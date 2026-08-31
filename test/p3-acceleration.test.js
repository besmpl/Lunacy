import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/canonical.js';
import { createInitialState, reduce } from '../dist/reducer.js';
import { validatePlan } from '../dist/validator.js';

const plan = { phaseId: 'p', steps: [
  { stepId: 'b', dependencies: ['a'], claims: [{ resource: 'output/x', mode: 'WRITE' }] },
  { stepId: 'a', claims: [{ resource: 'input/x', mode: 'READ' }] },
  { stepId: 'c', claims: [{ resource: 'output/x', mode: 'READ' }] },
] };

test('direct reducer deterministically enforces dependencies and conflicts', () => {
  const normalized = validatePlan(plan).plan;
  const state = createInitialState('r', normalized, digest(normalized), 'none');
  state.steps.a.status = 'DONE';
  const event = { kind: 'RESUME' };
  const identity = { runId: 'r', phaseId: 'p', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'resume', payloadDigest: digest(event) };
  const result = reduce(state, normalized, identity, event, 2, true);
  assert.deepEqual(Object.values(result.state.outbox).map((command) => command.stepId), ['c']);
  assert.equal(result.state.steps.b.status, 'READY');
  assert.equal(result.state.steps.c.status, 'ACTIVE');
});
