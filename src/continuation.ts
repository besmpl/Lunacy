import { promises as fs, constants as fsConstants } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalString, digest, parseCanonical } from './canonical.js';
import { canonicalizeDeclaration } from './bridge.js';
import { FileArtifactStore } from './store.js';
import { inspectTrustedPath, sameFilesystemIdentity, ensurePrivateDirectory, filesystemIdentity, type FilesystemIdentity, syncDirectory } from './filesystem.js';
import { resumeRun, type LifecycleOptions, type LifecycleResult, type TerminalEffectDriver } from './orchestration.js';
import { codexHostPolicyDigest, validateCodexHostPolicy, type CodexHostPolicy } from './codex-host-policy.js';
import type { MachineState, Plan } from './model.js';
import { decodeWorkerProof, verifyWorkerProof, type CheckContract, type WorkerProof } from './codex-worker-proof.js';
import { validateLaunchRecord, validateTerminalRecord, type LaunchRecord, type TerminalRecord } from './codex-effect-records.js';

/**
 * Private, explicit, decision-disabled continuation metadata.  This module is
 * intentionally not imported by the package root: it is an observational
 * sidecar around the existing FileArtifactStore and BridgeDrivePump seams.
 */
export const CONTINUATION_SCHEMA = 'lunacy-continuation/v1' as const;
export const CONTINUATION_VERSION = 1 as const;
export const CONTINUATION_SIDECAR = 'continuation.json' as const;
export const CONTINUATION_LOCK = '.continuation.lock' as const;
export const CONTINUATION_MAX_WAKES = 1024 as const;
export const CONTINUATION_MAX_RECORD_BYTES = 64 * 1024;
export const CONTINUATION_MAX_LEASE_MS = 24 * 60 * 60 * 1000;
export const CONTINUATION_DEFAULT_LEASE_MS = 30 * 1000;
export const CONTINUATION_MAX_OWNER_LENGTH = 256;

export const CONTINUATION_WAKE_SOURCES = Object.freeze([
  'explicit-resume', 'proof',
] as const);
export type ContinuationWakeSource = (typeof CONTINUATION_WAKE_SOURCES)[number];

export const CONTINUATION_ATTENTION_CODES = Object.freeze([
  'MALFORMED',
  'MALFORMED_PROOF',
  'DISABLED',
  'CURRENT_INVALID',
  'BINDING_DRIFT',
  'LEASE_LOST',
  'STALE_LIVENESS',
  'LEASE_EXPIRED',
  'REVOKED',
  'MAX_WAKES',
  'DEADLINE_EXPIRED',
  'CANCELLED',
  'UNKNOWN',
  'UNSUPPORTED_WAKE',
  'UNSUPPORTED_BOUNDARY',
  'SIDECAR_CONFLICT',
  'SIDECAR_FAULT',
  'LIFECYCLE_ERROR',
] as const);
export type ContinuationAttentionCode = (typeof CONTINUATION_ATTENTION_CODES)[number];

export type ContinuationState = 'ACTIVE' | 'ATTENTION' | 'REVOKED' | 'CLOSED';
export type ContinuationRecord = Readonly<{
  schema: typeof CONTINUATION_SCHEMA;
  version: typeof CONTINUATION_VERSION;
  runRoot: string;
  runId: string;
  phaseId: string;
  planDigest: string;
  policyDigest: string | null;
  rootIdentity: FilesystemIdentity;
  owner: string;
  ownerNonce: string;
  ownerPid: number;
  leaseEpoch: number;
  leaseExpiresAt: string;
  deadline: string;
  maxWakes: number;
  wakeCount: number;
  wakeInFlight: boolean;
  wakeSources: readonly ContinuationWakeSource[];
  generation: number;
  currentGeneration: number;
  currentRevision: number;
  currentAuthorityEpoch: number;
  currentAttemptEpoch: number;
  currentBarrierEpoch: number;
  revocationGeneration: number;
  state: ContinuationState;
  attention: ContinuationAttentionCode | null;
  lastWakeSource: ContinuationWakeSource | null;
  lastWakeAt: string | null;
}>;

export type ContinuationCreateOptions = Readonly<{
  runRoot: string;
  runId: string;
  plan: Plan;
  policy?: CodexHostPolicy;
  owner?: string;
  ownerNonce?: string;
  leaseTtlMs?: number;
  deadline?: string | number | Date;
  maxWakes?: number;
  wakeSources?: readonly ContinuationWakeSource[];
  sidecarPath?: string;
  lockWaitMs?: number;
  now?: string | number | Date;
  faultInjector?: (point: string) => void;
}>;

export type ContinuationLoadOptions = Readonly<Pick<ContinuationCreateOptions, 'runRoot' | 'runId' | 'plan' | 'policy' | 'sidecarPath' | 'owner' | 'ownerNonce' | 'lockWaitMs' | 'faultInjector'>>;

export type ContinuationWakeOptions = Readonly<{
  source: ContinuationWakeSource | string;
  plan: Plan;
  driver?: TerminalEffectDriver;
  policy?: CodexHostPolicy;
  signal?: AbortSignal;
  maxTransitions?: number;
  dispatcher?: LifecycleOptions['dispatcher'];
  /** A proof publication wake must carry a closed proof and contract. */
  proof?: WorkerProof | string | Uint8Array;
  contract?: CheckContract;
  terminal?: TerminalRecord;
  launch?: LaunchRecord;
  now?: string | number | Date;
}>;

export type ContinuationWakeResult = Readonly<{
  schema: typeof CONTINUATION_SCHEMA;
  version: typeof CONTINUATION_VERSION;
  status: 'advanced' | 'attention' | 'disabled';
  source: string;
  wakeCount: number;
  leaseEpoch: number;
  generation: number;
  lifecycle?: LifecycleResult;
  attention?: Readonly<{ code: ContinuationAttentionCode }>;
}>;

export class ContinuationError extends Error {
  constructor(public readonly code: ContinuationAttentionCode, message: string) {
    super(message);
    this.name = `Continuation${code}`;
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ISO_MAX = 64;
const processLocks = new Map<string, Promise<void>>();

function stableCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function fail(code: ContinuationAttentionCode, message: string): never { throw new ContinuationError(code, message); }
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > CONTINUATION_MAX_OWNER_LENGTH || CONTROL.test(value)) fail('MALFORMED', `${label} is invalid`);
  return value;
}
function digestValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('MALFORMED', `${label} is invalid`);
  return value;
}
function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('MALFORMED', `${label} is invalid`);
  return value as number;
}
function positive(value: unknown, label: string): number {
  const number = nonNegative(value, label);
  if (number < 1) fail('MALFORMED', `${label} must be positive`);
  return number;
}
function canonicalTime(value: unknown, label: string): string {
  let date: Date;
  if (value instanceof Date) date = new Date(value.getTime());
  else if (typeof value === 'number' && Number.isFinite(value)) date = new Date(value);
  else if (typeof value === 'string' && value.length <= ISO_MAX && !CONTROL.test(value)) date = new Date(value);
  else fail('MALFORMED', `${label} is invalid`);
  if (!Number.isFinite(date.getTime())) fail('MALFORMED', `${label} is invalid`);
  const iso = date.toISOString();
  if (typeof value === 'string' && value !== iso) fail('MALFORMED', `${label} is not canonical UTC`);
  return iso;
}
function nowIso(value: unknown): string {
  return value === undefined ? new Date().toISOString() : canonicalTime(value, 'now');
}
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plain(value)) fail('MALFORMED', `${label} is malformed`);
  const actual = Object.keys(value).sort(stableCompare);
  const expected = [...keys].sort(stableCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail('MALFORMED', `${label} fields are not closed`);
  return value;
}
function canonicalRoot(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !value.startsWith('/') || resolve(value) !== value) fail('MALFORMED', `${label} must be an absolute canonical path`);
  return value;
}
function pathWithin(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !relation.startsWith(sep));
}
function sidecarFor(root: string, requested?: string): string {
  const defaultPath = join(root, '.kernel', CONTINUATION_SIDECAR);
  const path = requested === undefined ? defaultPath : canonicalRoot(requested, 'sidecarPath');
  if (!pathWithin(join(root, '.kernel'), path)) fail('MALFORMED', 'sidecarPath must remain within .kernel');
  return path;
}
function source(value: unknown): ContinuationWakeSource {
  if (typeof value !== 'string' || !CONTINUATION_WAKE_SOURCES.includes(value as ContinuationWakeSource)) fail('UNSUPPORTED_WAKE', 'wake source is not supported');
  return value as ContinuationWakeSource;
}
function sources(value: unknown): readonly ContinuationWakeSource[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CONTINUATION_WAKE_SOURCES.length) fail('MALFORMED', 'wakeSources are invalid');
  const list = value.map((entry) => source(entry));
  const sorted = [...list].sort(stableCompare);
  if (new Set(list).size !== list.length || list.some((entry, index) => entry !== sorted[index])) fail('MALFORMED', 'wakeSources must be byte-sorted and unique');
  return Object.freeze(list);
}
function identity(value: unknown): FilesystemIdentity {
  const object = exact(value, ['dev', 'ino'], 'rootIdentity');
  if (typeof object.dev !== 'string' || object.dev.length === 0 || object.dev.length > 100 || typeof object.ino !== 'string' || object.ino.length === 0 || object.ino.length > 100) fail('MALFORMED', 'rootIdentity is invalid');
  return Object.freeze({ dev: object.dev, ino: object.ino });
}
function status(value: unknown): ContinuationState {
  if (value !== 'ACTIVE' && value !== 'ATTENTION' && value !== 'REVOKED' && value !== 'CLOSED') fail('MALFORMED', 'state is invalid');
  return value;
}
function attentionCode(value: unknown): ContinuationAttentionCode | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !(CONTINUATION_ATTENTION_CODES as readonly string[]).includes(value)) fail('MALFORMED', 'attention is invalid');
  return value as ContinuationAttentionCode;
}
function nullableSource(value: unknown): ContinuationWakeSource | null {
  if (value === null) return null;
  return source(value);
}
function parseRecord(value: unknown): ContinuationRecord {
  const object = exact(value, [
    'attention', 'currentAttemptEpoch', 'currentAuthorityEpoch', 'currentBarrierEpoch', 'currentGeneration', 'currentRevision',
    'deadline', 'generation', 'lastWakeAt', 'lastWakeSource', 'leaseEpoch', 'leaseExpiresAt', 'maxWakes', 'owner', 'ownerNonce', 'ownerPid',
    'phaseId', 'planDigest', 'policyDigest', 'revocationGeneration', 'rootIdentity', 'runId', 'runRoot', 'schema', 'state', 'version', 'wakeCount', 'wakeInFlight', 'wakeSources',
  ], 'continuation record');
  if (object.schema !== CONTINUATION_SCHEMA || object.version !== CONTINUATION_VERSION) fail('MALFORMED', 'schema/version is invalid');
  const runRoot = canonicalRoot(object.runRoot, 'runRoot');
  const runId = id(object.runId, 'runId');
  const phaseId = id(object.phaseId, 'phaseId');
  const planDigest = digestValue(object.planDigest, 'planDigest');
  const policyDigest = object.policyDigest === null ? null : digestValue(object.policyDigest, 'policyDigest');
  const owner = id(object.owner, 'owner');
  const ownerNonce = id(object.ownerNonce, 'ownerNonce');
  const ownerPid = positive(object.ownerPid, 'ownerPid');
  const leaseEpoch = positive(object.leaseEpoch, 'leaseEpoch');
  const leaseExpiresAt = canonicalTime(object.leaseExpiresAt, 'leaseExpiresAt');
  const deadline = canonicalTime(object.deadline, 'deadline');
  if (Date.parse(leaseExpiresAt) > Date.parse(deadline)) fail('MALFORMED', 'leaseExpiresAt exceeds deadline');
  const maxWakes = positive(object.maxWakes, 'maxWakes');
  if (maxWakes > CONTINUATION_MAX_WAKES) fail('MALFORMED', 'maxWakes exceeds ceiling');
  const wakeCount = nonNegative(object.wakeCount, 'wakeCount');
  if (typeof object.wakeInFlight !== 'boolean') fail('MALFORMED', 'wakeInFlight is invalid');
  if (wakeCount > maxWakes) fail('MALFORMED', 'wakeCount exceeds maxWakes');
  const generation = positive(object.generation, 'generation');
  const currentGeneration = positive(object.currentGeneration, 'currentGeneration');
  const currentRevision = nonNegative(object.currentRevision, 'currentRevision');
  const currentAuthorityEpoch = nonNegative(object.currentAuthorityEpoch, 'currentAuthorityEpoch');
  const currentAttemptEpoch = nonNegative(object.currentAttemptEpoch, 'currentAttemptEpoch');
  const currentBarrierEpoch = nonNegative(object.currentBarrierEpoch, 'currentBarrierEpoch');
  const revocationGeneration = nonNegative(object.revocationGeneration, 'revocationGeneration');
  const stateValue = status(object.state);
  const attention = attentionCode(object.attention);
  const wakeSources = sources(object.wakeSources);
  const lastWakeSource = nullableSource(object.lastWakeSource);
  const lastWakeAt = object.lastWakeAt === null ? null : canonicalTime(object.lastWakeAt, 'lastWakeAt');
  if (stateValue === 'ACTIVE' && attention !== null) fail('MALFORMED', 'active continuation cannot carry attention');
  if (stateValue !== 'ACTIVE' && attention === null && stateValue !== 'CLOSED') fail('MALFORMED', 'terminal continuation requires attention');
  const result: ContinuationRecord = Object.freeze({
    schema: CONTINUATION_SCHEMA, version: CONTINUATION_VERSION, runRoot, runId, phaseId, planDigest, policyDigest,
    rootIdentity: identity(object.rootIdentity), owner, ownerNonce, ownerPid, leaseEpoch, leaseExpiresAt, deadline,
    maxWakes, wakeCount, wakeInFlight: object.wakeInFlight, wakeSources, generation, currentGeneration, currentRevision, currentAuthorityEpoch, currentAttemptEpoch,
    currentBarrierEpoch, revocationGeneration, state: stateValue, attention, lastWakeSource, lastWakeAt,
  });
  if (Buffer.byteLength(canonicalString(result), 'utf8') > CONTINUATION_MAX_RECORD_BYTES) fail('MALFORMED', 'continuation record exceeds byte ceiling');
  return result;
}
function recordBytes(record: ContinuationRecord): string { return canonicalString(parseRecord(record)); }
function asDate(value: string): number { return Date.parse(value); }
function parseNow(value: unknown): number {
  const iso = nowIso(value);
  const millis = asDate(iso);
  if (!Number.isFinite(millis)) fail('MALFORMED', 'now is invalid');
  return millis;
}
type OwnerLiveness = 'LIVE' | 'DEAD' | 'UNKNOWN';
function ownerLiveness(pid: number): OwnerLiveness {
  try { process.kill(pid, 0); return 'LIVE'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'DEAD' : 'UNKNOWN'; }
}
function attentionResult(record: ContinuationRecord, code: ContinuationAttentionCode, sourceValue: string): ContinuationWakeResult {
  return Object.freeze({ schema: CONTINUATION_SCHEMA, version: CONTINUATION_VERSION, status: code === 'DISABLED' ? 'disabled' as const : 'attention' as const, source: sourceValue, wakeCount: record.wakeCount, leaseEpoch: record.leaseEpoch, generation: record.generation, attention: { code } });
}
function successResult(record: ContinuationRecord, lifecycle: LifecycleResult, sourceValue: string): ContinuationWakeResult {
  return Object.freeze({ schema: CONTINUATION_SCHEMA, version: CONTINUATION_VERSION, status: 'advanced' as const, source: sourceValue, wakeCount: record.wakeCount, leaseEpoch: record.leaseEpoch, generation: record.generation, lifecycle });
}

async function withProcessLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = processLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const queued = prior.then(() => current);
  processLocks.set(key, queued);
  await prior;
  try { return await operation(); }
  finally { release(); if (processLocks.get(key) === queued) void queued.then(() => { if (processLocks.get(key) === queued) processLocks.delete(key); }); }
}

async function verifyBoundFile(path: string, expected: FilesystemIdentity, expectedBytes: string, label: string): Promise<void> {
  const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
  if (!trusted || !sameFilesystemIdentity(expected, trusted.identity)) fail('SIDECAR_FAULT', `${label} identity changed`);
  let handle: import('node:fs').promises.FileHandle | undefined;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    const expectedBuffer = Buffer.from(expectedBytes, 'utf8');
    if (!stat.isFile() || stat.size !== expectedBuffer.byteLength || stat.size > CONTINUATION_MAX_RECORD_BYTES || !sameFilesystemIdentity(expected, filesystemIdentity(stat))) fail('SIDECAR_FAULT', `${label} changed before verification`);
    const bytes = await handle.readFile();
    if (!expectedBuffer.equals(bytes)) fail('SIDECAR_FAULT', `${label} bytes changed before verification`);
  } finally { await handle?.close().catch(() => undefined); }
}

async function cleanupBoundFile(path: string, parentPath: string, parentIdentity: FilesystemIdentity, expected: FilesystemIdentity, expectedBytes: string): Promise<void> {
  // Cleanup is deliberately conservative: any inspection/open/identity error
  // leaves the name untouched.  Under the stable-namespace contract the
  // checks bind this unlink to the temp inode and exact canonical bytes
  // created by this operation.
  try {
    const parent = await inspectTrustedPath(parentPath, 'continuation temp parent', { surface: true, kind: 'directory' });
    if (!parent || !sameFilesystemIdentity(parent.identity, parentIdentity)) return;
    const trusted = await inspectTrustedPath(path, 'continuation temporary', { surface: true, kind: 'file' });
    if (!trusted || !sameFilesystemIdentity(trusted.identity, expected)) return;
    const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      const expectedBuffer = Buffer.from(expectedBytes, 'utf8');
      if (!sameFilesystemIdentity(expected, filesystemIdentity(stat)) || stat.size !== expectedBuffer.byteLength || stat.size > CONTINUATION_MAX_RECORD_BYTES) return;
      const bytes = await handle.readFile();
      if (!expectedBuffer.equals(bytes)) return;
    } finally { await handle.close(); }
    await fs.unlink(path);
    await syncDirectory(parentPath, 'continuation temp parent').catch(() => undefined);
  } catch { /* uncertainty never authorizes unlink */ }
}

async function acquireLock(path: string, waitMs: number): Promise<(() => Promise<void>) | undefined> {
  const started = Date.now();
  const directory = dirname(path);
  const parent = await ensurePrivateDirectory(directory, 'continuation lock parent');
  const ownerBytes = canonicalString({ ownerNonce: randomUUID(), ownerPid: process.pid, acquiredAt: new Date().toISOString() });
  for (;;) {
    let handle: import('node:fs').promises.FileHandle | undefined;
    let createdIdentity: FilesystemIdentity | undefined;
    try {
      const currentParent = await inspectTrustedPath(directory, 'continuation lock parent', { surface: true, kind: 'directory' });
      if (!currentParent || !sameFilesystemIdentity(parent.identity, currentParent.identity)) fail('SIDECAR_FAULT', 'continuation lock parent changed before create');
      handle = await fs.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      createdIdentity = filesystemIdentity(await handle.stat());
      await handle.writeFile(ownerBytes, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      const afterParent = await inspectTrustedPath(directory, 'continuation lock parent', { surface: true, kind: 'directory' });
      if (!afterParent || !sameFilesystemIdentity(parent.identity, afterParent.identity)) fail('SIDECAR_FAULT', 'continuation lock parent changed after create');
      await verifyBoundFile(path, createdIdentity, ownerBytes, 'continuation lock');
      return async () => {
        // Release is identity- and byte-bound.  Missing, replaced, malformed,
        // or inspection-error paths are all no-ops; this operation never
        // reclaims a lock it cannot prove was created by this acquisition.
        try {
          const currentParent = await inspectTrustedPath(directory, 'continuation lock parent', { surface: true, kind: 'directory' });
          if (!currentParent || !sameFilesystemIdentity(parent.identity, currentParent.identity)) return;
          await verifyBoundFile(path, createdIdentity!, ownerBytes, 'continuation lock');
          await fs.unlink(path);
          await syncDirectory(directory, 'continuation lock directory').catch(() => undefined);
        } catch { /* conservative release no-op */ }
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A lock is an ownership fence, not a lease.  Its mtime cannot prove
      // that the writer is dead, so elapsed wall time never authorizes steal.
      if (Date.now() - started >= waitMs) return undefined;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(10, Math.max(1, waitMs - (Date.now() - started)))));
    }
  }
}

async function readSidecar(path: string): Promise<ContinuationRecord | undefined> {
  const trusted = await inspectTrustedPath(path, 'continuation sidecar', { allowMissing: true, surface: true, kind: 'file' });
  if (!trusted) return undefined;
  let handle;
  try { handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('MALFORMED', 'continuation sidecar is a symlink'); throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameFilesystemIdentity(filesystemIdentity(stat), trusted.identity)) fail('MALFORMED', 'continuation sidecar changed before read');
    if (stat.size < 1 || stat.size > CONTINUATION_MAX_RECORD_BYTES) fail('MALFORMED', 'continuation sidecar exceeds byte ceiling');
    const bytes = await handle.readFile();
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('MALFORMED', 'continuation sidecar is not UTF-8');
    return parseRecord(parseCanonical(text));
  } catch (error) {
    if (error instanceof ContinuationError) throw error;
    fail('MALFORMED', 'continuation sidecar is not canonical JSON');
  } finally { await handle.close(); }
}

async function publishSidecar(path: string, record: ContinuationRecord, faultInjector?: (point: string) => void): Promise<void> {
  const directory = dirname(path);
  const root = await inspectTrustedPath(record.runRoot, 'continuation run root', { surface: true, kind: 'directory' });
  if (!root || !sameFilesystemIdentity(record.rootIdentity, root.identity)) fail('SIDECAR_FAULT', 'continuation run root changed');
  const parent = await ensurePrivateDirectory(directory, 'continuation sidecar directory');
  const assertBoundary = async (boundary: string): Promise<void> => {
    const currentRoot = await inspectTrustedPath(record.runRoot, 'continuation run root', { surface: true, kind: 'directory' });
    if (!currentRoot || !sameFilesystemIdentity(record.rootIdentity, currentRoot.identity)) fail('SIDECAR_FAULT', `continuation run root changed at ${boundary}`);
    const currentParent = await inspectTrustedPath(directory, 'continuation sidecar directory', { surface: true, kind: 'directory' });
    if (!currentParent || !sameFilesystemIdentity(parent.identity, currentParent.identity)) fail('SIDECAR_FAULT', `sidecar parent changed at ${boundary}`);
  };
  const text = recordBytes(record);
  faultInjector?.('before-temp');
  await assertBoundary('before-temp');
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryHandle: import('node:fs').promises.FileHandle | undefined;
  let temporaryIdentity: FilesystemIdentity | undefined;
  try {
    temporaryHandle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    temporaryIdentity = filesystemIdentity(await temporaryHandle.stat());
    await assertBoundary('after-temp-open');
    await temporaryHandle.writeFile(text, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    faultInjector?.('after-temp-write');
    await assertBoundary('after-temp-write');
    faultInjector?.('before-rename');
    await assertBoundary('before-rename');
    await verifyBoundFile(temporary, temporaryIdentity, text, 'continuation temporary');
    await assertBoundary('before-rename-final');
    await fs.rename(temporary, path);
    await assertBoundary('after-rename');
    await syncDirectory(directory, 'continuation sidecar directory');
    faultInjector?.('after-directory-sync');
  } catch (error) {
    if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
    if (temporaryIdentity) await cleanupBoundFile(temporary, directory, parent.identity, temporaryIdentity, text);
    throw error;
  }
}

async function trustedRun(options: { runRoot: string; runId: string; plan: Plan; policy?: CodexHostPolicy; expected?: ContinuationRecord }): Promise<{ state: NonNullable<Awaited<ReturnType<FileArtifactStore['loadReadOnly']>>['state']>; generation: number; rootIdentity: FilesystemIdentity; planDigest: string; policyDigest: string | null }> {
  const runRoot = canonicalRoot(options.runRoot, 'runRoot');
  const plan = canonicalizeDeclaration(options.plan);
  const planDigest = digest(plan);
  let policyDigest: string | null = null;
  if (options.policy !== undefined) {
    const policy = validateCodexHostPolicy(options.policy);
    if (policy.runRoot !== runRoot || policy.runId !== options.runId || policy.planDigest !== planDigest) fail('BINDING_DRIFT', 'policy does not match run binding');
    policyDigest = codexHostPolicyDigest(policy);
  }
  const store = new FileArtifactStore(runRoot);
  let loaded: Awaited<ReturnType<FileArtifactStore['loadReadOnly']>>;
  try { loaded = await store.loadReadOnly(options.runId); }
  catch { fail('CURRENT_INVALID', 'CURRENT could not be verified'); }
  if (!loaded.state || loaded.state.runId !== options.runId || loaded.state.planDigest !== planDigest || loaded.metadata.rootPath !== runRoot || loaded.metadata.phaseId !== loaded.state.phaseId) fail('BINDING_DRIFT', 'CURRENT binding differs from continuation');
  const root = await inspectTrustedPath(runRoot, 'continuation run root', { surface: true, kind: 'directory' });
  if (!root) fail('CURRENT_INVALID', 'run root is absent');
  if (options.expected) {
    const prior = options.expected;
    if (prior.runRoot !== runRoot || prior.runId !== options.runId || prior.phaseId !== loaded.state.phaseId || prior.planDigest !== planDigest || prior.policyDigest !== policyDigest || !sameFilesystemIdentity(prior.rootIdentity, root.identity)) fail('BINDING_DRIFT', 'continuation binding changed');
    if (prior.currentGeneration !== loaded.generation || prior.currentRevision !== loaded.state.revision || prior.currentAuthorityEpoch !== loaded.state.authorityEpoch || prior.currentAttemptEpoch !== loaded.state.attemptEpoch || prior.currentBarrierEpoch !== loaded.state.barrierEpoch) fail('BINDING_DRIFT', 'CURRENT generation or epoch drifted');
  }
  return { state: loaded.state, generation: loaded.generation, rootIdentity: root.identity, planDigest, policyDigest };
}

function buildRecord(options: ContinuationCreateOptions, trusted: Awaited<ReturnType<typeof trustedRun>>): ContinuationRecord {
  const now = parseNow(options.now);
  const leaseTtl = options.leaseTtlMs ?? CONTINUATION_DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseTtl) || leaseTtl < 1 || leaseTtl > CONTINUATION_MAX_LEASE_MS) fail('MALFORMED', 'leaseTtlMs is invalid');
  const deadline = options.deadline === undefined ? new Date(now + leaseTtl).toISOString() : canonicalTime(options.deadline, 'deadline');
  const deadlineMs = asDate(deadline);
  if (deadlineMs <= now) fail('DEADLINE_EXPIRED', 'deadline has expired');
  const leaseExpiresAt = new Date(Math.min(now + leaseTtl, deadlineMs)).toISOString();
  const maxWakes = options.maxWakes ?? 16;
  if (!Number.isSafeInteger(maxWakes) || maxWakes < 1 || maxWakes > CONTINUATION_MAX_WAKES) fail('MALFORMED', 'maxWakes is invalid');
  const wakeSources = options.wakeSources === undefined ? CONTINUATION_WAKE_SOURCES : sources(options.wakeSources);
  const owner = options.owner ?? `continuation:${process.pid}`;
  const ownerNonce = options.ownerNonce ?? randomUUID();
  const initial: ContinuationRecord = {
    schema: CONTINUATION_SCHEMA, version: CONTINUATION_VERSION, runRoot: options.runRoot, runId: options.runId,
    phaseId: trusted.state.phaseId, planDigest: trusted.planDigest, policyDigest: trusted.policyDigest, rootIdentity: trusted.rootIdentity,
    owner: id(owner, 'owner'), ownerNonce: id(ownerNonce, 'ownerNonce'), ownerPid: process.pid, leaseEpoch: 1,
    leaseExpiresAt, deadline, maxWakes, wakeCount: 0, wakeInFlight: false, wakeSources,
    generation: 1, currentGeneration: trusted.generation, currentRevision: trusted.state.revision,
    currentAuthorityEpoch: trusted.state.authorityEpoch, currentAttemptEpoch: trusted.state.attemptEpoch, currentBarrierEpoch: trusted.state.barrierEpoch,
    revocationGeneration: 0, state: 'ACTIVE', attention: null, lastWakeSource: null, lastWakeAt: null,
  };
  return parseRecord(initial);
}

async function withSidecarLock<T>(path: string, waitMs: number, operation: () => Promise<T>): Promise<T> {
  return withProcessLock(path, async () => {
    const release = await acquireLock(path, waitMs);
    if (!release) fail('SIDECAR_CONFLICT', 'continuation sidecar is busy');
    try { return await operation(); } finally { await release(); }
  });
}

async function loadAndValidate(options: ContinuationLoadOptions, requireOwner = false): Promise<{ record: ContinuationRecord; path: string; trusted: Awaited<ReturnType<typeof trustedRun>> }> {
  const runRoot = canonicalRoot(options.runRoot, 'runRoot');
  const path = sidecarFor(runRoot, options.sidecarPath);
  const record = await readSidecar(path);
  if (!record) fail('DISABLED', 'continuation sidecar is absent');
  const trusted = await trustedRun({ runRoot, runId: options.runId, plan: options.plan, policy: options.policy, expected: record });
  if (requireOwner && (options.owner === undefined || options.ownerNonce === undefined || options.owner !== record.owner || options.ownerNonce !== record.ownerNonce)) fail('LEASE_LOST', 'continuation owner or nonce does not match');
  return { record, path, trusted };
}

/** Create and atomically publish one explicit continuation sidecar. */
export async function createContinuationSession(options: ContinuationCreateOptions): Promise<ContinuationSession> {
  const runRoot = canonicalRoot(options.runRoot, 'runRoot');
  const path = sidecarFor(runRoot, options.sidecarPath);
  const trusted = await trustedRun({ runRoot, runId: options.runId, plan: options.plan, policy: options.policy });
  return withSidecarLock(join(dirname(path), CONTINUATION_LOCK), options.lockWaitMs ?? 1000, async () => {
    const existing = await readSidecar(path);
    if (existing && existing.state === 'ACTIVE') fail('SIDECAR_CONFLICT', 'continuation sidecar already has an active owner');
    const record = buildRecord({ ...options, runRoot }, trusted);
    await publishSidecar(path, record, options.faultInjector);
    return new ContinuationSession({ ...options, runRoot }, path, record);
  });
}

/** Reload an existing sidecar after restart. Absence is a disabled route. */
export async function loadContinuationSession(options: ContinuationLoadOptions): Promise<ContinuationSession | undefined> {
  const runRoot = canonicalRoot(options.runRoot, 'runRoot');
  const path = sidecarFor(runRoot, options.sidecarPath);
  let loaded: Awaited<ReturnType<typeof loadAndValidate>>;
  try { loaded = await loadAndValidate({ ...options, runRoot }); }
  catch (error) { if (error instanceof ContinuationError && error.code === 'DISABLED') return undefined; throw error; }
  return new ContinuationSession({ ...options, runRoot }, path, loaded.record);
}

export class ContinuationSession {
  private readonly options: ContinuationCreateOptions;
  private readonly path: string;
  private recordValue: ContinuationRecord;
  constructor(options: ContinuationCreateOptions, path: string, record: ContinuationRecord) {
    this.options = Object.freeze({ ...options, runRoot: canonicalRoot(options.runRoot, 'runRoot') });
    this.path = path;
    this.recordValue = record;
  }
  get record(): ContinuationRecord { return this.recordValue; }
  get sidecarPath(): string { return this.path; }

  async reload(): Promise<ContinuationRecord> {
    const loaded = await loadAndValidate(this.options);
    this.recordValue = loaded.record;
    return loaded.record;
  }

  async revoke(): Promise<ContinuationRecord> {
    const lock = join(dirname(this.path), CONTINUATION_LOCK);
    return withSidecarLock(lock, this.options.lockWaitMs ?? 1000, async () => {
      const loaded = await loadAndValidate(this.options, true);
      const current = loaded.record;
      if (current.state === 'REVOKED') { this.recordValue = current; return current; }
      const next = parseRecord({ ...current, generation: current.generation + 1, revocationGeneration: current.revocationGeneration + 1, state: 'REVOKED', attention: 'REVOKED' });
      await publishSidecar(this.path, next, this.options.faultInjector);
      this.recordValue = next;
      return next;
    });
  }

  /** Explicit owner renewal. Renewal is a lease-epoch fence, not a timer. */
  async renew(input: Readonly<{ leaseTtlMs?: number; now?: string | number | Date }> = {}): Promise<ContinuationRecord> {
    const lock = join(dirname(this.path), CONTINUATION_LOCK);
    return withSidecarLock(lock, this.options.lockWaitMs ?? 1000, async () => {
      const loaded = await loadAndValidate(this.options, true);
      const current = loaded.record;
      const now = parseNow(input.now);
      if (current.state !== 'ACTIVE') { this.recordValue = current; return current; }
      if (now >= Date.parse(current.deadline)) fail('DEADLINE_EXPIRED', 'continuation deadline has expired');
      // Renewal is only valid while the existing lease is live.  An elapsed
      // lease cannot be resurrected by the old owner/nonce: without a
      // separately proven-dead recovery protocol, preserve the old fence and
      // stop at bounded attention instead of advancing leaseEpoch.
      const liveness = ownerLiveness(current.ownerPid);
      if (liveness !== 'LIVE' || now >= Date.parse(current.leaseExpiresAt)) {
        const code: ContinuationAttentionCode = now >= Date.parse(current.leaseExpiresAt) && liveness === 'DEAD' ? 'LEASE_EXPIRED' : 'STALE_LIVENESS';
        const next = parseRecord({ ...current, wakeInFlight: false, generation: current.generation + 1, state: 'ATTENTION', attention: code });
        await publishSidecar(this.path, next, this.options.faultInjector);
        this.recordValue = next;
        return next;
      }
      const ttl = input.leaseTtlMs ?? this.options.leaseTtlMs ?? CONTINUATION_DEFAULT_LEASE_MS;
      if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > CONTINUATION_MAX_LEASE_MS) fail('MALFORMED', 'leaseTtlMs is invalid');
      const next = parseRecord({ ...current, generation: current.generation + 1, leaseEpoch: current.leaseEpoch + 1, leaseExpiresAt: new Date(Math.min(now + ttl, Date.parse(current.deadline))).toISOString() });
      await publishSidecar(this.path, next, this.options.faultInjector);
      this.recordValue = next;
      return next;
    });
  }

  async wake(input: ContinuationWakeOptions): Promise<ContinuationWakeResult> {
    return wakeContinuationSession({ session: this, ...input });
  }
}

function lifecycleAttention(result: LifecycleResult): ContinuationAttentionCode | undefined {
  if (result.stop === 'cancelled') return 'CANCELLED';
  if (result.yield?.kind === 'BLOCKED' && result.yield.code === 'UnknownDispatch') return 'UNKNOWN';
  if (result.yield?.kind === 'DECISION_REQUIRED' || result.yield?.kind === 'BLOCKED' || result.yield?.kind === 'FINAL') return 'UNSUPPORTED_BOUNDARY';
  if (result.stop === 'terminal-invalid' || result.stop === 'terminal-unavailable') return 'UNSUPPORTED_BOUNDARY';
  return undefined;
}

function decodeWakeProof(input: ContinuationWakeOptions): { proof?: WorkerProof; attention?: ContinuationAttentionCode } {
  if (input.source !== 'proof') return {};
  // Proof wake is deliberately stricter than the generic verifier: the
  // effect witness must be supplied so the checkpoint can bind it to the
  // current outbox command, rather than accepting a bare terminal label.
  if (input.proof === undefined || input.contract === undefined || input.terminal === undefined || input.launch === undefined) return { attention: 'MALFORMED_PROOF' };
  try {
    const proof = typeof input.proof === 'string' || input.proof instanceof Uint8Array ? decodeWorkerProof(input.proof) : input.proof;
    const launch = validateLaunchRecord(input.launch);
    const terminal = validateTerminalRecord(input.terminal);
    const verdict = verifyWorkerProof(input.contract, proof, { at: input.now ?? new Date().toISOString(), binding: { terminal, launch } });
    return verdict === 'CERTIFIED' ? { proof } : { attention: 'MALFORMED_PROOF' };
  } catch { return { attention: 'MALFORMED_PROOF' }; }
}

/**
 * A certified proof is still only a wake witness.  Before checkpointing it
 * must name the exact command/effect currently retained by CURRENT: same run,
 * phase, attempt, launch token, command digest, and an ACKED receipt.  This
 * closes the stale-valid-proof window without making the sidecar an authority.
 */
function proofCurrentBinding(proof: WorkerProof, launchInput: LaunchRecord, terminalInput: TerminalRecord, state: MachineState): boolean {
  // This predicate runs while the sidecar checkpoint lock is held.  Keep the
  // entire witness chain closed here: a valid proof/terminal from another run
  // must not become a wake merely because its launch token happens to match a
  // current string.  Malformed receipt bytes are ordinary bounded attention,
  // not an exception that can escape the wake path.
  try {
    if (proof.phaseId !== state.phaseId || proof.attemptEpoch !== state.attemptEpoch) return false;
    if (launchInput.runId !== state.runId || launchInput.phaseId !== state.phaseId || launchInput.attemptEpoch !== state.attemptEpoch || launchInput.authorityEpoch !== state.authorityEpoch || launchInput.barrierEpoch !== state.barrierEpoch || launchInput.launchToken !== proof.launchToken || launchInput.commandDigest !== proof.commandDigest) return false;
    if (terminalInput.launchToken !== proof.launchToken || terminalInput.commandDigest !== proof.commandDigest || terminalInput.status !== 'PASS' || terminalInput.outcome !== 'normal-completion') return false;
    const command = Object.values(state.outbox).find((candidate) => candidate.launchToken === proof.launchToken && candidate.commandDigest === proof.commandDigest);
    if (!command || command.state !== 'ACKED' || command.receipt === undefined) return false;
    if (command.runId !== state.runId || command.phaseId !== state.phaseId || command.attemptEpoch !== state.attemptEpoch || command.authorityEpoch !== state.authorityEpoch || command.barrierEpoch !== state.barrierEpoch) return false;
    if (command.modeEpoch !== state.modeEpoch || state.steps[command.stepId]?.status !== 'ACTIVE') return false;
    if (command.stepId !== proof.stepId) return false;

    // ACKED is not by itself an effect witness.  Revalidate the canonical
    // outbox receipt envelope and its immutable launch record so the supplied
    // launch/terminal pair is the exact effect retained by the current run.
    const receipt = command.receipt;
    if (receipt.id !== `receipt:${proof.launchToken}` || receipt.scope !== 'outbox/receipt' || typeof receipt.bytes !== 'string' || receipt.digest !== digest(parseCanonical(receipt.bytes))) return false;
    const outer = parseCanonical<unknown>(receipt.bytes);
    const outerObject = exact(outer, ['commandDigest', 'launchToken', 'receipt'], 'outbox receipt');
    if (outerObject.launchToken !== proof.launchToken || outerObject.commandDigest !== proof.commandDigest) return false;
    const inner = outerObject.receipt;
    const innerObject = exact(inner, ['bytes', 'digest', 'id', 'scope'], 'launch receipt');
    if (innerObject.id !== `codex-launch:${proof.launchToken}` || innerObject.scope !== 'codex/effect/launch' || typeof innerObject.bytes !== 'string') return false;
    const launch = validateLaunchRecord(parseCanonical(innerObject.bytes));
    if (innerObject.digest !== digest(launch) || canonicalString(launch) !== canonicalString(launchInput)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Consume one explicit wake source. The checkpoint is published before the
 * existing lifecycle/pump is invoked, and the post-call observation is
 * published separately. No decision-inbox import or parent decision call is
 * present in this module by construction.
 */
export async function wakeContinuationSession(input: ContinuationWakeOptions & { session: ContinuationSession }): Promise<ContinuationWakeResult> {
  const session = input.session;
  const sourceValue = typeof input.source === 'string' ? input.source : '';
  let wakeSource: ContinuationWakeSource;
  try { wakeSource = source(input.source); } catch (error) {
    return attentionResult(session.record, error instanceof ContinuationError ? error.code : 'UNSUPPORTED_WAKE', sourceValue);
  }
  const proofValue = decodeWakeProof(input);
  if (proofValue.attention) return attentionResult(session.record, proofValue.attention, wakeSource);
  if (input.signal?.aborted) return attentionResult(session.record, 'CANCELLED', wakeSource);
  try {
    const suppliedPlan = canonicalizeDeclaration(input.plan);
    if (digest(suppliedPlan) !== session.record.planDigest) return attentionResult(session.record, 'BINDING_DRIFT', wakeSource);
    const suppliedPolicy = input.policy ?? session['options'].policy;
    if (suppliedPolicy !== undefined) {
      const checkedPolicy = validateCodexHostPolicy(suppliedPolicy);
      if (checkedPolicy.runRoot !== session.record.runRoot || checkedPolicy.runId !== session.record.runId || checkedPolicy.planDigest !== session.record.planDigest || session.record.policyDigest !== codexHostPolicyDigest(checkedPolicy)) return attentionResult(session.record, 'BINDING_DRIFT', wakeSource);
    } else if (session.record.policyDigest !== null) return attentionResult(session.record, 'BINDING_DRIFT', wakeSource);
  } catch { return attentionResult(session.record, 'BINDING_DRIFT', wakeSource); }
  const lock = join(dirname(session.sidecarPath), CONTINUATION_LOCK);
  let checkpoint: ContinuationRecord;
  try {
    checkpoint = await withSidecarLock(lock, session['options'].lockWaitMs ?? 1000, async () => {
      const loaded = await loadAndValidate(session['options'], true);
      const current = loaded.record;
      const now = parseNow(input.now);
      if (current.state === 'REVOKED') return current;
      if (current.state !== 'ACTIVE') return current;
      const stopAndPublish = async (code: ContinuationAttentionCode): Promise<ContinuationRecord> => {
        const next = parseRecord({ ...current, state: 'ATTENTION', attention: code, generation: current.generation + 1 });
        await publishSidecar(session.sidecarPath, next, session['options'].faultInjector);
        return next;
      };
      if (!current.wakeSources.includes(wakeSource)) return stopAndPublish('UNSUPPORTED_WAKE');
      if (wakeSource === 'proof' && (!proofValue.proof || !input.launch || !input.terminal || !proofCurrentBinding(proofValue.proof, validateLaunchRecord(input.launch), validateTerminalRecord(input.terminal), loaded.trusted.state))) return stopAndPublish('BINDING_DRIFT');
      if (now >= asDate(current.deadline)) return stopAndPublish('DEADLINE_EXPIRED');
      const liveness = ownerLiveness(current.ownerPid);
      if (liveness !== 'LIVE' || now >= asDate(current.leaseExpiresAt)) return stopAndPublish(now >= asDate(current.leaseExpiresAt) && liveness === 'DEAD' ? 'LEASE_EXPIRED' : 'STALE_LIVENESS');
      if (current.wakeCount >= current.maxWakes) return stopAndPublish('MAX_WAKES');
      if (current.wakeInFlight) return stopAndPublish('SIDECAR_CONFLICT');
      const next = parseRecord({ ...current, wakeCount: current.wakeCount + 1, wakeInFlight: true, generation: current.generation + 1, lastWakeSource: wakeSource, lastWakeAt: nowIso(input.now) });
      await publishSidecar(session.sidecarPath, next, session['options'].faultInjector);
      return next;
    });
  } catch (error) {
    const code = error instanceof ContinuationError ? error.code : 'SIDECAR_FAULT';
    return attentionResult(session.record, code, wakeSource);
  }
  session['recordValue'] = checkpoint;
  if (checkpoint.state !== 'ACTIVE') return attentionResult(checkpoint, checkpoint.attention ?? 'UNSUPPORTED_BOUNDARY', wakeSource);

  let lifecycle: LifecycleResult;
  try {
    const plan = canonicalizeDeclaration(input.plan);
    lifecycle = await resumeRun({
      command: 'resume', runDir: session['options'].runRoot, runId: session['options'].runId, plan,
      ...(input.driver === undefined ? {} : { driver: input.driver }),
      ...((input.policy ?? session['options'].policy) === undefined ? {} : { policy: input.policy ?? session['options'].policy }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.maxTransitions === undefined ? {} : { maxTransitions: input.maxTransitions }),
      ...(input.dispatcher === undefined ? {} : { dispatcher: input.dispatcher }),
    });
  } catch (error) {
    const code: ContinuationAttentionCode = input.signal?.aborted ? 'CANCELLED' : 'LIFECYCLE_ERROR';
    await finalizeWake(session, checkpoint, code).catch(() => undefined);
    return attentionResult(session.record, code, wakeSource);
  }
  const lifecycleCode = lifecycleAttention(lifecycle);
  if (lifecycleCode) {
    await finalizeWake(session, checkpoint, lifecycleCode).catch(() => undefined);
    return attentionResult(session.record, lifecycleCode, wakeSource);
  }
  const finishedAt = Date.now();
  if (finishedAt >= Date.parse(checkpoint.deadline)) {
    await finalizeWake(session, checkpoint, 'DEADLINE_EXPIRED').catch(() => undefined);
    return attentionResult(session.record, 'DEADLINE_EXPIRED', wakeSource);
  }
  if (finishedAt >= Date.parse(checkpoint.leaseExpiresAt)) {
    await finalizeWake(session, checkpoint, 'STALE_LIVENESS').catch(() => undefined);
    return attentionResult(session.record, 'STALE_LIVENESS', wakeSource);
  }
  try {
    const trusted = await trustedRun({ runRoot: session['options'].runRoot, runId: session['options'].runId, plan: input.plan, policy: input.policy ?? session['options'].policy });
    const lockRelease = await acquireLock(lock, session['options'].lockWaitMs ?? 1000);
    if (!lockRelease) return attentionResult(session.record, 'SIDECAR_CONFLICT', wakeSource);
    try {
      const latest = await readSidecar(session.sidecarPath);
      if (!latest || latest.ownerNonce !== checkpoint.ownerNonce || latest.leaseEpoch !== checkpoint.leaseEpoch || latest.revocationGeneration !== checkpoint.revocationGeneration || latest.generation !== checkpoint.generation || latest.state !== 'ACTIVE') {
        if (latest) session['recordValue'] = latest;
        return attentionResult(latest ?? session.record, latest?.attention ?? 'LEASE_LOST', wakeSource);
      }
      const next = parseRecord({ ...latest, wakeInFlight: false, generation: latest.generation + 1, currentGeneration: trusted.generation, currentRevision: trusted.state.revision, currentAuthorityEpoch: trusted.state.authorityEpoch, currentAttemptEpoch: trusted.state.attemptEpoch, currentBarrierEpoch: trusted.state.barrierEpoch });
      await publishSidecar(session.sidecarPath, next, session['options'].faultInjector);
      session['recordValue'] = next;
      return successResult(next, lifecycle, wakeSource);
    } finally { await lockRelease(); }
  } catch {
    return attentionResult(session.record, 'SIDECAR_FAULT', wakeSource);
  }
}

async function finalizeWake(session: ContinuationSession, checkpoint: ContinuationRecord, code: ContinuationAttentionCode): Promise<void> {
  const lock = join(dirname(session.sidecarPath), CONTINUATION_LOCK);
  const release = await acquireLock(lock, session['options'].lockWaitMs ?? 1000);
  if (!release) return;
  try {
    const latest = await readSidecar(session.sidecarPath);
    // Finalization is a compare-and-swap over the exact checkpoint fence.  A
    // revoke/renew or any other generation advance wins; never rewrite a
    // newer non-ACTIVE record back to ATTENTION after the lifecycle returns.
    if (!latest || latest.ownerNonce !== checkpoint.ownerNonce || latest.leaseEpoch !== checkpoint.leaseEpoch || latest.revocationGeneration !== checkpoint.revocationGeneration || latest.generation !== checkpoint.generation || latest.state !== 'ACTIVE') {
      if (latest) session['recordValue'] = latest;
      return;
    }
    const next = parseRecord({ ...latest, wakeInFlight: false, generation: latest.generation + 1, state: 'ATTENTION', attention: code });
    await publishSidecar(session.sidecarPath, next, session['options'].faultInjector);
    session['recordValue'] = next;
  } finally { await release(); }
}

/** Convenience restart-safe wake without exposing sidecar internals. */
export async function wakeContinuation(options: ContinuationLoadOptions & ContinuationWakeOptions): Promise<ContinuationWakeResult> {
  const sourceValue = typeof options.source === 'string' ? options.source : '';
  let session: ContinuationSession | undefined;
  try { session = await loadContinuationSession(options); }
  catch (error) {
    const code = error instanceof ContinuationError ? error.code : 'CURRENT_INVALID';
    return Object.freeze({ schema: CONTINUATION_SCHEMA, version: CONTINUATION_VERSION, status: 'attention' as const, source: sourceValue, wakeCount: 0, leaseEpoch: 0, generation: 0, attention: { code } });
  }
  if (!session) return Object.freeze({ schema: CONTINUATION_SCHEMA, version: CONTINUATION_VERSION, status: 'disabled' as const, source: sourceValue, wakeCount: 0, leaseEpoch: 0, generation: 0, attention: { code: 'DISABLED' as const } });
  return session.wake(options);
}

/** Explicit owner operations kept private to the continuation module. */
export async function revokeContinuationSession(session: ContinuationSession): Promise<ContinuationRecord> { return session.revoke(); }
export async function renewContinuationLease(session: ContinuationSession, input?: Readonly<{ leaseTtlMs?: number; now?: string | number | Date }>): Promise<ContinuationRecord> { return session.renew(input); }

/** Resolve the feature-owned sidecar path without creating any files. */
export function continuationSidecarPath(runRoot: string, sidecarPath?: string): string {
  return sidecarFor(canonicalRoot(runRoot, 'runRoot'), sidecarPath);
}

/** Validate an already-decoded sidecar without touching filesystem state. */
export function validateContinuationRecord(value: unknown): ContinuationRecord { return parseRecord(value); }
export function encodeContinuationRecord(value: ContinuationRecord): string { return recordBytes(value); }
export function decodeContinuationRecord(bytes: string | Uint8Array): ContinuationRecord {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  if (typeof bytes !== 'string' && !Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) fail('MALFORMED', 'continuation bytes are not UTF-8');
  if (Buffer.byteLength(text, 'utf8') > CONTINUATION_MAX_RECORD_BYTES) fail('MALFORMED', 'continuation record exceeds byte ceiling');
  return parseRecord(parseCanonical(text));
}
export function continuationDigest(value: ContinuationRecord): string { return digest(parseRecord(value)); }
