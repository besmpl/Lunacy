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
  | 'managedDirectProposals'
  | 'managedFocusProposals'
  | 'managedExploreProposals'
  | 'managedWavesAdmitted'
  | 'managedWavesRefused'
  | 'managedWavesKilled'
  | 'managedParentOverride'
  | 'managedAllRejected'
  | 'managedFallback'
  | 'managedAuthorityEscape'
  | 'managedStaleAdoption'
  | 'managedCeilingOverrun'
  | 'managedAuthoritativeDeletion'
  | 'managedDuplicateEntry'
  | 'managedPartialPromotion'
  | 'managedCalls'
  | 'managedInputTokens'
  | 'managedOutputTokens'
  | 'managedBytes'
  | 'managedRefs'
  | 'managedLatencyLe100ms'
  | 'managedLatencyLe1s'
  | 'managedLatencyLe10s'
  | 'managedLatencyOver10s';

export type MetricsSnapshot = Readonly<Record<AccelerationCounter, number>>;

const COUNTERS: readonly AccelerationCounter[] = [
  'graphPrepare', 'graphFallback', 'graphCorrupt', 'graphCandidates',
  'managedDirectProposals', 'managedFocusProposals', 'managedExploreProposals',
  'managedWavesAdmitted', 'managedWavesRefused', 'managedWavesKilled',
  'managedParentOverride', 'managedAllRejected', 'managedFallback', 'managedAuthorityEscape',
  'managedStaleAdoption', 'managedCeilingOverrun', 'managedAuthoritativeDeletion',
  'managedDuplicateEntry', 'managedPartialPromotion', 'managedCalls', 'managedInputTokens',
  'managedOutputTokens', 'managedBytes', 'managedRefs', 'managedLatencyLe100ms',
  'managedLatencyLe1s', 'managedLatencyLe10s', 'managedLatencyOver10s',
];

function empty(): Record<AccelerationCounter, number> {
  return Object.fromEntries(COUNTERS.map((name) => [name, 0])) as Record<AccelerationCounter, number>;
}

export class AccelerationMetrics {
  #counts = empty();

  increment(name: AccelerationCounter, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RangeError('metric increment must be a non-negative safe integer');
    if (!Object.prototype.hasOwnProperty.call(this.#counts, name)) throw new RangeError('metric name is not supported');
    this.#counts[name] = Math.min(Number.MAX_SAFE_INTEGER, this.#counts[name] + amount);
  }

  /** Bounded observation helper. Diagnostics are deliberately lossy and
   * never throw into execution or become a policy input. */
  observeManaged(input: Readonly<{ calls?: number; inputTokens?: number; outputTokens?: number; bytes?: number; refs?: number; wallTimeMs?: number }>): void {
    try {
      for (const [field, counter] of [
        ['calls', 'managedCalls'], ['inputTokens', 'managedInputTokens'], ['outputTokens', 'managedOutputTokens'], ['bytes', 'managedBytes'], ['refs', 'managedRefs'],
      ] as const) {
        const value = input[field] ?? 0;
        if (Number.isSafeInteger(value) && value >= 0) this.increment(counter, value);
      }
      const latency = input.wallTimeMs;
      if (Number.isFinite(latency) && (latency as number) >= 0) this.increment((latency as number) <= 100 ? 'managedLatencyLe100ms' : (latency as number) <= 1_000 ? 'managedLatencyLe1s' : (latency as number) <= 10_000 ? 'managedLatencyLe10s' : 'managedLatencyOver10s');
    } catch { /* diagnostics never affect execution */ }
  }

  snapshot(): MetricsSnapshot { return Object.freeze({ ...this.#counts }); }

  /** Test/host composition helper; it does not affect runtime semantics. */
  reset(): void { this.#counts = empty(); }
}

export const defaultMetrics = new AccelerationMetrics();
