import { canonicalString, digest, parseCanonical } from './canonical.js';
import { compileWavePlan, deriveTopology, resolveWaveSemanticClosure, retainedDeliberationPolicy, validateWave, type DeliberationTopology, type DeliberationWave } from './deliberation.js';
import type { MachineState, OutboxCommand, Ref } from './model.js';
import { validatePlan } from './validator.js';

export type ExecutionPlane = 'PRE_PLAN' | 'POST_PLAN' | 'ORDINARY' | 'AMBIGUOUS';
export type CommandExecutionOwner = 'DELIBERATION' | 'ORDINARY' | 'NONE';

type WaveContext = Readonly<{ ref: Ref; wave: DeliberationWave; topology: DeliberationTopology; compiledPlanDigest: string }>;

function sameRef(a: Ref | undefined, b: Ref | undefined): boolean {
  if (!a || !b) return false;
  return a.id === b.id && a.digest === b.digest && (a.scope ?? null) === (b.scope ?? null);
}

/** Validate the exact retained Wave used for command routing. This is a
 * reader-only derivation: it neither repairs nor normalizes durable state. */
export function readExecutionWave(ref: Ref | undefined, runId: string, phaseId: string): WaveContext | undefined {
  try {
    if (!ref || ref.scope !== 'deliberation/wave' || typeof ref.bytes !== 'string') return undefined;
    const wave = parseCanonical<DeliberationWave>(ref.bytes);
    if (digest(wave) !== ref.digest) return undefined;
    const closure = resolveWaveSemanticClosure(wave); if (!closure.ok) return undefined;
    const valid = validateWave(wave, {
      runId,
      phaseId,
      policy: retainedDeliberationPolicy(wave),
      committedEvidence: closure.value.committedEvidence,
      reachableConstraints: closure.value.reachableConstraints,
    });
    if (!valid.ok) return undefined;
    const compiled = compileWavePlan(ref, valid.value);
    if (!compiled.ok) return undefined;
    return { ref: { ...ref }, wave: valid.value, topology: deriveTopology(ref, valid.value), compiledPlanDigest: digest(validatePlan(compiled.value).plan) };
  } catch { return undefined; }
}

function currentCompletePlanDecisions(state: MachineState, waveRef: Ref): import('./model.js').DecisionToken[] {
  const proposalOrigin = state.managed?.proposal?.rolloutOrigin;
  return Object.values(state.decisionTokens).filter((record) => {
    if (!record.consumed || (record.kind !== 'DELIBERATION_SELECTION' && record.kind !== 'DELIBERATION') || record.resultKind !== 'COMPLETE_PLAN') return false;
    if (!record.resultDigest || !record.bindingDigest || !record.publicationLeaseSetId || !['SELECTION', 'SYNTHESIS'].includes(record.disposition ?? '')) return false;
    if (!sameRef(record.waveRef, waveRef)) return false;
    if (canonicalString(record.rolloutOrigin ?? null) !== canonicalString(proposalOrigin ?? null)) return false;
    const lease = state.managed?.leaseSets[record.publicationLeaseSetId];
    return Boolean(lease && (lease.status === 'ACTIVE' || lease.status === 'PROMOTED'));
  });
}

/** Pure command-plane derivation. Proposal history is provenance; only the
 * compiled current Wave before adoption or one closed COMPLETE_PLAN binding
 * after adoption can select a live plane. */
export function deriveExecutionPlane(state: MachineState): ExecutionPlane {
  if (state.schema !== 2 || !state.managed?.proposal) return 'ORDINARY';
  if (state.modeEpoch !== 0) return 'AMBIGUOUS';
  const proposal = state.managed.proposal;
  const context = readExecutionWave(proposal.roleWaveRef, state.runId, state.phaseId);
  if (!context) return 'AMBIGUOUS';
  const decisions = currentCompletePlanDecisions(state, context.ref);
  if (decisions.length > 1) return 'AMBIGUOUS';
  if (decisions.length === 0) {
    return state.planDigest === context.compiledPlanDigest && proposal.planDigest === state.planDigest ? 'PRE_PLAN' : 'AMBIGUOUS';
  }
  return state.planDigest === proposal.planDigest ? 'POST_PLAN' : 'AMBIGUOUS';
}

function currentFrame(state: MachineState, command: OutboxCommand): boolean {
  return command.runId === state.runId && command.phaseId === state.phaseId
    && command.attemptEpoch === state.attemptEpoch && command.authorityEpoch === state.authorityEpoch
    && command.barrierEpoch === state.barrierEpoch && command.modeEpoch === state.modeEpoch;
}

function roleBindingIsValid(command: OutboxCommand, context: WaveContext): boolean {
  if (!command.roleView || command.roleView.scope !== 'deliberation/role-view' || typeof command.roleView.bytes !== 'string') return false;
  let role: Record<string, unknown>;
  try {
    role = parseCanonical<Record<string, unknown>>(command.roleView.bytes);
    if (!role || typeof role !== 'object' || Array.isArray(role) || digest(role) !== command.roleView.digest) return false;
  } catch { return false; }
  const slot = context.topology.slots.find((candidate) => candidate.stepId === command.stepId);
  if (!slot || role.kind !== slot.role || !Array.isArray(command.predecessorReportDigests)) return false;
  let bound: unknown[];
  if (slot.role === 'GENERATOR') bound = [];
  else if (slot.role === 'CRITIC') bound = Array.isArray(role.generators) ? role.generators.map((item) => (item as { ref?: { digest?: unknown } })?.ref?.digest) : [];
  else bound = [(role.critic as { ref?: { digest?: unknown } } | undefined)?.ref?.digest];
  return bound.length === slot.dependencies.length
    && bound.every((value, index) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && value === command.predecessorReportDigests![index]);
}

/** Prepared roleView commands retain deliberation ownership across restart.
 * Unprepared commands may enter that plane only while the exact current Wave
 * Plan is active. Roleless post-Plan work belongs only to the ordinary plane. */
export function commandExecutionOwner(state: MachineState, command: OutboxCommand): CommandExecutionOwner {
  const proposal = state.managed?.proposal;
  const context = proposal ? readExecutionWave(proposal.roleWaveRef, state.runId, state.phaseId) : undefined;
  if (command.roleView) return context && roleBindingIsValid(command, context) ? 'DELIBERATION' : 'NONE';
  if (!currentFrame(state, command)) return 'NONE';
  const plane = deriveExecutionPlane(state);
  if (plane === 'PRE_PLAN') return context?.topology.slots.some((slot) => slot.stepId === command.stepId) ? 'DELIBERATION' : 'NONE';
  if (plane === 'POST_PLAN' || plane === 'ORDINARY') return 'ORDINARY';
  return 'NONE';
}

export function executionCapacity(state: MachineState | undefined, ordinaryCapacity: number, initialWave?: Ref): number {
  if (!state) {
    if (!initialWave) return ordinaryCapacity;
    try {
      const wave = parseCanonical<DeliberationWave>(initialWave.bytes ?? '');
      const context = readExecutionWave(initialWave, wave.authorship.runId, wave.authorship.phaseId);
      return context?.wave.gear === 'EXPLORE' ? 5 : context?.wave.gear === 'FOCUS' ? 2 : 0;
    } catch { return 0; }
  }
  const plane = deriveExecutionPlane(state);
  if (plane === 'POST_PLAN' || plane === 'ORDINARY') return ordinaryCapacity;
  if (plane !== 'PRE_PLAN') return 0;
  const context = readExecutionWave(state.managed?.proposal?.roleWaveRef, state.runId, state.phaseId);
  if (!context) return 0;
  // The reducer's dependency closure narrows critic/deepener admission to the
  // actual wavefront. This ceiling supplies only the plane's maximum width.
  return context.wave.gear === 'EXPLORE' ? 5 : 2;
}
