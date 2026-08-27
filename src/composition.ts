import { makeComposedKernel, type DispatcherOptions, type KernelOptions, type RunKernel } from './public.js';
import type { EffectDriver } from './driver.js';

export type CompositionOptions = KernelOptions & DispatcherOptions & {
  driver?: EffectDriver;
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
  'driver', 'dispatcher', 'timeoutMs', 'dispatchTimeoutMs',
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

/** Private host composition hook; callers still receive only the RunKernel seam. */
export function composeKernel(options: CompositionOptions): RunKernel {
  const driver = options.driver;
  const dispatcher = options.dispatcher;
  const timeoutMs = options.timeoutMs;
  const dispatchTimeoutMs = options.dispatchTimeoutMs;
  const signal = options.signal;
  const abortSignal = options.abortSignal;
  const onYield = options.onYield;
  const maxInFlight = options.maxInFlight;
  const kernelOptions = projectKernelOptions(options, maxInFlight);
  const merged: DispatcherOptions = {
    ...projectDispatcher(dispatcher),
    ...(timeoutMs === undefined && dispatchTimeoutMs === undefined ? {} : { timeoutMs: timeoutMs ?? dispatchTimeoutMs }),
    ...(signal === undefined && abortSignal === undefined ? {} : { signal: signal ?? abortSignal }),
    ...(onYield === undefined ? {} : { onYield }),
  };
  return makeComposedKernel(kernelOptions, driver, merged);
}
