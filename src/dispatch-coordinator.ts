import { canonicalString, digest } from './canonical.js';
import { claim, unknown, type DriverReceipt } from './outbox.js';
import { ProseDriver, type EffectDriver } from './driver.js';
import { appendJournal, commandForToken, reduce, refreshAdmission, type PreparedAdmission } from './reducer.js';
import { normalizeDriverResult, storeLinearizedDispatch, type ArtifactStore, type StoreLinearizedDispatchRequest } from './store.js';
import type { PreparedContext } from './compiler.js';
import type { AdvanceInput, CompactSnapshot, Event, EventIdentity, MachineState, OutboxCommand, Plan, Ref, Yield } from './model.js';

/** Snapshot of the host driver methods.  The receiver and methods are bound
 * once by the composition facade; no caller-owned object is read after an
 * await or while a store fence is held. */
export type DispatchDriverSnapshot = {
  receiver: EffectDriver;
  dispatch: EffectDriver['dispatch'];
  observe?: NonNullable<EffectDriver['observe']>;
};

export type DispatchCoordinatorOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  onYield?: (value: Yield) => void | Promise<void>;
};

type CommitEventOnly = (generation: number, current: MachineState, input: AdvanceInput, key: string, plan: Plan, capacity: number, y: Yield, preparedContext?: PreparedContext) => Promise<Yield>;
type CommitYield = (generation: number, state: MachineState, key: string, identity: EventIdentity, y: Yield, preparedContext?: PreparedContext, preparedAdmission?: PreparedAdmission) => Promise<Yield>;
type CommitDispatcherOutcome = (token: string, expectedDigest: string, plan: Plan, capacity: number, receipt?: DriverReceipt, expectedLeaseId?: string, receiptLeaseId?: string) => Promise<Yield | undefined>;
type FinalizeImmediateYield = (key: string, identity: EventIdentity, value: Yield) => Promise<Yield | undefined>;
type CommitClaim = (generation: number, claimed: MachineState, claimedCommand: OutboxCommand, key: string, input: AdvanceInput, waiting: Yield) => Promise<{ generation: number; authority: StoreLinearizedDispatchRequest['authority'] } | { replay: Yield }>;

type DispatchCoordinatorHost = {
  store: ArtifactStore;
  driver?: DispatchDriverSnapshot;
  segmentedJournalEnabled: () => boolean;
  commitEventOnly: CommitEventOnly;
  commitYield: CommitYield;
  commitDispatcherOutcome: CommitDispatcherOutcome;
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
  preparedContext?: PreparedContext;
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
    const { generation, current, input, key, plan, admissionOk, maxInFlight, preparedContext } = args;
    const command = Object.values(current.outbox).find((candidate) => candidate.state === 'PENDING' || candidate.state === 'CLAIMED' || candidate.state === 'UNKNOWN');
    if (!command) return this.host.commitYield(generation, current, key, input.identity, this.host.asYield(current, { outcome: 'WAITING' }), preparedContext);
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
        const reduced = reduce(current, plan, input.identity, input.event, maxInFlight, admissionOk, undefined, this.host.segmentedJournalEnabled());
        return this.host.commitYield(generation, reduced.state, key, input.identity, this.host.asYield(reduced.state, reduced), preparedContext);
      }
      if (!this.host.driver?.observe || this.options.signal?.aborted) {
        const y: Yield = { kind: 'BLOCKED', code: 'UnknownDispatch', reason: 'UnknownDispatch', retryable: false, launchToken: command.launchToken, snapshot: this.host.snapshot(current) };
        return this.host.commitEventOnly(generation, current, input, key, plan, maxInFlight, y, preparedContext);
      }
      const waiting = await this.host.commitEventOnly(generation, current, input, key, plan, maxInFlight, { kind: 'BLOCKED', code: 'UnknownDispatch', reason: 'UnknownDispatch', retryable: false, launchToken: command.launchToken, snapshot: this.host.snapshot(current) }, preparedContext);
      const committed = await this.host.store.load();
      const committedCommand = committed.state ? commandForToken(committed.state, command.launchToken) : undefined;
      const sameUnknownCommand = Boolean(committedCommand
        && committedCommand.state === 'UNKNOWN'
        && committedCommand.launchToken === command.launchToken
        && committedCommand.commandDigest === command.commandDigest
        && committedCommand.leaseId === command.leaseId
        && canonicalString(committedCommand) === canonicalString(command));
      if (!sameUnknownCommand || !committedCommand) return waiting;
      const observed = this.launchObserve(committed.generation, committedCommand, plan, maxInFlight, key, input.identity);
      if (observed) return (await observed) ?? waiting;
      return waiting;
    }

    if (command.state === 'CLAIMED') {
      // No in-process owner exists (for example after restart). Recovery is
      // conservative: mark the old lease UNKNOWN and never relaunch it.
      const uncertain = JSON.parse(JSON.stringify(current)) as MachineState;
      const uncertainCommand = commandForToken(uncertain, command.launchToken)!;
      unknown(uncertainCommand);
      const evidence = this.host.ref(`unknown:${command.launchToken}`, { launchToken: command.launchToken, commandDigest: command.commandDigest, status: 'UNKNOWN' }, 'outbox/recovery');
      const recovery: Event = { kind: 'OBSERVATION', category: 'RECOVERY', ref: evidence };
      appendJournal(uncertain, this.host.internalIdentity(uncertain, uncertainCommand, `dispatcher-recover:${command.launchToken}:${uncertain.revision + 1}`, recovery), recovery, this.host.segmentedJournalEnabled());
      appendJournal(uncertain, input.identity, input.event, this.host.segmentedJournalEnabled());
      refreshAdmission(uncertain, plan, maxInFlight);
      const y: Yield = { kind: 'BLOCKED', code: 'UnknownDispatch', reason: 'UnknownDispatch', retryable: false, launchToken: command.launchToken, snapshot: this.host.snapshot(uncertain) };
      return this.host.commitYield(generation, uncertain, key, input.identity, y, preparedContext);
    }

    // PENDING: cancellation before claim records no effect and leaves command
    // available for a later non-cancelled RESUME.
    if (this.options.signal?.aborted || !admissionOk) {
      if (!admissionOk) {
        const reduced = reduce(current, plan, input.identity, input.event, maxInFlight, admissionOk, undefined, this.host.segmentedJournalEnabled());
        return this.host.commitYield(generation, reduced.state, key, input.identity, this.host.asYield(reduced.state, reduced), preparedContext);
      }
      return this.host.commitEventOnly(generation, current, input, key, plan, maxInFlight, this.host.asYield(current, { outcome: 'WAITING' }), preparedContext);
    }
    if (!this.host.driver) {
      const request = new ProseDriver().request(command);
      const requestRef: Ref = { id: `human-receipt:${command.launchToken}`, scope: 'outbox', digest: digest(request), bytes: canonicalString(request) };
      const y: Yield = { kind: 'BLOCKED', code: 'HumanReceiptRequired', reason: 'ProseDriver cannot prove launch-token dispatch; submit a receipt', receipt: requestRef, launchToken: command.launchToken, retryable: false, snapshot: this.host.snapshot(current) };
      return this.host.commitEventOnly(generation, current, input, key, plan, maxInFlight, y, preparedContext);
    }

    const claimed = JSON.parse(JSON.stringify(current)) as MachineState;
    const claimedCommand = commandForToken(claimed, command.launchToken)!;
    claim(claimedCommand, `lease-${process.pid}-${claimed.revision + 1}`, claimed.modeEpoch, claimed.writerFence);
    const claimEvent: Event = { kind: 'OBSERVATION', category: 'HOST', ref: this.host.ref(`claim:${command.launchToken}`, { launchToken: command.launchToken, commandDigest: command.commandDigest }, 'outbox') };
    const claimIdentity = this.host.internalIdentity(claimed, claimedCommand, `dispatcher-claim:${command.launchToken}:${claimed.revision + 1}`, claimEvent);
    // Reserve claim -> UNKNOWN recovery shape before invoking external effect.
    try {
      const probe = JSON.parse(JSON.stringify(claimed)) as MachineState;
      appendJournal(probe, claimIdentity, claimEvent, this.host.segmentedJournalEnabled());
      const probeCommand = commandForToken(probe, command.launchToken)!;
      unknown(probeCommand);
      const probeEvidence = this.host.ref(`unknown:${command.launchToken}`, { launchToken: command.launchToken, commandDigest: command.commandDigest, status: 'UNKNOWN' }, 'outbox/recovery');
      const probeRecovery: Event = { kind: 'OBSERVATION', category: 'RECOVERY', ref: probeEvidence };
      appendJournal(probe, this.host.internalIdentity(probe, probeCommand, `dispatcher-unknown:${command.launchToken}:${probe.revision + 1}`, probeRecovery), probeRecovery, this.host.segmentedJournalEnabled());
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
        task.noReceiptOutcome = this.host.commitDispatcherOutcome(token, task.commandDigest, plan, capacity, undefined, leaseId).catch(() => undefined);
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
      void finishUnknown().finally(() => { if (!task.settled) deleteTask(); });
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

  private launchObserve(generation: number, command: OutboxCommand, plan: Plan, capacity: number, processedKey?: string, processedIdentity?: EventIdentity): Promise<Yield | undefined> | undefined {
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
    let normalized: ReturnType<typeof normalizeDriverResult>;
    try { normalized = normalizeDriverResult(Reflect.apply(observe, driver.receiver, [token, controller.signal]), true); }
    catch { deleteTask(); return Promise.resolve(undefined); }
    const finish = (value: DriverReceipt | undefined, immediate = false): Promise<Yield | undefined> => {
      if (!value) return Promise.resolve(undefined);
      if (value.launchToken !== token || value.commandDigest !== command.commandDigest) return Promise.resolve(undefined);
      try { this.host.validateRef(value.ref); } catch { return Promise.resolve(undefined); }
      return this.host.commitDispatcherOutcome(token, command.commandDigest, plan, capacity, value, undefined, command.leaseId).then(async (result) => {
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
    if (normalized.kind === 'ABSENT' || normalized.kind === 'INVALID') {
      task.settled = true;
      deleteTask();
      return Promise.resolve(undefined);
    }
    if (normalized.kind === 'RECEIPT') return finish(normalized.receipt, true).finally(() => { task.settled = true; deleteTask(); });
    const timer = setTimeout(() => { task.timedOut = true; controller.abort(); deleteTask(); }, this.options.timeoutMs);
    normalized.receipt.then((value) => { clearTimeout(timer); task.settled = true; void finish(value).finally(deleteTask); }, () => { clearTimeout(timer); task.settled = true; deleteTask(); });
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
