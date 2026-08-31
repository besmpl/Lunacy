import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeKernel } from '../dist/composition.js';
import { Conflict } from '../dist/index.js';
import { createManagedCapability } from '../dist/managed-capability.js';
import { FileArtifactStore } from '../dist/store.js';
import { canonicalString, digest } from '../dist/canonical.js';

const ref = (id, value, scope) => ({ id, ...(scope === undefined ? {} : { scope }), digest: digest(value), bytes: canonicalString(value) });
const plan = { phaseId: 'p3-s5', steps: [{ stepId: 'work' }] };
const input = (runId, eventId, event, snapshot, launchToken) => ({ runId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}), identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0, authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) }, event });
const start = (runId) => input(runId, 'start', { kind: 'START', intentRef: ref('plan', plan) });
const capability = () => createManagedCapability({ ceilings: { waves: 1, calls: 2, refs: 2, persistedBytes: 2 } });

async function reachDecision(runId, root) {
  const driver = { dispatch(command, launchToken) { return { launchToken, commandDigest: command.commandDigest, ref: ref('receipt', { accepted: true }, 'outbox') }; } };
  const kernel = composeKernel({ plan, rootDir: root, managedCapability: capability(), driver });
  let yielded = await kernel.advance(start(runId));
  yielded = await kernel.advance(input(runId, 'resume', { kind: 'RESUME' }, yielded.snapshot));
  const state = (await new FileArtifactStore(root).load()).state;
  const command = Object.values(state.outbox)[0];
  yielded = await kernel.advance(input(runId, 'worker', { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }, 'worker') }, yielded.snapshot, command.launchToken));
  return { kernel, yielded };
}

test('fresh current-frame reservation is selected after historical UNKNOWN retirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s5-c6-'));
  try {
    let calls = 0;
    const kernel = composeKernel({ plan, rootDir: root, managedCapability: capability(), driver: { dispatch() { calls += 1; throw new Error('ambiguous'); } } });
    let yielded = await kernel.advance(start('c6-fresh'));
    yielded = await kernel.advance(input('c6-fresh', 'resume-1', { kind: 'RESUME' }, yielded.snapshot));
    yielded = await kernel.advance(input('c6-fresh', 'resume-2', { kind: 'RESUME' }, yielded.snapshot));
    yielded = await kernel.advance(input('c6-fresh', 'resume-3', { kind: 'RESUME' }, yielded.snapshot));
    assert.equal(yielded.code, 'UnknownDispatch');
    assert.equal(calls, 2);
    const state = (await new FileArtifactStore(root).load()).state;
    assert.ok(Object.values(state.outbox).some((command) => command.attemptEpoch === 1 && command.state === 'UNKNOWN'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('superseded status-only disposition fixture is explicitly rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s5-c7-'));
  try {
    const { yielded } = await reachDecision('c7-closed', root);
    assert.equal(yielded.kind, 'BLOCKED');
    assert.match(yielded.reason, /Report\/v2|prefix/i);
    const state = (await new FileArtifactStore(root).load()).state;
    assert.equal(Object.values(state.decisionTokens).some((token) => token.kind === 'DELIBERATION_SELECTION'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed adoption updates proposal digest in the same authority CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s5-c8-'));
  try {
    const livePlan = { phaseId: 'p3-s5', steps: [{ stepId: 'work' }] };
    const kernel = composeKernel({ plan: livePlan, rootDir: root, managedCapability: capability(), maxInFlight: 0 });
    const started = await kernel.advance(input('c8-adopt', 'start', { kind: 'START', intentRef: ref('plan', livePlan) }));
    const changed = { ...livePlan, steps: [...livePlan.steps, { stepId: 'new' }] };
    livePlan.steps.push({ stepId: 'new' });
    const drift = await kernel.advance(input('c8-adopt', 'drift', { kind: 'RESUME' }, started.snapshot));
    assert.equal(drift.kind, 'DECISION_REQUIRED');
    const adopted = await kernel.advance(input('c8-adopt', 'adopt', { kind: 'PARENT_DECISION', token: drift.token, value: { kind: 'ADOPT', digest: digest(changed) } }, drift.snapshot));
    assert.equal(adopted.kind, 'WAITING');
    const state = (await new FileArtifactStore(root).load()).state;
    assert.equal(state.managed.proposal.planDigest, state.planDigest);
  } finally { await rm(root, { recursive: true, force: true }); }
});
