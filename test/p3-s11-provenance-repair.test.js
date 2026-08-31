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

const phaseId = 'p3-s11';
const ref = (id, value, scope) => ({ id, ...(scope === undefined ? {} : { scope }), digest: digest(value), bytes: canonicalString(value) });
const policy = {
  version: ref('policy', { generation: 1 }, 'policy'),
  frameCatalog: [0, 1, 2, 3].map((i) => ({ frameId: `f${i}`, tag: 'code', text: `frame-${i}` })).concat([{ frameId: 'wild', tag: 'wild', text: 'wild' }]),
  maxMaterialDecisions: 4, maxSettlementBytes: 10_000_000, maxResolvedRoleInputBytes: 10_000_000,
  convergeCount: 3, nonObviousNovelty: 5, viableFloor: 5,
};
const capability = createManagedCapability({ ceilings: { waves: 1, calls: 3, refs: 3, reportBytes: 1_000_000, persistedBytes: 1_000_000 } });

function authored(runId) {
  const intent = ref(`intent:${runId}`, { phaseId, steps: [{ stepId: 'placeholder' }] }, 'intent');
  const authored = authorPlan({ runId, phaseId, intent, evidenceSnapshot: ref(`snapshot:${runId}`, { generation: 1 }, 'snapshot'), authorityDigest: digest('authority'), policyVersion: policy.version, settlements: [] }, {
    decisionUnsettled: true, explicitExplore: false, citedWitness: false, planEquivalent: false,
    containedDiscovery: false, openEnded: false, highStakes: false, openlyPhrased: false, namedDiscriminator: true,
  }, policy);
  assert.equal(authored.kind, 'DELIBERATION_REQUIRED');
  const waveRef = authored.wave; const wave = JSON.parse(waveRef.bytes); const topology = deriveTopology(waveRef, wave);
  const generators = [0, 1].map((slotOrdinal) => ({ schema: 'lunacy-deliberation-report/v2', wave: waveRef, slotOrdinal, ideas: [{ text: `idea-${slotOrdinal}`, rationale: 'because' }] }));
  const reportRef = (report) => ref(`report:${digest(report).slice(0, 16)}`, report, 'deliberation/report');
  const locators = generators.map((generator) => ({ generatorReport: reportRef(generator), oneBasedOrdinal: 1 }));
  const critic = { schema: 'lunacy-deliberation-report/v2', wave: waveRef, slotOrdinal: 2, scores: locators.map((idea) => ({ idea, novelty: 8, viability: 8, fit: 8, evidence: [] })), clusters: [{ label: 'a', ideas: [locators[0]] }, { label: 'b', ideas: [locators[1]] }, { label: 'c', ideas: [] }] };
  const reports = [...generators, critic]; const reportRefs = reports.map(reportRef);
  const plan = validatePlan(compileWavePlan(waveRef, wave).value).plan;
  return { waveRef, wave, reportRefs, plan, byStep: new Map(topology.slots.map((slot, index) => [slot.stepId, reportRefs[index]])) };
}

function input(runId, eventId, event, snapshot, launchToken) {
  return { runId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}), identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0, authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) }, event };
}

async function reachDecision(runId, fixture, rootDir, memory) {
  const launched = new Map();
  const driver = { dispatch(command, launchToken) { launched.set(command.commandId, command); return { launchToken, commandDigest: command.commandDigest, ref: fixture.byStep.get(command.stepId) }; } };
  const kernel = composeKernel({ plan: fixture.plan, ...(memory ? {} : { rootDir }), managedCapability: capability, maxInFlight: 3, driver });
  let yielded = await kernel.advance(input(runId, 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) }));
  const completed = new Set();
  for (let index = 0; index < 100 && yielded.kind !== 'DECISION_REQUIRED'; index += 1) {
    const command = [...launched.values()].find((candidate) => !completed.has(candidate.commandId));
    if (command) {
      completed.add(command.commandId);
      yielded = await kernel.advance(input(runId, `worker-${index}`, { kind: 'WORKER_ENVELOPE', ref: fixture.byStep.get(command.stepId) }, yielded.snapshot, command.launchToken));
    } else yielded = await kernel.advance(input(runId, `resume-${index}`, { kind: 'RESUME' }, yielded.snapshot));
  }
  assert.equal(yielded.kind, 'DECISION_REQUIRED');
  return { kernel, yielded };
}

function settlement(runId, fixture, result, mutate = () => undefined) {
  const selection = { generatorReport: fixture.reportRefs[0], oneBasedOrdinal: 1 };
  const value = { schema: 'lunacy-deliberation-settlement/v1', authorshipInputDigest: digest({ runId, phaseId, authorshipInputDigest: ref('plan', fixture.plan).digest, decisionKey: 'START' }), decisionKey: 'START', frontierOrdinal: fixture.wave.authorship.prospectiveEffectFrontierOrdinal, waveRef: fixture.waveRef, orderedReportRefs: fixture.reportRefs, basis: selection, dissent: { kind: 'NONE' }, predecessors: [], selection, disposition: 'SELECTION', result, resultDigest: digest(result) };
  mutate(value);
  return ref(`settlement:${digest(value).slice(0, 16)}`, value, 'deliberation/settlement');
}

function connectedExplore(runId, fixture) {
  const prefix = { schema: 'lunacy-managed-accepted-report-prefix/v1', waveRef: fixture.waveRef, orderedReportRefs: fixture.reportRefs };
  const evidenceSnapshot = ref(`accepted-report-prefix:${digest(prefix).slice(0, 16)}`, prefix, 'deliberation/report-prefix');
  const authored = authorPlan({ runId, phaseId, intent: fixture.waveRef, evidenceSnapshot, authorityDigest: fixture.wave.authorship.authorityDigest, policyVersion: fixture.wave.authorship.policyVersion, settlements: [] }, {
    decisionUnsettled: true, explicitExplore: true, citedWitness: false, planEquivalent: false, containedDiscovery: false, openEnded: true, highStakes: false, openlyPhrased: false, namedDiscriminator: false,
  }, policy);
  assert.equal(authored.kind, 'DELIBERATION_REQUIRED');
  const wave = JSON.parse(authored.wave.bytes); wave.authorship.decisionKey = 'START';
  return ref(`wave:${digest(wave).slice(0, 16)}`, wave, 'deliberation/wave');
}

test('settlement predecessors and dissent are closed owner provenance on File and Memory', async () => {
  for (const memory of [false, true]) {
    for (const [label, mutate] of [['foreign-predecessor', (value) => { value.predecessors = [ref('foreign', { unrelated: true }, 'deliberation/settlement')]; }], ['opaque-dissent', (value) => { value.dissent = { attackerControlled: true }; }]]) {
      const runId = `s11-${label}-${memory ? 'memory' : 'file'}`; const fixture = authored(runId); const root = memory ? undefined : await mkdtemp(join(tmpdir(), `p3-s11-${label}-`));
      try {
        const reached = await reachDecision(runId, fixture, root, memory); const result = { kind: 'COMPLETE_PLAN', plan: fixture.plan }; const bad = settlement(runId, fixture, result, mutate);
        await assert.rejects(() => reached.kernel.advance(input(runId, label, { kind: 'PARENT_DECISION', token: reached.yielded.token, value: { disposition: 'SELECTION', settlementRef: bad, result } }, reached.yielded.snapshot)));
        if (!memory) assert.equal((await new FileArtifactStore(root).load()).state.decisionTokens[reached.yielded.token].consumed, false);
      } finally { if (root) await rm(root, { recursive: true, force: true }); }
    }
  }
});

test('WIDEN requires every exact connected successor provenance field and accepts a connected Explore Wave', async () => {
  const fields = ['intent', 'evidenceSnapshot', 'authorityDigest', 'settlementPrefixDigest', 'decisionKey'];
  for (const field of fields) {
    const runId = `s11-widen-${field}`; const fixture = authored(runId); const root = await mkdtemp(join(tmpdir(), `p3-s11-widen-${field}-`));
    try {
      const reached = await reachDecision(runId, fixture, root, false); const successor = connectedExplore(runId, fixture); const wave = JSON.parse(successor.bytes);
      if (field === 'intent') wave.authorship.intent = ref('unrelated-intent', { unrelated: true }, 'intent');
      if (field === 'evidenceSnapshot') wave.authorship.evidenceSnapshot = ref('unrelated-snapshot', { unrelated: true }, 'snapshot');
      if (field === 'authorityDigest') wave.authorship.authorityDigest = digest('unrelated-authority');
      if (field === 'settlementPrefixDigest') wave.authorship.settlementPrefixDigest = digest('unrelated-prefix');
      if (field === 'decisionKey') wave.authorship.decisionKey = 'UNRELATED';
      const badSuccessor = ref(`wave:${digest(wave).slice(0, 16)}`, wave, 'deliberation/wave'); const result = { kind: 'DELIBERATION_REQUIRED', wave: badSuccessor };
      await assert.rejects(() => reached.kernel.advance(input(runId, field, { kind: 'PARENT_DECISION', token: reached.yielded.token, value: { disposition: 'WIDEN', nullableSettlement: null, successorWaveRef: badSuccessor, result } }, reached.yielded.snapshot)));
      assert.equal((await new FileArtifactStore(root).load()).state.decisionTokens[reached.yielded.token].consumed, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  for (const memory of [false, true]) {
    const runId = `s11-connected-${memory ? 'memory' : 'file'}`; const fixture = authored(runId); const root = memory ? undefined : await mkdtemp(join(tmpdir(), `p3-s11-connected-${memory ? 'memory' : 'file'}-`));
    try {
      const reached = await reachDecision(runId, fixture, root, memory); const successor = connectedExplore(runId, fixture); const result = { kind: 'DELIBERATION_REQUIRED', wave: successor };
      const widened = await reached.kernel.advance(input(runId, 'connected', { kind: 'PARENT_DECISION', token: reached.yielded.token, value: { disposition: 'WIDEN', nullableSettlement: null, successorWaveRef: successor, result } }, reached.yielded.snapshot));
      assert.equal(widened.kind, 'WAITING');
    } finally { if (root) await rm(root, { recursive: true, force: true }); }
  }
});
