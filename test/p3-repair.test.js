import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { reduce } from '../dist/reducer.js';

const plan = { phaseId: 'p', steps: [{ stepId: 'a' }, { stepId: 'b', dependencies: ['a'] }] };
const receipt = (command, launchToken) => ({ launchToken, commandDigest: command.commandDigest, ref: { id: 'driver', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } });
const input = (runId, eventId, event, snapshot, launchToken) => ({
  runId, expectedRevision: snapshot?.revision,
  identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) }, event,
});
const start = (runId, eventId = 'start', startPlan = plan) => input(runId, eventId, { kind: 'START', intentRef: { id: 'plan', digest: digest(startPlan) } }, undefined);
const worker = (snapshot, launchToken, eventId = 'worker') => input('r', eventId, { kind: 'WORKER_ENVELOPE', ref: { id: 'worker', digest: digest({ status: 'DONE' }), bytes: canonicalString({ status: 'DONE' }) } }, snapshot, launchToken);
const tokenFor = (runId, stepId) => `launch-${digest({ runId, phaseId: 'p', stepId, attemptEpoch: 0 }).slice(0, 32)}`;

test('legacy graph decoration preserves direct post-event admission and cold bytes', async () => {
  const driver = { dispatch: (command, launchToken) => receipt(command, launchToken) };
  const off = composeKernel({ plan, maxInFlight: 1, driver });
  const on = composeKernel({ plan, maxInFlight: 1, driver, acceleration: { graph: 'ON' } });
  let cold = await off.advance(start('cold'));
  let graph = await on.advance(start('graph'));
  assert.deepEqual(graph, cold);
  cold = await off.advance(input('cold', 'resume', { kind: 'RESUME' }, cold.snapshot));
  graph = await on.advance(input('graph', 'resume', { kind: 'RESUME' }, graph.snapshot));
  assert.deepEqual(graph.snapshot, cold.snapshot);
  const coldToken = tokenFor('cold', 'a');
  const graphToken = tokenFor('graph', 'a');
  cold = await off.advance({ ...worker(cold.snapshot, coldToken, 'worker'), runId: 'cold', identity: { ...worker(cold.snapshot, coldToken, 'worker').identity, runId: 'cold' } });
  graph = await on.advance({ ...worker(graph.snapshot, graphToken, 'worker'), runId: 'graph', identity: { ...worker(graph.snapshot, graphToken, 'worker').identity, runId: 'graph' } });
  assert.equal(graph.snapshot.readyCount, 0);
  assert.equal(graph.snapshot.activeCount, 1, 'successor is admitted during the completion call');
  assert.equal(graph.snapshot.pendingDispatchCount, cold.snapshot.pendingDispatchCount);
});

test('reducer derives the complete frontier directly', () => {
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest({ phaseId: 'p', steps: [{ stepId: 'a' }] }) } };
  const identity = { runId: 'stale', phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'start', payloadDigest: digest(event) };
  const result = reduce(undefined, { phaseId: 'p', steps: [{ stepId: 'a' }] }, identity, event, 1, true);
  assert.equal(result.state.steps.a.status, 'ACTIVE');
  assert.equal(Object.keys(result.state.outbox).length, 1);
});

test('same-run frozen trace is byte-identical reducer/store vs graph hint, including stale and failed-dispatch rollback', async () => {
  const tracePlan = { phaseId: 'p', steps: [{ stepId: 'a' }, { stepId: 'b', dependencies: ['a'] }] };
  const receiptFor = (command, launchToken) => ({ launchToken, commandDigest: command.commandDigest, ref: { id: 'driver', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } });
  const inputFor = (runId, eventId, event, previous, launchToken) => ({
    runId, expectedRevision: previous?.snapshot?.revision,
    identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: previous?.snapshot?.attemptEpoch ?? 0, authorityEpoch: previous?.snapshot?.authorityEpoch ?? 0, barrierEpoch: previous?.snapshot?.barrierEpoch ?? 0, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) }, event,
  });
  const run = async (mode, rootDir, failing = false) => {
    const driver = { dispatch: (command, launchToken) => { if (failing) throw new Error('simulated dispatch failure'); return receiptFor(command, launchToken); } };
    const options = { plan: tracePlan, rootDir, maxInFlight: 1, driver, ...(mode === 'ON' ? { acceleration: { graph: 'ON' } } : {}) };
    const kernel = composeKernel(options); const yields = []; const states = [];
    const persist = async () => {
      const current = JSON.parse(await readFile(join(rootDir, '.kernel', 'CURRENT'), 'utf8'));
      states.push(await readFile(join(rootDir, '.kernel', 'generations', `g${current.generation}`, 'state.json'), 'utf8'));
    };
    let y = await kernel.advance(inputFor('frozen', 'start', { kind: 'START', intentRef: { id: 'plan', digest: digest(tracePlan) } })); yields.push(y); await persist();
    await assert.rejects(() => kernel.advance(inputFor('frozen', 'stale', { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'stale', digest: digest({ stale: true }), bytes: canonicalString({ stale: true }) } }, { snapshot: { ...y.snapshot, revision: 0 } })), /stale or missing expectedRevision/);
    y = await kernel.advance(inputFor('frozen', 'resume-a', { kind: 'RESUME' }, y)); yields.push(y); await persist();
    if (failing) return { yields, states };
    y = await kernel.advance(inputFor('frozen', 'worker-a', { kind: 'WORKER_ENVELOPE', ref: { id: 'worker', digest: digest({ status: 'DONE' }), bytes: canonicalString({ status: 'DONE' }) } }, y, tokenFor('frozen', 'a'))); yields.push(y); await persist();
    y = await kernel.advance(inputFor('frozen', 'resume-b', { kind: 'RESUME' }, y)); yields.push(y); await persist();
    y = await kernel.advance(inputFor('frozen', 'worker-b', { kind: 'WORKER_ENVELOPE', ref: { id: 'worker', digest: digest({ status: 'DONE' }), bytes: canonicalString({ status: 'DONE' }) } }, y, tokenFor('frozen', 'b'))); yields.push(y); await persist();
    return { yields, states };
  };
  const offRoot = await mkdtemp(join(tmpdir(), 'lunacy-p3-frozen-off-'));
  const onRoot = await mkdtemp(join(tmpdir(), 'lunacy-p3-frozen-on-'));
  const [off, on] = await Promise.all([run('OFF', offRoot), run('ON', onRoot)]);
  assert.deepEqual(on.yields, off.yields);
  assert.deepEqual(on.states, off.states);

  const failOffRoot = await mkdtemp(join(tmpdir(), 'lunacy-p3-rollback-off-'));
  const failOnRoot = await mkdtemp(join(tmpdir(), 'lunacy-p3-rollback-on-'));
  const [failOff, failOn] = await Promise.all([run('OFF', failOffRoot, true), run('ON', failOnRoot, true)]);
  assert.deepEqual(failOn.yields, failOff.yields);
  assert.deepEqual(failOn.states, failOff.states);
});
