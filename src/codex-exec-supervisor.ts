import { constants as fsConstants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { OutboxCommand } from './model.js';
import { digest } from './canonical.js';
import {
  attestCodexExecutable, buildCodexArguments, buildWorkerHandoff, childEnvironment, codexHostPolicyDigest, commandAuthorityPaths, expectedReportPath, parseWorkerResultText, reasoningEffortFor,
  launchAuthorityDescriptorPaths, launchAuthoritySnapshotPath, launchAuthoritySnapshotPaths, launchAuthoritySnapshotRoot, launchDirectoryPath, launchWritableRoots,
  validateCodexHostPolicy, type CodexCommandFrame, type CodexHostPolicy, type CodexBinaryAttestation, type CodexWorkerResult,
} from './codex-host-policy.js';
import {
  effectPaths, readBoundedUtf8File, readLaunchIntentRecord, readLaunchRecord, readTerminalRecord, reportControlStatus, validateTerminalRecord, writeLaunchIntentRecord, writeLaunchRecord, writeTerminalRecord,
  type LaunchIntentRecord, type LaunchRecord, type TerminalOutcome, type TerminalRecord, type TerminalStatus,
} from './codex-effect-records.js';
import { ensurePrivateDirectory, inspectTrustedPath, openTrustedDirectory, sameFilesystemIdentity, syncDirectory, syncDirectoryChain, syncFile, type FilesystemIdentity } from './filesystem.js';
import type { EffectDriver } from './driver.js';
import { assertReleaseAdmissionOpen } from './release-admission.js';

const WORKER_STATUSES = new Set(['PASS', 'NEEDS-DECISION', 'BLOCKED']);
// Authority files are parent-owned inputs, not unbounded worker output.  Keep
// the attestation bounded so a hostile skill tree cannot turn reconciliation
// into an uncontrolled read while still covering a normal managed bundle.
const MAX_AUTHORITY_BYTES = 32 * 1024 * 1024;
const MIN_HARD_REAP_MS = 25;

export type CodexSupervisorLaunch = Readonly<{
  command: CodexCommandFrame;
  policy: CodexHostPolicy;
  signal?: AbortSignal;
}>;

export type CodexSupervisorOptions = Readonly<{
  policy: CodexHostPolicy;
  /** Injectable only for deterministic tests; production uses node:child_process.spawn. */
  spawnProcess?: typeof spawn;
  attestExecutable?: (policy: CodexHostPolicy) => Promise<CodexBinaryAttestation>;
  /** Injectable only for deterministic Darwin sealing regressions. */
  sealImmutable?: (path: string, enabled: boolean) => boolean | void;
  /** Injectable only for deterministic Darwin flag-observation regressions. */
  observeImmutable?: (path: string) => boolean;
  /** Injectable process-group signal seam for deterministic tree tests. */
  signalProcessTree?: (pid: number, signal: NodeJS.Signals) => void;
  /** Injectable durable launch publication seam for deterministic failures. */
  writeLaunch?: typeof writeLaunchRecord;
  now?: () => Date;
}>;

type BoundedText = { text: string; bytes: number; overflow: boolean };

type AuthorityMetadata = Readonly<{ size: number; mode: number; mtimeMs: number; ctimeMs: number }>;
type AuthorityEntry = Readonly<{
  path: string;
  kind: 'directory' | 'file';
  identity: FilesystemIdentity;
  metadata: AuthorityMetadata;
  contentDigest: string | null;
}>;

type AuthorityBudget = { bytes: number; counted: Set<string>; snapshotRoot?: string; snapshotPolicy?: CodexHostPolicy; snapshotCommand?: CodexCommandFrame; snapshotWritten: Set<string> };

export type CodexHostAuthorityAttestation = Readonly<{ digest: string }>;

function fail(message: string): never { throw new Error(`CodexExecSupervisor: ${message}`); }
function boundedPush(state: BoundedText, chunk: unknown, ceiling: number): void {
  const text = String(chunk); const bytes = Buffer.byteLength(text);
  if (state.bytes >= ceiling) { state.overflow = true; return; }
  const remaining = ceiling - state.bytes;
  if (bytes > remaining) state.overflow = true;
  // Slice by bytes, not UTF-16 units, so a non-ASCII stream cannot evade the
  // evidence ceiling.  The resulting text is only used for classification.
  const value = Buffer.from(text).subarray(0, remaining).toString('utf8');
  state.text += value; state.bytes += Buffer.byteLength(value);
}
function safeSignal(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null; }
function sha256(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
function parseJsonl(text: string): { events: Array<Record<string, unknown>>; malformed: number } {
  const events: Array<Record<string, unknown>> = []; let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value as Record<string, unknown>);
      else malformed += 1;
    } catch { malformed += 1; }
  }
  return { events, malformed };
}
function eventType(event: Record<string, unknown>): string { return typeof event.type === 'string' ? event.type.toLowerCase() : ''; }
function eventItem(event: Record<string, unknown>): Record<string, unknown> | undefined {
  return event.item && typeof event.item === 'object' && !Array.isArray(event.item) ? event.item as Record<string, unknown> : undefined;
}
function structuralStatus(event: Record<string, unknown>): string {
  const item = eventItem(event);
  const value = item?.status ?? event.status ?? event.control;
  return typeof value === 'string' ? value.toLowerCase().replace(/[ _]/g, '-') : '';
}
function capabilityDenied(events: Array<Record<string, unknown>>, stderr: string): boolean {
  // Do not scan the complete JSONL stream for denial words: normal worker
  // prose and inspected skill text legitimately mention sandbox/blocked
  // boundaries.  Only stderr or an explicit command-execution denial/error
  // is evidence of a capability boundary.
  if (/sandbox.*(denied|deny|blocked)|permission denied|operation not permitted|outside the sandbox|command.*(denied|blocked)/i.test(stderr)) return true;
  return events.some((event) => {
    const item = event.item;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const value = item as Record<string, unknown>;
    const type = String(value.type ?? '').toLowerCase();
    const status = String(value.status ?? '').toLowerCase();
    if (type.includes('command_execution')) {
      // A successful command may legitimately mention a path such as
      // `blocked.md`; only a host-denied status or a failed command's output
      // can establish a capability boundary.  Never classify the command
      // string itself as denial evidence.
      if (status === 'denied') return true;
      if (status !== 'failed' && status !== 'error') return false;
    } else if (String(event.type ?? '').toLowerCase() !== 'error') return false;
    const details = [value.message, value.aggregated_output, value.output, value.error, event.message, event.error]
      .filter((part): part is string => typeof part === 'string').join('\n');
    return /sandbox.*(denied|deny|blocked)|permission denied|operation not permitted|outside the sandbox|command.*(denied|blocked)/i.test(details);
  });
}
function classifyOutcome(stdout: string, stderr: string, exitCode: number | null, signal: string | null, cancelled: boolean): TerminalOutcome {
  const parsed = parseJsonl(stdout);
  if (parsed.malformed > 0) return 'host-evidence-failure';
  const stderrText = stderr.toLowerCase();
  if (cancelled || signal || parsed.events.some((event) => /^(turn\.)?(aborted|cancelled|canceled)$/.test(eventType(event)) || ['cancelled', 'canceled', 'aborted'].includes(structuralStatus(event))) || /host.*\b(cancelled|canceled|aborted)\b/.test(stderrText)) return 'cancellation';
  if (parsed.events.some((event) => {
    const type = eventType(event); const itemType = String(eventItem(event)?.type ?? '').toLowerCase(); const status = structuralStatus(event);
    return ['approval.required', 'approval_required', 'turn.approval_required'].includes(type)
      || ['approval_request', 'approval.required'].includes(itemType)
      || ['approval-required', 'approval-needed', 'needs-approval'].includes(status);
  }) || /host.*approval (required|needed)/.test(stderrText)) return 'approval-required';
  if (capabilityDenied(parsed.events, stderr)) return 'sandbox-denial';
  if (parsed.events.some((event) => /^(turn\.)?failed$/.test(eventType(event)) || structuralStatus(event) === 'turn-failed') || /^(?:codex|host):.*(?:turn failed|model error|provider error|context window exceeded)/m.test(stderrText)) return 'turn-failure';
  return exitCode === 0 ? 'normal-completion' : 'process-failure';
}
function terminalStatus(outcome: TerminalOutcome, resultStatus?: string): TerminalStatus {
  if (outcome === 'approval-required') return 'NEEDS-DECISION';
  if (outcome !== 'normal-completion') return 'BLOCKED';
  return WORKER_STATUSES.has(resultStatus ?? '') ? resultStatus as TerminalStatus : 'BLOCKED';
}
function pathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function authorityRecordDigest(entries: readonly AuthorityEntry[]): string {
  const records = [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0).map((entry) => ({
    path: entry.path, kind: entry.kind, identity: entry.identity, metadata: entry.kind === 'file' ? entry.metadata : null, contentDigest: entry.contentDigest,
  }));
  return digest({ schema: 'lunacy-codex-authority/v1', records });
}

function authorityMetadata(stat: import('node:fs').Stats): AuthorityMetadata {
  return Object.freeze({ size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
}

function sameAuthorityMetadata(left: AuthorityMetadata, right: AuthorityMetadata): boolean {
  return left.size === right.size && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function writeAuthoritySnapshotFile(snapshotRoot: string, snapshotPath: string, bytes: Buffer, label: string): Promise<void> {
  const relativePath = relative(snapshotRoot, snapshotPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) fail(`${label} snapshot escapes launch boundary`);
  await ensurePrivateDirectory(dirname(snapshotPath), `${label} snapshot directory`).catch((error) => fail(`${label} snapshot directory could not be created safely: ${(error as Error).message}`));
  // The target directory may predate this attempt. Flush the complete chain
  // before publishing a snapshot filename so restart cannot lose its parent
  // name after the file itself has been synced.
  await syncDirectoryChain(dirname(snapshotPath), `${label} snapshot directory`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(snapshotPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o400);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existingStat = await fs.lstat(snapshotPath).catch((readError) => fail(`${label} snapshot could not be inspected: ${(readError as Error).message}`));
      if (!existingStat.isFile() || existingStat.nlink !== 1) fail(`${label} snapshot is not a private regular file`);
      let existing: Buffer;
      try { existing = await fs.readFile(snapshotPath); } catch (readError) { fail(`${label} snapshot could not be read: ${(readError as Error).message}`); }
      if (!existing!.equals(bytes)) fail(`${label} snapshot conflicts with an existing launch input`);
      await syncDirectory(dirname(snapshotPath), `${label} snapshot directory`);
      return;
    }
    fail(`${label} snapshot could not be written: ${(error as Error).message}`);
  } finally { await handle?.close().catch(() => undefined); }
  const writtenStat = await fs.lstat(snapshotPath).catch((error) => fail(`${label} snapshot could not be inspected: ${(error as Error).message}`));
  if (!writtenStat.isFile() || writtenStat.nlink !== 1) fail(`${label} snapshot is not a private regular file`);
  try { await fs.chmod(snapshotPath, 0o400); } catch (error) { fail(`${label} snapshot could not be sealed: ${(error as Error).message}`); }
  await syncFile(snapshotPath, `${label} snapshot`);
  await syncDirectory(dirname(snapshotPath), `${label} snapshot directory`);
}

type ImmutableSetter = (path: string, enabled: boolean) => boolean | void;
type ImmutableObserver = (path: string) => boolean;

function setImmutableSync(path: string, enabled: boolean, override?: ImmutableSetter, simulatedFlags?: Map<string, boolean>): void {
  // Darwin has no descriptor-relative cwd in child_process.spawn.  A private
  // uchg boundary is therefore used for the detached launch image/snapshot;
  // Linux binds the actual image and directories through inherited fds below.
  if (override) {
    const changed = override(path, enabled);
    // The optional setter is a deterministic test seam standing in for the
    // Darwin kernel flag. Keep that simulated state scoped to one supervisor
    // so final verification remains meaningful without weakening production,
    // which always reads the native flag.
    if (changed !== false) simulatedFlags?.set(path, enabled);
    return;
  }
  if (process.platform !== 'darwin') return;
  const result = spawnSync('/usr/bin/chflags', [enabled ? 'uchg' : 'nouchg', path], { shell: false, stdio: 'ignore' });
  if (result.error || result.status !== 0) fail(`${path} could not be made immutable`);
}

type SnapshotSealWitness = Readonly<{
  path: string;
  kind: 'directory' | 'file';
  identity: FilesystemIdentity;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
  digest: string | null;
}>;

function snapshotWitnessesSync(root: string): SnapshotSealWitness[] {
  const witnesses: SnapshotSealWitness[] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail('Codex authority snapshot rejects symlinks');
    if (!stat.isDirectory() && !stat.isFile()) fail('Codex authority snapshot contains a non-regular entry');
    witnesses.push(Object.freeze({
      path,
      kind: stat.isDirectory() ? 'directory' : 'file',
      identity: { dev: String(stat.dev), ino: String(stat.ino) },
      size: stat.size,
      mode: stat.mode & 0o777,
      uid: stat.uid,
      gid: stat.gid,
      nlink: stat.nlink,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      digest: stat.isFile() ? sha256(readFileSync(path)) : null,
    }));
    if (stat.isDirectory()) {
      for (const child of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) visit(join(path, child.name));
    }
  };
  visit(root);
  return witnesses;
}

async function sealAuthoritySnapshot(root: string, override?: ImmutableSetter, simulatedFlags?: Map<string, boolean>): Promise<readonly SnapshotSealWitness[]> {
  // Capture identities/content before chmod/chflags. The final Darwin fence
  // compares every object against this witness set and rejects a replacement
  // even when an attacker restores identical bytes.
  const before = snapshotWitnessesSync(root);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let children: import('node:fs').Dirent[];
    try { children = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) { fail(`Codex authority snapshot could not be inspected: ${(error as Error).message}`); }
    for (const child of children!.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const path = join(current, child.name);
      if (child.isSymbolicLink()) fail('Codex authority snapshot rejects symlinks');
      if (child.isDirectory()) stack.push(path);
      else if (!child.isFile()) fail('Codex authority snapshot contains a non-regular entry');
      else {
        const entryStat = await fs.lstat(path).catch((error) => fail(`Codex authority snapshot entry could not be inspected: ${(error as Error).message}`));
        if (!entryStat.isFile() || entryStat.nlink !== 1) fail('Codex authority snapshot rejects hard links');
        // The copied launch image remains executable; every other authority
        // byte is read-only.  Apply the mode before uchg because Darwin
        // rejects chmod on an already immutable entry.
        const mode = path === join(root, 'codex-executable') ? 0o500 : 0o400;
        await fs.chmod(path, mode).catch((error) => fail(`Codex authority snapshot file could not be sealed: ${(error as Error).message}`));
        setImmutableSync(path, true, override, simulatedFlags);
        await syncFile(path, 'Codex authority snapshot file');
        await syncDirectory(dirname(path), 'Codex authority snapshot directory');
      }
    }
    await fs.chmod(current, 0o500).catch((error) => fail(`Codex authority snapshot directory could not be sealed: ${(error as Error).message}`));
    setImmutableSync(current, true, override, simulatedFlags);
    await syncDirectory(current, 'Codex authority snapshot directory');
    await syncDirectory(dirname(current), 'Codex authority snapshot parent');
  }
  return before;
}

function immutableFlagSync(path: string, simulatedFlags?: ReadonlyMap<string, boolean>, override?: ImmutableObserver): boolean {
  if (override) {
    const observed: unknown = override(path);
    if (observed !== true && observed !== false) fail(`${path} immutable flag observation was not an exact state`);
    return observed;
  }
  const simulated = simulatedFlags?.get(path);
  if (simulated !== undefined) return simulated;
  const stat = lstatSync(path) as import('node:fs').Stats & { flags?: number };
  // Darwin's native stat binding exposes flags on supported Node versions.
  // UF_IMMUTABLE is 0x00000002 on Darwin. Keep a synchronous stat fallback
  // for older bindings; it runs inside the final fence, before spawn, and is
  // never followed by an await or another mutable pathname operation.
  if (typeof stat.flags === 'number') {
    if (!Number.isSafeInteger(stat.flags) || stat.flags < 0 || stat.flags > 0xffffffff) fail(`${path} immutable flag observation was out of range`);
    return (stat.flags & 0x00000002) !== 0;
  }
  const result = spawnSync('/usr/bin/stat', ['-f', '%f', path], { shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error) fail(`${path} immutable flag observation failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${path} immutable flag observation exited with status ${String(result.status)}`);
  const output = String(result.stdout).trim();
  if (!/^[0-9a-fA-F]+$/.test(output)) fail(`${path} immutable flag observation was unparseable`);
  const value = Number.parseInt(output, 16);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) fail(`${path} immutable flag observation was out of range`);
  return (value & 0x00000002) !== 0;
}

type ExecutableImage = Readonly<{ path: string; fd?: number; cleanup: () => Promise<void> }>;

async function copyImmutableExecutable(attestation: CodexBinaryAttestation, destinationRoot: string, expectedDigest: string, allowSyntheticAttestation: boolean): Promise<ExecutableImage | undefined> {
  let source: fs.FileHandle | undefined;
  try { source = await fs.open(attestation.physicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { if (allowSyntheticAttestation) return undefined; fail(`Codex executable image could not be opened: ${(error as Error).message}`); }
  let sourceStat: import('node:fs').Stats;
  try { sourceStat = await source.stat(); }
  catch (error) { await source.close().catch(() => undefined); if (allowSyntheticAttestation) return undefined; fail(`Codex executable image could not be inspected: ${(error as Error).message}`); }
  if (!sourceStat.isFile() || (sourceStat.mode & 0o111) === 0) { await source.close().catch(() => undefined); if (allowSyntheticAttestation) return undefined; fail('Codex executable image is not an executable regular file'); }
  // Read through the already-open no-follow descriptor.  Reopening the
  // attested pathname here would reintroduce the very replacement window this
  // image is meant to close.
  const sourceBytes = await fs.readFile(childDescriptorPath(source.fd)).catch(() => undefined);
  if (!sourceBytes || sha256(sourceBytes) !== expectedDigest || sha256(sourceBytes) !== attestation.digest) {
    await source.close().catch(() => undefined);
    if (allowSyntheticAttestation) return undefined;
    fail('Codex executable image digest changed before launch');
  }
  const destination = join(destinationRoot, 'codex-executable');
  let target: fs.FileHandle | undefined;
  try {
    target = await fs.open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o500);
    await target.writeFile(sourceBytes);
    await target.sync();
    if (process.platform === 'linux') {
      // Duplicate the still-open construction inode through its descriptor;
      // reopening the pathname after close would permit a same-directory
      // replacement before the execution handle is acquired.
      const executable = await fs.open(childDescriptorPath(target.fd), fsConstants.O_RDONLY);
      const copied = await fs.readFile(childDescriptorPath(executable.fd));
      if (sha256(copied) !== expectedDigest) {
        await executable.close().catch(() => undefined);
        fail('Codex launch executable snapshot digest changed');
      }
      await fs.unlink(destination);
      // The descriptor remains the executable authority on Linux, but the
      // pathname unlink is still a publication transition whose directory
      // entry must be durable before launch proceeds.
      await syncDirectory(dirname(destination), 'Codex launch executable directory');
      await target.close(); target = undefined;
      await source.close(); source = undefined;
      return Object.freeze({ path: '/proc/self/fd/3', fd: executable.fd, cleanup: async () => { await executable.close().catch(() => undefined); } });
    }
    await target.close(); target = undefined;
    await fs.chmod(destination, 0o500);
    await syncFile(destination, 'Codex launch executable');
    const copied = await fs.readFile(destination);
    if (sha256(copied) !== expectedDigest) fail('Codex launch executable snapshot digest changed');
    await syncDirectory(dirname(destination), 'Codex launch executable directory');
    await source.close(); source = undefined;
    return Object.freeze({ path: destination, cleanup: async () => undefined });
  } catch (error) {
    await target?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
    throw error;
  }
}

type SyncPathWitness = Readonly<{ dev: string; ino: string; size: number; mode: number; uid: number; gid: number; nlink: number; mtimeMs: number; ctimeMs: number }>;
function syncPathWitness(path: string): SyncPathWitness | undefined {
  try {
    const stat = lstatSync(path);
    return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino), size: stat.size, mode: stat.mode, uid: stat.uid, gid: stat.gid, nlink: stat.nlink, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  } catch { return undefined; }
}
function sameSyncPathWitness(left: SyncPathWitness | undefined, right: SyncPathWitness | undefined): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function sameSyncPathIdentity(left: SyncPathWitness | undefined, right: SyncPathWitness | undefined): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}
function executablePathWitness(requestedPath: string, physicalPath: string): SyncPathWitness | undefined {
  try {
    const requested = lstatSync(requestedPath); const physical = statSync(physicalPath);
    return Object.freeze({ dev: `${requested.dev}:${physical.dev}`, ino: `${requested.ino}:${physical.ino}`, size: physical.size, mode: physical.mode, uid: physical.uid, gid: physical.gid, nlink: physical.nlink, mtimeMs: physical.mtimeMs, ctimeMs: physical.ctimeMs });
  } catch { return undefined; }
}

function sameLaunchInputMetadata(left: SyncPathWitness | undefined, right: SyncPathWitness | undefined): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs;
}

/**
 * Darwin has no descriptor-relative cwd in child_process.spawn.  Once all
 * pathname sealing operations complete, this synchronous fence verifies the
 * complete copied image/snapshot/root set.  It intentionally performs no
 * asynchronous work; the caller invokes spawn immediately afterwards.
 */
function verifySealedLaunchInputsSync(args: Readonly<{
  snapshotRoot: string;
  snapshotBefore: readonly SnapshotSealWitness[];
  snapshotSealed: readonly SnapshotSealWitness[];
  executablePath: string;
  executableDigest: string;
  runRoot: string;
  workspace: string;
  runRootBefore: SyncPathWitness | undefined;
  runRootSealed: SyncPathWitness | undefined;
  workspaceBefore: SyncPathWitness | undefined;
  workspaceSealed: SyncPathWitness | undefined;
  simulatedFlags?: ReadonlyMap<string, boolean>;
  observeImmutable?: ImmutableObserver;
}>): void {
  const expectedBefore = new Map(args.snapshotBefore.map((entry) => [entry.path, entry]));
  const expectedSealed = new Map(args.snapshotSealed.map((entry) => [entry.path, entry]));
  const actual = snapshotWitnessesSync(args.snapshotRoot);
  if (actual.length !== expectedBefore.size || actual.length !== expectedSealed.size) fail('Codex authority snapshot entry set changed before spawn');
  for (const entry of actual) {
    const prior = expectedBefore.get(entry.path); const sealed = expectedSealed.get(entry.path);
    if (!prior || !sealed || prior.kind !== entry.kind || sealed.kind !== entry.kind || !sameFilesystemIdentity(prior.identity, entry.identity) || !sameFilesystemIdentity(sealed.identity, entry.identity)) fail(`Codex authority snapshot entry ${entry.path} changed before spawn`);
    if (entry.uid !== prior.uid || entry.gid !== prior.gid || entry.nlink !== prior.nlink || entry.size !== prior.size || entry.mtimeMs !== prior.mtimeMs || entry.digest !== prior.digest || entry.ctimeMs !== sealed.ctimeMs) fail('Codex authority snapshot metadata changed before spawn');
    const expectedMode = entry.kind === 'directory' || entry.path === join(args.snapshotRoot, 'codex-executable') ? 0o500 : 0o400;
    if (entry.mode !== expectedMode) fail('Codex authority snapshot mode changed before spawn');
    if (!immutableFlagSync(entry.path, args.simulatedFlags, args.observeImmutable)) fail(`Codex authority snapshot ${entry.path} is not immutable before spawn`);
  }
  const verifyRoot = (path: string, before: SyncPathWitness | undefined, sealed: SyncPathWitness | undefined, label: string): void => {
    const current = syncPathWitness(path);
    if (!current || !current.mode || !sameLaunchInputMetadata(before, current) || !sealed || current.ctimeMs !== sealed.ctimeMs) fail(`${label} changed before spawn`);
    if (!current || (current.mode & 0o170000) !== 0o040000) fail(`${label} is not a directory`);
    if (!immutableFlagSync(path, args.simulatedFlags, args.observeImmutable)) fail(`${label} is not immutable before spawn`);
  };
  verifyRoot(args.runRoot, args.runRootBefore, args.runRootSealed, 'Codex run root');
  verifyRoot(args.workspace, args.workspaceBefore, args.workspaceSealed, 'Codex workspace');
  const executable = syncPathWitness(args.executablePath);
  if (!executable || !executable.mode || (executable.mode & 0o170000) !== 0o100000 || (executable.mode & 0o777) !== 0o500 || executable.nlink !== 1 || sha256(readFileSync(args.executablePath)) !== args.executableDigest || !immutableFlagSync(args.executablePath, args.simulatedFlags, args.observeImmutable)) fail('Codex launch executable changed before spawn');
}

type LaunchDirectoryBoundary = Readonly<{
  workspaceFd?: number;
  runRootFd?: number;
  cwd: string;
  cleanup: () => Promise<void>;
}>;

type LaunchAuthorityBoundary = Readonly<{
  handles: readonly fs.FileHandle[];
  cleanup: () => Promise<void>;
}>;

function childDescriptorPath(slot: number): string {
  return process.platform === 'linux' ? `/proc/self/fd/${slot}` : `/dev/fd/${slot}`;
}

async function bindLaunchDirectories(policy: CodexHostPolicy, descriptorBound = process.platform === 'linux'): Promise<LaunchDirectoryBoundary> {
  let workspace: Awaited<ReturnType<typeof openTrustedDirectory>> | undefined;
  let runRoot: Awaited<ReturnType<typeof openTrustedDirectory>> | undefined;
  try {
    workspace = await openTrustedDirectory(policy.workspace, 'Codex workspace');
    runRoot = await openTrustedDirectory(policy.runRoot, 'Codex run root');
    return Object.freeze({
      ...(descriptorBound ? { workspaceFd: workspace.handle.fd, runRootFd: runRoot.handle.fd } : {}),
      cwd: descriptorBound ? childDescriptorPath(4) : policy.workspace,
      cleanup: async () => {
        await workspace?.handle.close().catch(() => undefined);
        await runRoot?.handle.close().catch(() => undefined);
      },
    });
  } catch (error) {
    await workspace?.handle.close().catch(() => undefined);
    await runRoot?.handle.close().catch(() => undefined);
    throw error;
  }
}

/** Open every command-selected snapshot file before child entry.  Linux uses
 * these read-only handles as the worker's authority paths; the snapshot
 * pathname is never looked up by the child after this point. */
async function bindLaunchAuthorityFiles(policy: CodexHostPolicy, command: CodexCommandFrame, snapshotRoot: string): Promise<LaunchAuthorityBoundary> {
  const handles: fs.FileHandle[] = [];
  try {
    for (const original of commandAuthorityPaths(policy, command)) {
      const snapshotPath = launchAuthoritySnapshotPath(policy, command, original);
      const handle = await fs.open(snapshotPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o222) !== 0) {
        await handle.close().catch(() => undefined);
        fail(`Codex authority snapshot entry ${snapshotPath} is not a sealed regular file`);
      }
      // Ensure the deterministic root argument was actually used; this also
      // rejects an accidental map to an unrelated snapshot namespace.
      if (!pathWithin(snapshotRoot, snapshotPath)) {
        await handle.close().catch(() => undefined);
        fail('Codex authority snapshot entry escapes launch boundary');
      }
      handles.push(handle);
    }
    return Object.freeze({ handles: Object.freeze(handles), cleanup: async () => { for (const handle of handles) await handle.close().catch(() => undefined); } });
  } catch (error) {
    for (const handle of handles) await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readAuthorityFile(path: string, label: string, budget: AuthorityBudget): Promise<AuthorityEntry> {
  const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
  if (!trusted) fail(`${label} is absent`);
  if (trusted.stat.size > MAX_AUTHORITY_BYTES) fail(`${label} exceeds authority ceiling`);
  if (!budget.counted.has(path)) {
    budget.counted.add(path);
    budget.bytes += trusted.stat.size;
  }
  if (budget.bytes > MAX_AUTHORITY_BYTES) fail('Codex authority bundle exceeds aggregate ceiling');
  let bytes: Buffer;
  try { bytes = await fs.readFile(path); } catch (error) { fail(`${label} could not be read: ${(error as Error).message}`); }
  const after = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
  if (!after || !sameFilesystemIdentity(trusted.identity, after.identity) || !sameAuthorityMetadata(authorityMetadata(trusted.stat), authorityMetadata(after.stat))) fail(`${label} changed during attestation`);
  let bytesAfter: Buffer;
  try { bytesAfter = await fs.readFile(path); } catch (error) { fail(`${label} could not be read: ${(error as Error).message}`); }
  if (!bytesAfter!.equals(bytes!)) fail(`${label} changed during attestation`);
  if (budget.snapshotRoot !== undefined && budget.snapshotPolicy !== undefined && budget.snapshotCommand !== undefined) {
    const snapshotPath = launchAuthoritySnapshotPath(budget.snapshotPolicy, budget.snapshotCommand, path);
    if (!budget.snapshotWritten.has(snapshotPath)) {
      await writeAuthoritySnapshotFile(budget.snapshotRoot, snapshotPath, bytes!, label);
      budget.snapshotWritten.add(snapshotPath);
    }
  }
  return Object.freeze({ path, kind: 'file', identity: trusted.identity, metadata: authorityMetadata(trusted.stat), contentDigest: sha256(bytes!) });
}

async function collectSkillBundle(root: string, runRoot: string, workspace: string, entries: AuthorityEntry[], budget: AuthorityBudget): Promise<void> {
  const trusted = await inspectTrustedPath(root, 'Codex skill root', { surface: true, kind: 'directory' });
  if (!trusted) fail('Codex skill root is absent');
  // A test/development composition may colocate the skill root and run root.
  // Run-owned effects are deliberately excluded from the bundle snapshot; the
  // explicit ENGINEERING.md entry below remains mandatory in that layout.
  let children: import('node:fs').Dirent[];
  try { children = await fs.readdir(root, { withFileTypes: true }); } catch (error) { fail(`Codex skill root could not be read: ${(error as Error).message}`); }
  for (const child of children!.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = join(root, child.name);
    if (pathWithin(runRoot, path) || pathWithin(workspace, path)) continue;
    const childTrusted = await inspectTrustedPath(path, `Codex skill bundle entry ${child.name}`, { surface: true });
    if (!childTrusted) fail(`Codex skill bundle entry ${child.name} is absent`);
    if (childTrusted.stat.isDirectory()) {
      entries.push(Object.freeze({ path, kind: 'directory', identity: childTrusted.identity, metadata: authorityMetadata(childTrusted.stat), contentDigest: null }));
      await collectSkillBundle(path, runRoot, workspace, entries, budget);
    } else if (childTrusted.stat.isFile()) {
      entries.push(await readAuthorityFile(path, `Codex skill bundle entry ${child.name}`, budget));
    } else {
      fail(`Codex skill bundle entry ${child.name} is not a regular file or directory`);
    }
  }
}

/** Snapshot all parent-owned authority inputs used to construct the handoff.
 * The aggregate is persisted with the launch record and rechecked at every
 * receipt/terminal boundary, so restart cannot accept a changed skill or
 * project-instruction tree merely because the policy object is unchanged. */
export async function attestCodexHostAuthority(policy: CodexHostPolicy, command: CodexCommandFrame, snapshotRoot?: string): Promise<CodexHostAuthorityAttestation> {
  const checked = validateCodexHostPolicy(policy);
  const authorityPaths = commandAuthorityPaths(checked, command);
  const entries: AuthorityEntry[] = [];
  const budget: AuthorityBudget = { bytes: 0, counted: new Set(), snapshotWritten: new Set<string>(), ...(snapshotRoot === undefined ? {} : { snapshotRoot, snapshotPolicy: checked, snapshotCommand: command }) };
  if (snapshotRoot !== undefined) {
    const expectedRoot = launchAuthoritySnapshotRoot(checked, command);
    if (snapshotRoot !== expectedRoot) fail('Codex authority snapshot root is not deterministic');
    try {
      await ensurePrivateDirectory(snapshotRoot, 'Codex authority snapshot root');
      await syncDirectoryChain(snapshotRoot, 'Codex authority snapshot root');
    }
    catch (error) { fail(`Codex authority snapshot could not be created: ${(error as Error).message}`); }
  }
  for (const [path, label] of [[checked.runRoot, 'Codex run root'], [checked.workspace, 'Codex workspace'], [checked.skillRoot, 'Codex skill root']] as const) {
    const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'directory' });
    if (!trusted) fail(`${label} is absent`);
    entries.push(Object.freeze({ path, kind: 'directory', identity: trusted.identity, metadata: authorityMetadata(trusted.stat), contentDigest: null }));
  }
  const skillRoot = await inspectTrustedPath(checked.skillRoot, 'Codex skill root', { surface: true, kind: 'directory' });
  if (!skillRoot) fail('Codex skill root is absent');
  await collectSkillBundle(checked.skillRoot, checked.runRoot, checked.workspace, entries, budget);
  for (const path of authorityPaths) entries.push(await readAuthorityFile(path, `Codex authority file ${path}`, budget));
  // The recursive traversal above is intentionally bounded and deterministic,
  // but a file/directory can still be replaced after its individual read while
  // later entries are being visited. Recheck the three authority anchors at the
  // end of the same pass so root/workspace swaps (including same-byte restores)
  // cannot produce a digest for a mixed launch snapshot.
  for (const [path, label] of [[checked.runRoot, 'Codex run root'], [checked.workspace, 'Codex workspace'], [checked.skillRoot, 'Codex skill root']] as const) {
    const before = entries.find((entry) => entry.path === path && entry.kind === 'directory');
    const after = await inspectTrustedPath(path, label, { surface: true, kind: 'directory' });
    if (!before || !after || !sameFilesystemIdentity(before.identity, after.identity)) fail(`${label} changed during attestation`);
  }
  for (const entry of entries.filter((candidate) => candidate.kind === 'file')) {
    const after = await inspectTrustedPath(entry.path, `Codex authority file ${entry.path}`, { surface: true, kind: 'file' });
    if (!after || !sameFilesystemIdentity(entry.identity, after.identity) || !sameAuthorityMetadata(entry.metadata, authorityMetadata(after.stat))) fail(`Codex authority file ${entry.path} changed during attestation`);
  }
  for (const entry of entries.filter((candidate) => candidate.kind === 'directory' && candidate.path !== checked.runRoot && candidate.path !== checked.workspace && candidate.path !== checked.skillRoot)) {
    const after = await inspectTrustedPath(entry.path, `Codex authority directory ${entry.path}`, { surface: true, kind: 'directory' });
    if (!after || !sameFilesystemIdentity(entry.identity, after.identity) || !sameAuthorityMetadata(entry.metadata, authorityMetadata(after.stat))) fail(`Codex authority directory ${entry.path} changed during attestation`);
  }
  const worker = entries.find((entry) => entry.path === checked.workerSchemaPath && entry.kind === 'file');
  if (!worker || worker.contentDigest !== checked.workerSchemaDigest) fail('Codex worker schema digest changed');
  return Object.freeze({ digest: authorityRecordDigest(entries) });
}

/** Re-attest authority and executable identity against an immutable launch. */
export async function verifyCodexHostBoundary(policy: CodexHostPolicy, launch: LaunchRecord, attestExecutable: (policy: CodexHostPolicy) => Promise<CodexBinaryAttestation> = attestCodexExecutable): Promise<void> {
  const command: CodexCommandFrame = {
    commandId: launch.commandId, runId: launch.runId, phaseId: launch.phaseId, stepId: launch.stepId,
    attemptEpoch: launch.attemptEpoch, authorityEpoch: launch.authorityEpoch, barrierEpoch: launch.barrierEpoch,
    modeEpoch: 0, launchToken: launch.launchToken, commandDigest: launch.commandDigest as CodexCommandFrame['commandDigest'], planDigest: policy.planDigest,
  };
  const authority = await attestCodexHostAuthority(policy, command);
  if (authority.digest !== launch.authorityDigest) fail('Codex authority changed after launch');
  const binary = await attestExecutable(policy);
  if (binary.requestedPath !== policy.codexPath || binary.requestedPath !== launch.codexPath || binary.version !== policy.codexVersion || binary.version !== launch.codexVersion || binary.digest !== policy.codexBinaryDigest || binary.digest !== launch.codexBinaryDigest) fail('Codex executable changed after launch');
}

/**
 * One supervisor instance owns one token and one child.  It is deliberately
 * not a scheduler: it accepts one already-selected command and exposes only
 * launch/terminal evidence for that command.
 */
export class CodexExecSupervisor {
  private readonly policy: CodexHostPolicy;
  private readonly spawnProcess: typeof spawn;
  private readonly attest: (policy: CodexHostPolicy) => Promise<CodexBinaryAttestation>;
  private readonly sealImmutable?: ImmutableSetter;
  private readonly observeImmutable?: ImmutableObserver;
  private readonly signalProcessTreeOverride?: (pid: number, signal: NodeJS.Signals) => void;
  private readonly writeLaunch: typeof writeLaunchRecord;
  private readonly simulatedImmutableFlags = new Map<string, boolean>();
  private readonly now: () => Date;
  private started = false;
  private launch?: LaunchRecord;
  private authority?: CodexHostAuthorityAttestation;
  private launchPaths?: ReturnType<typeof effectPaths>;
  private launchBoundary?: LaunchDirectoryBoundary;
  private launchAuthority?: LaunchAuthorityBoundary;
  private executableImage?: ExecutableImage;
  private executableWitness?: SyncPathWitness;
  private immutableRoots = false;
  private entryRootWitnesses?: Readonly<{ runRoot: SyncPathWitness; workspace: SyncPathWitness }>;
  private child?: ChildProcess;
  private token?: string;
  private commandDigest?: string;
  private cancelled = false;
  private terminalPromise?: Promise<TerminalRecord>;
  private resolveTerminal?: (value: TerminalRecord) => void;
  private rejectTerminal?: (reason: unknown) => void;
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  private reapTimer?: ReturnType<typeof setTimeout>;
  private cancellationPromise?: Promise<void>;
  private finishTask?: Promise<void>;
  private childClosedPromise?: Promise<void>;
  private resolveChildClosed?: () => void;
  private childClosed = false;
  private onChildClose?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private onChildError?: (error: Error) => void;
  private onStdoutData?: (chunk: unknown) => void;
  private onStderrData?: (chunk: unknown) => void;
  private launchSignal?: AbortSignal;
  private onLaunchAbort?: () => void;
  private finished = false;
  private readonly stdout: BoundedText = { text: '', bytes: 0, overflow: false };
  private readonly stderr: BoundedText = { text: '', bytes: 0, overflow: false };

  private get usesDarwinEntryFence(): boolean {
    // A custom immutable setter is a platform-neutral test seam. Production
    // can enter this branch only on Darwin because the real spawn path rejects
    // a custom setter in the constructor.
    return process.platform === 'darwin' || this.sealImmutable !== undefined || this.observeImmutable !== undefined;
  }

  constructor(options: CodexSupervisorOptions) {
    if (!options || typeof options !== 'object') fail('options are required');
    this.policy = options.policy;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.attest = options.attestExecutable ?? attestCodexExecutable;
    this.sealImmutable = options.sealImmutable;
    this.observeImmutable = options.observeImmutable;
    this.signalProcessTreeOverride = options.signalProcessTree;
    this.writeLaunch = options.writeLaunch ?? writeLaunchRecord;
    if ((this.sealImmutable || this.observeImmutable) && this.spawnProcess === spawn) fail('immutable flag seams are test-only and cannot replace Darwin kernel sealing');
    this.now = options.now ?? (() => new Date());
  }

  get launchRecord(): LaunchRecord | undefined { return this.launch; }
  get launchToken(): string | undefined { return this.token; }

  async start(spec: CodexSupervisorLaunch): Promise<LaunchRecord> {
    if (this.started) fail('supervisor already owns a launch token');
    try {
    await assertReleaseAdmissionOpen(this.policy.runRoot);
    if (spec.policy !== this.policy) fail('launch policy is not the composed policy');
    const command = spec.command;
    if (command.runId !== this.policy.runId || command.planDigest !== this.policy.planDigest) fail('command is outside policy authority');
    if (command.commandDigest !== digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken })) fail('command digest is not canonical');
    if (spec.signal?.aborted) fail('launch was cancelled before spawn');
    this.started = true; this.token = command.launchToken; this.commandDigest = command.commandDigest;
    // Handoff and schema paths are deterministic launch-slot paths.  The
    // corresponding bytes are populated only after the one-shot intent is
    // reserved, then sealed before child entry; restart can reconstruct these
    // exact witnesses from the token without trusting mutable policy prose.
    // The production child_process.spawn path receives Linux descriptors.  A
    // custom spawn seam is intentionally not descriptor-bound: deterministic
    // fake children run in this parent process and must be able to write the
    // durable effect path named in their test callback.  The real path remains
    // descriptor-bound, while custom tests still exercise immutable snapshots
    // and all pre-entry fences.
    const descriptorBound = process.platform === 'linux' && !this.usesDarwinEntryFence && this.spawnProcess === spawn;
    const descriptorWorkspace = descriptorBound ? '/proc/self/fd/4' : undefined;
    const descriptorRunRoot = descriptorBound ? '/proc/self/fd/5' : undefined;
    const authorityPaths = descriptorBound ? launchAuthorityDescriptorPaths(this.policy, command) : launchAuthoritySnapshotPaths(this.policy, command);
    const handoff = buildWorkerHandoff(this.policy, command, { authorityPaths });
    const effort = reasoningEffortFor(this.policy, command);
    const paths = effectPaths(this.policy, command.launchToken);
    const workerSchemaSnapshot = authorityPaths.get(this.policy.workerSchemaPath);
    if (!workerSchemaSnapshot) fail('Codex worker schema snapshot path is unavailable');
    const args = buildCodexArguments(this.policy, command, effort, paths.output, {
      outputPath: launchDirectoryPath(this.policy, paths.output, descriptorWorkspace, descriptorRunRoot),
      workerSchemaPath: workerSchemaSnapshot,
      workspacePath: launchDirectoryPath(this.policy, this.policy.workspace, descriptorWorkspace, descriptorRunRoot),
      writableRoots: launchWritableRoots(this.policy, descriptorWorkspace, descriptorRunRoot),
    });
    // A token is one-shot even when a previous supervisor died before it
    // could publish the child pid. Refuse any pre-existing launch evidence or
    // reservation before creating a new external process.
    if (await readLaunchRecord(this.policy, command.launchToken)) fail('launch record already exists for this launch token');
    if (await readLaunchIntentRecord(this.policy, command.launchToken)) fail('launch intent already exists for this launch token');
    // Bind the process cwd and every parent-owned effect root to a trusted
    // private directory before any child can observe or mutate them. A
    // renamed/symlinked workspace is a launch failure, never a reason to
    // continue with a best-effort cwd.
    const trustedRunRoot = await inspectTrustedPath(this.policy.runRoot, 'Codex run root', { surface: true, kind: 'directory' });
    const trustedWorkspace = await inspectTrustedPath(this.policy.workspace, 'Codex workspace', { surface: true, kind: 'directory' });
    if (!trustedRunRoot || !trustedWorkspace) fail('Codex run root/workspace is absent');
    const rootWitness = syncPathWitness(this.policy.runRoot);
    const workspaceWitness = syncPathWitness(this.policy.workspace);
    this.authority = await attestCodexHostAuthority(this.policy, command);
    const attestation = await this.attest(this.policy);
    if (attestation.requestedPath !== this.policy.codexPath || attestation.version !== this.policy.codexVersion || attestation.digest !== this.policy.codexBinaryDigest) fail('Codex executable attestation does not match policy');
    await this.attestWorkerSchema();
    if (spec.signal?.aborted) fail('launch was cancelled before spawn');
    const runRootBeforeSpawn = await inspectTrustedPath(this.policy.runRoot, 'Codex run root', { surface: true, kind: 'directory' });
    const workspaceBeforeSpawn = await inspectTrustedPath(this.policy.workspace, 'Codex workspace', { surface: true, kind: 'directory' });
    if (!runRootBeforeSpawn || !workspaceBeforeSpawn || !sameFilesystemIdentity(trustedRunRoot.identity, runRootBeforeSpawn.identity) || !sameFilesystemIdentity(trustedWorkspace.identity, workspaceBeforeSpawn.identity)) fail('Codex run root/workspace changed before spawn');
    const authorityBeforeSpawn = await attestCodexHostAuthority(this.policy, command);
    if (!this.authority || authorityBeforeSpawn.digest !== this.authority.digest) fail('Codex authority changed before spawn');
    const startedAt = this.now().toISOString();
    const buildLaunchIntent = (launchAttestation: CodexBinaryAttestation): LaunchIntentRecord => Object.freeze({
      schema: 'lunacy-codex-launch-intent/v1', launchToken: command.launchToken, commandDigest: command.commandDigest, commandId: command.commandId,
      runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attempt: command.attemptEpoch, attemptEpoch: command.attemptEpoch,
      authorityEpoch: command.authorityEpoch, barrierEpoch: command.barrierEpoch, policyDigest: codexHostPolicyDigest(this.policy), handoffDigest: handoff.digest,
      authorityDigest: this.authority!.digest,
      argvDigest: digest(args), codexPath: launchAttestation.requestedPath, codexVersion: launchAttestation.version, codexBinaryDigest: launchAttestation.digest,
      workspace: this.policy.workspace, supervisor: { pid: process.pid }, startedAt,
    });
    let launchAttestation = attestation;
    let attestationAtSpawn = launchAttestation;
    let reservedPaths: ReturnType<typeof effectPaths>;
    if (this.usesDarwinEntryFence) {
      // Reserve the one-shot intent before the second/third executable witness
      // so those witnesses cannot be blocked waiting for a name that has not
      // yet been published. The reservation is removed durably only when the
      // second witness fails before any external process boundary; once that
      // witness passes, the intent remains a permanent retry fence.
      reservedPaths = await writeLaunchIntentRecord(this.policy, buildLaunchIntent(launchAttestation));
      this.launchPaths = reservedPaths;
      const attestationBeforeSpawn = await this.attest(this.policy);
      if (attestationBeforeSpawn.requestedPath !== this.policy.codexPath || attestationBeforeSpawn.version !== this.policy.codexVersion || attestationBeforeSpawn.digest !== this.policy.codexBinaryDigest
        || attestationBeforeSpawn.physicalPath !== attestation.physicalPath || attestationBeforeSpawn.requestedPathIsSymlink !== attestation.requestedPathIsSymlink
        || attestationBeforeSpawn.uid !== attestation.uid || attestationBeforeSpawn.gid !== attestation.gid || attestationBeforeSpawn.mode !== attestation.mode) {
        try { await fs.unlink(reservedPaths.launchIntent); await syncDirectory(dirname(reservedPaths.launchIntent), 'launch intent cleanup directory'); } catch (error) { fail(`launch intent could not be withdrawn before spawn: ${(error as Error).message}`); }
        this.launchPaths = undefined;
        fail('Codex executable changed before spawn');
      }
      launchAttestation = attestationBeforeSpawn;
      this.executableWitness = executablePathWitness(launchAttestation.requestedPath, launchAttestation.physicalPath);
      if (spec.signal?.aborted) fail('launch was cancelled before spawn');
      // Preserve the final pre-seal executable witness after reservation. The
      // synchronous post-seal fence below is the actual Darwin entry proof.
      attestationAtSpawn = await this.attest(this.policy);
      if (attestationAtSpawn.requestedPath !== this.policy.codexPath || attestationAtSpawn.version !== this.policy.codexVersion || attestationAtSpawn.digest !== this.policy.codexBinaryDigest
        || attestationAtSpawn.physicalPath !== launchAttestation.physicalPath || attestationAtSpawn.requestedPathIsSymlink !== launchAttestation.requestedPathIsSymlink
        || attestationAtSpawn.uid !== launchAttestation.uid || attestationAtSpawn.gid !== launchAttestation.gid || attestationAtSpawn.mode !== launchAttestation.mode) fail('Codex executable changed before spawn');
      if (spec.signal?.aborted) fail('launch was cancelled before spawn');
    } else {
      // The first executable check can complete while authority/effect
      // preparation is still in flight. Re-attest the exact image immediately
      // before reserving/spawning so a replacement in that window cannot be
      // launched under the old digest/path witness.
      const attestationBeforeSpawn = await this.attest(this.policy);
      if (attestationBeforeSpawn.requestedPath !== this.policy.codexPath || attestationBeforeSpawn.version !== this.policy.codexVersion || attestationBeforeSpawn.digest !== this.policy.codexBinaryDigest
        || attestationBeforeSpawn.physicalPath !== attestation.physicalPath || attestationBeforeSpawn.requestedPathIsSymlink !== attestation.requestedPathIsSymlink
        || attestationBeforeSpawn.uid !== attestation.uid || attestationBeforeSpawn.gid !== attestation.gid || attestationBeforeSpawn.mode !== attestation.mode) fail('Codex executable changed before spawn');
      launchAttestation = attestationBeforeSpawn;
      attestationAtSpawn = launchAttestation;
      this.executableWitness = executablePathWitness(launchAttestation.requestedPath, launchAttestation.physicalPath);
      if (spec.signal?.aborted) fail('launch was cancelled before spawn');
      reservedPaths = await writeLaunchIntentRecord(this.policy, buildLaunchIntent(launchAttestation));
      this.launchPaths = reservedPaths;
    }
    const snapshotRoot = launchAuthoritySnapshotRoot(this.policy, command);
    // Populate the immutable authority image only after the intent is durable.
    // If this pass observes any source drift relative to the pre-reservation
    // digest, leave the intent as a conservative UNKNOWN fence and do not
    // enter child_process.
    const snapshotAuthority = await attestCodexHostAuthority(this.policy, command, snapshotRoot);
    if (!this.authority || snapshotAuthority.digest !== this.authority.digest) fail('Codex authority changed before spawn');
    // Darwin freezes the run root through process entry. Pre-create the
    // worker's deterministic report directory while it is still mutable, and
    // close its complete parent-chain durability barrier so the child never
    // needs to publish a new directory name under an immutable root.
    const reportDirectory = dirname(expectedReportPath(this.policy, command));
    await ensurePrivateDirectory(reportDirectory, 'Codex worker report directory');
    await syncDirectoryChain(reportDirectory, 'Codex worker report directory');
    this.launchBoundary = await bindLaunchDirectories(this.policy, descriptorBound);
    // A custom spawn/attestation pair is a documented test seam and may use a
    // synthetic executable digest/path. Production's real spawn path must
    // never fall back to a mutable pathname when image capture fails.
    this.executableImage = await copyImmutableExecutable(launchAttestation, snapshotRoot, this.policy.codexBinaryDigest, this.spawnProcess !== spawn);
    // Seal every copied authority object before taking the final Darwin
    // witness. The returned pre-seal identities let that synchronous witness
    // reject replacement even when bytes are restored exactly.
    const snapshotBeforeSeal = await sealAuthoritySnapshot(snapshotRoot, this.sealImmutable, this.simulatedImmutableFlags);
    // The pre-seal identities defend the sealing traversal itself; this
    // post-seal witness is the metadata baseline for the final synchronous
    // Darwin fence (chmod/chflags legitimately update ctime).
    const snapshotSealed = this.usesDarwinEntryFence ? snapshotWitnessesSync(snapshotRoot) : undefined;
    if (descriptorBound) this.launchAuthority = await bindLaunchAuthorityFiles(this.policy, command, snapshotRoot);
    if (!this.usesDarwinEntryFence) {
      // Recheck the immutable launch slot after reserving it. A stale
      // pre-upgrade process may have written launch.json without the intent;
      // never race it into a second child.
      if (await readLaunchRecord(this.policy, command.launchToken)) fail('launch record appeared after launch intent reservation');
      if (spec.signal?.aborted) fail('launch was cancelled before spawn');
      // The reservation write and slot check are asynchronous. Re-attest once
      // more after those awaits and immediately before entering child_process
      // so a replacement in that final gap cannot launch an image described
      // only by the earlier witness.
      attestationAtSpawn = await this.attest(this.policy);
      if (attestationAtSpawn.requestedPath !== this.policy.codexPath || attestationAtSpawn.version !== this.policy.codexVersion || attestationAtSpawn.digest !== this.policy.codexBinaryDigest
        || attestationAtSpawn.physicalPath !== launchAttestation.physicalPath || attestationAtSpawn.requestedPathIsSymlink !== launchAttestation.requestedPathIsSymlink
        || attestationAtSpawn.uid !== launchAttestation.uid || attestationAtSpawn.gid !== launchAttestation.gid || attestationAtSpawn.mode !== launchAttestation.mode) fail('Codex executable changed before spawn');
    }
    if (this.usesDarwinEntryFence) {
      // Release admission is the last asynchronous gate. From the root seals
      // below through spawn and their strict release there is no await.
      await assertReleaseAdmissionOpen(this.policy.runRoot);
      if (spec.signal?.aborted) fail('launch was cancelled before spawn');
      // macOS spawn(2) cannot use a directory descriptor as cwd. Seal both
      // pathname roots synchronously, then perform one complete synchronous
      // verification. There is intentionally no await, subprocess, or
      // mutable pathname operation between this fence and child_process.spawn.
      try {
        // Snapshot creation necessarily updates the run-root directory mtime;
        // capture the root/workspace witnesses after all launch preparation and
        // immediately before sealing rather than reusing the pre-reservation
        // identity-only witnesses used by Linux's asynchronous fence.
        const rootWitnessBeforeSeal = syncPathWitness(this.policy.runRoot);
        const workspaceWitnessBeforeSeal = syncPathWitness(this.policy.workspace);
        if (!rootWitnessBeforeSeal || !workspaceWitnessBeforeSeal) fail('Codex run root/workspace disappeared while sealing');
        // Record exact ownership before the first flag mutation so even a
        // partial seal failure can clear only flags placed on these inodes.
        this.entryRootWitnesses = Object.freeze({ runRoot: rootWitnessBeforeSeal, workspace: workspaceWitnessBeforeSeal });
        if (immutableFlagSync(this.policy.workspace, this.simulatedImmutableFlags, this.observeImmutable) || immutableFlagSync(this.policy.runRoot, this.simulatedImmutableFlags, this.observeImmutable)) fail('Codex run root/workspace was already immutable before entry sealing');
        this.immutableRoots = true;
        setImmutableSync(this.policy.workspace, true, this.sealImmutable, this.simulatedImmutableFlags);
        setImmutableSync(this.policy.runRoot, true, this.sealImmutable, this.simulatedImmutableFlags);
        const rootWitnessAtSeal = syncPathWitness(this.policy.runRoot);
        const workspaceWitnessAtSeal = syncPathWitness(this.policy.workspace);
        if (!rootWitnessBeforeSeal || !workspaceWitnessBeforeSeal || !rootWitnessAtSeal || !workspaceWitnessAtSeal) fail('Codex run root/workspace disappeared while sealing');
        this.entryRootWitnesses = Object.freeze({ runRoot: rootWitnessAtSeal, workspace: workspaceWitnessAtSeal });
        if (this.spawnProcess === spawn && !this.executableImage) fail('Codex launch executable image is unavailable');
        if (this.executableImage) verifySealedLaunchInputsSync({
          snapshotRoot,
          snapshotBefore: snapshotBeforeSeal,
          snapshotSealed: snapshotSealed ?? snapshotBeforeSeal,
          executablePath: this.executableImage.path,
          executableDigest: this.policy.codexBinaryDigest,
          runRoot: this.policy.runRoot,
          workspace: this.policy.workspace,
          runRootBefore: rootWitnessBeforeSeal,
          runRootSealed: rootWitnessAtSeal,
          workspaceBefore: workspaceWitnessBeforeSeal,
          workspaceSealed: workspaceWitnessAtSeal,
          simulatedFlags: this.simulatedImmutableFlags,
          observeImmutable: this.observeImmutable,
        });
        else if (!sameSyncPathWitness(this.executableWitness, executablePathWitness(attestationAtSpawn.requestedPath, attestationAtSpawn.physicalPath))) fail('Codex executable changed before spawn');
      }
      catch (error) {
        this.releaseImmutableRootsBestEffort();
        throw error;
      }
    } else {
      // Re-attest every parent-owned identity after the reservation and final
      // executable witness. The dynamic phase STEPS path is included by the
      // command-specific authority digest, so a mutation in this last await
      // window fences the child before it can observe the workspace.
      const runRootAtSpawn = await inspectTrustedPath(this.policy.runRoot, 'Codex run root', { surface: true, kind: 'directory' });
      const workspaceAtSpawn = await inspectTrustedPath(this.policy.workspace, 'Codex workspace', { surface: true, kind: 'directory' });
      if (!runRootAtSpawn || !workspaceAtSpawn || !sameFilesystemIdentity(trustedRunRoot.identity, runRootAtSpawn.identity) || !sameFilesystemIdentity(trustedWorkspace.identity, workspaceAtSpawn.identity)) fail('Codex run root/workspace changed before spawn');
      const authorityAtSpawn = await attestCodexHostAuthority(this.policy, command);
      if (!this.authority || authorityAtSpawn.digest !== this.authority.digest) fail('Codex authority changed before spawn');
      if (!sameSyncPathIdentity(rootWitness, syncPathWitness(this.policy.runRoot)) || !sameSyncPathIdentity(workspaceWitness, syncPathWitness(this.policy.workspace))) fail('Codex run root/workspace changed before spawn');
      if (!sameSyncPathWitness(this.executableWitness, executablePathWitness(attestationAtSpawn.requestedPath, attestationAtSpawn.physicalPath))) fail('Codex executable changed before spawn');
      if (spec.signal?.aborted) fail('launch was cancelled before spawn');
      await assertReleaseAdmissionOpen(this.policy.runRoot);
      if (spec.signal?.aborted) fail('launch was cancelled before spawn');
    }
    const spawnStdio: SpawnOptions['stdio'] = ['pipe', 'pipe', 'pipe'];
    if (descriptorBound) {
      (spawnStdio as Array<unknown>)[3] = this.executableImage?.fd ?? 'ignore';
      (spawnStdio as Array<unknown>)[4] = this.launchBoundary?.workspaceFd ?? 'ignore';
      (spawnStdio as Array<unknown>)[5] = this.launchBoundary?.runRootFd ?? 'ignore';
      this.launchAuthority?.handles.forEach((handle, index) => { (spawnStdio as Array<unknown>)[6 + index] = handle.fd; });
    }
    let child: ChildProcess;
    try {
      const immutableExecutablePath = (descriptorBound || this.usesDarwinEntryFence) ? this.executableImage?.path : undefined;
      child = this.spawnProcess(immutableExecutablePath ?? attestationAtSpawn.physicalPath, args, {
      cwd: this.launchBoundary?.cwd ?? this.policy.workspace,
      env: childEnvironment(this.policy),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: spawnStdio,
      } as SpawnOptions);
    } catch (error) {
      this.releaseImmutableRootsBestEffort();
      throw error;
    }
    this.child = child;
    this.childClosedPromise = new Promise<void>((resolvePromise) => { this.resolveChildClosed = resolvePromise; });
    // Keep the child observable if the strict synchronous post-entry
    // transition fails before launch publication. Event delivery cannot occur
    // inside the no-await transition, but these listeners let bounded teardown
    // settle once the event loop resumes.
    const onUnpublishedClose = (): void => { this.markChildClosed(); };
    const onUnpublishedError = (): void => { this.markChildClosed(); };
    child.once('close', onUnpublishedClose);
    child.once('error', onUnpublishedError);
    try {
      if (this.usesDarwinEntryFence) this.releaseEntryRootsAfterSpawnSync();
    } catch (error) {
      // Begin termination synchronously, then bound the owned-tree reap. No
      // launch record or success receipt exists at this point; the durable
      // one-shot intent remains the conservative retry fence.
      this.signalOwnedTree('SIGTERM');
      await this.terminateUnpublishedChild();
      child.removeListener('close', onUnpublishedClose);
      child.removeListener('error', onUnpublishedError);
      await this.cleanupAfterSettlement();
      fail(`post-entry run-root/workspace immutable release failed before launch publication: ${(error as Error).message}`);
    }
    const childPid = child.pid;
    if (!Number.isSafeInteger(childPid) || (childPid as number) < 1) {
      this.signalOwnedTree('SIGTERM');
      await this.terminateUnpublishedChild();
      child.removeListener('close', onUnpublishedClose);
      child.removeListener('error', onUnpublishedError);
      fail('Codex child did not expose a valid pid');
    }
    child.removeListener('close', onUnpublishedClose);
    child.removeListener('error', onUnpublishedError);
    this.onStdoutData = (chunk: unknown) => boundedPush(this.stdout, chunk, this.policy.maxOutputBytes);
    this.onStderrData = (chunk: unknown) => boundedPush(this.stderr, chunk, this.policy.maxErrorBytes);
    child.stdout?.on('data', this.onStdoutData);
    child.stderr?.on('data', this.onStderrData);
    const launch: LaunchRecord = Object.freeze({
      schema: 'lunacy-codex-launch/v1', launchToken: command.launchToken, commandDigest: command.commandDigest, commandId: command.commandId,
      runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attempt: command.attemptEpoch, attemptEpoch: command.attemptEpoch,
      authorityEpoch: command.authorityEpoch, barrierEpoch: command.barrierEpoch, policyDigest: codexHostPolicyDigest(this.policy), handoffDigest: handoff.digest,
      authorityDigest: this.authority.digest,
      argvDigest: digest(args), codexPath: attestationAtSpawn.requestedPath, codexVersion: attestationAtSpawn.version, codexBinaryDigest: attestationAtSpawn.digest,
      workspace: this.policy.workspace, supervisor: { pid: process.pid }, child: { pid: childPid as number }, startedAt,
    });
    this.launch = launch;
    let launchWritten: ReturnType<typeof writeLaunchRecord>;
    launchWritten = this.writeLaunch(this.policy, launch);
    this.terminalPromise = new Promise<TerminalRecord>((resolvePromise, rejectPromise) => { this.resolveTerminal = resolvePromise; this.rejectTerminal = rejectPromise; });
    // start() can fail after the promise is created but before returning a
    // launch receipt. Keep that rejection observable to explicit waiters
    // without creating an unhandled-rejection process hazard.
    void this.terminalPromise.catch(() => undefined);
    this.onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      this.markChildClosed();
      void launchWritten.then(() => this.startFinish(code, signal)).catch((error) => this.rejectTerminal?.(error));
    };
    this.onChildError = (error: Error): void => {
      this.markChildClosed();
      // A child error can arrive without close on mocked/process-failure
      // implementations.  Preserve the first error as bounded terminal data.
      if (!this.terminalPromise) return;
      void launchWritten.then(() => this.startFinish(null, null, error)).catch((cause) => this.rejectTerminal?.(cause));
    };
    child.once('close', this.onChildClose);
    child.once('error', this.onChildError);
    try {
      await launchWritten;
    } catch (error) {
      await this.terminateUnpublishedChild();
      await this.cleanupAfterSettlement();
      this.rejectTerminal?.(error);
      throw error;
    }
    this.timeoutTimer = setTimeout(() => { void this.cancel(); }, this.policy.timeoutMs);
    if (spec.signal) {
      this.launchSignal = spec.signal;
      this.onLaunchAbort = (): void => { void this.cancel(); };
      spec.signal.addEventListener('abort', this.onLaunchAbort, { once: true });
    }
    if (spec.signal?.aborted) await this.cancel();
    else {
      try { child.stdin?.end(`${handoff.text}`); } catch (error) { await this.cancel(); throw error; }
    }
    return launch;
    } catch (error) {
      await this.cleanupAfterSettlement();
      throw error;
    }
  }

  async wait(): Promise<TerminalRecord> {
    if (!this.terminalPromise) fail('supervisor has not started');
    return this.terminalPromise;
  }

  async cancel(): Promise<void> {
    if (!this.child || this.finished) return;
    this.cancellationPromise ??= this.terminatePublishedChild();
    await this.cancellationPromise;
  }

  async terminal(): Promise<TerminalRecord | undefined> {
    if (!this.token) return undefined;
    const record = await readTerminalRecord(this.policy, this.token);
    if (!record) return undefined;
    try { await this.verifyBoundary(); } catch { return undefined; }
    return record;
  }

  /** Re-attest the immutable launch's authority before exposing terminal
   * evidence.  This is also used by the live driver path; restart callers use
   * verifyCodexHostBoundary directly against the persisted launch record. */
  async verifyBoundary(): Promise<void> {
    if (!this.launch) fail('supervisor has not started');
    await verifyCodexHostBoundary(this.policy, this.launch, this.attest);
  }

  private markChildClosed(): void {
    if (this.childClosed) return;
    this.childClosed = true;
    this.resolveChildClosed?.();
    this.resolveChildClosed = undefined;
  }

  private signalOwnedTree(signal: NodeJS.Signals): void {
    const child = this.child; const pid = child?.pid;
    if (!child) return;
    if (Number.isSafeInteger(pid) && (pid as number) > 0) {
      try {
        if (this.signalProcessTreeOverride) this.signalProcessTreeOverride(pid as number, signal);
        else if (this.spawnProcess === spawn && process.platform !== 'win32') process.kill(-(pid as number), signal);
      } catch { /* the group may already have exited */ }
    }
    try { child.kill(signal); } catch { /* terminal/close evidence remains authoritative */ }
  }

  private async waitForChildClose(graceMs: number): Promise<boolean> {
    if (this.childClosed) return true;
    // Zero grace still advances through every signal stage. Yield once so a
    // synchronous fake/host close emitted by the signal can be observed.
    if (graceMs === 0) { await Promise.resolve(); return this.childClosed; }
    const close = this.childClosedPromise ?? Promise.resolve();
    await Promise.race([
      close,
      new Promise<void>((resolvePromise) => { this.reapTimer = setTimeout(resolvePromise, graceMs); }),
    ]);
    if (this.reapTimer) clearTimeout(this.reapTimer);
    this.reapTimer = undefined;
    return this.childClosed;
  }

  private async terminatePublishedChild(): Promise<void> {
    this.cancelled = true;
    const signals = ['SIGINT', 'SIGTERM', 'SIGKILL'] as const;
    for (const [index, signal] of signals.entries()) {
      this.signalOwnedTree(signal);
      // A zero policy grace advances immediately through interrupt/terminate,
      // but hard-kill still gets one short bounded event-loop reap window.
      const grace = index === signals.length - 1 ? Math.max(this.policy.cancellationGraceMs, MIN_HARD_REAP_MS) : this.policy.cancellationGraceMs;
      if (await this.waitForChildClose(grace)) {
        await this.terminalPromise?.catch(() => undefined);
        return;
      }
    }
    await this.startUnresolvedFinish();
    await this.terminalPromise?.catch(() => undefined);
  }

  private async terminateUnpublishedChild(): Promise<void> {
    this.cancelled = true;
    const signals = ['SIGINT', 'SIGTERM', 'SIGKILL'] as const;
    for (const [index, signal] of signals.entries()) {
      this.signalOwnedTree(signal);
      const grace = index === signals.length - 1 ? Math.max(this.policy.cancellationGraceMs, MIN_HARD_REAP_MS) : this.policy.cancellationGraceMs;
      if (await this.waitForChildClose(grace)) return;
    }
  }

  private startFinish(code: number | null, signal: NodeJS.Signals | null, processError?: unknown): Promise<void> {
    this.finishTask ??= this.finish(code, signal, processError);
    return this.finishTask;
  }

  private startUnresolvedFinish(): Promise<void> {
    this.finishTask ??= this.finishUnresolved();
    return this.finishTask;
  }

  private async finishUnresolved(): Promise<void> {
    if (!this.launch || !this.token || !this.commandDigest || this.finished) return;
    this.finished = true;
    const terminal: TerminalRecord = Object.freeze({
      schema: 'lunacy-codex-terminal/v1', launchToken: this.token, commandDigest: this.commandDigest,
      status: 'UNKNOWN', outcome: 'unresolved-termination', exitCode: null, signal: null,
      resultDigest: null, reportPath: null, reportDigest: null,
      eventsDigest: sha256(this.stdout.text), finishedAt: this.now().toISOString(),
    });
    try {
      await writeTerminalRecord(this.policy, terminal);
      await this.cleanupAfterSettlement();
      this.resolveTerminal?.(validateTerminalRecord(terminal));
    } catch (error) {
      await this.cleanupAfterSettlement();
      this.rejectTerminal?.(error);
    }
  }

  private async finish(code: number | null, signal: NodeJS.Signals | null, processError?: unknown): Promise<void> {
    if (!this.launch || !this.token || !this.commandDigest || this.finished) return;
    this.finished = true;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
    try {
      const paths = this.launchPaths ?? effectPaths(this.policy, this.token);
      const finalState = await this.readFinal(paths.output);
      let outputDurable = true;
      if (finalState.kind !== 'absent') {
        try { await syncFile(paths.output, 'Codex final output'); await syncDirectory(dirname(paths.output), 'Codex final output directory'); }
        catch { outputDurable = false; }
      }
      const finalStateOversizedOrUnreadable = finalState.kind === 'oversized' || finalState.kind === 'unreadable';
      const outcome = processError || this.stdout.overflow || this.stderr.overflow || finalStateOversizedOrUnreadable || !outputDurable ? 'process-failure' : classifyOutcome(this.stdout.text, this.stderr.text, code, safeSignal(signal), this.cancelled);
      let status: TerminalStatus = terminalStatus(outcome, finalState.result?.status);
      let reportPath: string | null = null; let reportDigest: string | null = null;
      if (outcome === 'normal-completion' && finalState.result) {
        const expected = expectedReportPath(this.policy, this.launch);
        if (finalState.result.reportPath !== expected) status = 'BLOCKED';
        else {
          const report = await this.verifyReport(expected, finalState.result.reportDigest, finalState.result.status);
          if (report) {
            try {
              await syncFile(expected, 'Codex worker report');
              await syncDirectory(dirname(expected), 'Codex worker report directory');
              reportPath = expected; reportDigest = report.digest;
            }
            catch { status = 'BLOCKED'; }
          }
          else status = 'BLOCKED';
        }
      }
      const terminal: TerminalRecord = Object.freeze({
        schema: 'lunacy-codex-terminal/v1', launchToken: this.token, commandDigest: this.commandDigest, status,
        outcome: outcome === 'normal-completion' && finalState.kind === 'absent' ? 'absent-final-output' : (outcome === 'normal-completion' && (finalState.kind !== 'ok' || !finalState.result) ? 'malformed-final-output' : (outcome === 'normal-completion' && finalState.result && status === 'BLOCKED' && !reportPath ? 'malformed-final-output' : outcome)),
        exitCode: code, signal: safeSignal(signal), resultDigest: 'digest' in finalState ? finalState.digest : null, reportPath, reportDigest, eventsDigest: sha256(this.stdout.text), finishedAt: this.now().toISOString(),
      });
      try {
        await writeTerminalRecord(this.policy, terminal);
        await this.cleanupAfterSettlement();
        this.resolveTerminal?.(validateTerminalRecord(terminal));
      }
      catch (error) { await this.cleanupAfterSettlement(); this.rejectTerminal?.(error); }
    } catch (error) {
      await this.cleanupAfterSettlement();
      this.rejectTerminal?.(error);
    }
  }

  private async cleanupAfterSettlement(): Promise<void> {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.reapTimer) clearTimeout(this.reapTimer);
    this.timeoutTimer = undefined; this.reapTimer = undefined;
    if (this.launchSignal && this.onLaunchAbort) this.launchSignal.removeEventListener('abort', this.onLaunchAbort);
    this.launchSignal = undefined; this.onLaunchAbort = undefined;
    const child = this.child;
    if (child) {
      if (this.onChildClose) child.removeListener('close', this.onChildClose);
      if (this.onChildError) child.removeListener('error', this.onChildError);
      if (this.onStdoutData) child.stdout?.removeListener('data', this.onStdoutData);
      if (this.onStderrData) child.stderr?.removeListener('data', this.onStderrData);
      try { (child.stdin as { destroy?: () => void } | null)?.destroy?.(); } catch { /* best effort */ }
      try { child.stdout?.destroy(); } catch { /* best effort */ }
      try { child.stderr?.destroy(); } catch { /* best effort */ }
    }
    this.child = undefined;
    this.onChildClose = undefined; this.onChildError = undefined;
    this.onStdoutData = undefined; this.onStderrData = undefined;
    this.resolveChildClosed = undefined; this.childClosedPromise = undefined;
    await this.releaseLaunchInputs();
    this.simulatedImmutableFlags.clear();
  }

  private async releaseLaunchInputs(): Promise<void> {
    this.releaseImmutableRootsBestEffort();
    const image = this.executableImage; this.executableImage = undefined;
    const boundary = this.launchBoundary; this.launchBoundary = undefined;
    const authority = this.launchAuthority; this.launchAuthority = undefined;
    await image?.cleanup().catch(() => undefined);
    await authority?.cleanup().catch(() => undefined);
    await boundary?.cleanup().catch(() => undefined);
  }

  private releaseEntryRootsAfterSpawnSync(): void {
    const witnesses = this.entryRootWitnesses;
    if (!this.immutableRoots || !witnesses) fail('Darwin entry flags are not owned by this launch');
    const release = (path: string, witness: SyncPathWitness, label: string): void => {
      if (!sameSyncPathIdentity(witness, syncPathWitness(path))) fail(`${label} identity changed before post-entry immutable release`);
      if (!immutableFlagSync(path, this.simulatedImmutableFlags, this.observeImmutable)) fail(`${label} immutable flag was lost before post-entry release`);
      setImmutableSync(path, false, this.sealImmutable, this.simulatedImmutableFlags);
      if (!sameSyncPathIdentity(witness, syncPathWitness(path))) fail(`${label} identity changed during post-entry immutable release`);
      if (immutableFlagSync(path, this.simulatedImmutableFlags, this.observeImmutable)) fail(`${label} remained immutable after child entry`);
    };
    release(this.policy.workspace, witnesses.workspace, 'Codex workspace');
    release(this.policy.runRoot, witnesses.runRoot, 'Codex run root');
    if (!sameSyncPathIdentity(witnesses.workspace, syncPathWitness(this.policy.workspace)) || !sameSyncPathIdentity(witnesses.runRoot, syncPathWitness(this.policy.runRoot))) fail('Codex run root/workspace changed during post-entry immutable release');
    if (immutableFlagSync(this.policy.workspace, this.simulatedImmutableFlags, this.observeImmutable) || immutableFlagSync(this.policy.runRoot, this.simulatedImmutableFlags, this.observeImmutable)) fail('Codex run root/workspace remained immutable after child entry');
    this.immutableRoots = false;
    this.entryRootWitnesses = undefined;
  }

  private releaseImmutableRootsBestEffort(): void {
    if (!this.immutableRoots) return;
    const witnesses = this.entryRootWitnesses;
    this.immutableRoots = false;
    this.entryRootWitnesses = undefined;
    const release = (path: string, witness: SyncPathWitness | undefined): void => {
      if (!witness || !sameSyncPathIdentity(witness, syncPathWitness(path))) return;
      try {
        if (immutableFlagSync(path, this.simulatedImmutableFlags, this.observeImmutable)) setImmutableSync(path, false, this.sealImmutable, this.simulatedImmutableFlags);
      } catch { /* preserve conservative intent/terminal evidence */ }
    };
    release(this.policy.workspace, witnesses?.workspace);
    release(this.policy.runRoot, witnesses?.runRoot);
  }

  private async readFinal(path: string): Promise<Awaited<ReturnType<typeof readBoundedUtf8File>> & { result?: CodexWorkerResult }> {
    const evidence = await readBoundedUtf8File(path, 'Codex final output', this.policy.maxOutputBytes);
    if (evidence.kind !== 'ok') return evidence;
    // Codex structured output is validated at this closed boundary; property
    // order is intentionally independent while duplicate keys are rejected.
    const result = parseWorkerResultText(evidence.text);
    return { ...evidence, result: result ?? undefined };
  }

  private async attestWorkerSchema(): Promise<void> {
    const trusted = await inspectTrustedPath(this.policy.workerSchemaPath, 'Codex worker schema', { surface: true, kind: 'file' });
    if (!trusted || trusted.stat.size > this.policy.maxOutputBytes) fail('worker schema is absent or oversized');
    const bytes = await fs.readFile(this.policy.workerSchemaPath);
    const after = await inspectTrustedPath(this.policy.workerSchemaPath, 'Codex worker schema', { surface: true, kind: 'file' });
    if (!after || !sameFilesystemIdentity(trusted.identity, after.identity)) fail('worker schema changed during attestation');
    if (sha256(bytes) !== this.policy.workerSchemaDigest) fail('worker schema digest changed');
  }

  private async verifyReport(path: string, expectedDigest: string, expectedStatus: string): Promise<{ digest: string } | undefined> {
    const absolute = resolve(path);
    if (!pathWithin(this.policy.runRoot, absolute)) return undefined;
    const report = await readBoundedUtf8File(absolute, 'worker report', this.policy.maxReportBytes);
    if (report.kind !== 'ok' || report.digest !== expectedDigest || reportControlStatus(report.text) !== expectedStatus) return undefined;
    return { digest: report.digest };
  }
}

export type CodexExecSupervisorDriver = EffectDriver & {
  terminal?(launchToken: string): Promise<TerminalRecord | undefined>;
  cancel?(launchToken: string): Promise<void>;
};
