import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeKernel } from '../dist/composition.js';
import { createManagedCapability } from '../dist/managed-capability.js';
import { FileArtifactStore } from '../dist/store.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { authorExactManagedFixture, exactManagedTeardown, makeExactManagedKernel } from './exact-managed-harness.js';

const ref = (id, value, scope) => ({ id, ...(scope === undefined ? {} : { scope }), digest: digest(value), bytes: canonicalString(value) });
const plan = { phaseId: 'p3-s3', steps: [{ stepId: 'work' }] };
const policy = {
  version: ref('policy', { generation: 1 }, 'policy'),
  frameCatalog: [0, 1, 2, 3].map((i) => ({ frameId: `f${i}`, tag: 'code', text: `frame-${i}` })).concat([{ frameId: 'wild', tag: 'wild', text: 'wild' }]),
  maxMaterialDecisions: 4, maxSettlementBytes: 10_000_000, maxResolvedRoleInputBytes: 10_000_000,
  convergeCount: 3, nonObviousNovelty: 5, viableFloor: 5,
};
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
const start = (runId, selectedPlan = plan) => input(runId, 'start', { kind: 'START', intentRef: ref('plan', selectedPlan) });

async function readState(root) {
  return (await new FileArtifactStore(root).load()).state;
}

test('managed UNKNOWN retirement opens a fresh fully-reserved command epoch and fences late receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s3-attempt-'));
  try {
    const fixture = authorExactManagedFixture({ runId: 'attempt-retire', phaseId: 'p3-s3', policy });
    const capability = createManagedCapability({ ceilings: { waves: 1, calls: 4, refs: 4, persistedBytes: 4 } });
    let dispatchAvailable = true;
    const kernel = makeExactManagedKernel({
      plan: fixture.plan, rootDir: root, capability, waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: 2,
      driver: {
        available() { return dispatchAvailable; },
        dispatch() { dispatchAvailable = false; throw new Error('ambiguous launch'); },
        observeTeardown(_token, _commandDigest, _signal, command) { return exactManagedTeardown(command); },
      },
    });
    let yielded = await kernel.advance(start('attempt-retire', fixture.plan));
    for (let index = 1; index <= 4 && yielded.kind !== 'BLOCKED'; index += 1) {
      yielded = await kernel.advance(input('attempt-retire', `resume-${index}`, { kind: 'RESUME' }, yielded.snapshot));
    }
    assert.equal(yielded.kind, 'BLOCKED');
    assert.equal(yielded.code, 'UnknownDispatch');
    const old = (await readState(root));
    const oldCommand = Object.values(old.outbox).find((command) => command.state === 'UNKNOWN');
    assert.ok(oldCommand);

    yielded = await kernel.advance(input('attempt-retire', 'retire', { kind: 'RESUME' }, yielded.snapshot));
    assert.equal(yielded.kind, 'WAITING');
    const state = await readState(root);
    const commands = Object.values(state.outbox);
    const fresh = commands.find((command) => command.attemptEpoch === 1);
    assert.ok(fresh, 'retirement must reserve a successor command');
    assert.equal(fresh.state, 'PENDING');
    assert.equal(state.attemptEpoch, 1);
    assert.equal(state.managed.attempts[oldCommand.commandId].status, 'TIMED_OUT');
    assert.equal(state.managed.attempts[fresh.commandId].status, 'LIVE');
    assert.equal(state.managed.waveCounters.calls, 3, 'both initial wavefront reservations remain charged and the retired owner receives one fresh reservation');
    assert.equal(state.managed.reservations[oldCommand.commandId].charged, true);
    assert.equal(state.managed.reservations[fresh.commandId].calls, 1);
    assert.equal(state.managed.reservations[fresh.commandId].charged, true);

    const lateReceipt = ref('late-receipt', { ok: true });
    const proof = ref(`receipt:${oldCommand.launchToken}`, { launchToken: oldCommand.launchToken, commandDigest: oldCommand.commandDigest, receipt: lateReceipt }, 'outbox/receipt');
    const before = await new FileArtifactStore(root).load();
    const late = await kernel.advance(input('attempt-retire', 'late-receipt', { kind: 'DISPATCH_RECEIPT', ref: proof }, yielded.snapshot, oldCommand.launchToken));
    assert.equal(late.kind, 'BLOCKED');
    const after = await new FileArtifactStore(root).load();
    assert.equal(after.state.outbox[oldCommand.commandId].state, 'UNKNOWN', 'retired late result cannot acknowledge the old command');
    assert.equal(after.state.managed.attempts[oldCommand.commandId].status, 'TIMED_OUT');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test('managed UNKNOWN observation timeout retires rather than looping the same epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s3-observe-timeout-'));
  try {
    const fixture = authorExactManagedFixture({ runId: 'attempt-observe-timeout', phaseId: 'p3-s3', policy });
    const capability = createManagedCapability({ ceilings: { waves: 1, calls: 4, refs: 4, persistedBytes: 4 } });
    let stopObserve; let dispatchAvailable = true;
    const kernel = makeExactManagedKernel({
      plan: fixture.plan, rootDir: root, capability, waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: 2, timeoutMs: 10,
      driver: {
        available() { return dispatchAvailable; },
        dispatch() { dispatchAvailable = false; throw new Error('ambiguous launch'); },
        observe() { return new Promise((_, reject) => { stopObserve = reject; }); },
        observeTeardown(_token, _commandDigest, _signal, command) { return exactManagedTeardown(command); },
      },
    });
    let yielded = await kernel.advance(start('attempt-observe-timeout', fixture.plan));
    yielded = await kernel.advance(input('attempt-observe-timeout', 'resume-1', { kind: 'RESUME' }, yielded.snapshot));
    yielded = await kernel.advance(input('attempt-observe-timeout', 'resume-2', { kind: 'RESUME' }, yielded.snapshot));
    assert.equal(yielded.kind, 'BLOCKED');
    let state;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      state = await readState(root);
      if (state.attemptEpoch === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const commands = Object.values(state.outbox);
    assert.ok(commands.some((command) => command.attemptEpoch === 1 && command.state === 'PENDING'));
    const old = commands.find((command) => command.attemptEpoch === 0 && command.state === 'UNKNOWN');
    assert.ok(old);
    assert.equal(state.managed.attempts[old.commandId].status, 'TIMED_OUT');
    stopObserve?.(new Error('test cleanup'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

async function reachManagedDecision(runId, root, capability) {
  const fixture = authorExactManagedFixture({ runId, phaseId: 'p3-s3', policy });
  const driver = { dispatch(command, launchToken) { return { launchToken, commandDigest: command.commandDigest, ref: fixture.byStep.get(command.stepId) }; } };
  const kernel = makeExactManagedKernel({ plan: fixture.plan, rootDir: root, capability, waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: 2, driver });
  let yielded = await kernel.advance(start(runId, fixture.plan));
  yielded = await kernel.advance(input(runId, 'resume', { kind: 'RESUME' }, yielded.snapshot));
  const state = await readState(root);
  const command = Object.values(state.outbox).find((candidate) => candidate.state === 'ACKED' && state.steps[candidate.stepId]?.status === 'ACTIVE');
  const worker = { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }, 'worker') };
  yielded = await kernel.advance(input(runId, 'worker', worker, yielded.snapshot, command.launchToken));
  return { kernel, yielded };
}

test('status-only managed envelopes are explicitly rejected before settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s3-decision-'));
  try {
    const capability = createManagedCapability({ ceilings: { waves: 1, calls: 3, refs: 3, persistedBytes: 3 } });
    const { yielded } = await reachManagedDecision('decision-selection', root, capability);
    assert.equal(yielded.kind, 'BLOCKED');
    assert.match(yielded.reason, /Report\/v2|prefix/i);
    const state = await readState(root);
    assert.equal(Object.values(state.decisionTokens).some((token) => token.kind === 'DELIBERATION_SELECTION'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('status-only WIDEN fixture is explicitly rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s3-widen-'));
  try {
    const capability = createManagedCapability({ ceilings: { waves: 1, calls: 3, refs: 3, persistedBytes: 3 } });
    const { yielded } = await reachManagedDecision('decision-widen', root, capability);
    assert.equal(yielded.kind, 'BLOCKED');
    assert.match(yielded.reason, /Report\/v2|prefix/i);
    const state = await readState(root);
    assert.equal(Object.values(state.decisionTokens).some((token) => token.kind === 'DELIBERATION_SELECTION'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('authority adoption checks its read-set only at the moving CAS and returns STALE without consuming', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s3-adoption-'));
  try {
    const capability = createManagedCapability({ ceilings: { waves: 1, calls: 1, refs: 1, persistedBytes: 1 } });
    const livePlan = { phaseId: 'p3-s3', steps: [{ stepId: 'work' }] };
    const adoptionKernel = composeKernel({ plan: livePlan, rootDir: root, managedCapability: capability, maxInFlight: 0 });
    const started = await adoptionKernel.advance(start('adoption-stale', livePlan));
    const changedPlan = { ...livePlan, steps: [...livePlan.steps, { stepId: 'new' }] };
    livePlan.steps.push({ stepId: 'new' });
    const drift = await adoptionKernel.advance(input('adoption-stale', 'drift', { kind: 'RESUME' }, started.snapshot));
    assert.equal(drift.kind, 'DECISION_REQUIRED');
    const before = await new FileArtifactStore(root).load();
    const stale = await adoptionKernel.advance(input('adoption-stale', 'adopt-stale', {
      kind: 'PARENT_DECISION', token: drift.token,
      value: { kind: 'ADOPT', digest: digest(changedPlan), readSet: { workspace: 'new' }, readSetDigest: digest({ workspace: 'old' }) },
    }, drift.snapshot));
    assert.equal(stale.kind, 'BLOCKED');
    assert.equal(stale.code, 'STALE');
    const after = await new FileArtifactStore(root).load();
    assert.equal(after.generation, before.generation);
    assert.equal(after.state.decisionTokens[drift.token].consumed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
