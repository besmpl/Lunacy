import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { canonicalString, digest } from '../dist/canonical.js';
import { createManagedCapability } from '../dist/managed-capability.js';
import { ONE_SHOT_ROLLOUT_GENERATION_FLOOR } from '../dist/one-shot.js';
import { FileArtifactStore, MemoryArtifactStore } from '../dist/store.js';
import { retireManagedAttempt } from '../dist/reducer.js';
import { validatePlan } from '../dist/validator.js';
import { authorExactManagedFixture, exactManagedTeardown, makeExactManagedKernel } from './exact-managed-harness.js';

const phaseId = 'p2-one-shot';
const ref = (id, value, scope) => ({ id, ...(scope ? { scope } : {}), digest: digest(value), bytes: canonicalString(value) });
const policy = {
  version: ref('policy', { generation: 1 }, 'policy'),
  frameCatalog: [0, 1, 2, 3].map((i) => ({ frameId: `f${i}`, tag: 'code', text: `frame-${i}` })).concat([{ frameId: 'wild', tag: 'wild', text: 'wild' }]),
  maxMaterialDecisions: 4, maxSettlementBytes: 10_000_000, maxResolvedRoleInputBytes: 10_000_000,
  convergeCount: 3, nonObviousNovelty: 5, viableFloor: 5,
};

function input(runId, eventId, event, snapshot, launchToken) {
  return {
    runId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}), event,
    identity: {
      runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0,
      authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0,
      eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}),
    },
  };
}

async function load(root) { return new FileArtifactStore(root).load(); }

function capabilityFor(gear) {
  const calls = gear === 'EXPLORE' ? 9 : 3;
  return createManagedCapability({ ceilings: { waves: 1, calls, refs: 512, reportBytes: 10_000_000, persistedBytes: 10_000_000 } });
}

async function unknownFixture({ generation, gear = 'FOCUS', mode }) {
  const root = await mkdtemp(join(tmpdir(), `p2-one-shot-${gear.toLowerCase()}-`));
  const runId = `p2-${gear.toLowerCase()}-${generation}-${mode ?? 'default'}`;
  const fixture = authorExactManagedFixture({ runId, phaseId, policy, gear });
  let providerCalls = 0;
  const driver = {
    dispatch(command, launchToken) {
      providerCalls += 1;
      if (providerCalls === 2) throw new Error('poison second provider entry');
      return { launchToken, commandDigest: command.commandDigest, ref: fixture.byStep.get(command.stepId) };
    },
    observeTeardown(_token, _digest, _signal, command) { return exactManagedTeardown(command); },
  };
  const options = {
    plan: fixture.plan, rootDir: root, capability: capabilityFor(gear), waveRef: fixture.waveRef, wave: fixture.wave,
    policy, maxInFlight: gear === 'EXPLORE' ? 5 : 2, rolloutGeneration: generation, ...(mode ? { rolloutMode: mode } : {}), driver,
  };
  let kernel = makeExactManagedKernel(options);
  let yielded = await kernel.advance(input(runId, 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) }));
  for (let index = 0; index < 20 && yielded.kind !== 'BLOCKED'; index += 1) {
    yielded = await kernel.advance(input(runId, `resume-${index}`, { kind: 'RESUME' }, yielded.snapshot));
  }
  assert.equal(yielded.kind, 'BLOCKED');
  assert.equal(yielded.code, 'UnknownDispatch');
  assert.equal(providerCalls, 2);
  const unknown = await load(root);
  const command = Object.values(unknown.state.outbox).find((candidate) => candidate.state === 'UNKNOWN');
  assert.ok(command);
  return { root, runId, fixture, options, yielded, unknown, command, providerCalls: () => providerCalls, restart() { kernel = makeExactManagedKernel(options); return kernel; } };
}

test('sealed floor is strictly newer than the accepted compatibility generations', () => {
  assert.equal(ONE_SHOT_ROLLOUT_GENERATION_FLOOR, 22);
  assert.ok(ONE_SHOT_ROLLOUT_GENERATION_FLOOR > 21);
});

test('current Focus admission rejects the legacy collision without consumption while below-floor replay stays readable', async () => {
  async function run(generation) {
    const root = await mkdtemp(join(tmpdir(), `p3-focus-collision-${generation}-`));
    const runId = `p3-focus-collision-${generation}`; const fixture = authorExactManagedFixture({ runId, phaseId, policy });
    const legacyCritic = structuredClone(fixture.reports[2]); legacyCritic.clusters.push({ label: 'c', ideas: [] });
    const legacyRef = ref(`report:${digest(legacyCritic).slice(0, 16)}`, legacyCritic, 'deliberation/report');
    fixture.byStep.set(fixture.topology.slots[2].stepId, legacyRef);
    const launched = new Map(); const driver = { dispatch(command, launchToken) { launched.set(command.commandId, structuredClone(command)); return { launchToken, commandDigest: command.commandDigest, ref: fixture.byStep.get(command.stepId) }; } };
    const kernel = makeExactManagedKernel({ plan: fixture.plan, rootDir: root, capability: capabilityFor('FOCUS'), waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: 2, rolloutGeneration: generation, driver });
    let yielded = await kernel.advance(input(runId, 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) })); let criticInput;
    const completed = new Set();
    for (let index = 0; index < 100 && yielded.kind !== 'DECISION_REQUIRED' && yielded.kind !== 'BLOCKED'; index += 1) {
      const command = [...launched.values()].find((candidate) => !completed.has(candidate.commandId));
      if (!command) { yielded = await kernel.advance(input(runId, `resume-${index}`, { kind: 'RESUME' }, yielded.snapshot)); continue; }
      completed.add(command.commandId); const event = { kind: 'WORKER_ENVELOPE', ref: fixture.byStep.get(command.stepId) };
      const nextInput = input(runId, `report-${index}`, event, yielded.snapshot, command.launchToken); if (command.stepId === fixture.topology.slots[2].stepId) criticInput = nextInput;
      yielded = await kernel.advance(nextInput);
    }
    return { root, kernel, yielded, criticInput, state: (await load(root)).state };
  }
  const current = await run(ONE_SHOT_ROLLOUT_GENERATION_FLOOR);
  try {
    assert.equal(current.yielded.kind, 'BLOCKED'); assert.equal(Object.keys(current.state.managed.acceptedReports).length, 2); assert.equal(Object.values(current.state.decisionTokens).some((token) => token.kind === 'DELIBERATION_SELECTION'), false);
    const before = (await load(current.root)).generation; const replay = await current.kernel.advance(current.criticInput); assert.equal(canonicalString(replay), canonicalString(current.yielded)); assert.equal((await load(current.root)).generation, before);
  } finally { await rm(current.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
  const historical = await run(ONE_SHOT_ROLLOUT_GENERATION_FLOOR - 1);
  try { assert.equal(historical.yielded.kind, 'DECISION_REQUIRED'); assert.equal(Object.keys(historical.state.managed.acceptedReports).length, 3); }
  finally { await rm(historical.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('File restart lattice terminalizes Focus below/at/above the floor without retrying one-shot commands', async () => {
  for (const [generation, mode, oneShot] of [
    [ONE_SHOT_ROLLOUT_GENERATION_FLOOR - 1, 'focus-canary', false],
    [ONE_SHOT_ROLLOUT_GENERATION_FLOOR, 'focus-canary', true],
    [ONE_SHOT_ROLLOUT_GENERATION_FLOOR + 1, 'automatic-focus', true],
  ]) {
    const fx = await unknownFixture({ generation, mode });
    try {
      const beforeReservations = Object.keys(fx.unknown.state.managed.reservations).sort();
      const beforeCounters = structuredClone(fx.unknown.state.managed.waveCounters);
      const restarted = fx.restart();
      const retired = await restarted.advance(input(fx.runId, 'retire', { kind: 'RESUME' }, fx.yielded.snapshot));
      const after = await load(fx.root);
      assert.equal(after.state.managed.attempts[fx.command.commandId].status, 'TIMED_OUT');
      if (!oneShot) {
        assert.equal(retired.kind, 'WAITING');
        assert.equal(after.state.attemptEpoch, 1);
        assert.ok(Object.values(after.state.outbox).some((command) => command.attemptEpoch === 1 && command.state === 'PENDING'));
        continue;
      }
      assert.equal(retired.kind, 'BLOCKED');
      assert.equal(retired.code, 'UnknownDispatch');
      assert.equal(after.state.status, 'BLOCKED');
      assert.equal(after.state.steps[fx.command.stepId].status, 'ACTIVE');
      assert.equal(after.state.attemptEpoch, 0);
      assert.deepEqual(Object.keys(after.state.managed.reservations).sort(), beforeReservations);
      assert.deepEqual(after.state.managed.waveCounters, beforeCounters);
      assert.equal(fx.providerCalls(), 2);
      const bytes = canonicalString(retired);
      const repeated = await restarted.advance(input(fx.runId, 'repeat', { kind: 'RESUME' }, retired.snapshot));
      assert.equal(canonicalString(repeated), bytes);
      assert.equal((await load(fx.root)).generation, after.generation);
      assert.equal(fx.providerCalls(), 2, 'poison driver proves no second-boundary retry');
      const late = ref('late', { ignored: true }, 'deliberation/report');
      const proof = ref(`receipt:${fx.command.launchToken}`, { launchToken: fx.command.launchToken, commandDigest: fx.command.commandDigest, receipt: late }, 'outbox/receipt');
      await assert.rejects(() => restarted.advance(input(fx.runId, 'late', { kind: 'DISPATCH_RECEIPT', ref: proof }, retired.snapshot, fx.command.launchToken)));
      assert.equal((await load(fx.root)).generation, after.generation);
    } finally { await rm(fx.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
  }
});

test('Explore canary at the floor uses the same one-shot terminal branch', async () => {
  const fx = await unknownFixture({ generation: ONE_SHOT_ROLLOUT_GENERATION_FLOOR, gear: 'EXPLORE' });
  try {
    const retired = await fx.restart().advance(input(fx.runId, 'retire', { kind: 'RESUME' }, fx.yielded.snapshot));
    const state = (await load(fx.root)).state;
    assert.equal(retired.kind, 'BLOCKED');
    assert.equal(state.attemptEpoch, 0);
    assert.equal(state.managed.attempts[fx.command.commandId].status, 'TIMED_OUT');
    assert.equal(fx.providerCalls(), 2);
  } finally { await rm(fx.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('unproven managed teardown remains CLAIMED and cannot enter a provider twice after File restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2-one-shot-claimed-'));
  try {
    const runId = 'p2-claimed-unproven'; const fixture = authorExactManagedFixture({ runId, phaseId, policy });
    let calls = 0;
    let rejectPending;
    const pending = new Promise((_, reject) => { rejectPending = reject; });
    const base = { plan: fixture.plan, rootDir: root, capability: capabilityFor('FOCUS'), waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: 2, rolloutGeneration: ONE_SHOT_ROLLOUT_GENERATION_FLOOR };
    let kernel = makeExactManagedKernel({ ...base, timeoutMs: 60_000, driver: { dispatch() { calls += 1; return pending; } } });
    let yielded = await kernel.advance(input(runId, 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) }));
    yielded = await kernel.advance(input(runId, 'claim', { kind: 'RESUME' }, yielded.snapshot));
    const claimed = await load(root); const command = Object.values(claimed.state.outbox).find((candidate) => candidate.state === 'CLAIMED');
    assert.ok(command); assert.equal(calls, 1);
    kernel = makeExactManagedKernel({ ...base, driver: { dispatch() { calls += 1; throw new Error('must not enter'); } } });
    const blocked = await kernel.advance(input(runId, 'restart', { kind: 'RESUME' }, claimed.state));
    assert.equal(blocked.kind, 'BLOCKED'); assert.match(blocked.reason, /teardown is unproven/);
    const after = await load(root); assert.equal(after.state.outbox[command.commandId].state, 'CLAIMED'); assert.equal(calls, 1);
    rejectPending(new Error('test cleanup'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

test('MemoryArtifactStore preserves the terminal retirement state without epoch or reservation churn', async () => {
  const fx = await unknownFixture({ generation: ONE_SHOT_ROLLOUT_GENERATION_FLOOR });
  try {
    const memory = new MemoryArtifactStore();
    await memory.commit(0, fx.unknown.state);
    const loaded = await memory.load();
    const identity = input(fx.runId, 'memory-retire', { kind: 'RESUME' }, loaded.state).identity;
    const reduced = retireManagedAttempt(loaded.state, identity, fx.command.launchToken, fx.fixture.plan, 2, 'FAILED');
    assert.equal(reduced.outcome, 'BLOCKED');
    assert.equal(reduced.state.attemptEpoch, loaded.state.attemptEpoch);
    assert.deepEqual(reduced.state.managed.reservations, loaded.state.managed.reservations);
    await memory.commit(loaded.generation, reduced.state);
    const restarted = await memory.load();
    assert.equal(restarted.state.managed.attempts[fx.command.commandId].status, 'FAILED');
    assert.equal(restarted.state.outbox[fx.command.commandId].state, 'UNKNOWN');
    assert.equal(restarted.state.status, 'BLOCKED');
  } finally { await rm(fx.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});

async function reachDecision(runId, root, generation) {
  const fixture = authorExactManagedFixture({ runId, phaseId, policy });
  const launched = new Map();
  const driver = { dispatch(command, launchToken) { launched.set(command.commandId, structuredClone(command)); return { launchToken, commandDigest: command.commandDigest, ref: fixture.byStep.get(command.stepId) }; } };
  const options = { plan: fixture.plan, rootDir: root, capability: capabilityFor('FOCUS'), waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: 2, rolloutGeneration: generation, driver };
  const kernel = makeExactManagedKernel(options);
  let yielded = await kernel.advance(input(runId, 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) }));
  const completed = new Set();
  for (let index = 0; index < 100 && yielded.kind !== 'DECISION_REQUIRED'; index += 1) {
    const command = [...launched.values()].find((candidate) => !completed.has(candidate.commandId));
    if (command) {
      completed.add(command.commandId);
      yielded = await kernel.advance(input(runId, `report-${index}`, { kind: 'WORKER_ENVELOPE', ref: fixture.byStep.get(command.stepId) }, yielded.snapshot, command.launchToken));
    } else yielded = await kernel.advance(input(runId, `resume-${index}`, { kind: 'RESUME' }, yielded.snapshot));
  }
  assert.equal(yielded.kind, 'DECISION_REQUIRED');
  return { fixture, kernel, yielded };
}

function completeDecision(runId, fixture, state, tokenName) {
  const token = state.decisionTokens[tokenName]; const result = { kind: 'COMPLETE_PLAN', plan: validatePlan(fixture.plan).plan };
  const selection = { generatorReport: token.orderedReportRefs[0], oneBasedOrdinal: 1 };
  const settlement = {
    schema: 'lunacy-deliberation-settlement/v1', authorshipInputDigest: token.authorshipInputDigest, decisionKey: token.decisionKey,
    frontierOrdinal: fixture.wave.authorship.prospectiveEffectFrontierOrdinal, waveRef: fixture.waveRef,
    orderedReportRefs: token.orderedReportRefs, basis: selection, dissent: { kind: 'NONE' }, predecessors: [], selection,
    disposition: 'SELECTION', result, resultDigest: digest(result),
  };
  return { disposition: 'SELECTION', settlementRef: ref(`settlement:${runId}`, settlement, 'deliberation/settlement'), result };
}

test('one-shot successor spellings refuse before lease and leave the token for COMPLETE_PLAN', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p2-one-shot-successor-'));
  try {
    const runId = 'p2-successor-refusal'; const reached = await reachDecision(runId, root, ONE_SHOT_ROLLOUT_GENERATION_FLOOR);
    const before = await load(root); const token = reached.yielded.token; const fakeWave = reached.fixture.waveRef;
    const spellings = [
      { disposition: 'WIDEN', nullableSettlement: null, successorWaveRef: fakeWave, result: { kind: 'DELIBERATION_REQUIRED', wave: fakeWave } },
      { disposition: 'SELECTION', nextWaveRef: fakeWave, result: { kind: 'COMPLETE_PLAN', plan: reached.fixture.plan } },
      { disposition: 'SYNTHESIS', successorWaveRef: fakeWave, result: { kind: 'COMPLETE_PLAN', plan: reached.fixture.plan } },
      { disposition: 'SELECTION', result: { kind: 'DELIBERATION_REQUIRED', wave: fakeWave } },
    ];
    for (let index = 0; index < spellings.length; index += 1) {
      await assert.rejects(() => reached.kernel.advance(input(runId, `successor-${index}`, { kind: 'PARENT_DECISION', token, value: spellings[index] }, reached.yielded.snapshot)), /one-shot|canonical|binding/i);
      const unchanged = await load(root);
      assert.equal(unchanged.generation, before.generation);
      assert.equal(unchanged.state.decisionTokens[token].consumed, false);
      assert.equal(Object.keys(unchanged.state.managed.leaseSets).length, Object.keys(before.state.managed.leaseSets).length);
    }
    const valid = completeDecision(runId, reached.fixture, before.state, token);
    const accepted = await reached.kernel.advance(input(runId, 'complete-plan', { kind: 'PARENT_DECISION', token, value: valid }, reached.yielded.snapshot));
    assert.equal(accepted.kind, 'WAITING');
    assert.equal((await load(root)).state.decisionTokens[token].consumed, true);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});
