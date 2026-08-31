import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/canonical.js';
import { GraphAcceleration, compileStaticGraph, validateStaticGraph } from '../dist/graph.js';
import { AccelerationMetrics } from '../dist/metrics.js';

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
