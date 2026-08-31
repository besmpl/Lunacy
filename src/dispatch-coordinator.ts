import { canonicalString, digest } from './canonical.js';
import { claim, commandInCurrentFrame, unknown, type DriverReceipt } from './outbox.js';
import { ProseDriver, type EffectDriver } from './driver.js';
import { appendJournal, commandForToken, reduce, refreshAdmission } from './reducer.js';
import { normalizeDriverResult, storeLinearizedDispatch, type ArtifactStore, type StoreLinearizedDispatchRequest } from './store.js';
import type { AdvanceInput, CompactSnapshot, Event, EventIdentity, MachineState, OutboxCommand, OutboxState, Plan, Ref, Yield } from './model.js';

export type CurrentCommandSelection = Readonly<{ command: OutboxCommand; authorityAnchor?: Ref }>;

export { commandInCurrentFrame } from './outbox.js';

function selection(state: MachineState, command: OutboxCommand): CurrentCommandSelection | undefined {
  const authorityAnchor = command.roleView ? state.managed?.attempts?.[command.commandId]?.authorityAnchor : undefined;
  if (command.roleView && command.state === 'ACKED' && !authorityAnchor) return undefined;
  return authorityAnchor ? { command, authorityAnchor } : { command };
}

function eligible(state: MachineState, command: OutboxCommand, allowed: ReadonlySet<OutboxState>): boolean {
  return allowed.has(command.state)
    && commandInCurrentFrame(state, command)
    && state.steps[command.stepId]?.status === 'ACTIVE'
    && state.steps[command.stepId]?.attempt === command.attemptEpoch
    && ((command.state !== 'CLAIMED' && command.state !== 'UNKNOWN') || (typeof command.leaseId === 'string' && command.leaseId.length > 0));
}

/** Select the next eligible command from the exact current execution frame. */
export function selectEligibleCommand(
  state: MachineState | undefined,
  dispositions: readonly OutboxState[],
): CurrentCommandSelection | undefined {
  if (!state || state.modeEpoch !== 0) return undefined;
  const allowed = new Set(dispositions);
  for (const command of Object.values(state.outbox)) {
    if (!eligible(state, command, allowed)) continue;
    const selected = selection(state, command);
    if (selected) return selected;
  }
  return undefined;
}

/** Reselect one already-retained token/digest/lease from a fresh generation. */
export function selectCurrentTokenCommand(
  state: MachineState | undefined,
  dispositions: readonly OutboxState[],
  expected: Pick<OutboxCommand, 'launchToken' | 'commandDigest' | 'leaseId'>,
): CurrentCommandSelection | undefined {
  if (!state || state.modeEpoch !== 0) return undefined;
  const allowed = new Set(dispositions);
  const command = Object.values(state.outbox).find((candidate) => candidate.launchToken === expected.launchToken
    && candidate.commandDigest === expected.commandDigest
    && (candidate.leaseId ?? null) === (expected.leaseId ?? null));
  return command && eligible(state, command, allowed) ? selection(state, command) : undefined;
}

/** Compatibility alias for private diagnostics/tests. */
export function selectCurrentCommand(state: MachineState | undefined, dispositions: readonly OutboxState[], expected?: Pick<OutboxCommand, 'launchToken' | 'commandDigest' | 'leaseId'>): CurrentCommandSelection | undefined {
  return expected ? selectCurrentTokenCommand(state, dispositions, expected) : selectEligibleCommand(state, dispositions);
}

/** Snapshot of the host driver methods.  The receiver and methods are bound
 * once by the composition facade; no caller-owned object is read after an
 * await or while a store fence is held. */
export type DispatchDriverSnapshot = {
  receiver: EffectDriver;
  prepare?: NonNullable<EffectDriver['prepare']>;
  dispatch: EffectDriver['dispatch'];
  observe?: NonNullable<EffectDriver['observe']>;
  observeTeardown?: NonNullable<EffectDriver['observeTeardown']>;
};

export type DispatchCoordinatorOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  onYield?: (value: Yield) => void | Promise<void>;
};

type CommitEventOnly = (generation: number, current: MachineState, input: AdvanceInput, key: string, plan: Plan, capacity: number, y: Yield) => Promise<Yield>;
type CommitYield = (generation: number, state: MachineState, key: string, identity: EventIdentity, y: Yield) => Promise<Yield>;
type CommitDispatcherOutcome = (token: string, expectedDigest: string, plan: Plan, capacity: number, receipt?: DriverReceipt, expectedLeaseId?: string, receiptLeaseId?: string, teardownEvidence?: Ref) => Promise<Yield | undefined>;
type RetireManagedAttempt = (generation: number, current: MachineState, token: string, input: AdvanceInput, plan: Plan, capacity: number, status?: 'TIMED_OUT' | 'CANCELLED' | 'FAILED') => Promise<Yield>;
type FinalizeImmediateYield = (key: string, identity: EventIdentity, value: Yield) => Promise<Yield | undefined>;
type CommitClaim = (generation: number, claimed: MachineState, claimedCommand: OutboxCommand, key: string, input: AdvanceInput, waiting: Yield) => Promise<{ generation: number; authority: StoreLinearizedDispatchRequest['authority'] } | { replay: Yield }>;

type DispatchCoordinatorHost = {
  store: ArtifactStore;
  driver?: DispatchDriverSnapshot;
  segmentedJournalEnabled: () => boolean;
  commitEventOnly: CommitEventOnly;
  commitYield: CommitYield;
  commitDispatcherOutcome: CommitDispatcherOutcome;
  retireManagedAttempt?: RetireManagedAttempt;
  finalizeImmediateYield: FinalizeImmediateYield;
  commitClaim: CommitClaim;
  asYield: (state: MachineState, result: { outcome: string; reason?: string; token?: string; brief?: Ref; receipt?: Ref; launchToken?: string }) => Yield;
  snapshot: (state: MachineState) => CompactSnapshot;
  ref: (id: string, value: unknown, scope?: string) => Ref;
  internalIdentity: (state: MachineState, command: { launchToken: string; stepId: string }, eventId: string, event: Event) => EventIdentity;
  validateRef: (value: Ref) => void;
};

export type DispatchResumeArgs = {
  generation: number;
  current: MachineState;
  input: AdvanceInput;
  key: string;
  plan: Plan;
  admissionOk: boolean;
  maxInFlight: number;
};

/**
 * Private owner of all in-process dispatch lifecycle state.  KernelImpl keeps
 * boundary validation/reducer/commit policy and supplies these narrow durable
 * callbacks; this class owns task identity, launch/observe races, cancellation
 * watchers, receipt classification, settlement, cleanup, and notifications.
 */
export class DispatchCoordinator {
  readonly activeDispatches = new Map<string, ActiveDispatchTask>();
  readonly driver?: DispatchDriverSnapshot;
  readonly options: DispatchCoordinatorOptions;
  private readonly host: DispatchCoordinatorHost;

  constructor(host: DispatchCoordinatorHost, options: DispatchCoordinatorOptions) {
    this.host = host;
    this.driver = host.driver;
    this.options = options;
  }

  /** Compatibility view used by existing in-process diagnostics/tests. */
  get dispatchOptions(): DispatchCoordinatorOptions { return this.options; }

  async resume(args: DispatchResumeArgs): Promise<Yield> {
    const { generation, current, input, key, plan, admissionOk, maxInFlight } = args;
    // Historical rows remain durable recovery evidence but are inert after an
    // epoch/frame transition. Select only the exact current frame so a retired
    // UNKNOWN attempt cannot shadow its fresh reservation.
    const command = selectEligibleCommand(current, ['PENDING', 'CLAIMED', 'UNKNOWN'])?.command;
    if (!command) return this.host.commitYield(generation, current, key, input.identity, this.host.asYield(current, { outcome: 'WAITING' }));
    // The deadline starts when this RESUME claims ownership, not after a slow
    // durable claim commit.  The post-CAS launch fence rechecks it.
    const dispatchDeadline = Date.now() + this.options.timeoutMs;

    const candidateActive = this.activeDispatches.get(command.launchToken);
    const active = candidateActive && candidateActive.commandDigest === command.commandDigest && candidateActive.leaseId === command.leaseId ? candidateActive : undefined;
    if (command.state === 'CLAIMED' && active) return this.host.asYield(current, { outcome: 'WAITING' });
    if (command.state === 'UNKNOWN' && active) {
      return { kind: 'BLOCKED', code: 'UnknownDispatch', reason: 'UnknownDispatch', retryable: false, launchToken: command.launchToken, snapshot: this.host.snapshot(current) };
    }

    if (command.state === 'UNKNOWN') {
      if (!admissionOk) {
        const reduced = reduce(current, plan, input.identity, input.event, maxInFlight, admissionOk, this.host.segmentedJournalEnabled());
        return this.host.commitYield(generation, reduced.state, key, input.identity, this.host.asYield(reduced.state, reduced));
      }
      if (!this.host.driver?.observe || this.options.signal?.aborted) {
        if (current.schema === 2 && current.managed && this.host.retireManagedAttempt) {
          return this.host.retireManagedAttempt(generation, current, command.launchToken, input, plan, maxInFlight, this.options.signal?.aborted ? 'CANCELLED' : 'TIMED_OUT');
        }
        const y: Yield = { kind: 'BLOCKED', code: 'UnknownDispatch', reason: 'UnknownDispatch', retryable: false, launchToken: command.launchToken, snapshot: this.host.snapshot(current) };
        return this.host.commitEventOnly(generation, current, input, key, plan, maxInFlight, y);
      }
      const waiting = await this.host.commitEventOnly(generation, current, input, key, plan, maxInFlight, { kind: 'BLOCKED', code: 'UnknownDispatch', reason: 'UnknownDispatch', retryable: false, launchToken: command.launchToken, snapshot: this.host.snapshot(current) });
      const committed = await this.host.store.load();
      const selection = selectCurrentTokenCommand(committed.state, ['UNKNOWN'], command);
      const committedCommand = selection?.command;
      if (!committedCommand || canonicalString(committedCommand) !== canonicalString(command)) return waiting;
      const observed = this.launchObserve(committed.generation, committedCommand, plan, maxInFlight, key, input, selection.authorityAnchor);
      if (observed) return (await observed) ?? waiting;
      return waiting;
    }

    if (command.state === 'CLAIMED') {
      // A managed provider lease cannot become UNKNOWN merely because this
      // process lost its in-memory task.  Only the driver's durable teardown
      // proof (written after provider exit and scratch removal) opens that
      // transition; otherwise retain CLAIMED so no fresh epoch can overlap.
      let managedTeardown: Ref | undefined;
      if (command.roleView) {
        const observeTeardown = this.host.driver?.observeTeardown;
        if (observeTeardown) {
          try { managedTeardown = await Reflect.apply(observeTeardown, this.host.driver!.receiver, [command.launchToken, command.commandDigest, this.options.signal]); }
          catch { managedTeardown = undefined; }
        }
        if (!managedTeardown) {
          const y: Yield = { kind: 'BLOCKED', code: 'UnknownDispatch', reason: 'managed provider teardown is unproven', retryable: false, launchToken: command.launchToken, snapshot: this.host.snapshot(current) };
          return this.host.commitEventOnly(generation, current, input, key, plan, maxInFlight, y);
        }
        try { this.host.validateRef(managedTeardown); } catch { managedTeardown = undefined; }
        if (!managedTeardown || managedTeardown.scope !== 'outbox/teardown') {
          const y: Yield = { kind: 'BLOCKED', code: 'UnknownDispatch', reason: 'managed provider teardown is invalid', retryable: false, launchToken: command.launchToken, snapshot: this.host.snapshot(current) };
          return this.host.commitEventOnly(generation, current, input, key, plan, maxInFlight, y);
        }
      }
      // No in-process owner exists (for example after restart). Recovery is
      // conservative: mark the old lease UNKNOWN and never relaunch it.
      const uncertain = JSON.parse(JSON.stringify(current)) as MachineState;
      const uncertainCommand = commandForToken(uncertain, command.launchToken)!;
      if (managedTeardown) uncertainCommand.noEffectEvidence = [...(uncertainCommand.noEffectEvidence ?? []), managedTeardown];
      unknown(uncertainCommand);
      const uncertainAttempt = uncertain.managed?.attempts?.[uncertainCommand.commandId];
      if (uncertainAttempt && (uncertainAttempt.status === 'LIVE' || uncertainAttempt.status === 'UNKNOWN')) uncertainAttempt.status = 'UNKNOWN';
      const evidence = this.host.ref(`unknown:${command.launchToken}`, { launchToken: command.launchToken, commandDigest: command.commandDigest, status: 'UNKNOWN' }, 'outbox/recovery');
      const recovery: Event = { kind: 'OBSERVATION', category: 'RECOVERY', ref: evidence };
      appendJournal(uncertain, this.host.internalIdentity(uncertain, uncertainCommand, `dispatcher-recover:${command.launchToken}:${uncertain.revision + 1}`, recovery), recovery, this.host.segmentedJournalEnabled());
      appendJournal(uncertain, input.identity, input.event, this.host.segmentedJournalEnabled());
      // A same-drive observer may immediately add the receipt row after this
      // recovery commit.  Probe that third append before mutating CURRENT so a
      // legacy journal with only the two recovery slots left refuses without
      // stranding a newly-UNKNOWN command at the ceiling.
      if (this.host.driver?.observe && !this.options.signal?.aborted) {
        const probe = JSON.parse(JSON.stringify(uncertain)) as MachineState;
        const probeCommand = commandForToken(probe, command.launchToken)!;
        const probeReceipt: Event = {
          kind: 'DISPATCH_RECEIPT',
          ref: this.host.ref(`receipt-capacity:${command.launchToken}`, { launchToken: command.launchToken, commandDigest: command.commandDigest }, 'outbox'),
        };
        appendJournal(probe, this.host.internalIdentity(probe, probeCommand, `dispatcher-receipt-capacity:${command.launchToken}:${probe.revision + 1}`, probeReceipt), probeReceipt, this.host.segmentedJournalEnabled());
      }
      refreshAdmission(uncertain, plan, maxInFlight);
      const y: Yield = { kind: 'BLOCKED', code: 'UnknownDispatch', reason: 'UnknownDispatch', retryable: false, launchToken: command.launchToken, snapshot: this.host.snapshot(uncertain) };
      const waiting = await this.host.commitYield(generation, uncertain, key, input.identity, y);
      const committed = await this.host.store.load();
      const recovered = selectCurrentTokenCommand(committed.state, ['UNKNOWN'], command);
      const committedCommand = recovered?.command;
      if (!committedCommand || canonicalString(committedCommand) !== canonicalString(uncertainCommand) || this.options.signal?.aborted) return waiting;
      const observed = this.launchObserve(committed.generation, committedCommand, plan, maxInFlight, key, input, recovered.authorityAnchor);
      if (observed) return (await observed) ?? waiting;
      return waiting;
    }

    // PENDING: cancellation before claim records no effect and leaves command
    // available for a later non-cancelled RESUME.
    if (this.options.signal?.aborted || !admissionOk) {
      if (!admissionOk) {
        const reduced = reduce(current, plan, input.identity, input.event, maxInFlight, admissionOk, this.host.segmentedJournalEnabled());
        return this.host.commitYield(generation, reduced.state, key, input.identity, this.host.asYield(reduced.state, reduced));
      }
      return this.host.commitEventOnly(generation, current, input, key, plan, maxInFlight, this.host.asYield(current, { outcome: 'WAITING' }));
    }
    if (!this.host.driver) {
      const request = new ProseDriver().request(command);
      const requestRef: Ref = { id: `human-receipt:${command.launchToken}`, scope: 'outbox', digest: digest(request), bytes: canonicalString(request) };
      const y: Yield = { kind: 'BLOCKED', code: 'HumanReceiptRequired', reason: 'ProseDriver cannot prove launch-token dispatch; submit a receipt', receipt: requestRef, launchToken: command.launchToken, retryable: false, snapshot: this.host.snapshot(current) };
      return this.host.commitEventOnly(generation, current, input, key, plan, maxInFlight, y);
    }

    const claimed = JSON.parse(JSON.stringify(current)) as MachineState;
    let claimedCommand = commandForToken(claimed, command.launchToken)!;
    if (claimed.schema === 2 && claimed.managed?.proposal && this.host.driver.prepare) {
      Reflect.apply(this.host.driver.prepare, this.host.driver.receiver, [claimedCommand, claimed]);
      claimedCommand = claimed.outbox[claimedCommand.commandId]!;
    }
    claim(claimedCommand, `lease-${process.pid}-${claimed.revision + 1}`, claimed.modeEpoch, claimed.writerFence);
    const preparedToken = claimedCommand.launchToken;
    const claimEvent: Event = { kind: 'OBSERVATION', category: 'HOST', ref: this.host.ref(`claim:${preparedToken}`, { launchToken: preparedToken, commandDigest: claimedCommand.commandDigest }, 'outbox') };
    const claimIdentity = this.host.internalIdentity(claimed, claimedCommand, `dispatcher-claim:${preparedToken}:${claimed.revision + 1}`, claimEvent);
    // Reserve claim -> UNKNOWN recovery shape before invoking external effect.
    try {
      const probe = JSON.parse(JSON.stringify(claimed)) as MachineState;
      appendJournal(probe, claimIdentity, claimEvent, this.host.segmentedJournalEnabled());
      const probeCommand = commandForToken(probe, preparedToken)!;
      unknown(probeCommand);
      const probeEvidence = this.host.ref(`unknown:${preparedToken}`, { launchToken: preparedToken, commandDigest: claimedCommand.commandDigest, status: 'UNKNOWN' }, 'outbox/recovery');
      const probeRecovery: Event = { kind: 'OBSERVATION', category: 'RECOVERY', ref: probeEvidence };
      appendJournal(probe, this.host.internalIdentity(probe, probeCommand, `dispatcher-unknown:${preparedToken}:${probe.revision + 1}`, probeRecovery), probeRecovery, this.host.segmentedJournalEnabled());
      appendJournal(probe, input.identity, input.event, this.host.segmentedJournalEnabled());
    } catch (error) {
      if ((error as Error).message === 'JournalCeiling') return this.host.asYield(current, { outcome: 'BLOCKED', reason: 'JournalCeiling' });
      throw error;
    }
    appendJournal(claimed, claimIdentity, claimEvent, this.host.segmentedJournalEnabled());
    appendJournal(claimed, input.identity, input.event, this.host.segmentedJournalEnabled());
    refreshAdmission(claimed, plan, maxInFlight);
    const waiting = this.host.asYield(claimed, { outcome: 'WAITING' });
    const committedClaim = await this.host.commitClaim(generation, claimed, claimedCommand, key, input, waiting);
    if ('replay' in committedClaim) return committedClaim.replay;
    const immediate = this.launchDispatch(committedClaim.authority, plan, maxInFlight, key, input.identity, dispatchDeadline);
    if (immediate) return (await immediate) ?? waiting;
    return waiting;
  }

  private notifyYield(value: Yield): void {
    const onYield = this.options.onYield;
    if (!onYield) return;
    try {
      const detached = Promise.resolve().then(() => Reflect.apply(onYield, this.options, [value]));
      void detached.catch(() => undefined);
    } catch { /* poisoned host Promise cannot gate the kernel */ }
  }

  private launchDispatch(authority: StoreLinearizedDispatchRequest['authority'], plan: Plan, capacity: number, processedKey?: string, processedIdentity?: EventIdentity, deadline = Date.now() + this.options.timeoutMs): Promise<Yield | undefined> | undefined {
    const command = authority.command;
    const token = command.launchToken;
    const leaseId = command.leaseId;
    if (!this.host.driver || typeof leaseId !== 'string') return undefined;
    const existing = this.activeDispatches.get(token);
    if (existing && existing.commandDigest === command.commandDigest && existing.leaseId === leaseId) return undefined;
    if (existing && existing.generation >= authority.generation) return undefined;
    const task: ActiveDispatchTask = { generation: authority.generation, commandDigest: command.commandDigest, leaseId, timedOut: false, settled: false, outcomeCommitted: false };
    const managedRole = Boolean(command.roleView);
    this.activeDispatches.set(token, task);
    const controller = new AbortController();
    const externalSignal = this.options.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    let asynchronousPromise = false;
    let noReceiptNotification: Promise<void> | undefined;
    const deleteTask = (): void => { if (this.activeDispatches.get(token) === task) this.activeDispatches.delete(token); };
    const stopCancellationWatch = (): void => {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', abort);
    };
    const cleanup = (): void => { stopCancellationWatch(); deleteTask(); };
    const notifyNoReceiptOutcome = (): void => {
      if (!task.noReceiptOutcome || noReceiptNotification) return;
      noReceiptNotification = task.noReceiptOutcome.then((value) => { if (value) this.notifyYield(value); }).catch(() => undefined);
    };
    const finishUnknown = (immediate = false): Promise<Yield | undefined> => {
      if (!task.noReceiptOutcome) {
        if (task.outcomeCommitted) return Promise.resolve(undefined);
        stopCancellationWatch();
        task.outcomeCommitted = true;
        const teardown = managedRole && this.host.driver?.observeTeardown
          ? Promise.resolve(Reflect.apply(this.host.driver.observeTeardown, this.host.driver.receiver, [token, task.commandDigest])).catch(() => undefined)
          : Promise.resolve(undefined);
        task.noReceiptOutcome = teardown.then((evidence) => this.host.commitDispatcherOutcome(token, task.commandDigest, plan, capacity, undefined, leaseId, undefined, evidence)).catch(() => undefined);
      }
      if (immediate && processedKey && processedIdentity) {
        task.immediateNoReceiptOutcome ??= task.noReceiptOutcome.then(async (value) => {
          if (!value) return undefined;
          const finalized = await this.host.finalizeImmediateYield(processedKey, processedIdentity, value);
          this.notifyYield(finalized ?? value);
          return finalized;
        });
        return task.immediateNoReceiptOutcome;
      }
      if (asynchronousPromise) notifyNoReceiptOutcome();
      return task.noReceiptOutcome;
    };
    const finishReceipt = (value: DriverReceipt, immediate = false): Promise<Yield | undefined> => {
      if (!value || value.launchToken !== token || value.commandDigest !== task.commandDigest) return finishUnknown(immediate);
      try { this.host.validateRef(value.ref); } catch { return finishUnknown(immediate); }
      stopCancellationWatch();
      if (!task.outcomeCommitted) task.outcomeCommitted = true;
      return this.host.commitDispatcherOutcome(token, task.commandDigest, plan, capacity, value, leaseId).then(async (result) => {
        if (!result) return undefined;
        if (immediate && processedKey && processedIdentity) {
          const finalized = await this.host.finalizeImmediateYield(processedKey, processedIdentity, result);
          this.notifyYield(finalized ?? result);
          return finalized;
        }
        this.notifyYield(result);
        return result;
      }).catch(() => undefined);
    };
    const finishCancelledBeforeLaunch = (): Promise<Yield | undefined> => {
      task.timedOut = true;
      controller.abort();
      return finishUnknown(true).finally(() => { task.settled = true; cleanup(); });
    };
    abort = () => {
      if (task.timedOut || task.outcomeCommitted) return;
      task.timedOut = true;
      controller.abort();
      // For managed roles, the dispatch Promise owns process close, scratch
      // cleanup, and teardown publication.  Its rejection handler below is
      // the first point at which UNKNOWN may be attempted.
      if (!managedRole) void finishUnknown().finally(() => { if (!task.settled) deleteTask(); });
    };
    if (externalSignal) externalSignal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
    if (externalSignal?.aborted) abort();

    const request: StoreLinearizedDispatchRequest = { authority, receiver: this.host.driver.receiver, dispatch: this.host.driver.dispatch, signal: controller.signal, deadline };
    return storeLinearizedDispatch(this.host.store, request).then(async (result) => {
      if (result.kind === 'STALE') {
        if (task.noReceiptOutcome) return finishUnknown(true).finally(() => { task.settled = true; cleanup(); });
        task.settled = true; cleanup(); return undefined;
      }
      if (result.kind === 'CANCELLED') return finishCancelledBeforeLaunch();
      if (result.kind === 'FENCE_FAILURE') {
        if (result.entered || task.noReceiptOutcome) return finishUnknown(true).finally(() => { task.settled = true; cleanup(); });
        task.settled = true; cleanup(); return undefined;
      }
      if (result.kind === 'UNCERTAIN') return finishUnknown(true).finally(() => { task.settled = true; cleanup(); });
      if (result.kind === 'RECEIPT') {
        task.settled = true;
        return finishReceipt(result.receipt, true).finally(cleanup);
      }
      asynchronousPromise = true;
      if (task.timedOut || controller.signal.aborted || Date.now() >= deadline) abort();
      if (task.noReceiptOutcome) notifyNoReceiptOutcome();
      result.receipt.then((value) => {
        task.settled = true;
        void finishReceipt(value).finally(cleanup);
      }, () => {
        task.settled = true;
        void finishUnknown().finally(cleanup);
      });
      return undefined;
    });
  }

  private launchObserve(generation: number, command: OutboxCommand, plan: Plan, capacity: number, processedKey?: string, processedInput?: AdvanceInput, authorityAnchor?: Ref): Promise<Yield | undefined> | undefined {
    const driver = this.host.driver;
    const observe = driver?.observe;
    if (!driver || !observe) return undefined;
    const token = command.launchToken;
    const existing = this.activeDispatches.get(token);
    if (existing && existing.commandDigest === command.commandDigest && existing.leaseId === command.leaseId) return undefined;
    if (existing && existing.generation >= generation) return undefined;
    const task: ActiveDispatchTask = { generation, commandDigest: command.commandDigest, leaseId: command.leaseId, timedOut: false, settled: false, outcomeCommitted: false };
    this.activeDispatches.set(token, task);
    const deleteTask = (): void => { if (this.activeDispatches.get(token) === task) this.activeDispatches.delete(token); };
    const controller = new AbortController();
    /** Retire an UNKNOWN managed attempt when observation proves no receipt or
     * reaches its deadline.  Re-load immediately before invoking the callback
     * so a concurrent receipt/authority CAS wins over retirement. */
    const retireUnknown = async (status: 'TIMED_OUT' | 'CANCELLED' = 'TIMED_OUT'): Promise<Yield | undefined> => {
      if (!processedInput || this.host.retireManagedAttempt === undefined) return undefined;
      try {
        const loaded = await this.host.store.load();
        const current = loaded.state;
        const candidate = current ? commandForToken(current, token) : undefined;
        if (!current || current.schema !== 2 || !current.managed || !candidate
          || candidate.state !== 'UNKNOWN' || candidate.commandDigest !== command.commandDigest
          || candidate.leaseId !== command.leaseId) return undefined;
        const result = await this.host.retireManagedAttempt(loaded.generation, current, token, processedInput, plan, capacity, status);
        this.notifyYield(result);
        return result;
      } catch { return undefined; }
    };
    const unresolvedBoundary = async (status: 'TIMED_OUT' | 'CANCELLED' = 'TIMED_OUT'): Promise<Yield | undefined> => {
      const retired = await retireUnknown(status);
      if (retired) return retired;
      try {
        const loaded = await this.host.store.load();
        const candidate = selectCurrentTokenCommand(loaded.state, ['UNKNOWN'], command);
        if (!loaded.state || !candidate) return undefined;
        const value: Yield = { kind: 'BLOCKED', code: 'UnknownDispatch', reason: 'UnknownDispatch', retryable: false, launchToken: token, snapshot: this.host.snapshot(loaded.state) };
        this.notifyYield(value);
        return value;
      } catch { return undefined; }
    };
    let normalized: ReturnType<typeof normalizeDriverResult>;
    try { normalized = normalizeDriverResult(Reflect.apply(observe, driver.receiver, [token, controller.signal, authorityAnchor, JSON.parse(JSON.stringify(command)) as OutboxCommand]), true); }
    catch { task.settled = true; deleteTask(); return unresolvedBoundary(); }
    const finish = (value: DriverReceipt | undefined, immediate = false): Promise<Yield | undefined> => {
      if (!value) return Promise.resolve(undefined);
      if (value.launchToken !== token || value.commandDigest !== command.commandDigest) return Promise.resolve(undefined);
      try { this.host.validateRef(value.ref); } catch { return Promise.resolve(undefined); }
      if (command.roleView && (!value.authorityAnchor || (authorityAnchor && canonicalString(value.authorityAnchor) !== canonicalString(authorityAnchor)))) return Promise.resolve(undefined);
      return this.host.commitDispatcherOutcome(token, command.commandDigest, plan, capacity, value, undefined, command.leaseId).then(async (result) => {
        if (!result) return undefined;
        if (immediate && processedKey && processedInput) {
          const finalized = await this.host.finalizeImmediateYield(processedKey, processedInput.identity, result);
          this.notifyYield(finalized ?? result);
          return finalized;
        }
        this.notifyYield(result);
        return result;
      }).catch(() => undefined);
    };
    const observedReceiptIsValid = (value: DriverReceipt | undefined): value is DriverReceipt => {
      if (!value || value.launchToken !== token || value.commandDigest !== command.commandDigest) return false;
      try {
        this.host.validateRef(value.ref);
        if (command.roleView && (!value.authorityAnchor || (authorityAnchor && canonicalString(value.authorityAnchor) !== canonicalString(authorityAnchor)))) return false;
        return true;
      } catch { return false; }
    };
    if (normalized.kind === 'ABSENT' || normalized.kind === 'INVALID') {
      task.settled = true;
      deleteTask();
      return unresolvedBoundary();
    }
    if (normalized.kind === 'RECEIPT') {
      if (!observedReceiptIsValid(normalized.receipt)) { task.settled = true; deleteTask(); return unresolvedBoundary(); }
      return finish(normalized.receipt, true).finally(() => { task.settled = true; deleteTask(); });
    }
    const timer = setTimeout(() => {
      task.timedOut = true;
      controller.abort();
      deleteTask();
      void unresolvedBoundary('TIMED_OUT');
    }, this.options.timeoutMs);
    normalized.receipt.then((value) => {
      clearTimeout(timer);
      task.settled = true;
      if (!observedReceiptIsValid(value)) { deleteTask(); void unresolvedBoundary('TIMED_OUT'); return; }
      void finish(value).finally(deleteTask);
    }, () => { clearTimeout(timer); task.settled = true; deleteTask(); void unresolvedBoundary('TIMED_OUT'); });
    return undefined;
  }
}

export type ActiveDispatchTask = {
  generation: number;
  commandDigest: string;
  leaseId?: string;
  timedOut: boolean;
  settled: boolean;
  outcomeCommitted: boolean;
  noReceiptOutcome?: Promise<Yield | undefined>;
  immediateNoReceiptOutcome?: Promise<Yield | undefined>;
};
