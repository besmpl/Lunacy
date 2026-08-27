/**
 * Private, in-process acceleration counters.  Metrics are deliberately not
 * part of MachineState or the public RunKernel seam: losing them on restart
 * must never change an outcome.
 */
export type AccelerationCounter =
  | 'graphPrepare'
  | 'graphFallback'
  | 'graphCorrupt'
  | 'graphCandidates'
  | 'contextPrepare'
  | 'contextHit'
  | 'contextMiss'
  | 'contextBypass'
  | 'contextCorrupt'
  | 'reuseHit'
  | 'reuseMiss'
  | 'reuseBypass'
  | 'reuseQuarantine';

export type MetricsSnapshot = Readonly<Record<AccelerationCounter, number>>;

const COUNTERS: readonly AccelerationCounter[] = [
  'graphPrepare', 'graphFallback', 'graphCorrupt', 'graphCandidates',
  'contextPrepare', 'contextHit', 'contextMiss', 'contextBypass', 'contextCorrupt',
  'reuseHit', 'reuseMiss', 'reuseBypass', 'reuseQuarantine',
];

function empty(): Record<AccelerationCounter, number> {
  return Object.fromEntries(COUNTERS.map((name) => [name, 0])) as Record<AccelerationCounter, number>;
}

export class AccelerationMetrics {
  #counts = empty();

  increment(name: AccelerationCounter, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('metric increment must be a non-negative safe integer');
    this.#counts[name] += amount;
  }

  snapshot(): MetricsSnapshot { return Object.freeze({ ...this.#counts }); }

  /** Test/host composition helper; it does not affect runtime semantics. */
  reset(): void { this.#counts = empty(); }
}

export const defaultMetrics = new AccelerationMetrics();
