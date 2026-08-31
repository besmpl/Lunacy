import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Private storage policy for future immutable evidence copies. */
export type EvidenceCopyPolicy = 'off' | 'prefer' | 'require';
export type EvidenceCopyFallbackReason =
  | 'unsupported-platform'
  | 'unsupported-filesystem'
  | 'cross-volume'
  | 'clone-unavailable'
  | 'clone-failed'
  | 'clone-verification-failed';

export type EvidenceCopyResult = Readonly<{
  method: 'off-full-copy' | 'ineligible-full-copy' | 'reflink' | 'fallback-full-copy';
  bytes: number;
  digest: string;
  fallbackReason?: EvidenceCopyFallbackReason;
}>;

export type EvidenceCopyOptions = Readonly<{
  policy: EvidenceCopyPolicy;
  maximumBytes: number;
  minimumCloneBytes?: number;
  checkBoundary?: () => void;
}>;

export const EVIDENCE_REFLINK_MIN_BYTES = 1024 * 1024;
// Darwin's statfs.f_type value for APFS. Eligibility checks both endpoints;
// the clone syscall remains authoritative and its failure is never hidden.
const DARWIN_APFS_TYPE = 26n;
const SHA256 = /^[0-9a-f]{64}$/;

export class EvidenceCopyError extends Error {
  readonly code: 'INVALID' | 'SOURCE_UNSTABLE' | 'CLONE_REQUIRED';
  readonly fallbackReason?: EvidenceCopyFallbackReason;
  constructor(code: EvidenceCopyError['code'], message: string, fallbackReason?: EvidenceCopyFallbackReason) {
    super(message);
    this.name = 'EvidenceCopyError';
    this.code = code;
    this.fallbackReason = fallbackReason;
  }
}

type StableSource = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>;

const destinationLocks = new Map<string, Promise<void>>();

async function withDestinationLock<T>(destination: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(destination);
  const previous = destinationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveLock) => { release = resolveLock; });
  const queued = previous.then(() => current);
  destinationLocks.set(key, queued);
  await previous;
  try { return await operation(); }
  finally { release(); if (destinationLocks.get(key) === queued) destinationLocks.delete(key); }
}

function invalid(message: string): never { throw new EvidenceCopyError('INVALID', message); }
function sourceUnstable(message: string): never { throw new EvidenceCopyError('SOURCE_UNSTABLE', message); }
function checkOptions(source: string, destination: string, options: EvidenceCopyOptions): void {
  if (!isAbsolute(source) || resolve(source) !== source || source.includes('\0')) invalid('evidence source must be an absolute canonical path');
  if (!isAbsolute(destination) || resolve(destination) !== destination || destination.includes('\0')) invalid('evidence destination must be an absolute canonical path');
  if (source === destination) invalid('evidence source and destination must differ');
  if (!['off', 'prefer', 'require'].includes(options.policy)) invalid('evidence copy policy is invalid');
  if (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 0) invalid('evidence copy byte ceiling is invalid');
  const minimum = options.minimumCloneBytes ?? EVIDENCE_REFLINK_MIN_BYTES;
  if (!Number.isSafeInteger(minimum) || minimum <= 0) invalid('evidence reflink threshold is invalid');
}

function stableSource(stat: BigIntStats): StableSource {
  if (!stat.isFile()) invalid('evidence source is not a regular file');
  if (stat.size < 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) invalid('evidence source size is invalid');
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameStableSource(left: StableSource, right: BigIntStats): boolean {
  return right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function assertSourcePathStable(path: string, expected: StableSource): Promise<void> {
  let stat: BigIntStats;
  try { stat = await fs.lstat(path, { bigint: true }); }
  catch (error) { sourceUnstable(`evidence source disappeared: ${(error as Error).message}`); }
  if (stat!.isSymbolicLink() || !sameStableSource(expected, stat!)) sourceUnstable('evidence source changed during copy');
}

async function assertDestinationAbsent(path: string): Promise<void> {
  try { await fs.lstat(path); invalid('evidence destination already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

async function unlinkIfIdentity(path: string, identity: FileIdentity): Promise<void> {
  try {
    const current = await fs.lstat(path, { bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino) await fs.unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function hashDescriptor(handle: Awaited<ReturnType<typeof fs.open>>, expectedBytes: number, checkBoundary?: () => void): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expectedBytes + 1)));
  let offset = 0;
  while (offset < expectedBytes) {
    checkBoundary?.();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > expectedBytes - offset) sourceUnstable('evidence source changed during digest verification');
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const extra = await handle.read(buffer, 0, 1, offset);
  if (extra.bytesRead !== 0) sourceUnstable('evidence source grew during digest verification');
  return hash.digest('hex');
}

async function writeDescriptor(
  source: Awaited<ReturnType<typeof fs.open>>,
  target: Awaited<ReturnType<typeof fs.open>>,
  expectedBytes: number,
  checkBoundary?: () => void,
): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expectedBytes + 1)));
  let offset = 0;
  while (offset < expectedBytes) {
    checkBoundary?.();
    const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > expectedBytes - offset) sourceUnstable('evidence source changed during full copy');
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await target.write(buffer, written, bytesRead - written, offset + written);
      if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytesRead - written) invalid('evidence destination write made no progress');
      written += result.bytesWritten;
    }
    offset += bytesRead;
  }
  const extra = await source.read(buffer, 0, 1, offset);
  if (extra.bytesRead !== 0) sourceUnstable('evidence source grew during full copy');
  return hash.digest('hex');
}

async function verifyTemporary(
  temporary: string,
  source: StableSource,
  expectedDestinationDev: bigint,
  bytes: number,
  expectedDigest: string,
  checkBoundary?: () => void,
): Promise<{ digest: string; identity: Readonly<{ dev: bigint; ino: bigint }> }> {
  let handle;
  try { handle = await fs.open(temporary, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { invalid(`evidence temporary could not be opened safely: ${(error as Error).message}`); }
  try {
    const stat = await handle!.stat({ bigint: true });
    if (!stat.isFile() || stat.dev !== expectedDestinationDev || (stat.dev === source.dev && stat.ino === source.ino) || stat.size !== BigInt(bytes)) invalid('evidence temporary identity or size is invalid');
    await handle!.chmod(0o500);
    const sealed = await handle!.stat({ bigint: true });
    if (sealed.dev !== stat.dev || sealed.ino !== stat.ino || (sealed.mode & 0o777n) !== 0o500n) invalid('evidence temporary could not be mode-normalized');
    let digest: string;
    try { digest = await hashDescriptor(handle!, bytes, checkBoundary); }
    catch (error) {
      if (error instanceof EvidenceCopyError && error.code === 'SOURCE_UNSTABLE') invalid('evidence temporary changed during digest verification');
      throw error;
    }
    if (!SHA256.test(digest) || digest !== expectedDigest) invalid('evidence temporary digest differs from its source');
    await handle!.sync();
    return { digest, identity: { dev: stat.dev, ino: stat.ino } };
  } finally { await handle!.close(); }
}

async function publishTemporary(temporary: string, destination: string, identity: Readonly<{ dev: bigint; ino: bigint }>): Promise<void> {
  await assertDestinationAbsent(destination);
  const staged = await fs.lstat(temporary, { bigint: true });
  if (!staged.isFile() || staged.dev !== identity.dev || staged.ino !== identity.ino || (staged.mode & 0o777n) !== 0o500n) invalid('evidence temporary changed before publication');
  // rename(2) replaces a destination created after the absence check.  Publish
  // the already-verified inode with link(2) instead: it is atomic, stays on the
  // same filesystem, and fails with EEXIST rather than overwriting a racer.
  try { await fs.link(temporary, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') invalid('evidence destination was created concurrently');
    invalid(`evidence destination could not be published: ${(error as Error).message}`);
  }
  try {
    const published = await fs.lstat(destination, { bigint: true });
    if (!published.isFile() || published.dev !== identity.dev || published.ino !== identity.ino || (published.mode & 0o777n) !== 0o500n) invalid('published evidence identity or mode is invalid');
    await fs.unlink(temporary);
    await syncDirectory(dirname(destination));
  } catch (error) {
    await unlinkIfIdentity(destination, identity).catch(() => undefined);
    if (error instanceof EvidenceCopyError) throw error;
    invalid(`published evidence could not be made durable: ${(error as Error).message}`);
  }
}

async function atomicFullCopy(
  sourcePath: string,
  source: Awaited<ReturnType<typeof fs.open>>,
  sourceIdentity: StableSource,
  destination: string,
  bytes: number,
  checkBoundary?: () => void,
): Promise<{ digest: string }> {
  const temporary = join(dirname(destination), `.${basename(destination)}.copy-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
  const parent = await fs.lstat(dirname(destination), { bigint: true });
  if (parent.isSymbolicLink() || !parent.isDirectory()) invalid('evidence destination parent is not a regular directory');
  let target: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    target = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const digest = await writeDescriptor(source, target, bytes, checkBoundary);
    await target.chmod(0o500);
    await target.sync();
    await target.close(); target = undefined;
    await assertSourcePathStable(sourcePath, sourceIdentity);
    const after = await source.stat({ bigint: true });
    if (!sameStableSource(sourceIdentity, after)) sourceUnstable('evidence source changed during full copy');
    const sourceDigest = await hashDescriptor(source, bytes, checkBoundary);
    if (sourceDigest !== digest) sourceUnstable('evidence source changed during full copy');
    await assertSourcePathStable(sourcePath, sourceIdentity);
    if (!sameStableSource(sourceIdentity, await source.stat({ bigint: true }))) sourceUnstable('evidence source changed during full copy');
    const verified = await verifyTemporary(temporary, sourceIdentity, parent.dev, bytes, sourceDigest, checkBoundary);
    await publishTemporary(temporary, destination, verified.identity);
    return { digest: verified.digest };
  } finally {
    await target?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function cloneEligibility(source: StableSource, sourcePath: string, destination: string): Promise<EvidenceCopyFallbackReason | undefined> {
  if (process.platform !== 'darwin') return 'unsupported-platform';
  const parent = await fs.lstat(dirname(destination), { bigint: true });
  if (parent.isSymbolicLink() || !parent.isDirectory()) invalid('evidence destination parent is not a regular directory');
  if (source.dev !== parent.dev) return 'cross-volume';
  const [sourceFs, destinationFs] = await Promise.all([
    fs.statfs(sourcePath, { bigint: true }),
    fs.statfs(dirname(destination), { bigint: true }),
  ]);
  if (sourceFs.type !== DARWIN_APFS_TYPE || destinationFs.type !== DARWIN_APFS_TYPE) return 'unsupported-filesystem';
  return undefined;
}

function cloneFailureReason(error: unknown): EvidenceCopyFallbackReason {
  if (error instanceof EvidenceCopyError && error.code === 'SOURCE_UNSTABLE') throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return ['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(String(code)) ? 'clone-unavailable' : 'clone-failed';
}

async function atomicClone(
  sourcePath: string,
  source: Awaited<ReturnType<typeof fs.open>>,
  sourceIdentity: StableSource,
  destination: string,
  bytes: number,
  checkBoundary?: () => void,
): Promise<{ digest: string }> {
  const temporary = join(dirname(destination), `.${basename(destination)}.reflink-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
  try {
    const beforeDigest = await hashDescriptor(source, bytes, checkBoundary);
    await assertSourcePathStable(sourcePath, sourceIdentity);
    await fs.copyFile(sourcePath, temporary, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE);
    await assertSourcePathStable(sourcePath, sourceIdentity);
    const after = await source.stat({ bigint: true });
    if (!sameStableSource(sourceIdentity, after)) sourceUnstable('evidence source changed during reflink copy');
    const afterDigest = await hashDescriptor(source, bytes, checkBoundary);
    if (afterDigest !== beforeDigest) sourceUnstable('evidence source changed during reflink copy');
    await assertSourcePathStable(sourcePath, sourceIdentity);
    if (!sameStableSource(sourceIdentity, await source.stat({ bigint: true }))) sourceUnstable('evidence source changed during reflink copy');
    let verified;
    try { verified = await verifyTemporary(temporary, sourceIdentity, sourceIdentity.dev, bytes, beforeDigest, checkBoundary); }
    catch (error) {
      if (error instanceof EvidenceCopyError && error.code === 'SOURCE_UNSTABLE') throw error;
      throw new EvidenceCopyError('INVALID', `evidence reflink verification failed: ${(error as Error).message}`, 'clone-verification-failed');
    }
    await publishTemporary(temporary, destination, verified.identity);
    return { digest: verified.digest };
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}

/**
 * Copy one future immutable evidence file. Only a verified temporary inode is
 * atomically published. `off` deliberately retains the pre-policy direct-copy
 * behavior; `prefer` may fall back only after recording why cloning failed.
 */
export async function copyImmutableEvidenceFile(sourcePath: string, destination: string, options: EvidenceCopyOptions): Promise<EvidenceCopyResult> {
  checkOptions(sourcePath, destination, options);
  return withDestinationLock(destination, async () => {
    options.checkBoundary?.();
    await assertDestinationAbsent(destination);
    let source;
    try { source = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') invalid('evidence source is a symlink');
      invalid(`evidence source could not be opened: ${(error as Error).message}`);
    }
    try {
      const sourceIdentity = stableSource(await source!.stat({ bigint: true }));
      await assertSourcePathStable(sourcePath, sourceIdentity);
      const bytes = Number(sourceIdentity.size);
      if (bytes > options.maximumBytes) invalid('evidence source exceeds its byte ceiling');
      const minimum = options.minimumCloneBytes ?? EVIDENCE_REFLINK_MIN_BYTES;

      if (options.policy === 'off') {
        // This is the original direct final-path copy: exclusive creation,
        // bounded complete writes, file sync, and the existing 0500 seal.
        let target;
        let targetIdentity: FileIdentity | undefined;
        try {
          target = await fs.open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
          const opened = await target.stat({ bigint: true });
          if (!opened.isFile() || (opened.dev === sourceIdentity.dev && opened.ino === sourceIdentity.ino)) invalid('evidence destination identity is invalid');
          targetIdentity = { dev: opened.dev, ino: opened.ino };
          const digest = await writeDescriptor(source!, target, bytes, options.checkBoundary);
          await target.chmod(0o500);
          await target.sync();
          await assertSourcePathStable(sourcePath, sourceIdentity);
          if (!sameStableSource(sourceIdentity, await source!.stat({ bigint: true }))) sourceUnstable('evidence source changed during full copy');
          if (await hashDescriptor(source!, bytes, options.checkBoundary) !== digest) sourceUnstable('evidence source changed during full copy');
          await assertSourcePathStable(sourcePath, sourceIdentity);
          if (!sameStableSource(sourceIdentity, await source!.stat({ bigint: true }))) sourceUnstable('evidence source changed during full copy');
          const sealed = await target.stat({ bigint: true });
          const published = await fs.lstat(destination, { bigint: true });
          if (!published.isFile() || published.dev !== targetIdentity.dev || published.ino !== targetIdentity.ino
            || sealed.dev !== targetIdentity.dev || sealed.ino !== targetIdentity.ino || sealed.size !== BigInt(bytes)
            || (sealed.mode & 0o777n) !== 0o500n || (published.mode & 0o777n) !== 0o500n) invalid('evidence destination changed during off copy');
          return Object.freeze({ method: 'off-full-copy', bytes, digest });
        } catch (error) {
          if (targetIdentity !== undefined) await unlinkIfIdentity(destination, targetIdentity).catch(() => undefined);
          throw error;
        } finally { await target?.close().catch(() => undefined); }
      }

      if (bytes < minimum) {
        const copied = await atomicFullCopy(sourcePath, source!, sourceIdentity, destination, bytes, options.checkBoundary);
        return Object.freeze({ method: 'ineligible-full-copy', bytes, digest: copied.digest });
      }

      let fallbackReason = await cloneEligibility(sourceIdentity, sourcePath, destination);
      if (fallbackReason === undefined) {
        try {
          const cloned = await atomicClone(sourcePath, source!, sourceIdentity, destination, bytes, options.checkBoundary);
          return Object.freeze({ method: 'reflink', bytes, digest: cloned.digest });
        } catch (error) {
          if (error instanceof EvidenceCopyError && error.code !== 'CLONE_REQUIRED' && !error.fallbackReason) throw error;
          fallbackReason = error instanceof EvidenceCopyError && error.fallbackReason
            ? error.fallbackReason
            : cloneFailureReason(error);
        }
      }
      if (options.policy === 'require') throw new EvidenceCopyError('CLONE_REQUIRED', `required evidence reflink failed: ${fallbackReason}`, fallbackReason);
      const copied = await atomicFullCopy(sourcePath, source!, sourceIdentity, destination, bytes, options.checkBoundary);
      return Object.freeze({ method: 'fallback-full-copy', bytes, digest: copied.digest, fallbackReason });
    } finally { await source!.close(); }
  });
}
