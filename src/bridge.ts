import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalString, digest, identityKey, parseCanonical } from './canonical.js';
import { acceptedStartPlanDigests, makeComposedKernelForBridge, makeRunKernelForBridge, type DispatcherOptions, type RunKernel } from './public.js';
import type { EffectDriver } from './driver.js';
import { FileArtifactStore, isFileArtifactStoreAbort, type StoreSnapshot } from './store.js';
import { assertStableIdentity, ensurePrivateDirectory, filesystemIdentity, inspectTrustedPath, sameFilesystemIdentity, trustedIdentity, type FilesystemIdentity } from './filesystem.js';
import { validatePlan } from './validator.js';
import { BEADS_BUILD, BEADS_COMMIT, BEADS_SCHEMA_VERSION, BEADS_SNAPSHOT_SCHEMA, BEADS_VERSION, BeadsPlanSource, BeadsUnavailable, validateBeadsAcknowledgement, beadsPlanDigest, beadsSnapshotDigest, type BeadsAcknowledgement, type BeadsCapture, type BeadsEvidenceCopyReceipt } from './beads.js';
import { isDispatchableStepStatus } from './dependency.js';
import type { AdvanceInput, Event, EventIdentity, MachineState, Plan, Yield } from './model.js';
import { assertReleaseAdmissionOpen } from './release-admission.js';

/**
 * Private host seam for the installed Lunacy skill.  This module is deliberately
 * not re-exported from the package root: the runtime still has one public
 * lifecycle (`RunKernel.advance`) and the bridge only adapts a parent-owned
 * declaration and projection files around that lifecycle.
 */

export const BRIDGE_SCHEMA = 1 as const;
export const BRIDGE_VERSION = '0.2.0' as const;
export const RUNTIME_VERSION = '0.3.0' as const;
export const BRIDGE_MANIFEST_NAME = 'BRIDGE.json' as const;
export const BRIDGE_TOMBSTONE_NAME = 'BRIDGE.DELETED' as const;
export const BRIDGE_MANIFEST_FILE = `.kernel/${BRIDGE_MANIFEST_NAME}` as const;
export const BRIDGE_TOMBSTONE_FILE = `.kernel/${BRIDGE_TOMBSTONE_NAME}` as const;
const BRIDGE_SOURCE_ID = 'lunacy-runtime-skill-bridge/v1';
const STATE_OPEN = '<!-- lunacy-runtime:state:start -->';
const STATE_CLOSE = '<!-- lunacy-runtime:state:end -->';
const STEPS_OPEN = '<!-- lunacy-runtime:steps:start -->';
const STEPS_CLOSE = '<!-- lunacy-runtime:steps:end -->';
const BRIDGE_LOCK_NAME = '.bridge.lock';
const BEADS_INPUT_NAME = 'BEADS.INPUT.json';
const BEADS_INPUT_PREFIX = 'BEADS.INPUT.';
const BEADS_REPLAY_PREFIX = 'BEADS.REPLAY.';

export type BridgeMode = 'markdown' | 'runtime';
export type BridgeStatus = 'enabled' | 'disabled';
export type BeadsBridgeMode = 'off' | 'shadow' | 'active';
export type BeadsBridgeOptions = {
  mode: BeadsBridgeMode;
  source: BeadsPlanSource;
  /** Parent acknowledgement of the exact captured snapshot and candidate. */
  acknowledgement?: BeadsAcknowledgement;
};

type BoundBeadsBridgeOptions = BeadsBridgeOptions & {
  /** Bound synchronously at transition entry; never looked up after an await. */
  capture: BeadsPlanSource['capture'];
};

export type BridgeManifest = {
  schema: typeof BRIDGE_SCHEMA;
  bridgeVersion: string;
  runtimeVersion: string;
  mode: 'runtime';
  status: BridgeStatus;
  runId: string;
  phaseId: string;
  rootPath: string;
  planDigest: string;
  sourceDigest: string;
};

type BridgeTombstone = Omit<BridgeManifest, 'status'> & { status: 'deleted' };

export type BridgeCounters = {
  declarationReads: number;
  declarationBytes: number;
  runtimeReads: number;
  runtimeBytes: number;
  projectionReads: number;
  projectionBytesRead: number;
  projectionWrites: number;
  projectionBytesWritten: number;
  routineWakeups: number;
  transitions: number;
  startedAtNs?: bigint;
};

export type BridgeTransition = {
  event: Event;
  eventId: string;
  phaseId?: string;
  stepId?: string;
  expectedRevision?: number;
  attemptEpoch?: number;
  authorityEpoch?: number;
  barrierEpoch?: number;
  launchToken?: string;
};

export type BridgeOptions = {
  runDir: string;
  runId: string;
  mode: BridgeMode;
  /** Parent-owned plan declaration. It is copied/canonicalized, never read
   * from arbitrary Markdown or treated as runtime authority. */
  plan?: unknown;
  statePath?: string;
  stepsPath?: string;
  runtimeVersion?: string;
  bridgeVersion?: string;
  counters?: BridgeCounters;
  /** Optional explicit Beads planning-memory boundary. It is never consulted
   * by RunKernel.advance; `shadow` returns before any runtime mutation. */
  beads?: BeadsBridgeOptions;
  /** Host-friendly aliases for structured callers and the private CLI. */
  beadsSource?: BeadsPlanSource;
  beadsMode?: BeadsBridgeMode;
  beadsAck?: BeadsAcknowledgement;
  /** Private drive composition.  The one-event bridge remains usable without
   * a driver and still truthfully returns HumanReceiptRequired. */
  driver?: EffectDriver;
  dispatcher?: DispatcherOptions;
};

/** Snapshot only supported own-enumerable dispatcher controls, once. */
function projectBridgeDispatcher(dispatcher: DispatcherOptions | undefined): DispatcherOptions {
  const projected = Object.create(null) as DispatcherOptions;
  if (dispatcher === undefined || dispatcher === null) return projected;
  const supported = new Set(['timeoutMs', 'signal', 'onYield']);
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

export type BridgeProjection = {
  statePath: string;
  stepsPath: string;
  digest: string;
  revision: number;
};

export type BridgeResult = {
  mode: BridgeMode;
  yield?: Yield;
  projected: boolean;
  projection?: BridgeProjection;
  counters: Readonly<BridgeCounters>;
  beads?: BridgeBeadsResult;
};

export type BridgeBeadsResult = {
  mode: BeadsBridgeMode;
  status: 'captured' | 'shadow-match' | 'shadow-mismatch' | 'drift' | 'unavailable';
  snapshotDigest?: string;
  targetPlanDigest?: string;
  nativePlanDigest?: string;
  reason?: string;
};

export type BridgeMutationResult = {
  manifest: BridgeManifest | BridgeTombstone;
  deleted?: boolean;
};

type BridgeErrorCode =
  | 'Unavailable'
  | 'InvalidDeclaration'
  | 'ManifestMismatch'
  | 'VersionMismatch'
  | 'PathMismatch'
  | 'ProjectionFailed'
  | 'ActiveWork'
  | 'ModeConflict'
  | 'Disabled';

export class BridgeError extends Error {
  constructor(public readonly code: BridgeErrorCode, message: string) {
    super(message);
    this.name = `Bridge${code}`;
  }
}

const MANIFEST_KEYS = ['bridgeVersion', 'mode', 'planDigest', 'rootPath', 'runId', 'phaseId', 'runtimeVersion', 'schema', 'sourceDigest', 'status'] as const;
const TOMBSTONE_KEYS = ['bridgeVersion', 'mode', 'planDigest', 'rootPath', 'runId', 'phaseId', 'runtimeVersion', 'schema', 'sourceDigest', 'status'] as const;

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('InvalidDeclaration', `${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new BridgeError('InvalidDeclaration', `${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) throw new BridgeError('ManifestMismatch', `${label} fields are invalid`);
}

function safeId(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) throw new BridgeError('PathMismatch', `${label} is not a safe path identifier`);
  return value;
}

function resolvedRoot(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.length === 0 || !isAbsolute(rootDir)) throw new BridgeError('PathMismatch', 'runDir must be an absolute path');
  return resolve(rootDir);
}

function stableCompare(a: string, b: string): number { return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }

function pathWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

async function nearestPhysicalPath(path: string): Promise<string> {
  const missing: string[] = [];
  let probe = path;
  while (true) {
    try {
      const physical = await fs.realpath(probe);
      return missing.reverse().reduce((current, segment) => join(current, segment), physical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(probe);
      if (parent === probe) return path;
      missing.push(basename(probe)); probe = parent;
    }
  }
}

/** Resolve a bridge I/O pathname to the physical existing ancestor before
 * opening or staging it.  Keeping the physical spelling for the remainder of
 * the operation closes the rename-to-symlink window between a lexical path
 * check and the subsequent write/read.  The only accepted alias is the host
 * temporary-directory spelling (`/tmp` -> `/private/tmp` on macOS). */
async function physicalIoPath(path: string, label: string): Promise<string> {
  const physical = await nearestPhysicalPath(path);
  if (physical !== path && !(await allowedSystemAlias(path, physical))) throw new BridgeError('PathMismatch', `${label} contains a symlinked ancestor`);
  return physical;
}

async function allowedSystemAlias(path: string, physical: string): Promise<boolean> {
  const lexicalRoots = [...new Set([resolve(tmpdir()), '/tmp'])];
  for (const lexicalTmp of lexicalRoots) {
    let physicalTmp: string;
    try { physicalTmp = await fs.realpath(lexicalTmp); } catch { continue; }
    if (!pathWithin(lexicalTmp, path)) continue;
    const expected = join(physicalTmp, relative(lexicalTmp, path));
    if (expected === physical) return true;
  }
  return false;
}

/** Check path components owned by the run root without following a
 * user-controlled symlink into another tree. */
async function assertNoSymlinkSegments(rootDir: string, candidate: string, label: string): Promise<void> {
  const root = resolvedRoot(rootDir);
  const target = resolve(candidate);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new BridgeError('PathMismatch', `${label} escapes runDir`);
  try { await inspectTrustedPath(target, label, { allowMissing: true, surface: true }); }
  catch (error) { throw new BridgeError('PathMismatch', (error as Error).message.replace(/^FilesystemTrust:\s*/, '')); }
}

function pathInside(rootDir: string, candidate: string, label: string, expectedPhase?: string): string {
  const root = resolvedRoot(rootDir);
  if (typeof candidate !== 'string' || candidate.length === 0) throw new BridgeError('PathMismatch', `${label} path is invalid`);
  const result = resolve(candidate);
  const rel = relative(root, result);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new BridgeError('PathMismatch', `${label} escapes runDir`);
  const expected = label === 'STATE.md' ? 'STATE.md' : label === 'STEPS.md' ? 'STEPS.md' : undefined;
  if (expected && basename(result) !== expected) throw new BridgeError('PathMismatch', `${label} must target ${expected}`);
  const segments = rel.split(sep);
  if (label === 'STATE.md' && rel !== 'STATE.md') throw new BridgeError('PathMismatch', 'STATE.md must be the run-root control file');
  if (label === 'STEPS.md' && (segments.length !== 3 || segments[0] !== 'phases' || segments[2] !== 'STEPS.md')) throw new BridgeError('PathMismatch', 'STEPS.md must be a phase control file');
  if (label === 'STEPS.md' && expectedPhase !== undefined && segments[1] !== safeId(expectedPhase, 'phaseId')) throw new BridgeError('PathMismatch', 'STEPS.md phase differs from the committed runtime phase');
  return result;
}

async function lstatNoFollow(path: string, label: string): Promise<import('node:fs').Stats | undefined> {
  try { return (await inspectTrustedPath(path, label, { allowMissing: true, surface: true }))?.stat; }
  catch (error) { throw new BridgeError('PathMismatch', (error as Error).message.replace(/^FilesystemTrust:\s*/, '')); }
}

async function assertTrustedPathSegments(rootDir: string, candidate: string, label: string): Promise<void> {
  const root = resolvedRoot(rootDir);
  const target = resolve(candidate);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new BridgeError('PathMismatch', `${label} escapes runDir`);
  try { await inspectTrustedPath(target, label, { allowMissing: true, surface: true }); }
  catch (error) { throw new BridgeError('PathMismatch', (error as Error).message.replace(/^FilesystemTrust:\s*/, '')); }
}

async function ensureDirectory(path: string, label: string, trustedRoot?: string): Promise<void> {
  const target = resolve(path);
  if (trustedRoot !== undefined && !pathWithin(resolvedRoot(trustedRoot), target)) throw new BridgeError('PathMismatch', `${label} escapes runDir`);
  try {
    const created = await ensurePrivateDirectory(target, label);
    await syncDirectory(created.path, label);
  } catch (error) { throw new BridgeError('PathMismatch', (error as Error).message.replace(/^FilesystemTrust:\s*/, '')); }
}

async function assertDirectoryOrMissing(path: string, label: string): Promise<void> {
  const stat = await lstatNoFollow(path, label);
  if (stat && !stat.isDirectory()) throw new BridgeError('PathMismatch', `${label} is not a directory`);
}

async function assertRegularOrMissing(path: string, label: string): Promise<void> {
  const stat = await lstatNoFollow(path, label);
  if (stat && !stat.isFile()) throw new BridgeError('PathMismatch', `${label} is not a regular file`);
}

type TrustedRegularRead = Readonly<{
  text: string;
  bytes: Buffer;
  identity: FilesystemIdentity;
}>;

/** Read a regular file through the same descriptor-bound trust model as
 * readRegular, retaining the raw bytes and bound identity for projection
 * equality proofs.  This result is private to the projection publisher; all
 * other callers continue to receive the decoded text-only read. */
async function readTrustedRegular(path: string, label: string, counters?: BridgeCounters): Promise<TrustedRegularRead | undefined> {
  const stat = await lstatNoFollow(path, label);
  if (!stat) return undefined;
  if (!stat.isFile()) throw new BridgeError('PathMismatch', `${label} is not a regular file`);
  const ioPath = await physicalIoPath(path, label);
  let handle;
  try { handle = await fs.open(ioPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new BridgeError('PathMismatch', `${label} is a symlink`); throw error; }
  let bytes: Buffer;
  let identity: FilesystemIdentity;
  try {
    const bound = await handle.stat();
    if (!sameFilesystemIdentity(filesystemIdentity(bound), filesystemIdentity(stat))) throw new BridgeError('PathMismatch', `${label} changed before descriptor binding`);
    identity = filesystemIdentity(bound);
    bytes = await handle.readFile();
    const after = await lstatNoFollow(path, label);
    if (!after || !sameFilesystemIdentity(identity, filesystemIdentity(after))) throw new BridgeError('PathMismatch', `${label} changed during descriptor read`);
  }
  finally { await handle.close(); }
  const text = bytes.toString('utf8');
  if (counters) { counters.projectionReads += 1; counters.projectionBytesRead += Buffer.byteLength(text); }
  return { text, bytes, identity };
}

async function readRegular(path: string, label: string, counters?: BridgeCounters): Promise<string | undefined> {
  return (await readTrustedRegular(path, label, counters))?.text;
}

async function writeRegular(path: string, bytes: string, label: string, counters?: BridgeCounters, trustedRoot?: string): Promise<void> {
  await ensureDirectory(dirname(path), `${label} parent`, trustedRoot);
  const existing = await lstatNoFollow(path, label);
  if (existing && !existing.isFile()) throw new BridgeError('PathMismatch', `${label} is not a regular file`);
  const ioPath = await physicalIoPath(path, label);
  const ioParent = dirname(ioPath);
  const temp = `${ioPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(temp, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const tempStat = await lstatNoFollow(temp, `${label} temporary`);
    if (!tempStat?.isFile()) throw new BridgeError('PathMismatch', `${label} temporary is not a regular file`);
    const current = await lstatNoFollow(path, label);
    if (existing ? (!current || !sameFilesystemIdentity(filesystemIdentity(existing), filesystemIdentity(current))) : current) throw new BridgeError('PathMismatch', `${label} changed before commit`);
    await syncFile(temp, label);
    await fs.rename(temp, ioPath);
    await syncDirectory(ioParent, `${label} parent`);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
  if (counters) { counters.projectionWrites += 1; counters.projectionBytesWritten += Buffer.byteLength(bytes); }
}

/** Publish a manifest only if no competing initializer has won the root. A
 * rename-based overwrite here would let two concurrent START calls leave the
 * plan digest from the loser beside the CURRENT state from the winner. */
async function writeNewRegular(path: string, bytes: string, label: string, trustedRoot?: string): Promise<void> {
  await ensureDirectory(dirname(path), `${label} parent`, trustedRoot);
  const ioPath = await physicalIoPath(path, label);
  const ioParent = dirname(ioPath);
  const temp = `${ioPath}.new-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(temp, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await syncFile(temp, label);
    await fs.link(temp, ioPath);
    await syncDirectory(ioParent, `${label} parent`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BridgeError('ManifestMismatch', `${label} was initialized concurrently`);
    throw error;
  } finally { await fs.unlink(temp).catch(() => undefined); await syncDirectory(ioParent, `${label} parent`); }
}

async function syncFile(path: string, label: string): Promise<void> {
  let handle;
  try { handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new BridgeError('PathMismatch', `${label} is a symlink`); throw error; }
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function syncDirectory(path: string, label: string): Promise<void> {
  let handle;
  try { handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new BridgeError('PathMismatch', `${label} is a symlink`); throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new BridgeError('PathMismatch', `${label} is not a directory`);
    await handle.sync();
  } finally { await handle.close(); }
}

const bridgeProcessLocks = new Map<string, Promise<void>>();

async function assertBridgeIdentity(path: string, expected: FilesystemIdentity, label: string): Promise<void> {
  try { await assertStableIdentity(path, expected, label, { surface: true, kind: 'directory' }); }
  catch (error) { throw new BridgeError('PathMismatch', (error as Error).message.replace(/^FilesystemTrust:\s*/, '')); }
}

async function createExclusiveLock(lockPath: string, owner: string, directory: string): Promise<boolean> {
  const temporary = `${lockPath}.new-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(owner, 'utf8'); await handle.sync();
    await handle.close(); handle = undefined;
    try { await fs.link(temporary, lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    await syncDirectory(directory, '.kernel');
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

/** Serialize stale-owner reclamation itself.  A contender that loses this
 * marker never unlinks a lock acquired by the winner; malformed/partial locks
 * are only possible from the old create-then-write protocol and are handled by
 * the same exclusive marker. */
async function reclaimBridgeLock(lockPath: string, directory: string): Promise<boolean> {
  const marker = `${lockPath}.reclaim`;
  try { await fs.mkdir(marker, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  try {
    let lockStat: import('node:fs').Stats;
    try { lockStat = await fs.lstat(lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
    if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new BridgeError('ManifestMismatch', 'bridge operation lock is not a regular file');
    let stale = true;
    let lockText: string | undefined;
    try { lockText = await readRegular(lockPath, 'bridge lock'); }
    catch (error) {
      // Only an ordinary disappearance is recoverable.  Path/ownership/mode
      // failures are authoritative-boundary violations and must not be
      // swallowed into permission to unlink the lock.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (lockText !== undefined) {
      try {
        const record = JSON.parse(lockText) as { pid?: number };
        if (typeof record.pid === 'number' && record.pid !== process.pid) {
          try { process.kill(record.pid, 0); stale = false; }
          catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') stale = false; }
        } else if (record.pid === process.pid) stale = false;
      } catch { /* incomplete stale owner from a crashed pre-link writer */ }
    }
    if (!stale) return false;
    await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await syncDirectory(directory, '.kernel');
    return true;
  } finally {
    await fs.rmdir(marker).catch(() => undefined);
    await syncDirectory(directory, '.kernel').catch(() => undefined);
  }
}

async function withBridgeOperationLock<T>(rootPath: string, fn: (rootIdentity: FilesystemIdentity) => Promise<T>): Promise<T> {
  const key = rootPath;
  const previous = bridgeProcessLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const queued = previous.then(() => current);
  bridgeProcessLocks.set(key, queued);
  await previous;
  try {
    await assertReleaseAdmissionOpen(rootPath);
    await assertNoSymlinkSegments(rootPath, rootPath, 'runDir');
    await ensureDirectory(rootPath, 'runDir', rootPath);
    const rootIdentity = await trustedIdentity(rootPath, 'runDir', { surface: true, kind: 'directory' });
    if (!rootIdentity) throw new BridgeError('PathMismatch', 'runDir identity is unavailable');
    const kernel = join(rootPath, '.kernel');
    await ensureDirectory(kernel, '.kernel', rootPath);
    const kernelIdentity = await trustedIdentity(kernel, '.kernel', { surface: true, kind: 'directory' });
    if (!kernelIdentity) throw new BridgeError('PathMismatch', '.kernel identity is unavailable');
    const lockPath = join(kernel, BRIDGE_LOCK_NAME);
    const owner = canonicalString({ pid: process.pid, started: Date.now(), nonce: Math.random().toString(16).slice(2) });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        if (await createExclusiveLock(lockPath, owner, kernel)) {
        try {
          await assertReleaseAdmissionOpen(rootPath);
          await assertBridgeIdentity(rootPath, rootIdentity, 'runDir');
          await assertBridgeIdentity(kernel, kernelIdentity, '.kernel');
          return await fn(rootIdentity);
        }
        finally {
          // Do not unlink a pathname that no longer names the locked inode.
          // A trusted non-sticky ancestor cannot be replaced by another UID,
          // but the identity fence also closes ordinary rename races.
          await assertBridgeIdentity(rootPath, rootIdentity, 'runDir');
          await assertBridgeIdentity(kernel, kernelIdentity, '.kernel');
          let actual: string | undefined;
          try { actual = await readRegular(lockPath, 'bridge lock'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (actual !== undefined && actual !== owner) throw new BridgeError('ManifestMismatch', 'bridge operation lock ownership changed');
          await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
          await syncDirectory(kernel, '.kernel');
        }
        }
        if (await reclaimBridgeLock(lockPath, kernel)) continue;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      } catch (error) {
        throw error;
      }
    }
    throw new BridgeError('Unavailable', 'bridge operation lock timed out');
  } finally {
    release(); if (bridgeProcessLocks.get(key) === queued) bridgeProcessLocks.delete(key);
  }
}

function newCounters(counters?: BridgeCounters): BridgeCounters {
  const defaults = { declarationReads: 0, declarationBytes: 0, runtimeReads: 0, runtimeBytes: 0, projectionReads: 0, projectionBytesRead: 0, projectionWrites: 0, projectionBytesWritten: 0, routineWakeups: 0, transitions: 0 };
  if (counters === undefined) return defaults;
  if (!counters || typeof counters !== 'object' || Object.getPrototypeOf(counters) !== Object.prototype) throw new BridgeError('Unavailable', 'bridge counters are invalid');
  const keys = Object.keys(counters).filter((key) => key !== 'startedAtNs').sort();
  const expected = Object.keys(defaults).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new BridgeError('Unavailable', 'bridge counters contain unsupported fields');
  const result = { ...defaults };
  for (const key of expected) {
    const value = counters[key as keyof typeof defaults];
    if (!Number.isSafeInteger(value) || value < 0) throw new BridgeError('Unavailable', `bridge counter ${key} is invalid`);
    result[key as keyof typeof defaults] = value;
  }
  if (counters.startedAtNs !== undefined && typeof counters.startedAtNs !== 'bigint') throw new BridgeError('Unavailable', 'bridge counter startedAtNs is invalid');
  return result;
}

/** Strict declaration boundary. Markdown text is intentionally not parsed: a
 * host must supply a structured parent-owned declaration, preventing prompt
 * prose, headings, or path names from silently becoming executable steps. */
export function canonicalizeDeclaration(input: unknown): Plan {
  let normalizedInput: Plan;
  try {
    // Snapshot arbitrary host objects exactly once at the declaration
    // boundary.  Re-reading a mutable object (or accessor-backed proxy) for
    // the kernel after digesting it would create two authorities for one
    // transition; canonical JSON is the immutable hand-off instead.
    const canonicalInput = parseCanonical<unknown>(canonicalString(input));
    const object = plainObject(canonicalInput, 'plan declaration');
    const allowed = ['authorityDigest', 'gateRequired', 'phaseId', 'schema', 'steps'];
    if (Object.keys(object).some((key) => !allowed.includes(key))) throw new BridgeError('InvalidDeclaration', 'plan declaration contains unsupported fields');
    normalizedInput = object as Plan;
    const result = validatePlan(normalizedInput);
    const plan = result.plan;
    safeId(plan.phaseId, 'phaseId');
    if (plan.authorityDigest !== undefined && (typeof plan.authorityDigest !== 'string' || !/^[0-9a-f]{64}$/.test(plan.authorityDigest))) throw new Error('authorityDigest is invalid');
    return clone(plan);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('InvalidDeclaration', (error as Error).message);
  }
}

/** Validate the one event shape that can create bridge metadata.  The kernel
 * remains the authoritative event validator, but START must pass this small
 * boundary check before its create-only manifest is published; otherwise an
 * invalid identity/ref could leave a half-initialized root behind. */
function validateStartBoundary(event: Event, acceptedDigests: readonly string[]): void {
  if (!event || typeof event !== 'object' || Array.isArray(event) || event.kind !== 'START') return;
  if (Object.keys(event as object).sort().join(',') !== 'intentRef,kind') throw new BridgeError('InvalidDeclaration', 'START event fields are invalid');
  const intent = (event as Extract<Event, { kind: 'START' }>).intentRef;
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw new BridgeError('InvalidDeclaration', 'START intentRef is invalid');
  if (Object.keys(intent).some((key) => !['id', 'digest', 'scope', 'bytes'].includes(key)) || typeof intent.id !== 'string' || intent.id.length === 0 || typeof intent.digest !== 'string' || !/^[0-9a-f]{64}$/.test(intent.digest) || (intent.scope !== undefined && (typeof intent.scope !== 'string' || intent.scope.length === 0)) || (intent.bytes !== undefined && typeof intent.bytes !== 'string')) throw new BridgeError('InvalidDeclaration', 'START intentRef is invalid');
  if (intent.bytes !== undefined) {
    try { const value = parseCanonical(intent.bytes); if (digest(value) !== intent.digest) throw new Error('digest does not match bytes'); }
    catch (error) { throw new BridgeError('InvalidDeclaration', `START intentRef bytes are invalid: ${(error as Error).message}`); }
  }
  if (!acceptedDigests.includes(intent.digest)) throw new BridgeError('InvalidDeclaration', 'START intentRef does not name the supplied plan');
}

function manifestPath(rootDir: string): string { return join(resolvedRoot(rootDir), BRIDGE_MANIFEST_FILE); }
function tombstonePath(rootDir: string): string { return join(resolvedRoot(rootDir), BRIDGE_TOMBSTONE_FILE); }
function beadsInputPath(rootDir: string, planDigest?: string): string {
  if (planDigest !== undefined && !/^[0-9a-f]{64}$/.test(planDigest)) throw new BridgeError('ManifestMismatch', 'Beads input plan digest is invalid');
  return join(resolvedRoot(rootDir), '.kernel', planDigest === undefined ? BEADS_INPUT_NAME : `${BEADS_INPUT_PREFIX}${planDigest}.json`);
}

function beadsReplayBindingPath(rootDir: string, identity: EventIdentity): string {
  return join(resolvedRoot(rootDir), '.kernel', `${BEADS_REPLAY_PREFIX}${digest(identity)}.json`);
}

function checkManifest(value: unknown): BridgeManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new BridgeError('ManifestMismatch', 'bridge manifest must be a plain object');
  const object = value as Record<string, unknown>;
  try {
    exactKeys(object, MANIFEST_KEYS, 'bridge manifest');
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('ManifestMismatch', (error as Error).message);
  }
  if (object.schema !== BRIDGE_SCHEMA || object.mode !== 'runtime' || !['enabled', 'disabled'].includes(String(object.status))) throw new BridgeError('ManifestMismatch', 'bridge manifest schema/mode/status is invalid');
  for (const field of ['bridgeVersion', 'runtimeVersion', 'runId', 'phaseId', 'rootPath', 'planDigest', 'sourceDigest']) if (typeof object[field] !== 'string' || String(object[field]).length === 0) throw new BridgeError('ManifestMismatch', `bridge manifest ${field} is invalid`);
  if (!/^[0-9a-f]{64}$/.test(String(object.planDigest)) || !/^[0-9a-f]{64}$/.test(String(object.sourceDigest))) throw new BridgeError('ManifestMismatch', 'bridge manifest digest is invalid');
  if (!isAbsolute(String(object.rootPath)) || resolve(String(object.rootPath)) !== String(object.rootPath)) throw new BridgeError('ManifestMismatch', 'bridge manifest rootPath is not canonical');
  safeId(String(object.phaseId), 'phaseId');
  if (String(object.sourceDigest) !== digest(BRIDGE_SOURCE_ID)) throw new BridgeError('ManifestMismatch', 'bridge manifest source digest is not this bridge');
  return object as BridgeManifest;
}

async function loadManifest(rootDir: string): Promise<BridgeManifest | undefined> {
  const path = manifestPath(rootDir);
  const bytes = await readRegular(path, 'bridge manifest');
  if (bytes === undefined) return undefined;
  try { return checkManifest(parseCanonical(bytes)); }
  catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('ManifestMismatch', `bridge manifest is not canonical: ${(error as Error).message}`); }
}

async function loadTombstone(rootDir: string): Promise<BridgeTombstone | undefined> {
  const path = tombstonePath(rootDir);
  const bytes = await readRegular(path, 'bridge tombstone');
  if (bytes === undefined) return undefined;
  try {
    const value = parseCanonical<Record<string, unknown>>(bytes);
    exactKeys(value, TOMBSTONE_KEYS, 'bridge tombstone');
    if (value.schema !== BRIDGE_SCHEMA || value.mode !== 'runtime' || value.status !== 'deleted') throw new Error('bridge tombstone fields are invalid');
    for (const field of ['bridgeVersion', 'runtimeVersion', 'runId', 'phaseId', 'rootPath', 'planDigest', 'sourceDigest']) if (typeof value[field] !== 'string' || String(value[field]).length === 0) throw new Error(`bridge tombstone ${field} is invalid`);
    if (!/^[0-9a-f]{64}$/.test(String(value.planDigest)) || String(value.sourceDigest) !== digest(BRIDGE_SOURCE_ID)) throw new Error('bridge tombstone digest is invalid');
    if (!isAbsolute(String(value.rootPath)) || resolve(String(value.rootPath)) !== String(value.rootPath)) throw new Error('bridge tombstone rootPath is not canonical');
    safeId(String(value.phaseId), 'phaseId');
    return value as BridgeTombstone;
  } catch (error) {
    throw new BridgeError('ManifestMismatch', `bridge tombstone is invalid: ${(error as Error).message}`);
  }
}

async function hasTombstone(rootDir: string): Promise<boolean> { return (await loadTombstone(rootDir)) !== undefined; }

function makeManifest(options: BridgeOptions, plan: Plan, rootPath: string, status: BridgeStatus = 'enabled'): BridgeManifest {
  return {
    schema: BRIDGE_SCHEMA, bridgeVersion: options.bridgeVersion ?? BRIDGE_VERSION, runtimeVersion: options.runtimeVersion ?? RUNTIME_VERSION,
    mode: 'runtime', status, runId: options.runId, phaseId: plan.phaseId, rootPath, planDigest: digest(plan), sourceDigest: digest(BRIDGE_SOURCE_ID),
  };
}

async function saveManifest(rootDir: string, manifest: BridgeManifest, createOnly = false): Promise<void> {
  const kernel = join(resolvedRoot(rootDir), '.kernel');
  await ensureDirectory(kernel, '.kernel', rootDir);
  const path = manifestPath(rootDir);
  if (createOnly) await writeNewRegular(path, canonicalString(manifest), 'bridge manifest', rootDir);
  else await writeRegular(path, canonicalString(manifest), 'bridge manifest', undefined, rootDir);
}

type PersistedBeadsInput = {
  schema: 'lunacy-beads-input-v1';
  snapshot: BeadsCapture['snapshot'];
  plan: BeadsCapture['plan'];
  sourceIds: BeadsCapture['sourceIds'];
  evidenceCopy?: BeadsEvidenceCopyReceipt;
  /** Legacy single binding retained for reading pre-S15 candidates only. */
  replayIdentity?: EventIdentity;
};

type PersistedBeadsReplayBinding = {
  schema: 'lunacy-beads-replay-v1';
  candidateDigest: string;
  identity: EventIdentity;
};

const BEADS_SNAPSHOT_KEYS = ['bdBuild', 'bdCommit', 'bdSchemaVersion', 'bdVersion', 'binaryDigest', 'capturedAt', 'contentDigest', 'edges', 'issues', 'schema', 'source', 'workspaceIdentity'] as const;
const BEADS_ISSUE_KEYS = ['description', 'issueType', 'priority', 'sourceId', 'status', 'title'] as const;
const BEADS_EDGE_KEYS = ['from', 'to', 'type'] as const;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const EVIDENCE_COPY_REASONS = new Set(['unsupported-platform', 'unsupported-filesystem', 'cross-volume', 'clone-unavailable', 'clone-failed', 'clone-verification-failed']);

function validateEvidenceCopyReceipt(value: unknown): Readonly<BeadsEvidenceCopyReceipt> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Beads evidence copy receipt must be a plain object');
  const receipt = value as Record<string, unknown>;
  exactKeys(receipt, ['schema', 'policy', 'eligibleFiles', 'clonedFiles', 'ineligibleFiles', 'fallbackFullCopyFiles', 'fallbackReasons'], 'Beads evidence copy receipt');
  if (receipt.schema !== 'lunacy-evidence-copy-v1' || (receipt.policy !== 'prefer' && receipt.policy !== 'require')) throw new Error('Beads evidence copy receipt policy is invalid');
  for (const field of ['eligibleFiles', 'clonedFiles', 'ineligibleFiles', 'fallbackFullCopyFiles']) if (!Number.isSafeInteger(receipt[field]) || (receipt[field] as number) < 0) throw new Error(`Beads evidence copy receipt ${field} is invalid`);
  if ((receipt.eligibleFiles as number) !== (receipt.clonedFiles as number) + (receipt.fallbackFullCopyFiles as number)) throw new Error('Beads evidence copy receipt eligible count is inconsistent');
  if (receipt.policy === 'require' && receipt.fallbackFullCopyFiles !== 0) throw new Error('required Beads evidence copy receipt contains a fallback');
  if (!Array.isArray(receipt.fallbackReasons)) throw new Error('Beads evidence copy receipt fallback reasons are invalid');
  const seen = new Set<string>(); let fallbackCount = 0; let prior = '';
  const reasons = receipt.fallbackReasons.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Beads evidence copy fallback reason is invalid');
    const row = value as Record<string, unknown>;
    exactKeys(row, ['reason', 'count'], 'Beads evidence copy fallback reason');
    if (typeof row.reason !== 'string' || !EVIDENCE_COPY_REASONS.has(row.reason) || seen.has(row.reason) || (prior && stableCompare(prior, row.reason) >= 0) || !Number.isSafeInteger(row.count) || (row.count as number) <= 0) throw new Error('Beads evidence copy fallback reason is invalid');
    seen.add(row.reason); prior = row.reason; fallbackCount += row.count as number;
    return Object.freeze({ reason: row.reason, count: row.count as number });
  });
  if (fallbackCount !== receipt.fallbackFullCopyFiles) throw new Error('Beads evidence copy fallback reason count is inconsistent');
  return Object.freeze({
    schema: 'lunacy-evidence-copy-v1', policy: receipt.policy,
    eligibleFiles: receipt.eligibleFiles as number, clonedFiles: receipt.clonedFiles as number,
    ineligibleFiles: receipt.ineligibleFiles as number, fallbackFullCopyFiles: receipt.fallbackFullCopyFiles as number,
    fallbackReasons: Object.freeze(reasons),
  }) as Readonly<BeadsEvidenceCopyReceipt>;
}

function validateCapturedSnapshot(value: unknown): BeadsCapture['snapshot'] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Beads snapshot must be a plain object');
  const snapshot = value as Record<string, unknown>;
  const keys = Object.keys(snapshot).sort(); const expected = [...BEADS_SNAPSHOT_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error('Beads snapshot fields are invalid');
  if (snapshot.schema !== BEADS_SNAPSHOT_SCHEMA || snapshot.source !== 'beads' || snapshot.bdVersion !== BEADS_VERSION || snapshot.bdBuild !== BEADS_BUILD || snapshot.bdCommit !== BEADS_COMMIT || snapshot.bdSchemaVersion !== BEADS_SCHEMA_VERSION) throw new Error('Beads snapshot pinned metadata is invalid');
  for (const field of ['workspaceIdentity', 'binaryDigest', 'contentDigest']) if (typeof snapshot[field] !== 'string' || !SHA256_HEX.test(snapshot[field] as string)) throw new Error(`Beads snapshot ${field} is invalid`);
  if (typeof snapshot.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(snapshot.capturedAt) || !Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error('Beads snapshot capturedAt is invalid');
  if (!Array.isArray(snapshot.issues) || !Array.isArray(snapshot.edges)) throw new Error('Beads snapshot collections are invalid');
  const ids = new Set<string>();
  for (const issue of snapshot.issues) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new Error('Beads snapshot issue is invalid');
    const item = issue as Record<string, unknown>; const issueKeys = Object.keys(item).sort(); const expectedIssue = [...BEADS_ISSUE_KEYS].sort();
    if (issueKeys.length !== expectedIssue.length || issueKeys.some((key, index) => key !== expectedIssue[index]) || typeof item.sourceId !== 'string' || item.sourceId.length === 0 || item.sourceId.includes('\0') || ids.has(item.sourceId) || typeof item.title !== 'string' || typeof item.description !== 'string' || (item.status !== 'open' && item.status !== 'closed') || !Number.isSafeInteger(item.priority) || (item.priority as number) < 0 || (item.priority as number) > 4 || !['task', 'bug', 'feature', 'chore', 'spike', 'story'].includes(String(item.issueType))) throw new Error('Beads snapshot issue is invalid');
    ids.add(item.sourceId);
  }
  const edges = new Set<string>();
  for (const edge of snapshot.edges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw new Error('Beads snapshot edge is invalid');
    const item = edge as Record<string, unknown>; const edgeKeys = Object.keys(item).sort(); const expectedEdge = [...BEADS_EDGE_KEYS].sort();
    if (edgeKeys.length !== expectedEdge.length || edgeKeys.some((key, index) => key !== expectedEdge[index]) || typeof item.from !== 'string' || typeof item.to !== 'string' || item.from === item.to || !ids.has(item.from) || !ids.has(item.to) || item.type !== 'blocks') throw new Error('Beads snapshot edge is invalid');
    const key = `${item.from}\0${item.to}\0${item.type}`; if (edges.has(key)) throw new Error('Beads snapshot contains duplicate edges'); edges.add(key);
  }
  const { contentDigest, capturedAt: _capturedAt, ...content } = snapshot;
  if (digest(content) !== contentDigest) throw new Error('Beads snapshot digest mismatch');
  return snapshot as BeadsCapture['snapshot'];
}

async function saveBeadsReplayBinding(rootDir: string, candidateDigest: string, identity: EventIdentity): Promise<void> {
  validateReplayIdentity(identity);
  if (!SHA256_HEX.test(candidateDigest)) throw new BridgeError('ManifestMismatch', 'Beads replay candidate digest is invalid');
  const path = beadsReplayBindingPath(rootDir, identity);
  const existing = await readRegular(path, 'Beads replay binding');
  if (existing !== undefined) {
    try {
      const parsed = parseCanonical<PersistedBeadsReplayBinding>(existing);
      if (parsed.schema !== 'lunacy-beads-replay-v1' || parsed.candidateDigest !== candidateDigest) throw new Error('Beads replay binding candidate differs');
      validateReplayIdentity(parsed.identity);
      if (identityKey(parsed.identity) !== identityKey(identity)) throw new Error('Beads replay binding identity differs');
      return;
    } catch (error) {
      throw new BridgeError('ManifestMismatch', `Beads replay binding is invalid: ${(error as Error).message}`);
    }
  }
  const value: PersistedBeadsReplayBinding = { schema: 'lunacy-beads-replay-v1', candidateDigest, identity: clone(identity) };
  try { await writeNewRegular(path, canonicalString(value), 'Beads replay binding', rootDir); }
  catch (error) {
    // A cooperating concurrent bridge may have published this exact binding
    // after the preflight read. Re-validate rather than overwrite it.
    if (error instanceof BridgeError && error.code === 'ManifestMismatch') return saveBeadsReplayBinding(rootDir, candidateDigest, identity);
    throw error;
  }
}

async function saveBeadsInput(rootDir: string, capture: BeadsCapture, replayIdentity?: EventIdentity): Promise<string> {
  const planDigest = digest(capture.plan);
  const candidatePath = beadsInputPath(rootDir, planDigest);
  // A digest-addressed candidate is immutable. Replay identities live in
  // separate append-only files so a precommit crash cannot monopolize the
  // candidate's only binding.
  if (await readRegular(candidatePath, 'Beads candidate input') !== undefined) {
    await loadBeadsInput(rootDir, planDigest);
    if (replayIdentity !== undefined) await saveBeadsReplayBinding(rootDir, planDigest, replayIdentity);
    return planDigest;
  }
  const value: PersistedBeadsInput = {
    schema: 'lunacy-beads-input-v1', snapshot: capture.snapshot, plan: capture.plan, sourceIds: capture.sourceIds,
    ...(capture.evidenceCopy === undefined ? {} : { evidenceCopy: capture.evidenceCopy }),
  };
  // Candidate captures are immutable and digest-addressed.  They never
  // replace the artifact selected by CURRENT while an adoption is pending.
  await writeRegular(candidatePath, canonicalString(value), 'Beads candidate input', undefined, rootDir);
  if (replayIdentity !== undefined) await saveBeadsReplayBinding(rootDir, planDigest, replayIdentity);
  return planDigest;
}

async function loadBeadsInput(rootDir: string, expectedPlanDigest?: string): Promise<BeadsCapture | undefined> {
  if (expectedPlanDigest === undefined) return undefined;
  const bytes = await readRegular(beadsInputPath(rootDir, expectedPlanDigest), 'Beads acknowledged input');
  if (bytes === undefined) return undefined;
  try {
    const value = parseCanonical<PersistedBeadsInput>(bytes);
    if (!value || value.schema !== 'lunacy-beads-input-v1' || !value.snapshot || !value.plan || !value.sourceIds) throw new Error('Beads acknowledged input fields are invalid');
    const fields = Object.keys(value).sort().join(',');
    if (!['evidenceCopy,plan,schema,snapshot,sourceIds', 'evidenceCopy,plan,replayIdentity,schema,snapshot,sourceIds', 'plan,schema,snapshot,sourceIds', 'plan,replayIdentity,schema,snapshot,sourceIds'].includes(fields)) throw new Error('Beads acknowledged input fields are invalid');
    if (value.replayIdentity !== undefined) validateReplayIdentity(value.replayIdentity);
    const plan = validatePlan(value.plan).plan;
    if (Object.getPrototypeOf(value.sourceIds) !== Object.prototype || Object.keys(value.sourceIds).length !== plan.steps.length || Object.keys(value.sourceIds).some((key) => typeof value.sourceIds[key] !== 'string' || value.sourceIds[key] !== key || !plan.steps.some((step) => step.stepId === key))) throw new Error('Beads acknowledged input sourceIds are invalid');
    if (expectedPlanDigest !== undefined && digest(plan) !== expectedPlanDigest) throw new Error('Beads acknowledged input plan differs from CURRENT');
    const snapshot = validateCapturedSnapshot(value.snapshot);
    if (plan.authorityDigest !== snapshot.contentDigest) throw new Error('Beads acknowledged input authority binding is invalid');
    const evidenceCopy = value.evidenceCopy === undefined ? undefined : validateEvidenceCopyReceipt(value.evidenceCopy);
    return { snapshot: Object.freeze(snapshot), plan: Object.freeze(plan), sourceIds: Object.freeze({ ...value.sourceIds }), ...(evidenceCopy === undefined ? {} : { evidenceCopy }) };
  } catch (error) {
    throw new BridgeError('ManifestMismatch', `Beads acknowledged input is invalid: ${(error as Error).message}`);
  }
}

function validateReplayIdentity(value: unknown): asserts value is EventIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Beads replay identity is invalid');
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  const expected = ['attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'eventId', 'payloadDigest', 'phaseId', 'runId', 'stepId'];
  const expectedWithLaunch = [...expected, 'launchToken'].sort();
  if (keys.join(',') !== expected.join(',') && keys.join(',') !== expectedWithLaunch.join(',')) throw new Error('Beads replay identity fields are invalid');
  for (const field of ['runId', 'phaseId', 'stepId', 'eventId']) if (typeof item[field] !== 'string' || (item[field] as string).length === 0) throw new Error(`Beads replay identity ${field} is invalid`);
  for (const field of ['attemptEpoch', 'authorityEpoch', 'barrierEpoch']) if (!Number.isSafeInteger(item[field]) || (item[field] as number) < 0) throw new Error(`Beads replay identity ${field} is invalid`);
  if (typeof item.payloadDigest !== 'string' || !SHA256_HEX.test(item.payloadDigest)) throw new Error('Beads replay identity payloadDigest is invalid');
  if (item.launchToken !== undefined && (typeof item.launchToken !== 'string' || item.launchToken.length === 0)) throw new Error('Beads replay identity launchToken is invalid');
}

async function loadBeadsInputForReplay(rootDir: string, record: ProcessedEvent): Promise<BeadsCapture | undefined> {
  const kernel = join(resolvedRoot(rootDir), '.kernel');
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(kernel, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const target = identityKey(record.identity);
  const bindings = entries.filter((entry) => entry.isFile() && entry.name.startsWith(BEADS_REPLAY_PREFIX) && entry.name.endsWith('.json')).sort((a, b) => stableCompare(a.name, b.name));
  for (const entry of bindings) {
    const bytes = await readRegular(join(kernel, entry.name), 'Beads replay binding');
    if (bytes === undefined) continue;
    try {
      const parsed = parseCanonical<PersistedBeadsReplayBinding>(bytes);
      const bindingDigest = /^BEADS\.REPLAY\.([0-9a-f]{64})\.json$/.exec(entry.name)?.[1];
      if (parsed.schema !== 'lunacy-beads-replay-v1' || !bindingDigest || bindingDigest !== digest(parsed.identity)) throw new Error('Beads replay binding fields are invalid');
      validateReplayIdentity(parsed.identity);
      if (identityKey(parsed.identity) !== target) continue;
      if (!SHA256_HEX.test(parsed.candidateDigest)) throw new Error('Beads replay candidate digest is invalid');
      return await loadBeadsInput(rootDir, parsed.candidateDigest);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('ManifestMismatch', `Beads replay input is invalid: ${(error as Error).message}`);
    }
  }
  // Read the legacy single binding for candidates written before S15. New
  // captures always use append-only BEADS.REPLAY.* records above.
  const candidates = entries.filter((entry) => entry.isFile() && entry.name.startsWith(BEADS_INPUT_PREFIX) && entry.name.endsWith('.json')).sort((a, b) => stableCompare(a.name, b.name));
  for (const entry of candidates) {
    const bytes = await readRegular(join(kernel, entry.name), 'Beads replay input');
    if (bytes === undefined) continue;
    try {
      const parsed = parseCanonical<PersistedBeadsInput>(bytes);
      if (parsed.replayIdentity === undefined) continue;
      validateReplayIdentity(parsed.replayIdentity);
      if (identityKey(parsed.replayIdentity) !== target) continue;
      const digestMatch = /^BEADS\.INPUT\.([0-9a-f]{64})\.json$/.exec(entry.name);
      if (!digestMatch) continue;
      return await loadBeadsInput(rootDir, digestMatch[1]);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('ManifestMismatch', `Beads replay input is invalid: ${(error as Error).message}`);
    }
  }
  return undefined;
}

/** Publish the compatibility alias only after CURRENT has committed the same
 * authority digest.  Recovery never reads this alias; it is informational for
 * older host tooling and may be absent after a crash without losing evidence. */
async function publishBeadsInputAlias(rootDir: string, planDigest: string): Promise<void> {
  const bytes = await readRegular(beadsInputPath(rootDir, planDigest), 'Beads acknowledged input');
  if (bytes === undefined) throw new BridgeError('ManifestMismatch', 'committed Beads input artifact is missing');
  await writeRegular(beadsInputPath(rootDir), bytes, 'Beads acknowledged input alias', undefined, rootDir);
}

function validateManifestAgainstOptions(manifest: BridgeManifest, options: BridgeOptions, plan: Plan, rootPath: string): void {
  if ((options.bridgeVersion !== undefined && options.bridgeVersion !== BRIDGE_VERSION) || (options.runtimeVersion !== undefined && options.runtimeVersion !== RUNTIME_VERSION)) throw new BridgeError('VersionMismatch', 'requested bridge/runtime version is not installed');
  if (manifest.rootPath !== rootPath) throw new BridgeError('PathMismatch', 'bridge manifest root path differs from runDir');
  if (manifest.runId !== options.runId || manifest.phaseId !== plan.phaseId) throw new BridgeError('ManifestMismatch', 'bridge manifest run identity differs from declaration');
  if (manifest.bridgeVersion !== (options.bridgeVersion ?? BRIDGE_VERSION) || manifest.runtimeVersion !== (options.runtimeVersion ?? RUNTIME_VERSION)) throw new BridgeError('VersionMismatch', 'bridge/runtime version does not match installed manifest');
  if (manifest.sourceDigest !== digest(BRIDGE_SOURCE_ID)) throw new BridgeError('VersionMismatch', 'bridge source digest does not match installed bridge');
  if (manifest.status === 'disabled') throw new BridgeError('Disabled', 'runtime bridge is disabled; start an explicit markdown-mode run instead');
}

function stateHasFreshAuthorityAdoption(state: MachineState, manifestPlanDigest: string): boolean {
  if (state.authorityEpoch <= 0) return false;
  // A crash can occur after an adoption CURRENT commit and before the bridge
  // manifest catches up; later recovery events may then be newer than the
  // adoption itself. Search the committed journal rather than trusting only
  // its final record, while still requiring the durable token/digest binding.
  for (const entry of [...state.journal].reverse()) {
    const event = entry.event;
    if (event.kind !== 'PARENT_DECISION' || !event.value || typeof event.value !== 'object' || Array.isArray(event.value)) continue;
    const value = event.value as Record<string, unknown>;
    if (!['ADOPT', 'ADOPT_AUTHORITY', 'AUTHORITY_ADOPT'].includes(String(value.kind ?? value.decision))) continue;
    const token = state.decisionTokens[event.token];
    if (token?.kind === 'AUTHORITY_ADOPTION' && token.consumed && token.expectedDigest === manifestPlanDigest && token.targetDigest === state.planDigest && token.observedDigest === state.planDigest) return true;
  }
  return false;
}

function eventIdentity(options: BridgeOptions, transition: BridgeTransition, plan: Plan, current: MachineState | undefined): EventIdentity {
  const identity: EventIdentity = {
    runId: options.runId,
    phaseId: transition.phaseId ?? plan.phaseId,
    stepId: transition.stepId ?? 'run',
    attemptEpoch: transition.attemptEpoch ?? current?.attemptEpoch ?? 0,
    authorityEpoch: transition.authorityEpoch ?? current?.authorityEpoch ?? 0,
    barrierEpoch: transition.barrierEpoch ?? current?.barrierEpoch ?? 0,
    eventId: transition.eventId,
    payloadDigest: digest(transition.event),
  };
  if (transition.launchToken !== undefined) identity.launchToken = transition.launchToken;
  return identity;
}

function projectionPayload(state: MachineState): Record<string, unknown> {
  return {
    schema: 'lunacy-runtime-projection-v1', mode: 'runtime', runId: state.runId, phaseId: state.phaseId,
    revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch,
    status: state.status, gate: state.gate, barrier: state.barrier, nextAction: state.nextAction,
    readyCount: Object.values(state.steps).filter((step) => isDispatchableStepStatus(step.status)).length,
    activeCount: Object.values(state.steps).filter((step) => step.status === 'ACTIVE').length,
    pendingDispatchCount: Object.values(state.outbox).filter((command) => command.state === 'PENDING' || command.state === 'CLAIMED').length,
    unknownDispatchCount: Object.values(state.outbox).filter((command) => command.state === 'UNKNOWN').length,
    steps: Object.values(state.steps).sort((a, b) => stableCompare(a.stepId, b.stepId)).map((step) => ({ stepId: step.stepId, status: step.status, attempt: step.attempt, dependencies: [...(step.dependencies ?? [])] })),
  };
}

function section(open: string, close: string, title: string, payload: Record<string, unknown>): string {
  return `${open}\n<!-- generated by lunacy-runtime-skill-bridge; machine-owned -->\n## ${title}\n\n\`\`\`json\n${canonicalString(payload)}\n\`\`\`\n${close}`;
}

const PROJECTION_KEYS = ['activeCount', 'attemptEpoch', 'authorityEpoch', 'barrier', 'barrierEpoch', 'gate', 'mode', 'nextAction', 'phaseId', 'readyCount', 'revision', 'runId', 'schema', 'status', 'steps', 'unknownDispatchCount', 'pendingDispatchCount'] as const;

function validateProjectionPayload(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('ProjectionFailed', 'projection payload is not an object');
  const object = value as Record<string, unknown>;
  const expected = [...PROJECTION_KEYS].sort();
  const actual = Object.keys(object).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new BridgeError('ProjectionFailed', 'projection payload fields are invalid');
  if (object.schema !== 'lunacy-runtime-projection-v1' || object.mode !== 'runtime' || typeof object.runId !== 'string' || object.runId.length === 0 || typeof object.phaseId !== 'string' || object.phaseId.length === 0 || typeof object.status !== 'string' || !['ACTIVE', 'BLOCKED', 'COMPLETE'].includes(object.status) || !['NOT-DUE', 'DUE', 'PASS', 'FINDINGS'].includes(String(object.gate)) || !['OPEN', 'CLOSED'].includes(String(object.barrier)) || typeof object.nextAction !== 'string' || object.nextAction.length === 0 || !Array.isArray(object.steps)) throw new BridgeError('ProjectionFailed', 'projection payload values are invalid');
  for (const field of ['revision', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch', 'readyCount', 'activeCount', 'pendingDispatchCount', 'unknownDispatchCount']) if (!Number.isSafeInteger(object[field]) || (object[field] as number) < 0) throw new BridgeError('ProjectionFailed', `projection ${field} is invalid`);
  const stepIds = new Set<string>();
  for (const step of object.steps) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new BridgeError('ProjectionFailed', 'projection step is invalid');
    const item = step as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    if (keys.join(',') !== 'attempt,dependencies,status,stepId' || typeof item.stepId !== 'string' || item.stepId.length === 0 || stepIds.has(item.stepId) || typeof item.status !== 'string' || !['READY', 'ACTIVE', 'NEEDS-DECISION', 'REPAIR', 'DONE', 'BLOCKED', 'SUPERSEDED'].includes(item.status) || !Array.isArray(item.dependencies) || !item.dependencies.every((dependency) => typeof dependency === 'string' && dependency.length > 0) || !Number.isSafeInteger(item.attempt) || (item.attempt as number) < 0) throw new BridgeError('ProjectionFailed', 'projection step fields are invalid');
    stepIds.add(item.stepId);
  }
}

function validateExistingSection(existing: string, open: string, close: string, title: string): void {
  const start = existing.indexOf(open); const end = existing.indexOf(close);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new BridgeError('ProjectionFailed', 'projection markers are malformed or duplicated');
  if (start < 0) return;
  if (existing.indexOf(open, start + open.length) >= 0 || existing.indexOf(close, end + close.length) >= 0) throw new BridgeError('ProjectionFailed', 'projection contains duplicate markers');
  const body = existing.slice(start + open.length, end).trim();
  const prefix = `<!-- generated by lunacy-runtime-skill-bridge; machine-owned -->\n## ${title}\n\n\`\`\`json\n`;
  const suffix = '\n```';
  if (!body.startsWith(prefix) || !body.endsWith(suffix)) throw new BridgeError('ProjectionFailed', 'projection marker content is not bridge-owned');
  const payloadText = body.slice(prefix.length, body.length - suffix.length);
  try { validateProjectionPayload(parseCanonical(payloadText)); }
  catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('ProjectionFailed', `projection payload is not canonical: ${(error as Error).message}`); }
}

function mergeSection(existing: string, open: string, close: string, generated: string): string {
  const start = existing.indexOf(open); const end = existing.indexOf(close);
  if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) throw new BridgeError('ProjectionFailed', 'projection markers are malformed or duplicated');
  if (start >= 0 && (existing.indexOf(open, start + open.length) >= 0 || existing.indexOf(close, end + close.length) >= 0)) throw new BridgeError('ProjectionFailed', 'projection contains duplicate markers');
  if (start < 0) return `${existing.replace(/\s*$/, '')}\n\n${generated}\n`;
  return `${existing.slice(0, start).replace(/\s*$/, '')}\n\n${generated}\n${existing.slice(end + close.length).replace(/^\s*/, '')}`;
}

/** Publish one projection file unless a trusted final read proves that its
 * complete desired bytes are already present.  The confirmation read is the
 * no-op linearization point; any miss falls through to the unchanged
 * writeRegular publication path. */
async function publishProjectionIfChanged(path: string, input: TrustedRegularRead | undefined, output: string, label: string, counters: BridgeCounters, rootDir: string): Promise<void> {
  const outputBytes = Buffer.from(output, 'utf8');
  if (input === undefined || Buffer.compare(input.bytes, outputBytes) !== 0) {
    await writeRegular(path, output, label, counters, rootDir);
    return;
  }
  let confirmation: TrustedRegularRead | undefined;
  try { confirmation = await readTrustedRegular(path, label, counters); }
  catch { confirmation = undefined; }
  if (confirmation === undefined || !sameFilesystemIdentity(input.identity, confirmation.identity) || Buffer.compare(confirmation.bytes, outputBytes) !== 0) {
    await writeRegular(path, output, label, counters, rootDir);
  }
}

async function project(rootDir: string, options: BridgeOptions, state: MachineState, counters: BridgeCounters): Promise<BridgeProjection> {
  const statePath = pathInside(rootDir, options.statePath ?? join(rootDir, 'STATE.md'), 'STATE.md');
  const stepsPath = pathInside(rootDir, options.stepsPath ?? join(rootDir, 'phases', safeId(state.phaseId, 'phaseId'), 'STEPS.md'), 'STEPS.md', state.phaseId);
  await assertNoSymlinkSegments(rootDir, statePath, 'STATE.md');
  await assertNoSymlinkSegments(rootDir, stepsPath, 'STEPS.md');
  const payload = projectionPayload(state);
  const stateInput = await readTrustedRegular(statePath, 'STATE.md', counters);
  const stepsInput = await readTrustedRegular(stepsPath, 'STEPS.md', counters);
  const stateBytes = stateInput?.text ?? '';
  const stepsBytes = stepsInput?.text ?? '';
  validateExistingSection(stateBytes, STATE_OPEN, STATE_CLOSE, 'Runtime state projection (machine-owned)');
  validateExistingSection(stepsBytes, STEPS_OPEN, STEPS_CLOSE, 'Runtime step projection (machine-owned)');
  const stateOut = mergeSection(stateBytes, STATE_OPEN, STATE_CLOSE, section(STATE_OPEN, STATE_CLOSE, 'Runtime state projection (machine-owned)', payload));
  const stepsOut = mergeSection(stepsBytes, STEPS_OPEN, STEPS_CLOSE, section(STEPS_OPEN, STEPS_CLOSE, 'Runtime step projection (machine-owned)', payload));
  try {
    await publishProjectionIfChanged(statePath, stateInput, stateOut, 'STATE.md', counters, rootDir);
    // A CLAIMED command has crossed the durable claim fence and its private
    // dispatcher may still be asynchronously attesting the exact phase
    // STEPS authority.  Defer the machine-owned STEPS rewrite until the
    // receipt/UNKNOWN callback publishes a non-CLAIMED state; replacing the
    // projection inode during that launch window would look like parent
    // instruction drift to the supervisor's final authority fence.  STATE.md
    // remains current, and the next callback/transition refreshes both files.
    const launchInFlight = Object.values(state.outbox).some((command) => command.state === 'CLAIMED');
    if (!launchInFlight) await publishProjectionIfChanged(stepsPath, stepsInput, stepsOut, 'STEPS.md', counters, rootDir);
  } catch (error) {
    throw new BridgeError('ProjectionFailed', (error as Error).message);
  }
  return { statePath, stepsPath, digest: digest(payload), revision: state.revision };
}

async function storeSnapshot(rootDir: string, counters: BridgeCounters, expectedRootIdentity?: FilesystemIdentity, signal?: AbortSignal): Promise<StoreSnapshot> {
  try {
    const snapshot = await new FileArtifactStore(rootDir, expectedRootIdentity).load(signal);
    counters.runtimeReads += 1;
    counters.runtimeBytes += Buffer.byteLength(canonicalString(snapshot.state ?? { generation: snapshot.generation }));
    return snapshot;
  } catch (error) {
    if (isFileArtifactStoreAbort(error)) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as Error).message.includes('ENOENT')) {
      const root = await lstatNoFollow(rootDir, 'runDir');
      const kernel = await lstatNoFollow(join(rootDir, '.kernel'), '.kernel');
      if (!root || !kernel) return { state: undefined, generation: 0 };
    }
    throw new BridgeError('ManifestMismatch', (error as Error).message);
  }
}

function finishCounters(counters: BridgeCounters): Readonly<BridgeCounters> {
  const copyCounters = { ...counters };
  delete copyCounters.startedAtNs;
  return Object.freeze(copyCounters);
}

function exactRawAcknowledgement(value: unknown): BeadsAcknowledgement {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new BridgeError('Unavailable', 'Beads acknowledgement is invalid');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'bdCommit,binaryDigest,snapshotDigest,targetPlanDigest,workspaceIdentity') throw new BridgeError('Unavailable', 'Beads acknowledgement must contain exactly the supported fields');
  return value as BeadsAcknowledgement;
}

function beadsOptions(options: BridgeOptions): BoundBeadsBridgeOptions | undefined {
  if (options.beads !== undefined) {
    if (options.beadsSource !== undefined || options.beadsMode !== undefined || options.beadsAck !== undefined) throw new BridgeError('Unavailable', 'Beads options must use one spelling');
    const value = options.beads;
    if (!value || typeof value !== 'object' || !(value.source instanceof BeadsPlanSource) || Object.getPrototypeOf(value.source) !== BeadsPlanSource.prototype || typeof value.source.capture !== 'function') throw new BridgeError('Unavailable', 'Beads bridge options are invalid');
    const mode = value.mode;
    if (!['off', 'shadow', 'active'].includes(mode)) throw new BridgeError('Unavailable', 'Beads bridge mode is invalid');
    let acknowledgement: BeadsAcknowledgement | undefined;
    if (value.acknowledgement !== undefined) {
      const raw = exactRawAcknowledgement(value.acknowledgement);
      acknowledgement = Object.freeze({ snapshotDigest: raw.snapshotDigest, targetPlanDigest: raw.targetPlanDigest, workspaceIdentity: raw.workspaceIdentity, bdCommit: raw.bdCommit, binaryDigest: raw.binaryDigest });
    }
    return Object.freeze({ mode, source: value.source, capture: value.source.capture.bind(value.source), ...(acknowledgement === undefined ? {} : { acknowledgement }) });
  }
  if (options.beadsSource !== undefined || options.beadsMode !== undefined || options.beadsAck !== undefined) {
    if (!(options.beadsSource instanceof BeadsPlanSource) || Object.getPrototypeOf(options.beadsSource) !== BeadsPlanSource.prototype || typeof options.beadsSource.capture !== 'function') throw new BridgeError('Unavailable', 'beadsSource is required for Beads mode');
    const mode = options.beadsMode ?? 'off';
    if (!['off', 'shadow', 'active'].includes(mode)) throw new BridgeError('Unavailable', 'Beads bridge mode is invalid');
    let acknowledgement: BeadsAcknowledgement | undefined;
    if (options.beadsAck !== undefined) {
      const raw = exactRawAcknowledgement(options.beadsAck);
      acknowledgement = Object.freeze({ snapshotDigest: raw.snapshotDigest, targetPlanDigest: raw.targetPlanDigest, workspaceIdentity: raw.workspaceIdentity, bdCommit: raw.bdCommit, binaryDigest: raw.binaryDigest });
    }
    return Object.freeze({ mode, source: options.beadsSource, capture: options.beadsSource.capture.bind(options.beadsSource), ...(acknowledgement === undefined ? {} : { acknowledgement }) });
  }
  return undefined;
}

function beadsResult(mode: BeadsBridgeMode, capture: BeadsCapture, nativePlanDigest?: string, status: BridgeBeadsResult['status'] = 'captured'): BridgeBeadsResult {
  return { mode, status, snapshotDigest: beadsSnapshotDigest(capture), targetPlanDigest: beadsPlanDigest(capture), ...(nativePlanDigest === undefined ? {} : { nativePlanDigest }) };
}

function validateCapturedBeads(value: unknown): BeadsCapture {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('capture must be an object');
    const input = value as Record<string, unknown>;
    if (!input.snapshot || !input.plan || !input.sourceIds || !['evidenceCopy,plan,snapshot,sourceIds', 'plan,snapshot,sourceIds'].includes(Object.keys(input).sort().join(','))) throw new Error('capture fields are invalid');
    const snapshot = validateCapturedSnapshot(parseCanonical<BeadsCapture['snapshot']>(canonicalString(input.snapshot)));
    const plan = canonicalizeDeclaration(parseCanonical<Plan>(canonicalString(input.plan)));
    const sourceIds = parseCanonical<Record<string, string>>(canonicalString(input.sourceIds));
    if (Object.getPrototypeOf(sourceIds) !== Object.prototype || Object.keys(sourceIds).length !== plan.steps.length || Object.keys(sourceIds).some((key) => sourceIds[key] !== key || !plan.steps.some((step) => step.stepId === key))) throw new Error('capture sourceIds are invalid');
    if (plan.authorityDigest !== snapshot.contentDigest) throw new Error('capture authority binding is invalid');
    const evidenceCopy = input.evidenceCopy === undefined ? undefined : validateEvidenceCopyReceipt(parseCanonical<BeadsEvidenceCopyReceipt>(canonicalString(input.evidenceCopy)));
    return { snapshot: Object.freeze(snapshot), plan: Object.freeze(plan), sourceIds: Object.freeze(sourceIds), ...(evidenceCopy === undefined ? {} : { evidenceCopy }) };
  } catch (error) {
    throw new BridgeError('Unavailable', `Beads capture is invalid: ${(error as Error).message}`);
  }
}

function semanticPlanDigest(plan: Plan): string {
  const { authorityDigest: _authorityDigest, ...withoutSourceBinding } = plan;
  return digest(withoutSourceBinding);
}

function beadsCaptureFailure(mode: BeadsBridgeMode, error: unknown): BridgeBeadsResult {
  const reason = error instanceof Error ? error.message : String(error);
  return { mode, status: 'unavailable', reason };
}

type ProcessedEvent = MachineState['processed'][string];

/** Find a durable replay by the fields the caller actually supplied.  Epochs
 * are fences for a new event, but they are not stable replay identity when an
 * invocation omitted them: CURRENT may have advanced since the original
 * commit.  The durable record retains the exact identity to feed back to the
 * kernel once the stable external fields match. */
function findProcessedEvent(state: MachineState | undefined, options: BridgeOptions, transition: BridgeTransition): ProcessedEvent | undefined {
  if (!state) return undefined;
  const payloadDigest = digest(transition.event);
  const expectedPhase = transition.phaseId;
  const expectedStep = transition.stepId;
  return Object.values(state.processed).find((record) => {
    const identity = record.identity;
    if (identity.runId !== options.runId || identity.eventId !== transition.eventId || identity.payloadDigest !== payloadDigest) return false;
    if (expectedPhase !== undefined ? identity.phaseId !== expectedPhase : identity.phaseId !== state.phaseId && identity.phaseId !== 'run') return false;
    if (expectedStep !== undefined ? identity.stepId !== expectedStep : identity.stepId !== 'run') return false;
    if (transition.launchToken !== undefined ? identity.launchToken !== transition.launchToken : identity.launchToken !== undefined) return false;
    for (const [field, value] of [['attemptEpoch', transition.attemptEpoch], ['authorityEpoch', transition.authorityEpoch], ['barrierEpoch', transition.barrierEpoch]] as const) if (value !== undefined && identity[field] !== value) return false;
    return true;
  });
}

function replayPlanDigest(event: Event, state: MachineState, record: ProcessedEvent): string {
  if (event.kind === 'START' && typeof event.intentRef.digest === 'string' && /^[0-9a-f]{64}$/.test(event.intentRef.digest)) return event.intentRef.digest;
  if (event.kind === 'PARENT_DECISION' && event.value && typeof event.value === 'object' && !Array.isArray(event.value)) {
    const value = event.value as Record<string, unknown>;
    if (typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest)) return value.digest;
  }
  // Non-authority events do not carry a candidate declaration; their
  // committed authority is the current digest.  The record parameter keeps
  // this helper tied to a proven replay rather than an arbitrary event.
  void record;
  return state.planDigest;
}

/** Execute exactly one parent event through the existing RunKernel.advance. */
export async function transition(options: BridgeOptions, transitionInput: BridgeTransition): Promise<BridgeResult> {
  if (!options || typeof options !== 'object') throw new BridgeError('Unavailable', 'bridge options are required');
  const runDir = options.runDir;
  const runId = options.runId;
  const mode = options.mode;
  // Copy the caller-owned declaration before any asynchronous Beads capture;
  // a parent must not be able to change the native authority while the
  // adapter is suspended on a subprocess.
  const planInput = options.plan === undefined ? undefined : clone(options.plan);
  const statePath = options.statePath;
  const stepsPath = options.stepsPath;
  const bridgeVersion = options.bridgeVersion;
  const runtimeVersion = options.runtimeVersion;
  const optionCounters = options.counters;
  const dispatcher = projectBridgeDispatcher(options.dispatcher);
  const dispatcherSignal = dispatcher.signal;
  if (mode === undefined) throw new BridgeError('Unavailable', 'bridge mode is required');
  if (typeof runDir !== 'string' || typeof runId !== 'string' || runId.length === 0) throw new BridgeError('Unavailable', 'bridge run identity is required');
  if (!transitionInput || typeof transitionInput !== 'object') throw new BridgeError('Unavailable', 'bridge transition identity is invalid');
  const rawTransition = transitionInput as BridgeTransition;
  const rawEvent = rawTransition.event;
  const eventId = rawTransition.eventId;
  const phaseId = rawTransition.phaseId;
  const stepId = rawTransition.stepId;
  const expectedRevision = rawTransition.expectedRevision;
  const attemptEpoch = rawTransition.attemptEpoch;
  const authorityEpoch = rawTransition.authorityEpoch;
  const barrierEpoch = rawTransition.barrierEpoch;
  const launchToken = rawTransition.launchToken;
  if (!rawEvent || typeof rawEvent !== 'object' || typeof eventId !== 'string' || eventId.length === 0) throw new BridgeError('Unavailable', 'bridge transition identity is invalid');
  for (const [label, value] of [['phaseId', phaseId], ['stepId', stepId], ['launchToken', launchToken]] as const) if (value !== undefined && (typeof value !== 'string' || value.length === 0)) throw new BridgeError('Unavailable', `${label} is invalid`);
  for (const [label, value] of [['expectedRevision', expectedRevision], ['attemptEpoch', attemptEpoch], ['authorityEpoch', authorityEpoch], ['barrierEpoch', barrierEpoch]] as const) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new BridgeError('Unavailable', `${label} is invalid`);
  // Snapshot the complete event synchronously at the public boundary.  All
  // filesystem/process awaits below must operate on this immutable clone, not
  // a caller-owned object that an ordinary callback could mutate while
  // preflight is suspended.
  let eventSnapshot: Event;
  try { eventSnapshot = parseCanonical<Event>(canonicalString(rawEvent)); }
  catch (error) { throw new BridgeError('Unavailable', `transition event is not canonical: ${(error as Error).message}`); }
  const transitionSnapshot: BridgeTransition = { event: eventSnapshot, eventId, ...(phaseId === undefined ? {} : { phaseId }), ...(stepId === undefined ? {} : { stepId }), ...(expectedRevision === undefined ? {} : { expectedRevision }), ...(attemptEpoch === undefined ? {} : { attemptEpoch }), ...(authorityEpoch === undefined ? {} : { authorityEpoch }), ...(barrierEpoch === undefined ? {} : { barrierEpoch }), ...(launchToken === undefined ? {} : { launchToken }) };
  const counters = newCounters(optionCounters); counters.transitions += 1; counters.routineWakeups += 1;
  if (mode !== 'markdown' && mode !== 'runtime') throw new BridgeError('Unavailable', 'bridge mode is invalid');
  if (mode === 'runtime' && ((bridgeVersion !== undefined && bridgeVersion !== BRIDGE_VERSION) || (runtimeVersion !== undefined && runtimeVersion !== RUNTIME_VERSION))) throw new BridgeError('VersionMismatch', 'requested bridge/runtime version is not installed');
  const configuredBeads = beadsOptions(options);
  if (configuredBeads && configuredBeads.mode !== 'off' && mode !== 'runtime') throw new BridgeError('ModeConflict', 'Beads planning mode requires the runtime bridge');
  const rootPath = resolvedRoot(runDir);
  // Every entry mode enforces the same owner/permission boundary. Shadow and
  // Markdown remain non-mutating, but must not inspect an unsafe runtime
  // surface that the runtime path would reject.
  await assertNoSymlinkSegments(rootPath, rootPath, 'runDir');
  const preflightRoot = await lstatNoFollow(rootPath, 'runDir');
  if (preflightRoot && !preflightRoot.isDirectory()) throw new BridgeError('PathMismatch', 'runDir is not a directory');
  const preflightKernel = await lstatNoFollow(join(rootPath, '.kernel'), '.kernel');
  if (preflightKernel && !preflightKernel.isDirectory()) throw new BridgeError('PathMismatch', '.kernel is not a directory');
  if (preflightKernel) await assertTrustedPathSegments(rootPath, join(rootPath, '.kernel'), '.kernel');
  if (mode === 'markdown') {
    const markdownRoot = resolvedRoot(runDir);
    await assertNoSymlinkSegments(markdownRoot, join(markdownRoot, '.kernel'), '.kernel');
    const existing = await loadManifest(runDir);
    if (existing || await hasTombstone(runDir)) throw new BridgeError('ModeConflict', 'markdown mode cannot run against a runtime bridge root');
    return { mode: 'markdown', projected: false, counters: finishCounters(counters) };
  }
  if (configuredBeads?.mode === 'shadow') {
    let captured: BeadsCapture;
    try {
      captured = validateCapturedBeads(await configuredBeads.capture(undefined, [rootPath, join(rootPath, '.kernel')]));
    }
    catch (error) { return { mode: 'runtime', projected: false, beads: beadsCaptureFailure('shadow', error), counters: finishCounters(counters) }; }
    if (planInput === undefined) throw new BridgeError('InvalidDeclaration', 'shadow Beads mode requires the native parent plan');
    let nativeDigest: string;
    try { nativeDigest = semanticPlanDigest(canonicalizeDeclaration(parseCanonical<Plan>(canonicalString(planInput)))); }
    catch (error) { throw new BridgeError('InvalidDeclaration', `native plan is invalid for Beads shadow comparison: ${(error as Error).message}`); }
    const status = nativeDigest === semanticPlanDigest(captured.plan) ? 'shadow-match' : 'shadow-mismatch';
    return { mode: 'runtime', projected: false, beads: beadsResult('shadow', captured, nativeDigest, status), counters: finishCounters(counters) };
  }

  // A fresh START must be rejected before the bridge lock creates the
  // runtime store namespace.  In particular, an active Beads capture can
  // reveal that a caller's native/raw alias is not one of the exact aliases
  // RunKernel will accept; allowing the lock setup to run first would leave
  // generations/quarantine/reuse directories behind for a rejected input.
  // Existing CURRENT state is deliberately excluded: a duplicate START must
  // be able to replay its durable yield without consulting a now-unavailable
  // Beads source.
  let preCapturedStart: BeadsCapture | undefined;
  if (eventSnapshot.kind === 'START' && configuredBeads?.mode === 'active') {
    let hasCurrent = false;
    try {
      const currentStat = await fs.lstat(join(rootPath, '.kernel', 'CURRENT'));
      hasCurrent = currentStat.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!hasCurrent) {
      try { preCapturedStart = validateCapturedBeads(await configuredBeads.capture(undefined, [rootPath, join(rootPath, '.kernel')])); }
      catch (error) {
        if (error instanceof BeadsUnavailable) throw new BridgeError('Unavailable', error.message);
        throw error;
      }
      if (planInput !== undefined) {
        let suppliedPlan: Plan;
        try { suppliedPlan = canonicalizeDeclaration(parseCanonical<Plan>(canonicalString(planInput))); }
        catch (error) { throw new BridgeError('InvalidDeclaration', `native plan is invalid for active Beads capture: ${(error as Error).message}`); }
        if (semanticPlanDigest(suppliedPlan) !== semanticPlanDigest(preCapturedStart.plan)) throw new BridgeError('Unavailable', 'caller plan differs from the captured Beads authority');
        if (suppliedPlan.authorityDigest !== undefined && suppliedPlan.authorityDigest !== preCapturedStart.snapshot.contentDigest) throw new BridgeError('Unavailable', 'caller plan authorityDigest differs from the captured Beads source binding');
      }
      validateStartBoundary(eventSnapshot, acceptedStartPlanDigests(preCapturedStart.plan, preCapturedStart.plan));
      if (phaseId !== undefined && phaseId !== 'run' && phaseId !== preCapturedStart.plan.phaseId) throw new BridgeError('InvalidDeclaration', 'START identity phase does not name the captured plan');
      if (configuredBeads.acknowledgement === undefined) throw new BridgeError('Unavailable', 'active Beads START/adoption requires an exact parent acknowledgement');
      try { validateBeadsAcknowledgement(configuredBeads.acknowledgement, preCapturedStart); }
      catch (error) {
        if (error instanceof BeadsUnavailable) throw new BridgeError('Unavailable', error.message);
        throw error;
      }
    }
  } else if (eventSnapshot.kind === 'START' && configuredBeads?.mode !== 'active') {
    // The native-only path has no source capture to establish a second plan;
    // its exact alias set is known synchronously from the caller declaration.
    if (planInput === undefined) throw new BridgeError('InvalidDeclaration', 'START requires a plan declaration');
    let nativeRawPlan: Plan; let nativePlan: Plan;
    try {
      nativeRawPlan = parseCanonical<Plan>(canonicalString(planInput));
      nativePlan = canonicalizeDeclaration(nativeRawPlan);
    }
    catch (error) { throw new BridgeError('InvalidDeclaration', `plan declaration is not canonical: ${(error as Error).message}`); }
    validateStartBoundary(eventSnapshot, acceptedStartPlanDigests(nativeRawPlan, nativePlan));
    if (phaseId !== undefined && phaseId !== 'run' && phaseId !== nativePlan.phaseId) throw new BridgeError('InvalidDeclaration', 'START identity phase does not name the supplied plan');
  }

  const requestedStatePath = statePath;
  const requestedStepsPath = stepsPath;
  return await withBridgeOperationLock(rootPath, async (lockedRootIdentity) => {
    const rootStat = await lstatNoFollow(rootPath, 'runDir');
    if (rootStat && !rootStat.isDirectory()) throw new BridgeError('PathMismatch', 'runDir is not a directory');
    const currentSnapshot = await storeSnapshot(rootPath, counters, lockedRootIdentity, dispatcherSignal);
    let manifest = await loadManifest(rootPath);
    if (await hasTombstone(rootPath)) throw new BridgeError('ManifestMismatch', 'runtime bridge metadata was deleted; reinitialize at a new run root');
    if (manifest?.status === 'disabled') throw new BridgeError('Disabled', 'runtime bridge is disabled; start an explicit markdown-mode run instead');
    let beadsObservation: BridgeBeadsResult | undefined;
    let beadsCapture: BeadsCapture | undefined;
    let captureForMutation = false;
    let candidatePlanDigest: string | undefined;
    let planValue = planInput;
    let replayRecord: ProcessedEvent | undefined;
    let adoptionDecision = false;
    if (configuredBeads?.mode === 'active') {
      adoptionDecision = eventSnapshot.kind === 'PARENT_DECISION' && currentSnapshot.state?.decisionTokens[eventSnapshot.token]?.kind === 'AUTHORITY_ADOPTION';
      replayRecord = findProcessedEvent(currentSnapshot.state, { ...options, runDir: rootPath }, { ...transitionSnapshot, event: eventSnapshot });
      const replayed = replayRecord !== undefined;
      captureForMutation = !replayed && (!currentSnapshot.state || eventSnapshot.kind === 'START' || eventSnapshot.kind === 'OBSERVATION' || adoptionDecision);
      if (eventSnapshot.kind === 'OBSERVATION' && eventSnapshot.category === 'RECOVERY') captureForMutation = false;
      if (captureForMutation) {
        try {
          beadsCapture = preCapturedStart !== undefined && eventSnapshot.kind === 'START'
            ? preCapturedStart
            : validateCapturedBeads(await configuredBeads.capture(undefined, [rootPath, join(rootPath, '.kernel')]));
        }
        catch (error) {
          if (eventSnapshot.kind === 'OBSERVATION' && currentSnapshot.state) return { mode: 'runtime', projected: false, beads: beadsCaptureFailure('active', error), counters: finishCounters(counters) };
          if (error instanceof BeadsUnavailable) throw new BridgeError('Unavailable', error.message);
          throw error;
        }
        planValue = beadsCapture.plan;
        beadsObservation = beadsResult('active', beadsCapture);
      } else {
        const expectedReplayDigest = replayRecord === undefined ? currentSnapshot.state?.planDigest : replayPlanDigest(eventSnapshot, currentSnapshot.state!, replayRecord);
        // A START may have been accepted with a semantically matching native
        // declaration whose raw/normalized digest is not the Beads candidate
        // digest.  Persisted replay bindings resolve that exact candidate
        // without consulting the live source or guessing from CURRENT.
        const replayEvidence = replayRecord === undefined ? undefined : await loadBeadsInputForReplay(rootPath, replayRecord);
        if (replayRecord !== undefined && replayEvidence === undefined && eventSnapshot.kind === 'OBSERVATION') {
          // A committed authority-drift observation carries the newly
          // captured candidate metadata needed for an exact lost-response
          // replay. Falling back to CURRENT's older authority would fabricate
          // an acknowledgement for the wrong snapshot; fail closed instead.
          try {
            const storedYield = JSON.parse(replayRecord.yieldBytes) as { kind?: string; token?: string };
            const token = storedYield.token === undefined ? undefined : currentSnapshot.state?.decisionTokens[storedYield.token];
            if (storedYield.kind === 'DECISION_REQUIRED' && token?.kind === 'AUTHORITY_ADOPTION') throw new BridgeError('Unavailable', 'authority-drift replay evidence is unavailable');
          } catch (error) {
            if (error instanceof BridgeError) throw error;
            throw new BridgeError('ManifestMismatch', `stored replay yield is invalid: ${(error as Error).message}`);
          }
        }
        beadsCapture = replayEvidence ?? await loadBeadsInput(rootPath, expectedReplayDigest);
        if (beadsCapture !== undefined) {
          // A proven replay returns the durable yield for the original event;
          // a caller declaration supplied on retry is not a new authority and
          // must not strand that replay behind a plan comparison.
          if (planInput !== undefined && replayRecord === undefined) {
            let suppliedPlan: Plan;
            try { suppliedPlan = canonicalizeDeclaration(parseCanonical<Plan>(canonicalString(planInput))); }
            catch (error) { throw new BridgeError('InvalidDeclaration', `plan declaration is not canonical: ${(error as Error).message}`); }
            if (digest(suppliedPlan) !== currentSnapshot.state?.planDigest && semanticPlanDigest(suppliedPlan) !== semanticPlanDigest(beadsCapture.plan)) throw new BridgeError('Unavailable', 'caller plan differs from the committed Beads authority');
            if (suppliedPlan.authorityDigest !== undefined && suppliedPlan.authorityDigest !== beadsCapture.snapshot.contentDigest) throw new BridgeError('Unavailable', 'caller plan authorityDigest differs from the captured Beads source binding');
          }
          planValue = beadsCapture.plan;
          beadsObservation = beadsResult('active', beadsCapture);
        } else {
          // Once an active snapshot has been acknowledged, ordinary events
          // must use that exact persisted input.  Do not fall back to a
          // caller-supplied Plan when the artifact is missing: doing so would
          // turn an input-artifact deletion into an unacknowledged authority
          // swap (or a spurious kernel adoption decision).  START and
          // authority-adoption remain the explicit recapture/ack boundaries.
          throw new BridgeError('Unavailable', 'acknowledged Beads input is unavailable; explicit recapture is required');
        }
      }
    }
    let rawPlan: Plan; let rawPlanBytes: string;
    try { rawPlanBytes = canonicalString(planValue); rawPlan = parseCanonical<Plan>(rawPlanBytes); }
    catch (error) { throw new BridgeError('InvalidDeclaration', `plan declaration is not canonical: ${(error as Error).message}`); }
    const plan = canonicalizeDeclaration(rawPlan);
    const kernelPlan = clone(rawPlan);
    const optionsSnapshot: BridgeOptions = { runDir, runId, mode, plan: kernelPlan, ...(requestedStatePath === undefined ? {} : { statePath: requestedStatePath }), ...(requestedStepsPath === undefined ? {} : { stepsPath: requestedStepsPath }), ...(bridgeVersion === undefined ? {} : { bridgeVersion }), ...(runtimeVersion === undefined ? {} : { runtimeVersion }) };
    if (configuredBeads?.mode === 'active' && beadsCapture !== undefined && captureForMutation && planInput !== undefined && (eventSnapshot.kind === 'START' || adoptionDecision || !currentSnapshot.state)) {
      let suppliedPlan: Plan;
      try { suppliedPlan = canonicalizeDeclaration(parseCanonical<Plan>(canonicalString(planInput))); }
      catch (error) { throw new BridgeError('InvalidDeclaration', `plan declaration is not canonical: ${(error as Error).message}`); }
      if (semanticPlanDigest(suppliedPlan) !== semanticPlanDigest(beadsCapture.plan)) throw new BridgeError('Unavailable', 'caller plan differs from the captured Beads authority');
      if (suppliedPlan.authorityDigest !== undefined && suppliedPlan.authorityDigest !== beadsCapture.snapshot.contentDigest) throw new BridgeError('Unavailable', 'caller plan authorityDigest differs from the captured Beads source binding');
    }
    // Bridge preflight and RunKernel.advance share the exact same START alias
    // set.  Do not add a caller-provided raw spelling here: when active Beads
    // capture supplies the source-bound declaration, an arbitrary semantically
    // equivalent native digest would be accepted by the bridge and rejected
    // by the sole kernel authority after durable bridge metadata was written.
    const acceptedStartDigests = new Set(acceptedStartPlanDigests(kernelPlan, plan));
    validateStartBoundary(eventSnapshot, [...acceptedStartDigests]);
    counters.declarationReads += 1; counters.declarationBytes += Buffer.byteLength(rawPlanBytes);
    if (configuredBeads?.mode === 'active' && beadsCapture !== undefined && captureForMutation) {
      let acknowledged = false;
      const adoptionDecision = eventSnapshot.kind === 'PARENT_DECISION' && currentSnapshot.state?.decisionTokens[eventSnapshot.token]?.kind === 'AUTHORITY_ADOPTION';
      const requiresAcknowledgement = !currentSnapshot.state || eventSnapshot.kind === 'START' || adoptionDecision;
      if (configuredBeads.acknowledgement === undefined && requiresAcknowledgement) throw new BridgeError('Unavailable', 'active Beads START/adoption requires an exact parent acknowledgement');
      try {
        if (configuredBeads.acknowledgement !== undefined) { validateBeadsAcknowledgement(configuredBeads.acknowledgement, beadsCapture); acknowledged = true; }
      } catch (error) {
        if (requiresAcknowledgement) { if (error instanceof BeadsUnavailable) throw new BridgeError('Unavailable', error.message); throw error; }
        beadsObservation = { ...beadsObservation!, status: 'drift', reason: error instanceof Error ? error.message : String(error) };
      }
      if (acknowledged) beadsObservation = { ...beadsObservation!, status: 'captured' };
      else if (currentSnapshot.state && eventSnapshot.kind !== 'START' && eventSnapshot.kind !== 'PARENT_DECISION' && beadsObservation?.status === 'captured') beadsObservation = { ...beadsObservation, status: 'drift', reason: 'source snapshot requires a fresh parent acknowledgement' };
    }
    if (!manifest && currentSnapshot.state && eventSnapshot.kind !== 'START') throw new BridgeError('ManifestMismatch', 'runtime state exists without an explicit bridge manifest');
    if (manifest) validateManifestAgainstOptions(manifest, optionsSnapshot, plan, rootPath);
    if (manifest && currentSnapshot.state && manifest.planDigest !== currentSnapshot.state.planDigest) {
      // A consumed adoption token is a one-hop crash-recovery proof, not a
      // durable substitute for the manifest. Reconcile that exact
      // predecessor before admitting another event; otherwise two crashes
      // can leave CURRENT two authorities ahead of the stale manifest and
      // strand every later operation behind ManifestMismatch.
      if (!stateHasFreshAuthorityAdoption(currentSnapshot.state, manifest.planDigest)) throw new BridgeError('ManifestMismatch', 'bridge manifest plan digest disagrees with CURRENT state');
      const repaired = { ...manifest, planDigest: currentSnapshot.state.planDigest, phaseId: currentSnapshot.state.phaseId };
      await saveManifest(rootPath, repaired);
      manifest = repaired;
    }
    if (eventSnapshot.kind === 'START' && currentSnapshot.state && !manifest) throw new BridgeError('ManifestMismatch', 'START cannot initialize an existing runtime root');
    if (!manifest && eventSnapshot.kind !== 'START') throw new BridgeError('Unavailable', 'runtime bridge is not initialized; use START in explicit runtime mode');
    if (manifest && !currentSnapshot.state && eventSnapshot.kind !== 'START') throw new BridgeError('ManifestMismatch', 'runtime bridge manifest exists without a committed CURRENT state');
    if (manifest && !currentSnapshot.state && eventSnapshot.kind === 'START' && manifest.planDigest !== digest(plan)) throw new BridgeError('ManifestMismatch', 'runtime bridge manifest plan does not match START declaration');
    const preflightStatePath = pathInside(rootPath, requestedStatePath ?? join(rootPath, 'STATE.md'), 'STATE.md');
    const projectionPhaseId = currentSnapshot.state?.phaseId ?? plan.phaseId;
    const preflightStepsPath = pathInside(rootPath, requestedStepsPath ?? join(rootPath, 'phases', safeId(projectionPhaseId, 'phaseId'), 'STEPS.md'), 'STEPS.md', projectionPhaseId);
    await assertNoSymlinkSegments(rootPath, preflightStatePath, 'STATE.md');
    await assertNoSymlinkSegments(rootPath, preflightStepsPath, 'STEPS.md');
    await assertTrustedPathSegments(rootPath, dirname(preflightStatePath), 'STATE.md parent');
    await assertTrustedPathSegments(rootPath, dirname(preflightStepsPath), 'STEPS.md parent');
    await assertRegularOrMissing(preflightStatePath, 'STATE.md');
    await assertRegularOrMissing(preflightStepsPath, 'STEPS.md');
    await assertDirectoryOrMissing(dirname(preflightStepsPath), 'STEPS.md parent');
    const preflightState = await readRegular(preflightStatePath, 'STATE.md', counters) ?? '';
    const preflightSteps = await readRegular(preflightStepsPath, 'STEPS.md', counters) ?? '';
    validateExistingSection(preflightState, STATE_OPEN, STATE_CLOSE, 'Runtime state projection (machine-owned)');
    validateExistingSection(preflightSteps, STEPS_OPEN, STEPS_CLOSE, 'Runtime step projection (machine-owned)');
    if (!manifest && eventSnapshot.kind === 'START') {
      if ([attemptEpoch, authorityEpoch, barrierEpoch].some((value) => value !== undefined && value !== 0)) throw new BridgeError('InvalidDeclaration', 'START identity epochs must be zero for a new run');
            const startDigests = new Set(acceptedStartDigests);
            if (!startDigests.has(eventSnapshot.intentRef.digest)) throw new BridgeError('InvalidDeclaration', 'START intentRef does not name the supplied plan');
      if (phaseId !== undefined && phaseId !== 'run' && phaseId !== plan.phaseId) throw new BridgeError('InvalidDeclaration', 'START identity phase does not name the supplied plan');
      manifest = makeManifest(optionsSnapshot, plan, rootPath);
      await saveManifest(rootPath, manifest, true);
    }
    const identity = replayRecord?.identity ?? eventIdentity(optionsSnapshot, { ...transitionSnapshot, event: eventSnapshot }, plan, currentSnapshot.state);
    // Persist every validated capture, including a drift observation that is
    // intentionally non-authoritative until a parent acknowledgement. If a
    // response is lost after RunKernel commits the diagnostic/token, replay
    // must recover the exact candidate snapshot rather than recapturing (or
    // falling back to the older CURRENT-selected input).
    if (configuredBeads?.mode === 'active' && beadsCapture !== undefined && captureForMutation) candidatePlanDigest = await saveBeadsInput(rootPath, beadsCapture, identity);
    const effectiveExpectedRevision = expectedRevision ?? currentSnapshot.state?.revision;
    const input: AdvanceInput = { runId, identity, event: clone(eventSnapshot), ...(effectiveExpectedRevision === undefined ? {} : { expectedRevision: effectiveExpectedRevision }) };
    let yieldValue: Yield;
    try {
      const kernel: RunKernel = options.driver === undefined
        ? makeRunKernelForBridge({ plan: kernelPlan, rootDir: rootPath }, lockedRootIdentity)
        : makeComposedKernelForBridge({ plan: kernelPlan, rootDir: rootPath }, lockedRootIdentity, options.driver, dispatcher);
      yieldValue = await kernel.advance(input);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (isFileArtifactStoreAbort(error)) throw error;
      const message = (error as Error).message;
      if (message.includes('ManifestMismatch')) throw new BridgeError('ManifestMismatch', message);
      throw error;
    }
    const after = await storeSnapshot(rootPath, counters, lockedRootIdentity, dispatcherSignal);
    if (!after.state) throw new BridgeError('ManifestMismatch', 'runtime transition committed no CURRENT state');
    if (manifest && after.state.planDigest === digest(plan) && manifest.planDigest !== digest(plan)) {
      const nextManifest = { ...manifest, planDigest: digest(plan), phaseId: plan.phaseId };
      await saveManifest(rootPath, nextManifest);
      manifest = nextManifest;
    }
    if (candidatePlanDigest !== undefined && after.state.planDigest === candidatePlanDigest) await publishBeadsInputAlias(rootPath, candidatePlanDigest);
    let projection: BridgeProjection;
    try { projection = await project(rootPath, { runDir: rootPath, runId, mode: 'runtime', statePath: requestedStatePath, stepsPath: requestedStepsPath }, after.state, counters); }
    catch (error) { if (error instanceof BridgeError) throw error; throw new BridgeError('ProjectionFailed', (error as Error).message); }
    return { mode: 'runtime', yield: yieldValue, projected: true, projection, ...(beadsObservation === undefined ? {} : { beads: beadsObservation }), counters: finishCounters(counters) };
  });
}

async function requireQuiescent(rootDir: string, options: BridgeOptions, allowDisabled = false, expectedRootIdentity?: FilesystemIdentity): Promise<BridgeManifest> {
  if (!options || typeof options !== 'object') throw new BridgeError('Unavailable', 'bridge options are required');
  const runId = options.runId;
  const bridgeVersion = options.bridgeVersion;
  const runtimeVersion = options.runtimeVersion;
  if (typeof runId !== 'string' || runId.length === 0) throw new BridgeError('Unavailable', 'bridge run identity is required');
  const optionsSnapshot: BridgeOptions = { runDir: rootDir, runId, mode: 'runtime', ...(bridgeVersion === undefined ? {} : { bridgeVersion }), ...(runtimeVersion === undefined ? {} : { runtimeVersion }) };
  const rootPath = resolvedRoot(rootDir);
  await assertNoSymlinkSegments(rootPath, rootPath, 'runDir');
  await assertNoSymlinkSegments(rootPath, join(rootPath, '.kernel'), '.kernel');
  let manifest = await loadManifest(rootPath);
  if (!manifest) throw new BridgeError('Unavailable', 'runtime bridge manifest is absent');
  // A tombstone is the durable delete decision.  If a crash left the old
  // manifest beside it, do not let a later disable/delete call roll metadata
  // back or mutate the tombstoned root; recovery must remain a fresh explicit
  // run at another root.
  if (await hasTombstone(rootPath)) throw new BridgeError('ManifestMismatch', 'runtime bridge metadata was deleted; reinitialize at a new run root');
  if (allowDisabled && manifest.status === 'disabled') {
    if ((bridgeVersion !== undefined && bridgeVersion !== BRIDGE_VERSION) || (runtimeVersion !== undefined && runtimeVersion !== RUNTIME_VERSION) || manifest.sourceDigest !== digest(BRIDGE_SOURCE_ID)) throw new BridgeError('VersionMismatch', 'bridge manifest does not match installed bridge');
    if (manifest.rootPath !== rootPath || manifest.runId !== runId || manifest.bridgeVersion !== (bridgeVersion ?? BRIDGE_VERSION) || manifest.runtimeVersion !== (runtimeVersion ?? RUNTIME_VERSION)) throw new BridgeError('ManifestMismatch', 'bridge manifest does not match delete request');
  } else validateManifestAgainstOptions(manifest, optionsSnapshot, { phaseId: manifest.phaseId, steps: [{ stepId: '__bridge_placeholder__' }] }, rootPath);
  const snapshot = await storeSnapshot(rootPath, newCounters(), expectedRootIdentity);
  const state = snapshot.state;
  if (state && manifest.planDigest !== state.planDigest) {
    // Lifecycle operations use the same exact-predecessor proof as ordinary
    // transition recovery. Repair a stale manifest only when CURRENT records
    // a consumed adoption token whose expected digest is exactly that
    // manifest; otherwise fail closed before publishing disable/delete.
    if (!stateHasFreshAuthorityAdoption(state, manifest.planDigest)) throw new BridgeError('ManifestMismatch', 'bridge manifest plan digest disagrees with CURRENT');
    const repaired = { ...manifest, planDigest: state.planDigest, phaseId: state.phaseId };
    await saveManifest(rootPath, repaired);
    manifest = repaired;
  }
  if (state && (Object.values(state.steps).some((step) => step.status === 'ACTIVE') || Object.values(state.outbox).some((command) => command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN'))) throw new BridgeError('ActiveWork', 'bridge cannot be disabled or deleted while work is active or unresolved');
  return manifest;
}

/** Disable only at a quiescent boundary. The durable runtime files remain for
 * recovery/audit; a disabled root cannot silently fall back to Markdown. */
export async function disable(options: BridgeOptions): Promise<BridgeMutationResult> {
  if (!options || options.mode !== 'runtime') throw new BridgeError('ModeConflict', 'disable requires explicit runtime mode');
  const runDir = options?.runDir;
  const rootPath = resolvedRoot(runDir);
  return await withBridgeOperationLock(rootPath, async (lockedRootIdentity) => {
    const manifest = await requireQuiescent(runDir, options, false, lockedRootIdentity);
    const next = { ...manifest, status: 'disabled' as const };
    await saveManifest(runDir, next);
    return { manifest: next };
  });
}

function validateTombstoneDeleteRequest(tombstone: BridgeTombstone, options: BridgeOptions, rootPath: string): void {
  if ((options.bridgeVersion !== undefined && options.bridgeVersion !== BRIDGE_VERSION) || (options.runtimeVersion !== undefined && options.runtimeVersion !== RUNTIME_VERSION) || tombstone.sourceDigest !== digest(BRIDGE_SOURCE_ID)) throw new BridgeError('VersionMismatch', 'bridge tombstone does not match installed bridge');
  if (tombstone.rootPath !== rootPath || tombstone.runId !== options.runId || tombstone.bridgeVersion !== (options.bridgeVersion ?? BRIDGE_VERSION) || tombstone.runtimeVersion !== (options.runtimeVersion ?? RUNTIME_VERSION)) throw new BridgeError('ManifestMismatch', 'bridge tombstone does not match delete request');
}

async function cleanupDeletedBridgeMetadata(rootDir: string): Promise<void> {
  const rootPath = resolvedRoot(rootDir);
  const path = manifestPath(rootPath);
  await fs.unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  const kernel = dirname(path);
  const entries = await fs.readdir(kernel, { withFileTypes: true });
  for (const entry of entries) {
    if ((!entry.name.startsWith(BEADS_INPUT_PREFIX) && !entry.name.startsWith(BEADS_REPLAY_PREFIX)) || !entry.name.endsWith('.json')) continue;
    await fs.unlink(join(kernel, entry.name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  await syncDirectory(kernel, 'bridge metadata parent');
}

/** Delete only bridge metadata at a quiescent boundary. CURRENT, generations,
 * journal, declarations, reports, and projections are intentionally retained. */
export async function deleteBridge(options: BridgeOptions): Promise<BridgeMutationResult> {
  if (!options || options.mode !== 'runtime') throw new BridgeError('ModeConflict', 'delete requires explicit runtime mode');
  const runDir = options?.runDir;
  const rootPath = resolvedRoot(runDir);
  return await withBridgeOperationLock(rootPath, async (lockedRootIdentity) => {
    const existingTombstone = await loadTombstone(rootPath);
    if (existingTombstone !== undefined) {
      validateTombstoneDeleteRequest(existingTombstone, options, rootPath);
      await cleanupDeletedBridgeMetadata(rootPath);
      return { manifest: existingTombstone, deleted: true };
    }
    const manifest = await requireQuiescent(runDir, options, true, lockedRootIdentity);
    // Persist the tombstone before unlinking the manifest.  The two directory
    // syncs make a successful delete/restart decision crash-durable.
    await writeRegular(tombstonePath(runDir), canonicalString({ ...manifest, status: 'deleted' }), 'bridge tombstone', undefined, runDir);
    await cleanupDeletedBridgeMetadata(rootPath);
    return { manifest, deleted: true };
  });
}

export const bridgeProjectionMarkers = Object.freeze({ stateOpen: STATE_OPEN, stateClose: STATE_CLOSE, stepsOpen: STEPS_OPEN, stepsClose: STEPS_CLOSE });
