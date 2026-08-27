import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { Conflict, KernelError, makeRunKernel } from '../dist/index.js';
import { MemoryArtifactStore } from '../dist/store.js';

const plan = { phaseId: 'p3-s6', steps: [{ stepId: 'a' }] };

function ref(id, value) {
  return { id, scope: 'p3-s6', digest: digest(value), bytes: canonicalString(value) };
}

function input(runId, eventId, event, cursor, launchToken) {
  return {
    runId,
    ...(cursor?.revision === undefined ? {} : { expectedRevision: cursor.revision }),
    identity: {
      runId,
      phaseId: 'run',
      stepId: 'run',
      attemptEpoch: cursor?.attemptEpoch ?? 0,
      authorityEpoch: cursor?.authorityEpoch ?? 0,
      barrierEpoch: cursor?.barrierEpoch ?? 0,
      eventId,
      payloadDigest: digest(event),
      ...(launchToken === undefined ? {} : { launchToken }),
    },
    event,
  };
}

function driver(seen) {
  return {
    dispatch(command, launchToken) {
      seen.push(command.commandId);
      return { launchToken, commandDigest: command.commandDigest, ref: ref('receipt', { ok: true }) };
    },
  };
}

async function processedOnlyFixture({ rootDir, admission } = {}) {
  const mutablePlan = { phaseId: plan.phaseId, steps: [{ stepId: 'a' }] };
  const calls = [];
  const kernel = composeKernel({ plan: mutablePlan, ...(rootDir ? { rootDir } : {}), driver: driver(calls), ...(admission ? { admission } : {}) });
  const started = await kernel.advance(input('s6-replay', 'start', { kind: 'START', intentRef: ref('plan', mutablePlan) }));
  mutablePlan.steps[0].goal = 'authority drift';
  const hostEvent = { kind: 'OBSERVATION', category: 'HOST', ref: ref('host', { changed: true }) };
  const drift = await kernel.advance(input('s6-replay', 'E', hostEvent, started.snapshot));
  assert.equal(drift.kind, 'DECISION_REQUIRED');
  return { kernel, mutablePlan, started, drift, calls, hostEvent };
}

test('exact processed replay wins over a same-eventId journal projection', async () => {
  const fixture = await processedOnlyFixture();
  const originalLoad = MemoryArtifactStore.prototype.load;
  let inject = true;
  MemoryArtifactStore.prototype.load = async function loadWithAmbiguousJournal() {
    const loaded = await originalLoad.call(this);
    if (inject && loaded.state) {
      const record = Object.values(loaded.state.processed).find((candidate) => candidate.identity.eventId === 'E');
      assert.ok(record);
      loaded.state.journal.push({
        identity: structuredClone(record.identity),
        event: fixture.hostEvent,
        digest: digest(fixture.hostEvent),
        revision: loaded.state.revision + 1,
      });
    }
    return loaded;
  };
  try {
    const exact = await fixture.kernel.advance(input('s6-replay', 'E', fixture.hostEvent, fixture.started.snapshot));
    assert.deepEqual(exact, fixture.drift);
    assert.equal(fixture.calls.length, 0);
  } finally {
    inject = false;
    MemoryArtifactStore.prototype.load = originalLoad;
  }
});

test('processed-only eventId conflicts preflight every finality, decision, and effect event kind', async () => {
  let admissionCalls = 0;
  const fixture = await processedOnlyFixture({ admission: () => { admissionCalls += 1; return true; } });
  const token = fixture.drift.token;
  const launchToken = 'launch-s6-collision';
  const commandDigest = digest('command');
  const events = [
    { event: { kind: 'RESUME' } },
    { event: { kind: 'PARENT_DECISION', token, value: 'PASS' } },
    { event: { kind: 'DISPATCH_RECEIPT', ref: ref('receipt-proof', { launchToken, commandDigest }) }, launchToken },
    { event: { kind: 'WORKER_ENVELOPE', ref: ref('worker-result', { status: 'DONE' }) }, launchToken },
    { event: { kind: 'OBSERVATION', category: 'RECOVERY', ref: ref('recovery-proof', { launchToken, commandDigest, status: 'UNKNOWN' }) }, launchToken },
    { event: { kind: 'OBSERVATION', category: 'USER_CHANGE', ref: ref('user-change', { changed: true }) } },
  ];
  const admissionBefore = admissionCalls;
  for (const candidate of events) {
    await assert.rejects(
      () => fixture.kernel.advance(input('s6-replay', 'E', candidate.event, fixture.drift.snapshot, candidate.launchToken)),
      (error) => error instanceof Conflict && error.message === 'eventId reused with conflicting identity',
    );
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal(admissionCalls, admissionBefore);
});

test('corrupt stored yield fails verified load before replay classification', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-s6-corrupt-yield-'));
  const fixture = await processedOnlyFixture({ rootDir });
  const currentPath = join(rootDir, '.kernel', 'CURRENT');
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  const statePath = join(rootDir, '.kernel', 'generations', `g${current.generation}`, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const key = Object.keys(state.processed).find((candidate) => state.processed[candidate].identity.eventId === 'E');
  assert.ok(key);
  state.processed[key].yieldBytes = '{}';
  current.stateDigest = digest(state);
  await writeFile(statePath, canonicalString(state));
  await writeFile(currentPath, canonicalString(current));
  await assert.rejects(
    () => makeRunKernel({ plan: fixture.mutablePlan, rootDir }).advance(input('s6-replay', 'E', { kind: 'RESUME' }, fixture.drift.snapshot)),
    (error) => error instanceof KernelError && error.code === 'ManifestMismatch',
  );
  assert.equal(fixture.calls.length, 0);
});
