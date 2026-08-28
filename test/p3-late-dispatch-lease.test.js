import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';

const plan = { phaseId: 'p3-late-dispatch-lease', steps: [{ stepId: 'a' }] };
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timeout');
    await wait(5);
  }
}
const ref = (id, value) => ({ id, scope: 'p3-late-dispatch-lease', digest: digest(value), bytes: canonicalString(value) });
const commandFrom = (state) => Object.values(state.outbox)[0];
const input = (runId, eventId, event, snapshot, launchToken) => ({
  runId,
  ...(snapshot?.revision === undefined ? {} : { expectedRevision: snapshot.revision }),
  identity: {
    runId, phaseId: 'run', stepId: 'run', eventId,
    attemptEpoch: snapshot?.attemptEpoch ?? 0,
    authorityEpoch: snapshot?.authorityEpoch ?? 0,
    barrierEpoch: snapshot?.barrierEpoch ?? 0,
    payloadDigest: digest(event),
    ...(launchToken ? { launchToken } : {}),
  },
  event,
});
const startInput = (runId) => input(runId, 'start', { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } });
const recoveryInput = (runId, eventId, state) => {
  const command = commandFrom(state);
  const proof = { launchToken: command.launchToken, commandDigest: command.commandDigest, status: 'NEVER_LAUNCHED' };
  const event = { kind: 'OBSERVATION', category: 'RECOVERY', ref: ref(`never:${command.launchToken}`, proof) };
  return input(runId, eventId, event, state, command.launchToken);
};
const receipt = (command, id) => ({ launchToken: command.launchToken, commandDigest: command.commandDigest, ref: ref(id, { accepted: true }) });
const loadState = async (root) => (await new FileArtifactStore(root).load()).state;

test('P3-LATE-DISPATCH-LEASE rejects an old receipt while successor is PENDING', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-late-dispatch-pending-'));
  const oldPending = deferred();
  let oldCommand;
  const oldKernel = composeKernel({
    plan,
    rootDir: root,
    timeoutMs: 10_000,
    driver: { dispatch(command) { oldCommand = clone(command); return oldPending.promise; } },
  });
  try {
    const runId = 'p3-late-dispatch-pending';
    const started = await oldKernel.advance(startInput(runId));
    await oldKernel.advance(input(runId, 'old-resume', { kind: 'RESUME' }, started.snapshot));
    await waitFor(() => oldCommand !== undefined);
    const oldClaim = await loadState(root);
    assert.equal(commandFrom(oldClaim).state, 'CLAIMED');
    const oldLease = commandFrom(oldClaim).leaseId;

    const recoveryKernel = composeKernel({ plan, rootDir: root });
    const blocked = await recoveryKernel.advance(input(runId, 'recover-claimed', { kind: 'RESUME' }, oldClaim));
    assert.equal(blocked.kind, 'BLOCKED');
    const unknown = await loadState(root);
    assert.equal(commandFrom(unknown).state, 'UNKNOWN');
    await recoveryKernel.advance(recoveryInput(runId, 'never-launched', unknown));
    const pending = await loadState(root);
    assert.equal(commandFrom(pending).state, 'PENDING');
    assert.equal(commandFrom(pending).leaseId, oldLease);
    const pendingGeneration = (await new FileArtifactStore(root).load()).generation;

    oldPending.resolve(receipt(oldCommand, 'old-dispatch-receipt'));
    await waitFor(() => oldKernel.activeDispatches.size === 0);
    const afterOld = await loadState(root);
    assert.equal(commandFrom(afterOld).state, 'PENDING');
    assert.equal(commandFrom(afterOld).leaseId, oldLease);
    assert.equal((await new FileArtifactStore(root).load()).generation, pendingGeneration);

    let successorCommand;
    let successorCalls = 0;
    const successorKernel = composeKernel({
      plan,
      rootDir: root,
      driver: { dispatch(command, token) { successorCalls += 1; successorCommand = clone(command); return receipt(command, 'successor-dispatch-receipt'); } },
    });
    const waiting = await successorKernel.advance(input(runId, 'successor-resume', { kind: 'RESUME' }, afterOld));
    assert.equal(waiting.kind, 'WAITING');
    assert.equal(successorCalls, 1);
    assert.ok(successorCommand);
    assert.notEqual(successorCommand.leaseId, oldLease);
    const acked = await loadState(root);
    assert.equal(commandFrom(acked).state, 'ACKED');
    assert.equal(commandFrom(acked).leaseId, successorCommand.leaseId);
  } finally {
    oldPending.resolve(receipt(oldCommand ?? { launchToken: 'cleanup', commandDigest: digest({}) }, 'cleanup'));
  }
});

test('P3-LATE-DISPATCH-LEASE rejects an old receipt while successor is CLAIMED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-late-dispatch-claimed-'));
  const oldPending = deferred();
  const successorPending = deferred();
  let oldCommand;
  let successorCommand;
  let successorEntered;
  const oldKernel = composeKernel({
    plan,
    rootDir: root,
    timeoutMs: 10_000,
    driver: { dispatch(command) { oldCommand = clone(command); return oldPending.promise; } },
  });
  try {
    const runId = 'p3-late-dispatch-claimed';
    const started = await oldKernel.advance(startInput(runId));
    await oldKernel.advance(input(runId, 'old-resume', { kind: 'RESUME' }, started.snapshot));
    await waitFor(() => oldCommand !== undefined);
    const oldClaim = await loadState(root);
    assert.equal(commandFrom(oldClaim).state, 'CLAIMED');
    const oldLease = commandFrom(oldClaim).leaseId;

    const recoveryKernel = composeKernel({ plan, rootDir: root });
    const blocked = await recoveryKernel.advance(input(runId, 'recover-claimed', { kind: 'RESUME' }, oldClaim));
    assert.equal(blocked.kind, 'BLOCKED');
    const unknown = await loadState(root);
    await recoveryKernel.advance(recoveryInput(runId, 'never-launched', unknown));
    const pending = await loadState(root);
    assert.equal(commandFrom(pending).state, 'PENDING');

    successorEntered = deferred();
    const successorKernel = composeKernel({
      plan,
      rootDir: root,
      timeoutMs: 10_000,
      driver: { dispatch(command) { successorCommand = clone(command); successorEntered.resolve(); return successorPending.promise; } },
    });
    const successorAdvance = successorKernel.advance(input(runId, 'successor-resume', { kind: 'RESUME' }, pending));
    await successorEntered.promise;
    await waitFor(async () => {
      const state = await loadState(root);
      return commandFrom(state).state === 'CLAIMED';
    });
    const successorClaim = await loadState(root);
    assert.equal(commandFrom(successorClaim).state, 'CLAIMED');
    assert.notEqual(commandFrom(successorClaim).leaseId, oldLease);
    const successorGeneration = (await new FileArtifactStore(root).load()).generation;

    oldPending.resolve(receipt(oldCommand, 'old-dispatch-receipt'));
    await waitFor(() => oldKernel.activeDispatches.size === 0);
    const afterOld = await loadState(root);
    assert.equal(commandFrom(afterOld).state, 'CLAIMED');
    assert.equal(commandFrom(afterOld).leaseId, successorCommand.leaseId);
    assert.equal((await new FileArtifactStore(root).load()).generation, successorGeneration);

    successorPending.resolve(receipt(successorCommand, 'successor-dispatch-receipt'));
    assert.equal((await successorAdvance).kind, 'WAITING');
    await waitFor(async () => commandFrom(await loadState(root)).state === 'ACKED');
    const acked = await loadState(root);
    assert.equal(commandFrom(acked).state, 'ACKED');
    assert.equal(commandFrom(acked).leaseId, successorCommand.leaseId);
  } finally {
    oldPending.resolve(receipt(oldCommand ?? { launchToken: 'cleanup', commandDigest: digest({}) }, 'cleanup'));
    successorPending.resolve(receipt(successorCommand ?? { launchToken: 'cleanup', commandDigest: digest({}) }, 'cleanup'));
  }
});
