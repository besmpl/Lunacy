import { makeComposedKernel, makeComposedKernelForBridge, type DispatcherOptions, type KernelOptions, type RunKernel } from './public.js';
import type { FilesystemIdentity } from './filesystem.js';
import type { EffectDriver } from './driver.js';
import { validateCodexDeliberationHostPolicy, type CodexDeliberationHostPolicy } from './codex-host-policy.js';
import { CodexDeliberationDriver } from './codex-deliberation-driver.js';
import { commandExecutionOwner } from './execution-plane.js';
import { parseCanonical } from './canonical.js';
import { validateRef as validateDeliberationRef, type DeliberationWave } from './deliberation.js';
import { createManagedRolloutPolicy } from './managed-capability.js';
import { inspectExploreAuthorization } from './explore-authorization.js';
import type { MachineState, OutboxCommand } from './model.js';

export type CompositionOptions = KernelOptions & DispatcherOptions & {
  driver?: EffectDriver;
  /** Closed real Codex host configuration for admitted managed Waves. */
  managedDeliberationPolicy?: CodexDeliberationHostPolicy;
  /** Private invocation-local proof. It is never persisted or projected. */
  exploreAuthorization?: unknown;
  /** Bridge-only barrier resolved after its filesystem operation lock exits. */
  providerGate?: Promise<void>;
  /** Backward/host-friendly aliases for the private controls. */
  dispatchTimeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Nested spelling is accepted for hosts that keep dispatcher policy grouped. */
  dispatcher?: DispatcherOptions;
};

/**
 * Copy only the supported own-enumerable nested dispatcher controls.  The
 * composition options object may be reused as `dispatcher`; snapshotting the
 * native own-key order avoids reading unrelated caller-owned values/getters.
 */
function projectDispatcher(dispatcher: DispatcherOptions | undefined): DispatcherOptions {
  if (dispatcher === undefined || dispatcher === null) return {};
  const projected = Object.create(null) as DispatcherOptions;
  const supported = new Set(['timeoutMs', 'signal', 'onYield']);
  // Native object spread processes the initial own-key list in its native
  // order, then rechecks each descriptor immediately before reading it.  Keep
  // that transition/order behavior while never reading unrelated values.
  for (const key of Object.getOwnPropertyNames(dispatcher)) {
    if (!supported.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(dispatcher, key);
    if (!descriptor?.enumerable) continue;
    if (key === 'timeoutMs') projected.timeoutMs = dispatcher.timeoutMs;
    else if (key === 'signal') projected.signal = dispatcher.signal;
    else projected.onYield = dispatcher.onYield;
  }
  return projected;
}

const COMPOSITION_CONTROL_KEYS = new Set([
  'driver', 'managedDeliberationPolicy', 'exploreAuthorization', 'providerGate', 'dispatcher', 'timeoutMs', 'dispatchTimeoutMs',
  'signal', 'abortSignal', 'onYield', 'maxInFlight',
]);

/**
 * Copy the remaining own-enumerable composition fields without applying
 * native object rest to the caller-owned options object.  The named control
 * reads happen before this helper is called, matching the outer rest order;
 * the key snapshot and descriptor rechecks preserve CopyDataProperties
 * transitions while keeping each accepted value to one read.
 */
function projectKernelOptions(options: CompositionOptions, maxInFlight: number | undefined): KernelOptions {
  const projected = Object.create(null) as KernelOptions;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key === 'string' && COMPOSITION_CONTROL_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor?.enumerable) continue;
    const value = Reflect.get(options, key);
    Object.defineProperty(projected, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(projected, 'maxInFlight', {
    value: maxInFlight,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return projected;
}

type DriverMethods = Readonly<{
  receiver: EffectDriver;
  prepare?: NonNullable<EffectDriver['prepare']>;
  dispatch: EffectDriver['dispatch'];
  observe?: NonNullable<EffectDriver['observe']>;
  observeTeardown?: NonNullable<EffectDriver['observeTeardown']>;
  observeProviderIntent?: NonNullable<EffectDriver['observeProviderIntent']>;
}>;

function snapshotDriver(driver: EffectDriver | undefined): DriverMethods | undefined {
  if (!driver) return undefined;
  return Object.freeze({
    receiver: driver,
    prepare: driver.prepare,
    dispatch: driver.dispatch,
    observe: driver.observe,
    observeTeardown: driver.observeTeardown,
    observeProviderIntent: driver.observeProviderIntent,
  });
}

/** Command-scoped private multiplexer. It owns no route state: durable
 * roleView/predecessor bindings and the pure execution-plane derivation are
 * the only selectors used before and after restart. */
function multiplexDrivers(ordinaryDriver: EffectDriver | undefined, deliberationDriver: EffectDriver): EffectDriver {
  const ordinary = snapshotDriver(ordinaryDriver);
  const deliberation = snapshotDriver(deliberationDriver)!;
  const routeRetained = (command: OutboxCommand | undefined): DriverMethods | undefined => command?.roleView ? deliberation : command ? ordinary : undefined;
  return {
    available(command, state) {
      const owner = commandExecutionOwner(state, command);
      return owner === 'DELIBERATION' ? true : owner === 'ORDINARY' ? ordinary !== undefined : false;
    },
    prepare(command: OutboxCommand, state: MachineState) {
      const owner = commandExecutionOwner(state, command);
      if (owner !== 'DELIBERATION') return;
      if (!command.roleView && deliberation.prepare) Reflect.apply(deliberation.prepare, deliberation.receiver, [command, state]);
    },
    dispatch(command, token, signal) {
      const selected = routeRetained(command);
      if (!selected) throw new Error('command execution plane has no driver');
      return Reflect.apply(selected.dispatch, selected.receiver, [command, token, signal]);
    },
    observe(token, signal, authorityAnchor, retainedCommand) {
      const selected = routeRetained(retainedCommand);
      if (!selected?.observe) return undefined;
      return Reflect.apply(selected.observe, selected.receiver, [token, signal, authorityAnchor, retainedCommand]);
    },
    observeTeardown(token, commandDigest, signal, retainedCommand) {
      const selected = routeRetained(retainedCommand);
      if (!selected?.observeTeardown) return undefined;
      return Reflect.apply(selected.observeTeardown, selected.receiver, [token, commandDigest, signal, retainedCommand]);
    },
    observeProviderIntent(token, commandDigest, retainedCommand) {
      const selected = routeRetained(retainedCommand);
      if (!selected?.observeProviderIntent) return { kind: 'AMBIGUOUS' } as const;
      return Reflect.apply(selected.observeProviderIntent, selected.receiver, [token, commandDigest, retainedCommand]);
    },
  };
}

/** Delay only provider entry; availability, preparation, and recovery reads
 * remain inside the root-bound transition that selected the exact command. */
function afterProviderGate(driver: EffectDriver, gate: Promise<void>): EffectDriver {
  const methods = snapshotDriver(driver)!;
  return {
    ...(driver.available === undefined ? {} : { available: driver.available.bind(driver) }),
    ...(driver.prepare === undefined ? {} : { prepare: driver.prepare.bind(driver) }),
    dispatch(command, token, signal) {
      return gate.then(() => Reflect.apply(methods.dispatch, methods.receiver, [command, token, signal]));
    },
    ...(driver.observe === undefined ? {} : { observe: driver.observe.bind(driver) }),
    ...(driver.observeTeardown === undefined ? {} : { observeTeardown: driver.observeTeardown.bind(driver) }),
    ...(driver.observeProviderIntent === undefined ? {} : { observeProviderIntent: driver.observeProviderIntent.bind(driver) }),
  };
}

/** Private host composition hook; callers still receive only the RunKernel seam. */
function compose(options: CompositionOptions, expectedRootIdentity?: FilesystemIdentity): RunKernel {
  const legacyDriver = options.driver;
  const managedPolicy = options.managedDeliberationPolicy;
  const suppliedExploreAuthorization = options.exploreAuthorization;
  const providerGate = options.providerGate;
  const dispatcher = options.dispatcher;
  const timeoutMs = options.timeoutMs;
  const dispatchTimeoutMs = options.dispatchTimeoutMs;
  const signal = options.signal;
  const abortSignal = options.abortSignal;
  const onYield = options.onYield;
  const maxInFlight = options.maxInFlight;
  const kernelOptions = projectKernelOptions(options, maxInFlight);
  let driver = legacyDriver;
  let exploreAuthorization: unknown;
  const managedWave = options.managedRollout?.wave !== undefined && options.managedRollout.policy.mode !== 'disabled';
  if (managedWave) {
    if (!managedPolicy) throw new Error('managed deliberation host policy is unavailable');
    if (!options.managedRollout?.deliberationPolicy) throw new Error('managed deliberation role policy is unavailable');
    const policy = validateCodexDeliberationHostPolicy(managedPolicy);
    if (options.workspace === undefined) throw new Error('managed deliberation target workspace is required');
    if (policy.targetWorkspace !== options.workspace) throw new Error('managed deliberation target workspace mismatch');
    // Composition independently checks the exact current Wave tuple before
    // forwarding the opaque process-local proof. Kernel admission consumes
    // and checks it again; a loose explicitExplore boolean is never upgraded.
    try {
      const checkedRef = validateDeliberationRef(options.managedRollout.wave!);
      if (checkedRef.ok && typeof checkedRef.value.bytes === 'string') {
        const wave = parseCanonical<DeliberationWave>(checkedRef.value.bytes);
        const rolloutPolicy = createManagedRolloutPolicy(options.managedRollout.policy);
        if (wave.gear === 'EXPLORE' && inspectExploreAuthorization(suppliedExploreAuthorization, {
          intent: wave.authorship.intent,
          authorityDigest: wave.authorship.authorityDigest,
          waveDigest: checkedRef.value.digest,
          runId: wave.authorship.runId,
          phaseId: wave.authorship.phaseId,
          rolloutPolicyDigest: rolloutPolicy.digest,
        })) exploreAuthorization = suppliedExploreAuthorization;
      }
    } catch { /* malformed/unbound proof remains unavailable to admission */ }
    const deliberation = new CodexDeliberationDriver({ policy, wave: options.managedRollout.wave!, deliberationPolicy: options.managedRollout.deliberationPolicy });
    driver = multiplexDrivers(legacyDriver, deliberation);
  }
  if (driver && providerGate) driver = afterProviderGate(driver, providerGate);
  const merged: DispatcherOptions = {
    ...projectDispatcher(dispatcher),
    ...(timeoutMs === undefined && dispatchTimeoutMs === undefined ? {} : { timeoutMs: timeoutMs ?? dispatchTimeoutMs }),
    ...(signal === undefined && abortSignal === undefined ? {} : { signal: signal ?? abortSignal }),
    ...(onYield === undefined ? {} : { onYield }),
  };
  const invocation = exploreAuthorization === undefined ? undefined : { exploreAuthorization };
  return expectedRootIdentity
    ? makeComposedKernelForBridge(kernelOptions, expectedRootIdentity, driver, merged, invocation)
    : makeComposedKernel(kernelOptions, driver, merged, invocation);
}

export function composeKernel(options: CompositionOptions): RunKernel { return compose(options); }

/** Root-bound variant used only while the private bridge owns its operation
 * lock.  Provider work begins later, after the lock has been released. */
export function composeKernelForBridge(options: CompositionOptions, expectedRootIdentity: FilesystemIdentity): RunKernel {
  return compose(options, expectedRootIdentity);
}
