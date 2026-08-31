import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRunKernel } from '../dist/index.js';
import { canonicalString, digest } from '../dist/canonical.js';

const plan = { phaseId: 'p7-inert-decoration', steps: [{ stepId: 'a' }] };
function input(eventId, event, previous) {
  return { runId: 'p7-inert', ...(previous ? { expectedRevision: previous.snapshot.revision } : {}), identity: { runId: 'p7-inert', phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId, payloadDigest: digest(event) }, event };
}
async function trace(acceleration) {
  const kernel = makeRunKernel({ plan, maxInFlight: 0, acceleration });
  const start = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
  const observation = { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'host', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } };
  const first = await kernel.advance(input('start', start));
  const second = await kernel.advance(input('host', observation, first));
  return [canonicalString(first), canonicalString(second)];
}
test('legacy context and reuse option decoration has no runtime effect', async () => {
  const baseline = await trace(undefined);
  const decorated = await trace({ context: 'ON', reuse: 'ON', cell: { hostile: true }, snapshot: { hostile: true } });
  assert.deepEqual(decorated, baseline);
});
