import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunKernel } from '../dist/index.js';
import { digest, canonicalString } from '../dist/canonical.js';
import { AccelerationMetrics } from '../dist/metrics.js';

const plan = { phaseId: 'p6-previewreduce', steps: [{ stepId: 'a' }] };
const payload = { observed: true };

function input(runId, eventId, event, previous, launchToken) {
  return {
    runId,
    ...(previous ? { expectedRevision: previous.snapshot.revision } : {}),
    identity: {
      runId,
      phaseId: 'run',
      stepId: 'run',
      attemptEpoch: previous?.snapshot.attemptEpoch ?? 0,
      authorityEpoch: previous?.snapshot.authorityEpoch ?? 0,
      barrierEpoch: previous?.snapshot.barrierEpoch ?? 0,
      eventId,
      payloadDigest: digest(event),
      ...(launchToken ? { launchToken } : {}),
    },
    event,
  };
}

function startEvent() {
  return { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
}

function hostEvent(id = 'host-1') {
  return { kind: 'OBSERVATION', category: 'HOST', ref: { id, scope: 'p6', digest: digest(payload), bytes: canonicalString(payload) } };
}

async function runGrowing(mode, metrics) {
  const kernel = makeRunKernel({ plan, maxInFlight: 0, acceleration: { graph: mode, metrics } });
  const yields = [];
  let previous;
  for (const [eventId, event] of [['start', startEvent()], ['host-1', hostEvent()], ['host-2', hostEvent('host-2')]]) {
    previous = await kernel.advance(input(`run-${mode}`, eventId, event, previous));
    yields.push(canonicalString(previous));
  }
  return { final: previous, yieldBytes: yields.join('\n') };
}

test('OFF bypasses preview while SHADOW and ON retain graph preparation and identical yields', async () => {
  const results = {};
  for (const mode of ['OFF', 'SHADOW', 'ON']) {
    const metrics = new AccelerationMetrics();
    results[mode] = { run: await runGrowing(mode, metrics), metrics: metrics.snapshot() };
  }
  assert.equal(results.OFF.metrics.graphPrepare, 0);
  assert.ok(results.SHADOW.metrics.graphPrepare > 0);
  assert.ok(results.ON.metrics.graphPrepare > 0);
  assert.equal(results.OFF.run.yieldBytes, results.SHADOW.run.yieldBytes);
  assert.equal(results.OFF.run.yieldBytes, results.ON.run.yieldBytes);
});

test('graph mode is a construction snapshot shared by bypass and preparation gates', async () => {
  const metrics = new AccelerationMetrics();
  const acceleration = { graph: 'ON', metrics };
  const kernel = makeRunKernel({ plan, maxInFlight: 0, acceleration });
  acceleration.graph = 'OFF';
  let value = await kernel.advance(input('snapshot', 'start', startEvent()));
  value = await kernel.advance(input('snapshot', 'host', hostEvent(), value));
  assert.ok(metrics.snapshot().graphPrepare > 0);
});

test('malformed live plan recovery suppresses graph preparation', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p6-previewreduce-'));
  try {
    const metrics = new AccelerationMetrics();
    let kernel = makeRunKernel({ plan, rootDir, maxInFlight: 1, acceleration: { graph: 'ON', metrics } });
    let value = await kernel.advance(input('recovery', 'start', startEvent()));
    value = await kernel.advance(input('recovery', 'resume', { kind: 'RESUME' }, value));
    assert.equal(value.kind, 'BLOCKED');
    assert.equal(value.code, 'HumanReceiptRequired');
    const request = JSON.parse(value.receipt.bytes);
    const launchToken = value.launchToken;
    const receipt = { kind: 'DISPATCH_RECEIPT', ref: { id: 'receipt', digest: digest({ launchToken, commandDigest: request.commandDigest }), bytes: canonicalString({ launchToken, commandDigest: request.commandDigest }) } };
    value = await kernel.advance(input('recovery', 'receipt', receipt, value, launchToken));

    const malformedPlan = { phaseId: plan.phaseId, steps: 'not-an-array' };
    kernel = makeRunKernel({ plan: malformedPlan, rootDir, maxInFlight: 9, acceleration: { graph: 'ON', metrics } });
    metrics.reset();
    const worker = { kind: 'WORKER_ENVELOPE', ref: { id: 'worker', digest: digest({ status: 'DONE' }), bytes: canonicalString({ status: 'DONE' }) } };
    const final = await kernel.advance(input('recovery', 'worker', worker, value, launchToken));
    assert.equal(metrics.snapshot().graphPrepare, 0);
    assert.equal(final.kind, 'FINAL');
    assert.equal(final.status, 'phase-ready');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
