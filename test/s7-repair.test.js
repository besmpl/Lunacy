import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactStore } from '../dist/store.js';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';

const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ref = (id, value) => ({ id, scope: 's7', digest: digest(value), bytes: canonicalString(value) });
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
const start = (runId, rootPlan = plan) => input(runId, 'start', { kind: 'START', intentRef: { id: 'plan', digest: digest(rootPlan) } });

test('abort during slow CLAIMED commit records UNKNOWN without calling a synchronous driver', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-s7-slow-commit-'));
  const controller = new AbortController();
  const yields = [];
  let dispatchCalls = 0;
  const driver = { dispatch(command, launchToken) {
    dispatchCalls += 1;
    return { launchToken, commandDigest: command.commandDigest, ref: ref('unexpected', { accepted: true }) };
  } };
  const originalCommit = FileArtifactStore.prototype.commit;
  let delayed = false;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const command = Object.values(state.outbox ?? {}).find((candidate) => candidate.state === 'CLAIMED');
    if (!delayed && command && state.journal.at(-1)?.event?.kind === 'RESUME') {
      delayed = true;
      // Abort synchronously once the CLAIMED candidate is handed to the
      // durable commit, then keep the commit slow enough to exercise the
      // post-CAS launch fence deterministically.
      controller.abort();
      await wait(25);
    }
    return originalCommit.call(this, generation, state);
  };
  try {
    const kernel = composeKernel({ plan, rootDir, driver, signal: controller.signal, timeoutMs: 250, onYield: (value) => yields.push(value) });
    let y = await kernel.advance(start('slow-commit'));
    const resume = kernel.advance(input('slow-commit', 'resume', { kind: 'RESUME' }, y.snapshot));
    y = await resume;
    assert.equal(dispatchCalls, 0);
    assert.equal(y.kind, 'BLOCKED');
    assert.equal(y.code, 'UnknownDispatch');
    assert.equal(y.snapshot.unknownDispatchCount, 1);
    await wait(5);
    assert.equal(yields.at(-1)?.code, 'UnknownDispatch');
    const persisted = await new FileArtifactStore(rootDir).load();
    const command = Object.values(persisted.state.outbox).find((candidate) => candidate.launchToken === y.launchToken);
    assert.equal(command?.state, 'UNKNOWN');
    const recovery = persisted.state.journal.find((entry) => entry.event.kind === 'OBSERVATION' && entry.event.category === 'RECOVERY');
    assert.equal(JSON.parse(recovery.event.ref.bytes).status, 'UNKNOWN');
    // Restart has no in-process launch owner, so RESUME cannot relaunch the
    // command.  It remains the same durable UNKNOWN identity.
    const restarted = composeKernel({ plan, rootDir, driver: { dispatch() { dispatchCalls += 1; throw new Error('must not relaunch'); } } });
    const recovered = await restarted.advance(input('slow-commit', 'restart', { kind: 'RESUME' }, y.snapshot));
    assert.equal(dispatchCalls, 0);
    assert.equal(recovered.kind, 'BLOCKED');
    assert.equal(recovered.code, 'UnknownDispatch');
    assert.equal(recovered.snapshot.unknownDispatchCount, 1);
  } finally {
    FileArtifactStore.prototype.commit = originalCommit;
  }
});

test('a synchronous driver is fenced by the internal deadline before launch and emits cancellation outcome', async () => {
  const yields = [];
  let dispatchCalls = 0;
  const driver = { dispatch(command, launchToken) {
    dispatchCalls += 1;
    return { launchToken, commandDigest: command.commandDigest, ref: ref('late-sync', { accepted: true }) };
  } };
  const kernel = composeKernel({ plan, driver, timeoutMs: 0, onYield: (value) => yields.push(value) });
  let y = await kernel.advance(start('sync-deadline'));
  y = await kernel.advance(input('sync-deadline', 'resume', { kind: 'RESUME' }, y.snapshot));
  assert.equal(dispatchCalls, 0);
  assert.equal(y.kind, 'BLOCKED');
  assert.equal(y.code, 'UnknownDispatch');
  assert.equal(y.snapshot.unknownDispatchCount, 1);
  assert.equal(yields.at(-1)?.code, 'UnknownDispatch');
});

test('abort-before-launch behavior is exact across direct and graph ON admission', async () => {
  const run = async (runId, graph) => {
    const rootDir = await mkdtemp(join(tmpdir(), `lunacy-s7-${graph.toLowerCase()}-`));
    const controller = new AbortController();
    let dispatchCalls = 0;
    const originalCommit = FileArtifactStore.prototype.commit;
    let abortOnClaim = true;
    FileArtifactStore.prototype.commit = async function (generation, state) {
      const command = Object.values(state.outbox ?? {}).find((candidate) => candidate.state === 'CLAIMED');
      if (abortOnClaim && command && state.journal.at(-1)?.event?.kind === 'RESUME') {
        abortOnClaim = false;
        controller.abort();
      }
      return originalCommit.call(this, generation, state);
    };
    try {
      const driver = { dispatch() { dispatchCalls += 1; throw new Error('must not launch'); } };
      const kernel = composeKernel({ plan, rootDir, driver, signal: controller.signal, timeoutMs: 250, acceleration: { graph } });
      let y = await kernel.advance(start(runId));
      y = await kernel.advance(input(runId, 'resume', { kind: 'RESUME' }, y.snapshot));
      return { y, dispatchCalls };
    } finally {
      FileArtifactStore.prototype.commit = originalCommit;
    }
  };
  const direct = await run('parity-direct', 'OFF');
  const graph = await run('parity-graph', 'ON');
  assert.equal(direct.dispatchCalls, 0);
  assert.equal(graph.dispatchCalls, 0);
  assert.equal(direct.y.kind, graph.y.kind);
  assert.equal(direct.y.code, graph.y.code);
  assert.deepEqual(
    { status: direct.y.snapshot.runStatus, gate: direct.y.snapshot.gate, barrier: direct.y.snapshot.barrier, unknown: direct.y.snapshot.unknownDispatchCount, pending: direct.y.snapshot.pendingDispatchCount },
    { status: graph.y.snapshot.runStatus, gate: graph.y.snapshot.gate, barrier: graph.y.snapshot.barrier, unknown: graph.y.snapshot.unknownDispatchCount, pending: graph.y.snapshot.pendingDispatchCount },
  );
});
