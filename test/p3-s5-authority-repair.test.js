import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeKernel } from '../dist/composition.js';
import { createManagedCapability } from '../dist/managed-capability.js';
import { FileArtifactStore } from '../dist/store.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { authorExactManagedFixture, exactManagedTeardown, makeExactManagedKernel } from './exact-managed-harness.js';

const ref = (id, value, scope) => ({ id, ...(scope === undefined ? {} : { scope }), digest: digest(value), bytes: canonicalString(value) });
const plan = { phaseId: 'p3-s5', steps: [{ stepId: 'work' }] };
const policy = {
  version: ref('policy', { generation: 1 }, 'policy'),
  frameCatalog: [0, 1, 2, 3].map((i) => ({ frameId: `f${i}`, tag: 'code', text: `frame-${i}` })).concat([{ frameId: 'wild', tag: 'wild', text: 'wild' }]),
  maxMaterialDecisions: 4, maxSettlementBytes: 10_000_000, maxResolvedRoleInputBytes: 10_000_000,
  convergeCount: 3, nonObviousNovelty: 5, viableFloor: 5,
};
const input = (runId, eventId, event, snapshot, launchToken) => ({ runId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}), identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0, authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) }, event });
const capability = (calls = 2) => createManagedCapability({ ceilings: { waves: 1, calls, refs: calls, persistedBytes: calls } });

async function reachDecision(runId, root) {
  const fixture = authorExactManagedFixture({ runId, phaseId: 'p3-s5', policy });
  const driver = { dispatch(command, launchToken) { return { launchToken, commandDigest: command.commandDigest, ref: fixture.byStep.get(command.stepId) }; } };
  const kernel = makeExactManagedKernel({ plan: fixture.plan, rootDir: root, capability: capability(3), waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: 2, driver });
  let yielded = await kernel.advance(input(runId, 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) }));
  yielded = await kernel.advance(input(runId, 'resume', { kind: 'RESUME' }, yielded.snapshot));
  const state = (await new FileArtifactStore(root).load()).state;
  const command = Object.values(state.outbox).find((candidate) => candidate.state === 'ACKED' && state.steps[candidate.stepId]?.status === 'ACTIVE');
  yielded = await kernel.advance(input(runId, 'worker', { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }, 'worker') }, yielded.snapshot, command.launchToken));
  return { kernel, yielded };
}

test('fresh current-frame reservation is selected after historical UNKNOWN retirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-s5-c6-'));
  try {
    let calls = 0;
    const fixture = authorExactManagedFixture({ runId: 'c6-fresh', phaseId: 'p3-s5', policy });
    const kernel = makeExactManagedKernel({ plan: fixture.plan, rootDir: root, capability: capability(4), waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: 2, driver: {
      dispatch() { calls += 1; throw new Error('ambiguous'); },
      observeTeardown(_token, _commandDigest, _signal, command) { return exactManagedTeardown(command); },
    } });
    let yielded = await kernel.advance(input('c6-fresh', 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) }));
    for (let index = 1; index <= 8 && calls < 2; index += 1) {
      yielded = await kernel.advance(input('c6-fresh', `resume-${index}`, { kind: 'RESUME' }, yielded.snapshot));
    }
    assert.equal(yielded.code, 'UnknownDispatch');
    assert.equal(calls, 2);
    const state = (await new FileArtifactStore(root).load()).state;
    assert.ok(Object.values(state.outbox).some((command) => command.attemptEpoch === 1 && command.state === 'UNKNOWN'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('status-only disposition fixture is explicitly rejected', async () => {
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
