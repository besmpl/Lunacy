import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { canonicalString, digest, parseCanonical } from './canonical.js';
import {
  EFFECT_DIRECTORY, MAX_EFFECT_RECORD_BYTES, readBoundedUtf8File, reportControlStatus,
  validateLaunchIntentRecord, validateLaunchRecord, validateTerminalRecord,
  type LaunchIntentRecord, type LaunchRecord, type TerminalRecord,
} from './codex-effect-records.js';
import { parseWorkerResultText } from './codex-host-policy.js';
import { inspectTrustedPath, sameFilesystemIdentity } from './filesystem.js';
import type { MachineState, OutboxCommand, Ref } from './model.js';
import { FileArtifactStore, isCanonicalRootPath } from './store.js';

const SHA256 = /^[0-9a-f]{64}$/;
const EFFECT_ENTRY = /^[0-9a-f]{64}$/;
const PROCESS_SNAPSHOT_SCHEMA = 'lunacy-process-snapshot/v1';
const DEPLOYMENT_RESIDUE = /^(?:\.lunacy-release-exclusion\.lock|\.lunacy-runtime-deploy\.(?:json|lock)|\.lunacy-runtime-deploy\.json\.tmp-.+|\.lunacy-runtime-(?:stage|backup|failed)-.+)$/;
const MAX_TARGET_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PROCESS_COUNT = 131_072;
const MAX_RUN_ROOTS = 4_096;
const MAX_TARGET_ENTRIES = 4_096;
const MAX_EFFECT_ENTRIES = 65_536;

export type ProcessSnapshotRecord = Readonly<{
  pid: number; ppid: number; pgid: number; startedAt: string; executable: string; argv: readonly string[];
}>;
export type ProcessSnapshot = Readonly<{
  schema: typeof PROCESS_SNAPSHOT_SCHEMA; capturedAt: string; processes: readonly ProcessSnapshotRecord[];
}>;
export type ReleaseQuiescenceInput = Readonly<{
  installedTarget: string; runRoots: readonly string[]; processSnapshot: unknown; selfPid?: number;
  /** Private proof supplied only by the continuous release operation. */
  releaseOwnership?: Readonly<{
    ownerBytes: string;
    releaseClaimPaths: readonly string[];
    bridgeClaimPaths: readonly string[];
    writerClaimPaths: readonly string[];
    targetLock?: Readonly<{ path: string; bytes: string }>;
  }>;
}>;
export type ReleaseQuiescenceReport = Readonly<{
  status: 'QUIESCENT'; installedTarget: string; runRoots: readonly string[]; runCount: number;
  effectCount: number; processCount: number; capturedAt: string;
}>;

export type ReleaseGenerationClassification = 'DIRECT' | 'MANAGED_WITHOUT_ROLLOUT' | 'MANAGED_ROLLOUT';
export type ReleaseGenerationCensusRow = Readonly<{
  root: string;
  classification: ReleaseGenerationClassification;
  generations: readonly number[];
  storeGeneration: number;
  stateDigest: string;
  metadataDigest: string;
  rootIdentity: Readonly<{ dev: string; ino: string }>;
}>;
export type ReleaseGenerationCensus = Readonly<{
  candidateFloor: number;
  maximumSupportedGeneration: number | null;
  roots: readonly ReleaseGenerationCensusRow[];
  digest: string;
}>;
export type ReleaseGenerationCensusInput = Readonly<{
  installedTarget: string;
  runRoots: readonly string[];
  candidateFloor: number;
  quiescence: ReleaseQuiescenceReport;
  releaseOwnership: NonNullable<ReleaseQuiescenceInput['releaseOwnership']>;
}>;

/** Private production-only predecessor-release gate. The deployment tool
 * calls this only for the closed v2 0.2.12 -> 0.3.0 operation. */
export type ExactLegacyDeployQuiescenceInput = ReleaseQuiescenceInput & Readonly<{ runRoots: readonly string[] }>;

type EffectChain = Readonly<{ launch: LaunchRecord; terminal: TerminalRecord; copiedExecutable: string }>;

function fail(message: string): never { throw new Error(`ReleaseQuiescence: ${message}`); }
function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(); const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) fail(`${label} fields are not closed`);
}
function safeInteger(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (positive ? (value as number) <= 0 : (value as number) < 0)) fail(`${label} is invalid`);
  return value as number;
}
function validDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`${label} is invalid`);
  return value;
}
function canonicalPath(value: unknown, label: string): string {
  if (!isCanonicalRootPath(value)) fail(`${label} is not an absolute canonical path`);
  return value;
}
function within(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function sha256(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
function tokenDirectory(token: string): string { return sha256(token); }

async function boundedDigest(path: string, label: string, limit: number): Promise<string> {
  const before = await inspectTrustedPath(path, label, { surface: true, kind: 'file' }).catch((error) => fail(`${label} is unreadable: ${(error as Error).message}`));
  if (!before || !Number.isSafeInteger(before.stat.size) || before.stat.size < 0 || before.stat.size > limit) fail(`${label} is absent or exceeds its byte limit`);
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => fail(`${label} cannot be opened: ${(error as Error).message}`));
  const state = createHash('sha256'); let total = 0; const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || String(stat.dev) !== before.identity.dev || String(stat.ino) !== before.identity.ino || stat.size !== before.stat.size) fail(`${label} changed before descriptor binding`);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead; if (total > stat.size || total > limit) fail(`${label} changed during bounded read`);
      state.update(buffer.subarray(0, bytesRead));
    }
    if (total !== stat.size) fail(`${label} changed during bounded read`);
  } finally { await handle.close(); }
  const after = await inspectTrustedPath(path, label, { surface: true, kind: 'file' }).catch(() => undefined);
  if (!after || !sameFilesystemIdentity(before.identity, after.identity) || after.stat.size !== before.stat.size) fail(`${label} changed during read`);
  return state.digest('hex');
}

async function boundedCanonical(path: string, label: string, limit: number, trailingNewline = false): Promise<{ text: string; value: unknown }> {
  const before = await inspectTrustedPath(path, label, { surface: true, kind: 'file' }).catch((error) => fail(`${label} is unreadable: ${(error as Error).message}`));
  if (!before) fail(`${label} is absent`);
  if (!Number.isSafeInteger(before.stat.size) || before.stat.size < 0 || before.stat.size > limit) fail(`${label} exceeds its byte limit`);
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => fail(`${label} cannot be opened: ${(error as Error).message}`));
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || String(stat.dev) !== before.identity.dev || String(stat.ino) !== before.identity.ino) fail(`${label} changed before descriptor binding`);
    bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size || bytes.byteLength > limit) fail(`${label} changed during bounded read`);
  } finally { await handle.close(); }
  const after = await inspectTrustedPath(path, label, { surface: true, kind: 'file' }).catch(() => undefined);
  if (!after || !sameFilesystemIdentity(before.identity, after.identity)) fail(`${label} changed during read`);
  const text = bytes!.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes!)) fail(`${label} is not valid UTF-8`);
  const canonical = trailingNewline && text.endsWith('\n') ? text.slice(0, -1) : text;
  try {
    const value = parseCanonical(canonical);
    if (trailingNewline && text !== `${canonicalString(value)}\n`) fail(`${label} is not canonical JSON`);
    return { text: canonical, value };
  }
  catch (error) { fail(`${label} is not canonical JSON: ${(error as Error).message}`); }
}

async function boundedDirectoryEntries(path: string, label: string, limit: number): Promise<import('node:fs').Dirent[]> {
  const before = await inspectTrustedPath(path, label, { surface: true, kind: 'directory' }).catch((error) => fail(`${label} is unreadable: ${(error as Error).message}`));
  if (!before) fail(`${label} is absent`);
  const directory = await fs.opendir(path).catch((error) => fail(`${label} cannot be enumerated: ${(error as Error).message}`));
  const entries: import('node:fs').Dirent[] = [];
  try {
    for await (const entry of directory) {
      if (entries.length >= limit) fail(`${label} entry limit is exceeded`);
      entries.push(entry);
    }
  } finally { await directory.close().catch(() => undefined); }
  const after = await inspectTrustedPath(path, label, { surface: true, kind: 'directory' }).catch(() => undefined);
  if (!after || !sameFilesystemIdentity(before.identity, after.identity)) fail(`${label} changed during enumeration`);
  return entries;
}

function parseProcessSnapshot(value: unknown): ProcessSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('process snapshot is malformed');
  const object = value as Record<string, unknown>;
  exactKeys(object, ['schema', 'capturedAt', 'processes'], 'process snapshot');
  if (object.schema !== PROCESS_SNAPSHOT_SCHEMA || !Array.isArray(object.processes) || object.processes.length > MAX_PROCESS_COUNT) fail('process snapshot is malformed');
  const capturedAt = validDate(object.capturedAt, 'process snapshot capturedAt');
  const capturedTime = Date.parse(capturedAt); const pids = new Set<number>();
  const processes = object.processes.map((candidate, index): ProcessSnapshotRecord => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail(`process ${index} is malformed`);
    const record = candidate as Record<string, unknown>;
    exactKeys(record, ['pid', 'ppid', 'pgid', 'startedAt', 'executable', 'argv'], `process ${index}`);
    const pid = safeInteger(record.pid, `process ${index} pid`, true);
    if (pids.has(pid)) fail(`process pid ${pid} is duplicated`); pids.add(pid);
    const ppid = safeInteger(record.ppid, `process ${index} ppid`);
    const pgid = safeInteger(record.pgid, `process ${index} pgid`, true);
    const startedAt = validDate(record.startedAt, `process ${index} startedAt`);
    if (Date.parse(startedAt) > capturedTime) fail(`process ${index} starts after the snapshot`);
    const executable = canonicalPath(record.executable, `process ${index} executable`);
    if (!Array.isArray(record.argv) || record.argv.length === 0 || record.argv.length > 4096 || !record.argv.every((token) => typeof token === 'string' && token.length > 0 && !token.includes('\0'))) fail(`process ${index} argv is invalid`);
    return Object.freeze({ pid, ppid, pgid, startedAt, executable, argv: Object.freeze([...record.argv]) });
  });
  return Object.freeze({ schema: PROCESS_SNAPSHOT_SCHEMA, capturedAt, processes: Object.freeze(processes) });
}

async function exactOwnedBytes(path: string, expected: string, label: string): Promise<void> {
  const before = await inspectTrustedPath(path, label, { surface: true, kind: 'file' }).catch((error) => fail(`${label} is unreadable: ${(error as Error).message}`));
  if (!before || before.stat.size < 1 || before.stat.size > MAX_TARGET_MANIFEST_BYTES) fail(`${label} is absent or too large`);
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  const after = await inspectTrustedPath(path, label, { surface: true, kind: 'file' }).catch(() => undefined);
  if (!after || !sameFilesystemIdentity(before.identity, after.identity) || bytes.toString('utf8') !== expected || !Buffer.from(expected, 'utf8').equals(bytes)) fail(`${label} ownership changed`);
}

async function validateReleaseOwnership(ownership: NonNullable<ReleaseQuiescenceInput['releaseOwnership']>, installedTarget: string, roots: readonly string[]): Promise<void> {
  if (typeof ownership.ownerBytes !== 'string' || ownership.ownerBytes.length < 1 || Buffer.byteLength(ownership.ownerBytes) > MAX_TARGET_MANIFEST_BYTES) fail('release owner bytes are invalid');
  for (const [label, paths] of [['release', ownership.releaseClaimPaths], ['bridge', ownership.bridgeClaimPaths], ['writer', ownership.writerClaimPaths]] as const) {
    if (!Array.isArray(paths) || new Set(paths).size !== paths.length) fail(`${label} ownership paths are invalid`);
    for (const [index, path] of paths.entries()) canonicalPath(path, `${label} ownership path ${index}`);
  }
  const expectedBridge = roots.map((root) => join(root, '.kernel', '.bridge.lock'));
  const expectedWriter = roots.map((root) => join(root, '.kernel', '.writer.lock'));
  if (canonicalString(ownership.bridgeClaimPaths) !== canonicalString(expectedBridge) || canonicalString(ownership.writerClaimPaths) !== canonicalString(expectedWriter)) fail('per-run release ownership is not exact');
  const targetRelease = join(installedTarget, '.lunacy-release-exclusion.lock');
  if (!ownership.releaseClaimPaths.includes(targetRelease)) fail('installed target release ownership is absent');
  for (const path of ownership.releaseClaimPaths) await exactOwnedBytes(path, ownership.ownerBytes, 'release ownership claim');
  if (!ownership.targetLock || ownership.targetLock.path !== join(installedTarget, '.lunacy-runtime-deploy.lock') || typeof ownership.targetLock.bytes !== 'string' || ownership.targetLock.bytes.length < 1) fail('target transaction ownership is absent');
  await exactOwnedBytes(ownership.targetLock.path, ownership.targetLock.bytes, 'target transaction ownership');
}

async function validateInstalledTarget(path: string, ownership?: ReleaseQuiescenceInput['releaseOwnership'], requireCurrentReleaseFiles = true): Promise<{ path: string; bridgeVersion: string; runtimeVersion: string }> {
  const target = canonicalPath(path, 'installed target');
  const trusted = await inspectTrustedPath(target, 'installed target', { surface: true, kind: 'directory' }).catch((error) => fail(`installed target is unreadable: ${(error as Error).message}`));
  if (!trusted) fail('installed target is absent');
  const entries = await boundedDirectoryEntries(target, 'installed target', MAX_TARGET_ENTRIES);
  const allowed = new Map<string, string>();
  for (const claim of ownership?.releaseClaimPaths ?? []) allowed.set(claim, ownership!.ownerBytes);
  if (ownership?.targetLock) allowed.set(ownership.targetLock.path, ownership.targetLock.bytes);
  for (const entry of entries) if (DEPLOYMENT_RESIDUE.test(entry.name)) {
    const residue = join(target, entry.name); const expected = allowed.get(residue);
    if (expected === undefined) fail(`installed target has deployment residue ${entry.name}`);
    await exactOwnedBytes(residue, expected, `owned deployment claim ${entry.name}`);
  }
  const runtime = join(target, 'runtime');
  const runtimeTrusted = await inspectTrustedPath(runtime, 'installed runtime', { surface: true, kind: 'directory' }).catch((error) => fail(`installed runtime is unreadable: ${(error as Error).message}`));
  if (!runtimeTrusted) fail('installed runtime is absent');
  const requiredFiles = requireCurrentReleaseFiles
    ? ['bridge.mjs', 'schemas/codex-terminal-record.schema.json', 'dist/store.js', 'dist/codex-effect-records.js']
    : ['bridge.mjs'];
  for (const required of requiredFiles) {
    const item = await inspectTrustedPath(join(runtime, required), `installed runtime ${required}`, { surface: true, kind: 'file' }).catch((error) => fail(`installed runtime ${required} is unreadable: ${(error as Error).message}`));
    if (!item) fail(`installed runtime ${required} is absent`);
  }
  const { value } = await boundedCanonical(join(runtime, 'DEPLOYMENT.json'), 'installed deployment manifest', MAX_TARGET_MANIFEST_BYTES, true);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('installed deployment manifest is malformed');
  const manifest = value as Record<string, unknown>;
  exactKeys(manifest, ['schema', 'bridgeVersion', 'runtimeVersion', 'sourceDigest', 'files', 'launcherDigest'], 'installed deployment manifest');
  if (manifest.schema !== 1 || typeof manifest.bridgeVersion !== 'string' || typeof manifest.runtimeVersion !== 'string' || !SHA256.test(String(manifest.sourceDigest)) || !SHA256.test(String(manifest.launcherDigest)) || !Array.isArray(manifest.files) || manifest.files.length === 0) fail('installed deployment manifest is malformed');
  const files = manifest.files as unknown[];
  if (!files.every((file) => typeof file === 'string' && file.startsWith('runtime/') && !file.includes('\\') && !file.split('/').some((part) => part === '' || part === '.' || part === '..'))) fail('installed deployment manifest files are unsafe');
  if (new Set(files).size !== files.length) fail('installed deployment manifest files are duplicated');
  return { path: target, bridgeVersion: manifest.bridgeVersion, runtimeVersion: manifest.runtimeVersion } as { path: string; bridgeVersion: string; runtimeVersion: string };
}

function sameLaunchIdentity(intent: LaunchIntentRecord, launch: LaunchRecord): boolean {
  const { schema: _intentSchema, ...intentBody } = intent;
  const { schema: _launchSchema, child: _child, ...launchBody } = launch;
  return canonicalString(intentBody) === canonicalString(launchBody);
}

function validateReceipt(command: OutboxCommand, launch: LaunchRecord, launchText: string): void {
  const receipt = command.receipt;
  if (!receipt?.bytes) fail(`outbox ${command.commandId} has no durable launch receipt`);
  let outer: Record<string, unknown>;
  try { outer = parseCanonical<Record<string, unknown>>(receipt.bytes); }
  catch { fail(`outbox ${command.commandId} receipt is not canonical`); }
  exactKeys(outer!, ['launchToken', 'commandDigest', 'receipt'], `outbox ${command.commandId} receipt`);
  if (outer!.launchToken !== command.launchToken || outer!.commandDigest !== command.commandDigest || digest(outer!) !== receipt.digest || receipt.id !== `receipt:${command.launchToken}` || receipt.scope !== 'outbox/receipt') fail(`outbox ${command.commandId} receipt binding is invalid`);
  const inner = outer!.receipt as Ref;
  if (!inner || typeof inner !== 'object' || typeof inner.bytes !== 'string') fail(`outbox ${command.commandId} inner launch receipt is absent`);
  exactKeys(inner, ['id', 'scope', 'digest', 'bytes'], `outbox ${command.commandId} inner launch receipt`);
  let parsed: LaunchRecord;
  try { parsed = validateLaunchRecord(parseCanonical(inner.bytes)); }
  catch { fail(`outbox ${command.commandId} inner launch receipt is invalid`); }
  if (inner.id !== `codex-launch:${command.launchToken}` || inner.scope !== 'codex/effect/launch' || inner.digest !== digest(parsed!) || inner.bytes !== launchText || canonicalString(parsed!) !== canonicalString(launch)) fail(`outbox ${command.commandId} launch receipt disagrees with launch evidence`);
}

function validateJournalChain(state: MachineState, command: OutboxCommand, terminal: TerminalRecord): void {
  const receipts = state.journal.filter((entry) => entry.identity.launchToken === command.launchToken && entry.event.kind === 'DISPATCH_RECEIPT');
  if (receipts.length !== 1 || canonicalString((receipts[0]!.event as Extract<MachineState['journal'][number]['event'], { kind: 'DISPATCH_RECEIPT' }>).ref) !== canonicalString(command.receipt)) fail(`outbox ${command.commandId} receipt is not bound exactly once in the journal`);
  const envelopes = state.journal.filter((entry) => entry.identity.launchToken === command.launchToken && entry.event.kind === 'WORKER_ENVELOPE');
  if (envelopes.length !== 1) fail(`outbox ${command.commandId} terminal has no unique worker envelope`);
  const expected = terminal.status === 'PASS' ? 'DONE' : terminal.status;
  let envelope: Record<string, unknown>;
  try { envelope = parseCanonical<Record<string, unknown>>((envelopes[0]!.event as Extract<MachineState['journal'][number]['event'], { kind: 'WORKER_ENVELOPE' }>).ref.bytes ?? ''); }
  catch { fail(`outbox ${command.commandId} worker envelope is invalid`); }
  if (canonicalString(envelope!) !== canonicalString({ status: expected })) fail(`outbox ${command.commandId} terminal disagrees with worker envelope`);
}

async function validateEffectChain(root: string, state: MachineState, command: OutboxCommand): Promise<EffectChain> {
  if (command.state !== 'ACKED') fail(`outbox ${command.commandId} is ${command.state}`);
  const directory = join(root, EFFECT_DIRECTORY, tokenDirectory(command.launchToken));
  const intentFile = await boundedCanonical(join(directory, 'launch-intent.json'), `launch intent ${command.launchToken}`, MAX_EFFECT_RECORD_BYTES);
  const launchFile = await boundedCanonical(join(directory, 'launch.json'), `launch ${command.launchToken}`, MAX_EFFECT_RECORD_BYTES);
  const terminalFile = await boundedCanonical(join(directory, 'terminal.json'), `terminal ${command.launchToken}`, MAX_EFFECT_RECORD_BYTES);
  let intent: LaunchIntentRecord; let launch: LaunchRecord; let terminal: TerminalRecord;
  try { intent = validateLaunchIntentRecord(intentFile.value); launch = validateLaunchRecord(launchFile.value); terminal = validateTerminalRecord(terminalFile.value); }
  catch (error) { fail(`effect ${command.launchToken} is invalid: ${(error as Error).message}`); }
  if (!sameLaunchIdentity(intent!, launch!)) fail(`effect ${command.launchToken} launch intent and launch disagree`);
  for (const record of [intent!, launch!, terminal!]) if (record.launchToken !== command.launchToken || record.commandDigest !== command.commandDigest) fail(`effect ${command.launchToken} token/digest binding is invalid`);
  if (launch!.commandId !== command.commandId || launch!.runId !== command.runId || launch!.phaseId !== command.phaseId || launch!.stepId !== command.stepId || launch!.attemptEpoch !== command.attemptEpoch || launch!.authorityEpoch !== command.authorityEpoch || launch!.barrierEpoch !== command.barrierEpoch || launch!.attempt !== command.attemptEpoch) fail(`effect ${command.launchToken} command binding is invalid`);
  if (Date.parse(terminal!.finishedAt) < Date.parse(launch!.startedAt)) fail(`effect ${command.launchToken} terminal predates launch`);
  const expectedStatus = terminal!.outcome === 'normal-completion' ? 'PASS' : terminal!.outcome === 'approval-required' ? 'NEEDS-DECISION' : terminal!.outcome === 'unresolved-termination' ? 'UNKNOWN' : 'BLOCKED';
  if (terminal!.status !== expectedStatus || terminal!.status === 'UNKNOWN') fail(`effect ${command.launchToken} is unresolved or status/outcome is inconsistent`);
  const resultFile = await readBoundedUtf8File(join(directory, 'result.json'), `result ${command.launchToken}`, MAX_EFFECT_RECORD_BYTES);
  if (terminal!.resultDigest === null) {
    if (resultFile.kind !== 'absent') fail(`effect ${command.launchToken} has unbound result evidence`);
  } else if ((resultFile.kind !== 'ok' && resultFile.kind !== 'invalid-utf8') || resultFile.digest !== terminal!.resultDigest) {
    fail(`effect ${command.launchToken} result evidence is unresolved`);
  }
  if (terminal!.outcome === 'normal-completion') {
    if (resultFile.kind !== 'ok') fail(`effect ${command.launchToken} result evidence is unresolved`);
    const result = parseWorkerResultText(resultFile.text);
    if (!result || result.status !== terminal!.status || result.reportPath !== terminal!.reportPath || result.reportDigest !== terminal!.reportDigest || !within(root, result.reportPath)) fail(`effect ${command.launchToken} result/terminal binding is invalid`);
    const report = await readBoundedUtf8File(result.reportPath, `report ${command.launchToken}`, MAX_EFFECT_RECORD_BYTES);
    if (report.kind !== 'ok' || report.digest !== result.reportDigest || reportControlStatus(report.text) !== result.status) fail(`effect ${command.launchToken} report evidence is unresolved`);
  } else if (terminal!.reportPath !== null || terminal!.reportDigest !== null) fail(`effect ${command.launchToken} has unbound report evidence`);
  validateReceipt(command, launch!, launchFile.text);
  validateJournalChain(state, command, terminal!);
  const copiedExecutable = join(directory, 'authority', 'codex-executable');
  const executable = await inspectTrustedPath(copiedExecutable, `copied executable ${command.launchToken}`, { surface: true, kind: 'file' }).catch((error) => fail(`copied executable ${command.launchToken} is unreadable: ${(error as Error).message}`));
  if (!executable) fail(`copied executable ${command.launchToken} is absent`);
  if (await boundedDigest(copiedExecutable, `copied executable ${command.launchToken}`, 512 * 1024 * 1024) !== launch!.codexBinaryDigest) fail(`copied executable ${command.launchToken} digest is invalid`);
  return Object.freeze({ launch: launch!, terminal: terminal!, copiedExecutable });
}

async function validateRootSet(runRoots: readonly string[], allowEmpty = false): Promise<string[]> {
  if (!Array.isArray(runRoots) || (!allowEmpty && runRoots.length === 0)) fail('closed run-root set is empty');
  if (runRoots.length > MAX_RUN_ROOTS) fail('closed run-root set exceeds its limit');
  const roots = runRoots.map((root, index) => canonicalPath(root, `run root ${index}`));
  if (new Set(roots).size !== roots.length) fail('closed run-root set contains duplicates');
  for (let left = 0; left < roots.length; left += 1) for (let right = left + 1; right < roots.length; right += 1) {
    if (within(roots[left]!, roots[right]!) || within(roots[right]!, roots[left]!)) fail('closed run-root set contains nested roots');
  }
  const identities = new Set<string>();
  for (const [index, root] of roots.entries()) {
    const trusted = await inspectTrustedPath(root, `run root ${index}`, { surface: true, kind: 'directory' }).catch((error) => fail(`run root ${index} is unreadable: ${(error as Error).message}`));
    if (!trusted) fail(`run root ${index} is absent`);
    const identity = `${trusted.identity.dev}:${trusted.identity.ino}`;
    if (identities.has(identity)) fail('closed run-root set aliases one physical root');
    identities.add(identity);
  }
  return roots;
}

function afterTerminal(process: ProcessSnapshotRecord, terminal: TerminalRecord): boolean {
  return Date.parse(process.startedAt) > Date.parse(terminal.finishedAt);
}

function validateProcesses(snapshot: ProcessSnapshot, installedTarget: string, roots: readonly string[], effects: readonly EffectChain[], selfPid?: number, rejectAnyInstalledTargetProcess = false): void {
  const bridgePath = join(installedTarget, 'runtime', 'bridge.mjs');
  const rootSet = new Set(roots); const copied = new Map(effects.map((effect) => [effect.copiedExecutable, effect]));
  const byChildPid = new Map(effects.map((effect) => [effect.launch.child.pid, effect]));
  const bySupervisorPid = new Map<number, EffectChain[]>();
  for (const effect of effects) bySupervisorPid.set(effect.launch.supervisor.pid, [...(bySupervisorPid.get(effect.launch.supervisor.pid) ?? []), effect]);
  for (const process of snapshot.processes) {
    const exactTokens = new Set([process.executable, ...process.argv]);
    if (rejectAnyInstalledTargetProcess && process.pid !== selfPid && [...exactTokens].some((token) => token === installedTarget || token.startsWith(`${installedTarget}${sep}`))) fail(`live installed-target process ${process.pid}`);
    const bridgeIndex = process.argv.findIndex((token) => token === bridgePath || /^\/.*\/runtime\/bridge\.mjs$/.test(token));
    if (bridgeIndex >= 0 && process.argv[bridgeIndex + 1] === 'drive') fail(`live managed bridge/pump process ${process.pid}`);
    for (const token of exactTokens) {
      const match = /^(\/.*)\/\.codex-effects\/([0-9a-f]{64})\/authority\/codex-executable$/.exec(token);
      if (!match) continue;
      const referencedRoot = match[1]!;
      if (!rootSet.has(referencedRoot)) fail(`live copied Codex child ${process.pid} belongs to an unlisted run root`);
      const effect = copied.get(token);
      if (!effect || tokenDirectory(effect.launch.launchToken) !== match[2]) fail(`live copied Codex child ${process.pid} has an unbound executable token`);
      fail(`live copied Codex child ${process.pid}`);
    }
    const child = byChildPid.get(process.pid);
    if (child && !afterTerminal(process, child.terminal)) {
      if (!exactTokens.has(child.copiedExecutable) || process.pgid !== child.launch.child.pid) fail(`child pid ${process.pid} ownership is ambiguous`);
      fail(`live copied Codex child ${process.pid}`);
    }
    for (const effect of effects) if (process.pgid === effect.launch.child.pid && !afterTerminal(process, effect.terminal)) fail(`live owned Codex process group ${process.pgid}`);
    const supervised = bySupervisorPid.get(process.pid);
    if (supervised?.some((effect) => !afterTerminal(process, effect.terminal))) fail(`live Codex supervisor ${process.pid}`);
    if (selfPid !== undefined && process.pid === selfPid) continue;
  }
}

export async function verifyExactLegacyDeployQuiescence(input: ExactLegacyDeployQuiescenceInput): Promise<ReleaseQuiescenceReport> {
  if (!input || typeof input !== 'object' || !Array.isArray(input.runRoots) || input.runRoots.length !== 0) fail('exact 0.2.12 deploy requires an empty run-root set');
  if (!input.releaseOwnership) fail('exact 0.2.12 deploy requires release ownership');
  await validateReleaseOwnership(input.releaseOwnership, input.installedTarget, input.runRoots);
  const target = await validateInstalledTarget(input.installedTarget, input.releaseOwnership, false);
  if (target.runtimeVersion !== '0.2.12' || target.bridgeVersion !== '0.1.0') fail('installed target is not the attested 0.2.12 release');
  const snapshot = parseProcessSnapshot(input.processSnapshot);
  validateProcesses(snapshot, target.path, input.runRoots, [], input.selfPid, true);
  return Object.freeze({ status: 'QUIESCENT', installedTarget: target.path, runRoots: Object.freeze([]), runCount: 0, effectCount: 0, processCount: snapshot.processes.length, capturedAt: snapshot.capturedAt });
}

export async function verifyReleaseQuiescence(input: ReleaseQuiescenceInput): Promise<ReleaseQuiescenceReport> {
  if (!input || typeof input !== 'object') fail('input is malformed');
  const roots = await validateRootSet(input.runRoots, Boolean(input.releaseOwnership));
  if (input.releaseOwnership) await validateReleaseOwnership(input.releaseOwnership, input.installedTarget, roots);
  const target = await validateInstalledTarget(input.installedTarget, input.releaseOwnership);
  const snapshot = parseProcessSnapshot(input.processSnapshot);
  const effects: EffectChain[] = [];
  for (const root of roots) {
    const writerPath = join(root, '.kernel', '.writer.lock');
    const writerLock = await inspectTrustedPath(writerPath, 'run writer lock', { allowMissing: true, surface: true }).catch((error) => fail(`run writer lock is unreadable: ${(error as Error).message}`));
    if (writerLock) {
      if (!input.releaseOwnership?.writerClaimPaths.includes(writerPath)) fail(`run root ${root} has writer-owner residue`);
      await exactOwnedBytes(writerPath, input.releaseOwnership.ownerBytes, 'owned run writer claim');
    }
    const bridgePath = join(root, '.kernel', '.bridge.lock');
    const bridgeLock = await inspectTrustedPath(bridgePath, 'managed launch admission lock', { allowMissing: true, surface: true }).catch((error) => fail(`managed launch admission lock is unreadable: ${(error as Error).message}`));
    if (bridgeLock) {
      if (!input.releaseOwnership?.bridgeClaimPaths.includes(bridgePath)) fail(`run root ${root} has managed-launch residue`);
      await exactOwnedBytes(bridgePath, input.releaseOwnership.ownerBytes, 'owned managed launch claim');
    }
    let loaded;
    try { loaded = await new FileArtifactStore(root).loadReadOnly(); }
    catch (error) { fail(`run root ${root} is invalid: ${(error as Error).message}`); }
    if (!loaded.state) fail(`run root ${root} has no committed state`);
    if (loaded.metadata.rootPath !== root || loaded.metadata.bridgeVersion !== target.bridgeVersion || loaded.metadata.runtimeVersion !== target.runtimeVersion) fail(`run root ${root} is not bound to the exact installed target release`);
    const effectRoot = join(root, EFFECT_DIRECTORY); const commands = Object.values(loaded.state.outbox);
    let entries: import('node:fs').Dirent[] = [];
    const effectTrusted = await inspectTrustedPath(effectRoot, 'effect root', { allowMissing: true, surface: true, kind: 'directory' }).catch((error) => fail(`effect root is unreadable: ${(error as Error).message}`));
    if (effectTrusted) entries = await boundedDirectoryEntries(effectRoot, 'effect root', MAX_EFFECT_ENTRIES);
    const expectedEntries = new Set(commands.map((command) => tokenDirectory(command.launchToken)));
    for (const entry of entries) if (!entry.isDirectory() || entry.isSymbolicLink() || !EFFECT_ENTRY.test(entry.name) || !expectedEntries.has(entry.name)) fail(`effect root contains unbound entry ${entry.name}`);
    if (entries.length !== expectedEntries.size) fail('effect root does not contain the exact outbox token set');
    for (const command of commands) effects.push(await validateEffectChain(root, loaded.state, command));
  }
  validateProcesses(snapshot, target.path, roots, effects, input.selfPid);
  return Object.freeze({ status: 'QUIESCENT', installedTarget: target.path, runRoots: Object.freeze([...roots]), runCount: roots.length, effectCount: effects.length, processCount: snapshot.processes.length, capturedAt: snapshot.capturedAt });
}

function supportedRolloutGenerations(state: MachineState): number[] {
  if (state.schema !== 2 || !state.managed) return [];
  const managed = state.managed;
  const projections = [
    managed.rollout,
    managed.rolloutOrigin,
    managed.proposal?.rolloutOrigin,
    ...Object.values(managed.attempts ?? {}).map((row) => row.rolloutOrigin),
    ...Object.values(managed.acceptedReports ?? {}).map((row) => row.rolloutOrigin),
    ...Object.values(managed.settlementOrigins ?? {}),
    ...Object.values(state.decisionTokens).map((row) => row.rolloutOrigin),
  ].filter((projection): projection is NonNullable<typeof projection> => projection !== undefined);
  const generations = projections.map((projection) => projection.generation);
  if (generations.some((generation) => !Number.isSafeInteger(generation) || generation < 0)) fail('supported rollout generation is invalid');
  return [...new Set(generations)].sort((left, right) => left - right);
}

/**
 * Classify every quiesced configured root under the existing release claims
 * and prove that the candidate one-shot floor is strictly newer than every
 * rollout generation the current reader can restore. The returned digest is
 * repeated immediately before publication to reject any intervening drift.
 */
export async function verifyReleaseGenerationCensus(input: ReleaseGenerationCensusInput): Promise<ReleaseGenerationCensus> {
  if (!input || typeof input !== 'object' || !input.quiescence || input.quiescence.status !== 'QUIESCENT') fail('generation census requires quiescence');
  if (!Number.isSafeInteger(input.candidateFloor) || input.candidateFloor <= 0) fail('candidate one-shot generation floor is invalid');
  const installedTarget = canonicalPath(input.installedTarget, 'installed target');
  if (input.quiescence.installedTarget !== installedTarget) fail('generation census target differs from quiescence');
  const roots = await validateRootSet(input.runRoots, true);
  if (canonicalString(roots) !== canonicalString(input.quiescence.runRoots) || input.quiescence.runCount !== roots.length) fail('generation census roots differ from quiescence');
  await validateReleaseOwnership(input.releaseOwnership, installedTarget, roots);

  const rows: ReleaseGenerationCensusRow[] = [];
  for (const root of roots) {
    const before = await inspectTrustedPath(root, 'generation census root', { surface: true, kind: 'directory' }).catch((error) => fail(`generation census root is unreadable: ${(error as Error).message}`));
    if (!before) fail(`generation census root is absent: ${root}`);
    let loaded;
    try { loaded = await new FileArtifactStore(root).loadReadOnly(); }
    catch (error) { fail(`generation census root ${root} is unreadable: ${(error as Error).message}`); }
    if (!loaded!.state) fail(`generation census root ${root} has no committed state`);
    const after = await inspectTrustedPath(root, 'generation census root', { surface: true, kind: 'directory' }).catch(() => undefined);
    if (!after || !sameFilesystemIdentity(before.identity, after.identity)) fail(`generation census root changed during classification: ${root}`);
    const generations = supportedRolloutGenerations(loaded!.state);
    if (generations.some((generation) => generation >= input.candidateFloor)) fail(`candidate one-shot generation floor ${input.candidateFloor} is not strictly newer than supported generation ${Math.max(...generations)}`);
    const classification: ReleaseGenerationClassification = loaded!.state.schema !== 2
      ? 'DIRECT'
      : generations.length === 0
        ? 'MANAGED_WITHOUT_ROLLOUT'
        : 'MANAGED_ROLLOUT';
    rows.push(Object.freeze({
      root,
      classification,
      generations: Object.freeze(generations),
      storeGeneration: loaded!.generation,
      stateDigest: digest(loaded!.state),
      metadataDigest: digest(loaded!.metadata),
      rootIdentity: Object.freeze({ ...before.identity }),
    }));
  }
  await validateReleaseOwnership(input.releaseOwnership, installedTarget, roots);
  const maximumSupportedGeneration = rows.reduce<number | null>((maximum, row) => {
    const candidate = row.generations.at(-1);
    return candidate === undefined ? maximum : maximum === null ? candidate : Math.max(maximum, candidate);
  }, null);
  const body = { candidateFloor: input.candidateFloor, maximumSupportedGeneration, roots: rows };
  return Object.freeze({ ...body, roots: Object.freeze(rows), digest: digest(body) });
}
