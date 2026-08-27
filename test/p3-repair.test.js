import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { makeRunKernel } from '../dist/index.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { AccelerationMetrics } from '../dist/metrics.js';
import { makeCellHandle, makeSnapshotHandle } from '../dist/reuse.js';
import { reduce } from '../dist/reducer.js';
import { FileArtifactStore } from '../dist/store.js';

const plan = { phaseId: 'p', steps: [{ stepId: 'a' }, { stepId: 'b', dependencies: ['a'] }] };
const receipt = (command, launchToken) => ({ launchToken, commandDigest: command.commandDigest, ref: { id: 'driver', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } });
const input = (runId, eventId, event, snapshot, launchToken) => ({
  runId, expectedRevision: snapshot?.revision,
  identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) }, event,
});
const start = (runId, eventId = 'start', startPlan = plan) => input(runId, eventId, { kind: 'START', intentRef: { id: 'plan', digest: digest(startPlan) } }, undefined);
const worker = (snapshot, launchToken, eventId = 'worker') => input('r', eventId, { kind: 'WORKER_ENVELOPE', ref: { id: 'worker', digest: digest({ status: 'DONE' }), bytes: canonicalString({ status: 'DONE' }) } }, snapshot, launchToken);
const tokenFor = (runId, stepId) => `launch-${digest({ runId, phaseId: 'p', stepId, attemptEpoch: 0 }).slice(0, 32)}`;

const storePlan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
const storeState = (runId = 'r', writerFence = 'wf') => ({
  schema: 1, runId, phaseId: 'p', revision: 0, authorityEpoch: 0, attemptEpoch: 0,
  barrierEpoch: 0, modeEpoch: 0, writerFence, status: 'ACTIVE', gate: 'NOT-DUE',
  barrier: 'OPEN', steps: { a: { stepId: 'a', status: 'READY', attempt: 0 } },
  outbox: {}, processed: {}, decisionTokens: {}, planDigest: digest(storePlan),
  nextAction: 'start', journal: [],
});
const reuseRecord = (key, bytes, generation, writerFence, runId = 'r') => ({
  key, contentAddress: digest(bytes), bytes, runId, generation, authorityDigest: digest(storePlan),
  authorityEpoch: 0, cellDigest: null, snapshotDigest: null, reuseEpoch: null, writerFence,
  schema: 'safe-fixed-base/v1',
});

test('ON graph uses post-event frontier and preserves cold bytes', async () => {
  const driver = { dispatch: (command, launchToken) => receipt(command, launchToken) };
  const onMetrics = new AccelerationMetrics();
  const off = composeKernel({ plan, maxInFlight: 1, driver });
  const on = composeKernel({ plan, maxInFlight: 1, driver, acceleration: { graph: 'ON', metrics: onMetrics } });
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
  assert.equal(onMetrics.snapshot().graphCandidates > 0, true);
});

test('fixed-cell BASE hits across kernel calls and restart', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-reuse-'));
  const cell = makeCellHandle({ tenant: 'tenant', principal: 'principal', workspace: 'workspace', sensitivity: 'RUN_PRIVATE', accessEpoch: 0, policyEpoch: 0 });
  const snapshot = makeSnapshotHandle({ generation: 1, treeDigest: digest('tree'), symlinkDigest: digest('symlink'), mountDigest: digest('mount'), readSetDigest: digest('read'), sourceDigests: [digest('source')] });
  const firstMetrics = new AccelerationMetrics();
  const options = { plan: { phaseId: 'p', steps: [{ stepId: 'a' }] }, rootDir, acceleration: { context: 'ON', reuse: 'ON', cell, snapshot, metrics: firstMetrics } };
  const first = makeRunKernel(options);
  const y = await first.advance(input('r', 's', { kind: 'START', intentRef: { id: 'plan', digest: digest(options.plan) } }));
  await first.advance(input('r', 'o', { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'host', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } }, y.snapshot));
  assert.equal(firstMetrics.snapshot().contextHit, 1);
  const secondMetrics = new AccelerationMetrics();
  const second = makeRunKernel({ ...options, acceleration: { ...options.acceleration, metrics: secondMetrics } });
  const loaded = await second.advance(input('r', 'r', { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'restart', digest: digest({ restart: true }), bytes: canonicalString({ restart: true }) } }, { ...y.snapshot, revision: 2 }));
  assert.equal(loaded.kind, 'WAITING');
  assert.equal(secondMetrics.snapshot().reuseHit, 1);
  assert.ok(await readFile(join(rootDir, '.kernel', 'reuse', 'index.json'), 'utf8'));
});

test('corrupt BASE is fenced/quarantined and SECRET never probes', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-corrupt-'));
  const cell = makeCellHandle({ tenant: 'tenant', principal: 'principal', workspace: 'workspace', sensitivity: 'RUN_PRIVATE', accessEpoch: 0, policyEpoch: 0 });
  const snapshot = makeSnapshotHandle({ generation: 1, treeDigest: digest('tree'), symlinkDigest: digest('symlink'), mountDigest: digest('mount'), readSetDigest: digest('read'), sourceDigests: [] });
  const metrics = new AccelerationMetrics();
  const options = { plan: { phaseId: 'p', steps: [{ stepId: 'a' }] }, rootDir, acceleration: { context: 'ON', reuse: 'ON', cell, snapshot, metrics } };
  const kernel = makeRunKernel(options);
  const y = await kernel.advance(input('r', 's', { kind: 'START', intentRef: { id: 'plan', digest: digest(options.plan) } }));
  await kernel.advance(input('r', 'o', { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'host', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } }, y.snapshot));
  const index = JSON.parse(await readFile(join(rootDir, '.kernel', 'reuse', 'index.json'), 'utf8'));
  const row = Object.values(index)[0];
  await writeFile(join(rootDir, '.kernel', 'reuse', 'blobs', `${row.contentAddress}.blob`), 'tampered');
  const next = await kernel.advance(input('r', 'c', { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'again', digest: digest({ again: true }), bytes: canonicalString({ again: true }) } }, { ...y.snapshot, revision: 2 }));
  assert.equal(next.kind, 'WAITING');
  const quarantine = await readdir(join(rootDir, '.kernel', 'reuse', 'quarantine'));
  assert.ok(quarantine.some((name) => name.includes(row.contentAddress)));

  const secretMetrics = new AccelerationMetrics();
  const secretCell = makeCellHandle({ tenant: 'tenant', principal: 'principal', workspace: 'workspace', sensitivity: 'SECRET', accessEpoch: 0, policyEpoch: 0 });
  const secretRoot = await mkdtemp(join(tmpdir(), 'lunacy-p3-secret-'));
  const secretKernel = makeRunKernel({ ...options, rootDir: secretRoot, acceleration: { context: 'ON', reuse: 'ON', cell: secretCell, snapshot, metrics: secretMetrics } });
  await secretKernel.advance(input('secret', 's', { kind: 'START', intentRef: { id: 'plan', digest: digest(options.plan) } }));
  assert.equal(secretMetrics.snapshot().contextBypass, 1);
  assert.equal(secretMetrics.snapshot().reuseBypass, 0);
  assert.equal(secretMetrics.snapshot().reuseHit, 0);
});

test('reducer rejects a stale graph frame and uses the direct frontier', () => {
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest({ phaseId: 'p', steps: [{ stepId: 'a' }] }) } };
  const identity = { runId: 'stale', phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'start', payloadDigest: digest(event) };
  const stale = {
    candidateIds: ['not-a-node'], planDigest: digest({ phaseId: 'p', steps: [{ stepId: 'a' }] }), graphDigest: digest('graph'), generation: 0,
    baseStateDigest: null, baseRevision: 0, baseJournalEnd: 0, baseJournalDigest: digest([]), postStateDigest: '0'.repeat(64), postRevision: 1,
    postJournalEnd: 1, postJournalDigest: digest([]), frontierIds: ['not-a-node'], authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0, modeEpoch: 0,
    writerFence: 'none', completeFrontierDigest: digest(['not-a-node']),
  };
  const result = reduce(undefined, { phaseId: 'p', steps: [{ stepId: 'a' }] }, identity, event, 1, true, stale);
  assert.equal(result.state.steps.a.status, 'ACTIVE');
  assert.equal(Object.keys(result.state.outbox).length, 1);
});

test('orphan in-flight reuse pins are quarantined on restart and do not block GC', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-orphan-pin-'));
  const store = new FileArtifactStore(rootDir);
  const key = digest('orphan-key');
  const record = reuseRecord(key, 'orphan-base', 1, 'wf');
  await store.reuseStage(record);
  assert.equal((await readdir(join(rootDir, '.kernel', 'reuse', 'pins'))).length, 1);
  // Simulate a process restart before CURRENT/INDEX publication.  Recovery
  // must prefer a safe miss over guessing that a commit happened.
  const restarted = new FileArtifactStore(rootDir);
  await restarted.load();
  assert.deepEqual(await readdir(join(rootDir, '.kernel', 'reuse', 'pins')), []);
  assert.equal(await restarted.reuseLookup(key), undefined);
  const quarantine = await readdir(join(rootDir, '.kernel', 'reuse', 'quarantine'));
  assert.ok(quarantine.some((name) => name.includes('.pin')));
  assert.ok(quarantine.some((name) => name.includes('.blob')));
});

test('failed CURRENT CAS leaves a staged reuse pin recoverable on the next load', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-failed-pin-'));
  const store = new FileArtifactStore(rootDir);
  await store.commit(0, storeState('r', 'wf'));
  const key = digest('failed-key');
  await store.reuseStage(reuseRecord(key, 'failed-base', 2, 'wf'));
  await assert.rejects(() => store.commit(0, storeState('r', 'wf')), /manifest revision conflict/);
  const restarted = new FileArtifactStore(rootDir);
  await restarted.load();
  assert.deepEqual(await readdir(join(rootDir, '.kernel', 'reuse', 'pins')), []);
  assert.equal(await restarted.reuseLookup(key), undefined);
});

test('reuse publication requires exact CURRENT generation/writer fence and conflicts leave no winner', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-reuse-fence-'));
  const store = new FileArtifactStore(rootDir);
  await store.commit(0, storeState('r', 'wf'));
  const key = digest('same-key');
  const first = reuseRecord(key, 'first-base', 1, 'wf');
  await store.reuseStage(first);
  await store.reusePublish(first);
  assert.ok(await store.reuseLookup(key));

  // A delayed old writer cannot publish against a newer committed generation.
  const delayed = reuseRecord(digest('delayed-key'), 'delayed-base', 1, 'wf');
  await store.reuseStage(delayed);
  await store.commit(1, storeState('r', 'wf'));
  await assert.rejects(() => store.reusePublish(delayed), /publication fence mismatch/);

  // Same-key differing content is fenced deterministically: neither row wins.
  const second = reuseRecord(key, 'second-base', 2, 'wf');
  await store.reuseStage(second);
  await assert.rejects(() => store.reusePublish(second), /conflicting content/);
  assert.equal(await store.reuseLookup(key), undefined);
  const quarantine = await readdir(join(rootDir, '.kernel', 'reuse', 'quarantine'));
  assert.ok(quarantine.some((name) => name.includes('prior.conflict')));
  assert.ok(quarantine.some((name) => name.includes('.conflict')));
});

test('reuse-epoch rollback cannot reuse a BASE from a newer epoch', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-reuse-epoch-'));
  const snapshot = makeSnapshotHandle({ generation: 1, treeDigest: digest('tree'), symlinkDigest: digest('symlink'), mountDigest: digest('mount'), readSetDigest: digest('read'), sourceDigests: [] });
  const cellNew = makeCellHandle({ tenant: 't', principal: 'p', workspace: 'w', sensitivity: 'RUN_PRIVATE', accessEpoch: 0, policyEpoch: 0 }, 2);
  const cellOld = makeCellHandle({ tenant: 't', principal: 'p', workspace: 'w', sensitivity: 'RUN_PRIVATE', accessEpoch: 0, policyEpoch: 0 }, 1);
  const options = { plan: storePlan, rootDir, acceleration: { context: 'ON', reuse: 'ON', cell: cellNew, snapshot } };
  const first = makeRunKernel(options);
  const firstYield = await first.advance(start('epoch-run', 'start', storePlan));
  await first.advance(input('epoch-run', 'epoch-observation', { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'h', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } }, firstYield.snapshot));
  const metrics = new AccelerationMetrics();
  const rolledBack = makeRunKernel({ ...options, acceleration: { ...options.acceleration, cell: cellOld, metrics } });
  await rolledBack.advance(input('epoch-run', 'epoch-rollback', { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'r', digest: digest({ rollback: true }), bytes: canonicalString({ rollback: true }) } }, { ...firstYield.snapshot, revision: 2 }));
  assert.equal(metrics.snapshot().reuseHit, 0);
  assert.equal(metrics.snapshot().reuseMiss, 1);
});

test('same-run frozen trace is byte-identical OFF vs ON, including stale and failed-dispatch rollback', async () => {
  const tracePlan = { phaseId: 'p', steps: [{ stepId: 'a' }, { stepId: 'b', dependencies: ['a'] }] };
  const cell = makeCellHandle({ tenant: 'tenant', principal: 'principal', workspace: 'workspace', sensitivity: 'RUN_PRIVATE', accessEpoch: 0, policyEpoch: 0 });
  const snapshot = makeSnapshotHandle({ generation: 1, treeDigest: digest('tree'), symlinkDigest: digest('symlink'), mountDigest: digest('mount'), readSetDigest: digest('read'), sourceDigests: [] });
  const receiptFor = (command, launchToken) => ({ launchToken, commandDigest: command.commandDigest, ref: { id: 'driver', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } });
  const inputFor = (runId, eventId, event, previous, launchToken) => ({
    runId, expectedRevision: previous?.snapshot?.revision,
    identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: previous?.snapshot?.attemptEpoch ?? 0, authorityEpoch: previous?.snapshot?.authorityEpoch ?? 0, barrierEpoch: previous?.snapshot?.barrierEpoch ?? 0, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) }, event,
  });
  const run = async (mode, rootDir, failing = false) => {
    const driver = { dispatch: (command, launchToken) => { if (failing) throw new Error('simulated dispatch failure'); return receiptFor(command, launchToken); } };
    const options = { plan: tracePlan, rootDir, maxInFlight: 1, driver, ...(mode === 'ON' ? { acceleration: { graph: 'ON', context: 'ON', reuse: 'ON', cell, snapshot } } : {}) };
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
