import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { BeadsPlanSource } from '../dist/beads.js';
import { Conflict, KernelError, makeRunKernel } from '../dist/index.js';
import { transition } from '../dist/bridge.js';
import { FileArtifactStore } from '../dist/store.js';

const plan = { phaseId: 'p3-replay', steps: [{ stepId: 'a' }] };

function input(runId, eventId, event, cursor, extra = {}) {
  return {
    runId,
    ...(cursor?.revision === undefined ? {} : { expectedRevision: cursor.revision }),
    identity: {
      runId,
      phaseId: extra.phaseId ?? 'run',
      stepId: extra.stepId ?? 'run',
      attemptEpoch: cursor?.attemptEpoch ?? extra.attemptEpoch ?? 0,
      authorityEpoch: cursor?.authorityEpoch ?? extra.authorityEpoch ?? 0,
      barrierEpoch: cursor?.barrierEpoch ?? extra.barrierEpoch ?? 0,
      eventId,
      payloadDigest: digest(event),
      ...(extra.launchToken === undefined ? {} : { launchToken: extra.launchToken }),
    },
    event,
  };
}

function ref(id, value, scope = 'test') {
  return { id, scope, digest: digest(value), bytes: canonicalString(value) };
}

async function treeBytes(root) {
  const out = {};
  async function walk(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, relative);
      else if (entry.isFile()) out[relative] = (await readFile(path)).toString('base64');
    }
  }
  await walk(root);
  return out;
}

function receiptDriver(seen) {
  return {
    dispatch(command, launchToken) {
      seen.push(command.commandId);
      return { launchToken, commandDigest: command.commandDigest, ref: ref('receipt', { ok: true }) };
    },
  };
}

async function processedOnlyFixture({ rootDir, composed }) {
  const mutablePlan = { phaseId: plan.phaseId, steps: [{ stepId: 'a' }] };
  const calls = [];
  const kernel = (composed ? composeKernel : makeRunKernel)({ plan: mutablePlan, ...(rootDir ? { rootDir } : {}), ...(composed ? { driver: receiptDriver(calls) } : {}) });
  const started = await kernel.advance(input('replay', 'start', { kind: 'START', intentRef: ref('plan', mutablePlan) }, { revision: undefined, attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0 }));
  mutablePlan.steps[0].goal = 'authority drift';
  const hostEvent = { kind: 'OBSERVATION', category: 'HOST', ref: ref('host', { changed: true }) };
  const drift = await kernel.advance(input('replay', 'E', hostEvent, started.snapshot));
  assert.equal(drift.kind, 'DECISION_REQUIRED');
  assert.equal(drift.snapshot.revision, 1);
  const exact = await kernel.advance(input('replay', 'E', hostEvent, started.snapshot));
  assert.deepEqual(exact, drift);
  return { kernel, mutablePlan, started, drift, hostEvent, calls };
}

test('private classifier preserves exact replay and rejects processed-only eventId reuse in Memory and File stores', async () => {
  const traces = [];
  for (const store of ['memory', 'file']) {
    const rootDir = store === 'file' ? await mkdtemp(join(tmpdir(), 'lunacy-p3-replay-')) : undefined;
    const fixture = await processedOnlyFixture({ rootDir, composed: true });
    const before = rootDir === undefined ? undefined : await treeBytes(rootDir);
    const conflicting = input('replay', 'E', { kind: 'RESUME' }, fixture.drift.snapshot);
    await assert.rejects(
      () => fixture.kernel.advance(conflicting),
      (error) => error instanceof Conflict && error.message === 'eventId reused with conflicting identity',
    );
    assert.equal(fixture.calls.length, 0);
    if (rootDir !== undefined) assert.deepEqual(await treeBytes(rootDir), before);
    const fresh = await fixture.kernel.advance(input('replay', 'fresh', { kind: 'RESUME' }, fixture.drift.snapshot));
    assert.equal(fresh.kind, 'WAITING');
    assert.equal(fixture.calls.length, 1);
    traces.push({ store, drift: fixture.drift, fresh });
  }
  assert.deepEqual(traces[0].drift, traces[1].drift);
  assert.deepEqual(traces[0].fresh, traces[1].fresh);
});

test('processed-only collision remains visible after FileArtifactStore restart', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-restart-'));
  const fixture = await processedOnlyFixture({ rootDir, composed: true });
  const restarted = composeKernel({ plan: fixture.mutablePlan, rootDir, driver: receiptDriver(fixture.calls) });
  const before = await treeBytes(rootDir);
  const exact = await restarted.advance(input('replay', 'E', fixture.hostEvent, fixture.started.snapshot));
  assert.deepEqual(exact, fixture.drift);
  await assert.rejects(
    () => restarted.advance(input('replay', 'E', { kind: 'RESUME' }, fixture.drift.snapshot)),
    (error) => error instanceof Conflict && error.message === 'eventId reused with conflicting identity',
  );
  assert.deepEqual(await treeBytes(rootDir), before);
  assert.equal(fixture.calls.length, 0);
});

test('existing generation CAS permits one same-eventId START winner and classifies loser retry', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-race-'));
  const first = makeRunKernel({ plan, rootDir });
  const second = makeRunKernel({ plan, rootDir });
  const firstInput = input('race', 'same-event', { kind: 'START', intentRef: ref('plan', plan) }, { revision: undefined, attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0 }, { stepId: 'one' });
  const secondInput = input('race', 'same-event', { kind: 'START', intentRef: ref('plan', plan) }, { revision: undefined, attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0 }, { stepId: 'two' });
  const results = await Promise.allSettled([first.advance(firstInput), second.advance(secondInput)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason instanceof Conflict).length, 1);
  const loser = results[0].status === 'rejected' ? firstInput : secondInput;
  await assert.rejects(() => makeRunKernel({ plan, rootDir }).advance(loser), (error) => error instanceof Conflict && error.message === 'eventId reused with conflicting identity');
});

test('malformed generation rejection remains ahead of committed replay classification', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-malformed-'));
  const fixture = await processedOnlyFixture({ rootDir, composed: false });
  const current = JSON.parse(await readFile(join(rootDir, '.kernel', 'CURRENT'), 'utf8'));
  await writeFile(join(rootDir, '.kernel', 'generations', `g${current.generation}`, 'journal.ndjson'), '{}\n');
  await assert.rejects(
    () => makeRunKernel({ plan: fixture.mutablePlan, rootDir }).advance(input('replay', 'E', { kind: 'RESUME' }, fixture.drift.snapshot)),
    (error) => error instanceof KernelError && error.code === 'ManifestMismatch',
  );
});

const VERSION = '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}';

async function beadsFixture(id) {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-beads-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.beads'), { recursive: true });
  const executablePath = join(root, 'bd');
  await writeFile(executablePath, `#!/bin/sh\nif [ "$1" = version ]; then printf '%s' '${VERSION}'; exit 0; fi\nprintf '%s\\n' '{"_type":"issue","id":"${id}","title":"${id}","status":"open","priority":0,"issue_type":"task"}'\n`);
  await chmod(executablePath, 0o755);
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  const source = new BeadsPlanSource({ executablePath, workspace, expectedBinaryDigest });
  return { root, source };
}

function acknowledgement(capture) {
  return { snapshotDigest: capture.snapshot.contentDigest, targetPlanDigest: digest(capture.plan), workspaceIdentity: capture.snapshot.workspaceIdentity, bdCommit: capture.snapshot.bdCommit, binaryDigest: capture.snapshot.binaryDigest };
}

test('active-Beads non-capturing DISPATCH_RECEIPT route shares classifier and does not mutate', async () => {
  const initial = await beadsFixture('old');
  const initialCapture = await initial.source.capture();
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-beads-run-'));
  const options = { runDir, runId: 'beads-replay', mode: 'runtime', beads: { mode: 'active', source: initial.source, acknowledgement: acknowledgement(initialCapture) } };
  await transition(options, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(initialCapture.plan) } }, eventId: 'start' });
  const changed = await beadsFixture('changed');
  const hostEvent = { kind: 'OBSERVATION', category: 'HOST', ref: ref('host', { changed: true }) };
  const drift = await transition({ runDir, runId: 'beads-replay', mode: 'runtime', beads: { mode: 'active', source: changed.source } }, { event: hostEvent, eventId: 'E' });
  assert.equal(drift.yield.kind, 'DECISION_REQUIRED');
  const state = await new FileArtifactStore(runDir).load();
  const command = Object.values(state.state.outbox).find((candidate) => candidate.state === 'PENDING');
  assert.ok(command);
  const proof = { launchToken: command.launchToken, commandDigest: command.commandDigest };
  const receiptEvent = { kind: 'DISPATCH_RECEIPT', ref: ref('receipt-proof', proof) };
  const before = await treeBytes(runDir);
  changed.source.capture = async () => { throw new Error('non-capturing collision must not call bd'); };
  await assert.rejects(
    () => transition({ runDir, runId: 'beads-replay', mode: 'runtime', beads: { mode: 'active', source: changed.source } }, { event: receiptEvent, eventId: 'E', launchToken: command.launchToken }),
    (error) => error instanceof Conflict && error.message === 'eventId reused with conflicting identity',
  );
  assert.deepEqual(await treeBytes(runDir), before);
});
