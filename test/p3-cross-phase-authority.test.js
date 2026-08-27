import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Conflict, makeRunKernel } from '../dist/index.js';
import { composeKernel } from '../dist/composition.js';
import { FileArtifactStore, MemoryArtifactStore } from '../dist/store.js';
import { canonicalString, digest } from '../dist/canonical.js';

const input = (runId, eventId, event, snapshot, launchToken) => ({
  runId,
  ...(snapshot ? { expectedRevision: snapshot.revision } : {}),
  identity: {
    runId, phaseId: 'run', stepId: 'run',
    attemptEpoch: snapshot?.attemptEpoch ?? 0,
    authorityEpoch: snapshot?.authorityEpoch ?? 0,
    barrierEpoch: snapshot?.barrierEpoch ?? 0,
    eventId, payloadDigest: digest(event),
    ...(launchToken ? { launchToken } : {}),
  },
  event,
});

const start = (runId, plan) => input(runId, 'start', { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } });
const adoption = (runId, token, plan, snapshot, eventId = 'adopt') => input(runId, eventId, { kind: 'PARENT_DECISION', token, value: { kind: 'ADOPT', digest: digest(plan) } }, snapshot);
const launchToken = (runId, phaseId, stepId, attemptEpoch) => `launch-${digest({ runId, phaseId, stepId, attemptEpoch }).slice(0, 32)}`;
const ref = (id, value) => ({ id, scope: 'p3', digest: digest(value), bytes: canonicalString(value) });
const errorShape = (error) => ({ name: error.name, code: error.code, message: error.message });

async function memoryCrossPhase() {
  const originalCommit = MemoryArtifactStore.prototype.commit;
  let owner;
  let commits = 0;
  MemoryArtifactStore.prototype.commit = async function capture(generation, state) {
    owner = this;
    commits += 1;
    return originalCommit.call(this, generation, state);
  };
  try {
    const runId = 'p3-memory-cross-phase';
    const plan = { phaseId: 'p1', steps: [{ stepId: 'a' }] };
    const kernel = makeRunKernel({ plan, maxInFlight: 0 });
    const started = await kernel.advance(start(runId, plan));
    plan.phaseId = 'p2';
    const drift = await kernel.advance(input(runId, 'drift', { kind: 'RESUME' }, started.snapshot));
    const before = await owner.load();
    let error;
    try { await kernel.advance(adoption(runId, drift.token, plan, drift.snapshot)); }
    catch (caught) { error = errorShape(caught); }
    const after = await owner.load();
    return { error, before, after, commits, token: drift.token };
  } finally {
    MemoryArtifactStore.prototype.commit = originalCommit;
  }
}

async function fileCrossPhase() {
  const runId = 'p3-file-cross-phase';
  const plan = { phaseId: 'p1', steps: [{ stepId: 'a' }] };
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-cross-phase-'));
  const kernel = makeRunKernel({ plan, maxInFlight: 0, rootDir });
  const started = await kernel.advance(start(runId, plan));
  plan.phaseId = 'p2';
  const drift = await kernel.advance(input(runId, 'drift', { kind: 'RESUME' }, started.snapshot));
  const before = await new FileArtifactStore(rootDir).load();
  let error;
  try { await makeRunKernel({ plan, maxInFlight: 0, rootDir }).advance(adoption(runId, drift.token, plan, drift.snapshot)); }
  catch (caught) { error = errorShape(caught); }
  const after = await new FileArtifactStore(rootDir).load();
  return { error, before, after, token: drift.token };
}

test('quiescent cross-phase adoption is an unchanged Conflict in Memory and File stores', async () => {
  const [memory, file] = await Promise.all([memoryCrossPhase(), fileCrossPhase()]);
  assert.deepEqual(memory.error, { name: 'Conflict', code: 'Conflict', message: 'phase fence mismatch' });
  assert.deepEqual(file.error, memory.error);
  assert.equal(memory.commits, 2);
  assert.equal(memory.before.generation, memory.after.generation);
  assert.equal(file.before.generation, file.after.generation);
  assert.equal(canonicalString(memory.before.state), canonicalString(memory.after.state));
  assert.equal(canonicalString(file.before.state), canonicalString(file.after.state));
  assert.equal(memory.before.state.decisionTokens[memory.token].consumed, false);
  assert.equal(file.before.state.decisionTokens[file.token].consumed, false);
  assert.equal(file.after.state.decisionTokens[file.token].consumed, false);
});

test('cross-phase adoption remains fenced after old work reconciliation', async () => {
  const runId = 'p3-old-work-cross-phase';
  const plan = { phaseId: 'p1', steps: [{ stepId: 'a' }] };
  const driver = { dispatch(command, token) { return { launchToken: token, commandDigest: command.commandDigest, ref: ref('receipt', { accepted: true }) }; } };
  const kernel = composeKernel({ plan, driver, maxInFlight: 1 });
  let current = await kernel.advance(start(runId, plan));
  plan.phaseId = 'p2';
  const drift = await kernel.advance(input(runId, 'drift', { kind: 'RESUME' }, current.snapshot));
  const refused = await kernel.advance(adoption(runId, drift.token, plan, drift.snapshot, 'adopt-live'));
  assert.equal(refused.kind, 'DECISION_REQUIRED');
  assert.deepEqual(refused.snapshot, drift.snapshot);
  await new Promise((resolve) => setTimeout(resolve, 10));
  current = await kernel.advance(input(runId, 'recover', { kind: 'RESUME' }, refused.snapshot));
  current = await kernel.advance(input(runId, 'done', { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) }, current.snapshot, launchToken(runId, 'p1', 'a', 0)));
  const before = current.snapshot;
  await assert.rejects(() => kernel.advance(adoption(runId, drift.token, plan, current.snapshot, 'adopt-after-recovery')), (error) => error instanceof Conflict && error.message === 'phase fence mismatch');
  assert.deepEqual(current.snapshot, before);
});

test('same-phase adoption keeps the existing path and supersedes a stale cross-phase token', async () => {
  const runId = 'p3-same-phase-parity';
  const plan = { phaseId: 'p1', steps: [{ stepId: 'a' }] };
  const kernel = makeRunKernel({ plan, maxInFlight: 0 });
  const started = await kernel.advance(start(runId, plan));
  plan.steps.push({ stepId: 'b', dependencies: ['a'] });
  const drift = await kernel.advance(input(runId, 'drift', { kind: 'RESUME' }, started.snapshot));
  const adopted = await kernel.advance(adoption(runId, drift.token, plan, drift.snapshot));
  assert.equal(adopted.kind, 'WAITING');
  assert.equal(adopted.snapshot.phase, 'p1');
  assert.equal(adopted.snapshot.revision, 2);
  assert.equal(adopted.snapshot.authorityEpoch, 1);
  assert.equal(adopted.snapshot.attemptEpoch, 1);
  assert.equal(adopted.snapshot.barrierEpoch, 1);
  assert.equal(adopted.snapshot.readyCount, 2);

  const replay = await kernel.advance(adoption(runId, drift.token, plan, drift.snapshot));
  assert.equal(canonicalString(replay), canonicalString(adopted));

  const restartPlan = { phaseId: 'p1', steps: [{ stepId: 'a' }] };
  const restartRun = 'p3-restart-cross-phase';
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-restart-'));
  const first = makeRunKernel({ plan: restartPlan, maxInFlight: 0, rootDir });
  const firstStart = await first.advance(start(restartRun, restartPlan));
  restartPlan.phaseId = 'p2';
  const firstDrift = await first.advance(input(restartRun, 'drift', { kind: 'RESUME' }, firstStart.snapshot));
  await assert.rejects(() => makeRunKernel({ plan: restartPlan, maxInFlight: 0, rootDir }).advance(adoption(restartRun, firstDrift.token, restartPlan, firstDrift.snapshot)), (error) => error instanceof Conflict && error.message === 'phase fence mismatch');
  restartPlan.phaseId = 'p1';
  restartPlan.steps.push({ stepId: 'b' });
  const restarted = makeRunKernel({ plan: restartPlan, maxInFlight: 0, rootDir });
  const samePhaseDrift = await restarted.advance(input(restartRun, 'drift-same-phase', { kind: 'RESUME' }, firstDrift.snapshot));
  assert.notEqual(samePhaseDrift.token, firstDrift.token);
  assert.equal((await new FileArtifactStore(rootDir).load()).state.decisionTokens[firstDrift.token].consumed, true);
  const samePhaseAdopted = await restarted.advance(adoption(restartRun, samePhaseDrift.token, restartPlan, samePhaseDrift.snapshot, 'adopt-same-phase'));
  assert.equal(samePhaseAdopted.kind, 'WAITING');
  assert.equal(samePhaseAdopted.snapshot.phase, 'p1');
  assert.equal(samePhaseAdopted.snapshot.readyCount, 2);
});
