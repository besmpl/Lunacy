import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Private filesystem trust boundary shared by the durable store, bridge, and
 * Beads adapter.  A pathname is not an authority by itself: every existing
 * component is checked for symlinks, unsafe sharing, and (for a protected
 * surface) current-user ownership before it is opened or mutated.
 */

export class FilesystemTrustError extends Error {
  constructor(message: string) {
    super(`FilesystemTrust: ${message}`);
    this.name = 'FilesystemTrustError';
  }
}

export type FilesystemIdentity = Readonly<{ dev: string; ino: string }>;
export type TrustedPath = Readonly<{ path: string; stat: Stats; identity: FilesystemIdentity }>;
export type TrustedPathOptions = Readonly<{
  /** Permit an absent final component.  Existing ancestors are still checked. */
  allowMissing?: boolean;
  /** Require current-user ownership and a non-shared mode on the final component. */
  surface?: boolean;
  /** Require the final component to be a directory or regular file. */
  kind?: 'directory' | 'file';
}>;

function fail(label: string, reason: string): never {
  throw new FilesystemTrustError(`${label} ${reason}`);
}

function isAbsoluteCanonical(path: string): boolean {
  return typeof path === 'string' && path.length > 0 && path[0] === sep && resolve(path) === path && !path.includes('\0');
}

function pathWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function identityOf(stat: Stats): FilesystemIdentity {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

export function filesystemIdentity(stat: Stats): FilesystemIdentity { return identityOf(stat); }

export function sameFilesystemIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function modeIsShared(stat: Stats): boolean { return (stat.mode & 0o022) !== 0; }
function isSticky(stat: Stats): boolean { return (stat.mode & 0o1000) !== 0; }

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function ownedByCurrentUser(stat: Stats): boolean {
  const uid = currentUid();
  return uid === undefined || stat.uid === uid;
}

/**
 * Return the lexical and physical temporary-directory spellings.  macOS may
 * expose `/tmp` through `/private/tmp` (and `/var` through `/private/var`), so
 * those exact host aliases are allowed while arbitrary symlinks remain out of
 * bounds.
 */
async function temporaryAliases(): Promise<Array<{ lexical: string; physical: string }>> {
  const lexicalRoots = [...new Set([resolve(tmpdir()), '/tmp'])];
  const aliases: Array<{ lexical: string; physical: string }> = [];
  for (const lexical of lexicalRoots) {
    let physical = lexical;
    try { physical = resolve(await fs.realpath(lexical)); } catch { /* absent is handled by callers */ }
    aliases.push({ lexical, physical });
  }
  return aliases;
}

async function isAllowedTemporaryAlias(path: string): Promise<boolean> {
  for (const { lexical, physical } of await temporaryAliases()) {
    if (!pathWithin(path, lexical)) continue;
    try {
      const actual = resolve(await fs.realpath(path));
      if (pathWithin(physical, actual) || pathWithin(actual, physical)) return true;
    } catch { /* try the next known alias */ }
  }
  return false;
}

async function isRecognizedStickyTemporaryDirectory(path: string, stat: Stats): Promise<boolean> {
  if (!isSticky(stat) || (stat.mode & 0o002) === 0) return false;
  // Only a known system temporary root receives sticky shared semantics;
  // descendants must be private even when an attacker marks them sticky.
  for (const { lexical, physical } of await temporaryAliases()) {
    if (path !== lexical && path !== physical) continue;
    try { if (resolve(await fs.realpath(path)) === physical) return true; } catch { /* try next */ }
  }
  return false;
}

async function checkComponent(path: string, label: string, final: boolean, surface: boolean): Promise<Stats | undefined> {
  let stat: Stats;
  try { stat = await fs.lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    fail(label, `could not be inspected: ${(error as Error).message}`);
  }
  if (stat!.isSymbolicLink()) {
    const allowedAlias = await isAllowedTemporaryAlias(path);
    if (!allowedAlias) fail(label, 'contains an untrusted symlink');
    // An alias is acceptable only as an ancestor.  A protected target must be
    // a real directory/file rather than a symlink, even for /tmp itself.
    if (final && surface) fail(label, 'is a symlink');
    return stat!;
  }
  // Parent directories need not be owned by this process (for example `/`),
  // but no non-sticky shared parent is a valid authority anchor.  Ownership
  // and the private mode are mandatory on the protected final surface.
  if (surface && !ownedByCurrentUser(stat!)) fail(label, 'is not owned by the current user');
  if (modeIsShared(stat!) && !(await isRecognizedStickyTemporaryDirectory(path, stat!))) fail(label, 'is group/world-writable');
  if (!final && !stat!.isDirectory()) fail(label, 'ancestor is not a directory');
  if (final && surface && modeIsShared(stat!)) fail(label, 'is group/world-writable');
  return stat!;
}

/**
 * Validate every existing component from `/` through `path`.  Missing final
 * segments are allowed only when requested; creation is then performed by
 * `ensurePrivateDirectory` one segment at a time beneath the validated
 * nearest ancestor.
 */
export async function inspectTrustedPath(path: string, label: string, options: TrustedPathOptions = {}): Promise<TrustedPath | undefined> {
  if (!isAbsoluteCanonical(path)) fail(label, 'must be an absolute canonical path');
  const target = resolve(path);
  const segments = target.split(sep).filter(Boolean);
  let current: string = sep;
  let finalStat: Stats | undefined;
  let missing = false;
  for (let index = 0; index < segments.length; index += 1) {
    current = current === sep ? join(current, segments[index]) : join(current, segments[index]);
    if (missing) continue;
    const stat = await checkComponent(current, label, index === segments.length - 1, Boolean(options.surface && index === segments.length - 1));
    if (stat === undefined) {
      missing = true;
      continue;
    }
    if (index === segments.length - 1) finalStat = stat;
  }
  if (missing || finalStat === undefined) {
    if (!options.allowMissing) fail(label, 'does not exist');
    return undefined;
  }
  if (options.kind === 'directory' && !finalStat.isDirectory() && !(finalStat.isSymbolicLink() && !options.surface && await isAllowedTemporaryAlias(target))) fail(label, 'is not a directory');
  if (options.kind === 'file' && (!finalStat.isFile() || finalStat.isSymbolicLink())) fail(label, 'is not a regular file');
  return Object.freeze({ path: target, stat: finalStat, identity: identityOf(finalStat) });
}

export async function trustedIdentity(path: string, label: string, options: TrustedPathOptions = {}): Promise<FilesystemIdentity | undefined> {
  const trusted = await inspectTrustedPath(path, label, options);
  return trusted?.identity;
}

export async function assertStableIdentity(path: string, expected: FilesystemIdentity, label: string, options: TrustedPathOptions = {}): Promise<void> {
  const actual = await trustedIdentity(path, label, options);
  if (!actual || !sameFilesystemIdentity(actual, expected)) fail(label, 'changed identity');
}

/** Ensure a private directory, creating missing segments below a trusted anchor. */
export async function ensurePrivateDirectory(path: string, label: string): Promise<TrustedPath> {
  if (!isAbsoluteCanonical(path)) fail(label, 'must be an absolute canonical path');
  // An existing target is itself a protected surface and must be owned by the
  // current user; only the nearest anchor used for creation may be a
  // root-owned sticky system-temp directory.
  const existing = await inspectTrustedPath(path, label, { allowMissing: true, surface: true, kind: 'directory' });
  if (existing) {
    if (!existing.stat.isDirectory()) fail(label, 'is not a directory');
    return existing;
  }
  const target = resolve(path);
  const missing: string[] = [];
  let probe = target;
  while (true) {
    // The nearest existing anchor may be a root-owned sticky system temp
    // directory; ancestor safety is required, but final-surface ownership is
    // only required on the newly-created private segments below it.
    const stat = await inspectTrustedPath(probe, label, { allowMissing: true, surface: false, kind: 'directory' });
    if (stat) {
      if (!stat.stat.isDirectory() && !stat.stat.isSymbolicLink()) fail(label, 'nearest existing ancestor is not a directory');
      let current = stat.path;
      for (const segment of missing.reverse()) {
        current = join(current, segment);
        let didCreate = true;
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fail(label, `could not be created: ${(error as Error).message}`);
          // Never chmod an object another actor won: chmod follows symlinks
          // and would mutate an attacker-selected target.  The subsequent
          // no-follow trust check is the only authority for an existing race.
          didCreate = false;
        }
        if (didCreate) {
          try { await fs.chmod(current, 0o700); } catch (error) { fail(label, `could not be made private: ${(error as Error).message}`); }
        }
        const created = await inspectTrustedPath(current, label, { surface: true, kind: 'directory' });
        if (!created) fail(label, 'created directory disappeared');
        // A directory name is not crash durable merely because mkdir returned.
        // Synchronize the new directory and every newly-created ancestor up
        // to the already-trusted anchor before publishing any child name.
        await syncDirectoryChain(current, `${label} durability`, stat.path);
      }
      const result = await inspectTrustedPath(target, label, { surface: true, kind: 'directory' });
      if (!result) fail(label, 'could not be created safely');
      return result;
    }
    const parent = dirname(probe);
    if (parent === probe) fail(label, 'has no existing trusted ancestor');
    missing.push(probe.slice(parent.length + 1));
    probe = parent;
  }
}

/**
 * Flush one regular file's data and metadata through a no-follow descriptor.
 * Callers synchronize the containing directory separately after publishing or
 * removing the filename; keeping the two operations explicit makes the crash
 * boundary visible at each protocol publication point.
 */
export async function syncFile(path: string, label: string): Promise<void> {
  let handle: import('node:fs').promises.FileHandle | undefined;
  try {
    handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) fail(label, 'is not a regular file');
    await handle.sync();
  } catch (error) {
    fail(label, `could not be synchronized: ${(error as Error).message}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Flush a directory entry set through a no-follow directory descriptor. */
export async function syncDirectory(path: string, label: string): Promise<void> {
  let handle: import('node:fs').promises.FileHandle | undefined;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
    handle = await fs.open(path, flags);
    const stat = await handle.stat();
    if (!stat.isDirectory()) fail(label, 'is not a directory');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not expose a portable directory-fsync primitive.  The
    // private pathname checks still apply there; POSIX hosts must never hide a
    // failed directory barrier because launch/restart durability depends on it.
    if (process.platform === 'win32' && ['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM', 'ERROR_INVALID_FUNCTION'].includes(String(code))) return;
    fail(label, `could not be synchronized: ${(error as Error).message}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Flush a directory and its newly-created parent chain.  `floor` is the
 * nearest existing trusted anchor used by ensurePrivateDirectory; callers can
 * omit it to flush through the filesystem root when a complete chain is
 * already known to exist.
 */
export async function syncDirectoryChain(path: string, label: string, floor?: string): Promise<void> {
  if (!isAbsoluteCanonical(path)) fail(label, 'must be an absolute canonical path');
  const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'directory' });
  if (!trusted) fail(label, 'does not exist');
  let target = resolve(path);
  // Flush the physical spelling so known host aliases such as macOS `/var`
  // (a symlink to `/private/var`) do not get treated as untrusted directory
  // entries when walking the parent chain.
  try { target = resolve(await fs.realpath(target)); }
  catch (error) { fail(label, `could not resolve physical path: ${(error as Error).message}`); }
  let stop = floor === undefined ? sep : resolve(floor);
  if (floor !== undefined) {
    try { stop = resolve(await fs.realpath(stop)); }
    catch (error) { fail(label, `could not resolve physical floor: ${(error as Error).message}`); }
  }
  if (!isAbsoluteCanonical(stop) || (stop !== sep && !pathWithin(stop, target))) fail(label, 'floor is not an ancestor');
  let current = target;
  while (true) {
    await syncDirectory(current, label);
    if (current === stop || current === sep) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function openTrustedDirectory(path: string, label: string): Promise<{ handle: import('node:fs').promises.FileHandle; identity: FilesystemIdentity }> {
  const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'directory' });
  if (!trusted) fail(label, 'does not exist');
  let handle: import('node:fs').promises.FileHandle;
  try { handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW); }
  catch (error) { fail(label, `could not be opened: ${(error as Error).message}`); }
  const bound = await handle!.stat();
  if (!sameFilesystemIdentity(identityOf(bound), trusted.identity)) {
    await handle!.close().catch(() => undefined);
    fail(label, 'changed before descriptor binding');
  }
  return { handle: handle!, identity: trusted.identity };
}
