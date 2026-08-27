import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalString, digest } from './canonical.js';
import { validatePlan } from './validator.js';
import { assertStableIdentity, filesystemIdentity, inspectTrustedPath, sameFilesystemIdentity, trustedIdentity } from './filesystem.js';
import type { Plan, Sha256 } from './model.js';

/**
 * The Beads integration is intentionally a host-only adapter.  Nothing in
 * the kernel imports this module; a bridge caller supplies an explicitly
 * provisioned executable and chooses when to capture one snapshot.
 */

export const BEADS_VERSION = '1.2.2';
export const BEADS_COMMIT = '6c124203e771433a3550c348771a5b5e27fd3c21';
export const BEADS_BUILD = '6c124203e';
export const BEADS_SCHEMA_VERSION = 1;
export const BEADS_SNAPSHOT_SCHEMA = 'lunacy-beads-snapshot-v1' as const;
export const BEADS_TIMEOUT_MS = 5_000 as const;
export const BEADS_STDOUT_BYTES = 8 * 1024 * 1024;
export const BEADS_STDERR_BYTES = 64 * 1024;
export const BEADS_LINE_BYTES = 128 * 1024;
export const BEADS_RECORD_LIMIT = 4_096 as const;
export const BEADS_TOTAL_EDGE_LIMIT = 16_384 as const;
export const BEADS_ID_BYTES = 128 as const;
export const BEADS_TITLE_BYTES = 512 as const;
export const BEADS_GOAL_BYTES = 16 * 1024;
export const BEADS_DEPENDENCY_LIMIT = 64 as const;
const BEADS_PRIVATE_SNAPSHOT_BYTES = 64 * 1024 * 1024;
// Pathname snapshots run on an untrusted, operator-selected database tree.
// Keep the envelope complete even when entries are empty (and therefore do
// not consume the byte budget): bounded cardinality, depth, pathname bytes,
// and a capture-wide deadline/abort are all enforced before descending.
const BEADS_PRIVATE_ENTRY_LIMIT = 16_384;
const BEADS_PRIVATE_FILE_LIMIT = 12_288;
const BEADS_PRIVATE_DIRECTORY_LIMIT = 4_096;
const BEADS_PRIVATE_DEPTH_LIMIT = 128;
const BEADS_PRIVATE_PATH_BYTES = 64 * 1024;

export type BeadsIssueStatus = 'open' | 'closed';
export type BeadsIssueType = 'task' | 'bug' | 'feature' | 'chore' | 'spike' | 'story';
export type BeadsSnapshotIssue = {
  sourceId: string;
  title: string;
  description: string;
  status: BeadsIssueStatus;
  priority: 0 | 1 | 2 | 3 | 4;
  issueType: BeadsIssueType;
};
export type BeadsSnapshotEdge = { from: string; to: string; type: 'blocks' };
export type BeadsSnapshot = {
  schema: typeof BEADS_SNAPSHOT_SCHEMA;
  source: 'beads';
  workspaceIdentity: Sha256;
  bdVersion: typeof BEADS_VERSION;
  bdBuild: typeof BEADS_BUILD;
  bdCommit: typeof BEADS_COMMIT;
  bdSchemaVersion: typeof BEADS_SCHEMA_VERSION;
  binaryDigest: Sha256;
  issues: BeadsSnapshotIssue[];
  edges: BeadsSnapshotEdge[];
  contentDigest: Sha256;
  capturedAt: string;
};

export type BeadsCapture = {
  snapshot: Readonly<BeadsSnapshot>;
  plan: Readonly<Plan>;
  sourceIds: Readonly<Record<string, string>>;
};

export type BeadsSourceOptions = {
  /** Absolute operator-provisioned bd release binary. */
  executablePath: string;
  /** Absolute workspace selected for this capture. */
  workspace: string;
  /** SHA-256 of executable bytes, supplied by the operator/release manifest. */
  expectedBinaryDigest: string;
  /** Optional isolated HOME. If omitted, the process receives a temporary path. */
  homeDir?: string;
  /** Optional isolated XDG config directory. Defaults beside homeDir. */
  xdgConfigHome?: string;
  /** Phase identity for the generated Lunacy plan (defaults to `beads`). */
  phaseId?: string;
  timeoutMs?: number;
};

export class BeadsUnavailable extends Error {
  readonly code = 'Unavailable' as const;
  constructor(message: string) { super(message); this.name = 'BeadsUnavailable'; }
}

type JsonRecord = Record<string, unknown>;

function fail(message: string): never { throw new BeadsUnavailable(message); }
function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
}
function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8'); }
function boundedText(value: unknown, label: string, ceiling: number): string {
  if (typeof value !== 'string' || value.includes('\0') || hasUnpairedSurrogate(value) || byteLength(value) > ceiling) fail(`${label} is invalid or exceeds ${ceiling} bytes`);
  return value;
}
/** JSON permits escaped UTF-16 surrogate code units, but they are not UTF-8
 * scalar values.  Keep them out of opaque plan text so a malformed producer
 * cannot smuggle non-Unicode data across the snapshot/Plan boundary. */
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function boundedId(value: unknown, label: string): string {
  const result = boundedText(value, label, BEADS_ID_BYTES);
  if (result.length === 0 || result === '.' || result === '..') fail(`${label} is invalid`);
  return result;
}
/** Locale-independent ordering for digest-relevant identifiers.  UTF-8 byte
 * order is stable across hosts and does not depend on process locale. */
function compareStable(a: string, b: string): number { return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
function exactKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} contains unsupported or missing fields`);
}
function allowedKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) fail(`${label} contains unsupported fields`);
}
function nonNegativeInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} is invalid`);
  return value as number;
}
function timestamp(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.includes('\0') || hasUnpairedSurrogate(value) || byteLength(value) > 256) fail(`${label} is invalid`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (!match) fail(`${label} is invalid`);
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (month < 1 || month > 12 || day < 1 || day > (daysInMonth ?? 0) || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(value))) fail(`${label} is invalid`);
}
function freeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return value;
}

/** Reject duplicate object keys before JSON.parse erases their distinction. */
function rejectDuplicateKeys(text: string): void {
  let index = 0;
  let depth = 0;
  const maxDepth = 256;
  const skipSpace = () => { while (index < text.length && /\s/.test(text[index]!)) index += 1; };
  const parseString = (): string => {
    const start = index;
    if (text[index] !== '"') fail('JSON contains an invalid string');
    index += 1;
    while (index < text.length) {
      const char = text[index]!;
      if (char === '\\') { index += 2; continue; }
      index += 1;
      if (char === '"') {
        try { return JSON.parse(text.slice(start, index)) as string; } catch { fail('JSON contains an invalid string'); }
      }
      if (char < ' ') fail('JSON contains a control character');
    }
    fail('JSON contains an unterminated string');
  };
  const value = (): void => {
    skipSpace();
    if (depth > maxDepth) fail('JSON nesting exceeds the supported bound');
    const char = text[index];
    if (char === '"') { parseString(); return; }
    if (char === '{') {
      depth += 1; index += 1; skipSpace(); const keys = new Set<string>();
      if (text[index] === '}') { index += 1; depth -= 1; return; }
      while (true) {
        skipSpace(); const key = parseString();
        if (keys.has(key)) fail(`duplicate JSON field ${key}`);
        keys.add(key); skipSpace(); if (text[index] !== ':') fail('JSON object is missing a colon');
        index += 1; value(); skipSpace();
        if (text[index] === '}') { index += 1; depth -= 1; return; }
        if (text[index] !== ',') fail('JSON object is missing a comma');
        index += 1;
      }
    }
    if (char === '[') {
      depth += 1; index += 1; skipSpace();
      if (text[index] === ']') { index += 1; depth -= 1; return; }
      while (true) {
        value(); skipSpace();
        if (text[index] === ']') { index += 1; depth -= 1; return; }
        if (text[index] !== ',') fail('JSON array is missing a comma');
        index += 1;
      }
    }
    const rest = text.slice(index);
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(rest);
    if (!match) fail('JSON contains an invalid value');
    index += match[0].length;
  };
  value(); skipSpace(); if (index !== text.length) fail('JSON contains trailing data');
}

function parseJson(text: string, label: string): unknown {
  try { rejectDuplicateKeys(text); return JSON.parse(text); }
  catch (error) { if (error instanceof BeadsUnavailable) throw error; fail(`${label} is not valid JSON`); }
}

async function statRegular(path: string, label: string, executable = false): Promise<import('node:fs').Stats> {
  try {
    const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
    if (!trusted) fail(`${label} is unavailable`);
    if (executable && (trusted.stat.mode & 0o111) === 0) fail(`${label} is not executable`);
    return trusted.stat;
  } catch (error) { fail(`${label} is unavailable: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
}
async function assertDirectory(path: string, label: string): Promise<void> {
  try {
    const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'directory' });
    if (!trusted) fail(`${label} is unavailable`);
  } catch (error) { fail(`${label} is unavailable: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
}
async function assertNoSymlinkSegments(path: string, label: string): Promise<void> {
  try { await inspectTrustedPath(path, label, { allowMissing: true, surface: true }); }
  catch (error) { fail(`${label} is unavailable: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
}
function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

/** Physicalize an existing or missing path through its nearest existing
 * ancestor.  This keeps missing protected roots in the same pathname domain
 * as workspaceReal/beadsDirReal (notably `/var` versus `/private/var` on
 * Darwin) before overlap checks. */
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
      missing.push(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
}

async function privateDirectory(path: string, label: string): Promise<string> {
  try {
    const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'directory' });
    if (!trusted || (trusted.stat.mode & 0o077) !== 0) fail(`${label} must be an existing private directory`);
    return fs.realpath(path).catch((error) => fail(`${label} cannot be canonicalized: ${(error as Error).message}`));
  } catch (error) { fail(`${label} is unavailable: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
}

type VerifiedExecutable = {
  /** A descriptor-bound path used by child processes (fd 3 is inherited). */
  execPath: string;
  fd: number;
  digest: Sha256;
  cleanup: () => Promise<void>;
};

/** A path which resolves to an already-open descriptor in the child.  The
 * descriptor is deliberately the authority for the capture workspace: a
 * pathname swap (even one which is restored before the child exits) cannot
 * make bd read a different directory. */
function descriptorPath(fd: number): string {
  return process.platform === 'linux' ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`;
}

// Node's spawn stdio mapping names inherited descriptors by their child slot,
// not by the parent's FileHandle.fd. Keep these slots fixed so a caller that
// has consumed descriptors 4/5 still gets the exact bound workspace/database.
const CHILD_EXECUTABLE_FD = 3;
const CHILD_WORKSPACE_FD = 4;
const CHILD_BEADS_FD = 5;

/** Read one private database file through a bounded descriptor.  The
 * pre-read stat rejects sparse/oversized files, while the fixed-size loop
 * keeps a concurrent growth race from turning a small initial stat into an
 * unbounded readFile allocation. */
async function readBoundedPrivateFile(path: string, limit: number, label: string, consume: (chunk: Buffer) => Promise<void>): Promise<number> {
  let handle;
  try { handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail(label + ' is a symlink'); fail(label + ' could not be opened: ' + (error as Error).message); }
  try {
    const stat = await handle!.stat();
    if (!stat.isFile()) fail(label + ' is not a regular file');
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limit) fail(label + ' exceeds the 64 MiB private snapshot bound');
    const expected = stat.size;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected + 1)));
    let total = 0;
    while (true) {
      const { bytesRead } = await handle!.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      if (bytesRead > expected - total || bytesRead > limit - total) fail(label + ' changed during bounded read');
      await consume(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total !== expected) fail(label + ' changed during bounded read');
    return total;
  } finally { await handle!.close().catch(() => undefined); }
}

type PrivateSnapshotBoundary = { signal?: AbortSignal; deadline: number };
type PrivateSnapshotBudget = PrivateSnapshotBoundary & {
  entries: number;
  files: number;
  directories: number;
  pathBytes: number;
  bytes: number;
};
type PrivateTreeItem = {
  source: string;
  destination?: string;
  relativePath: string;
  depth: number;
  exit?: boolean;
};
type PrivateTreeEntry = PrivateTreeItem & { name: string };

function checkPrivateSnapshotBoundary(boundary: PrivateSnapshotBoundary): void {
  if (boundary.signal?.aborted) fail('Beads private snapshot was aborted');
  if (Date.now() > boundary.deadline) fail('Beads private snapshot exceeded its construction deadline');
}
function makePrivateSnapshotBudget(boundary: PrivateSnapshotBoundary): PrivateSnapshotBudget {
  checkPrivateSnapshotBoundary(boundary);
  return { ...boundary, entries: 0, files: 0, directories: 0, pathBytes: 0, bytes: 0 };
}
function recordPrivateEntry(budget: PrivateSnapshotBudget, relativePath: string, depth: number): void {
  checkPrivateSnapshotBoundary(budget);
  const pathBytes = byteLength(relativePath.length === 0 ? '.' : relativePath);
  if (pathBytes > BEADS_PRIVATE_PATH_BYTES || budget.pathBytes + pathBytes > BEADS_PRIVATE_PATH_BYTES) fail('Beads private snapshot path bytes exceed the supported bound');
  if (depth > BEADS_PRIVATE_DEPTH_LIMIT) fail('Beads private snapshot depth exceeds the supported bound');
  budget.pathBytes += pathBytes;
  budget.entries += 1;
  if (budget.entries > BEADS_PRIVATE_ENTRY_LIMIT) fail('Beads private snapshot entry count exceeds the supported bound');
}
function recordPrivateKind(budget: PrivateSnapshotBudget, stat: import('node:fs').Stats): void {
  checkPrivateSnapshotBoundary(budget);
  if (stat.isDirectory()) {
    budget.directories += 1;
    if (budget.directories > BEADS_PRIVATE_DIRECTORY_LIMIT) fail('Beads private snapshot directory count exceeds the supported bound');
  } else if (stat.isFile()) {
    budget.files += 1;
    if (budget.files > BEADS_PRIVATE_FILE_LIMIT) fail('Beads private snapshot file count exceeds the supported bound');
  } else fail('Beads private snapshot contains a non-regular entry');
}
function privateChildPath(relativePath: string, name: string): string {
  return relativePath.length === 0 ? name : join(relativePath, name);
}

/** Consume a directory incrementally so a hostile directory cannot first
 * allocate an unbounded readdir array. Entries are bounded before sorting. */
async function readPrivateEntries(source: string, relativePath: string, depth: number, budget: PrivateSnapshotBudget): Promise<PrivateTreeEntry[]> {
  checkPrivateSnapshotBoundary(budget);
  let directory;
  try { directory = await fs.opendir(source); }
  catch (error) { fail('Beads private snapshot directory could not be opened: ' + (error as Error).message); }
  const entries: PrivateTreeEntry[] = [];
  try {
    for await (const entry of directory!) {
      checkPrivateSnapshotBoundary(budget);
      const childRelativePath = privateChildPath(relativePath, entry.name);
      recordPrivateEntry(budget, childRelativePath, depth + 1);
      entries.push({ source: join(source, entry.name), relativePath: childRelativePath, depth: depth + 1, name: entry.name });
      if (entries.length > BEADS_PRIVATE_ENTRY_LIMIT) fail('Beads private snapshot directory entry count exceeds the supported bound');
    }
  } finally { await directory!.close().catch(() => undefined); }
  return entries;
}

async function copyPrivateBeadsTree(sourceRoot: string, destinationRoot: string, boundary: PrivateSnapshotBoundary): Promise<void> {
  const budget = makePrivateSnapshotBudget(boundary);
  const rootDestination = join(destinationRoot, '.beads');
  const stack: PrivateTreeItem[] = [{ source: sourceRoot, destination: rootDestination, relativePath: '', depth: 0 }];
  recordPrivateEntry(budget, '', 0);
  while (stack.length > 0) {
    checkPrivateSnapshotBoundary(budget);
    const item = stack.pop()!;
    let stat: import('node:fs').Stats;
    try { stat = await fs.lstat(item.source); } catch (error) { fail('Beads private snapshot could not be inspected: ' + (error as Error).message); }
    if (stat!.isSymbolicLink()) fail('Beads private snapshot rejects symlinked database entries');
    if (item.exit) {
      await fs.chmod(item.destination!, 0o500).catch((error) => fail('Beads private snapshot directory could not be sealed: ' + (error as Error).message));
      continue;
    }
    recordPrivateKind(budget, stat!);
    if (stat!.isDirectory()) {
      await fs.mkdir(item.destination!, { recursive: false, mode: 0o700 }).catch((error) => fail('Beads private snapshot directory could not be created: ' + (error as Error).message));
      const entries = (await readPrivateEntries(item.source, item.relativePath, item.depth, budget)).sort((a, b) => compareStable(a.name, b.name));
      stack.push({ ...item, exit: true });
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        stack.push({ source: entry.source, destination: join(item.destination!, entry.name), relativePath: entry.relativePath, depth: entry.depth });
      }
      continue;
    }
    const remaining = BEADS_PRIVATE_SNAPSHOT_BYTES - budget.bytes;
    if (remaining < 0) fail('Beads private snapshot exceeds its byte bound');
    let target;
    try { target = await fs.open(item.destination!, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); }
    catch (error) { fail('Beads private snapshot file could not be created: ' + (error as Error).message); }
    try {
      await readBoundedPrivateFile(item.source, remaining, 'Beads private snapshot file', async (chunk) => {
        checkPrivateSnapshotBoundary(budget);
        budget.bytes += chunk.byteLength;
        if (budget.bytes > BEADS_PRIVATE_SNAPSHOT_BYTES) fail('Beads private snapshot exceeds its byte bound');
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await target!.write(chunk, offset, chunk.byteLength - offset, null);
          if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > chunk.byteLength - offset) fail('Beads private snapshot write made no progress');
          offset += result.bytesWritten;
        }
      });
      await target!.sync();
    } catch (error) {
      await target!.close().catch(() => undefined);
      throw error;
    }
    await target!.close();
    await fs.chmod(item.destination!, 0o500);
  }
  await fs.chmod(destinationRoot, 0o500);
}

async function hashPrivateBeadsTree(sourceRoot: string, boundary: PrivateSnapshotBoundary): Promise<Sha256> {
  const budget = makePrivateSnapshotBudget(boundary);
  const hash = createHash('sha256');
  const stack: PrivateTreeItem[] = [{ source: sourceRoot, relativePath: '', depth: 0 }];
  recordPrivateEntry(budget, '', 0);
  while (stack.length > 0) {
    checkPrivateSnapshotBoundary(budget);
    const item = stack.pop()!;
    let stat: import('node:fs').Stats;
    try { stat = await fs.lstat(item.source); } catch (error) { fail('Beads private snapshot could not be inspected: ' + (error as Error).message); }
    if (stat!.isSymbolicLink()) fail('Beads private snapshot rejects symlinked database entries');
    recordPrivateKind(budget, stat!);
    const name = item.relativePath.length === 0 ? '.' : item.relativePath;
    if (stat!.isDirectory()) {
      hash.update('D\0' + name + '\0');
      const entries = (await readPrivateEntries(item.source, item.relativePath, item.depth, budget)).sort((a, b) => compareStable(a.name, b.name));
      for (let index = entries.length - 1; index >= 0; index -= 1) stack.push(entries[index]!);
      continue;
    }
    const remaining = BEADS_PRIVATE_SNAPSHOT_BYTES - budget.bytes;
    if (remaining < 0) fail('Beads private snapshot exceeds its byte bound');
    hash.update('F\0' + name + '\0' + String(stat!.size) + '\0');
    const bytes = await readBoundedPrivateFile(item.source, remaining, 'Beads private snapshot file', async (chunk) => {
      checkPrivateSnapshotBoundary(budget);
      budget.bytes += chunk.byteLength;
      if (budget.bytes > BEADS_PRIVATE_SNAPSHOT_BYTES) fail('Beads private snapshot exceeds its byte bound');
      hash.update(chunk);
    });
    if (bytes !== stat!.size || budget.bytes > BEADS_PRIVATE_SNAPSHOT_BYTES) fail('Beads private snapshot changed during bounded hash');
  }
  return hash.digest('hex') as Sha256;
}

/**
 * The pathname snapshot is sealed read-only while bd runs.  A recursive rm
 * cannot remove entries from those 0500 directories, so unwind the seal before
 * cleanup.  This helper only traverses the adapter-created snapshot tree and
 * never follows a symlink; the tree is already bounded by the snapshot budget.
 */
async function removePrivateSnapshot(root: string): Promise<void> {
  const loosen = async (path: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(path, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; return; }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await loosen(child);
      else if (!entry.isSymbolicLink()) await fs.chmod(child, 0o600).catch(() => undefined);
    }
    await fs.chmod(path, 0o700).catch(() => undefined);
  };
  await loosen(root);
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}

async function hashExecutableDescriptor(handle: Awaited<ReturnType<typeof fs.open>>, label: string): Promise<Sha256> {
  let stat;
  try { stat = await handle.stat(); } catch (error) { fail(label + ' could not be inspected: ' + (error as Error).message); }
  if (!stat!.isFile() || !Number.isSafeInteger(stat!.size) || stat!.size < 0) fail(label + ' is not a regular file');
  const expected = stat!.size;
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    if (bytesRead > expected - total) fail(label + ' changed during digest verification');
    hash.update(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total !== expected) fail(label + ' changed during digest verification');
  return hash.digest('hex') as Sha256;
}

async function writeAll(handle: Awaited<ReturnType<typeof fs.open>>, bytes: Buffer, label: string): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) fail(label + ' write made no progress');
    offset += result.bytesWritten;
  }
}

async function copyVerifiedExecutable(path: string, expectedDigest: string): Promise<VerifiedExecutable> {
  let source;
  try { source = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('bd executablePath is a symlink'); fail('bd executable is unavailable: ' + (error as Error).message); }
  const sourceStat = await source!.stat().catch((error) => fail('bd executable could not be inspected: ' + (error as Error).message));
  if (!sourceStat!.isFile() || (sourceStat!.mode & 0o111) === 0) { await source!.close().catch(() => undefined); fail('bd executable must be an executable regular file'); }
  try {
    const trusted = await inspectTrustedPath(path, 'bd executable', { surface: true, kind: 'file' });
    if (!trusted || !sameFilesystemIdentity(filesystemIdentity(sourceStat!), trusted.identity)) fail('bd executable changed before descriptor binding');
  } catch (error) { await source!.close().catch(() => undefined); throw error; }
  const privateRoot = await fs.mkdtemp(join(tmpdir(), 'lunacy-bd-capture-')).catch((error) => fail('private bd directory could not be created: ' + (error as Error).message));
  try { await assertNoSymlinkSegments(privateRoot, 'private bd directory'); }
  catch (error) { await source!.close().catch(() => undefined); await fs.rm(privateRoot, { recursive: true, force: true }); throw error; }
  const privatePath = join(privateRoot, 'bd');
  let target: Awaited<ReturnType<typeof fs.open>> | undefined;
  let executable: Awaited<ReturnType<typeof fs.open>> | undefined;
  let immutable = false;
  try { target = await fs.open(privatePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o700); }
  catch (error) { await source!.close().catch(() => undefined); await fs.rm(privateRoot, { recursive: true, force: true }); fail('private bd copy could not be created: ' + (error as Error).message); }
  const sourceHash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const { bytesRead } = await source!.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const bytes = buffer.subarray(0, bytesRead);
      sourceHash.update(bytes);
      await writeAll(target!, bytes, 'bd executable');
    }
    await source!.close();
    const copiedDigest = sourceHash.digest('hex') as Sha256;
    if (copiedDigest !== expectedDigest) fail('bd executable digest does not match the operator-provided digest');
    // Remove owner write access before any descriptor/path is used as an
    // execution authority, then force all subsequent digest/probe work to
    // refer to the exact completed inode.
    await target!.chmod(0o500);
    await target!.sync();
    if (process.platform === 'darwin') {
      immutable = await setImmutable(privatePath, true);
      if (!immutable) fail('private bd copy could not be made immutable');
    }
    if (process.platform === 'linux') {
      // /proc/self/fd/N is itself a kernel-provided descriptor alias; O_NOFOLLOW
      // would reject that alias before it can be duplicated read-only.
      executable = await fs.open(descriptorPath(target!.fd), fsConstants.O_RDONLY);
    } else {
      executable = await fs.open(privatePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    }
    const targetDigest = await hashExecutableDescriptor(executable!, 'copied bd executable');
    if (targetDigest !== copiedDigest || targetDigest !== expectedDigest) fail('copied bd executable digest does not match the executed image');
    if (process.platform === 'linux') {
      await fs.unlink(privatePath).catch((error) => fail('private bd copy could not be detached from its pathname: ' + (error as Error).message));
    }
    await target!.close();
    target = undefined;
    return {
      execPath: process.platform === 'linux' ? descriptorPath(CHILD_EXECUTABLE_FD) : privatePath,
      fd: executable!.fd,
      digest: targetDigest,
      cleanup: async () => {
        if (immutable) await setImmutable(privatePath, false);
        await executable!.close().catch(() => undefined);
        await target?.close().catch(() => undefined);
        await fs.rm(privateRoot, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await target?.close().catch(() => undefined);
    await executable?.close().catch(() => undefined);
    await source!.close().catch(() => undefined);
    if (immutable) await setImmutable(privatePath, false);
    await fs.rm(privateRoot, { recursive: true, force: true });
    if (error instanceof BeadsUnavailable) throw error;
    fail('bd executable could not be copied: ' + (error as Error).message);
  }
}

async function setImmutable(path: string, enabled: boolean): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  return await new Promise<boolean>((resolveResult) => {
    const child = spawn('/usr/bin/chflags', [enabled ? 'uchg' : 'nouchg', path], { shell: false, stdio: 'ignore' });
    child.on('error', () => resolveResult(false));
    child.on('close', (code) => resolveResult(code === 0));
  });
}

type ProcessResult = { stdout: Buffer; stderr: Buffer; code: number | null; signal: NodeJS.Signals | null };
type CaptureDescriptors = { executableFd?: number; workspaceFd: number; beadsFd: number };
async function runBd(path: string, cwd: string, env: NodeJS.ProcessEnv, args: string[], timeoutMs: number, signal?: AbortSignal, descriptors?: CaptureDescriptors): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolveResult, rejectResult) => {
    // A released bd may launch an embedded Dolt child. Detached process-group
    // ownership lets timeout/abort terminate that whole tree rather than
    // leaving descendants holding stdout pipes open after bd is killed.
    const stdio: import('node:child_process').StdioOptions = ['ignore', 'pipe', 'pipe'];
    if (descriptors !== undefined) {
      // A macOS private executable remains pathname-bound under its `uchg`
      // flag.  Do not pass the O_WRONLY construction descriptor to the child:
      // an executable that can reach fd 3 could rewrite the very inode whose
      // pathname is being used for both probes.  Linux supplies a detached
      // read-only fd; macOS deliberately supplies an ignored slot instead.
      stdio[3] = descriptors.executableFd ?? 'ignore';
      stdio[4] = descriptors.workspaceFd;
      stdio[5] = descriptors.beadsFd;
    }
    const child = spawn(path, args, { cwd, env, shell: false, detached: true, windowsHide: true, stdio });
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let settled = false; let timer: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const killTree = () => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group may already be gone */ } }
      try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      abortHandler = undefined;
    };
    const failOnce = (error: unknown) => { if (settled) return; settled = true; cleanup(); rejectResult(error); };
    const finish = (code: number | null, childSignal: NodeJS.Signals | null) => { if (settled) return; settled = true; cleanup(); resolveResult({ stdout, stderr, code, signal: childSignal }); };
    child.on('error', (error) => failOnce(new BeadsUnavailable(`bd process failed: ${error.message}`)));
    child.stdout!.on('data', (chunk: Buffer) => { if (stdout.length + chunk.length > BEADS_STDOUT_BYTES) { killTree(); failOnce(new BeadsUnavailable('bd stdout exceeds 8 MiB')); return; } stdout = Buffer.concat([stdout, chunk]); });
    child.stderr!.on('data', (chunk: Buffer) => { if (stderr.length + chunk.length > BEADS_STDERR_BYTES) { killTree(); failOnce(new BeadsUnavailable('bd stderr exceeds 64 KiB')); return; } stderr = Buffer.concat([stderr, chunk]); });
    child.on('close', finish);
    timer = setTimeout(() => { killTree(); failOnce(new BeadsUnavailable('bd command timed out after 5 seconds')); }, timeoutMs);
    if (signal) {
      if (signal.aborted) { killTree(); failOnce(new BeadsUnavailable('bd capture was aborted')); }
      else {
        abortHandler = () => { killTree(); failOnce(new BeadsUnavailable('bd capture was aborted')); };
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    }
  });
}

function decodeUtf8(bytes: Buffer, label: string): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail(`${label} is not valid UTF-8`); }
  if (text.charCodeAt(0) === 0xfeff) fail(`${label} contains a leading UTF-8 BOM`);
  if (text.includes('\0')) fail(`${label} contains NUL`);
  return text;
}

function validateVersion(stdout: string): void {
  const value = parseJson(stdout.trim(), 'bd version output');
  if (!isRecord(value)) fail('bd version output must be an object');
  exactKeys(value, ['build', 'commit', 'schema_version', 'version'], 'bd version output');
  if (value.version !== BEADS_VERSION || value.build !== BEADS_BUILD || value.commit !== BEADS_COMMIT || value.schema_version !== BEADS_SCHEMA_VERSION) fail('bd version does not match pinned v1.2.2 release');
}

const ISSUE_KEYS = ['_type', 'id', 'title', 'description', 'status', 'priority', 'issue_type', 'created_at', 'updated_at', 'created_by', 'dependency_count', 'dependent_count', 'comment_count', 'dependencies', 'labels', 'comments'] as const;
const DEPENDENCY_KEYS = ['issue_id', 'depends_on_id', 'type', 'created_at', 'created_by', 'metadata'] as const;

function parseIssue(value: unknown): { issue: BeadsSnapshotIssue; dependencies: BeadsSnapshotEdge[] } {
  if (!isRecord(value)) fail('export line must be an object');
  allowedKeys(value, ISSUE_KEYS, 'issue');
  if (value._type !== 'issue') fail('export contains a non-issue record');
  const sourceId = boundedId(value.id, 'issue id');
  const title = boundedText(value.title, 'issue title', BEADS_TITLE_BYTES);
  if (title.length === 0) fail('issue title is empty');
  const description = value.description === undefined ? '' : boundedText(value.description, 'issue description', BEADS_GOAL_BYTES);
  const status = value.status;
  if (status !== 'open' && status !== 'closed') fail(`unsupported issue status ${String(status)}`);
  const priority = nonNegativeInt(value.priority, 'issue priority');
  if (priority > 4) fail('issue priority is outside 0..4');
  const issueType = value.issue_type;
  if (!['task', 'bug', 'feature', 'chore', 'spike', 'story'].includes(String(issueType))) fail(`unsupported issue type ${String(issueType)}`);
  for (const field of ['created_at', 'updated_at']) timestamp(value[field], `issue ${field}`);
  if (value.created_by !== undefined) boundedText(value.created_by, 'issue created_by', BEADS_ID_BYTES);
  for (const field of ['dependency_count', 'dependent_count', 'comment_count']) if (value[field] !== undefined) nonNegativeInt(value[field], `issue ${field}`);
  if (value.labels !== undefined && (!Array.isArray(value.labels) || value.labels.length !== 0)) fail('non-empty issue labels are unsupported');
  if (value.comments !== undefined && (!Array.isArray(value.comments) || value.comments.length !== 0)) fail('non-empty issue comments are unsupported');
  const dependencies: BeadsSnapshotEdge[] = [];
  if (value.dependencies !== undefined) {
    if (!Array.isArray(value.dependencies) || value.dependencies.length > BEADS_DEPENDENCY_LIMIT) fail(`issue ${sourceId} has too many dependencies`);
    for (const raw of value.dependencies) {
      if (!isRecord(raw)) fail(`dependency for ${sourceId} is invalid`);
      allowedKeys(raw, DEPENDENCY_KEYS, 'dependency');
      const issueId = boundedId(raw.issue_id, 'dependency issue_id');
      const dependsOnId = boundedId(raw.depends_on_id, 'dependency depends_on_id');
      if (issueId !== sourceId) fail(`dependency issue_id does not match ${sourceId}`);
      if (raw.type !== 'blocks') fail(`unsupported dependency type ${String(raw.type)}`);
      timestamp(raw.created_at, 'dependency created_at');
      if (raw.created_by !== undefined) boundedText(raw.created_by, 'dependency created_by', BEADS_ID_BYTES);
      if (raw.metadata !== undefined && raw.metadata !== '{}') fail('non-empty dependency metadata is unsupported');
      dependencies.push({ from: sourceId, to: dependsOnId, type: 'blocks' });
    }
  }
  return { issue: { sourceId, title, description, status, priority: priority as 0 | 1 | 2 | 3 | 4, issueType: issueType as BeadsIssueType }, dependencies };
}

function parseExport(stdout: string): { issues: BeadsSnapshotIssue[]; edges: BeadsSnapshotEdge[] } {
  let bytes = 0; let records = 0; const issues: BeadsSnapshotIssue[] = []; const edges: BeadsSnapshotEdge[] = [];
  if (stdout.includes('\0')) fail('bd export contains NUL');
  const lines = stdout.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) fail('bd export is empty');
  for (const line of lines) {
    bytes += byteLength(line) + 1; if (byteLength(line) > BEADS_LINE_BYTES) fail('bd export line exceeds 128 KiB');
    if (line.trim().length === 0) fail('bd export contains a blank line');
    records += 1; if (records > BEADS_RECORD_LIMIT) fail('bd export contains too many records');
    const parsed = parseJson(line, 'bd export line');
    const result = parseIssue(parsed); issues.push(result.issue); edges.push(...result.dependencies);
    if (edges.length > BEADS_TOTAL_EDGE_LIMIT) fail('bd export contains too many edges');
  }
  if (bytes > BEADS_STDOUT_BYTES) fail('bd export exceeds 8 MiB');
  const ids = new Set<string>(); for (const issue of issues) { if (ids.has(issue.sourceId)) fail(`duplicate issue id ${issue.sourceId}`); ids.add(issue.sourceId); }
  const edgeKeys = new Set<string>();
  for (const edge of edges) { if (edge.from === edge.to) fail(`self dependency ${edge.from}`); const key = `${edge.from}\0${edge.to}\0${edge.type}`; if (edgeKeys.has(key)) fail('duplicate dependency edge'); edgeKeys.add(key); if (!ids.has(edge.to)) fail(`dependency endpoint ${edge.to} is missing`); }
  return { issues, edges };
}

function makePlan(issues: readonly BeadsSnapshotIssue[], edges: readonly BeadsSnapshotEdge[], phaseId: string, authorityDigest?: Sha256): { plan: Plan; sourceIds: Record<string, string> } {
  const closed = new Set(issues.filter((issue) => issue.status === 'closed').map((issue) => issue.sourceId));
  const open = issues.filter((issue) => issue.status === 'open').sort((a, b) => a.priority - b.priority || compareStable(a.sourceId, b.sourceId));
  if (open.length === 0) fail('bd export contains no executable open issues');
  const steps = open.map((issue) => ({ stepId: issue.sourceId, goal: issue.description ? `${issue.title}\n\n${issue.description}` : issue.title, dependencies: edges.filter((edge) => edge.from === issue.sourceId && !closed.has(edge.to)).map((edge) => edge.to).sort() }));
  for (const step of steps) if (byteLength(step.goal ?? '') > BEADS_GOAL_BYTES) fail(`goal for ${step.stepId} exceeds 16 KiB`);
  let normalized: Plan;
  try { normalized = validatePlan({ schema: 'lunacy-plan-v1', phaseId, steps, ...(authorityDigest === undefined ? {} : { authorityDigest }) }).plan; }
  catch (error) { fail(`Beads plan is invalid: ${(error as Error).message}`); }
  const sourceIds: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const step of normalized.steps) sourceIds[step.stepId] = step.stepId;
  return { plan: normalized, sourceIds };
}

function contentSnapshot(value: Omit<BeadsSnapshot, 'contentDigest' | 'capturedAt'>): Omit<BeadsSnapshot, 'contentDigest' | 'capturedAt'> {
  return { ...value, issues: value.issues.map((issue) => ({ ...issue })), edges: value.edges.map((edge) => ({ ...edge })) };
}

export class BeadsPlanSource {
  readonly options!: Readonly<BeadsSourceOptions>;
  constructor(options: BeadsSourceOptions) {
    if (!options || typeof options !== 'object') fail('Beads source options are required');
    if (typeof options.executablePath !== 'string' || !isAbsolute(options.executablePath) || resolve(options.executablePath) !== options.executablePath || options.executablePath.split(sep).some((part) => part === '.' || part === '..')) fail('bd executablePath must be an absolute canonical path');
    if (typeof options.workspace !== 'string' || !isAbsolute(options.workspace) || resolve(options.workspace) !== options.workspace || options.workspace.split(sep).some((part) => part === '.' || part === '..')) fail('Beads workspace must be an absolute canonical path');
    if (typeof options.expectedBinaryDigest !== 'string' || !/^[0-9a-f]{64}$/.test(options.expectedBinaryDigest)) fail('expectedBinaryDigest must be a SHA-256 hex digest');
    for (const [label, value] of [['homeDir', options.homeDir], ['xdgConfigHome', options.xdgConfigHome] ] as const) {
      if (value !== undefined && (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.split(sep).some((part) => part === '.' || part === '..'))) fail(`Beads ${label} must be an absolute canonical path`);
    }
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > BEADS_TIMEOUT_MS)) fail('timeoutMs must be between 1 and 5000');
    if (options.phaseId !== undefined) { const phaseId = boundedId(options.phaseId, 'Beads phaseId'); if (phaseId.includes('/') || phaseId.includes('\\')) fail('Beads phaseId is unsafe'); }
    const frozenOptions = Object.freeze({
      executablePath: options.executablePath,
      workspace: options.workspace,
      expectedBinaryDigest: options.expectedBinaryDigest,
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      ...(options.xdgConfigHome === undefined ? {} : { xdgConfigHome: options.xdgConfigHome }),
      ...(options.phaseId === undefined ? {} : { phaseId: options.phaseId }),
      timeoutMs: options.timeoutMs ?? BEADS_TIMEOUT_MS,
    });
    // Keep the configuration binding immutable at runtime.  The capture
    // method itself remains overridable for host test doubles, but bridge
    // callers bind whichever implementation is present synchronously at
    // transition entry before any await.
    Object.defineProperty(this, 'options', { value: frozenOptions, enumerable: true, writable: false, configurable: false });
  }

  async capture(signal?: AbortSignal, protectedRoots: readonly string[] = []): Promise<BeadsCapture> {
    if (signal !== undefined && (!signal || typeof signal !== 'object' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) fail('bd capture signal is invalid');
    if (!Array.isArray(protectedRoots) || protectedRoots.some((root) => typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root)) fail('protected capture roots are invalid');
    // Snapshot every option before the first await.  A caller retaining the
    // source object cannot change the identity of an in-flight capture.
    const { executablePath, workspace, expectedBinaryDigest, timeoutMs, homeDir, xdgConfigHome, phaseId } = this.options;
    const captureBoundary: PrivateSnapshotBoundary = { ...(signal === undefined ? {} : { signal }), deadline: Date.now() + (timeoutMs ?? BEADS_TIMEOUT_MS) };
    checkPrivateSnapshotBoundary(captureBoundary);
    const protectedRootSnapshot = [...protectedRoots];
    await assertNoSymlinkSegments(executablePath, 'bd executablePath');
    await assertNoSymlinkSegments(workspace, 'Beads workspace');
    await statRegular(executablePath, 'bd executable', true);
    await assertDirectory(workspace, 'Beads workspace');
    const workspaceFsIdentity = await trustedIdentity(workspace, 'Beads workspace', { surface: true, kind: 'directory' });
    if (!workspaceFsIdentity) fail('Beads workspace identity is unavailable');
    const workspaceReal = await fs.realpath(workspace);
    const beadsDir = join(workspaceReal, '.beads');
    // BEADS_DIR is explicit and cannot escape the selected workspace.  The
    // directory is read by bd; unlike `bd init`, the adapter never creates it.
    await assertNoSymlinkSegments(beadsDir, 'BEADS_DIR');
    await assertDirectory(beadsDir, 'BEADS_DIR');
    const beadsFsIdentity = await trustedIdentity(beadsDir, 'BEADS_DIR', { surface: true, kind: 'directory' });
    if (!beadsFsIdentity) fail('BEADS_DIR identity is unavailable');
    const beadsDirReal = await fs.realpath(beadsDir);
    const workspaceStat = await fs.stat(workspace);
    const beadsStat = await fs.stat(beadsDir);
    let workspaceHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let beadsHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      await assertStableIdentity(workspace, workspaceFsIdentity, 'Beads workspace', { surface: true, kind: 'directory' });
      await assertStableIdentity(beadsDir, beadsFsIdentity, 'BEADS_DIR', { surface: true, kind: 'directory' });
      const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
      workspaceHandle = await fs.open(workspaceReal, directoryFlags);
      beadsHandle = await fs.open(beadsDirReal, directoryFlags);
      const boundWorkspace = await workspaceHandle.stat();
      const boundBeads = await beadsHandle.stat();
      // A path replacement before descriptor acquisition is not silently
      // accepted.  Once these descriptors are held, however, a swap-and-
      // restore during either bd subprocess cannot change what is read.
      if (!sameFilesystemIdentity(filesystemIdentity(boundWorkspace), workspaceFsIdentity) || !sameFilesystemIdentity(filesystemIdentity(boundBeads), beadsFsIdentity)) throw new Error('selected Beads directories changed before descriptor binding');
    } catch (error) {
      await workspaceHandle?.close().catch(() => undefined);
      await beadsHandle?.close().catch(() => undefined);
      fail(`Beads workspace could not be descriptor-bound: ${(error as Error).message}`);
    }
    const workspaceIdentity = digest({ workspace: workspaceReal, beadsDir: beadsDirReal, workspaceDevice: String(workspaceStat.dev), workspaceInode: String(workspaceStat.ino), beadsDevice: String(beadsStat.dev), beadsInode: String(beadsStat.ino) });

    // Explicit directories are accepted only when they are pre-existing,
    // private, owned by this user, and physically disjoint from the selected
    // workspace/database.  The default is a fresh 0700 pair for every
    // capture, removed even when bd fails or is interrupted.
    const cleanupDirs: string[] = [];
    let privateWorkspaceRoot: string | undefined;
    let homeReal: string; let xdgReal: string;
    try {
      if (homeDir === undefined) {
        const home = await fs.mkdtemp(join(tmpdir(), 'lunacy-beads-home-')); cleanupDirs.push(home);
        await assertNoSymlinkSegments(home, 'isolated HOME');
        await fs.chmod(home, 0o700).catch((error) => fail(`isolated HOME could not be made private: ${(error as Error).message}`));
        homeReal = await fs.realpath(home);
      } else homeReal = await privateDirectory(homeDir, 'isolated HOME');
      if (xdgConfigHome === undefined) {
        const config = await fs.mkdtemp(join(tmpdir(), 'lunacy-beads-config-')); cleanupDirs.push(config);
        await assertNoSymlinkSegments(config, 'isolated XDG_CONFIG_HOME');
        await fs.chmod(config, 0o700).catch((error) => fail(`isolated XDG_CONFIG_HOME could not be made private: ${(error as Error).message}`));
        xdgReal = await fs.realpath(config);
      } else xdgReal = await privateDirectory(xdgConfigHome, 'isolated XDG_CONFIG_HOME');
      if (pathsOverlap(homeReal, workspaceReal) || pathsOverlap(homeReal, beadsDirReal) || pathsOverlap(xdgReal, workspaceReal) || pathsOverlap(xdgReal, beadsDirReal) || pathsOverlap(homeReal, xdgReal)) fail('isolated HOME/XDG_CONFIG_HOME overlaps the Beads workspace');
      for (const root of protectedRootSnapshot) {
        const physicalRoot = await nearestPhysicalPath(root).catch((error) => fail(`protected runtime root could not be physicalized: ${(error as Error).message}`));
        if (pathsOverlap(workspaceReal, physicalRoot) || pathsOverlap(beadsDirReal, physicalRoot)) fail('Beads workspace overlaps a protected runtime root');
        if (pathsOverlap(homeReal, physicalRoot) || pathsOverlap(xdgReal, physicalRoot)) fail('isolated HOME/XDG_CONFIG_HOME overlaps a protected runtime root');
      }
      // Linux can make both cwd and BEADS_DIR descriptor-relative.  macOS's
      // spawn(2) rejects /dev/fd/N as cwd, so copy the already-bound .beads
      // tree into a bounded private snapshot and run both probes against that
      // immutable tree.  This removes the live-path swap window while bd is
      // running; the original descriptors and post-capture fence still prove
      // that the acknowledged workspace was not replaced around the capture.
      const descriptorBound = process.platform === 'linux';
      if (!descriptorBound) {
        // Node has no portable directory-fd traversal/fchdir primitive on
        // macOS.  Bind the pathname-only copy to the already observed source
        // bytes instead: a swap-and-restore or in-place rewrite during the
        // copy then mismatches either the pre-copy source or the copied image.
        await assertStableIdentity(workspace, workspaceFsIdentity, 'Beads workspace', { surface: true, kind: 'directory' });
        await assertStableIdentity(beadsDir, beadsFsIdentity, 'BEADS_DIR', { surface: true, kind: 'directory' });
        const sourceBefore = await fs.stat(beadsDirReal);
        if (sourceBefore.dev !== beadsStat.dev || sourceBefore.ino !== beadsStat.ino) fail('Beads workspace changed before private snapshot');
        const sourceTreeDigest = await hashPrivateBeadsTree(beadsDirReal, captureBoundary);
        const sourceAfterHash = await fs.stat(beadsDirReal);
        if (sourceAfterHash.dev !== beadsStat.dev || sourceAfterHash.ino !== beadsStat.ino) fail('Beads workspace changed during private snapshot preflight');
        privateWorkspaceRoot = await fs.mkdtemp(join(tmpdir(), 'lunacy-beads-snapshot-')).catch((error) => fail(`private Beads snapshot could not be created: ${(error as Error).message}`));
        cleanupDirs.push(privateWorkspaceRoot);
        await assertNoSymlinkSegments(privateWorkspaceRoot, 'private Beads snapshot');
        await copyPrivateBeadsTree(beadsDirReal, privateWorkspaceRoot, captureBoundary);
        const afterTreeDigest = await hashPrivateBeadsTree(beadsDirReal, captureBoundary);
        const snapshotTreeDigest = await hashPrivateBeadsTree(join(privateWorkspaceRoot, '.beads'), captureBoundary);
        if (sourceTreeDigest !== afterTreeDigest || sourceTreeDigest !== snapshotTreeDigest) fail('Beads workspace changed during private snapshot');
      }
      const captureWorkspacePath = descriptorBound ? descriptorPath(CHILD_WORKSPACE_FD) : privateWorkspaceRoot!;
      const captureBeadsPath = descriptorBound ? descriptorPath(CHILD_BEADS_FD) : join(privateWorkspaceRoot!, '.beads');
      const env: NodeJS.ProcessEnv = { BEADS_DIR: captureBeadsPath, HOME: homeReal, XDG_CONFIG_HOME: xdgReal, BD_DISABLE_METRICS: '1', NO_COLOR: '1' };
      const verified = await copyVerifiedExecutable(executablePath, expectedBinaryDigest);
      try {
        const timeout = timeoutMs ?? BEADS_TIMEOUT_MS;
        // On Linux the executable is detached from its pathname and passed as
        // a read-only descriptor.  macOS cannot reopen an inherited descriptor
        // through `/dev/fd/N` with Node's fs API; keep its immutable pathname as
        // the execution authority and do not leak the copy's write descriptor
        // into the child (the target was opened O_WRONLY while it was built).
        const descriptors: CaptureDescriptors = {
          ...(process.platform === 'linux' ? { executableFd: verified.fd } : {}),
          workspaceFd: workspaceHandle!.fd,
          beadsFd: beadsHandle!.fd,
        };
        const boundWorkspacePath = captureWorkspacePath;
        const versionResult = await runBd(verified.execPath, boundWorkspacePath, env, ['version', '--json'], timeout, signal, descriptors);
        if (versionResult.code !== 0) fail(`bd version failed with exit ${String(versionResult.code)}`);
        // A pinned release is expected to be silent on stderr.  Treat any
        // diagnostic as a failed probe rather than allowing an attempted
        // workspace/database mutation (or another unexpected side effect) to
        // be mistaken for a clean version check.
        const versionStderr = decodeUtf8(versionResult.stderr, 'bd version stderr');
        if (versionStderr.length !== 0) fail('bd version wrote unexpected stderr');
        validateVersion(decodeUtf8(versionResult.stdout, 'bd version output').trim());
        const exportResult = await runBd(verified.execPath, boundWorkspacePath, env, ['--readonly', '--json', 'export'], timeout, signal, descriptors);
        const exportText = decodeUtf8(exportResult.stdout, 'bd export output');
        const stderrText = decodeUtf8(exportResult.stderr, 'bd export stderr');
        if (exportResult.code !== 0) fail(`bd export failed with exit ${String(exportResult.code)}${stderrText ? `: ${stderrText.slice(0, 512)}` : ''}`);
        const workspaceAfter = await workspaceHandle!.stat();
        const beadsAfter = await beadsHandle!.stat();
        if (!sameFilesystemIdentity(filesystemIdentity(workspaceAfter), workspaceFsIdentity) || !sameFilesystemIdentity(filesystemIdentity(beadsAfter), beadsFsIdentity)) fail('descriptor-bound Beads workspace changed during capture');
        if (!descriptorBound) {
          const workspaceAfterPath = await fs.realpath(workspace);
          const beadsAfterPath = await fs.realpath(join(workspaceAfterPath, '.beads'));
          const workspaceAfterPathStat = await fs.stat(workspace);
          const beadsAfterPathStat = await fs.stat(join(workspaceAfterPath, '.beads'));
          if (workspaceAfterPath !== workspaceReal || beadsAfterPath !== beadsDirReal || workspaceAfterPathStat.dev !== workspaceStat.dev || workspaceAfterPathStat.ino !== workspaceStat.ino || beadsAfterPathStat.dev !== beadsStat.dev || beadsAfterPathStat.ino !== beadsStat.ino) fail('Beads workspace changed during capture');
        }
        const parsed = parseExport(exportText);
        const issues = [...parsed.issues].sort((a, b) => compareStable(a.sourceId, b.sourceId));
        const edges = [...parsed.edges].sort((a, b) => compareStable(a.from, b.from) || compareStable(a.to, b.to) || compareStable(a.type, b.type));
        const base = contentSnapshot({ schema: BEADS_SNAPSHOT_SCHEMA, source: 'beads', workspaceIdentity, bdVersion: BEADS_VERSION, bdBuild: BEADS_BUILD, bdCommit: BEADS_COMMIT, bdSchemaVersion: BEADS_SCHEMA_VERSION, binaryDigest: verified.digest, issues, edges });
        const snapshot = { ...base, contentDigest: digest(base), capturedAt: new Date().toISOString() } as BeadsSnapshot;
        const mapped = makePlan(issues, edges, phaseId ?? 'beads', snapshot.contentDigest);
        return { snapshot: freeze(snapshot), plan: freeze(mapped.plan), sourceIds: freeze(mapped.sourceIds) };
      } finally { await verified.cleanup(); }
    } finally {
      await beadsHandle?.close().catch(() => undefined);
      await workspaceHandle?.close().catch(() => undefined);
      for (const path of cleanupDirs) {
        if (path === privateWorkspaceRoot) await removePrivateSnapshot(path);
        else await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

export type BeadsAcknowledgement = {
  snapshotDigest: string;
  targetPlanDigest: string;
  workspaceIdentity: string;
  bdCommit: string;
  binaryDigest: string;
};

export function validateBeadsAcknowledgement(value: unknown, capture: BeadsCapture): BeadsAcknowledgement {
  if (!isRecord(value)) fail('Beads acknowledgement must be an object');
  exactKeys(value, ['snapshotDigest', 'targetPlanDigest', 'workspaceIdentity', 'bdCommit', 'binaryDigest'], 'Beads acknowledgement');
  const expected: BeadsAcknowledgement = { snapshotDigest: capture.snapshot.contentDigest, targetPlanDigest: digest(capture.plan), workspaceIdentity: capture.snapshot.workspaceIdentity, bdCommit: BEADS_COMMIT, binaryDigest: capture.snapshot.binaryDigest };
  for (const key of Object.keys(expected) as (keyof BeadsAcknowledgement)[]) if (value[key] !== expected[key]) fail(`Beads acknowledgement ${key} does not match the captured snapshot`);
  return Object.freeze({ ...expected });
}

export function beadsPlanDigest(capture: BeadsCapture): Sha256 { return digest(capture.plan); }
export function beadsSnapshotDigest(capture: BeadsCapture): Sha256 { return capture.snapshot.contentDigest; }
