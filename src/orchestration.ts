import { canonicalString, digest } from './canonical.js';
import { resolve } from 'node:path';
import { canonicalizeDeclaration, transition, type BridgeOptions, type BridgeProjection, type BridgeResult, type BridgeTransition } from './bridge.js';
import { FileArtifactStore, isFileArtifactStoreAbort } from './store.js';
import { inspectTrustedPath } from './filesystem.js';
import type { EffectDriver } from './driver.js';
import type { Event, MachineState, OutboxCommand, Plan, Yield } from './model.js';
import { validateTerminalRecord, type TerminalRecord } from './codex-effect-records.js';
import { validateCodexHostPolicy, type CodexHostPolicy } from './codex-host-policy.js';
import { makeCodexExecDriver } from './codex-exec-driver.js';
import type { DispatcherOptions } from './public.js';
import { assertReleaseAdmissionOpen } from './release-admission.js';
import { selectCurrentTokenCommand, selectEligibleCommand } from './dispatch-coordinator.js';

/** Optional evidence waiter implemented by managed effect drivers.  It is
 * deliberately outside EffectDriver: the kernel only needs dispatch and
 * observe, while a drive pump may wait for a terminal witness after receipt. */
export type TerminalEffectDriver = EffectDriver & {
  /** Present only on the managed Codex driver. The pump binds this immutable
   * policy to the bridge/kernel authority before it may issue RESUME. */
  readonly hostPolicy?: CodexHostPolicy;
  waitTerminal?: (launchToken: string, signal?: AbortSignal, retainedCommand?: OutboxCommand) => Promise<TerminalRecord | undefined>;
  terminal?: (launchToken: string, signal?: AbortSignal, retainedCommand?: OutboxCommand) => Promise<TerminalRecord | undefined>;
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
function workerRef(token: string, status: string) {
  const payload = { status };
  const bytes = canonicalString(payload);
  return { id: `worker:${token}`, scope: 'codex/worker', digest: digest(payload), bytes };
}

function currentCommand(state: MachineState | undefined): OutboxCommand | undefined {
  return selectEligibleCommand(state, ['PENDING', 'CLAIMED', 'UNKNOWN', 'ACKED'])?.command;
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
          if (this.transitions < this.maxTransitions && !aborted(this.signal)) return await this.runLoop();
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
      result = await this.resume(loaded.state, initialCommand);
    }
    this.last = result;

    for (;;) {
      if (aborted(this.signal)) { await this.cancelCurrentEffect(); return this.finish('cancelled', result); }
      if (result.yield?.kind === 'BLOCKED' && result.yield.code === 'UnknownDispatch' && result.yield.launchToken && typeof this.driver.observe === 'function') {
        const unknownToken = result.yield.launchToken;
        try {
          const wake = await this.waitNotification(unknownToken);
          result = { ...result, yield: wake };
          this.last = result;
          continue;
        } catch (error) {
          if ((error as Error).name === 'AbortError') {
            await this.cancel(unknownToken);
            return this.finish('cancelled', result);
          }
          throw error;
        }
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
        result = await this.resume(state, command);
        this.last = result;
        if (result.yield?.kind === 'WAITING' && (command.state === 'PENDING' || command.state === 'CLAIMED')) {
          const latest = await this.load();
          const current = selectCurrentTokenCommand(latest.state, ['PENDING', 'CLAIMED', 'UNKNOWN', 'ACKED'], command)?.command;
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
      try { rawTerminal = await this.waitTerminal(command); }
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
      const terminalState = (await this.load()).state;
      const terminalSelection = selectCurrentTokenCommand(terminalState, ['ACKED'], command);
      if (!terminalState) return this.finish('terminal-invalid', result, terminal);
      const workerStatus = terminal.status === 'PASS' ? 'DONE' : terminal.status;
      const event: Event = { kind: 'WORKER_ENVELOPE', ref: workerRef(command.launchToken, workerStatus) };
      const workerInput = transitionInput(this.options.runId, terminalState, `drive-worker:${command.launchToken}`, event, command.launchToken);
      if (!terminalSelection) {
        // A competing pump may already have committed this exact envelope.
        // Ask the kernel's processed-identity replay path; never infer success
        // from the terminal record or current gate in the pump.
        workerInput.attemptEpoch = command.attemptEpoch;
        workerInput.authorityEpoch = command.authorityEpoch;
        workerInput.barrierEpoch = command.barrierEpoch;
      }
      result = await this.invoke(workerInput);
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
    return { state: snapshot.state };
  }

  private async resume(state: MachineState, command?: OutboxCommand): Promise<BridgeResult> {
    const token = command?.launchToken;
    const event: Event = { kind: 'RESUME' };
    const id = command === undefined ? `drive-resume:${state.revision}` : `drive-resume:${token}`;
    return this.invoke(transitionInput(this.options.runId, state, id, event, token));
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

  private async waitTerminal(command: OutboxCommand): Promise<unknown> {
    if (aborted(this.signal)) throw abortError();
    const token = command.launchToken;
    const task = typeof this.driver.waitTerminal === 'function'
      ? this.driver.waitTerminal(token, this.signal, command)
      : typeof this.driver.terminal === 'function'
        ? this.driver.terminal(token, this.signal, command)
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
  }
}

export async function drive(options: BridgeDriveOptions): Promise<BridgeDriveResult> {
  return new BridgeDrivePump(options).run();
}


/**
 * Private, additive per-run lifecycle boundary.  This module composes the
 * existing bridge transition and mechanical drive pump; it owns no durable
 * state and is intentionally not exported from the package root.
 */
export const LIFECYCLE_SCHEMA = 'lunacy-lifecycle/v1' as const;
export const LIFECYCLE_VERSION = 1 as const;

export type LifecycleCommand = 'init' | 'run' | 'resume';
export type LifecycleStatus = 'terminal' | 'attention';
export type LifecycleStop = 'initialized' | BridgeDriveStop;

export type LifecycleOptions = Readonly<{
  command?: LifecycleCommand;
  runDir: string;
  runId: string;
  /** Parent-owned canonical runtime declaration. Markdown is never parsed. */
  plan: Plan;
  statePath?: string;
  stepsPath?: string;
  driver?: TerminalEffectDriver;
  /** Closed managed host policy. A driver and policy are mutually exclusive. */
  policy?: CodexHostPolicy;
  dispatcher?: DispatcherOptions;
  signal?: AbortSignal;
  maxTransitions?: number;
  /** Stable START identity; retries use the same event id for exact replay. */
  startEventId?: string;
}>;

export type LifecycleAttention = Readonly<{
  stop: LifecycleStop;
  kind?: Yield['kind'];
  code?: string;
  token?: string;
}>;

export type LifecycleResult = Readonly<{
  schema: typeof LIFECYCLE_SCHEMA;
  version: typeof LIFECYCLE_VERSION;
  command: LifecycleCommand;
  status: LifecycleStatus;
  stop: LifecycleStop;
  /** Alias used by structured hosts; `stop` remains the canonical key. */
  stopReason: LifecycleStop;
  transitions: number;
  projected: boolean;
  projection?: BridgeProjection;
  counters: BridgeResult['counters'];
  yield?: Yield;
  terminal?: BridgeDriveResult['terminal'];
  attention?: LifecycleAttention;
}>;

export type LifecycleErrorCode =
  | 'InvalidInput'
  | 'InvalidPlan'
  | 'InvalidPolicy'
  | 'PolicyMismatch'
  | 'ProjectionFailed';

/** Stable, non-sensitive controller input/error boundary. */
export class LifecycleError extends Error {
  constructor(public readonly code: LifecycleErrorCode, message: string) {
    super(message);
    this.name = `Lifecycle${code}`;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateInput(options: LifecycleOptions, command: LifecycleCommand): Plan {
  if (!plainObject(options)) throw new LifecycleError('InvalidInput', 'lifecycle options are required');
  if (!['init', 'run', 'resume'].includes(command)) throw new LifecycleError('InvalidInput', 'lifecycle command is invalid');
  if (typeof options.runDir !== 'string' || options.runDir.length === 0 || !options.runDir.startsWith('/') || resolve(options.runDir) !== options.runDir) throw new LifecycleError('InvalidInput', 'runDir must be an absolute path');
  if (typeof options.runId !== 'string' || options.runId.length === 0) throw new LifecycleError('InvalidInput', 'runId is required');
  if (options.startEventId !== undefined && (typeof options.startEventId !== 'string' || options.startEventId.length === 0)) throw new LifecycleError('InvalidInput', 'startEventId is invalid');
  if (options.maxTransitions !== undefined && (!Number.isSafeInteger(options.maxTransitions) || options.maxTransitions < 1)) throw new LifecycleError('InvalidInput', 'maxTransitions must be positive');
  let plan: Plan;
  try { plan = canonicalizeDeclaration(options.plan); }
  catch (error) { throw new LifecycleError('InvalidPlan', error instanceof Error ? error.message : String(error)); }
  return plan;
}

function validatePolicyBinding(options: LifecycleOptions, plan: Plan): void {
  if (options.driver !== undefined && options.policy !== undefined) throw new LifecycleError('InvalidPolicy', 'driver and policy are mutually exclusive');
  let suppliedPolicy: CodexHostPolicy | undefined;
  try { suppliedPolicy = options.policy ?? options.driver?.hostPolicy; }
  catch { throw new LifecycleError('InvalidPolicy', 'managed driver policy is unavailable'); }
  if (suppliedPolicy === undefined) return;
  let policy: CodexHostPolicy;
  try { policy = validateCodexHostPolicy(suppliedPolicy); }
  catch (error) { throw new LifecycleError('InvalidPolicy', error instanceof Error ? error.message : String(error)); }
  const expectedPlanDigest = digest(plan);
  if (policy.runId !== options.runId || policy.runRoot !== resolve(options.runDir) || policy.planDigest !== expectedPlanDigest) {
    throw new LifecycleError('PolicyMismatch', 'managed policy does not match run identity or plan');
  }
}

function bindDriver(options: LifecycleOptions, plan: Plan): TerminalEffectDriver {
  validatePolicyBinding(options, plan);
  let driver = options.driver;
  if (options.policy !== undefined) {
    try { driver = makeCodexExecDriver({ policy: validateCodexHostPolicy(options.policy) }); }
    catch (error) { throw new LifecycleError('InvalidPolicy', error instanceof Error ? error.message : String(error)); }
  }
  if (!driver || typeof driver !== 'object' || typeof driver.dispatch !== 'function') throw new LifecycleError('InvalidPolicy', 'run/resume requires a valid effect driver or closed policy');
  return driver;
}

function bridgeOptions(options: LifecycleOptions, plan: Plan, driver?: TerminalEffectDriver): BridgeOptions {
  return {
    runDir: options.runDir,
    runId: options.runId,
    mode: 'runtime',
    plan,
    ...(options.statePath === undefined ? {} : { statePath: options.statePath }),
    ...(options.stepsPath === undefined ? {} : { stepsPath: options.stepsPath }),
    ...(driver === undefined ? {} : { driver }),
    ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
  };
}

function resultStatus(yieldValue: Yield | undefined, stop: LifecycleStop): LifecycleStatus {
  if (yieldValue?.kind === 'FINAL' && (yieldValue.status === 'phase-ready' || yieldValue.status === 'complete')) return 'terminal';
  if (stop === 'initialized' && yieldValue?.kind === 'FINAL') return 'terminal';
  return 'attention';
}

function attentionFor(yieldValue: Yield | undefined, stop: LifecycleStop): LifecycleAttention | undefined {
  if (stop === 'initialized') return undefined;
  if (yieldValue?.kind === 'BLOCKED') return { stop, kind: yieldValue.kind, code: yieldValue.code, ...(yieldValue.launchToken === undefined ? {} : { token: yieldValue.launchToken }) };
  if (yieldValue?.kind === 'DECISION_REQUIRED') return { stop, kind: yieldValue.kind, token: yieldValue.token };
  if (yieldValue !== undefined && yieldValue.kind !== 'FINAL') return { stop, kind: yieldValue.kind };
  if (stop !== 'parent-boundary') return { stop };
  return undefined;
}

function fromBridge(command: LifecycleCommand, bridge: BridgeResult, stop: LifecycleStop = 'initialized', transitions = bridge.counters.transitions, terminal?: BridgeDriveResult['terminal']): LifecycleResult {
  const yieldValue = bridge.yield;
  const status = resultStatus(yieldValue, stop);
  const attention = attentionFor(yieldValue, stop);
  return Object.freeze({
    schema: LIFECYCLE_SCHEMA,
    version: LIFECYCLE_VERSION,
    command,
    status,
    stop,
    stopReason: stop,
    transitions,
    projected: bridge.projected,
    ...(bridge.projection === undefined ? {} : { projection: bridge.projection }),
    counters: bridge.counters,
    ...(yieldValue === undefined ? {} : { yield: yieldValue }),
    ...(terminal === undefined ? {} : { terminal }),
    ...(attention === undefined ? {} : { attention }),
  });
}

function fromDrive(command: LifecycleCommand, result: BridgeDriveResult): LifecycleResult {
  return Object.freeze({
    schema: LIFECYCLE_SCHEMA,
    version: LIFECYCLE_VERSION,
    command,
    status: resultStatus(result.yield, result.stopped),
    stop: result.stopped,
    stopReason: result.stopped,
    transitions: result.transitions,
    projected: result.projected,
    ...(result.projection === undefined ? {} : { projection: result.projection }),
    counters: result.counters,
    ...(result.yield === undefined ? {} : { yield: result.yield }),
    ...(result.terminal === undefined ? {} : { terminal: result.terminal }),
    ...(attentionFor(result.yield, result.stopped) === undefined ? {} : { attention: attentionFor(result.yield, result.stopped) }),
  });
}

function emptyLifecycle(command: LifecycleCommand, stop: LifecycleStop): LifecycleResult {
  const counters: BridgeResult['counters'] = Object.freeze({
    declarationReads: 0,
    declarationBytes: 0,
    runtimeReads: 0,
    runtimeBytes: 0,
    projectionReads: 0,
    projectionBytesRead: 0,
    projectionWrites: 0,
    projectionBytesWritten: 0,
    routineWakeups: 0,
    transitions: 0,
  });
  return Object.freeze({
    schema: LIFECYCLE_SCHEMA,
    version: LIFECYCLE_VERSION,
    command,
    status: 'attention' as const,
    stop,
    stopReason: stop,
    transitions: 0,
    projected: false,
    counters,
    attention: { stop },
  });
}

/** Submit the canonical START once. A retry uses bridge/kernel replay and
 * therefore returns the exact committed yield without appending another row. */
export async function initRun(options: LifecycleOptions): Promise<LifecycleResult> {
  const command: LifecycleCommand = 'init';
  const plan = validateInput(options, command);
  validatePolicyBinding(options, plan);
  if (options.signal?.aborted) return emptyLifecycle(command, 'cancelled');
  const event: Event = { kind: 'START', intentRef: { id: 'plan', scope: 'plan', digest: digest(plan), bytes: canonicalString(plan) } };
  const eventId = options.startEventId ?? 'lifecycle-start';
  try {
    const bridge = await transition(bridgeOptions(options, plan), { event, eventId, phaseId: plan.phaseId, stepId: 'run' });
    return fromBridge(command, bridge);
  } catch (error) {
    // Keep established bridge error classes and messages (including
    // ProjectionFailed) visible to callers; the durable START has already been
    // committed if the failure is a post-commit projection fault.
    throw error;
  }
}

/** Drive one selected run to an existing parent boundary. Fresh roots are
 * started by BridgeDrivePump; existing roots resume from verified CURRENT. */
export async function runRun(options: LifecycleOptions): Promise<LifecycleResult> {
  const command: LifecycleCommand = 'run';
  const plan = validateInput(options, command);
  const driver = bindDriver(options, plan);
  const result = await drive({
    ...bridgeOptions(options, plan, driver),
    plan,
    driver,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxTransitions === undefined ? {} : { maxTransitions: options.maxTransitions }),
  } as BridgeDriveOptions);
  return fromDrive(command, result);
}

/** Resume is intentionally the same ephemeral operation as run: the pump
 * decides from verified CURRENT whether this is a fresh START or continuation. */
export async function resumeRun(options: LifecycleOptions): Promise<LifecycleResult> {
  const command: LifecycleCommand = 'resume';
  const plan = validateInput(options, command);
  const driver = bindDriver(options, plan);
  const result = await drive({
    ...bridgeOptions(options, plan, driver),
    plan,
    driver,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxTransitions === undefined ? {} : { maxTransitions: options.maxTransitions }),
  } as BridgeDriveOptions);
  return fromDrive(command, result);
}

/** Dispatch a private lifecycle command. */
export async function lifecycle(options: LifecycleOptions): Promise<LifecycleResult> {
  const command = options?.command ?? 'run';
  if (command === 'init') return initRun(options);
  if (command === 'resume') return resumeRun(options);
  return runRun(options);
}

// Host-friendly aliases; these remain private because this module is not a
// package-root export.
export const init = initRun;
export const run = runRun;
export const resume = resumeRun;

/** Build a compact, canonical result for embedding callers that need bytes. */
export function lifecycleResultBytes(result: LifecycleResult): string {
  return canonicalString(result);
}

/** Small state-free facade for hosts that prefer an object seam. Each method
 * still constructs a fresh bridge/pump invocation; no cursor or scheduler is
 * retained between calls. */
export class LifecycleController {
  private readonly options: LifecycleOptions;
  constructor(options: LifecycleOptions) {
    this.options = Object.freeze({ ...options });
  }
  init(): Promise<LifecycleResult> { return initRun({ ...this.options, command: 'init' }); }
  run(): Promise<LifecycleResult> { return runRun({ ...this.options, command: 'run' }); }
  resume(): Promise<LifecycleResult> { return resumeRun({ ...this.options, command: 'resume' }); }
  drive(): Promise<LifecycleResult> { return this.run(); }
}
