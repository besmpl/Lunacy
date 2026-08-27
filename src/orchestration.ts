import { canonicalString, digest } from './canonical.js';
import { resolve } from 'node:path';
import { canonicalizeDeclaration, transition, type BridgeOptions, type BridgeResult, type BridgeTransition } from './bridge.js';
import { FileArtifactStore, isFileArtifactStoreAbort } from './store.js';
import { inspectTrustedPath, sameFilesystemIdentity, type FilesystemIdentity } from './filesystem.js';
import type { EffectDriver } from './driver.js';
import type { Event, MachineState, OutboxCommand, Plan, Ref, Yield } from './model.js';
import { validateTerminalRecord, type TerminalRecord } from './codex-effect-records.js';
import { codexHostPolicyDigest, validateCodexHostPolicy, type CodexHostPolicy } from './codex-host-policy.js';
import { assertReleaseAdmissionOpen } from './release-admission.js';

/** Optional evidence waiter implemented by managed effect drivers.  It is
 * deliberately outside EffectDriver: the kernel only needs dispatch and
 * observe, while a drive pump may wait for a terminal witness after receipt. */
export type TerminalEffectDriver = EffectDriver & {
  /** Present only on the managed Codex driver. The pump binds this immutable
   * policy to the bridge/kernel authority before it may issue RESUME. */
  readonly hostPolicy?: CodexHostPolicy;
  waitTerminal?: (launchToken: string, signal?: AbortSignal) => Promise<TerminalRecord | undefined>;
  terminal?: (launchToken: string, signal?: AbortSignal) => Promise<TerminalRecord | undefined>;
  cancel?: (launchToken: string) => Promise<void>;
};

export type BridgeDriveOptions = Omit<BridgeOptions, 'mode' | 'driver' | 'dispatcher'> & {
  plan: Plan;
  driver: TerminalEffectDriver;
  signal?: AbortSignal;
  dispatcher?: BridgeOptions['dispatcher'];
  /** Mechanical safety bound only; it is not a durable queue/cursor. */
  maxTransitions?: number;
};

export type BridgeDriveStop =
  | 'parent-boundary'
  | 'cancelled'
  | 'limit'
  | 'terminal-unavailable'
  | 'terminal-invalid';

export type BridgeDriveResult = BridgeResult & {
  stopped: BridgeDriveStop;
  transitions: number;
  terminal?: TerminalRecord;
};

type Loaded = { state: MachineState | undefined };
type ManagedDriveAuthority = Readonly<{
  rootIdentity: FilesystemIdentity;
  runRoot: string;
  runId: string;
  planDigest: string;
  policyDigest: string;
}>;

function workerRef(token: string, status: string) {
  const payload = { status };
  const bytes = canonicalString(payload);
  return { id: `worker:${token}`, scope: 'codex/worker', digest: digest(payload), bytes };
}

function currentCommand(state: MachineState | undefined): OutboxCommand | undefined {
  if (!state) return undefined;
  const commands = Object.values(state.outbox);
  return commands.find((command) => command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN')
    ?? commands.find((command) => command.state === 'ACKED'
      && command.attemptEpoch === state.attemptEpoch
      && command.authorityEpoch === state.authorityEpoch
      && command.barrierEpoch === state.barrierEpoch
      && command.modeEpoch === state.modeEpoch
      && state.steps[command.stepId]?.status === 'ACTIVE');
}

function parentBoundary(yieldValue: Yield): boolean {
  return yieldValue.kind === 'FINAL' || yieldValue.kind === 'DECISION_REQUIRED' || yieldValue.kind === 'BLOCKED'
    || yieldValue.snapshot.runStatus === 'BLOCKED' || yieldValue.snapshot.gate === 'DUE' || yieldValue.snapshot.gate === 'FINDINGS'
    || yieldValue.snapshot.barrier === 'CLOSED';
}

function transitionInput(runId: string, state: MachineState | undefined, eventId: string, event: Event, launchToken?: string): BridgeTransition {
  return {
    event,
    eventId,
    ...(state?.revision === undefined ? {} : { expectedRevision: state.revision }),
    ...(state?.phaseId === undefined ? {} : { phaseId: state.phaseId }),
    stepId: 'run',
    ...(state === undefined ? {} : { attemptEpoch: state.attemptEpoch, authorityEpoch: state.authorityEpoch, barrierEpoch: state.barrierEpoch }),
    ...(launchToken === undefined ? {} : { launchToken }),
  };
}

function aborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }

function validReceiptRef(value: unknown): value is Ref {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (typeof ref.id !== 'string' || ref.id.length === 0 || typeof ref.scope !== 'string' || ref.scope.length === 0 || typeof ref.digest !== 'string' || !/^[0-9a-f]{64}$/.test(ref.digest) || typeof ref.bytes !== 'string') return false;
  try { const parsed = JSON.parse(ref.bytes); return canonicalString(parsed) === ref.bytes && digest(parsed) === ref.digest; }
  catch { return false; }
}

function abortError(): Error { const error = new Error('drive cancelled'); error.name = 'AbortError'; return error; }

/**
 * Ephemeral mechanical host loop. It owns no scheduler state: every command,
 * token, epoch, and successor comes from the kernel's verified CURRENT state.
 * The loop stops at the first parent boundary and can be recreated after a
 * process restart from the same run root.
 */
export class BridgeDrivePump {
  private readonly options: BridgeDriveOptions;
  private readonly driver: TerminalEffectDriver;
  private readonly signal?: AbortSignal;
  private readonly maxTransitions: number;
  private readonly managedPolicy?: CodexHostPolicy;
  private managedAuthority?: ManagedDriveAuthority;
  private transitions = 0;
  private last?: BridgeResult;
  /**
   * Dispatch outcomes can arrive after the transition that started an effect
   * returns. Keep one pump-owned channel instead of replacing an
   * invocation-local promise on every transition: a late callback must wake
   * whichever waiter is currently attached, while an early callback must be
   * retained until the waiter arrives. Tag each entry with its launch token so
   * a stale callback cannot wake a successor's waiter.
   */
  private readonly notificationQueue: Array<{ value: Yield; launchToken?: string }> = [];
  private notificationWaiter?: {
    launchToken?: string;
    resolve: (value: Yield) => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  };
  private notificationsClosed = false;

  constructor(options: BridgeDriveOptions) {
    if (!options || typeof options !== 'object') throw new Error('BridgeDrivePump: options are required');
    if (!options.plan || typeof options.plan !== 'object') throw new Error('BridgeDrivePump: plan is required');
    if (!options.driver || typeof options.driver !== 'object' || typeof options.driver.dispatch !== 'function') throw new Error('BridgeDrivePump: driver is required');
    if (options.maxTransitions !== undefined && (!Number.isSafeInteger(options.maxTransitions) || options.maxTransitions < 1)) throw new Error('BridgeDrivePump: maxTransitions must be positive');
    const plan = canonicalizeDeclaration(options.plan);
    this.options = Object.freeze({ ...options, plan });
    this.driver = options.driver;
    this.signal = options.signal;
    this.maxTransitions = options.maxTransitions ?? 1024;
    const hostPolicy = options.driver.hostPolicy;
    if (hostPolicy !== undefined) this.managedPolicy = validateCodexHostPolicy(hostPolicy);
  }

  /** Run until the kernel yields a parent boundary or cancellation occurs. */
  async run(): Promise<BridgeDriveResult> {
    try {
      try { return await this.runLoop(); }
      catch (error) {
        if (isFileArtifactStoreAbort(error) && aborted(this.signal)) {
          return this.last ? this.finish('cancelled', this.last) : this.emptyResult('cancelled');
        }
        // A competing pump may win the bridge lock and advance the same exact
        // frame between our verified load and transition. Treat that stale
        // caller view as a parent wake-up, never as a second launch or a retry.
        const code = (error as { code?: unknown }).code;
        if (code === 'Conflict' || (error instanceof Error && /stale|barrier is closed|epoch fence/i.test(error.message))) {
          if (this.last) return this.finish('parent-boundary', this.last);
          return this.emptyResult('parent-boundary');
        }
        throw error;
      }
    } finally {
      // A late effect callback may still run after the pump has returned. It
      // is no longer actionable; close the channel so it cannot retain a
      // dangling promise or queue stale wake-ups for a later run.
      this.closeNotifications();
    }
  }

  private async runLoop(): Promise<BridgeDriveResult> {
    if (aborted(this.signal)) return this.emptyResult('cancelled');
    await this.establishManagedAuthority();
    let loaded = await this.load();
    if (aborted(this.signal)) { await this.cancelCurrentEffect(loaded.state); return this.emptyResult('cancelled'); }
    let result: BridgeResult;
    if (!loaded.state) {
      if (aborted(this.signal)) return this.emptyResult('cancelled');
      const startEvent: Event = { kind: 'START', intentRef: { id: 'plan', scope: 'plan', digest: digest(this.options.plan), bytes: canonicalString(this.options.plan) } };
      result = await this.invoke(transitionInput(this.options.runId, undefined, 'drive-start', startEvent));
    } else {
      const initialCommand = currentCommand(loaded.state);
      result = await this.resume(loaded.state, initialCommand, initialCommand?.state === 'UNKNOWN');
    }
    this.last = result;

    for (;;) {
      if (aborted(this.signal)) { await this.cancelCurrentEffect(); return this.finish('cancelled', result); }
      if (result.yield?.kind === 'BLOCKED' && result.yield.code === 'UnknownDispatch') {
        // A restart recovery call intentionally returns UnknownDispatch while
        // the exact old token is UNKNOWN. Give observe() one bounded chance to
        // prove the immutable launch before waking the parent; this is not a
        // retry or a new claim.
        const recovered = await this.reconcileUnknown();
        if (aborted(this.signal)) { await this.cancelCurrentEffect(); return this.finish('cancelled', result); }
        if (recovered) { result = recovered; this.last = result; continue; }
        return this.finish('parent-boundary', result);
      }
      if (result.yield && parentBoundary(result.yield)) return this.finish('parent-boundary', result);
      if (this.transitions >= this.maxTransitions) return this.finish('limit', result);
      loaded = await this.load();
      if (aborted(this.signal)) { await this.cancelCurrentEffect(loaded.state); return this.finish('cancelled', result); }
      const state = loaded.state;
      if (!state) return this.finish('terminal-invalid', result);
      const command = currentCommand(state);
      if (!command) {
        // A completion check is still a kernel call; the pump never derives
        // phase readiness from Markdown or from its own queue.
        result = await this.resume(state);
        this.last = result;
        continue;
      }
      if (command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN') {
        // Kernel UNKNOWN recovery is intentionally suppressed here. The pump
        // performs the one exact-token observe itself, so an async/absent
        // observer cannot be started twice by repeated RESUME calls.
        result = await this.resume(state, command, command.state === 'UNKNOWN');
        this.last = result;
        if (result.yield?.kind === 'WAITING' && (command.state === 'PENDING' || command.state === 'CLAIMED')) {
          // A competing pump may have entered the same claimed lease. If its
          // immutable launch receipt is already visible, reconcile that exact
          // token directly instead of waiting on a callback owned by another
          // in-process pump.
          const latest = await this.load();
          const current = latest.state && Object.values(latest.state.outbox).find((candidate) => candidate.launchToken === command.launchToken && candidate.commandDigest === command.commandDigest);
          const observed = command.state === 'CLAIMED' && current && await this.observeReceipt(current);
          if (observed) { result = observed; this.last = result; continue; }
          // A synchronous receipt may have ACKED before this load. Only wait
          // while the exact command is still CLAIMED; PENDING means the
          // kernel's claim/dispatch transition has not published its wake yet.
          if (!current || current.state !== 'CLAIMED') continue;
          // Dispatch receipt/UNKNOWN publication is signalled by the kernel's
          // detached onYield callback. No timer or status polling is used.
          try {
            const wake = await this.waitNotification(command.launchToken);
            result = { ...result, yield: wake };
            this.last = result;
          } catch (error) {
            if ((error as Error).name === 'AbortError') {
              await this.cancel(command.launchToken);
              return this.finish('cancelled', result);
            }
            throw error;
          }
        }
        continue;
      }

      let rawTerminal: unknown;
      try { rawTerminal = await this.waitTerminal(command.launchToken); }
      catch (error) {
        if ((error as Error).name === 'AbortError') {
          await this.cancel(command.launchToken);
          return this.finish('cancelled', result);
        }
        // A waiter is an untrusted effect boundary.  An exception or a
        // malformed witness is fail-closed: wake the parent rather than
        // treating an uncertain worker outcome as a retryable launch.
        return this.finish('terminal-invalid', result);
      }
      if (!rawTerminal) return this.finish('terminal-unavailable', result);
      let terminal: TerminalRecord;
      try { terminal = validateTerminalRecord(rawTerminal); }
      catch { return this.finish('terminal-invalid', result); }
      if (terminal.launchToken !== command.launchToken || terminal.commandDigest !== command.commandDigest) return this.finish('terminal-invalid', result, terminal);
      if (terminal.status === 'UNKNOWN') return this.finish('terminal-invalid', result, terminal);
      if (terminal.status === 'PASS' && terminal.outcome !== 'normal-completion') return this.finish('terminal-invalid', result, terminal);
      const workerStatus = terminal.status === 'PASS' ? 'DONE' : terminal.status;
      const event: Event = { kind: 'WORKER_ENVELOPE', ref: workerRef(command.launchToken, workerStatus) };
      result = await this.invoke(transitionInput(this.options.runId, state, `drive-worker:${command.launchToken}`, event, command.launchToken));
      this.last = result;
      if (terminal.status !== 'PASS') return this.finish('parent-boundary', result, terminal);
      // PASS only mechanically permits another kernel call. The next loop
      // selects whatever the committed runtime admits; no batch is formed.
    }
  }

  async drive(): Promise<BridgeDriveResult> { return this.run(); }

  private async load(): Promise<Loaded> {
    const trusted = await inspectTrustedPath(this.options.runDir, 'drive run root', { allowMissing: true, surface: true, kind: 'directory' });
    if (!trusted) return { state: undefined };
    const snapshot = await new FileArtifactStore(this.options.runDir, trusted.identity).load(this.signal);
    await this.verifyManagedAuthority(snapshot.state);
    return { state: snapshot.state };
  }

  private async resume(state: MachineState, command?: OutboxCommand, suppressObserve = false): Promise<BridgeResult> {
    await this.verifyManagedAuthority(state);
    const token = command?.launchToken;
    const event: Event = { kind: 'RESUME' };
    const id = command === undefined ? `drive-resume:${state.revision}` : `drive-resume:${token}`;
    if (!suppressObserve) return this.invoke(transitionInput(this.options.runId, state, id, event, token));
    // For an UNKNOWN command, use a driver view without observe() only for
    // this kernel call. The durable RESUME records the blocked boundary;
    // reconcileUnknown() below owns the single direct evidence lookup.
    const noObserve: TerminalEffectDriver = { dispatch: this.driver.dispatch };
    return this.invoke(transitionInput(this.options.runId, state, id, event, token), noObserve);
  }

  private async invoke(input: BridgeTransition, driverOverride: TerminalEffectDriver = this.driver): Promise<BridgeResult> {
    if (this.transitions >= this.maxTransitions) throw new Error('BridgeDrivePump: transition limit reached');
    this.transitions += 1;
    const prior = this.options.dispatcher;
    const onYield = (value: Yield): void => {
      this.enqueueNotification(value, input.launchToken);
      try {
        const callback = prior?.onYield;
        if (callback) void Promise.resolve(callback(value)).catch(() => undefined);
      } catch { /* notifications never gate the kernel */ }
    };
    const options: BridgeOptions = {
        ...this.options,
        mode: 'runtime',
        driver: driverOverride,
        dispatcher: { ...prior, signal: this.signal ?? prior?.signal, onYield },
    };
    let result: BridgeResult;
    try { result = await transition(options, input); }
    catch (error) {
      if (isFileArtifactStoreAbort(error) && aborted(this.signal) && input.launchToken !== undefined) await this.cancel(input.launchToken);
      throw error;
    }
    this.last = result;
    return result;
  }

  private async waitNotification(launchToken: string): Promise<Yield> {
    if (aborted(this.signal)) throw abortError();
    const queuedIndex = this.notificationQueue.findIndex((entry) => entry.launchToken === launchToken);
    if (queuedIndex >= 0) return this.notificationQueue.splice(queuedIndex, 1)[0]!.value;
    if (this.notificationsClosed) throw new Error('BridgeDrivePump: notification channel is closed');
    if (this.notificationWaiter) throw new Error('BridgeDrivePump: notification waiter already exists');
    return new Promise<Yield>((resolvePromise, rejectPromise) => {
      let settled = false;
      let waiter: {
        launchToken?: string;
        resolve: (value: Yield) => void;
        reject: (error: unknown) => void;
        cleanup: () => void;
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        if (this.notificationWaiter === waiter) this.notificationWaiter = undefined;
        waiter.cleanup();
        rejectPromise(abortError());
      };
      const cleanup = (): void => { this.signal?.removeEventListener('abort', onAbort); };
      waiter = {
        launchToken,
        resolve: (value: Yield): void => {
          if (settled) return;
          settled = true;
          if (this.notificationWaiter === waiter) this.notificationWaiter = undefined;
          cleanup();
          resolvePromise(value);
        },
        reject: (error: unknown): void => {
          if (settled) return;
          settled = true;
          if (this.notificationWaiter === waiter) this.notificationWaiter = undefined;
          cleanup();
          rejectPromise(error);
        },
        cleanup,
      };
      this.notificationWaiter = waiter;
      this.signal?.addEventListener('abort', onAbort, { once: true });
      if (this.notificationsClosed) waiter.reject(new Error('BridgeDrivePump: notification channel is closed'));
    });
  }

  private enqueueNotification(value: Yield, launchToken?: string): void {
    if (this.notificationsClosed) return;
    const waiter = this.notificationWaiter;
    if (waiter && waiter.launchToken === launchToken) {
      waiter.resolve(value);
      return;
    }
    this.notificationQueue.push({ value, launchToken });
  }

  private closeNotifications(): void {
    if (this.notificationsClosed) return;
    this.notificationsClosed = true;
    this.notificationQueue.length = 0;
    const waiter = this.notificationWaiter;
    this.notificationWaiter = undefined;
    if (waiter) {
      waiter.cleanup();
      waiter.reject(new Error('BridgeDrivePump: notification channel is closed'));
    }
  }

  private async cancel(token: string): Promise<void> {
    if (!this.driver.cancel) return;
    try { await Promise.resolve(this.driver.cancel(token)); }
    catch { /* cancellation is best effort; the durable token remains fenced */ }
  }

  private async cancelCurrentEffect(state?: MachineState): Promise<void> {
    try {
      const currentState = state ?? (await this.load()).state;
      const command = currentCommand(currentState);
      if (command) await this.cancel(command.launchToken);
    } catch { /* the durable claimed/unknown token remains the successor fence */ }
  }

  private async waitTerminal(token: string): Promise<unknown> {
    await this.verifyManagedAuthority((await this.load()).state);
    if (aborted(this.signal)) throw abortError();
    const task = typeof this.driver.waitTerminal === 'function'
      ? this.driver.waitTerminal(token, this.signal)
      : typeof this.driver.terminal === 'function'
        ? this.driver.terminal(token, this.signal)
        : undefined;
    if (!task) return undefined;
    let onAbort: (() => void) | undefined;
    let abortPromise: Promise<undefined> | undefined;
    if (this.signal) {
      abortPromise = new Promise<undefined>((_, rejectPromise) => {
        onAbort = (): void => { rejectPromise(abortError()); };
        this.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    let terminal: TerminalRecord | undefined;
    try { terminal = this.signal === undefined ? await task : await Promise.race([task, abortPromise!]); }
    finally { if (this.signal && onAbort) this.signal.removeEventListener('abort', onAbort); }
    if (aborted(this.signal)) throw abortError();
    return terminal;
  }

  private async reconcileUnknown(): Promise<BridgeResult | undefined> {
    const loaded = await this.load();
    const command = loaded.state && Object.values(loaded.state.outbox).find((candidate) => candidate.state === 'UNKNOWN');
    if (!command) return undefined;
    return this.observeReceipt(command, loaded.state);
  }

  private async observeReceipt(command: OutboxCommand, state?: MachineState): Promise<BridgeResult | undefined> {
    try { await this.verifyManagedAuthority(state ?? (await this.load()).state); }
    catch { return undefined; }
    if (typeof this.driver.observe !== 'function') return undefined;
    let observed: Awaited<ReturnType<NonNullable<EffectDriver['observe']>>>;
    try { observed = await this.driver.observe(command.launchToken, this.signal); }
    catch { return undefined; }
    try {
      if (!observed || observed.launchToken !== command.launchToken || observed.commandDigest !== command.commandDigest || !validReceiptRef(observed.ref)) return undefined;
    } catch { return undefined; }
    const value = { launchToken: command.launchToken, commandDigest: command.commandDigest, receipt: observed.ref };
    const event: Event = { kind: 'DISPATCH_RECEIPT', ref: { id: `receipt:${command.launchToken}`, scope: 'outbox/receipt', digest: digest(value), bytes: canonicalString(value) } };
    try { return await this.invoke(transitionInput(this.options.runId, state, `drive-receipt:${command.launchToken}`, event, command.launchToken)); }
    catch { return undefined; }
  }

  private finish(stopped: BridgeDriveStop, result: BridgeResult, terminal?: TerminalRecord): BridgeDriveResult {
    return { ...result, stopped, transitions: this.transitions, ...(terminal === undefined ? {} : { terminal }) };
  }

  private emptyResult(stopped: BridgeDriveStop): BridgeDriveResult {
    const empty: BridgeResult = { mode: 'runtime', projected: false, counters: Object.freeze({ declarationReads: 0, declarationBytes: 0, runtimeReads: 0, runtimeBytes: 0, projectionReads: 0, projectionBytesRead: 0, projectionWrites: 0, projectionBytesWritten: 0, routineWakeups: 0, transitions: 0 }) };
    return { ...empty, stopped, transitions: this.transitions };
  }

  private async establishManagedAuthority(): Promise<void> {
    if (!this.managedPolicy) return;
    const runRoot = resolve(this.options.runDir);
    await assertReleaseAdmissionOpen(runRoot);
    const root = await inspectTrustedPath(runRoot, 'managed drive run root', { surface: true, kind: 'directory' });
    if (!root) throw new Error('BridgeDrivePump: managed drive run root is absent');
    const planDigest = digest(this.options.plan);
    if (this.managedPolicy.runRoot !== runRoot) throw new Error('BridgeDrivePump: managed policy run root mismatch');
    if (this.managedPolicy.runId !== this.options.runId) throw new Error('BridgeDrivePump: managed policy run id mismatch');
    if (this.managedPolicy.planDigest !== planDigest) throw new Error('BridgeDrivePump: managed policy input plan mismatch');
    this.managedAuthority = Object.freeze({
      rootIdentity: root.identity,
      runRoot,
      runId: this.options.runId,
      planDigest,
      policyDigest: codexHostPolicyDigest(this.managedPolicy),
    });
  }

  /** Recheck both sides of the private composition. This runs on every load
   * and immediately before restart observation/terminal acceptance, so a
   * caller cannot swap policy, root, or committed plan after the first check. */
  private async verifyManagedAuthority(state: MachineState | undefined): Promise<void> {
    const authority = this.managedAuthority;
    if (!authority) return;
    const currentPolicy = this.driver.hostPolicy;
    if (currentPolicy === undefined) throw new Error('BridgeDrivePump: managed policy disappeared');
    let checked: CodexHostPolicy;
    try { checked = validateCodexHostPolicy(currentPolicy); }
    catch { throw new Error('BridgeDrivePump: managed policy is invalid'); }
    if (codexHostPolicyDigest(checked) !== authority.policyDigest
      || checked.runRoot !== authority.runRoot
      || checked.runId !== authority.runId
      || checked.planDigest !== authority.planDigest) throw new Error('BridgeDrivePump: managed policy changed');
    const root = await inspectTrustedPath(authority.runRoot, 'managed drive run root', { surface: true, kind: 'directory' });
    if (!root || !sameFilesystemIdentity(authority.rootIdentity, root.identity)) throw new Error('BridgeDrivePump: managed drive run root identity changed');
    if (state && (state.runId !== authority.runId || state.planDigest !== authority.planDigest)) throw new Error('BridgeDrivePump: committed run/plan differs from managed authority');
  }
}

export async function drive(options: BridgeDriveOptions): Promise<BridgeDriveResult> {
  return new BridgeDrivePump(options).run();
}
