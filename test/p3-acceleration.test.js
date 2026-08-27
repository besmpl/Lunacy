import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/canonical.js';
import { GraphAcceleration, compileStaticGraph, validateStaticGraph } from '../dist/graph.js';
import { ContextCompiler } from '../dist/compiler.js';
import { AccelerationMetrics } from '../dist/metrics.js';
import { FixedCellReuse, makeCellHandle, makeSnapshotHandle } from '../dist/reuse.js';

const plan = { phaseId: 'p', steps: [
  { stepId: 'b', dependencies: ['a'], claims: [{ resource: 'output/x', mode: 'WRITE' }] },
  { stepId: 'a', claims: [{ resource: 'input/x', mode: 'READ' }] },
  { stepId: 'c', claims: [{ resource: 'output/x', mode: 'READ' }] },
] };

test('static graph has verified reverse indexes and deterministic maximal candidates', () => {
  const graph = compileStaticGraph('r', plan);
  validateStaticGraph(graph);
  assert.deepEqual(graph.nodes.map((node) => node.id), ['a', 'c', 'b']);
  const state = {
    schema: 1, runId: 'r', phaseId: 'p', revision: 2, authorityEpoch: 0, attemptEpoch: 0,
    barrierEpoch: 0, modeEpoch: 0, writerFence: 'none', status: 'ACTIVE', gate: 'NOT-DUE', barrier: 'OPEN',
    steps: { a: { ...plan.steps[1], status: 'DONE', attempt: 0 }, b: { ...plan.steps[0], status: 'READY', attempt: 0 }, c: { ...plan.steps[2], status: 'READY', attempt: 0 } },
    outbox: {}, processed: {}, decisionTokens: {}, planDigest: digest(plan), nextAction: 'advance-ready-steps', journal: [],
  };
  const metrics = new AccelerationMetrics();
  const prepared = new GraphAcceleration('ON', metrics).prepare({ runId: 'r', plan, state, maxInFlight: 2 });
  assert.deepEqual(prepared.candidates.map((candidate) => candidate.nodeId), ['c']);
  assert.equal(prepared.diagnostics.fallback, false);
  assert.equal(metrics.snapshot().graphCandidates, 1);
});

test('context stable prefix is proof-bound and dynamic tail is never reused', async () => {
  const metrics = new AccelerationMetrics();
  const snapshot = makeSnapshotHandle({ generation: 1, treeDigest: digest('tree'), symlinkDigest: digest('symlink'), mountDigest: digest('mount'), readSetDigest: digest('read'), sourceDigests: [digest('source')] });
  const cell = makeCellHandle({ tenant: 't', principal: 'p', workspace: 'w', sensitivity: 'RUN_PRIVATE', accessEpoch: 0, policyEpoch: 0 });
  const compiler = new ContextCompiler({ mode: 'ON', reuseMode: 'ON', metrics });
  const base = { proof: { runId: 'r', authorityDigest: digest(plan), authorityEpoch: 0, generation: 1, revision: 0 }, scope: { tenant: 't', principal: 'p', workspace: 'w', sensitivity: 'RUN_PRIVATE' }, sources: [{ id: 'source', digest: digest('source') }], kind: 'BASE', derivation: { id: 'test', version: '1', schema: 'v1' }, snapshot, cell, build: (value) => JSON.stringify(value) };
  const first = await compiler.prepare({ ...base, dynamicTail: { bytes: 'tail-a', eventId: 'e1', snapshotDigest: digest(snapshot) } });
  const second = await compiler.prepare({ ...base, dynamicTail: { bytes: 'tail-b', eventId: 'e2', snapshotDigest: digest(snapshot) } });
  assert.equal(first.stableDigest, second.stableDigest);
  assert.notEqual(first.requestBytes, second.requestBytes);
  assert.equal(second.hit, true);
  assert.equal(metrics.snapshot().contextHit, 1);
});

test('SECRET and corrupt fixed-cell entries fail closed without a probe', () => {
  const metrics = new AccelerationMetrics();
  const cell = makeCellHandle({ tenant: 't', principal: 'p', workspace: 'w', sensitivity: 'SECRET', accessEpoch: 0, policyEpoch: 0 });
  const snapshot = makeSnapshotHandle({ generation: 1, treeDigest: digest('tree'), symlinkDigest: digest('symlink'), mountDigest: digest('mount'), readSetDigest: digest('read'), sourceDigests: [] });
  const reuse = new FixedCellReuse('ON', metrics);
  const result = reuse.prepare({ runId: 'r', cell, snapshot, authorityDigest: digest(plan), authorityEpoch: 0, derivation: { id: 'x', version: '1', schema: 'v1' }, sources: [], sensitivity: 'SECRET', build: () => 'cold' });
  assert.equal(result.hit, false);
  assert.equal(result.bytes, 'cold');
  assert.equal(metrics.snapshot().reuseBypass, 1);
});

test('fixed-cell reuse is run-bound and deletion is a cold-equivalent miss', () => {
  const metrics = new AccelerationMetrics();
  const cell = makeCellHandle({ tenant: 't', principal: 'p', workspace: 'w', sensitivity: 'RUN_PRIVATE', accessEpoch: 0, policyEpoch: 0 });
  const snapshot = makeSnapshotHandle({ generation: 1, treeDigest: digest('tree'), symlinkDigest: digest('symlink'), mountDigest: digest('mount'), readSetDigest: digest('read'), sourceDigests: [] });
  const reuse = new FixedCellReuse('ON', metrics);
  const request = (runId) => ({ runId, cell, snapshot, authorityDigest: digest(plan), authorityEpoch: 0, derivation: { id: 'x', version: '1', schema: 'v1' }, sources: [], build: () => '{"stable":true}' });
  const first = reuse.prepare(request('r1'));
  const otherRun = reuse.prepare(request('r2'));
  assert.equal(first.hit, false);
  assert.equal(otherRun.hit, false);
  assert.equal(reuse.size(), 2);
  reuse.clear();
  const coldAfterDelete = reuse.prepare(request('r1'));
  assert.equal(coldAfterDelete.hit, false);
  assert.equal(coldAfterDelete.contentAddress, first.contentAddress);
});
