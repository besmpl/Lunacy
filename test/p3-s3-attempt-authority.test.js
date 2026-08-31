import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeKernel } from '../dist/composition.js';
import { Conflict } from '../dist/index.js';
import { createManagedCapability } from '../dist/managed-capability.js';
import { FileArtifactStore } from '../dist/store.js';
import { canonicalString, digest } from '../dist/canonical.js';

const ref = (id, value, scope) => ({ id, ...(scope === undefined ? {} : { scope }), digest: digest(value), bytes: canonicalString(value) });
const plan = { phaseId: 'p3-s3', steps: [{ stepId: 'work' }] };
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

test('managed UNKNOWN retirement opens a fresh fully-reserved epoch and fences late receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s3-attempt-'));
  try {
    const capability = createManagedCapability({ ceilings: { waves: 1, calls: 2, refs: 2, persistedBytes: 2 } });
    const kernel = composeKernel({
      plan, rootDir: root, managedCapability: capability,
      driver: { dispatch() { throw new Error('ambiguous launch'); } },
    });
    let yielded = await kernel.advance(start('attempt-retire'));
    yielded = await kernel.advance(input('attempt-retire', 'resume-1', { kind: 'RESUME' }, yielded.snapshot));
    assert.equal(yielded.kind, 'BLOCKED');
    assert.equal(yielded.code, 'UnknownDispatch');
    const old = (await readState(root));
    const oldCommand = Object.values(old.outbox).find((command) => command.state === 'UNKNOWN');
    assert.ok(oldCommand);

    yielded = await kernel.advance(input('attempt-retire', 'resume-2', { kind: 'RESUME' }, yielded.snapshot));
    assert.equal(yielded.kind, 'WAITING');
    const state = await readState(root);
    const commands = Object.values(state.outbox);
    const fresh = commands.find((command) => command.attemptEpoch === 1);
    assert.ok(fresh, 'retirement must reserve a successor command');
    assert.equal(fresh.state, 'PENDING');
    assert.equal(state.attemptEpoch, 1);
    assert.equal(state.managed.attempts[oldCommand.commandId].status, 'TIMED_OUT');
    assert.equal(state.managed.attempts[fresh.commandId].status, 'LIVE');
    assert.equal(state.managed.waveCounters.calls, 2, 'old reservation remains charged and fresh reservation is full');

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
    const capability = createManagedCapability({ ceilings: { waves: 1, calls: 2, refs: 2, persistedBytes: 2 } });
    let stopObserve;
    const kernel = composeKernel({
      plan, rootDir: root, managedCapability: capability, timeoutMs: 10,
      driver: { dispatch() { throw new Error('ambiguous launch'); }, observe() { return new Promise((_, reject) => { stopObserve = reject; }); } },
    });
    let yielded = await kernel.advance(start('attempt-observe-timeout'));
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
    const old = commands.find((command) => command.attemptEpoch === 0);
    assert.equal(state.managed.attempts[old.commandId].status, 'TIMED_OUT');
    stopObserve?.(new Error('test cleanup'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

async function reachManagedDecision(runId, root, capability) {
  const driver = { dispatch(command, launchToken) { return { launchToken, commandDigest: command.commandDigest, ref: ref('dispatch-receipt', { accepted: true }, 'outbox') }; } };
  const kernel = composeKernel({ plan, rootDir: root, managedCapability: capability, driver });
  let yielded = await kernel.advance(start(runId));
  const state = await readState(root);
  const command = Object.values(state.outbox).find((candidate) => candidate.state === 'ACKED');
  yielded = await kernel.advance(input(runId, 'resume', { kind: 'RESUME' }, yielded.snapshot));
  // The synchronous receipt is committed during RESUME; only the worker
  // envelope is needed to close the one-step plan and issue a deliberation.
  const worker = { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }, 'worker') };
  yielded = await kernel.advance(input(runId, 'worker', worker, yielded.snapshot, command?.launchToken ?? Object.values((await readState(root)).outbox)[0].launchToken));
  return { kernel, yielded };
}

test('superseded status-only managed envelopes are explicitly rejected before settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s3-decision-'));
  try {
    const capability = createManagedCapability({ ceilings: { waves: 1, calls: 2, refs: 2, persistedBytes: 2 } });
    const { yielded } = await reachManagedDecision('decision-selection', root, capability);
    assert.equal(yielded.kind, 'BLOCKED');
    assert.match(yielded.reason, /Report\/v2|prefix/i);
    const state = await readState(root);
    assert.equal(Object.values(state.decisionTokens).some((token) => token.kind === 'DELIBERATION_SELECTION'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('superseded status-only WIDEN fixture is explicitly rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s3-widen-'));
  try {
    const capability = createManagedCapability({ ceilings: { waves: 1, calls: 2, refs: 2, persistedBytes: 2 } });
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
