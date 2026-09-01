import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeExactManagedKernel } from './exact-managed-harness.js';
import { createManagedCapability } from '../dist/managed-capability.js';
import { authorPlan, compileWavePlan, deriveTopology, reconcileWave } from '../dist/deliberation.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';

const ref = (id, value, scope) => ({ id, ...(scope === undefined ? {} : { scope }), digest: digest(value), bytes: canonicalString(value) });
const policy = {
  version: ref('policy', { generation: 1 }, 'policy'),
  frameCatalog: [0, 1, 2, 3].map((i) => ({ frameId: `f${i}`, tag: 'code', text: `frame-${i}` })).concat([{ frameId: 'wild', tag: 'wild', text: 'wild' }]),
  maxMaterialDecisions: 4, maxSettlementBytes: 10_000_000, maxResolvedRoleInputBytes: 10_000_000,
  convergeCount: 3, nonObviousNovelty: 5, viableFloor: 5,
};
const capability = (calls) => createManagedCapability({ ceilings: { waves: 1, calls, refs: calls, persistedBytes: calls } });

function authored(gear, runId) {
  const intent = ref(`intent:${runId}`, { phaseId: 'p3-s7', steps: [{ stepId: 'placeholder' }] }, 'intent');
  const result = authorPlan({ runId, phaseId: 'p3-s7', intent, evidenceSnapshot: ref(`snapshot:${runId}`, { generation: 1 }, 'snapshot'), authorityDigest: digest('authority'), policyVersion: policy.version, settlements: [] }, {
    decisionUnsettled: true, explicitExplore: gear === 'EXPLORE', citedWitness: false, planEquivalent: false,
    containedDiscovery: false, openEnded: false, highStakes: false, openlyPhrased: false, namedDiscriminator: gear === 'FOCUS',
  }, policy);
  assert.equal(result.kind, 'DELIBERATION_REQUIRED');
  const wave = JSON.parse(result.wave.bytes);
  const waveRef = result.wave;
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
  const deepeners = gear === 'EXPLORE' ? [6, 7, 8].map((slotOrdinal) => ({
    schema: 'lunacy-deliberation-report/v2', wave: waveRef, slotOrdinal,
    sketch: 'One. Two. Three. Four.', loadBearingRisk: 'risk', firstConcreteStep: 'step', childIdeas: ['a', 'b', 'c'],
  })) : [];
  const reports = [...generators, critic, ...deepeners];
  const plan = compileWavePlan(waveRef, wave).value;
  const byStep = new Map(topology.slots.map((slot, index) => [slot.stepId, reportRef(reports[index])]));
  return { waveRef, wave, topology, reports, plan, byStep };
}

function input(runId, eventId, event, snapshot, launchToken) {
  return { runId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}), identity: {
    runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0,
    authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0,
    eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}),
  }, event };
}

async function completeWave(runId, fixture, root, mutate = () => undefined) {
  let currentReportByStep = fixture.byStep;
  const driver = { dispatch(command, launchToken) {
    const report = currentReportByStep.get(command.stepId);
    const altered = mutate(command, report);
    return { launchToken, commandDigest: command.commandDigest, ref: altered?.receipt ?? report };
  } };
  const kernel = makeExactManagedKernel({ plan: fixture.plan, rootDir: root, capability: capability(fixture.reports.length), waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: fixture.reports.length, driver });
  let yielded = await kernel.advance(input(runId, 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) }));
  for (let index = 0; index < 100 && yielded.kind !== 'DECISION_REQUIRED'; index += 1) {
    const state = (await new FileArtifactStore(root).load()).state;
    const command = Object.values(state.outbox).find((candidate) => candidate.state === 'ACKED' && state.steps[candidate.stepId]?.status === 'ACTIVE');
    if (command) {
      const report = currentReportByStep.get(command.stepId);
      const altered = mutate(command, report);
      const event = { kind: 'WORKER_ENVELOPE', ref: altered?.worker ?? report };
      yielded = await kernel.advance(input(runId, `worker-${index}`, event, yielded.snapshot, command.launchToken));
      if (yielded.kind === 'BLOCKED') break;
    } else {
      yielded = await kernel.advance(input(runId, `resume-${index}`, { kind: 'RESUME' }, yielded.snapshot));
    }
  }
  return { kernel, yielded };
}

test('raw status, wrong slot/Wave, and forged receipt cannot form a managed Report/v2 prefix', async () => {
  const fixture = authored('FOCUS', 's7-negative');
  for (const [label, mutate] of [
    ['raw-status', (_command, report) => ({ receipt: report, worker: ref('raw', { status: 'DONE' }, 'worker') })],
    ['forged-receipt', (_command, report) => ({ receipt: ref('forged', { accepted: true }, 'deliberation/report'), worker: report })],
  ]) {
    const root = await mkdtemp(join(tmpdir(), `p3-s7-${label}-`));
    try {
      const run = await completeWave(`s7-${label}`, fixture, root, mutate);
      assert.equal(run.yielded.kind, 'BLOCKED', label);
      const state = (await new FileArtifactStore(root).load()).state;
      assert.equal(Object.values(state.decisionTokens).some((token) => token.kind === 'DELIBERATION_SELECTION'), false, label);
      assert.equal(state.managed.acceptedReports && Object.keys(state.managed.acceptedReports).length, 0, label);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  const wrong = authored('FOCUS', 's7-wrong');
  const foreign = authored('FOCUS', 's7-foreign');
  const root = await mkdtemp(join(tmpdir(), 'p3-s7-wrong-slot-'));
  try {
    const run = await completeWave('s7-wrong', wrong, root, (command, report) => command.stepId === wrong.topology.slots[0].stepId ? ({ receipt: foreign.byStep.get(foreign.topology.slots[1].stepId), worker: foreign.byStep.get(foreign.topology.slots[1].stepId) }) : ({ receipt: report, worker: report }));
    assert.equal(run.yielded.kind, 'BLOCKED');
    const state = (await new FileArtifactStore(root).load()).state;
    assert.equal(Object.values(state.decisionTokens).some((token) => token.kind === 'DELIBERATION_SELECTION'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('partial and stale epoch completions remain non-authoritative', async () => {
  const fixture = authored('FOCUS', 's7-partial');
  const root = await mkdtemp(join(tmpdir(), 'p3-s7-partial-'));
  try {
    const driver = { dispatch(command, launchToken) { return { launchToken, commandDigest: command.commandDigest, ref: fixture.byStep.get(command.stepId) }; } };
    const kernel = makeExactManagedKernel({ plan: fixture.plan, rootDir: root, capability: capability(3), waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: 2, driver });
    let yielded = await kernel.advance(input('s7-partial', 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) }));
    yielded = await kernel.advance(input('s7-partial', 'resume', { kind: 'RESUME' }, yielded.snapshot));
    const state = (await new FileArtifactStore(root).load()).state;
    const command = Object.values(state.outbox).find((candidate) => candidate.state === 'ACKED' && state.steps[candidate.stepId]?.status === 'ACTIVE');
    yielded = await kernel.advance(input('s7-partial', 'worker', { kind: 'WORKER_ENVELOPE', ref: fixture.byStep.get(command.stepId) }, yielded.snapshot, command.launchToken));
    assert.equal(yielded.kind, 'WAITING', yielded.reason);
    assert.equal(Object.values((await new FileArtifactStore(root).load()).state.decisionTokens).some((token) => token.kind === 'DELIBERATION_SELECTION'), false);
    await assert.rejects(() => kernel.advance(input('s7-partial', 'stale', { kind: 'RESUME' }, { ...yielded.snapshot, attemptEpoch: yielded.snapshot.attemptEpoch + 1 })), /Superseded/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('wrong mode epoch cannot admit an otherwise valid Report/v2 receipt', async () => {
  const fixture = authored('FOCUS', 's7-mode');
  const root = await mkdtemp(join(tmpdir(), 'p3-s7-mode-'));
  try {
    const driver = { dispatch(command, launchToken) { return { launchToken, commandDigest: command.commandDigest, ref: fixture.byStep.get(command.stepId) }; } };
    const kernel = makeExactManagedKernel({ plan: fixture.plan, rootDir: root, capability: capability(3), waveRef: fixture.waveRef, wave: fixture.wave, policy, maxInFlight: 2, driver });
    let yielded = await kernel.advance(input('s7-mode', 'start', { kind: 'START', intentRef: ref('plan', fixture.plan) }));
    yielded = await kernel.advance(input('s7-mode', 'resume', { kind: 'RESUME' }, yielded.snapshot));
    const state = (await new FileArtifactStore(root).load()).state;
    const command = Object.values(state.outbox).find((candidate) => candidate.state === 'ACKED' && state.steps[candidate.stepId]?.status === 'ACTIVE');
    const wrongMode = input('s7-mode', 'wrong-mode', { kind: 'WORKER_ENVELOPE', ref: fixture.byStep.get(command.stepId) }, yielded.snapshot, command.launchToken);
    wrongMode.identity.modeEpoch += 1;
    await assert.rejects(() => kernel.advance(wrongMode), /accepted Report\/v2|Conflict|Superseded|InvalidEvent/);
    const after = (await new FileArtifactStore(root).load()).state;
    assert.equal(Object.keys(after.managed.acceptedReports).length, 0);
    assert.equal(Object.values(after.decisionTokens).some((token) => token.kind === 'DELIBERATION_SELECTION'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const gear of ['FOCUS', 'EXPLORE']) test(`valid ${gear} completion issues derived COMPLETE prefix`, async () => {
  const fixture = authored(gear, `s7-valid-${gear.toLowerCase()}`);
  const root = await mkdtemp(join(tmpdir(), `p3-s7-valid-${gear.toLowerCase()}-`));
  try {
    const run = await completeWave(`s7-valid-${gear.toLowerCase()}`, fixture, root);
    assert.equal(run.yielded.kind, 'DECISION_REQUIRED');
    const state = (await new FileArtifactStore(root).load()).state;
    const token = state.decisionTokens[run.yielded.token];
    assert.equal(token.kind, 'DELIBERATION_SELECTION');
    const accepted = fixture.reports.map((report) => {
      const row = state.managed.acceptedReports[digest(report)];
      assert.ok(row);
      assert.equal(row.ref.id, `managed-report:${row.roleDigest}:${row.ref.digest}`);
      return row.ref;
    });
    assert.deepEqual(token.orderedReportRefs, accepted);
    assert.deepEqual(token.orderedReportRefs.map(({ digest: reportDigest }) => reportDigest), fixture.reports.map(digest));
    assert.equal(Object.keys(state.managed.acceptedReports).length, fixture.reports.length);
    assert.equal(reconcileWave(fixture.waveRef, fixture.wave, fixture.reports.map((report) => ({ ref: ref(`report:${digest(report).slice(0, 16)}`, report, 'deliberation/report'), report, receipt: { commandDigest: digest('command'), resultDigest: digest(report), attemptEpoch: 0 } })) ).architecture, 'COMPLETE');
  } finally { await rm(root, { recursive: true, force: true }); }
});
