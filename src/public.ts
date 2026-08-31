import { digest, canonicalString, identityKey, parseCanonical } from './canonical.js';
import { canonicalClaims, proveAdmission } from './admission.js';
import { appendJournal, applyAuthorityAdoption, applyDispatchReceipt, applyParentDecision, applyManagedReservations, applyManagedRolloutPolicy, bindManagedProposal, commandForToken, migrateMachineState, nextWriterFence, reduce, refreshAdmission, retireManagedAttempt, validateManagedDecisionBinding, type PreparedDecisionPublication } from './reducer.js';
import { claim, commandInCurrentFrame, unknown, type DriverReceipt } from './outbox.js';
import { ProseDriver, type EffectDriver } from './driver.js';
import { isStoreGenerationConflict, storeForRoot, type ArtifactStore, type StoreLinearizedDispatchRequest } from './store.js';
import type { FilesystemIdentity } from './filesystem.js';
import { validatePlan } from './validator.js';
import { isDispatchableStepStatus } from './dependency.js';
import { compileWavePlan, deriveTopology, shadowPolicy, validateRef as validateDeliberationRef, validateWave, verifyWavePlan, type DeliberationPolicy, type DeliberationWave } from './deliberation.js';
import { verifyReadSet } from './authority.js';
import { DispatchCoordinator, type DispatchDriverSnapshot, type ActiveDispatchTask } from './dispatch-coordinator.js';
import { AccelerationMetrics, defaultMetrics } from './metrics.js';
import { JOURNAL_BYTE_CEILING, JOURNAL_EVENT_CEILING } from './limits.js';
import { assertManagedGraph, createManagedCapability, createManagedRolloutPolicy, managedAdmissionAllowed, managedRolloutDecision, verifyManagedCapability, verifyManagedRolloutPolicy, type ManagedCapability, type ManagedCapabilityInput, type ManagedRolloutDecision, type ManagedRolloutPolicy, type ManagedRolloutPolicyInput } from './managed-capability.js';
import type { AdvanceInput, CompactSnapshot, Event, EventIdentity, MachineState, Plan, Ref, Yield } from './model.js';
export type { AdvanceInput, CompactSnapshot, Cursor, Event, EventIdentity, Plan, PlanStep, Ref, Yield, RunId, PhaseId, StepId, EventId, Sha256, LaunchToken } from './model.js';

/**
 * The one START declaration alias set shared by the public kernel and the
 * private bridge.  A raw declaration and its validator-normalized form are
 * accepted, plus the source-bound plan's semantic spelling (authorityDigest
 * omitted).  Callers must not add arbitrary aliases around this boundary:
 * the bridge preflight and RunKernel.advance must admit exactly this set.
 */
export function acceptedStartPlanDigests(rawPlan: Plan, normalizedPlan: Plan): readonly string[] {
  const accepted = new Set<string>([digest(rawPlan), digest(normalizedPlan)]);
  if (normalizedPlan.authorityDigest !== undefined) {
    const { authorityDigest: _authorityDigest, ...withoutSourceBinding } = normalizedPlan;
    accepted.add(digest(withoutSourceBinding));
  }
  return [...accepted];
}

export type KernelOptions = {
  plan: Plan;
  rootDir?: string;
  maxInFlight?: number;
  workspace?: string;
  ownership?: string;
  admission?: (input: { runId: string; claims: import('./model.js').Claim[]; workspace?: string; ownership?: string }) => boolean | Promise<boolean>;
  /** Composition-time diagnostics. Legacy acceleration decorations are inert. */
  acceleration?: {
    graph?: unknown;
    metrics?: AccelerationMetrics;
  };
  /** Private Stage-C opt-in. Omitted keeps the ordinary schema-1 path. */
  managedCapability?: ManagedCapabilityInput | ManagedCapability | null;
  /** Operator kill switch for the managed capability; default is off. */
  managedKillSwitch?: boolean;
  /** Private P4 rollout control. Omitted preserves the explicit Stage-C
   * capability seam; an explicit disabled policy is a true managed bypass. */
  managedRollout?: {
    policy: ManagedRolloutPolicyInput | ManagedRolloutPolicy;
    wave?: Ref;
    deliberationPolicy?: DeliberationPolicy;
    synthetic?: boolean;
    disposable?: boolean;
    explicitExplore?: boolean;
    decisionUnsettled?: boolean;
    openEnded?: boolean;
    highStakes?: boolean;
    openlyPhrased?: boolean;
  } | null;
};

/** Private composition-only dispatcher controls.  These types are exported
 * from the private composition subpath, never from the package root. */
export type DispatcherOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onYield?: (value: Yield) => void | Promise<void>;
};

export class KernelError extends Error { constructor(public readonly code: 'InvalidEvent' | 'Conflict' | 'ManifestMismatch' | 'InvalidPlan', message: string) { super(message); this.name = code; } }
export class InvalidEvent extends KernelError { constructor(message: string) { super('InvalidEvent', message); } }
export class Conflict extends KernelError { constructor(message: string) { super('Conflict', message); } }
export class InvalidPlan extends KernelError { constructor(message: string) { super('InvalidPlan', message); } }

export interface RunKernel { advance(input: AdvanceInput): Promise<Yield>; }

function validateKernelOptions(options: KernelOptions): number {
  if (!options || typeof options !== 'object' || !options.plan || typeof options.plan !== 'object') throw new InvalidPlan('plan is required');
  if (options.rootDir !== undefined && typeof options.rootDir !== 'string') throw new InvalidPlan('rootDir must be a string');
  if (options.workspace !== undefined && typeof options.workspace !== 'string') throw new InvalidPlan('workspace must be a string');
  if (options.ownership !== undefined && typeof options.ownership !== 'string') throw new InvalidPlan('ownership must be a string');
  if (options.admission !== undefined && typeof options.admission !== 'function') throw new InvalidPlan('admission must be a function');
  if (options.managedKillSwitch !== undefined && typeof options.managedKillSwitch !== 'boolean') throw new InvalidPlan('managedKillSwitch must be boolean');
  if (options.managedCapability !== undefined && options.managedCapability !== null) {
    try { createManagedCapability(options.managedCapability as ManagedCapabilityInput); }
    catch { throw new InvalidPlan('managedCapability is invalid'); }
  }
  if (options.managedRollout !== undefined && options.managedRollout !== null) {
    if (!options.managedRollout || typeof options.managedRollout !== 'object' || Array.isArray(options.managedRollout)) throw new InvalidPlan('managedRollout is invalid');
    const allowed = new Set(['policy', 'wave', 'deliberationPolicy', 'synthetic', 'disposable', 'explicitExplore', 'decisionUnsettled', 'openEnded', 'highStakes', 'openlyPhrased']);
    if (Object.keys(options.managedRollout).some((key) => !allowed.has(key))) throw new InvalidPlan('managedRollout fields are not closed');
    if (!options.managedCapability) throw new InvalidPlan('managedRollout requires managedCapability');
    try { createManagedRolloutPolicy(options.managedRollout.policy); }
    catch { throw new InvalidPlan('managedRollout policy is invalid'); }
    for (const key of ['synthetic', 'disposable', 'explicitExplore', 'decisionUnsettled', 'openEnded', 'highStakes', 'openlyPhrased'] as const) {
      if (options.managedRollout[key] !== undefined && typeof options.managedRollout[key] !== 'boolean') throw new InvalidPlan(`managedRollout ${key} must be boolean`);
    }
  }
  const maxInFlight = options.maxInFlight;
  if (maxInFlight !== undefined && (!Number.isSafeInteger(maxInFlight) || maxInFlight < 0)) throw new InvalidPlan('maxInFlight must be a non-negative safe integer');
  const configuredMaxInFlight = maxInFlight ?? 1;
  const acceleration = options.acceleration;
  if (!acceleration) return configuredMaxInFlight;
  if (acceleration.metrics !== undefined && (!acceleration.metrics || typeof acceleration.metrics !== 'object' || typeof acceleration.metrics.increment !== 'function' || typeof acceleration.metrics.snapshot !== 'function')) throw new InvalidPlan('acceleration metrics are invalid');
  return configuredMaxInFlight;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function ref(id: string, value: unknown, scope = 'kernel'): Ref { const bytes = canonicalString(value); return { id, scope, digest: digest(value), bytes }; }
function snapshot(state: MachineState): CompactSnapshot {
  const steps = Object.values(state.steps); const outbox = Object.values(state.outbox);
  return { revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, runStatus: state.status, phase: state.phaseId, gate: state.gate, barrier: state.barrier, readyCount: steps.filter((s) => isDispatchableStepStatus(s.status)).length, activeCount: steps.filter((s) => s.status === 'ACTIVE').length, pendingDispatchCount: outbox.filter((x) => x.state === 'PENDING' || x.state === 'CLAIMED').length, unknownDispatchCount: outbox.filter((x) => x.state === 'UNKNOWN').length, nextAction: state.nextAction };
}
function asYield(state: MachineState, result: { outcome: string; reason?: string; token?: string; brief?: Ref; receipt?: Ref; launchToken?: string }): Yield {
  const snap = snapshot(state); const cursor = { revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch };
  if (result.outcome === 'PHASE_READY') {
    const token = result.token ?? Object.keys(state.decisionTokens).find((t) => !state.decisionTokens[t].consumed);
    return { kind: 'FINAL', status: 'phase-ready', artifacts: token ? [ref(`decision:${token}`, { token, gate: state.gate }, 'gate')] : [], snapshot: snap };
  }
  if (result.outcome === 'COMPLETE') return { kind: 'FINAL', status: 'complete', artifacts: [], snapshot: snap };
  if (result.outcome === 'DECISION_REQUIRED') {
    const brief = result.brief ?? ref(`brief:${state.revision}`, { reason: result.reason ?? 'decision required' }, 'decision');
    return { kind: 'DECISION_REQUIRED', brief, token: result.token ?? `decision-${state.revision}`, cursor, snapshot: snap };
  }
  if (result.outcome === 'BLOCKED') {
    const reason = result.reason ?? 'blocked';
    const code = reason === 'CrossRunUnproven' ? 'CrossRunUnproven' : reason === 'UnknownDispatch' ? 'UnknownDispatch' : reason === 'HumanReceiptRequired' ? 'HumanReceiptRequired' : reason === 'ManifestMismatch' ? 'ManifestMismatch' : reason === 'JournalCeiling' ? 'JournalCeiling' : reason === 'STALE' ? 'STALE' : reason === 'NO_SETTLEMENT' ? 'NO_SETTLEMENT' : 'InvalidEvent';
    return { kind: 'BLOCKED', code, reason, ...(result.receipt === undefined ? {} : { receipt: result.receipt }), ...(result.launchToken === undefined ? {} : { launchToken: result.launchToken }), retryable: code !== 'UnknownDispatch' && code !== 'HumanReceiptRequired' && code !== 'JournalCeiling' && reason !== 'gate findings', snapshot: snap };
  }
  return { kind: 'WAITING', cursor, snapshot: snap };
}

function eventDigest(input: AdvanceInput): string { return digest(input.event); }
// The journal is intentionally finite until a separately designed compaction
// protocol exists. Crossing either bound blocks promotion; records are never
// silently truncated or rewritten.
export { JOURNAL_EVENT_CEILING, JOURNAL_BYTE_CEILING } from './limits.js';
function journalHasRecordBudget(state: MachineState, additionalRecords: number): boolean {
  return state.journal.length + additionalRecords <= JOURNAL_EVENT_CEILING;
}
function segmentedJournalEnabled(store: ArtifactStore): boolean { return store.journalFormat === 'segmented' || store.journalFormat === 'segmented/v2'; }
function exactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new InvalidEvent(`${label} fields are invalid`);
}
function validateRef(value: Ref): void {
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new InvalidEvent('ref is malformed');
  const refKeys = Object.keys(value as unknown as object);
  if (refKeys.some((key) => !['id', 'digest', 'scope', 'bytes'].includes(key))) throw new InvalidEvent('ref fields are invalid');
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)) throw new InvalidEvent('ref is malformed');
  if (value.scope !== undefined && (typeof value.scope !== 'string' || value.scope.length === 0)) throw new InvalidEvent('ref scope is malformed');
  if (value.bytes !== undefined && typeof value.bytes !== 'string') throw new InvalidEvent('ref bytes must be a string');
  if (value.bytes !== undefined) {
    try {
      const parsed = JSON.parse(value.bytes);
      if (canonicalString(parsed) !== value.bytes) throw new Error('non-canonical bytes');
      if (digest(parsed) !== value.digest) throw new Error('digest does not match bytes');
    } catch { throw new InvalidEvent('ref bytes must be canonical JSON'); }
  }
}
function validateWorkerEnvelope(value: Ref): void {
  if (typeof value.bytes !== 'string') throw new InvalidEvent('worker envelope requires canonical result bytes');
  try {
    const result = parseCanonical<Record<string, unknown>>(value.bytes);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid worker result');
    if (typeof result.status === 'string' && Object.keys(result).length === 1) return;
    if (result.schema === 'lunacy-deliberation-report/v2' && Object.prototype.hasOwnProperty.call(result, 'wave') && Number.isSafeInteger(result.slotOrdinal)) return;
    throw new Error('invalid worker result');
  } catch { throw new InvalidEvent('worker envelope result is malformed'); }
}
function validateEvent(event: unknown): asserts event is Event {
  if (!event || typeof event !== 'object' || (Object.getPrototypeOf(event) !== Object.prototype && Object.getPrototypeOf(event) !== null) || typeof (event as { kind?: unknown }).kind !== 'string') throw new InvalidEvent('event is malformed');
  const kind = (event as { kind: string }).kind;
  switch (kind) {
    case 'START':
      exactKeys(event as object, ['kind', 'intentRef'], 'START event');
      validateRef((event as Extract<Event, { kind: 'START' }>).intentRef);
      return;
    case 'RESUME':
      exactKeys(event as object, ['kind'], 'RESUME event'); return;
    case 'PARENT_DECISION': {
      exactKeys(event as object, ['kind', 'token', 'value'], 'PARENT_DECISION event');
      const decision = event as Extract<Event, { kind: 'PARENT_DECISION' }>;
      if (typeof decision.token !== 'string' || decision.token.length === 0) throw new InvalidEvent('decision token is required');
      return;
    }
    case 'DISPATCH_RECEIPT':
      exactKeys(event as object, ['kind', 'ref'], 'DISPATCH_RECEIPT event');
      const receiptRef = (event as Extract<Event, { kind: 'DISPATCH_RECEIPT' }>).ref;
      validateRef(receiptRef);
      if (typeof receiptRef.bytes !== 'string') throw new InvalidEvent('dispatch receipt requires canonical proof bytes');
      try {
        const proof = JSON.parse(receiptRef.bytes) as Record<string, unknown>;
        if (!proof || typeof proof !== 'object' || Array.isArray(proof) || typeof proof.launchToken !== 'string' || typeof proof.commandDigest !== 'string' || Object.keys(proof).some((key) => !['launchToken', 'commandDigest', 'receipt'].includes(key))) throw new Error('invalid dispatch proof');
        if (proof.receipt !== undefined) validateRef(proof.receipt as Ref);
      } catch { throw new InvalidEvent('dispatch receipt proof is malformed'); }
      return;
    case 'WORKER_ENVELOPE':
      exactKeys(event as object, ['kind', 'ref'], 'WORKER_ENVELOPE event');
      const workerRef = (event as Extract<Event, { kind: 'WORKER_ENVELOPE' }>).ref;
      validateRef(workerRef);
      validateWorkerEnvelope(workerRef);
      return;
    case 'OBSERVATION': {
      exactKeys(event as object, ['kind', 'ref', 'category'], 'OBSERVATION event');
      const observation = event as Extract<Event, { kind: 'OBSERVATION' }>;
      if (!['USER_CHANGE', 'HOST', 'RECOVERY'].includes(observation.category)) throw new InvalidEvent('observation category is invalid');
      validateRef(observation.ref);
      if (observation.category === 'RECOVERY' && typeof observation.ref.bytes !== 'string') throw new InvalidEvent('recovery observation requires canonical proof bytes');
      if (observation.category === 'RECOVERY') {
        try {
          const recovery = JSON.parse(observation.ref.bytes!) as Record<string, unknown>;
          if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) || typeof recovery.launchToken !== 'string' || typeof recovery.commandDigest !== 'string' || typeof recovery.status !== 'string' || Object.keys(recovery).some((key) => !['launchToken', 'commandDigest', 'status'].includes(key))) throw new Error('invalid recovery proof');
        } catch { throw new InvalidEvent('recovery observation proof is malformed'); }
      }
      return;
    }
    default: throw new InvalidEvent(`unknown event kind ${kind}`);
  }
}
function validateIdentity(input: AdvanceInput): void {
  if (!input || typeof input !== 'object' || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new InvalidEvent('input is malformed');
  if (Object.keys(input as object).some((key) => !['runId', 'identity', 'event', 'expectedRevision'].includes(key))) throw new InvalidEvent('input fields are invalid');
  if (typeof input.runId !== 'string' || input.runId.length === 0 || !input.identity || typeof input.identity !== 'object' || (Object.getPrototypeOf(input.identity) !== Object.prototype && Object.getPrototypeOf(input.identity) !== null)) throw new InvalidEvent('runId and identity.runId must match');
  if (Object.keys(input.identity as object).some((key) => !['runId', 'phaseId', 'stepId', 'attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'eventId', 'payloadDigest', 'launchToken'].includes(key))) throw new InvalidEvent('identity fields are invalid');
  if (input.identity.runId !== input.runId) throw new InvalidEvent('runId and identity.runId must match');
  if (!input.event || typeof input.event !== 'object') throw new InvalidEvent('event is required');
  validateEvent(input.event);
  for (const key of ['phaseId', 'stepId', 'eventId'] as const) if (typeof input.identity[key] !== 'string' || input.identity[key].length === 0) throw new InvalidEvent(`${key} is required`);
  if (!Number.isSafeInteger(input.identity.attemptEpoch) || input.identity.attemptEpoch < 0 || !Number.isSafeInteger(input.identity.authorityEpoch) || input.identity.authorityEpoch < 0 || !Number.isSafeInteger(input.identity.barrierEpoch) || input.identity.barrierEpoch < 0) throw new InvalidEvent('epochs must be non-negative integers');
  if (typeof input.identity.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.identity.payloadDigest)) throw new InvalidEvent('payloadDigest must be a SHA-256 hex digest');
  let expectedDigest: string;
  try { expectedDigest = eventDigest(input); } catch { throw new InvalidEvent('event is not canonical JSON'); }
  if (input.identity.payloadDigest !== expectedDigest) throw new InvalidEvent('payloadDigest does not match canonical event bytes');
  if (input.identity.launchToken !== undefined && (typeof input.identity.launchToken !== 'string' || input.identity.launchToken.length === 0)) throw new InvalidEvent('launchToken is invalid');
  if ((input.event.kind === 'DISPATCH_RECEIPT' || input.event.kind === 'WORKER_ENVELOPE') && !input.identity.launchToken) throw new InvalidEvent(`${input.event.kind} requires launchToken`);
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) throw new InvalidEvent('expectedRevision must be a non-negative integer');
}

function emptyState(runId: string, phaseId: string): MachineState {
  return { schema: 1, runId, phaseId, revision: 0, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0, modeEpoch: 0, writerFence: 'none', status: 'BLOCKED', gate: 'NOT-DUE', barrier: 'OPEN', steps: {}, outbox: {}, processed: {}, decisionTokens: {}, planDigest: digest({ runId, phaseId, empty: true }), nextAction: 'blocked', journal: [] };
}

function planFromCommittedState(state: MachineState): Plan {
  return {
    schema: 'lunacy-plan-v1', phaseId: state.phaseId,
    steps: Object.values(state.steps).map((machine) => {
      const { status: _status, attempt: _attempt, lastEvent: _lastEvent, ...step } = machine;
      return step;
    }),
  };
}

function canReconcileWithoutLivePlan(state: MachineState, input: AdvanceInput): boolean {
  const commands = Object.values(state.outbox);
  if (input.event.kind === 'PARENT_DECISION') return Object.prototype.hasOwnProperty.call(state.decisionTokens, input.event.token) && (state.gate === 'DUE' || state.decisionTokens[input.event.token]?.kind === 'AUTHORITY_ADOPTION');
  if (input.event.kind === 'RESUME') return commands.some((command) => (command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN') && commandInCurrentFrame(state, command));
  if (!input.identity.launchToken) return false;
  const command = commands.find((candidate) => candidate.launchToken === input.identity.launchToken);
  if (!command) return false;
  if (input.event.kind === 'DISPATCH_RECEIPT' || input.event.kind === 'WORKER_ENVELOPE') return true;
  if (input.event.kind === 'OBSERVATION' && input.event.category === 'RECOVERY') {
    try { const proof = JSON.parse(input.event.ref.bytes ?? '') as { launchToken?: unknown }; return proof.launchToken === command.launchToken; }
    catch { return false; }
  }
  return false;
}

function internalIdentity(state: MachineState, command: { launchToken: string; stepId: string }, eventId: string, event: Event): EventIdentity {
  return { runId: state.runId, phaseId: state.phaseId, stepId: command.stepId, attemptEpoch: state.attemptEpoch, authorityEpoch: state.authorityEpoch, barrierEpoch: state.barrierEpoch, eventId, payloadDigest: digest(event), launchToken: command.launchToken };
}
function receiptEnvelope(command: { launchToken: string; commandDigest: string }, receipt: DriverReceipt): Ref {
  const value = { launchToken: command.launchToken, commandDigest: command.commandDigest, receipt: receipt.ref, ...(receipt.authorityAnchor ? { authorityAnchor: receipt.authorityAnchor } : {}) };
  return ref(`receipt:${command.launchToken}`, value, 'outbox/receipt');
}

function hasLiveOldWork(state: MachineState): boolean {
  return Object.values(state.steps).some((step) => step.status === 'ACTIVE') || Object.values(state.outbox).some((command) => command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN');
}

function isOldWorkEvent(state: MachineState, input: AdvanceInput): boolean {
  if (input.event.kind === 'RESUME') return Object.values(state.outbox).some((command) => command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN');
  if (!input.identity.launchToken) return false;
  const command = commandForToken(state, input.identity.launchToken);
  if (!command) return false;
  if (input.event.kind === 'DISPATCH_RECEIPT' || input.event.kind === 'WORKER_ENVELOPE') return true;
  return input.event.kind === 'OBSERVATION' && input.event.category === 'RECOVERY';
}

function isAdoptionDecision(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  const kind = object.kind ?? object.decision;
  return kind === 'ADOPT' || kind === 'ADOPT_AUTHORITY' || kind === 'AUTHORITY_ADOPT';
}

function authorityAdoptionRequired(current: MachineState, identity: EventIdentity, targetDigest: string): { state: MachineState; yield: Yield } {
  const priorEntry = Object.entries(current.decisionTokens).find(([, record]) => record.kind === 'AUTHORITY_ADOPTION' && !record.consumed);
  const priorToken = priorEntry?.[1];
  const blockedState = clone(current);
  let token: string;
  if (priorToken && priorToken.targetDigest === targetDigest && priorToken.observedDigest === targetDigest) {
    token = priorEntry![0];
  } else {
    if (priorEntry) blockedState.decisionTokens[priorEntry[0]]!.consumed = true;
    token = `authority-${current.revision}-${targetDigest.slice(0, 16)}`;
    let suffix = 1;
    while (Object.prototype.hasOwnProperty.call(blockedState.decisionTokens, token)) token = `authority-${current.revision}-${targetDigest.slice(0, 16)}-${suffix++}`;
    blockedState.decisionTokens[token] = { kind: 'AUTHORITY_ADOPTION', consumed: false, identity: digest(identity), expectedDigest: current.planDigest, observedDigest: targetDigest, targetDigest, ...(current.managed?.rolloutOrigin ? { rolloutOrigin: { ...current.managed.rolloutOrigin } } : {}) };
  }
  const value: Yield = { kind: 'DECISION_REQUIRED', brief: ref(`authority:${current.revision}`, { expected: current.planDigest, actual: targetDigest, token }, 'authority'), token, cursor: { revision: current.revision, authorityEpoch: current.authorityEpoch, attemptEpoch: current.attemptEpoch, barrierEpoch: current.barrierEpoch }, snapshot: snapshot(blockedState) };
  return { state: blockedState, yield: value };
}

/**
 * Classify a caller against the two committed identity projections before
 * any live-plan or recovery work runs.  Exact processed-key replay remains
 * the strongest evidence; the journal and the remaining processed rows only
 * prove that this event id cannot be reused under a different identity.
 */
function readExactProcessedReplay(state: MachineState, key: string, identity: EventIdentity): Yield | undefined {
  const duplicate = state.processed[key];
  if (!duplicate) return undefined;
  try {
    if (duplicate.digest !== identity.payloadDigest || identityKey(duplicate.identity) !== key) return undefined;
    return parseCanonical<Yield>(duplicate.yieldBytes);
  }
  catch { return undefined; }
}

function classifyCommittedReplay(state: MachineState, key: string, identity: EventIdentity): Yield | undefined {
  const replay = readExactProcessedReplay(state, key, identity);
  if (replay !== undefined) return replay;
  if (state.journal.some((entry) => entry.identity.eventId === identity.eventId)) throw new Conflict('eventId reused with conflicting identity');
  if (Object.entries(state.processed).some(([processedKey, record]) => processedKey !== key && record.identity.eventId === identity.eventId)) throw new Conflict('eventId reused with conflicting identity');
  return undefined;
}

function mapCommitFailure(error: unknown): KernelError {
  const message = (error as Error).message;
  return message.includes('ManifestMismatch') ? new KernelError('ManifestMismatch', message) : new Conflict(message);
}

function rolloutGear(waveRef: Ref | undefined): 'FOCUS' | 'EXPLORE' | undefined {
  try {
    if (!waveRef?.bytes) return undefined;
    const wave = parseCanonical<DeliberationWave>(waveRef.bytes);
    return wave.gear === 'FOCUS' || wave.gear === 'EXPLORE' ? wave.gear : undefined;
  } catch { return undefined; }
}

function evaluateManagedRollout(
  planInput: Plan,
  capability: ManagedCapability | undefined,
  config: NonNullable<KernelOptions['managedRollout']>,
  policy: ManagedRolloutPolicy,
): ManagedRolloutDecision {
  const direct = () => managedRolloutDecision(policy, capability, {
    gear: 'DIRECT', synthetic: false, disposable: false, effectDenied: false,
    oneDecisionKey: false, staticTopology: false, childDelegation: false,
    claimsOrEffects: false, sealedEvidenceOnly: false, explicitExplore: false,
    decisionUnsettled: false, openEnded: false, highStakes: false, openlyPhrased: false,
  });
  if (!config.wave) return direct();
  let wave: DeliberationWave | undefined;
  try {
    const checkedRef = validateDeliberationRef(config.wave);
    if (!checkedRef.ok || typeof checkedRef.value.bytes !== 'string' || checkedRef.value.scope !== 'deliberation/wave' || !config.deliberationPolicy) throw new Error('wave unavailable');
    wave = parseCanonical<DeliberationWave>(checkedRef.value.bytes);
    if (digest(wave) !== checkedRef.value.digest) throw new Error('wave digest mismatch');
    const evidence = new Set(wave.question.evidence.map((item) => canonicalString({ id: item.id, digest: item.digest, scope: item.scope ?? null })));
    const constraints = new Set(wave.question.constraints.map((item) => canonicalString({ id: item.id, digest: item.digest, scope: item.scope ?? null })));
    const validated = validateWave(wave, { runId: wave.authorship.runId, phaseId: wave.authorship.phaseId, policy: config.deliberationPolicy, committedEvidence: evidence, reachableConstraints: constraints });
    if (!validated.ok) throw new Error('wave invalid');
    const compiled = compileWavePlan(checkedRef.value, validated.value);
    if (!compiled.ok) throw new Error('wave plan invalid');
    const topology = deriveTopology(checkedRef.value, validated.value);
    if (!verifyWavePlan(compiled.value, topology).ok) throw new Error('wave topology invalid');
    const supplied = validatePlan(planInput).plan;
    const compiledPlan = validatePlan(compiled.value).plan;
    const planMatches = digest(supplied) === digest(compiledPlan);
    const refs = [...validated.value.question.evidence, ...validated.value.question.constraints];
    const sealedEvidenceOnly = refs.every((item) => typeof item.bytes === 'string' && validateDeliberationRef(item).ok);
    const claimsOrEffects = compiledPlan.steps.some((step) => (step.claims ?? []).some((claim) => claim.mode !== 'READ'));
    return managedRolloutDecision(policy, capability, {
      gear: validated.value.gear,
      synthetic: config.synthetic === true,
      disposable: config.disposable === true,
      effectDenied: capability?.effectDenied === true,
      oneDecisionKey: validated.value.authorship.decisionKey.length > 0,
      staticTopology: planMatches,
      childDelegation: false,
      claimsOrEffects,
      sealedEvidenceOnly,
      explicitExplore: config.explicitExplore === true,
      decisionUnsettled: config.decisionUnsettled === true,
      openEnded: config.openEnded === true,
      highStakes: config.highStakes === true,
      openlyPhrased: config.openlyPhrased === true,
    });
  } catch {
    const gear = wave?.gear === 'EXPLORE' ? 'EXPLORE' : 'FOCUS';
    return managedRolloutDecision(policy, capability, {
      gear, synthetic: config.synthetic === true, disposable: config.disposable === true,
      effectDenied: capability?.effectDenied === true, oneDecisionKey: false,
      staticTopology: false, childDelegation: false, claimsOrEffects: true,
      sealedEvidenceOnly: false, explicitExplore: config.explicitExplore === true,
      decisionUnsettled: config.decisionUnsettled === true, openEnded: config.openEnded === true,
      highStakes: config.highStakes === true, openlyPhrased: config.openlyPhrased === true,
    });
  }
}

class KernelImpl implements RunKernel {
  private readonly configuredMaxInFlight: number;
  private readonly metrics: AccelerationMetrics;
  readonly #managedCapability?: ManagedCapability;
  readonly #managedKillSwitch: boolean;
  readonly #managedRolloutPolicy?: ManagedRolloutPolicy;
  readonly #managedRolloutDecision?: ManagedRolloutDecision;
  /** In-process dispatch state is owned by the private coordinator.  These
   * compatibility views are intentionally non-authoritative diagnostics. */
  private readonly coordinator: DispatchCoordinator;
  get activeDispatches(): Map<string, ActiveDispatchTask> { return this.coordinator.activeDispatches; }
  get dispatchOptions(): DispatchCoordinator['options'] { return this.coordinator.dispatchOptions; }

  constructor(private readonly options: KernelOptions, configuredMaxInFlight: number, private readonly store: ArtifactStore, driver?: DispatchDriverSnapshot, dispatcher: DispatcherOptions = {}) {
    this.configuredMaxInFlight = configuredMaxInFlight;
    this.#managedCapability = options.managedCapability && options.managedCapability !== null ? createManagedCapability(options.managedCapability as ManagedCapabilityInput) : undefined;
    this.#managedKillSwitch = options.managedKillSwitch ?? false;
    this.metrics = options.acceleration?.metrics ?? defaultMetrics;
    if (options.managedRollout) {
      this.#managedRolloutPolicy = createManagedRolloutPolicy(options.managedRollout.policy);
      this.#managedRolloutDecision = evaluateManagedRollout(options.plan, this.#managedCapability, options.managedRollout, this.#managedRolloutPolicy);
      if (this.#managedRolloutPolicy.mode !== 'disabled' && this.#managedRolloutDecision.reason !== 'DIRECT_BYPASS') {
        this.safeMetric(this.#managedKillSwitch ? 'managedWavesKilled' : this.#managedRolloutDecision.admitted ? 'managedWavesAdmitted' : 'managedWavesRefused');
        const gear = rolloutGear(options.managedRollout.wave);
        if (gear) this.safeMetric(gear === 'FOCUS' ? 'managedFocusProposals' : 'managedExploreProposals');
      }
    }
    const timeoutMs = dispatcher.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new InvalidPlan('dispatcher timeoutMs must be a non-negative safe integer');
    if (dispatcher.signal !== undefined && (typeof dispatcher.signal !== 'object' || typeof dispatcher.signal.addEventListener !== 'function' || typeof dispatcher.signal.removeEventListener !== 'function' || typeof dispatcher.signal.aborted !== 'boolean')) throw new InvalidPlan('dispatcher signal is invalid');
    if (dispatcher.onYield !== undefined && typeof dispatcher.onYield !== 'function') throw new InvalidPlan('dispatcher onYield must be a function');
    const coordinatorOptions = { timeoutMs, signal: dispatcher.signal, onYield: dispatcher.onYield };
    this.coordinator = new DispatchCoordinator({
      store: this.store, driver, segmentedJournalEnabled: () => segmentedJournalEnabled(this.store),
      commitEventOnly: (...args) => this.commitEventOnly(...args),
      commitYield: (...args) => this.commitYield(...args),
      commitDispatcherOutcome: (...args) => this.commitDispatcherOutcome(...args),
      retireManagedAttempt: (...args) => this.commitRetireManagedAttempt(...args),
      finalizeImmediateYield: (...args) => this.finalizeImmediateYield(...args),
      commitClaim: (...args) => this.commitClaim(...args),
      asYield, snapshot, ref, internalIdentity, validateRef,
    }, coordinatorOptions);
    // Preserve the historical in-process diagnostic shape (an own Map found
    // by host probes) while the coordinator remains the sole owner of that
    // map and all lifecycle mutations.
    Object.defineProperty(this, 'activeDispatches', {
      value: this.coordinator.activeDispatches,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  private managedEnabled(generation: number): boolean {
    return managedAdmissionAllowed(this.#managedCapability ? { capability: this.#managedCapability, generation, killSwitch: this.#managedKillSwitch } : undefined, generation, this.#managedKillSwitch);
  }

  private managedRuntimeEnabled(): boolean {
    return Boolean(this.#managedCapability && !this.#managedKillSwitch && (!this.#managedRolloutPolicy || this.#managedRolloutDecision?.admitted));
  }

  private safeMetric(name: import('./metrics.js').AccelerationCounter): void {
    try { this.metrics.increment(name); } catch { /* diagnostics never affect execution */ }
  }

  private prepareManagedState(state: MachineState, generation: number, input: AdvanceInput, lease?: import('./store.js').PublicationLease): MachineState {
    if (!this.#managedCapability || !this.managedEnabled(generation)) return state;
    if (state.schema === 2 && state.managed) {
      const persisted = state.managed.capability;
      if (!verifyManagedCapability(persisted) || persisted.checksum !== this.#managedCapability.checksum || state.managed.killSwitch) throw new Conflict('managed capability unavailable');
    }
    let next = migrateMachineState(state, this.#managedCapability);
    if (this.#managedRolloutPolicy) next = applyManagedRolloutPolicy(next, this.#managedCapability, this.#managedRolloutPolicy);
    if (input.event.kind === 'START' && !next.managed!.proposal) {
      const key = digest({ runId: String(input.runId), phaseId: next.phaseId, authorshipInputDigest: input.event.intentRef.digest, decisionKey: 'START' });
      const leaseSetId = lease?.leaseId ?? `lease-${key.slice(0, 32)}`;
      if (!lease) throw new Conflict('managed graph lease root is unavailable');
      assertManagedGraph({
        proposal: { leaseSetId, waveRef: input.event.intentRef },
        leaseSets: { [leaseSetId]: { leaseId: leaseSetId, closedRefGraph: lease.refs } },
      });
      next = bindManagedProposal(next, this.#managedCapability, { key: key as import('./model.js').Sha256, waveRef: input.event.intentRef, ...(this.options.managedRollout?.wave ? { roleWaveRef: this.options.managedRollout.wave } : {}), planDigest: next.planDigest, leaseSetId });
      if (lease) next.managed!.leaseSets[lease.leaseId] = { leaseId: lease.leaseId, closedRefGraph: lease.refs.map((ref) => ({ ...ref })), expiresAt: lease.expiresAt, status: lease.status };
    } else applyManagedReservations(next, this.#managedCapability);
    return next;
  }

  /** Prepare one bounded publication lease for a managed parent decision.
   * Acquisition is deliberately side-effect-only at the lease layer; the
   * token, journal, prefix, and proposal mutate only in the subsequent state
   * CAS through applyParentDecision. */
  private async prepareDecisionPublication(state: MachineState, token: string, value: unknown): Promise<PreparedDecisionPublication | undefined> {
    if (!state.managed || !Object.prototype.hasOwnProperty.call(state.decisionTokens, token)) return undefined;
    const record = state.decisionTokens[token];
    if (!record || (record.kind !== 'DELIBERATION_SELECTION' && record.kind !== 'DELIBERATION') || record.consumed) return undefined;
    const requested = typeof value === 'string' ? { disposition: value } : value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const disposition = typeof requested.disposition === 'string' ? requested.disposition : typeof requested.kind === 'string' ? requested.kind : typeof requested.decision === 'string' ? requested.decision : undefined;
    if (!disposition || !['SELECTION', 'SYNTHESIS', 'WIDEN', 'NO_SETTLEMENT'].includes(disposition)) throw new Conflict('unsupported deliberation decision');
    if (disposition === 'NO_SETTLEMENT') return undefined;
    const binding = validateManagedDecisionBinding(state, token, value);
    if (!binding) throw new Conflict('full canonical deliberation result or settlement binding is invalid');
    const requestedSettlement = Object.prototype.hasOwnProperty.call(requested, 'nullableSettlement')
      ? requested.nullableSettlement
      : Object.prototype.hasOwnProperty.call(requested, 'settlementRef')
        ? requested.settlementRef
        : Object.prototype.hasOwnProperty.call(requested, 'settlement')
          ? requested.settlement
          : requested.settlementDigest;
    const fullRef = (candidate: unknown): candidate is Ref => {
      try { validateRef(candidate as Ref); } catch { return false; }
      return typeof (candidate as Ref).bytes === 'string' && typeof (candidate as Ref).scope === 'string' && String((candidate as Ref).scope).startsWith('deliberation/settlement');
    };
    let settlementRef: Ref | null = null;
    if (disposition === 'WIDEN') {
      if (!Object.prototype.hasOwnProperty.call(requested, 'nullableSettlement') || requestedSettlement !== null) throw new Conflict('WIDEN requires explicit null settlement');
      if (!binding.successorWaveRef) throw new Conflict('WIDEN requires an exact Explore successor');
    } else {
      if (!fullRef(requestedSettlement) || !binding.settlementRef) throw new Conflict('selection/synthesis requires a full settlement ref');
      settlementRef = { ...(binding.settlementRef as Ref) };
    }
    const resultObject = requested.result && typeof requested.result === 'object' && !Array.isArray(requested.result) ? requested.result as Record<string, unknown> : undefined;
    const successor = binding.successorWaveRef ?? requested.nextWaveRef ?? requested.successorWaveRef ?? resultObject?.wave;
    const authorityAnchors: Ref[] = [];
    for (const reportRef of record.orderedReportRefs ?? []) {
      const row = state.managed.acceptedReports?.[reportRef.digest];
      if (row?.roleDigest) {
        if (!row.authorityAnchor) throw new Conflict('accepted Report authority anchor is missing');
        authorityAnchors.push({ ...row.authorityAnchor });
      }
    }
    const closure: Ref[] = [{ ...(record.waveRef as Ref) }, ...((record.orderedReportRefs ?? []).map((item) => ({ ...item }))), ...authorityAnchors];
    if (settlementRef) closure.push(settlementRef);
    if (successor !== undefined) {
      try { validateRef(successor as Ref); } catch { throw new Conflict('successor Wave Ref is malformed'); }
      if (typeof (successor as Ref).bytes !== 'string') throw new Conflict('successor Wave Ref requires canonical bytes');
      closure.push({ ...(successor as Ref) });
    }
    const uniqueClosure = [...new Map(closure.map((item) => [canonicalString(item), item])).values()];
    // The lease identity is derived from the exact normalized result admitted
    // by the shared reducer preflight, not from an optional/aliased caller
    // payload.  This keeps the pre-publication root deterministic and makes a
    // replay with a differently-spelled result fail closed at the binding seam.
    const resultDigest = digest(binding.result ?? null);
    const leaseId = `decision-lease-${digest({ runId: state.runId, token, predecessorGeneration: record.predecessorGeneration, disposition, settlementDigest: settlementRef?.digest ?? null, resultDigest }).slice(0, 32)}`;
    const acquire = this.store.acquirePublicationLease;
    if (!acquire) throw new Conflict('managed publication lease unavailable');
    let lease: import('./store.js').PublicationLease;
    try { lease = await acquire.call(this.store, leaseId, uniqueClosure); }
    catch { throw new Conflict('managed publication lease unavailable'); }
    if (lease.leaseId !== leaseId || lease.status === 'EXPIRED' || canonicalString(lease.refs) !== canonicalString(uniqueClosure)) throw new Conflict('managed publication lease closure mismatch');
    return { disposition: disposition as 'SELECTION' | 'SYNTHESIS' | 'WIDEN', settlementRef, lease };
  }



  async advance(input: AdvanceInput): Promise<Yield> {
    validateIdentity(input);
    // P2 policy is a private, default-off shadow seam.  It must be called
    // before any managed plan/frame resolution and is intentionally unable to
    // affect the ordinary reducer, store, or returned Yield.  OFF returns
    // before inspecting policy, refs, or computing an identity digest.
    const zeroDigest = '0000000000000000000000000000000000000000000000000000000000000000' as import('./model.js').Sha256;
    const shadowRef: Ref = { id: 'shadow', digest: zeroDigest, scope: 'shadow' };
    shadowPolicy({
      authorship: {
        runId: String(input.runId), phaseId: String(input.identity.phaseId),
        intent: input.event.kind === 'START' ? input.event.intentRef : shadowRef,
        evidenceSnapshot: shadowRef, authorityDigest: zeroDigest, policyVersion: shadowRef, settlements: [],
      },
      predicates: { decisionUnsettled: false, explicitExplore: false, citedWitness: false, planEquivalent: false, containedDiscovery: false, openEnded: false, highStakes: false, openlyPhrased: false, namedDiscriminator: false },
      mode: 'OFF',
    });
    let loaded;
    try { loaded = await this.store.load(); }
    catch (error) {
      const message = (error as Error).message;
      if (message.includes('ManifestMismatch') || message.includes('ENOENT')) throw new KernelError('ManifestMismatch', message);
      throw error;
    }
    let current = loaded.state;
    if (current && current.runId !== String(input.runId)) throw new Conflict('runId does not match CURRENT');
    // Rollout policy changes share the existing generation CAS. Exact replay
    // is inert; promotion or rollback must carry a strictly newer generation.
    if (current?.schema === 2 && current.managed && this.#managedCapability && this.#managedRolloutPolicy) {
      let synced: MachineState;
      try { synced = applyManagedRolloutPolicy(current, this.#managedCapability, this.#managedRolloutPolicy); }
      catch { return asYield(current, { outcome: 'BLOCKED', reason: 'managed rollout policy conflict' }); }
      if (canonicalString(synced.managed?.rollout) !== canonicalString(current.managed.rollout)) {
        try {
          const policyIdentity: EventIdentity = {
            runId: current.runId, phaseId: current.phaseId, stepId: 'run',
            attemptEpoch: current.attemptEpoch, authorityEpoch: current.authorityEpoch, barrierEpoch: current.barrierEpoch,
            eventId: `managed-rollout:${this.#managedRolloutPolicy.generation}:${this.#managedRolloutPolicy.digest.slice(0, 16)}`,
            payloadDigest: this.#managedRolloutPolicy.digest,
          };
          synced.writerFence = nextWriterFence(current.writerFence, loaded.generation + 1, policyIdentity);
          const generation = await this.store.commit(loaded.generation, synced);
          loaded = { state: synced, generation };
          current = synced;
        } catch (error) { throw mapCommitFailure(error); }
      }
    }
    // Schema-1 runs remain readable by default.  A managed opt-in atomically
    // lifts the committed projection before any managed admission; a failed
    // migration leaves the legacy state untouched and closes the capability.
    if (current && this.managedRuntimeEnabled() && current.schema === 1) {
      const migrated = migrateMachineState(current, this.#managedCapability);
      try {
        const generation = await this.store.commit(loaded.generation, migrated);
        loaded = { state: migrated, generation };
        current = migrated;
      } catch (error) {
        throw mapCommitFailure(error);
      }
    }
    // Schema-2 is an explicitly managed projection.  It cannot silently
    // fall back to the ordinary path: a restart must present the same
    // authenticated descriptor with the kill switch clear, otherwise no
    // managed CAS or downstream work is admitted.
    if (current?.schema === 2 && current.managed) {
      const persisted = current.managed.capability;
      const sameCapability = Boolean(this.#managedCapability && verifyManagedCapability(persisted)
        && persisted.checksum === this.#managedCapability.checksum);
      const rolloutAvailable = !current.managed.rollout || Boolean(this.#managedRolloutPolicy && this.#managedRolloutDecision?.admitted
        && current.managed.rollout.generation === this.#managedRolloutPolicy.generation
        && current.managed.rollout.digest === this.#managedRolloutPolicy.digest
        && current.managed.rollout.mode === this.#managedRolloutPolicy.mode);
      if (!sameCapability || !rolloutAvailable || this.#managedKillSwitch || current.managed.killSwitch) {
        return asYield(current, { outcome: 'BLOCKED', reason: 'managed capability unavailable' });
      }
    }
    if (!current && input.event.kind === 'START' && (input.identity.attemptEpoch !== 0 || input.identity.authorityEpoch !== 0 || input.identity.barrierEpoch !== 0)) throw new Conflict('START must use zero epochs for a new run');
    const key = identityKey(input.identity);
    if (current) {
      const replay = classifyCommittedReplay(current, key, input.identity);
      if (replay !== undefined) return replay;
      if (input.event.kind === 'START') throw new Conflict('run already started');
      if (input.expectedRevision === undefined || input.expectedRevision !== current.revision) throw new Conflict('stale or missing expectedRevision');
      if (input.identity.authorityEpoch !== current.authorityEpoch || input.identity.attemptEpoch !== current.attemptEpoch || input.identity.barrierEpoch !== current.barrierEpoch) throw new Conflict('Superseded: epoch fence mismatch');
      if (input.identity.phaseId !== current.phaseId && input.identity.phaseId !== 'run') throw new Conflict('phase fence mismatch');
      // COMPLETE and a closed gate/barrier are sticky.  No ordinary
      // observation or resume may append journal records after finality; a
      // parent decision is the only event allowed to resolve a DUE gate.
      if (current.status === 'COMPLETE') throw new Conflict('run is complete');
      if (current.barrier === 'CLOSED' && input.event.kind !== 'PARENT_DECISION') throw new Conflict('barrier is closed');
      if (current.status === 'BLOCKED' && current.gate !== 'DUE' && input.event.kind !== 'PARENT_DECISION') throw new Conflict('run is blocked');
    }
    let plan: Plan; let recoveryAgainstCommittedPlan = false;
    try { plan = validatePlan(this.options.plan).plan; }
    catch (error) {
      // A malformed live declaration must not strand an already committed
      // outbox command.  Recovery/receipt/worker events use the plan encoded
      // by the durable state projection and suppress only new admission;
      // START or unrelated observations still fail as InvalidPlan.
      if (!current || !canReconcileWithoutLivePlan(current, input)) throw new InvalidPlan((error as Error).message);
      try { plan = validatePlan(planFromCommittedState(current)).plan; }
      catch (stateError) { throw new KernelError('ManifestMismatch', `committed plan projection is invalid: ${(stateError as Error).message}`); }
      recoveryAgainstCommittedPlan = true;
    }
    // Validation above checks graph structure; canonicalization additionally
    // rejects BigInt, functions, class instances, undefined, and other values
    // that cannot participate in a stable authority digest.  Do this before
    // any reducer/accelerator work so malformed plans are reported as a
    // boundary InvalidPlan rather than leaking a TypeError halfway through a
    // transition.
    let rawPlanDigest: string; let normalizedPlanDigest: string;
    try {
      rawPlanDigest = recoveryAgainstCommittedPlan ? current!.planDigest : digest(this.options.plan);
      normalizedPlanDigest = recoveryAgainstCommittedPlan ? current!.planDigest : digest(plan);
    }
    catch (error) { throw new InvalidPlan(`plan is not canonical JSON: ${(error as Error).message}`); }
    if (input.event.kind === 'START') {
      if (input.identity.phaseId !== 'run' && input.identity.phaseId !== plan.phaseId) throw new InvalidEvent('START identity phase does not name the supplied plan');
      // The START ref binds the caller's canonical plan artifact.  Accept the
      // raw digest used by the CLI/examples as well as the normalized digest
      // stored by the validator.  A source-bound declaration also has a
      // semantic alias (the same plan with authorityDigest omitted), allowing
      // a native parent declaration to refer to the exact candidate without
      // dropping that source binding from CURRENT.
      const acceptedPlanDigests = new Set(acceptedStartPlanDigests(this.options.plan, plan));
      if (!acceptedPlanDigests.has(input.event.intentRef.digest)) throw new InvalidEvent('START intentRef does not name the supplied plan');
    }
    if (current) {
      if (!segmentedJournalEnabled(this.store)) {
        const journalBytes = current.journal.map((entry) => canonicalString(entry)).join('\n') + (current.journal.length ? '\n' : '');
        const nextRecordBytes = canonicalString({ identity: input.identity, event: input.event, digest: digest(input.event), revision: current.revision + 1 });
        if (!Number.isSafeInteger(current.revision + 1) || !journalHasRecordBudget(current, 1) || Buffer.byteLength(journalBytes) + Buffer.byteLength(nextRecordBytes) + 1 > JOURNAL_BYTE_CEILING) {
          return asYield(current, { outcome: 'BLOCKED', reason: 'JournalCeiling' });
        }
      }
    }
    const authorityDrift = Boolean(current && !recoveryAgainstCommittedPlan && normalizedPlanDigest !== current.planDigest);

    // Parent decisions are handled before the normal authority-drift fence so
    // a previously issued, digest-bound adoption token can be acknowledged
    // against the new declaration.  Gate decisions continue to use the
    // committed plan projection when the live declaration is malformed.
    if (current && input.event.kind === 'PARENT_DECISION') {
      const tokenRecord = current.decisionTokens[input.event.token];
      if (tokenRecord?.kind === 'AUTHORITY_ADOPTION') {
        if (!authorityDrift || !isAdoptionDecision(input.event.value)) throw new Conflict('authority adoption token requires its acknowledged plan digest');
        const requestedDigest = input.event.value && typeof input.event.value === 'object' && !Array.isArray(input.event.value)
          ? (typeof (input.event.value as Record<string, unknown>).digest === 'string' ? (input.event.value as Record<string, unknown>).digest : typeof (input.event.value as Record<string, unknown>).planDigest === 'string' ? (input.event.value as Record<string, unknown>).planDigest : (input.event.value as Record<string, unknown>).authorityDigest)
          : undefined;
        // START already accepts raw and validator-normalized plan digests; the
        // adoption acknowledgement follows the same boundary while the
        // durable token stores the normalized target used by CURRENT.
        if (requestedDigest !== normalizedPlanDigest && requestedDigest !== rawPlanDigest) throw new Conflict('authority adoption digest does not match live plan');
        // Adoption is recovery-only while any old writer/effect is live.  Do
        // not consume or mark the caller event processed: the same token may
        // be retried after RESUME/receipt reconciliation.
        if (hasLiveOldWork(current)) {
          const blocked = asYield(current, { outcome: 'DECISION_REQUIRED', brief: ref(`authority:${current.revision}`, { expected: current.planDigest, actual: normalizedPlanDigest, token: input.event.token }, 'authority'), token: input.event.token });
          return blocked;
        }
        // Mutation-coupled freshness is checked at the authority-moving CAS,
        // never when the token is merely displayed.  A caller may provide the
        // sealed read-set digest alongside its adoption value; any drift is a
        // non-consuming STALE result and leaves the token live for resealing.
        const requestedObject = input.event.value && typeof input.event.value === 'object' && !Array.isArray(input.event.value) ? input.event.value as Record<string, unknown> : undefined;
        const readSet = requestedObject?.readSet ?? requestedObject?.workspaceReadSet;
        const expectedReadSet = requestedObject?.readSetDigest ?? requestedObject?.workspaceDigest;
        if (readSet !== undefined && typeof expectedReadSet === 'string' && !verifyReadSet(expectedReadSet as import('./model.js').Sha256, readSet)) {
          return asYield(current, { outcome: 'BLOCKED', reason: 'STALE' });
        }
      const adopted = applyAuthorityAdoption(current, input.identity, input.event.token, input.event.value, plan, normalizedPlanDigest as import('./model.js').Sha256, segmentedJournalEnabled(this.store));
      if (adopted.outcome === 'BLOCKED' || adopted.state === current) {
        if (adopted.reason === 'STALE') return asYield(current, adopted);
        throw new Conflict(adopted.reason ?? 'authority adoption rejected');
      }
      if (this.managedRuntimeEnabled()) adopted.state = this.prepareManagedState(adopted.state, loaded.generation, input);
      return this.commitYield(loaded.generation, adopted.state, key, input.identity, asYield(adopted.state, adopted));
      }
      // A gate decision is parent-owned and remains valid against the old
      // committed plan only when the live declaration is malformed. A valid
      // new authority must be explicitly adopted before the old gate can be
      // resolved, which creates fresh epochs/work/a fresh gate.
      if (tokenRecord?.kind === 'GATE') {
        if (authorityDrift) {
          const adoption = authorityAdoptionRequired(current, input.identity, normalizedPlanDigest);
          return this.commitYield(loaded.generation, adoption.state, key, input.identity, adoption.yield);
        }
        if (recoveryAgainstCommittedPlan) plan = validatePlan(planFromCommittedState(current)).plan;
      }
    }

    if (current && authorityDrift && input.event.kind !== 'PARENT_DECISION') {
      const priorEntry = Object.entries(current.decisionTokens).find(([, record]) => record.kind === 'AUTHORITY_ADOPTION' && !record.consumed);
      const priorToken = priorEntry?.[1];
      // The first drift observation is a no-effect diagnostic.  Once its
      // token is durable, recovery events may use the old committed plan while
      // the parent decides whether/how to adopt the new one.
      if (isOldWorkEvent(current, input) && (priorToken || input.event.kind !== 'RESUME')) {
        plan = validatePlan(planFromCommittedState(current)).plan;
        recoveryAgainstCommittedPlan = true;
        rawPlanDigest = current.planDigest;
        normalizedPlanDigest = current.planDigest;
      } else {
        const adoption = authorityAdoptionRequired(current, input.identity, normalizedPlanDigest);
        return this.commitYield(loaded.generation, adoption.state, key, input.identity, adoption.yield);
      }
    }
    // Managed admission is fail-closed before invoking the caller's
    // admission hook.  A kill switch therefore cannot leak a policy probe,
    // acquire a lease, or enter any downstream admission seam.
    const managedRequested = this.#managedRolloutPolicy ? Boolean(this.#managedRolloutDecision?.admitted) : Boolean(this.#managedCapability);
    if (this.#managedRolloutPolicy && this.#managedRolloutPolicy.mode !== 'disabled' && this.#managedRolloutDecision?.reason !== 'DIRECT_BYPASS' && !managedRequested) {
      return asYield(current ?? emptyState(String(input.runId), plan.phaseId), { outcome: 'BLOCKED', reason: 'managed rollout cohort refused' });
    }
    if (managedRequested && this.#managedKillSwitch) {
      return asYield(current ?? emptyState(String(input.runId), plan.phaseId), { outcome: 'BLOCKED', reason: 'managed capability unavailable' });
    }
    const claims = canonicalClaims(plan.steps);
    const admissionOk = recoveryAgainstCommittedPlan ? true : await proveAdmission(this.options.admission, { runId: String(input.runId), claims, workspace: this.options.workspace, ownership: this.options.ownership });
    // Recovery against the committed projection may reconcile the existing
    // command, but a malformed live declaration must never admit successors
    // until the caller restores the authoritative plan.  Keep the public
    // lifecycle unchanged while making the reducer capacity explicit.
    const recoveryCapacity = recoveryAgainstCommittedPlan ? 0 : this.configuredMaxInFlight;

    let managedLease: import('./store.js').PublicationLease | undefined;
    if (managedRequested && this.#managedCapability && !this.#managedKillSwitch && !current && input.event.kind === 'START') {
      // The managed lease is a closed graph root, not an assertion about a
      // caller-supplied name. Require canonical bytes before creating that
      // root; validateEvent has already proved the digest/bytes relation.
      if (typeof input.event.intentRef.bytes !== 'string') {
        return asYield(emptyState(String(input.runId), plan.phaseId), { outcome: 'BLOCKED', reason: 'managed artifact unavailable' });
      }
      const leaseId = `lease-${digest({ runId: String(input.runId), phaseId: plan.phaseId, authorshipInputDigest: input.event.intentRef.digest, decisionKey: 'START' }).slice(0, 32)}`;
      try {
        // Validate ownership/provenance before touching the store. The same
        // validator is applied again to the acquired lease and at commit.
        assertManagedGraph({ proposal: { leaseSetId: leaseId, waveRef: input.event.intentRef }, leaseSets: { [leaseId]: { leaseId, closedRefGraph: [input.event.intentRef] } } });
      } catch {
        return asYield(emptyState(String(input.runId), plan.phaseId), { outcome: 'BLOCKED', reason: 'managed graph is invalid' });
      }
      const acquire = this.store.acquirePublicationLease;
      if (!acquire) return asYield(emptyState(String(input.runId), plan.phaseId), { outcome: 'BLOCKED', reason: 'managed publication lease unavailable' });
      try {
        managedLease = await acquire.call(this.store, leaseId, [input.event.intentRef]);
        assertManagedGraph({ proposal: { leaseSetId: leaseId, waveRef: input.event.intentRef }, leaseSets: { [leaseId]: { leaseId, closedRefGraph: managedLease.refs } } });
      }
      catch { return asYield(emptyState(String(input.runId), plan.phaseId), { outcome: 'BLOCKED', reason: 'managed publication lease unavailable' }); }
    }

    if (current && input.event.kind === 'PARENT_DECISION') {
      let preparedDecision: PreparedDecisionPublication | undefined;
      if (this.managedRuntimeEnabled()) {
        preparedDecision = await this.prepareDecisionPublication(current, input.event.token, input.event.value);
      }
      const reduced = applyParentDecision(current, input.identity, input.event.token, input.event.value, segmentedJournalEnabled(this.store), preparedDecision, plan);
      if (reduced.outcome === 'BLOCKED' && reduced.state === current) {
        // NO_SETTLEMENT is a pure refusal: no native event, token consumption,
        // prefix publication, or generation CAS is allowed.  Return the
        // existing public blocked shape while leaving the live token intact.
        if (reduced.reason === 'NO_SETTLEMENT') return asYield(current, reduced);
        throw new Conflict(reduced.reason ?? 'invalid decision');
      }
      // A FINDINGS decision opens a fresh attempt.  Keep admission under the
      // same mandatory direct validator; effects still launch only on a later
      // RESUME, so this event never calls an external driver inline.
      if (reduced.outcome === 'WAITING' && reduced.state.gate === 'NOT-DUE' && reduced.state.barrier === 'OPEN' && !reduced.deferAdmission) refreshAdmission(reduced.state, plan, recoveryCapacity);
      if (this.managedRuntimeEnabled()) reduced.state = this.prepareManagedState(reduced.state, loaded.generation, input);
      return this.commitYield(loaded.generation, reduced.state, key, input.identity, asYield(reduced.state, reduced));
    }

    const hasCurrentDispatch = (command: import('./model.js').OutboxCommand): boolean => Boolean(current && commandInCurrentFrame(current, command));
    if (current && input.event.kind === 'RESUME' && Object.values(current.outbox).some((command) => (command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN') && hasCurrentDispatch(command))) {
      const command = Object.values(current.outbox).find((candidate) => (candidate.state === 'PENDING' || candidate.state === 'CLAIMED' || candidate.state === 'UNKNOWN') && hasCurrentDispatch(candidate));
      const active = command ? this.activeDispatches.get(command.launchToken) : undefined;
      const liveInProcess = Boolean(command && active && active.commandDigest === command.commandDigest && active.leaseId === command.leaseId);
      const maximumInternalRecords = command?.state === 'CLAIMED' ? (liveInProcess ? 1 : 2) : command?.state === 'UNKNOWN' ? (liveInProcess ? 1 : this.coordinator.driver?.observe ? 2 : 1) : (admissionOk && this.coordinator.driver ? 3 : 1);
      // RESUME may append dispatcher claim/recovery/receipt records in
      // addition to the caller event.  Reserve the whole transition before
      // invoking a driver so a near-ceiling run cannot perform an effect and
      // only then discover that its journal cannot represent the outcome.
      if (!segmentedJournalEnabled(this.store) && !journalHasRecordBudget(current, maximumInternalRecords)) return asYield(current, { outcome: 'BLOCKED', reason: 'JournalCeiling' });
      try {
        return await this.coordinator.resume({ generation: loaded.generation, current, input, key, plan, admissionOk, maxInFlight: recoveryCapacity });
      } catch (error) {
        if ((error as Error).message === 'JournalCeiling') return asYield(current, { outcome: 'BLOCKED', reason: 'JournalCeiling' });
        throw error;
      }
    }

    let reduced;
    try {
      reduced = reduce(current, plan, input.identity, input.event, recoveryCapacity, admissionOk, segmentedJournalEnabled(this.store));
    }
    catch (error) {
      if ((error as Error).message === 'JournalCeiling') return asYield(current ?? emptyState(String(input.runId), plan.phaseId), { outcome: 'BLOCKED', reason: 'JournalCeiling' });
      throw new InvalidEvent((error as Error).message);
    }
    if (this.managedRuntimeEnabled() && managedRequested) {
      try { reduced.state = this.prepareManagedState(reduced.state, loaded.generation, input, managedLease); }
      catch (error) { if ((error as Error).message.includes('managed proposal') || (error as Error).message.includes('managed graph')) throw new Conflict((error as Error).message); throw error; }
    }
    if (reduced.outcome === 'BLOCKED' && !reduced.state) return asYield(emptyState(String(input.runId), plan.phaseId), reduced);
    if (reduced.outcome === 'BLOCKED' && reduced.state === current && (input.event.kind === 'DISPATCH_RECEIPT' || input.event.kind === 'PARENT_DECISION')) throw new Conflict(reduced.reason ?? 'event rejected');
    return this.commitYield(loaded.generation, reduced.state, key, input.identity, asYield(reduced.state, reduced));
  }

  /** Persist a durable CLAIMED transition before the coordinator invokes a
   * driver.  The coordinator never writes this state directly: KernelImpl is
   * the sole commit facade and returns the immutable authority snapshot used
   * by the store-linearized launch fence. */
  private async commitClaim(generation: number, claimed: MachineState, claimedCommand: import('./model.js').OutboxCommand, key: string, input: AdvanceInput, waiting: Yield): Promise<{ generation: number; authority: StoreLinearizedDispatchRequest['authority'] } | { replay: Yield }> {
    this.assertManagedCas(claimed, generation);
    const managedAttempt = claimed.managed?.attempts?.[claimedCommand.commandId];
    if (managedAttempt) { managedAttempt.leaseId = claimedCommand.leaseId; managedAttempt.status = 'LIVE'; }
    claimed.writerFence = nextWriterFence(claimed.writerFence, generation + 1, input.identity);
    claimed.processed[key] = { digest: input.identity.payloadDigest, yieldBytes: canonicalString(waiting), revision: claimed.revision, identity: clone(input.identity) };
    let claimedGeneration: number;
    try { claimedGeneration = await this.store.commit(generation, claimed); }
    catch (error) {
      const mapped = mapCommitFailure(error);
      const replay = await this.recoverExactCommittedReplay(key, input.identity);
      if (replay !== undefined) return { replay };
      throw mapped;
    }
    return {
      generation: claimedGeneration,
      authority: {
        generation: claimedGeneration,
        writerFence: claimed.writerFence,
        runId: claimed.runId,
        phaseId: claimed.phaseId,
        authorityEpoch: claimed.authorityEpoch,
        attemptEpoch: claimed.attemptEpoch,
        barrierEpoch: claimed.barrierEpoch,
        modeEpoch: claimed.modeEpoch,
        command: clone(claimedCommand),
      },
    };
  }

  /** Commit the caller event without changing outbox ownership. */
  private async commitEventOnly(generation: number, current: MachineState, input: AdvanceInput, key: string, plan: Plan, capacity: number, y: Yield): Promise<Yield> {
    const next = clone(current);
    appendJournal(next, input.identity, input.event, segmentedJournalEnabled(this.store));
    refreshAdmission(next, plan, capacity);
    if (this.managedRuntimeEnabled() && this.#managedCapability) applyManagedReservations(next, this.#managedCapability);
    const rebased: Yield = y.kind === 'WAITING'
      ? asYield(next, { outcome: 'WAITING' })
      : y.kind === 'BLOCKED'
        ? { ...y, snapshot: snapshot(next) }
        : y.kind === 'DECISION_REQUIRED'
          ? { ...y, cursor: { revision: next.revision, authorityEpoch: next.authorityEpoch, attemptEpoch: next.attemptEpoch, barrierEpoch: next.barrierEpoch }, snapshot: snapshot(next) }
          : { ...y, snapshot: snapshot(next) };
    return this.commitYield(generation, next, key, input.identity, rebased);
  }

  /** Managed schema-2 transitions are admitted only while the exact
   * capability descriptor is available and the operator switch is clear.
   * This guard is deliberately placed immediately before every generation CAS
   * (including private recovery/authority CASes), rather than relying on the
   * initial START admission check. */
  private assertManagedCas(state: MachineState, generation: number): void {
    if (state.schema !== 2 || !state.managed) return;
    if (!this.#managedCapability || this.#managedKillSwitch || state.managed.killSwitch || !verifyManagedCapability(state.managed.capability) || state.managed.capability.checksum !== this.#managedCapability.checksum || !managedAdmissionAllowed({ capability: this.#managedCapability, generation, killSwitch: this.#managedKillSwitch }, generation, this.#managedKillSwitch)) throw new Conflict('managed capability unavailable');
    if (state.managed.rollout) {
      if (!this.#managedRolloutPolicy || !verifyManagedRolloutPolicy(this.#managedRolloutPolicy) || !this.#managedRolloutDecision?.admitted
        || state.managed.rollout.generation !== this.#managedRolloutPolicy.generation
        || state.managed.rollout.digest !== this.#managedRolloutPolicy.digest
        || state.managed.rollout.mode !== this.#managedRolloutPolicy.mode) throw new Conflict('managed rollout policy unavailable');
    }
  }

  private async commitRetireManagedAttempt(generation: number, current: MachineState, token: string, input: AdvanceInput, plan: Plan, capacity: number, status: 'TIMED_OUT' | 'CANCELLED' | 'FAILED' = 'TIMED_OUT'): Promise<Yield> {
    this.assertManagedCas(current, generation);
    const reduced = retireManagedAttempt(current, input.identity, token, plan, capacity, status, segmentedJournalEnabled(this.store));
    if (reduced.outcome === 'BLOCKED' || reduced.state === current) return asYield(current, reduced);
    if (this.managedRuntimeEnabled() && this.#managedCapability) applyManagedReservations(reduced.state, this.#managedCapability);
    return this.commitYield(generation, reduced.state, identityKey(input.identity), input.identity, asYield(reduced.state, reduced));
  }

  /**
   * Persist a receipt/UNKNOWN transition using the same launch-token identity
   * as the original command.  One invocation owns exactly eight private typed
   * generation-CAS retry grants after its first attempt; no external effect is
   * retried and no unrelated error is classified by message text.
   */
  private async commitDispatcherOutcome(token: string, expectedDigest: string, plan: Plan, capacity: number, receipt?: DriverReceipt, expectedLeaseId?: string, receiptLeaseId?: string, teardownEvidence?: Ref): Promise<Yield | undefined> {
    let receiptMode = receipt === undefined ? 'UNKNOWN' as const : 'RECEIPT' as const;
    let remainingTypedCasRetries = 8;
    for (;;) {
      const loaded = await this.store.load();
      const state = loaded.state;
      if (!state) return undefined;
      const command = commandForToken(state, token);
      if (!command || command.commandDigest !== expectedDigest) return undefined;
      if (receiptMode === 'RECEIPT') {
        if (!receipt) return undefined;
        if (command.state === 'ACKED') {
          const anchored = state.managed?.attempts?.[command.commandId]?.authorityAnchor;
          if (command.roleView && (!anchored || !receipt?.authorityAnchor || canonicalString(anchored) !== canonicalString(receipt.authorityAnchor))) return undefined;
          return asYield(state, { outcome: 'WAITING' });
        }
        // Observation receipts are tied to the UNKNOWN lease they were
        // started for.  Unlike a dispatch Promise's late receipt channel,
        // an observer that was delayed across a successor claim must not
        // acknowledge that newer lease or suppress its dispatch.
        if (receiptLeaseId !== undefined && command.leaseId !== receiptLeaseId) return undefined;
        // A late dispatch receipt is bound to the lease captured at launch.
        // Reject it when the same token/digest has since been reclaimed by a
        // successor, regardless of whether that successor is still PENDING or
        // already CLAIMED.
        if (expectedLeaseId !== undefined && (command.leaseId !== expectedLeaseId || command.state === 'PENDING')) return undefined;
        if (receipt.launchToken !== token || receipt.commandDigest !== expectedDigest) return undefined;
        validateRef(receipt.ref);
        if (receipt.authorityAnchor) validateRef(receipt.authorityAnchor);
        const next = clone(state); const nextCommand = commandForToken(next, token)!;
        const event: Event = { kind: 'DISPATCH_RECEIPT', ref: receiptEnvelope(nextCommand, receipt) };
        const identity = internalIdentity(next, nextCommand, `dispatcher-receipt:${token}:${next.revision + 1}`, event);
        try { this.assertManagedCas(state, loaded.generation); applyDispatchReceipt(next, identity, event); appendJournal(next, identity, event, segmentedJournalEnabled(this.store)); refreshAdmission(next, plan, capacity); if (this.managedRuntimeEnabled() && this.#managedCapability) applyManagedReservations(next, this.#managedCapability); }
        catch (error) {
          // A receipt that cannot fit is external-effect uncertainty, not a
          // reason to acknowledge an unrepresentable result.  Continue in
          // UNKNOWN mode under this invocation's same retry owner rather than
          // recursively creating a fresh budget.
          if ((error as Error).message === 'JournalCeiling') { receiptMode = 'UNKNOWN'; continue; }
          return undefined;
        }
        next.writerFence = nextWriterFence(next.writerFence, loaded.generation + 1, identity);
        try { await this.store.commit(loaded.generation, next); }
        catch (error) {
          if (isStoreGenerationConflict(error) && remainingTypedCasRetries > 0) { remainingTypedCasRetries -= 1; continue; }
          return undefined;
        }
        return asYield(next, { outcome: 'WAITING' });
      }
      // A different owner may have already reconciled this attempt.  Only the
      // task that actually commits CLAIMED -> UNKNOWN owns the blocked result;
      // otherwise a stale/cancelled launcher could overwrite its durable
      // WAITING replay after a matching receipt has already ACKED the command.
      if (command.state === 'ACKED' || command.state === 'UNKNOWN') return undefined;
      if (command.state !== 'CLAIMED' || typeof expectedLeaseId !== 'string' || command.leaseId !== expectedLeaseId) return undefined;
      const next = clone(state); const nextCommand = commandForToken(next, token)!;
      if (nextCommand.roleView) {
        if (!teardownEvidence) return undefined;
        try { validateRef(teardownEvidence); } catch { return undefined; }
        if (teardownEvidence.scope !== 'outbox/teardown') return undefined;
        nextCommand.noEffectEvidence = [...(nextCommand.noEffectEvidence ?? []), clone(teardownEvidence)];
      }
      unknown(nextCommand);
      this.assertManagedCas(state, loaded.generation);
      const unknownAttempt = next.managed?.attempts?.[nextCommand.commandId];
      if (unknownAttempt && (unknownAttempt.status === 'LIVE' || unknownAttempt.status === 'UNKNOWN')) unknownAttempt.status = 'UNKNOWN';
      const evidence: Ref = ref(`unknown:${token}`, { launchToken: token, commandDigest: expectedDigest, status: 'UNKNOWN' }, 'outbox/recovery');
      const event: Event = { kind: 'OBSERVATION', category: 'RECOVERY', ref: evidence };
      const identity = internalIdentity(next, nextCommand, `dispatcher-unknown:${token}:${next.revision + 1}`, event);
      appendJournal(next, identity, event, segmentedJournalEnabled(this.store)); refreshAdmission(next, plan, capacity); if (this.managedRuntimeEnabled() && this.#managedCapability) applyManagedReservations(next, this.#managedCapability);
      next.writerFence = nextWriterFence(next.writerFence, loaded.generation + 1, identity);
      try { await this.store.commit(loaded.generation, next); }
      catch (error) {
        if (isStoreGenerationConflict(error) && remainingTypedCasRetries > 0) { remainingTypedCasRetries -= 1; continue; }
        return undefined;
      }
      return asYield(next, { outcome: 'BLOCKED', reason: 'UnknownDispatch', launchToken: token });
    }
  }

  /** A synchronous test/compatibility driver can complete before RESUME
   * returns.  Replace that caller's processed yield with the final receipt
   * yield so exact duplicate identities still return byte-identical data. */
  private async finalizeImmediateYield(key: string, identity: EventIdentity, value: Yield): Promise<Yield | undefined> {
    const replay = async (): Promise<Yield | undefined> => {
      const current = await this.store.load();
      return current.state ? readExactProcessedReplay(current.state, key, identity) : undefined;
    };
    try {
      const loaded = await this.store.load();
      if (!loaded.state || !readExactProcessedReplay(loaded.state, key, identity)) return undefined;
      const next = clone(loaded.state);
      next.processed[key] = { digest: identity.payloadDigest, yieldBytes: canonicalString(value), revision: next.revision, identity: clone(identity) };
      next.writerFence = nextWriterFence(next.writerFence, loaded.generation + 1, identity);
      await this.store.commit(loaded.generation, next);
      return value;
    } catch {
      // A CAS winner (or a release error after publication) owns replay. Never
      // return newly computed bytes unless those exact bytes were committed.
      try { return await replay(); }
      catch { return undefined; }
    }
  }

  /** One read-only arm for a caller CAS/release failure. A failed recovery
   * load or malformed processed bytes are ordinary misses: the original
   * mapped commit error remains authoritative. */
  private async recoverExactCommittedReplay(key: string, identity: EventIdentity): Promise<Yield | undefined> {
    try {
      const loaded = await this.store.load();
      return loaded.state ? readExactProcessedReplay(loaded.state, key, identity) : undefined;
    } catch { return undefined; }
  }

  /** Reconcile the private leaseSet status after its publication row has
   * crossed the store's ACTIVE-to-PROMOTED boundary. This bounded, no-journal
   * CAS may lose a race; the next recovery/commit can retry convergence. */
  private async convergeManagedLeasePromotion(leaseSetId: string, identity: EventIdentity): Promise<boolean> {
    try {
      const loaded = await this.store.load();
      const current = loaded.state;
      const leaseSet = current?.schema === 2 ? current.managed?.leaseSets[leaseSetId] : undefined;
      if (!current || !leaseSet) return false;
      if (leaseSet.status !== 'ACTIVE') return leaseSet.status === 'PROMOTED';
      const next = clone(current);
      next.managed!.leaseSets[leaseSetId]!.status = 'PROMOTED';
      // This is still a managed authority CAS (even though it carries no
      // public event), so the capability generation and operator gate must be
      // checked at the last possible moment just like every other write.
      this.assertManagedCas(current, loaded.generation);
      next.writerFence = nextWriterFence(current.writerFence, loaded.generation + 1, identity);
      await this.store.commit(loaded.generation, next);
      return true;
    } catch {
      // The durable publication row remains bounded if this reconciliation
      // loses a CAS race or the store is temporarily unavailable.
      return false;
    }
  }

  private async commitYield(generation: number, state: MachineState, key: string, identity: EventIdentity, y: Yield): Promise<Yield> {
    const next = state === undefined ? state : clone(state);
    if (!next) return y;
    this.assertManagedCas(next, generation);
    // Every durable event gets a unique writer fence.  It is private state,
    next.writerFence = nextWriterFence(state.writerFence, generation + 1, identity);
    next.processed[key] = { digest: identity.payloadDigest, yieldBytes: canonicalString(y), revision: next.revision, identity: clone(identity) };
    try { await this.store.commit(generation, next); }
    catch (error) {
      const mapped = mapCommitFailure(error);
      const replay = await this.recoverExactCommittedReplay(key, identity);
      if (replay !== undefined) return replay;
      throw mapped;
    }
    // Promotion follows the authoritative CURRENT CAS.  A crash in this
    // small post-commit window leaves a bounded lease root, never an
    // unpinned authoritative Ref; restart/recovery can safely re-promote it.
    const leaseIds = new Set<string>();
    if (next.managed?.proposal?.leaseSetId) leaseIds.add(next.managed.proposal.leaseSetId);
    for (const record of Object.values(next.decisionTokens)) if (record.consumed && record.publicationLeaseSetId) leaseIds.add(record.publicationLeaseSetId);
    for (const leaseSetId of leaseIds) if (this.store.promotePublicationLease) {
      try {
        const promoted = await this.store.promotePublicationLease(leaseSetId);
        if (promoted.status === 'PROMOTED' && await this.convergeManagedLeasePromotion(leaseSetId, identity)) {
          // Once CURRENT owns the closed graph, the temporary publication row
          // has served its purpose and can be released. A crash before this
          // call leaves a bounded PROMOTED row for deterministic recovery.
          if (this.store.releasePublicationLease) await this.store.releasePublicationLease(leaseSetId);
        }
      }
      catch { /* lease remains bounded and is never treated as authority */ }
    }
    return y;
  }
}

export function makeRunKernel(options: KernelOptions): RunKernel {
  const configuredMaxInFlight = validateKernelOptions(options);
  return new KernelImpl(options, configuredMaxInFlight, storeForRoot(options.rootDir));
}

/** Private bridge constructor.  The package root intentionally exports only
 * makeRunKernel; the bridge passes the inode identity it held while locking
 * the run root so the public kernel cannot silently follow a replaced path. */
export function makeRunKernelForBridge(options: KernelOptions, expectedRootIdentity: FilesystemIdentity): RunKernel {
  const configuredMaxInFlight = validateKernelOptions(options);
  return new KernelImpl(options, configuredMaxInFlight, storeForRoot(options.rootDir, expectedRootIdentity));
}

/** Private composition entry; intentionally not re-exported from the package index. */
export function makeComposedKernel(options: KernelOptions, driver?: EffectDriver, dispatcher?: DispatcherOptions): RunKernel {
  const configuredMaxInFlight = validateKernelOptions(options);
  let snapshot: DispatchDriverSnapshot | undefined;
  if (driver !== undefined) {
    if (!driver || typeof driver !== 'object') throw new InvalidPlan('driver is invalid');
    const prepare = driver.prepare;
    const dispatch = driver.dispatch;
    const observe = driver.observe;
    const observeTeardown = driver.observeTeardown;
    if ((prepare !== undefined && typeof prepare !== 'function') || typeof dispatch !== 'function' || (observe !== undefined && typeof observe !== 'function') || (observeTeardown !== undefined && typeof observeTeardown !== 'function')) throw new InvalidPlan('driver is invalid');
    snapshot = { receiver: driver, prepare, dispatch, observe, observeTeardown };
  }
  return new KernelImpl(options, configuredMaxInFlight, storeForRoot(options.rootDir), snapshot, dispatcher);
}

/** Private bridge composition entry.  The bridge holds the run-root identity
 * while it owns its operation lock; binding that identity here prevents a
 * composed dispatcher from silently following a renamed/replaced root.  This
 * is intentionally not exported from the package root or composition
 * subpath: hosts receive only the existing RunKernel seam. */
export function makeComposedKernelForBridge(options: KernelOptions, expectedRootIdentity: FilesystemIdentity, driver?: EffectDriver, dispatcher?: DispatcherOptions): RunKernel {
  const configuredMaxInFlight = validateKernelOptions(options);
  let snapshot: DispatchDriverSnapshot | undefined;
  if (driver !== undefined) {
    if (!driver || typeof driver !== 'object') throw new InvalidPlan('driver is invalid');
    const prepare = driver.prepare;
    const dispatch = driver.dispatch;
    const observe = driver.observe;
    const observeTeardown = driver.observeTeardown;
    if ((prepare !== undefined && typeof prepare !== 'function') || typeof dispatch !== 'function' || (observe !== undefined && typeof observe !== 'function') || (observeTeardown !== undefined && typeof observeTeardown !== 'function')) throw new InvalidPlan('driver is invalid');
    snapshot = { receiver: driver, prepare, dispatch, observe, observeTeardown };
  }
  return new KernelImpl(options, configuredMaxInFlight, storeForRoot(options.rootDir, expectedRootIdentity), snapshot, dispatcher);
}
