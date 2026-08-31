import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunKernel } from '../dist/index.js';
import { digest, canonicalString } from '../dist/canonical.js';

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

async function runGrowing(mode) {
  const kernel = makeRunKernel({ plan, maxInFlight: 0, acceleration: { graph: mode } });
  const yields = [];
  let previous;
  for (const [eventId, event] of [['start', startEvent()], ['host-1', hostEvent()], ['host-2', hostEvent('host-2')]]) {
    previous = await kernel.advance(input(`run-${mode}`, eventId, event, previous));
    yields.push(canonicalString(previous));
  }
  return { final: previous, yieldBytes: yields.join('\n') };
}

test('legacy graph decorations preserve exact growing-journal bytes', async () => {
  const results = {};
  for (const mode of ['OFF', 'SHADOW', 'ON']) {
    results[mode] = await runGrowing(mode);
  }
  assert.equal(results.OFF.yieldBytes, results.SHADOW.yieldBytes);
  assert.equal(results.OFF.yieldBytes, results.ON.yieldBytes);
});

test('legacy graph decoration mutation has no runtime effect', async () => {
  const acceleration = { graph: 'ON' };
  const kernel = makeRunKernel({ plan, maxInFlight: 0, acceleration });
  acceleration.graph = 'OFF';
  let value = await kernel.advance(input('snapshot', 'start', startEvent()));
  value = await kernel.advance(input('snapshot', 'host', hostEvent(), value));
  assert.equal(value.snapshot.revision, 2);
});

test('malformed live plan recovery retains the committed direct plan', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p6-previewreduce-'));
  try {
    let kernel = makeRunKernel({ plan, rootDir, maxInFlight: 1, acceleration: { graph: 'ON' } });
    let value = await kernel.advance(input('recovery', 'start', startEvent()));
    value = await kernel.advance(input('recovery', 'resume', { kind: 'RESUME' }, value));
    assert.equal(value.kind, 'BLOCKED');
    assert.equal(value.code, 'HumanReceiptRequired');
    const request = JSON.parse(value.receipt.bytes);
    const launchToken = value.launchToken;
    const receipt = { kind: 'DISPATCH_RECEIPT', ref: { id: 'receipt', digest: digest({ launchToken, commandDigest: request.commandDigest }), bytes: canonicalString({ launchToken, commandDigest: request.commandDigest }) } };
    value = await kernel.advance(input('recovery', 'receipt', receipt, value, launchToken));

    const malformedPlan = { phaseId: plan.phaseId, steps: 'not-an-array' };
    kernel = makeRunKernel({ plan: malformedPlan, rootDir, maxInFlight: 9, acceleration: { graph: 'ON' } });
    const worker = { kind: 'WORKER_ENVELOPE', ref: { id: 'worker', digest: digest({ status: 'DONE' }), bytes: canonicalString({ status: 'DONE' }) } };
    const final = await kernel.advance(input('recovery', 'worker', worker, value, launchToken));
    assert.equal(final.kind, 'FINAL');
    assert.equal(final.status, 'phase-ready');
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
