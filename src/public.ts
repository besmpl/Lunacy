import { digest, canonicalString, identityKey, parseCanonical } from './canonical.js';
import { canonicalClaims, proveAdmission } from './admission.js';
import { appendJournal, applyAuthorityAdoption, applyDispatchReceipt, applyParentDecision, commandForToken, nextWriterFence, previewReduce, reduce, refreshAdmission, type PreparedAdmission } from './reducer.js';
import { claim, unknown, type DriverReceipt } from './outbox.js';
import { ProseDriver, type EffectDriver } from './driver.js';
import { isStoreGenerationConflict, storeForRoot, type ArtifactStore, type StoreLinearizedDispatchRequest } from './store.js';
import type { FilesystemIdentity } from './filesystem.js';
import { validatePlan } from './validator.js';
import { ContextCompiler, publishPreparedContext, type CompilerMode, type PreparedContext } from './compiler.js';
import { DispatchCoordinator, type DispatchDriverSnapshot, type ActiveDispatchTask } from './dispatch-coordinator.js';
import { GraphAcceleration, type GraphMode } from './graph.js';
import { AccelerationMetrics, defaultMetrics } from './metrics.js';
import { JOURNAL_BYTE_CEILING, JOURNAL_EVENT_CEILING } from './limits.js';
import type { CellHandle, SnapshotHandle } from './reuse.js';
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
  /** Composition-time acceleration switches. They never add lifecycle methods or authority. */
  acceleration?: {
    graph?: GraphMode;
    context?: CompilerMode;
    reuse?: CompilerMode;
    metrics?: AccelerationMetrics;
    /** Optional root-owned handles; callers cannot manufacture a cache lifecycle. */
    cell?: CellHandle | null;
    snapshot?: SnapshotHandle | null;
  };
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
  const maxInFlight = options.maxInFlight;
  if (maxInFlight !== undefined && (!Number.isSafeInteger(maxInFlight) || maxInFlight < 0)) throw new InvalidPlan('maxInFlight must be a non-negative safe integer');
  const configuredMaxInFlight = maxInFlight ?? 1;
  const acceleration = options.acceleration;
  if (!acceleration) return configuredMaxInFlight;
  if (acceleration.metrics !== undefined && (!acceleration.metrics || typeof acceleration.metrics !== 'object' || typeof acceleration.metrics.increment !== 'function' || typeof acceleration.metrics.snapshot !== 'function')) throw new InvalidPlan('acceleration metrics are invalid');
  for (const [name, mode] of Object.entries({ graph: acceleration.graph, context: acceleration.context, reuse: acceleration.reuse })) {
    if (mode !== undefined && mode !== 'OFF' && mode !== 'SHADOW' && mode !== 'ON') throw new InvalidPlan(`${name} acceleration mode is invalid`);
  }
  return configuredMaxInFlight;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function ref(id: string, value: unknown, scope = 'kernel'): Ref { const bytes = canonicalString(value); return { id, scope, digest: digest(value), bytes }; }
function snapshot(state: MachineState): CompactSnapshot {
  const steps = Object.values(state.steps); const outbox = Object.values(state.outbox);
  return { revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, runStatus: state.status, phase: state.phaseId, gate: state.gate, barrier: state.barrier, readyCount: steps.filter((s) => s.status === 'READY').length, activeCount: steps.filter((s) => s.status === 'ACTIVE').length, pendingDispatchCount: outbox.filter((x) => x.state === 'PENDING' || x.state === 'CLAIMED').length, unknownDispatchCount: outbox.filter((x) => x.state === 'UNKNOWN').length, nextAction: state.nextAction };
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
    const code = reason === 'CrossRunUnproven' ? 'CrossRunUnproven' : reason === 'UnknownDispatch' ? 'UnknownDispatch' : reason === 'HumanReceiptRequired' ? 'HumanReceiptRequired' : reason === 'ManifestMismatch' ? 'ManifestMismatch' : reason === 'JournalCeiling' ? 'JournalCeiling' : 'InvalidEvent';
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
      if (typeof workerRef.bytes !== 'string') throw new InvalidEvent('worker envelope requires canonical result bytes');
      try {
        const result = JSON.parse(workerRef.bytes) as Record<string, unknown>;
        if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.status !== 'string' || Object.keys(result).some((key) => key !== 'status')) throw new Error('invalid worker result');
      } catch { throw new InvalidEvent('worker envelope result is malformed'); }
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
  if (input.event.kind === 'RESUME') return commands.some((command) => command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN');
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
  const value = { launchToken: command.launchToken, commandDigest: command.commandDigest, receipt: receipt.ref };
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

class KernelImpl implements RunKernel {
  private readonly configuredMaxInFlight: number;
  private readonly metrics: AccelerationMetrics;
  readonly #contextMode: CompilerMode;
  readonly #compiler: ContextCompiler;
  readonly #graphMode: GraphMode;
  readonly #graph: GraphAcceleration;
  /** In-process dispatch state is owned by the private coordinator.  These
   * compatibility views are intentionally non-authoritative diagnostics. */
  private readonly coordinator: DispatchCoordinator;
  get activeDispatches(): Map<string, ActiveDispatchTask> { return this.coordinator.activeDispatches; }
  get dispatchOptions(): DispatchCoordinator['options'] { return this.coordinator.dispatchOptions; }

  constructor(private readonly options: KernelOptions, configuredMaxInFlight: number, private readonly store: ArtifactStore, driver?: DispatchDriverSnapshot, dispatcher: DispatcherOptions = {}) {
    this.configuredMaxInFlight = configuredMaxInFlight;
    this.metrics = options.acceleration?.metrics ?? defaultMetrics;
    this.#contextMode = options.acceleration?.context ?? 'OFF';
    this.#compiler = new ContextCompiler({ mode: this.#contextMode, reuseMode: options.acceleration?.reuse ?? 'OFF', metrics: this.metrics, store });
    this.#graphMode = options.acceleration?.graph ?? 'OFF';
    this.#graph = new GraphAcceleration(this.#graphMode, this.metrics);
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

  async #prepareContext(plan: Plan, current: MachineState | undefined, input: AdvanceInput, generation: number): Promise<PreparedContext | undefined> {
    if (this.#contextMode === 'OFF') return undefined;
    // The compiler is intentionally called only after duplicate/event/plan
    // checks. Its output is stable-prefix material only; reducer/CURRENT remain
    // authoritative and this method never mutates state.
    const proof = {
      runId: String(input.runId), authorityDigest: digest(plan), authorityEpoch: current?.authorityEpoch ?? 0,
      generation, revision: current?.revision ?? 0, stateDigest: current ? digest(current) : undefined,
      attemptEpoch: current?.attemptEpoch ?? 0, barrierEpoch: current?.barrierEpoch ?? 0,
      modeEpoch: current?.modeEpoch ?? 0,
      // The proof names the exact writer fence expected on the target
      // generation, not merely the pre-call fence.  This makes a delayed
      // pre-CAS writer fail closed even when another writer reaches the same
      // generation number first.
      writerFence: nextWriterFence(current?.writerFence ?? 'none', generation + 1, input.identity),
    };
    const snapshotDigest = this.options.acceleration?.snapshot
      ? digest(this.options.acceleration.snapshot)
      : digest({ runId: proof.runId, generation, revision: proof.revision });
    const sources = plan.steps.map((step) => ({ id: step.stepId, scope: 'plan', digest: digest(step) }));
    const cell = this.options.acceleration?.cell ?? null;
    try {
      return await this.#compiler.prepare({
        proof, scope: { tenant: cell?.tuple.tenant, principal: cell?.tuple.principal, workspace: cell?.tuple.workspace ?? this.options.workspace, sensitivity: cell?.tuple.sensitivity ?? 'RUN_PRIVATE', accessEpoch: cell?.tuple.accessEpoch, policyEpoch: cell?.tuple.policyEpoch }, sources,
        kind: 'BASE', derivation: { id: 'run-kernel', version: '1', schema: 'context-base/v1' },
        dynamicTail: { bytes: canonicalString(input.event), eventId: String(input.identity.eventId), snapshotDigest },
        cell,
        snapshot: this.options.acceleration?.snapshot ?? null,
        build: (stable) => canonicalString(stable),
      });
    } catch { /* a private accelerator failure is an ordinary cold path */ return undefined; }
  }

  #prepareGraph(plan: Plan, current: MachineState | undefined, postState: MachineState, input: AdvanceInput, generation: number): PreparedAdmission | undefined {
    if (this.#graphMode === 'OFF') return undefined;
    try {
      const prepared = this.#graph.prepare({
        runId: String(input.runId), plan, state: postState, generation,
        journalEnd: postState.journal.length, journalDigest: digest(postState.journal), authorityDigest: digest(plan), authorityEpoch: postState.authorityEpoch,
        maxInFlight: this.configuredMaxInFlight,
        postEvent: { baseState: current, baseGeneration: generation, baseJournalEnd: current?.journal.length ?? 0, baseJournalDigest: digest(current?.journal ?? []), identity: input.identity },
      });
      // SHADOW must never alter admission; it is intentionally a diagnostic
      // compile/verify pass only.
      if (this.#graphMode !== 'ON') return undefined;
      if (prepared.diagnostics.fallback || !prepared.candidates.length) return prepared.diagnostics.fallback ? undefined : {
        candidateIds: [], planDigest: prepared.boundGraph.planDigest, graphDigest: prepared.freshness.graphDigest, generation: prepared.freshness.generation,
        baseStateDigest: prepared.freshness.baseStateDigest, baseRevision: prepared.freshness.baseRevision, baseJournalEnd: prepared.freshness.baseJournalEnd, baseJournalDigest: prepared.freshness.baseJournalDigest,
        postStateDigest: prepared.freshness.stateDigest ?? digest(postState), postRevision: prepared.freshness.revision, postJournalEnd: prepared.freshness.postJournalEnd, postJournalDigest: prepared.freshness.postJournalDigest,
        frontierIds: prepared.frontierIds, authorityEpoch: prepared.freshness.authorityEpoch, attemptEpoch: prepared.freshness.attemptEpoch, barrierEpoch: prepared.freshness.barrierEpoch, modeEpoch: prepared.freshness.modeEpoch, writerFence: prepared.freshness.writerFence, completeFrontierDigest: prepared.freshness.completeFrontierDigest,
      };
      return {
        candidateIds: prepared.candidates.map((candidate) => candidate.nodeId), planDigest: prepared.boundGraph.planDigest, graphDigest: prepared.freshness.graphDigest, generation: prepared.freshness.generation,
        baseStateDigest: prepared.freshness.baseStateDigest, baseRevision: prepared.freshness.baseRevision, baseJournalEnd: prepared.freshness.baseJournalEnd, baseJournalDigest: prepared.freshness.baseJournalDigest,
        postStateDigest: prepared.freshness.stateDigest ?? digest(postState), postRevision: prepared.freshness.revision, postJournalEnd: prepared.freshness.postJournalEnd, postJournalDigest: prepared.freshness.postJournalDigest,
        frontierIds: prepared.frontierIds, authorityEpoch: prepared.freshness.authorityEpoch, attemptEpoch: prepared.freshness.attemptEpoch, barrierEpoch: prepared.freshness.barrierEpoch, modeEpoch: prepared.freshness.modeEpoch, writerFence: prepared.freshness.writerFence, completeFrontierDigest: prepared.freshness.completeFrontierDigest,
      };
    } catch { /* direct mandatory evaluator remains authoritative */ return undefined; }
  }

  async advance(input: AdvanceInput): Promise<Yield> {
    validateIdentity(input);
    let loaded;
    try { loaded = await this.store.load(); }
    catch (error) {
      const message = (error as Error).message;
      if (message.includes('ManifestMismatch') || message.includes('ENOENT')) throw new KernelError('ManifestMismatch', message);
      throw error;
    }
    const current = loaded.state;
    if (current && current.runId !== String(input.runId)) throw new Conflict('runId does not match CURRENT');
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
        const adopted = applyAuthorityAdoption(current, input.identity, input.event.token, input.event.value, plan, normalizedPlanDigest as import('./model.js').Sha256, segmentedJournalEnabled(this.store));
        if (adopted.outcome === 'BLOCKED' || adopted.state === current) throw new Conflict(adopted.reason ?? 'authority adoption rejected');
        return this.commitYield(loaded.generation, adopted.state, key, input.identity, asYield(adopted.state, adopted));
      }
      // A gate decision is parent-owned and remains valid against the old
      // committed plan even if declarations changed after the gate closed.
      if (tokenRecord?.kind === 'GATE') {
        plan = recoveryAgainstCommittedPlan || authorityDrift ? validatePlan(planFromCommittedState(current)).plan : plan;
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
        const blockedState = clone(current);
        let token: string;
        if (priorToken && priorToken.targetDigest === normalizedPlanDigest && priorToken.observedDigest === normalizedPlanDigest) {
          token = priorEntry![0];
        } else {
          // A newer explicit observation supersedes an unconsumed candidate.
          // Consume the old token before publishing the new one so a delayed
          // B acknowledgement can never adopt after the source has moved to C.
          if (priorEntry) blockedState.decisionTokens[priorEntry[0]]!.consumed = true;
          token = `authority-${current.revision}-${normalizedPlanDigest.slice(0, 16)}`;
          let suffix = 1;
          while (Object.prototype.hasOwnProperty.call(blockedState.decisionTokens, token)) token = `authority-${current.revision}-${normalizedPlanDigest.slice(0, 16)}-${suffix++}`;
          blockedState.decisionTokens[token] = { kind: 'AUTHORITY_ADOPTION', consumed: false, identity: digest(input.identity), expectedDigest: current.planDigest, observedDigest: normalizedPlanDigest, targetDigest: normalizedPlanDigest };
        }
        const blocked: Yield = { kind: 'DECISION_REQUIRED', brief: ref(`authority:${current.revision}`, { expected: current.planDigest, actual: normalizedPlanDigest, token }, 'authority'), token, cursor: { revision: current.revision, authorityEpoch: current.authorityEpoch, attemptEpoch: current.attemptEpoch, barrierEpoch: current.barrierEpoch }, snapshot: snapshot(blockedState) };
        return this.commitYield(loaded.generation, blockedState, key, input.identity, blocked);
      }
    }
    const claims = canonicalClaims(plan.steps);
    const admissionOk = recoveryAgainstCommittedPlan ? true : await proveAdmission(this.options.admission, { runId: String(input.runId), claims, workspace: this.options.workspace, ownership: this.options.ownership });
    // Recovery against the committed projection may reconcile the existing
    // command, but a malformed live declaration must never admit successors
    // until the caller restores the authoritative plan.  Keep the public
    // lifecycle unchanged while making the reducer capacity explicit.
    const recoveryCapacity = recoveryAgainstCommittedPlan ? 0 : this.configuredMaxInFlight;

    // Stable context preparation is independent of the reducer event and is
    // retained through CURRENT commit for post-commit BASE publication.  The
    // graph, in contrast, is built only after a pure post-event preflight so a
    // completion can expose its newly-ready successors in this same call.
    const preparedContext = recoveryAgainstCommittedPlan || input.event.kind === 'PARENT_DECISION' ? undefined : await this.#prepareContext(plan, current, input, loaded.generation);

    if (current && input.event.kind === 'PARENT_DECISION') {
      const reduced = applyParentDecision(current, input.identity, input.event.token, input.event.value, segmentedJournalEnabled(this.store));
      if (reduced.outcome === 'BLOCKED' && reduced.state === current) throw new Conflict(reduced.reason ?? 'invalid decision');
      // A FINDINGS decision opens a fresh attempt.  Keep admission under the
      // same mandatory direct validator; effects still launch only on a later
      // RESUME, so this event never calls an external driver inline.
      if (reduced.outcome === 'WAITING' && reduced.state.gate === 'NOT-DUE' && reduced.state.barrier === 'OPEN') refreshAdmission(reduced.state, plan, recoveryCapacity);
      return this.commitYield(loaded.generation, reduced.state, key, input.identity, asYield(reduced.state, reduced), preparedContext);
    }

    if (current && input.event.kind === 'RESUME' && Object.values(current.outbox).some((command) => command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN')) {
      const command = Object.values(current.outbox).find((candidate) => candidate.state === 'PENDING' || candidate.state === 'CLAIMED' || candidate.state === 'UNKNOWN');
      const active = command ? this.activeDispatches.get(command.launchToken) : undefined;
      const liveInProcess = Boolean(command && active && active.commandDigest === command.commandDigest && active.leaseId === command.leaseId);
      const maximumInternalRecords = command?.state === 'CLAIMED' ? (liveInProcess ? 1 : 2) : command?.state === 'UNKNOWN' ? (liveInProcess ? 1 : this.coordinator.driver?.observe ? 2 : 1) : (admissionOk && this.coordinator.driver ? 3 : 1);
      // RESUME may append dispatcher claim/recovery/receipt records in
      // addition to the caller event.  Reserve the whole transition before
      // invoking a driver so a near-ceiling run cannot perform an effect and
      // only then discover that its journal cannot represent the outcome.
      if (!segmentedJournalEnabled(this.store) && !journalHasRecordBudget(current, maximumInternalRecords)) return asYield(current, { outcome: 'BLOCKED', reason: 'JournalCeiling' });
      try {
        return await this.coordinator.resume({ generation: loaded.generation, current, input, key, plan, admissionOk, maxInFlight: recoveryCapacity, preparedContext });
      } catch (error) {
        if ((error as Error).message === 'JournalCeiling') return asYield(current, { outcome: 'BLOCKED', reason: 'JournalCeiling' });
        throw error;
      }
    }

    let reduced;
    let preparedAdmission: PreparedAdmission | undefined;
    try {
      if (recoveryAgainstCommittedPlan || this.#graphMode === 'OFF') {
        reduced = reduce(current, plan, input.identity, input.event, recoveryCapacity, admissionOk, undefined, segmentedJournalEnabled(this.store));
      } else {
        const preview = previewReduce(current, plan, input.identity, input.event, admissionOk, segmentedJournalEnabled(this.store));
        if (preview.outcome === 'BLOCKED' || preview.outcome === 'DECISION_REQUIRED') reduced = preview;
        else {
          preparedAdmission = this.#prepareGraph(plan, current, preview.state, input, loaded.generation);
          reduced = reduce(current, plan, input.identity, input.event, recoveryCapacity, admissionOk, preparedAdmission, segmentedJournalEnabled(this.store));
        }
      }
    }
    catch (error) {
      if ((error as Error).message === 'JournalCeiling') return asYield(current ?? emptyState(String(input.runId), plan.phaseId), { outcome: 'BLOCKED', reason: 'JournalCeiling' });
      throw new InvalidEvent((error as Error).message);
    }
    if (reduced.outcome === 'BLOCKED' && !reduced.state) return asYield(emptyState(String(input.runId), plan.phaseId), reduced);
    if (reduced.outcome === 'BLOCKED' && reduced.state === current && (input.event.kind === 'DISPATCH_RECEIPT' || input.event.kind === 'PARENT_DECISION')) throw new Conflict(reduced.reason ?? 'event rejected');
    return this.commitYield(loaded.generation, reduced.state, key, input.identity, asYield(reduced.state, reduced), preparedContext, preparedAdmission);
  }

  /** Persist a durable CLAIMED transition before the coordinator invokes a
   * driver.  The coordinator never writes this state directly: KernelImpl is
   * the sole commit facade and returns the immutable authority snapshot used
   * by the store-linearized launch fence. */
  private async commitClaim(generation: number, claimed: MachineState, claimedCommand: import('./model.js').OutboxCommand, key: string, input: AdvanceInput, waiting: Yield): Promise<{ generation: number; authority: StoreLinearizedDispatchRequest['authority'] } | { replay: Yield }> {
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
  private async commitEventOnly(generation: number, current: MachineState, input: AdvanceInput, key: string, plan: Plan, capacity: number, y: Yield, preparedContext?: PreparedContext): Promise<Yield> {
    const next = clone(current);
    appendJournal(next, input.identity, input.event, segmentedJournalEnabled(this.store));
    refreshAdmission(next, plan, capacity);
    const rebased: Yield = y.kind === 'WAITING'
      ? asYield(next, { outcome: 'WAITING' })
      : y.kind === 'BLOCKED'
        ? { ...y, snapshot: snapshot(next) }
        : y.kind === 'DECISION_REQUIRED'
          ? { ...y, cursor: { revision: next.revision, authorityEpoch: next.authorityEpoch, attemptEpoch: next.attemptEpoch, barrierEpoch: next.barrierEpoch }, snapshot: snapshot(next) }
          : { ...y, snapshot: snapshot(next) };
    return this.commitYield(generation, next, key, input.identity, rebased, preparedContext);
  }

  /**
   * Persist a receipt/UNKNOWN transition using the same launch-token identity
   * as the original command.  One invocation owns exactly eight private typed
   * generation-CAS retry grants after its first attempt; no external effect is
   * retried and no unrelated error is classified by message text.
   */
  private async commitDispatcherOutcome(token: string, expectedDigest: string, plan: Plan, capacity: number, receipt?: DriverReceipt, expectedLeaseId?: string, receiptLeaseId?: string): Promise<Yield | undefined> {
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
        if (command.state === 'ACKED') return asYield(state, { outcome: 'WAITING' });
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
        const next = clone(state); const nextCommand = commandForToken(next, token)!;
        const event: Event = { kind: 'DISPATCH_RECEIPT', ref: receiptEnvelope(nextCommand, receipt) };
        const identity = internalIdentity(next, nextCommand, `dispatcher-receipt:${token}:${next.revision + 1}`, event);
        try { applyDispatchReceipt(next, identity, event); appendJournal(next, identity, event, segmentedJournalEnabled(this.store)); refreshAdmission(next, plan, capacity); }
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
      const next = clone(state); const nextCommand = commandForToken(next, token)!; unknown(nextCommand);
      const evidence: Ref = ref(`unknown:${token}`, { launchToken: token, commandDigest: expectedDigest, status: 'UNKNOWN' }, 'outbox/recovery');
      const event: Event = { kind: 'OBSERVATION', category: 'RECOVERY', ref: evidence };
      const identity = internalIdentity(next, nextCommand, `dispatcher-unknown:${token}:${next.revision + 1}`, event);
      appendJournal(next, identity, event, segmentedJournalEnabled(this.store)); refreshAdmission(next, plan, capacity);
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

  private async commitYield(generation: number, state: MachineState, key: string, identity: EventIdentity, y: Yield, preparedContext?: PreparedContext, preparedAdmission?: PreparedAdmission): Promise<Yield> {
    const next = state === undefined ? state : clone(state);
    if (!next) return y;
    // Every durable event gets a unique writer fence.  It is private state,
    // but it is the binding that makes staged reuse publication exact.
    next.writerFence = nextWriterFence(state.writerFence, generation + 1, identity);
    if (preparedAdmission) {
      // Admission itself mutates statuses/outbox after the post-event proof;
      // recheck the immutable event/journal/epoch fence here, while the
      // reducer already checked postStateDigest before creating commands.
      if (preparedAdmission.generation !== generation || preparedAdmission.postRevision !== state.revision || preparedAdmission.postJournalEnd !== state.journal.length || preparedAdmission.postJournalDigest !== digest(state.journal) || preparedAdmission.planDigest !== state.planDigest) throw new Conflict('graph freshness proof mismatch');
    }
    next.processed[key] = { digest: identity.payloadDigest, yieldBytes: canonicalString(y), revision: next.revision, identity: clone(identity) };
    try { await this.store.commit(generation, next); }
    catch (error) {
      const mapped = mapCommitFailure(error);
      const replay = await this.recoverExactCommittedReplay(key, identity);
      if (replay !== undefined) return replay;
      throw mapped;
    }
    try { await publishPreparedContext(preparedContext, this.store); }
    catch { /* the authoritative commit is already durable; the row is a miss next time */ }
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
    const dispatch = driver.dispatch;
    const observe = driver.observe;
    if (typeof dispatch !== 'function' || (observe !== undefined && typeof observe !== 'function')) throw new InvalidPlan('driver is invalid');
    snapshot = { receiver: driver, dispatch, observe };
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
    const dispatch = driver.dispatch;
    const observe = driver.observe;
    if (typeof dispatch !== 'function' || (observe !== undefined && typeof observe !== 'function')) throw new InvalidPlan('driver is invalid');
    snapshot = { receiver: driver, dispatch, observe };
  }
  return new KernelImpl(options, configuredMaxInFlight, storeForRoot(options.rootDir, expectedRootIdentity), snapshot, dispatcher);
}
