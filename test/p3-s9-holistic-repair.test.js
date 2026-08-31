import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeKernel } from '../dist/composition.js';
import { createManagedCapability } from '../dist/managed-capability.js';
import { authorPlan, compileWavePlan, deriveTopology } from '../dist/deliberation.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';
import { validatePlan } from '../dist/validator.js';

const phaseId = 'p3-s9';
const ref = (id, value, scope) => ({ id, ...(scope === undefined ? {} : { scope }), digest: digest(value), bytes: canonicalString(value) });
const policy = {
  version: ref('policy', { generation: 1 }, 'policy'),
  frameCatalog: [0, 1, 2, 3].map((i) => ({ frameId: `f${i}`, tag: 'code', text: `frame-${i}` })).concat([{ frameId: 'wild', tag: 'wild', text: 'wild' }]),
  maxMaterialDecisions: 4, maxSettlementBytes: 10_000_000, maxResolvedRoleInputBytes: 10_000_000,
  convergeCount: 3, nonObviousNovelty: 5, viableFloor: 5,
};

const capability = (calls, bytes = 1_000_000) => createManagedCapability({ ceilings: { waves: 1, calls, refs: calls, reportBytes: bytes, persistedBytes: bytes } });

function authored(gear, runId) {
  const intent = ref(`intent:${runId}`, { phaseId, steps: [{ stepId: 'placeholder' }] }, 'intent');
  const result = authorPlan({ runId, phaseId, intent, evidenceSnapshot: ref(`snapshot:${runId}`, { generation: 1 }, 'snapshot'), authorityDigest: digest('authority'), policyVersion: policy.version, settlements: [] }, {
    decisionUnsettled: true, explicitExplore: gear === 'EXPLORE', citedWitness: false, planEquivalent: false,
    containedDiscovery: false, openEnded: false, highStakes: false, openlyPhrased: false, namedDiscriminator: gear === 'FOCUS',
  }, policy);
  assert.equal(result.kind, 'DELIBERATION_REQUIRED');
  const waveRef = result.wave;
  const wave = JSON.parse(waveRef.bytes);
  const topology = deriveTopology(waveRef, wave);
  const generators = Array.from({ length: gear === 'EXPLORE' ? 5 : 2 }, (_, slotOrdinal) => ({
    schema: 'lunacy-deliberation-report/v2', wave: waveRef, slotOrdinal,
    ideas: Array.from({ length: gear === 'EXPLORE' ? 6 : 1 }, (_, index) => ({ text: `idea-${slotOrdinal}-${index}`, rationale: 'because' })),
  }));
  const reportRef = (report) => ref(`report:${digest(report).slice(0, 16)}`, report, 'deliberation/report');
  const locator = (generator, oneBasedOrdinal) => ({ generatorReport: reportRef(generator), oneBasedOrdinal });
  const allLocators = generators.flatMap((generator) => generator.ideas.map((_, index) => locator(generator, index + 1)));
  const criticOrdinal = gear === 'EXPLORE' ? 5 : 2;
  const critic = {
    schema: 'lunacy-deliberation-report/v2', wave: waveRef, slotOrdinal: criticOrdinal,
    scores: allLocators.map((idea) => ({ idea, novelty: 8, viability: 8, fit: 8, evidence: [] })),
    clusters: [0, 1, 2].map((cluster) => ({ label: String.fromCharCode(97 + cluster), ideas: allLocators.filter((_, index) => index % 3 === cluster) })),
  };
  const deepeners = gear === 'EXPLORE' ? [6, 7, 8].map((slotOrdinal) => ({ schema: 'lunacy-deliberation-report/v2', wave: waveRef, slotOrdinal, sketch: 'One. Two. Three. Four.', loadBearingRisk: 'risk', firstConcreteStep: 'step', childIdeas: ['a', 'b', 'c'] })) : [];
  const reports = [...generators, critic, ...deepeners];
  const plan = validatePlan(compileWavePlan(waveRef, wave).value).plan;
  const byStep = new Map(topology.slots.map((slot, index) => [slot.stepId, reportRef(reports[index])]));
  const reportRefs = reports.map((report) => reportRef(report));
  return { waveRef, wave, topology, reports, reportRefs, plan, byStep, intent };
}

function input(runId, eventId, event, snapshot, launchToken) {
  return { runId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}), identity: {
    runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0,
    authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0,
    eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}),
  }, event };
}

function start(runId, fixture) { return input(runId, 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) }); }

async function reachDecision({ runId, fixture, rootDir, memory = false, calls = fixture.reports.length, bytes = 1_000_000 }) {
  const launched = new Map();
  const driver = { dispatch(command, launchToken) {
    launched.set(command.commandId, command);
    const report = fixture.byStep.get(command.stepId);
    return { launchToken, commandDigest: command.commandDigest, ref: report };
  } };
  const kernel = composeKernel({ plan: fixture.plan, ...(memory ? {} : { rootDir }), managedCapability: capability(calls, bytes), maxInFlight: calls, driver });
  let yielded = await kernel.advance(start(runId, fixture));
  const completed = new Set();
  for (let index = 0; index < 200 && yielded.kind !== 'DECISION_REQUIRED' && yielded.kind !== 'BLOCKED'; index += 1) {
    const command = [...launched.values()].find((candidate) => !completed.has(candidate.commandId));
    if (command) {
      completed.add(command.commandId);
      yielded = await kernel.advance(input(runId, `worker-${index}`, { kind: 'WORKER_ENVELOPE', ref: fixture.byStep.get(command.stepId) }, yielded.snapshot, command.launchToken));
    } else yielded = await kernel.advance(input(runId, `resume-${index}`, { kind: 'RESUME' }, yielded.snapshot));
  }
  return { kernel, yielded, launched };
}

function settlementFor(runId, fixture, result, disposition = 'SELECTION', synthesis = undefined) {
  const authorshipInputDigest = digest({ runId, phaseId, authorshipInputDigest: ref('plan', fixture.plan).digest, decisionKey: 'START' });
  const selection = { generatorReport: fixture.reportRefs[0], oneBasedOrdinal: 1 };
  const value = {
    schema: 'lunacy-deliberation-settlement/v1', authorshipInputDigest, decisionKey: 'START', frontierOrdinal: fixture.wave.authorship.prospectiveEffectFrontierOrdinal,
    waveRef: fixture.waveRef, orderedReportRefs: fixture.reportRefs,
    basis: disposition === 'SELECTION' ? selection : [selection], dissent: { kind: 'NONE' }, predecessors: [],
    ...(disposition === 'SELECTION' ? { selection } : { synthesis: synthesis ?? 'The complete bounded synthesis.' }),
    disposition, result, resultDigest: digest(result),
  };
  return ref(`settlement:${digest(value).slice(0, 16)}`, value, 'deliberation/settlement');
}

function successorExplore(runId, focus) {
  const prefixValue = { schema: 'lunacy-managed-accepted-report-prefix/v1', waveRef: focus.waveRef, orderedReportRefs: focus.reportRefs };
  const prefixDigest = digest(prefixValue);
  const evidenceSnapshot = { id: `accepted-report-prefix:${prefixDigest.slice(0, 16)}`, scope: 'deliberation/report-prefix', digest: prefixDigest, bytes: canonicalString(prefixValue) };
  const result = authorPlan({ runId, phaseId, intent: focus.waveRef, evidenceSnapshot, authorityDigest: focus.wave.authorship.authorityDigest, policyVersion: focus.wave.authorship.policyVersion, settlements: [] }, {
    decisionUnsettled: true, explicitExplore: true, citedWitness: false, planEquivalent: false, containedDiscovery: false,
    openEnded: true, highStakes: false, openlyPhrased: false, namedDiscriminator: false,
  }, policy);
  assert.equal(result.kind, 'DELIBERATION_REQUIRED');
  // The successor remains on the consumed material decision key.  The
  // authorship helper derives a fresh key from the Wave intent by default,
  // so bind that private field to the token's exact decision key before
  // recomputing the content-addressed Wave Ref.
  const wave = JSON.parse(result.wave.bytes);
  wave.authorship.decisionKey = 'START';
  return ref(`wave:${digest(wave).slice(0, 16)}`, wave, 'deliberation/wave');
}

test('full canonical selection result and settlement bind atomically on File and Memory, including replay', async () => {
  for (const memory of [false, true]) {
    const fixture = authored('FOCUS', `s9-select-${memory ? 'memory' : 'file'}`);
    const rootDir = memory ? undefined : await mkdtemp(join(tmpdir(), 'p3-s9-selection-'));
    try {
      const runId = `s9-select-${memory ? 'memory' : 'file'}`;
      const reached = await reachDecision({ runId, fixture, rootDir, memory });
      assert.equal(reached.yielded.kind, 'DECISION_REQUIRED');
      const result = { kind: 'COMPLETE_PLAN', plan: fixture.plan };
      const settlement = settlementFor(runId, fixture, result);
      const decision = { kind: 'PARENT_DECISION', token: reached.yielded.token, value: { disposition: 'SELECTION', settlementRef: settlement, result } };
      const decisionInput = input(runId, 'select', decision, reached.yielded.snapshot);
      const selected = await reached.kernel.advance(decisionInput);
      assert.equal(selected.kind, 'WAITING');
      const replay = await reached.kernel.advance(decisionInput);
      assert.deepEqual(replay, selected);
      if (!memory) {
        const state = (await new FileArtifactStore(rootDir).load()).state;
        const token = state.decisionTokens[reached.yielded.token];
        assert.equal(token.consumed, true);
        assert.equal(token.resultKind, 'COMPLETE_PLAN');
        assert.equal(state.managed.settlements[settlement.digest].digest, settlement.digest);
      }
    } finally { if (rootDir) await rm(rootDir, { recursive: true, force: true }); }
  }
});

test('full canonical synthesis result and settlement bind atomically', async () => {
  for (const memory of [false, true]) {
    const fixture = authored('FOCUS', `s9-synthesis-${memory ? 'memory' : 'file'}`);
    const rootDir = memory ? undefined : await mkdtemp(join(tmpdir(), 'p3-s9-synthesis-'));
    try {
      const runId = `s9-synthesis-${memory ? 'memory' : 'file'}`;
      const reached = await reachDecision({ runId, fixture, rootDir, memory });
      assert.equal(reached.yielded.kind, 'DECISION_REQUIRED');
      const result = { kind: 'COMPLETE_PLAN', plan: fixture.plan };
      const settlement = settlementFor(runId, fixture, result, 'SYNTHESIS', 'The complete bounded synthesis.');
      const decision = input(runId, 'synthesis', { kind: 'PARENT_DECISION', token: reached.yielded.token, value: { disposition: 'SYNTHESIS', settlementRef: settlement, result } }, reached.yielded.snapshot);
      const synthesized = await reached.kernel.advance(decision);
      assert.equal(synthesized.kind, 'WAITING');
      const replay = await reached.kernel.advance(decision);
      assert.deepEqual(replay, synthesized);
    } finally { if (rootDir) await rm(rootDir, { recursive: true, force: true }); }
  }
});

test('arbitrary settlement and incomplete result are rejected without consuming File or Memory token', async () => {
  for (const memory of [false, true]) {
    const fixture = authored('FOCUS', `s9-negative-${memory ? 'memory' : 'file'}`);
    const rootDir = memory ? undefined : await mkdtemp(join(tmpdir(), 'p3-s9-negative-'));
    try {
      const runId = `s9-negative-${memory ? 'memory' : 'file'}`;
      const reached = await reachDecision({ runId, fixture, rootDir, memory });
      assert.equal(reached.yielded.kind, 'DECISION_REQUIRED');
      const result = { kind: 'COMPLETE_PLAN', plan: fixture.plan };
      const arbitrary = ref('arbitrary', { arbitrary: true }, 'deliberation/settlement');
      const bad = input(runId, 'bad', { kind: 'PARENT_DECISION', token: reached.yielded.token, value: { disposition: 'SELECTION', settlementRef: arbitrary, result } }, reached.yielded.snapshot);
      await assert.rejects(() => reached.kernel.advance(bad));
      if (!memory) {
        const state = (await new FileArtifactStore(rootDir).load()).state;
        assert.equal(state.decisionTokens[reached.yielded.token].consumed, false);
        assert.equal(state.managed.settlements && Object.keys(state.managed.settlements).length, 0);
      }
    } finally { if (rootDir) await rm(rootDir, { recursive: true, force: true }); }
  }
});

test('WIDEN requires and publishes an exact Explore successor Wave', async () => {
  for (const memory of [false, true]) {
    const fixture = authored('FOCUS', `s9-widen-${memory ? 'memory' : 'file'}`);
    const rootDir = memory ? undefined : await mkdtemp(join(tmpdir(), 'p3-s9-widen-'));
    try {
      const runId = `s9-widen-${memory ? 'memory' : 'file'}`;
      const reached = await reachDecision({ runId, fixture, rootDir, memory });
      assert.equal(reached.yielded.kind, 'DECISION_REQUIRED');
      const missing = input(runId, 'missing', { kind: 'PARENT_DECISION', token: reached.yielded.token, value: { disposition: 'WIDEN', nullableSettlement: null, result: { kind: 'DELIBERATION_REQUIRED', wave: fixture.waveRef } } }, reached.yielded.snapshot);
      await assert.rejects(() => reached.kernel.advance(missing));
      const successor = successorExplore(runId, fixture);
      const result = { kind: 'DELIBERATION_REQUIRED', wave: successor };
      const decision = input(runId, 'widen', { kind: 'PARENT_DECISION', token: reached.yielded.token, value: { disposition: 'WIDEN', nullableSettlement: null, successorWaveRef: successor, result } }, reached.yielded.snapshot);
      const widened = await reached.kernel.advance(decision);
      assert.equal(widened.kind, 'WAITING');
      if (!memory) {
        const state = (await new FileArtifactStore(rootDir).load()).state;
        assert.equal(state.decisionTokens[reached.yielded.token].successorWaveRef.digest, successor.digest);
        assert.equal(state.managed.proposal.waveRef.digest, successor.digest);
      }
    } finally { if (rootDir) await rm(rootDir, { recursive: true, force: true }); }
  }
});

test('non-divisible Focus(3) and Explore(9) reservations consume exact ceilings', async () => {
  for (const [gear, calls, bytes] of [['FOCUS', 3, 1_000_001], ['EXPLORE', 9, 1_000_004]]) {
    const fixture = authored(gear, `s9-quota-${gear.toLowerCase()}`);
    const rootDir = await mkdtemp(join(tmpdir(), `p3-s9-quota-${gear.toLowerCase()}-`));
    try {
      const run = await reachDecision({ runId: `s9-quota-${gear.toLowerCase()}`, fixture, rootDir, calls, bytes });
      assert.equal(run.yielded.kind, 'DECISION_REQUIRED');
      const state = (await new FileArtifactStore(rootDir).load()).state;
      assert.equal(state.managed.waveCounters.calls, calls);
      assert.equal(state.managed.waveCounters.reportBytes, bytes);
      assert.equal(state.managed.waveCounters.persistedBytes, bytes);
      assert.equal(Object.values(state.steps).every((step) => step.status === 'DONE'), true);
    } finally { await rm(rootDir, { recursive: true, force: true }); }
  }
});

test('File CAS loss leaves the token unconsumed and exact decision replay remains authoritative', async () => {
  const fixture = authored('FOCUS', 's9-cas');
  const rootDir = await mkdtemp(join(tmpdir(), 'p3-s9-cas-'));
  const originalCommit = FileArtifactStore.prototype.commit;
  let injected = false;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    if (!injected && state.journal.at(-1)?.event.kind === 'PARENT_DECISION') {
      injected = true;
      const winner = await this.load();
      if (winner.state) await originalCommit.call(this, winner.generation, winner.state);
    }
    return originalCommit.call(this, generation, state);
  };
  try {
    const runId = 's9-cas';
    const reached = await reachDecision({ runId, fixture, rootDir });
    assert.equal(reached.yielded.kind, 'DECISION_REQUIRED');
    const result = { kind: 'COMPLETE_PLAN', plan: fixture.plan };
    const settlement = settlementFor(runId, fixture, result);
    const decision = input(runId, 'select', { kind: 'PARENT_DECISION', token: reached.yielded.token, value: { disposition: 'SELECTION', settlementRef: settlement, result } }, reached.yielded.snapshot);
    await assert.rejects(() => reached.kernel.advance(decision));
    const afterLoss = (await new FileArtifactStore(rootDir).load()).state;
    assert.equal(afterLoss.decisionTokens[reached.yielded.token].consumed, false);
    FileArtifactStore.prototype.commit = originalCommit;
    const winner = await reached.kernel.advance(decision);
    assert.equal(winner.kind, 'WAITING');
    const replay = await reached.kernel.advance(decision);
    assert.deepEqual(replay, winner);
  } finally {
    FileArtifactStore.prototype.commit = originalCommit;
    await rm(rootDir, { recursive: true, force: true });
  }
});
