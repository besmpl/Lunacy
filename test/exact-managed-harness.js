import { canonicalString, digest } from '../dist/canonical.js';
import { authorPlan, compileWavePlan, deriveTopology, materializeRoleView } from '../dist/deliberation.js';
import { createManagedRolloutPolicy } from '../dist/managed-capability.js';
import { makeComposedKernel } from '../dist/public.js';
import { mintExploreAuthorization } from '../dist/explore-authorization.js';

const provenance = (ref) => canonicalString({ id: ref.id, digest: ref.digest, scope: ref.scope ?? null });
const launchToken = (commandId, attemptEpoch, roleDigest, predecessorReportDigests) =>
  `launch-${digest({ commandId, attemptEpoch, roleDigest, predecessorReportDigests }).slice(0, 32)}`;

const contentRef = (id, value, scope) => ({ id, scope, digest: digest(value), bytes: canonicalString(value) });

export function exactManagedTeardown(command) {
  const commandBinding = Object.fromEntries(['commandId', 'runId', 'phaseId', 'stepId', 'attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'modeEpoch', 'launchToken', 'commandDigest'].map((key) => [key, command[key]]));
  const value = {
    schema: 'lunacy-codex-deliberation-teardown/v1', command: commandBinding,
    roleDigest: command.roleView.digest, predecessorReportDigests: [...command.predecessorReportDigests],
    providerExited: true, processTreeExited: true, scratchRemoved: true,
  };
  return contentRef(`teardown:${digest(value)}`, value, 'outbox/teardown');
}

export function authorExactManagedFixture({ runId, phaseId, policy, gear = 'FOCUS' }) {
  const intent = contentRef(`intent:${runId}`, { phaseId, steps: [{ stepId: 'placeholder' }] }, 'intent');
  const authored = authorPlan({
    runId, phaseId, intent,
    evidenceSnapshot: contentRef(`snapshot:${runId}`, { generation: 1 }, 'snapshot'),
    authorityDigest: digest('authority'), policyVersion: policy.version, settlements: [],
  }, {
    decisionUnsettled: true, explicitExplore: gear === 'EXPLORE', citedWitness: false, planEquivalent: false,
    containedDiscovery: false, openEnded: gear === 'EXPLORE', highStakes: false, openlyPhrased: false,
    namedDiscriminator: gear === 'FOCUS',
  }, policy);
  if (authored.kind !== 'DELIBERATION_REQUIRED') throw new Error('exact managed fixture did not author a Wave');
  const waveRef = authored.wave; const wave = JSON.parse(waveRef.bytes); const topology = deriveTopology(waveRef, wave);
  const generatorCount = gear === 'EXPLORE' ? 5 : 2;
  const generators = Array.from({ length: generatorCount }, (_, slotOrdinal) => ({
    schema: 'lunacy-deliberation-report/v2', wave: waveRef, slotOrdinal,
    ideas: Array.from({ length: gear === 'EXPLORE' ? 6 : 1 }, (_, index) => ({ text: `idea-${slotOrdinal}-${index}`, rationale: 'because' })),
  }));
  const bareRef = (report) => contentRef(`report:${digest(report).slice(0, 16)}`, report, 'deliberation/report');
  const locators = generators.flatMap((generator) => generator.ideas.map((_, index) => ({ generatorReport: bareRef(generator), oneBasedOrdinal: index + 1 })));
  const critic = {
    schema: 'lunacy-deliberation-report/v2', wave: waveRef, slotOrdinal: generatorCount,
    scores: locators.map((idea) => ({ idea, novelty: 8, viability: 8, fit: 8, evidence: [] })),
    clusters: Array.from({ length: gear === 'FOCUS' ? 2 : 3 }, (_, cluster) => ({ label: String.fromCharCode(97 + cluster), ideas: locators.filter((_, index) => index % (gear === 'FOCUS' ? 2 : 3) === cluster) })),
  };
  const deepeners = gear === 'EXPLORE' ? [6, 7, 8].map((slotOrdinal) => ({
    schema: 'lunacy-deliberation-report/v2', wave: waveRef, slotOrdinal,
    sketch: 'One. Two. Three. Four.', loadBearingRisk: 'risk', firstConcreteStep: 'step', childIdeas: ['a', 'b', 'c'],
  })) : [];
  const reports = [...generators, critic, ...deepeners]; const reportRefs = reports.map(bareRef);
  return {
    intent, waveRef, wave, topology, reports, reportRefs, plan: compileWavePlan(waveRef, wave).value,
    byStep: new Map(topology.slots.map((slot, index) => [slot.stepId, reportRefs[index]])),
  };
}

function prepareRole(command, state, waveRef, wave, policy) {
  if (command.roleView) return;
  const topology = deriveTopology(waveRef, wave);
  const slot = topology.slots.find((candidate) => candidate.stepId === command.stepId);
  if (!slot) throw new Error('exact managed harness command is outside the Wave');
  const rowsBySlot = new Map();
  const acceptedReportsByRef = new Map();
  for (const row of Object.values(state.managed?.acceptedReports ?? {})) {
    const owner = state.outbox[row.commandId];
    if (!owner || owner.state !== 'ACKED' || owner.attemptEpoch !== command.attemptEpoch
      || owner.authorityEpoch !== command.authorityEpoch || owner.barrierEpoch !== command.barrierEpoch
      || owner.modeEpoch !== command.modeEpoch || canonicalString(row.report.wave) !== canonicalString(waveRef)) continue;
    const predecessorRef = {
      id: `report:${row.ref.digest.slice(0, 16)}`, scope: 'deliberation/report', digest: row.ref.digest,
      ...(row.ref.bytes === undefined ? {} : { bytes: row.ref.bytes }),
    };
    acceptedReportsByRef.set(provenance(predecessorRef), {
      ref: predecessorRef, report: structuredClone(row.report),
      receipt: { commandDigest: row.receipt.commandDigest, resultDigest: row.receipt.resultDigest, attemptEpoch: row.receipt.attemptEpoch },
    });
    const refs = rowsBySlot.get(row.report.slotOrdinal) ?? []; refs.push(predecessorRef); rowsBySlot.set(row.report.slotOrdinal, refs);
  }
  const predecessorRefs = slot.dependencies.map((ordinal) => {
    const refs = rowsBySlot.get(ordinal) ?? [];
    if (refs.length !== 1) throw new Error(`exact managed harness predecessor ${ordinal} is unavailable`);
    return refs[0];
  });
  const resolved = new Map();
  for (const bound of [...wave.question.evidence, ...wave.question.constraints]) {
    if (typeof bound.bytes !== 'string') throw new Error('exact managed harness requires sealed role inputs');
    resolved.set(provenance(bound), { ref: { ...bound }, bytes: bound.bytes, size: Buffer.byteLength(bound.bytes) });
  }
  const role = materializeRoleView({ waveRef, wave, slot, predecessorRefs, acceptedReportsByRef, resolved, policy });
  if (!role.ok) throw new Error(`exact managed harness role failed: ${role.code} ${role.message}`);
  const bytes = canonicalString(role.value); const roleDigest = digest(role.value);
  command.roleView = { id: `role-view:${roleDigest}`, scope: 'deliberation/role-view', digest: roleDigest, bytes };
  command.predecessorReportDigests = predecessorRefs.map((bound) => bound.digest);
  command.launchToken = launchToken(command.commandId, command.attemptEpoch, roleDigest, command.predecessorReportDigests);
  command.commandDigest = digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken });
}

function authorityAnchor(command, reportRef) {
  const transport = { id: `test-transport:${command.launchToken}`, scope: 'outbox/model-transport', digest: digest({ token: command.launchToken, kind: 'transport' }), bytes: canonicalString({ token: command.launchToken, kind: 'transport' }) };
  const teardown = { id: `test-teardown:${command.launchToken}`, scope: 'outbox/teardown', digest: digest({ token: command.launchToken, kind: 'teardown' }), bytes: canonicalString({ token: command.launchToken, kind: 'teardown' }) };
  const value = { schema: 'lunacy-managed-receipt-authority/v1', commandDigest: command.commandDigest, reportDigest: reportRef.digest, receiptDigest: digest({ commandDigest: command.commandDigest, reportDigest: reportRef.digest, transport, teardown }), transport, teardown };
  const anchorDigest = digest(value);
  return { id: `managed-receipt-authority:${command.commandDigest}:${anchorDigest}`, scope: 'outbox/managed-receipt-authority', digest: anchorDigest, bytes: canonicalString(value) };
}

function exactDriver(driver, waveRef, wave, policy) {
  const bind = (command, result) => {
    if (!result || !command.roleView) return result;
    result.ref.id = `managed-report:${command.roleView.digest}:${result.ref.digest}`;
    result.ref.scope = 'deliberation/report';
    const managedRef = result.ref;
    return { ...result, ref: managedRef, ...(result.authorityAnchor ? {} : { authorityAnchor: authorityAnchor(command, managedRef) }) };
  };
  return {
    available: (...args) => typeof driver.available === 'function' ? Reflect.apply(driver.available, driver, args) : true,
    prepare(command, state) { prepareRole(command, state, waveRef, wave, policy); },
    dispatch(command, token, signal) {
      const result = Reflect.apply(driver.dispatch, driver, [command, token, signal]);
      return result && typeof result.then === 'function' ? Promise.resolve(result).then((value) => bind(command, value)) : bind(command, result);
    },
    ...(typeof driver.observe === 'function' ? { observe(token, signal, anchor, command) { return Reflect.apply(driver.observe, driver, [token, signal, anchor, command]); } } : {}),
    ...(typeof driver.observeTeardown === 'function' ? { observeTeardown(token, commandDigestValue, signal, command) { return Reflect.apply(driver.observeTeardown, driver, [token, commandDigestValue, signal, command]); } } : {}),
  };
}

export function makeExactManagedKernel({ plan, rootDir, capability, waveRef, wave, policy, driver, maxInFlight, rolloutGeneration = 1, rolloutMode, ...dispatcher }) {
  const explore = wave.gear === 'EXPLORE';
  const rollout = {
    policy: createManagedRolloutPolicy({ generation: rolloutGeneration, mode: rolloutMode ?? (explore ? 'explicit-explore-canary' : 'focus-canary') }),
    wave: waveRef, deliberationPolicy: policy, decisionUnsettled: true,
    ...(explore ? { explicitExplore: true, openEnded: true, highStakes: true, openlyPhrased: true } : {}),
  };
  const authorization = explore ? mintExploreAuthorization({
    intent: wave.authorship.intent, authorityDigest: wave.authorship.authorityDigest,
    waveDigest: waveRef.digest, runId: wave.authorship.runId, phaseId: wave.authorship.phaseId,
    rolloutPolicyDigest: rollout.policy.digest,
  }) : undefined;
  return makeComposedKernel(
    { plan, rootDir, maxInFlight, managedCapability: capability, managedRollout: rollout },
    exactDriver(driver, waveRef, wave, policy), dispatcher,
    authorization === undefined ? undefined : { exploreAuthorization: authorization },
  );
}
