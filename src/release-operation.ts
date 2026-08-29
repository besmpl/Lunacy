import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalString, digest, parseCanonical } from './canonical.js';
import { inspectTrustedPath, sameFilesystemIdentity, syncDirectory, type FilesystemIdentity } from './filesystem.js';
import {
  BRIDGE_OPERATION_LOCK, RELEASE_EXCLUSION_LOCK, WRITER_LOCK,
  acquireOwnedFileClaim, assertExactDiscoveredRoots, currentReleaseOwner,
  discoverManagedRunRoots, releaseOwnerIsLive, validateReleaseManifest,
  type OwnedFileClaim, type ReleaseManifest, type ReleaseOwner, type ReleaseOperation,
} from './release-admission.js';

export type ReleaseExclusionOwnership = Readonly<{
  manifest: ReleaseManifest;
  manifestDigest: string;
  owner: ReleaseOwner;
  ownerBytes: string;
  releaseClaims: readonly OwnedFileClaim[];
  bridgeClaims: readonly OwnedFileClaim[];
  writerClaims: readonly OwnedFileClaim[];
}>;

export type ReleaseExclusionOptions = Readonly<{
  manifest: ReleaseManifest;
  manifestDigest: string;
  /** Private resume seam: reuse the exact owner identity bound by the outer marker. */
  owner?: ReleaseOwner;
  waitMs?: number;
  signal?: AbortSignal;
}>;

/**
 * Durable, private wrapper around the existing release transaction.  The
 * marker is intentionally a projection: it never owns managed-tree bytes and
 * must be rebound to the release manifest, claims, and inner transaction
 * before a caller delegates any mutation.
 */
export const RELEASE_OPERATION_ENVELOPE_SCHEMA = 'lunacy-release-operation/v2' as const;
export const RELEASE_OPERATION_ENVELOPE_MARKER = '.lunacy-release-operation.v2.json' as const;
export const RELEASE_OPERATION_ENVELOPE_TEMP_SUFFIX = '.tmp' as const;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENVELOPE_PHASES = ['prepared', 'admitted', 'quiesced', 'delegated', 'committed', 'failed', 'attention'] as const;
const ENVELOPE_STATUSES = ['READY', 'WAITING', 'COMMITTED', 'FAILED', 'ATTENTION'] as const;
export type ReleaseOperationEnvelopePhase = typeof ENVELOPE_PHASES[number];
export type ReleaseOperationEnvelopeStatus = typeof ENVELOPE_STATUSES[number];
export type ReleaseOperationTargetIdentity = Readonly<{ pathDigest: string; dev: string; ino: string }>;
export type ReleaseOperationOwnerIdentity = Readonly<{ id: string; pid: number; processStartedAt: string; acquiredAt: string; manifestDigest: string; epoch: number }>;
export type ReleaseOperationSnapshotIdentity = Readonly<{ pathDigest: string; digest: string; capturedAt: string }>;
export type ReleaseOperationLockIdentity = Readonly<{ pathDigest: string; dev: string; ino: string; ownerId: string }>;
export type ReleaseOperationEnvelope = Readonly<{
  schema: typeof RELEASE_OPERATION_ENVELOPE_SCHEMA;
  operationId: string;
  operation: ReleaseOperation;
  manifestDigest: string;
  manifestIdentityDigest: string;
  installedTarget: ReleaseOperationTargetIdentity;
  discoveryParentsDigest: string;
  runRootsDigest: string;
  processSnapshotPathDigest: string;
  owner: ReleaseOperationOwnerIdentity;
  snapshot: ReleaseOperationSnapshotIdentity | null;
  targetLock: ReleaseOperationLockIdentity | null;
  phase: ReleaseOperationEnvelopePhase;
  status: ReleaseOperationEnvelopeStatus;
  recovery: Readonly<{ code: string | null; attempts: number }>;
  inner: Readonly<{ markerDigest: string | null; aggregate: string | null; previousAggregate: string | null }>;
}>;
export type ReleaseOperationEnvelopeInput = Readonly<{
  operationId?: string;
  operation: ReleaseOperation;
  manifest: ReleaseManifest;
  manifestDigest: string;
  targetIdentity: ReleaseOperationTargetIdentity;
  owner: ReleaseOperationOwnerIdentity;
  snapshot?: ReleaseOperationSnapshotIdentity | null;
  targetLock?: ReleaseOperationLockIdentity | null;
  phase?: ReleaseOperationEnvelopePhase;
  status?: ReleaseOperationEnvelopeStatus;
  recovery?: { code?: string | null; attempts?: number };
  inner?: { markerDigest?: string | null; aggregate?: string | null; previousAggregate?: string | null };
}>;
export type ReleaseOperationEnvelopeRead = Readonly<{
  state: 'ABSENT' | 'VALID' | 'MALFORMED' | 'CONFLICTING';
  path: string;
  bytes?: string;
  identity?: FilesystemIdentity;
  envelope?: ReleaseOperationEnvelope;
  reason?: string;
}>;
export type ReleaseOperationStatus = Readonly<{
  schema: typeof RELEASE_OPERATION_ENVELOPE_SCHEMA;
  status: 'ABSENT' | 'VALID' | 'STALE' | 'MALFORMED' | 'CONFLICTING';
  phase: ReleaseOperationEnvelopePhase | null;
  operation: ReleaseOperation | null;
  operationId: string | null;
  nextAction: 'create' | 'admit' | 'quiesce' | 'delegate' | 'verify' | 'retry' | 'none';
  recovery: Readonly<{ code: string | null; attempts: number }>;
}>;

function fail(message: string): never { throw new Error(`ReleaseExclusion: ${message}`); }
function stableCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }

function envelopeFail(message: string): never { throw new Error(`ReleaseOperationEnvelope: ${message}`); }
function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(stableCompare); const wanted = [...expected].sort(stableCompare);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) envelopeFail(`${label} fields are not closed`);
}
function safeDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) envelopeFail(`${label} is invalid`);
  return value;
}
function safePathDigest(value: unknown, label: string): string { return safeDigest(value, label); }
function safeString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.length > 4096) envelopeFail(`${label} is invalid`);
  return value;
}
function safeDate(value: unknown, label: string): string {
  const text = safeString(value, label); if (Number.isNaN(Date.parse(text))) envelopeFail(`${label} is invalid`); return text;
}
function safeIdentity(value: unknown, label: string): ReleaseOperationTargetIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) envelopeFail(`${label} is malformed`);
  const object = value as Record<string, unknown>; exactKeys(object, ['pathDigest', 'dev', 'ino'], label);
  return Object.freeze({ pathDigest: safePathDigest(object.pathDigest, `${label} pathDigest`), dev: safeString(object.dev, `${label} dev`), ino: safeString(object.ino, `${label} ino`) });
}
function safeOwner(value: unknown): ReleaseOperationOwnerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) envelopeFail('owner is malformed');
  const object = value as Record<string, unknown>; exactKeys(object, ['id', 'pid', 'processStartedAt', 'acquiredAt', 'manifestDigest', 'epoch'], 'owner');
  if (typeof object.id !== 'string' || !UUID.test(object.id)) envelopeFail('owner id is invalid');
  if (!Number.isSafeInteger(object.pid) || (object.pid as number) <= 0 || (object.pid as number) > 2_147_483_647) envelopeFail('owner pid is invalid');
  if (!Number.isSafeInteger(object.epoch) || (object.epoch as number) < 0) envelopeFail('owner epoch is invalid');
  return Object.freeze({ id: object.id, pid: object.pid as number, processStartedAt: safeDate(object.processStartedAt, 'owner processStartedAt'), acquiredAt: safeDate(object.acquiredAt, 'owner acquiredAt'), manifestDigest: safeDigest(object.manifestDigest, 'owner manifestDigest'), epoch: object.epoch as number });
}
function safeSnapshot(value: unknown): ReleaseOperationSnapshotIdentity | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) envelopeFail('snapshot is malformed');
  const object = value as Record<string, unknown>; exactKeys(object, ['pathDigest', 'digest', 'capturedAt'], 'snapshot');
  return Object.freeze({ pathDigest: safePathDigest(object.pathDigest, 'snapshot pathDigest'), digest: safeDigest(object.digest, 'snapshot digest'), capturedAt: safeDate(object.capturedAt, 'snapshot capturedAt') });
}
function safeLock(value: unknown): ReleaseOperationLockIdentity | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) envelopeFail('target lock is malformed');
  const object = value as Record<string, unknown>; exactKeys(object, ['pathDigest', 'dev', 'ino', 'ownerId'], 'target lock');
  if (typeof object.ownerId !== 'string' || !UUID.test(object.ownerId)) envelopeFail('target lock owner id is invalid');
  return Object.freeze({ pathDigest: safePathDigest(object.pathDigest, 'target lock pathDigest'), dev: safeString(object.dev, 'target lock dev'), ino: safeString(object.ino, 'target lock ino'), ownerId: object.ownerId });
}
function safeRecovery(value: unknown): Readonly<{ code: string | null; attempts: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) envelopeFail('recovery is malformed');
  const object = value as Record<string, unknown>; exactKeys(object, ['code', 'attempts'], 'recovery');
  if (object.code !== null && (typeof object.code !== 'string' || object.code.length === 0 || object.code.length > 128 || object.code.includes('\0'))) envelopeFail('recovery code is invalid');
  if (!Number.isSafeInteger(object.attempts) || (object.attempts as number) < 0 || (object.attempts as number) > 1_000_000) envelopeFail('recovery attempts are invalid');
  return Object.freeze({ code: object.code as string | null, attempts: object.attempts as number });
}
function safeInner(value: unknown): Readonly<{ markerDigest: string | null; aggregate: string | null; previousAggregate: string | null }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) envelopeFail('inner proof is malformed');
  const object = value as Record<string, unknown>; exactKeys(object, ['markerDigest', 'aggregate', 'previousAggregate'], 'inner proof');
  for (const key of ['markerDigest', 'aggregate', 'previousAggregate'] as const) if (object[key] !== null) safeDigest(object[key], `inner ${key}`);
  return Object.freeze({ markerDigest: object.markerDigest as string | null, aggregate: object.aggregate as string | null, previousAggregate: object.previousAggregate as string | null });
}

/** Validate the closed v2 outer envelope.  This parser never inspects or
 * mutates an inner deployment marker; callers must perform that subordinate
 * proof separately before promoting `committed`. */
export function validateReleaseOperationEnvelope(value: unknown): ReleaseOperationEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) envelopeFail('envelope is malformed');
  const object = value as Record<string, unknown>;
  exactKeys(object, ['schema', 'operationId', 'operation', 'manifestDigest', 'manifestIdentityDigest', 'installedTarget', 'discoveryParentsDigest', 'runRootsDigest', 'processSnapshotPathDigest', 'owner', 'snapshot', 'targetLock', 'phase', 'status', 'recovery', 'inner'], 'envelope');
  if (object.schema !== RELEASE_OPERATION_ENVELOPE_SCHEMA || typeof object.operationId !== 'string' || !UUID.test(object.operationId)) envelopeFail('schema or operation id is invalid');
  if (!['deploy', 'check', 'restore', 'deploy-exact-0.2.12'].includes(String(object.operation))) envelopeFail('operation is invalid');
  if (!ENVELOPE_PHASES.includes(object.phase as ReleaseOperationEnvelopePhase) || !ENVELOPE_STATUSES.includes(object.status as ReleaseOperationEnvelopeStatus)) envelopeFail('phase or status is invalid');
  const owner = safeOwner(object.owner); const target = safeIdentity(object.installedTarget, 'installed target'); const snapshot = safeSnapshot(object.snapshot); const targetLock = safeLock(object.targetLock); const recovery = safeRecovery(object.recovery); const inner = safeInner(object.inner);
  const envelope = Object.freeze({ schema: RELEASE_OPERATION_ENVELOPE_SCHEMA, operationId: object.operationId as string, operation: object.operation as ReleaseOperation, manifestDigest: safeDigest(object.manifestDigest, 'manifest digest'), manifestIdentityDigest: safeDigest(object.manifestIdentityDigest, 'manifest identity digest'), installedTarget: target, discoveryParentsDigest: safeDigest(object.discoveryParentsDigest, 'discovery parents digest'), runRootsDigest: safeDigest(object.runRootsDigest, 'run roots digest'), processSnapshotPathDigest: safeDigest(object.processSnapshotPathDigest, 'process snapshot path digest'), owner, snapshot, targetLock, phase: object.phase as ReleaseOperationEnvelopePhase, status: object.status as ReleaseOperationEnvelopeStatus, recovery, inner });
  if (owner.manifestDigest !== envelope.manifestDigest) envelopeFail('owner and manifest digest disagree');
  if (targetLock && targetLock.ownerId !== owner.id) envelopeFail('target lock owner disagrees');
  if (envelope.phase === 'committed' && envelope.status !== 'COMMITTED') envelopeFail('committed phase requires committed status');
  if (envelope.phase === 'failed' && envelope.status !== 'FAILED') envelopeFail('failed phase requires failed status');
  if (envelope.phase === 'attention' && envelope.status !== 'ATTENTION') envelopeFail('attention phase requires attention status');
  if (envelope.status === 'COMMITTED' && envelope.phase !== 'committed') envelopeFail('committed status requires committed phase');
  // A committed outer projection is meaningful only when it carries the
  // exact aggregate attested by the inner transaction.  `markerDigest` may
  // remain null for first-install/check paths, but aggregate absence is never
  // a valid committed state (including through the low-level write API).
  if (envelope.phase === 'committed' && envelope.inner.aggregate === null) envelopeFail('committed phase lacks inner aggregate');
  return envelope;
}

function envelopeManifestIdentity(manifest: ReleaseManifest): { manifestIdentityDigest: string; discoveryParentsDigest: string; runRootsDigest: string; processSnapshotPathDigest: string } {
  return { manifestIdentityDigest: digest({ operation: manifest.operation, installedTarget: manifest.installedTarget, discoveryParents: manifest.discoveryParents, runRoots: manifest.runRoots, processSnapshotPath: manifest.processSnapshotPath }), discoveryParentsDigest: digest(manifest.discoveryParents), runRootsDigest: digest(manifest.runRoots), processSnapshotPathDigest: digest(manifest.processSnapshotPath) };
}

export function createReleaseOperationEnvelope(input: ReleaseOperationEnvelopeInput): ReleaseOperationEnvelope {
  const manifest = validateReleaseManifest(input.manifest); const manifestDigest = safeDigest(input.manifestDigest, 'manifest digest');
  if (manifest.operation !== input.operation) envelopeFail('operation does not match release manifest');
  const identities = envelopeManifestIdentity(manifest); const { schema: _ownerSchema, ...ownerInput } = input.owner as ReleaseOwner & { epoch: number }; const owner = safeOwner({ ...ownerInput, manifestDigest });
  return validateReleaseOperationEnvelope({ schema: RELEASE_OPERATION_ENVELOPE_SCHEMA, operationId: input.operationId ?? randomUUID(), operation: input.operation, manifestDigest, ...identities, installedTarget: input.targetIdentity, owner, snapshot: input.snapshot ?? null, targetLock: input.targetLock ?? null, phase: input.phase ?? 'prepared', status: input.status ?? 'READY', recovery: { code: input.recovery?.code ?? null, attempts: input.recovery?.attempts ?? 0 }, inner: { markerDigest: input.inner?.markerDigest ?? null, aggregate: input.inner?.aggregate ?? null, previousAggregate: input.inner?.previousAggregate ?? null } });
}

async function readEnvelopeFile(path: string): Promise<ReleaseOperationEnvelopeRead> {
  const trusted = await inspectTrustedPath(path, 'release operation envelope', { allowMissing: true, surface: true, kind: 'file' }).catch((error) => envelopeFail(`envelope is unreadable: ${(error as Error).message}`));
  if (!trusted) return Object.freeze({ state: 'ABSENT', path });
  if (trusted.stat.size < 1 || trusted.stat.size > 1024 * 1024) return Object.freeze({ state: 'MALFORMED', path, reason: 'envelope exceeds byte limit' });
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    envelopeFail(`envelope cannot be opened: ${(error as Error).message}`);
  });
  if (!handle) return Object.freeze({ state: 'CONFLICTING', path, reason: 'envelope disappeared during read' });
  let bytes: Buffer;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  const after = await inspectTrustedPath(path, 'release operation envelope', { surface: true, kind: 'file' }).catch(() => undefined);
  if (!after || !sameFilesystemIdentity(trusted.identity, after.identity)) return Object.freeze({ state: 'CONFLICTING', path, reason: 'envelope identity changed during read' });
  const text = bytes.toString('utf8'); if (!Buffer.from(text, 'utf8').equals(bytes)) return Object.freeze({ state: 'MALFORMED', path, reason: 'envelope is not UTF-8' });
  try { const canonicalText = text.endsWith('\n') ? text.slice(0, -1) : text; const parsed = parseCanonical(canonicalText); const envelope = validateReleaseOperationEnvelope(parsed); if (`${canonicalString(envelope)}\n` !== text && canonicalString(envelope) !== text) return Object.freeze({ state: 'MALFORMED', path, reason: 'envelope bytes are not canonical' }); return Object.freeze({ state: 'VALID', path, bytes: text, identity: trusted.identity, envelope }); }
  catch (error) { return Object.freeze({ state: 'MALFORMED', path, reason: (error as Error).message }); }
}

export async function readReleaseOperationEnvelope(target: string, markerName = RELEASE_OPERATION_ENVELOPE_MARKER): Promise<ReleaseOperationEnvelopeRead> {
  const trustedTarget = await inspectTrustedPath(target, 'installed target', { surface: true, kind: 'directory' }).catch((error) => envelopeFail(`installed target is unsafe: ${(error as Error).message}`));
  if (!trustedTarget) envelopeFail('installed target is absent');
  if (typeof markerName !== 'string' || markerName !== RELEASE_OPERATION_ENVELOPE_MARKER) envelopeFail('envelope marker name is invalid');
  return readEnvelopeFile(join(target, markerName));
}

async function writeEnvelopeFile(path: string, bytes: string, expected?: ReleaseOperationEnvelopeRead): Promise<FilesystemIdentity> {
  const directory = dirname(path); const temporary = `${path}.${RELEASE_OPERATION_ENVELOPE_TEMP_SUFFIX}-${randomUUID()}`;
  const prior = await inspectTrustedPath(path, 'release operation envelope', { allowMissing: true, surface: true, kind: 'file' }).catch((error) => envelopeFail(`envelope is unreadable: ${(error as Error).message}`));
  if (expected) {
    if (expected.state !== 'VALID' || !expected.identity || !expected.bytes || !prior || !sameFilesystemIdentity(prior.identity, expected.identity) || prior.stat.size !== Buffer.byteLength(expected.bytes)) envelopeFail('envelope CAS identity changed');
    const current = await readEnvelopeFile(path); if (current.state !== 'VALID' || current.bytes !== expected.bytes) envelopeFail('envelope CAS bytes changed');
  } else if (prior) envelopeFail('envelope already exists');
  const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); await syncDirectory(directory, 'release operation envelope parent'); await fs.rename(temporary, path); await syncDirectory(directory, 'release operation envelope parent'); const stat = await fs.stat(path); return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) }); }
  finally { await handle.close().catch(() => undefined); await fs.unlink(temporary).then(() => syncDirectory(directory, 'release operation envelope parent')).catch(() => undefined); }
}

/** Publish a prepared marker or atomically advance one existing marker. */
export async function writeReleaseOperationEnvelope(target: string, envelope: ReleaseOperationEnvelope, expected?: ReleaseOperationEnvelopeRead): Promise<ReleaseOperationEnvelopeRead> {
  const validated = validateReleaseOperationEnvelope(envelope); const path = join(target, RELEASE_OPERATION_ENVELOPE_MARKER); const bytes = `${canonicalString(validated)}\n`; await writeEnvelopeFile(path, bytes, expected); return readEnvelopeFile(path);
}

export async function transitionReleaseOperationEnvelope(target: string, current: ReleaseOperationEnvelopeRead, next: ReleaseOperationEnvelope): Promise<ReleaseOperationEnvelopeRead> {
  if (current.state !== 'VALID') envelopeFail('transition requires a valid current envelope');
  const prior = current.envelope!;
  // Validate before inspecting fields so a malformed caller value fails closed
  // rather than being able to exploit a partial transition check.
  const candidate = validateReleaseOperationEnvelope(next);
  if (prior.operationId !== candidate.operationId || prior.operation !== candidate.operation || prior.manifestDigest !== candidate.manifestDigest
    || prior.manifestIdentityDigest !== candidate.manifestIdentityDigest
    || prior.installedTarget.pathDigest !== candidate.installedTarget.pathDigest
    || prior.installedTarget.dev !== candidate.installedTarget.dev
    || prior.installedTarget.ino !== candidate.installedTarget.ino
    || prior.discoveryParentsDigest !== candidate.discoveryParentsDigest
    || prior.runRootsDigest !== candidate.runRootsDigest
    || prior.processSnapshotPathDigest !== candidate.processSnapshotPathDigest) envelopeFail('transition identity changed');
  if (prior.phase === 'committed' || prior.phase === 'failed') envelopeFail('terminal envelope cannot transition');
  const order = new Map(ENVELOPE_PHASES.map((phase, index) => [phase, index]));
  const ownerChanged = canonicalString(prior.owner) !== canonicalString(candidate.owner);
  const ownerRebind = ownerChanged && candidate.phase === 'prepared';
  if (ownerChanged && !ownerRebind) envelopeFail('owner identity changed outside prepared rebind');
  if (ownerRebind) {
    if (candidate.owner.epoch <= prior.owner.epoch) envelopeFail('owner epoch did not advance');
    // A takeover is valid only after the same definitive liveness proof used
    // by release admission says the previous owner is not live.  Uncertainty
    // is treated as live by releaseOwnerIsLive and therefore fails closed.
    const priorOwner: ReleaseOwner = {
      schema: 'lunacy-release-owner/v1', id: prior.owner.id, pid: prior.owner.pid,
      processStartedAt: prior.owner.processStartedAt, acquiredAt: prior.owner.acquiredAt,
      manifestDigest: prior.owner.manifestDigest,
    };
    if (releaseOwnerIsLive(priorOwner)) envelopeFail('cannot rebind a live owner');
  }
  if (!ownerRebind && candidate.phase !== 'attention' && candidate.phase !== 'failed'
    && (order.get(candidate.phase)! < order.get(prior.phase)! || order.get(candidate.phase)! > order.get(prior.phase)! + 1)) envelopeFail('phase transition is not adjacent');
  if (!ownerRebind && prior.snapshot && canonicalString(prior.snapshot) !== canonicalString(candidate.snapshot)) envelopeFail('snapshot identity changed');
  if (!ownerRebind && prior.targetLock && canonicalString(prior.targetLock) !== canonicalString(candidate.targetLock)) envelopeFail('target lock identity changed');
  if (candidate.phase === 'committed' && candidate.inner.aggregate === null) envelopeFail('committed envelope lacks an inner aggregate');
  if (candidate.phase !== 'committed' && canonicalString(prior.inner) !== canonicalString(candidate.inner)) envelopeFail('inner proof changed before commit');
  return writeReleaseOperationEnvelope(target, candidate, current);
}

/** A deterministic, mutation-free status capsule.  It deliberately omits
 * paths, process arguments, and envelope payloads; callers can use the
 * operation id and phase to request the next explicit action. */
export async function releaseOperationStatus(options: Readonly<{ target: string; manifest?: ReleaseManifest; manifestDigest?: string }>): Promise<ReleaseOperationStatus> {
  const observed = await readReleaseOperationEnvelope(options.target);
  if (observed.state === 'ABSENT') return Object.freeze({ schema: RELEASE_OPERATION_ENVELOPE_SCHEMA, status: 'ABSENT', phase: null, operation: null, operationId: null, nextAction: 'create', recovery: Object.freeze({ code: null, attempts: 0 }) });
  if (observed.state !== 'VALID') return Object.freeze({ schema: RELEASE_OPERATION_ENVELOPE_SCHEMA, status: observed.state, phase: null, operation: null, operationId: null, nextAction: 'retry', recovery: Object.freeze({ code: 'malformed-envelope', attempts: 0 }) });
  const envelope = observed.envelope!; let status: ReleaseOperationStatus['status'] = 'VALID'; let code = envelope.recovery.code; let phase = envelope.phase;
  const target = await inspectTrustedPath(options.target, 'installed target', { surface: true, kind: 'directory' }).catch(() => undefined);
  if (!target || !sameFilesystemIdentity(target.identity, envelope.installedTarget)) { status = 'STALE'; code = 'target-binding-drift'; }
  if (status === 'VALID' && envelope.phase !== 'committed' && !releaseOwnerIsLive({ schema: 'lunacy-release-owner/v1', id: envelope.owner.id, pid: envelope.owner.pid, processStartedAt: envelope.owner.processStartedAt, acquiredAt: envelope.owner.acquiredAt, manifestDigest: envelope.owner.manifestDigest })) { status = 'STALE'; code = 'owner-stale'; }
  if ((options.manifest && !options.manifestDigest) || (!options.manifest && options.manifestDigest)) { status = 'STALE'; code = 'manifest-binding-incomplete'; }
  if (options.manifest && options.manifestDigest) {
    try { const manifest = validateReleaseManifest(options.manifest); const ids = envelopeManifestIdentity(manifest); if (options.manifestDigest !== envelope.manifestDigest || ids.manifestIdentityDigest !== envelope.manifestIdentityDigest || manifest.installedTarget !== options.target) { status = 'STALE'; code = 'manifest-binding-drift'; } }
    catch { status = 'MALFORMED'; code = 'manifest-invalid'; }
  }
  const nextAction = status !== 'VALID' ? 'retry' : phase === 'prepared' ? 'admit' : phase === 'admitted' ? 'quiesce' : phase === 'quiesced' ? 'delegate' : phase === 'delegated' ? 'verify' : 'none';
  return Object.freeze({ schema: RELEASE_OPERATION_ENVELOPE_SCHEMA, status, phase, operation: envelope.operation, operationId: envelope.operationId, nextAction, recovery: Object.freeze({ code: code ?? null, attempts: envelope.recovery.attempts }) });
}

async function releaseReverse(claims: readonly OwnedFileClaim[]): Promise<void> {
  let failure: unknown;
  for (const claim of [...claims].reverse()) {
    try { await claim.release(); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

/**
 * Private production release boundary.
 *
 * Global deadlock-free order:
 *   1. byte-sorted discovery-parent + installed-target release claims;
 *   2. byte-sorted per-run bridge/managed-launch admission claims;
 *   3. byte-sorted per-run store writer claims;
 *   4. the caller's installed-target deployment transaction claim.
 *
 * Normal bridge work already takes (2) before (3). Store writers take only
 * (3), and target deployment takes only (4). The ancestor release marker is
 * checked on both sides of every maintained admission, so a pre-existing
 * entrant settles before this function owns its lower-order claim while a
 * later entrant cannot cross it.
 */
export async function withReleaseExclusion<T>(options: ReleaseExclusionOptions, operation: (ownership: ReleaseExclusionOwnership) => Promise<T>): Promise<T> {
  const manifest = validateReleaseManifest(options.manifest);
  if (!/^[0-9a-f]{64}$/.test(options.manifestDigest)) fail('manifest digest is invalid');
  if (typeof operation !== 'function') fail('operation callback is required');
  const waitMs = options.waitMs ?? 30_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120_000) fail('wait is invalid');
  const suppliedOwner = options.owner;
  const owner = suppliedOwner
    ? Object.freeze({ schema: 'lunacy-release-owner/v1' as const, id: suppliedOwner.id, pid: suppliedOwner.pid, processStartedAt: suppliedOwner.processStartedAt, acquiredAt: suppliedOwner.acquiredAt, manifestDigest: suppliedOwner.manifestDigest })
    : currentReleaseOwner(options.manifestDigest);
  if (owner.manifestDigest !== options.manifestDigest) fail('release owner manifest digest differs');
  const acquired: OwnedFileClaim[] = [];
  const releaseClaims: OwnedFileClaim[] = [];
  const bridgeClaims: OwnedFileClaim[] = [];
  const writerClaims: OwnedFileClaim[] = [];
  try {
    const anchors = [...new Set([...manifest.discoveryParents, manifest.installedTarget])].sort(stableCompare);
    for (const anchor of anchors) {
      const trusted = await inspectTrustedPath(anchor, 'release anchor', { surface: true, kind: 'directory' }).catch((error) => fail(`release anchor is unsafe: ${(error as Error).message}`));
      if (!trusted) fail(`release anchor is absent: ${anchor}`);
      const claim = await acquireOwnedFileClaim(join(anchor, RELEASE_EXCLUSION_LOCK), owner, { waitMs, signal: options.signal, reclaimStaleReleaseOwner: true, label: 'release ownership' });
      acquired.push(claim); releaseClaims.push(claim);
    }
    const discovered = await discoverManagedRunRoots(manifest.discoveryParents);
    assertExactDiscoveredRoots(manifest, discovered);
    for (const root of manifest.runRoots) {
      const kernel = await inspectTrustedPath(join(root, '.kernel'), 'managed run kernel', { surface: true, kind: 'directory' }).catch((error) => fail(`managed run kernel is unsafe: ${(error as Error).message}`));
      if (!kernel) fail(`managed run kernel is absent: ${root}`);
      const claim = await acquireOwnedFileClaim(join(root, '.kernel', BRIDGE_OPERATION_LOCK), owner, { waitMs, signal: options.signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, label: 'managed launch admission' });
      acquired.push(claim); bridgeClaims.push(claim);
    }
    for (const root of manifest.runRoots) {
      const claim = await acquireOwnedFileClaim(join(root, '.kernel', WRITER_LOCK), owner, { waitMs, signal: options.signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, writerReclaimProtocol: true, label: 'run writer exclusion' });
      acquired.push(claim); writerClaims.push(claim);
    }
    const ownership = Object.freeze({
      manifest, manifestDigest: options.manifestDigest, owner,
      ownerBytes: writerClaims[0]?.bytes ?? releaseClaims[0]!.bytes,
      releaseClaims: Object.freeze([...releaseClaims]), bridgeClaims: Object.freeze([...bridgeClaims]), writerClaims: Object.freeze([...writerClaims]),
    });
    if (options.signal?.aborted) { const error = new Error('release operation cancelled'); error.name = 'AbortError'; throw error; }
    return await operation(ownership);
  } finally {
    await releaseReverse(acquired);
  }
}
