import { canonicalString, digest } from './canonical.js';
import type { Ref, Sha256 } from './model.js';
import { AccelerationMetrics, defaultMetrics } from './metrics.js';
import { FixedCellReuse, makeStoreTxn, validateCellHandle, validateSnapshotHandle, type CellHandle, type Sensitivity, type SnapshotHandle } from './reuse.js';
import type { ArtifactStore, ReuseRecord } from './store.js';

export type CompilerMode = 'OFF' | 'SHADOW' | 'ON';
export type ImmutableSourceRef = { id: string; scope?: string; digest: Sha256; bytes?: number };
export type VerifiedDynamicTail = { bytes: string; eventId: string; snapshotDigest: Sha256 };
export type ContextProof = {
  runId: string;
  authorityDigest: Sha256;
  authorityEpoch: number;
  generation?: number;
  revision?: number;
  stateDigest?: Sha256;
  attemptEpoch?: number;
  barrierEpoch?: number;
  modeEpoch?: number;
  writerFence?: string;
};

export type PrepareRequest = {
  proof: ContextProof;
  scope: { tenant?: string; principal?: string; workspace?: string; sensitivity?: Sensitivity; accessEpoch?: number; policyEpoch?: number };
  sources: readonly ImmutableSourceRef[];
  kind: 'BASE' | 'VIEW';
  derivation: { id: string; version: string; schema: string };
  model?: unknown;
  tools?: unknown;
  dynamicTail: VerifiedDynamicTail;
  cell?: CellHandle | null;
  snapshot?: SnapshotHandle | null;
  /** Deterministic allow-listed renderer. If omitted, canonical stable fields are rendered. */
  build?: (stable: unknown) => string;
};

export type PreparedContext = {
  readonly stableRef: Ref;
  readonly stableDigest: Sha256;
  readonly lookupKey: Sha256;
  readonly requestBytes: string;
  readonly consumed: { readonly snapshotDigest: Sha256; readonly sourceReadSetDigest: Sha256; readonly authorityDigest: Sha256 };
  readonly hit: boolean;
  readonly mode: CompilerMode;
  readonly pendingReuse?: ReuseRecord;
};

function validDigest(value: unknown): value is Sha256 { return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value); }
function freezeSources(sources: readonly ImmutableSourceRef[]): ImmutableSourceRef[] {
  return sources.map((source) => ({ id: source.id, scope: source.scope ?? '', digest: source.digest, ...(source.bytes === undefined ? {} : { bytes: source.bytes }) }));
}

/** Private stable-prefix compiler. Dynamic tails are never part of its key or stored bytes. */
export class ContextCompiler {
  readonly #mode: CompilerMode;
  readonly #reuse: FixedCellReuse;
  readonly #metrics: AccelerationMetrics;
  readonly #store?: ArtifactStore;

  constructor(options: { mode?: CompilerMode; reuseMode?: CompilerMode; metrics?: AccelerationMetrics; store?: ArtifactStore } = {}) {
    this.#mode = options.mode ?? 'OFF';
    this.#metrics = options.metrics ?? defaultMetrics;
    this.#store = options.store;
    const reuseMode = options.mode === 'OFF' ? 'OFF' : (options.reuseMode ?? options.mode ?? 'OFF');
    this.#reuse = new FixedCellReuse(reuseMode, this.#metrics);
  }

  async prepare(request: PrepareRequest): Promise<PreparedContext> {
    this.#metrics.increment('contextPrepare');
    const sensitivity = request.scope.sensitivity ?? request.cell?.tuple.sensitivity;
    // SECRET is a hard pre-probe branch. Do not validate names, source
    // digests, or touch the fixed-cell adapter/index for this request.
    if (sensitivity === 'SECRET') {
      this.#metrics.increment('contextBypass');
      const tailDigest = request.dynamicTail?.snapshotDigest ?? ('0'.repeat(64) as Sha256);
      return this.cold(request, tailDigest);
    }
    try {
      if (request.cell) validateCellHandle(request.cell);
      if (request.snapshot) validateSnapshotHandle(request.snapshot);
    } catch {
      this.#metrics.increment('contextCorrupt');
      const snapshotDigest = request.snapshot ? digest(request.snapshot) : digest({ runId: request.proof.runId, generation: request.proof.generation ?? 0, revision: request.proof.revision ?? 0 });
      return this.cold(request, snapshotDigest);
    }
    const snapshotDigest = request.snapshot ? digest(request.snapshot) : digest({ runId: request.proof.runId, generation: request.proof.generation ?? 0, revision: request.proof.revision ?? 0 });
    const tail = request.dynamicTail;
    if (!tail || typeof tail.bytes !== 'string' || !tail.eventId || !validDigest(tail.snapshotDigest) || tail.snapshotDigest !== snapshotDigest) {
      this.#metrics.increment('contextBypass');
      return this.cold(request, snapshotDigest);
    }
    const sources = freezeSources(request.sources);
    if (sources.some((source) => !source.id || !validDigest(source.digest))) {
      this.#metrics.increment('contextBypass');
      return this.cold(request, snapshotDigest);
    }
    const stable = {
      schema: 'context-base/v1', kind: request.kind, derivation: request.derivation,
      // Mutable generation/revision/state/attempt/barrier/mode/writer values
      // belong to the commit-time proof, never reusable BASE bytes/key.
      proof: { runId: request.proof.runId, authorityDigest: request.proof.authorityDigest, authorityEpoch: request.proof.authorityEpoch },
      scope: { tenant: request.scope.tenant ?? '', principal: request.scope.principal ?? '', workspace: request.scope.workspace ?? '', sensitivity: sensitivity ?? 'RUN_PRIVATE', accessEpoch: request.scope.accessEpoch ?? 0, policyEpoch: request.scope.policyEpoch ?? 0 },
      sources, model: request.model ?? null, tools: request.tools ?? null,
    };
    const builder = request.build ?? ((value: unknown) => canonicalString(value));
    let result;
    try {
      if (request.kind !== 'BASE') {
        // Fixed-cell reuse is deliberately BASE-only. VIEW/state-derived
        // material remains an ordinary deterministic cold build; keeping this
        // branch explicit prevents a future cache-key omission from turning a
        // mutable view into reusable authority.
        const bytes = builder(stable);
        if (typeof bytes !== 'string') throw new Error('VIEW builder must return canonical string bytes');
        result = { bytes, contentAddress: digest(bytes), lookupKey: digest({ schema: 'context-lookup/v1', stable }), hit: false, proof: { runId: request.proof.runId, authorityDigest: request.proof.authorityDigest, authorityEpoch: request.proof.authorityEpoch, cellDigest: request.cell?.identity ?? null, snapshotDigest: request.snapshot ? digest(request.snapshot) : null, reuseEpoch: request.cell?.reuseEpoch ?? null } };
      } else {
        const reuseRequest = {
          runId: request.proof.runId, kind: request.kind, generation: request.proof.generation, cell: request.cell ?? null, snapshot: request.snapshot ?? null,
          authorityDigest: request.proof.authorityDigest, authorityEpoch: request.proof.authorityEpoch,
          derivation: request.derivation, sources, model: request.model, tools: request.tools, sensitivity,
          writerFence: request.proof.writerFence,
          txn: makeStoreTxn(request.proof.generation ?? 0, request.proof.writerFence ?? 'none'),
          build: () => builder(stable),
        };
        result = this.#store ? await this.#reuse.prepareWithStore(reuseRequest, this.#store) : this.#reuse.prepare(reuseRequest);
      }
    } catch {
      this.#metrics.increment('contextCorrupt');
      return this.cold(request, snapshotDigest);
    }
    // In OFF mode FixedCellReuse builds the same deterministic bytes, but the
    // request-wide cache remains disabled and reports a miss.
    const stableBytes = result.bytes;
    const stableDigest = result.contentAddress;
    const lookupKey = result.lookupKey;
    // Frame the per-call tail explicitly.  Event identity and payload remain
    // outside stable bytes/key, but two calls with equal payload text and
    // different event IDs must still produce distinct transient requests.
    const tailBytes = canonicalString({ eventId: tail.eventId, bytes: tail.bytes, snapshotDigest: tail.snapshotDigest });
    const requestBytes = `${stableBytes}\n${tailBytes}`;
    const stableRef: Ref = { id: `context:${stableDigest}`, digest: stableDigest, scope: request.scope.workspace ?? 'run', bytes: stableBytes };
    if (result.hit) this.#metrics.increment('contextHit'); else this.#metrics.increment('contextMiss');
    return { stableRef, stableDigest, lookupKey, requestBytes, consumed: { snapshotDigest, sourceReadSetDigest: digest(sources), authorityDigest: request.proof.authorityDigest }, hit: result.hit && this.#mode === 'ON', mode: this.#mode, pendingReuse: result.pending };
  }

  private cold(request: PrepareRequest, snapshotDigest: Sha256): PreparedContext {
    const stable = { schema: 'context-base/v1', kind: request.kind, derivation: request.derivation, sources: freezeSources(request.sources), model: request.model ?? null, tools: request.tools ?? null, authorityDigest: request.proof.authorityDigest, authorityEpoch: request.proof.authorityEpoch };
    const bytes = request.build ? request.build(stable) : canonicalString(stable);
    const stableDigest = digest(bytes);
    const tail = canonicalString({ eventId: request.dynamicTail?.eventId ?? '', bytes: request.dynamicTail?.bytes ?? '', snapshotDigest });
    return { stableRef: { id: `context:${stableDigest}`, digest: stableDigest, scope: request.scope.workspace ?? 'run', bytes }, stableDigest, lookupKey: digest({ schema: 'context-lookup/v1', stable }), requestBytes: `${bytes}\n${tail}`, consumed: { snapshotDigest, sourceReadSetDigest: digest(request.sources), authorityDigest: request.proof.authorityDigest }, hit: false, mode: this.#mode };
  }
}

/** Publish a staged BASE row only after the caller's CURRENT generation is
 * durable.  A failed publication is a miss on the next call and cannot alter
 * the already committed run. */
export async function publishPreparedContext(prepared: PreparedContext | undefined, store: ArtifactStore | undefined): Promise<void> {
  if (!prepared?.pendingReuse || !store?.reusePublish) return;
  await store.reusePublish(prepared.pendingReuse);
}

export type ContextCompilerOptions = ConstructorParameters<typeof ContextCompiler>[0];
export function createContextCompiler(options?: ContextCompilerOptions): ContextCompiler { return new ContextCompiler(options); }
