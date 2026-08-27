import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeadsPlanSource, BeadsUnavailable } from '../dist/beads.js';
import { BridgeError, deleteBridge, transition } from '../dist/bridge.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';

const VERSION = '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}';

async function fixture(id = 'x') {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s15-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.beads'), { recursive: true });
  const executablePath = join(root, 'bd');
  await writeFile(executablePath, `#!/bin/sh
if [ "$1" = version ]; then printf '%s' '${VERSION}'; exit 0; fi
printf '%s\\n' '{"_type":"issue","id":"${id}","title":"${id}","status":"open","priority":0,"issue_type":"task"}'
`);
  await chmod(executablePath, 0o755);
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  const source = new BeadsPlanSource({ executablePath, workspace, expectedBinaryDigest });
  return { root, workspace, executablePath, source };
}

function acknowledgement(capture) {
  return {
    snapshotDigest: capture.snapshot.contentDigest,
    targetPlanDigest: digest(capture.plan),
    workspaceIdentity: capture.snapshot.workspaceIdentity,
    bdCommit: capture.snapshot.bdCommit,
    binaryDigest: capture.snapshot.binaryDigest,
  };
}

test('active START aliases are exactly shared with RunKernel and reject before mutation', async () => {
  const data = await fixture();
  const capture = await data.source.capture();
  const native = { phaseId: capture.plan.phaseId, steps: capture.plan.steps.map(({ stepId, goal }) => ({ stepId, goal })) };
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s15-alias-run-'));
  await assert.rejects(
    () => transition({ runDir, runId: 's15-alias', mode: 'runtime', plan: native, beads: { mode: 'active', source: data.source, acknowledgement: acknowledgement(capture) } }, { event: { kind: 'START', intentRef: { id: 'native', digest: digest(native) } }, eventId: 'start' }),
    (error) => error instanceof BridgeError && error.code === 'InvalidDeclaration',
  );
  await assert.rejects(() => readFile(join(runDir, '.kernel', 'BRIDGE.json')));
  await assert.rejects(() => readFile(join(runDir, '.kernel', `BEADS.INPUT.${digest(capture.plan)}.json`)));
});

test('event is snapshotted before asynchronous filesystem preflight', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s15-event-run-'));
  const plan = { phaseId: 's15-event', steps: [{ stepId: 'x', goal: 'x' }] };
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
  const pending = transition({ runDir, runId: 's15-event', mode: 'runtime', plan }, { event, eventId: 'start' });
  event.intentRef.digest = '0'.repeat(64);
  const result = await pending;
  assert.equal(result.yield?.snapshot?.revision, 1);
});

test('Linux capture uses fixed child descriptor slots for workspace and BEADS_DIR', { skip: process.platform !== 'linux' }, async () => {
  const data = await fixture();
  const workspaceStat = await stat(data.workspace);
  const beadsStat = await stat(join(data.workspace, '.beads'));
  const script = `#!/bin/sh
if [ "$1" = version ]; then printf '%s' '${VERSION}'; exit 0; fi
[ "$(cd /proc/self/fd/4 && pwd -P)" = "${data.workspace}" ] || exit 31
[ "$(cd /proc/self/fd/5 && pwd -P)" = "${join(data.workspace, '.beads')}" ] || exit 32
[ "$(pwd -P)" = "${data.workspace}" ] || exit 33
printf '%s\\n' '{"_type":"issue","id":"x","title":"x","status":"open","priority":0,"issue_type":"task"}'
`;
  await writeFile(data.executablePath, script); await chmod(data.executablePath, 0o755);
  data.source = new BeadsPlanSource({ executablePath: data.executablePath, workspace: data.workspace, expectedBinaryDigest: createHash('sha256').update(await readFile(data.executablePath)).digest('hex') });
  const capture = await data.source.capture();
  assert.equal(capture.snapshot.issues[0].sourceId, 'x');
  assert.equal(workspaceStat.isDirectory(), true); assert.equal(beadsStat.isDirectory(), true);
});

test('append-only replay bindings survive a precommit candidate and exact replay after epochs', async () => {
  const data = await fixture();
  const capture = await data.source.capture();
  const native = structuredClone(capture.plan); delete native.authorityDigest;
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s15-replay-run-'));
  await mkdir(join(runDir, '.kernel'), { recursive: true });
  const candidatePath = join(runDir, '.kernel', `BEADS.INPUT.${digest(capture.plan)}.json`);
  await writeFile(candidatePath, canonicalString({ schema: 'lunacy-beads-input-v1', snapshot: capture.snapshot, plan: capture.plan, sourceIds: capture.sourceIds }));
  const staleIdentity = { runId: 's15-replay', phaseId: capture.plan.phaseId, stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'crashed', payloadDigest: digest({ kind: 'START', intentRef: { id: 'full', digest: digest(capture.plan) } }) };
  await writeFile(join(runDir, '.kernel', `BEADS.REPLAY.${digest(staleIdentity)}.json`), canonicalString({ schema: 'lunacy-beads-replay-v1', candidateDigest: digest(capture.plan), identity: staleIdentity }));
  const event = { kind: 'START', intentRef: { id: 'native', digest: digest(native) } };
  const options = { runDir, runId: 's15-replay', mode: 'runtime', plan: native };
  const first = await transition({ ...options, beads: { mode: 'active', source: data.source, acknowledgement: acknowledgement(capture) } }, { event, eventId: 'start' });
  const bindings = (await readdir(join(runDir, '.kernel'))).filter((name) => name.startsWith('BEADS.REPLAY.'));
  assert.ok(bindings.length >= 2);
  const loaded = await new FileArtifactStore(runDir).load();
  await new FileArtifactStore(runDir).commit(loaded.generation, { ...loaded.state, attemptEpoch: loaded.state.attemptEpoch + 1, barrierEpoch: loaded.state.barrierEpoch + 1 });
  data.source.capture = async () => { throw new Error('replay must not call bd'); };
  const replay = await transition({ ...options, plan: { phaseId: 'ignored', steps: [{ stepId: 'ignored', goal: 'ignored' }] }, beads: { mode: 'active', source: data.source } }, { event, eventId: 'start' });
  assert.equal(canonicalString(replay.yield), canonicalString(first.yield));
});

test('drift candidates are persisted for lost-response replay without bd', async () => {
  const oldData = await fixture('old');
  const oldCapture = await oldData.source.capture();
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s15-drift-run-'));
  await transition({ runDir, runId: 's15-drift', mode: 'runtime', beads: { mode: 'active', source: oldData.source, acknowledgement: acknowledgement(oldCapture) } }, { event: { kind: 'START', intentRef: { id: 'old', digest: digest(oldCapture.plan) } }, eventId: 'start' });
  const changed = await fixture('changed');
  const event = { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'drift', scope: 'test', digest: digest({ drift: true }), bytes: canonicalString({ drift: true }) } };
  const drift = await transition({ runDir, runId: 's15-drift', mode: 'runtime', beads: { mode: 'active', source: changed.source } }, { event, eventId: 'drift' });
  assert.equal(drift.yield.kind, 'DECISION_REQUIRED');
  assert.ok((await readdir(join(runDir, '.kernel'))).some((name) => name.startsWith('BEADS.REPLAY.')));
  changed.source.capture = async () => { throw new Error('drift replay must not call bd'); };
  const replay = await transition({ runDir, runId: 's15-drift', mode: 'runtime', beads: { mode: 'active', source: changed.source } }, { event, eventId: 'drift' });
  assert.equal(canonicalString(replay.yield), canonicalString(drift.yield));
});

test('delete resumes idempotent cleanup after a durable tombstone', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s15-delete-run-'));
  const plan = { phaseId: 's15', steps: [{ stepId: 'x', goal: 'x' }] };
  await transition({ runDir, runId: 's15-delete', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const manifestPath = join(runDir, '.kernel', 'BRIDGE.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(join(runDir, '.kernel', 'BRIDGE.DELETED'), canonicalString({ ...manifest, status: 'deleted' }));
  await unlink(manifestPath);
  const result = await deleteBridge({ runDir, runId: 's15-delete', mode: 'runtime' });
  assert.equal(result.deleted, true);
  await assert.rejects(() => readFile(manifestPath));
  assert.equal(JSON.parse(await readFile(join(runDir, '.kernel', 'BRIDGE.DELETED'), 'utf8')).status, 'deleted');
});

test('sparse Beads files are rejected from stat size before allocation', { skip: process.platform === 'linux' }, async () => {
  const data = await fixture();
  await writeFile(join(data.workspace, '.beads', 'oversized'), '');
  await truncate(join(data.workspace, '.beads', 'oversized'), 64 * 1024 * 1024 + 1);
  await assert.rejects(() => data.source.capture(), BeadsUnavailable);
});
