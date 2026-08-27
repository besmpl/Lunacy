import { canonicalString, digest } from './canonical.js';
import type { Sha256 } from './model.js';
import { AccelerationMetrics, defaultMetrics } from './metrics.js';
import type { ArtifactStore, ReuseRecord } from './store.js';

/** Sensitivity classes are intentionally closed at the private seam. */
export type Sensitivity = 'PUBLIC' | 'WORKSPACE_PRIVATE' | 'RUN_PRIVATE' | 'SECRET';

export type CellTuple = {
  tenant: string;
  principal: string;
  workspace: string;
  sensitivity: Sensitivity;
  accessEpoch: number;
  policyEpoch: number;
};

export type CellHandle = Readonly<{
  readonly kind: 'CellHandle';
  readonly identity: Sha256;
  readonly tuple: CellTuple;
  readonly reuseEpoch: number;
}>;

export type SnapshotHandle = Readonly<{
  readonly kind: 'SnapshotHandle';
  readonly generation: number;
  readonly treeDigest: Sha256;
  readonly symlinkDigest: Sha256;
  readonly mountDigest: Sha256;
  readonly readSetDigest: Sha256;
  readonly sourceDigests: readonly Sha256[];
}>;

export type StoreTxn = Readonly<{
  readonly kind: 'StoreTxn';
  readonly generation: number;
  readonly writerFence: string;
}>;

const SHA256 = /^[0-9a-f]{64}$/;
const SENSITIVITIES = new Set<Sensitivity>(['PUBLIC', 'WORKSPACE_PRIVATE', 'RUN_PRIVATE', 'SECRET']);
function exactObjectKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} fields are invalid`);
}

/** Revalidate opaque root-owned handles at every private reuse boundary. */
export function validateCellHandle(value: CellHandle): void {
  if (!value || typeof value !== 'object' || value.kind !== 'CellHandle') throw new Error('cell handle is invalid');
  exactObjectKeys(value as unknown as object, ['kind', 'identity', 'tuple', 'reuseEpoch'], 'cell handle');
  if (!SHA256.test(value.identity) || !Number.isSafeInteger(value.reuseEpoch) || value.reuseEpoch < 0) throw new Error('cell handle proof is invalid');
  if (!value.tuple || typeof value.tuple !== 'object') throw new Error('cell tuple is invalid');
  exactObjectKeys(value.tuple as object, ['tenant', 'principal', 'workspace', 'sensitivity', 'accessEpoch', 'policyEpoch'], 'cell tuple');
  if (typeof value.tuple.tenant !== 'string' || value.tuple.tenant.length === 0 || typeof value.tuple.principal !== 'string' || value.tuple.principal.length === 0 || typeof value.tuple.workspace !== 'string' || value.tuple.workspace.length === 0 || !SENSITIVITIES.has(value.tuple.sensitivity) || !Number.isSafeInteger(value.tuple.accessEpoch) || value.tuple.accessEpoch < 0 || !Number.isSafeInteger(value.tuple.policyEpoch) || value.tuple.policyEpoch < 0) throw new Error('cell tuple proof is invalid');
  if (digest({ schema: 'cell/v1', tuple: value.tuple, reuseEpoch: value.reuseEpoch }) !== value.identity) throw new Error('cell identity digest mismatch');
}

export function validateSnapshotHandle(value: SnapshotHandle): void {
  if (!value || typeof value !== 'object' || value.kind !== 'SnapshotHandle') throw new Error('snapshot handle is invalid');
  exactObjectKeys(value as unknown as object, ['kind', 'generation', 'treeDigest', 'symlinkDigest', 'mountDigest', 'readSetDigest', 'sourceDigests'], 'snapshot handle');
  if (!Number.isSafeInteger(value.generation) || value.generation < 0 || !SHA256.test(value.treeDigest) || !SHA256.test(value.symlinkDigest) || !SHA256.test(value.mountDigest) || !SHA256.test(value.readSetDigest) || !Array.isArray(value.sourceDigests) || value.sourceDigests.some((item) => !SHA256.test(item))) throw new Error('snapshot handle proof is invalid');
}

export function makeCellHandle(tuple: CellTuple, reuseEpoch = 0): CellHandle {
  if (!tuple || !tuple.tenant || !tuple.principal || !tuple.workspace) throw new Error('cell identity is incomplete');
  exactObjectKeys(tuple as object, ['tenant', 'principal', 'workspace', 'sensitivity', 'accessEpoch', 'policyEpoch'], 'cell tuple');
  if (!SENSITIVITIES.has(tuple.sensitivity)) throw new Error('cell sensitivity is invalid');
  if (!Number.isSafeInteger(tuple.accessEpoch) || tuple.accessEpoch < 0 || !Number.isSafeInteger(tuple.policyEpoch) || tuple.policyEpoch < 0) throw new Error('cell epochs are invalid');
  if (!Number.isSafeInteger(reuseEpoch) || reuseEpoch < 0) throw new Error('reuseEpoch is invalid');
  const normalized = Object.freeze({ ...tuple, accessEpoch: tuple.accessEpoch, policyEpoch: tuple.policyEpoch }) as CellTuple;
  return Object.freeze({ kind: 'CellHandle', identity: digest({ schema: 'cell/v1', tuple: normalized, reuseEpoch }), tuple: normalized, reuseEpoch });
}

export function makeSnapshotHandle(input: Omit<SnapshotHandle, 'kind'>): SnapshotHandle {
  exactObjectKeys(input as object, ['generation', 'treeDigest', 'symlinkDigest', 'mountDigest', 'readSetDigest', 'sourceDigests'], 'snapshot handle');
  const fields = ['treeDigest', 'symlinkDigest', 'mountDigest', 'readSetDigest'] as const;
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error('snapshot generation is invalid');
  for (const field of fields) if (!/^[0-9a-f]{64}$/i.test(input[field])) throw new Error(`snapshot ${field} is invalid`);
  if (!Array.isArray(input.sourceDigests) || input.sourceDigests.some((x) => !/^[0-9a-f]{64}$/i.test(x))) throw new Error('snapshot source digests are invalid');
  return Object.freeze({ kind: 'SnapshotHandle', ...input, sourceDigests: Object.freeze([...input.sourceDigests]) });
}

export function makeStoreTxn(generation: number, writerFence: string): StoreTxn {
  if (!Number.isSafeInteger(generation) || generation < 0 || !writerFence) throw new Error('store transaction proof is invalid');
  return Object.freeze({ kind: 'StoreTxn', generation, writerFence });
}

export type ReuseRequest = {
  runId: string;
  /** Stable artifact class is part of identity: BASE and VIEW bytes must not
   * alias even when their source/authority proofs happen to match. */
  kind?: 'BASE' | 'VIEW';
  generation?: number;
  cell: CellHandle | null;
  snapshot: SnapshotHandle | null;
  authorityDigest: Sha256;
  authorityEpoch: number;
  derivation: { id: string; version: string; schema: string };
  serializerVersion?: string;
  sources: readonly { id: string; scope?: string; digest: Sha256; bytes?: number }[];
  model?: unknown;
  tools?: unknown;
  sensitivity?: Sensitivity;
  writerFence?: string;
  /** Store-owned transaction proof carried through staging/publication. */
  txn?: StoreTxn;
  /** Pure allow-listed builder. It receives only proof-bound immutable input. */
  build: () => string;
};

export type ReuseResult = {
  readonly bytes: string;
  readonly contentAddress: Sha256;
  readonly lookupKey: Sha256;
  readonly hit: boolean;
  readonly proof: {
    readonly runId: string;
    readonly authorityDigest: Sha256;
    readonly authorityEpoch: number;
    readonly cellDigest: Sha256 | null;
    readonly snapshotDigest: Sha256 | null;
    readonly reuseEpoch: number | null;
  };
  /** Private staged BASE row; published only after the authoritative CURRENT
   * commit by ContextCompiler/KernelImpl. */
  readonly pending?: ReuseRecord;
};

type Entry = ReuseResult & { readonly key: Sha256 };

function canonicalDigest(value: unknown): Sha256 { return digest(value); }

/** A bounded fixed-cell adapter storing only complete immutable BASE bytes.
 * Kernel composition supplies private ArtifactStore transaction hooks for
 * restart-safe persistence; direct unit callers retain the in-memory adapter. */
export class FixedCellReuse {
  readonly #entries = new Map<string, Entry>();
  readonly #metrics: AccelerationMetrics;
  readonly #mode: 'OFF' | 'SHADOW' | 'ON';

  constructor(mode: 'OFF' | 'SHADOW' | 'ON' = 'OFF', metrics: AccelerationMetrics = defaultMetrics) {
    this.#mode = mode; this.#metrics = metrics;
  }

  prepare(request: ReuseRequest): ReuseResult {
    const sensitivity = request.sensitivity ?? request.cell?.tuple.sensitivity;
    if (this.#mode === 'OFF' || (request.kind !== undefined && request.kind !== 'BASE') || !request.cell || !request.snapshot || sensitivity === 'SECRET' || !request.runId) {
      this.#metrics.increment('reuseBypass');
      return this.cold(request);
    }
    try {
      this.verify(request);
      if (request.txn && (request.txn.generation !== (request.generation ?? 0) || request.txn.writerFence !== (request.writerFence ?? 'none'))) throw new Error('store transaction proof mismatch');
      const lookupKey = this.key(request);
      const previous = this.#entries.get(lookupKey);
      if (previous && this.#mode === 'ON') {
        // Never return bytes until the entire proof has been checked again.
        // The content address proves only that the bytes are self-consistent;
        // a corrupted in-memory entry could still pair an attacker-chosen
        // payload with its matching digest.  Re-render the pure stable BASE
        // and require byte identity before treating the entry as a hit.
        const expected = this.cold(request, lookupKey);
        if (previous.contentAddress === expected.contentAddress && previous.bytes === expected.bytes && previous.contentAddress === digest(previous.bytes) && previous.proof.cellDigest === request.cell.identity && previous.proof.snapshotDigest === digest(request.snapshot)) {
          this.#metrics.increment('reuseHit');
          return { ...previous, hit: true };
        }
        this.#entries.delete(lookupKey); this.#metrics.increment('reuseQuarantine');
      }
      this.#metrics.increment('reuseMiss');
      const cold = this.cold(request, lookupKey);
      if (this.#mode === 'ON') this.#entries.set(lookupKey, { ...cold, key: lookupKey });
      return cold;
    } catch {
      this.#metrics.increment('reuseBypass');
      return this.cold(request);
    }
  }

  /** Persistent ArtifactStore path.  It deliberately has no public cache
   * lifecycle: the store only exposes these hooks to this private seam. */
  async prepareWithStore(request: ReuseRequest, store: ArtifactStore): Promise<ReuseResult> {
    const sensitivity = request.sensitivity ?? request.cell?.tuple.sensitivity;
    if (this.#mode === 'OFF' || (request.kind !== undefined && request.kind !== 'BASE') || !request.cell || !request.snapshot || sensitivity === 'SECRET' || !request.runId) {
      this.#metrics.increment('reuseBypass');
      return this.cold(request);
    }
    if (!store.reuseLookup || !store.reuseStage) {
      this.#metrics.increment('reuseBypass');
      throw new Error('persistent fixed-cell store hooks are unavailable');
    }
    try {
      this.verify(request);
      const lookupKey = this.key(request);
      const row = await store.reuseLookup(lookupKey);
      // A valid digest and matching ACL/epoch metadata are necessary but not
      // sufficient: an untrusted cache index/blob pair can be rewritten with
      // a fresh digest.  Compare against the deterministic builder output so
      // cache corruption becomes a cold-equivalent miss rather than an
      // authority-visible BASE substitution.
      const expected = row ? this.cold(request, lookupKey) : undefined;
      if (row && expected && row.key === lookupKey && row.contentAddress === expected.contentAddress && row.bytes === expected.bytes && row.contentAddress === digest(row.bytes) && row.bytes.length > 0 && row.runId === request.runId && row.authorityDigest === request.authorityDigest && row.authorityEpoch === request.authorityEpoch && row.cellDigest === request.cell.identity && row.snapshotDigest === digest(request.snapshot) && row.reuseEpoch === request.cell.reuseEpoch) {
        this.#metrics.increment('reuseHit');
        return { bytes: row.bytes, contentAddress: row.contentAddress as Sha256, lookupKey, hit: this.#mode === 'ON', proof: { runId: row.runId, authorityDigest: row.authorityDigest as Sha256, authorityEpoch: row.authorityEpoch, cellDigest: row.cellDigest as Sha256, snapshotDigest: row.snapshotDigest as Sha256, reuseEpoch: row.reuseEpoch } };
      }
      if (row) { await store.reuseQuarantine?.(lookupKey); this.#metrics.increment('reuseQuarantine'); }
      this.#metrics.increment('reuseMiss');
      const cold = this.cold(request, lookupKey);
      // Stage against the generation that this call is expected to commit.
      // A pre-call generation is not a publication proof: a delayed writer
      // must never be able to publish after another transition wins the CAS.
      const pending: ReuseRecord = { key: lookupKey, contentAddress: cold.contentAddress, bytes: cold.bytes, runId: request.runId, generation: (request.generation ?? 0) + 1, authorityDigest: request.authorityDigest, authorityEpoch: request.authorityEpoch, cellDigest: request.cell.identity, snapshotDigest: digest(request.snapshot), reuseEpoch: request.cell.reuseEpoch, writerFence: request.writerFence ?? 'none', schema: 'safe-fixed-base/v1' };
      if (this.#mode === 'ON') {
        await store.reuseStage(pending);
        return { ...cold, pending };
      }
      return cold;
    } catch (error) {
      this.#metrics.increment('reuseBypass');
      throw error;
    }
  }

  private cold(request: ReuseRequest, lookupKey?: Sha256): ReuseResult {
    let bytes = request.build();
    if (typeof bytes !== 'string') throw new Error('BASE builder must return canonical string bytes');
    // Canonical JSON is the default stable representation; plain UTF-8 text
    // is permitted for renderers that have their own canonicalizer.
    if (bytes.length === 0) bytes = 'null';
    const contentAddress = digest(bytes);
    const result: ReuseResult = {
      bytes, contentAddress, lookupKey: lookupKey ?? this.key(request), hit: false,
      proof: { runId: request.runId, authorityDigest: request.authorityDigest, authorityEpoch: request.authorityEpoch, cellDigest: request.cell?.identity ?? null, snapshotDigest: request.snapshot ? digest(request.snapshot) : null, reuseEpoch: request.cell?.reuseEpoch ?? null },
    };
    return result;
  }

  private verify(request: ReuseRequest): void {
    if (!request.cell || !request.snapshot) throw new Error('reuse handles are required');
    validateCellHandle(request.cell); validateSnapshotHandle(request.snapshot);
    if (!/^[0-9a-f]{64}$/i.test(request.authorityDigest) || !Number.isSafeInteger(request.authorityEpoch) || request.authorityEpoch < 0) throw new Error('authority proof is invalid');
    if (request.cell?.tuple.sensitivity === 'SECRET') throw new Error('secret cells are not reusable');
    if (request.sensitivity && request.cell && request.sensitivity !== request.cell.tuple.sensitivity) throw new Error('cell sensitivity mismatch');
    for (const source of request.sources) {
      if (!source.id || !/^[0-9a-f]{64}$/i.test(source.digest)) throw new Error('source proof is invalid');
      if (source.bytes !== undefined && (!Number.isSafeInteger(source.bytes) || source.bytes < 0)) throw new Error('source byte length is invalid');
    }
  }

  private key(request: ReuseRequest): Sha256 {
    const cell = request.cell;
    const snapshot = request.snapshot;
    return canonicalDigest({
      schema: 'safe-fixed-base/v1', class: 'BASE', runId: request.runId,
      kind: request.kind ?? 'BASE',
      derivation: request.derivation, serializerVersion: request.serializerVersion ?? 'canonical/v1',
      sources: request.sources.map((source) => ({ id: source.id, scope: source.scope ?? '', digest: source.digest, bytes: source.bytes ?? null })),
      snapshot: snapshot ? { generation: snapshot.generation, treeDigest: snapshot.treeDigest, symlinkDigest: snapshot.symlinkDigest, mountDigest: snapshot.mountDigest, readSetDigest: snapshot.readSetDigest, sourceDigests: snapshot.sourceDigests } : null,
      authorityDigest: request.authorityDigest, authorityEpoch: request.authorityEpoch,
      model: request.model ?? null, tools: request.tools ?? null,
      cell: cell ? { tenant: cell.tuple.tenant, principal: cell.tuple.principal, workspace: cell.tuple.workspace, sensitivity: cell.tuple.sensitivity, accessEpoch: cell.tuple.accessEpoch, policyEpoch: cell.tuple.policyEpoch } : null,
      reuseEpoch: cell?.reuseEpoch ?? null,
    });
  }

  /** Corruption/restart safety: all entries can be dropped without authority impact. */
  clear(): void { this.#entries.clear(); }
  size(): number { return this.#entries.size; }
}

export function canonicalBaseBytes(value: unknown): string { return canonicalString(value); }
