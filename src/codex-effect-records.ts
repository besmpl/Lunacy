import { constants as fsConstants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Ref, Sha256 } from './model.js';
import { canonicalString, digest, parseCanonical } from './canonical.js';
import { ensurePrivateDirectory, inspectTrustedPath, sameFilesystemIdentity, syncDirectory, syncDirectoryChain, type FilesystemIdentity } from './filesystem.js';
import { buildCodexArguments, buildWorkerHandoff, codexHostPolicyDigest, expectedReportPath, launchAuthorityDescriptorPaths, launchAuthoritySnapshotPaths, launchDirectoryPath, launchWritableRoots, parseWorkerResultText, reasoningEffortFor, type CodexCommandFrame, type CodexHostPolicy } from './codex-host-policy.js';

export const LAUNCH_RECORD_SCHEMA = 'lunacy-codex-launch/v1' as const;
/**
 * A launch intent is the durable reservation written before a child process is
 * created. The final launch record still carries the child pid, but this
 * record closes the otherwise unavoidable spawn -> launch-record window: a
 * restart can see that the token was reserved and must not blindly launch it
 * again when the child pid record was never published.
 */
export const LAUNCH_INTENT_RECORD_SCHEMA = 'lunacy-codex-launch-intent/v1' as const;
export const TERMINAL_RECORD_SCHEMA = 'lunacy-codex-terminal/v1' as const;
export const EFFECT_DIRECTORY = '.codex-effects' as const;
export const MAX_EFFECT_RECORD_BYTES = 256 * 1024;

export type LaunchRecord = Readonly<{
  schema: typeof LAUNCH_RECORD_SCHEMA;
  launchToken: string;
  commandDigest: string;
  commandId: string;
  runId: string;
  phaseId: string;
  stepId: string;
  attempt: number;
  attemptEpoch: number;
  authorityEpoch: number;
  barrierEpoch: number;
  policyDigest: string;
  /** Aggregate attestation of the run/skill/instruction authority bytes and identities. */
  authorityDigest: string;
  handoffDigest: string;
  argvDigest: string;
  codexPath: string;
  codexVersion: string;
  codexBinaryDigest: string;
  workspace: string;
  supervisor: Readonly<{ pid: number }>;
  child: Readonly<{ pid: number }>;
  startedAt: string;
}>;

export type LaunchIntentRecord = Readonly<Omit<LaunchRecord, 'schema' | 'child'> & {
  schema: typeof LAUNCH_INTENT_RECORD_SCHEMA;
}>;

export type TerminalOutcome = 'normal-completion' | 'turn-failure' | 'sandbox-denial' | 'approval-required' | 'cancellation' | 'host-evidence-failure' | 'unresolved-termination' | 'malformed-final-output' | 'absent-final-output' | 'process-failure';
export type TerminalStatus = 'PASS' | 'NEEDS-DECISION' | 'BLOCKED' | 'UNKNOWN';
export type TerminalRecord = Readonly<{
  schema: typeof TERMINAL_RECORD_SCHEMA;
  launchToken: string;
  commandDigest: string;
  status: TerminalStatus;
  outcome: TerminalOutcome;
  exitCode: number | null;
  signal: string | null;
  resultDigest: string | null;
  reportPath: string | null;
  reportDigest: string | null;
  eventsDigest: string;
  finishedAt: string;
}>;

/** A bounded file read that preserves the exact bytes used for evidence.  A
 * successful UTF-8 decode is not enough on its own: Node replaces malformed
 * sequences, so callers must require the round-trip check before parsing. */
export type BoundedUtf8File = Readonly<
  | { kind: 'absent' }
  | { kind: 'oversized' }
  | { kind: 'unreadable' }
  | { kind: 'invalid-utf8'; bytes: Buffer; digest: Sha256 }
  | { kind: 'ok'; bytes: Buffer; text: string; digest: Sha256 }
>;

export type EffectPaths = Readonly<{
  root: string;
  tokenDirectory: string;
  launchIntent: string;
  launch: string;
  terminal: string;
  output: string;
  events: string;
}>;

function fail(message: string): never { throw new Error(`CodexEffectRecords: ${message}`); }
function sha256(value: Uint8Array | string): Sha256 { return createHash('sha256').update(value).digest('hex') as Sha256; }
function safeToken(token: string): string {
  if (typeof token !== 'string' || token.length === 0 || token.includes('\0')) fail('launch token is invalid');
  // A token is an opaque identity.  Never place it directly in a pathname:
  // slash, dot, and platform-specific separators must not alter the effect
  // namespace selected by observe().
  return sha256(token);
}
function pathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function assertCanonicalPath(path: string, label: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || resolve(path) !== path) fail(`${label} must be absolute canonical`);
  return path;
}

export function effectPaths(policy: CodexHostPolicy, launchToken: string): EffectPaths {
  const root = assertCanonicalPath(policy.effectsRoot, 'effectsRoot');
  if (!pathWithin(policy.runRoot, root)) fail('effectsRoot is outside runRoot');
  const tokenDirectory = join(root, safeToken(launchToken));
  return Object.freeze({ root, tokenDirectory, launchIntent: join(tokenDirectory, 'launch-intent.json'), launch: join(tokenDirectory, 'launch.json'), terminal: join(tokenDirectory, 'terminal.json'), output: join(tokenDirectory, 'result.json'), events: join(tokenDirectory, 'events.jsonl') });
}

function exactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} fields are not closed`);
}
function digestField(value: unknown, label: string, allowNull = false): string | null {
  if (allowNull && value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}
function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) fail(`${label} is invalid`);
  return value;
}
function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} is invalid`);
  return value as number;
}

/** Read one bounded, trusted file and retain its raw-byte SHA-256.  This is
 * shared by live completion and restart reconciliation so both paths bind the
 * same bytes and reject the same malformed UTF-8 aliases. */
export async function readBoundedUtf8File(path: string, label: string, ceiling: number): Promise<BoundedUtf8File> {
  let trusted: Awaited<ReturnType<typeof inspectTrustedPath>>;
  try { trusted = await inspectTrustedPath(path, label, { allowMissing: true, surface: true, kind: 'file' }); }
  catch { return { kind: 'unreadable' }; }
  if (!trusted) return { kind: 'absent' };
  if (trusted.stat.size > ceiling) return { kind: 'oversized' };
  let bytes: Buffer;
  try { bytes = await fs.readFile(path); }
  catch { return { kind: 'unreadable' }; }
  let after: Awaited<ReturnType<typeof inspectTrustedPath>>;
  try { after = await inspectTrustedPath(path, label, { surface: true, kind: 'file' }); }
  catch { return { kind: 'unreadable' }; }
  if (!after || !sameFilesystemIdentity(trusted.identity, after.identity) || after.stat.size !== trusted.stat.size) return { kind: 'unreadable' };
  const digestValue = sha256(bytes);
  let bytesAfter: Buffer;
  try { bytesAfter = await fs.readFile(path); }
  catch { return { kind: 'unreadable' }; }
  if (!bytesAfter.equals(bytes)) return { kind: 'unreadable' };
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return { kind: 'invalid-utf8', bytes, digest: digestValue };
  return { kind: 'ok', bytes, text, digest: digestValue };
}

export function validateLaunchRecord(value: unknown): LaunchRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('launch record is malformed');
  const record = value as Record<string, unknown>;
  exactKeys(record, ['schema', 'launchToken', 'commandDigest', 'commandId', 'runId', 'phaseId', 'stepId', 'attempt', 'attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'policyDigest', 'authorityDigest', 'handoffDigest', 'argvDigest', 'codexPath', 'codexVersion', 'codexBinaryDigest', 'workspace', 'supervisor', 'child', 'startedAt'], 'launch record');
  if (record.schema !== LAUNCH_RECORD_SCHEMA) fail('launch record schema is invalid');
  const supervisor = record.supervisor; const child = record.child;
  if (!supervisor || typeof supervisor !== 'object' || Array.isArray(supervisor) || Object.keys(supervisor as object).join(',') !== 'pid') fail('launch supervisor identity is invalid');
  if (!child || typeof child !== 'object' || Array.isArray(child) || Object.keys(child as object).join(',') !== 'pid') fail('launch child identity is invalid');
  const supervisorPid = nonNegative((supervisor as Record<string, unknown>).pid, 'supervisor.pid');
  const childPid = nonNegative((child as Record<string, unknown>).pid, 'child.pid');
  if (supervisorPid < 1 || childPid < 1) fail('process identity is invalid');
  const out: LaunchRecord = Object.freeze({
    schema: LAUNCH_RECORD_SCHEMA,
    launchToken: nonEmpty(record.launchToken, 'launchToken'),
    commandDigest: digestField(record.commandDigest, 'commandDigest')!,
    commandId: nonEmpty(record.commandId, 'commandId'),
    runId: nonEmpty(record.runId, 'runId'), phaseId: nonEmpty(record.phaseId, 'phaseId'), stepId: nonEmpty(record.stepId, 'stepId'),
    attempt: nonNegative(record.attempt, 'attempt'), attemptEpoch: nonNegative(record.attemptEpoch, 'attemptEpoch'), authorityEpoch: nonNegative(record.authorityEpoch, 'authorityEpoch'), barrierEpoch: nonNegative(record.barrierEpoch, 'barrierEpoch'),
    policyDigest: digestField(record.policyDigest, 'policyDigest')!, authorityDigest: digestField(record.authorityDigest, 'authorityDigest')!, handoffDigest: digestField(record.handoffDigest, 'handoffDigest')!, argvDigest: digestField(record.argvDigest, 'argvDigest')!,
    codexPath: nonEmpty(record.codexPath, 'codexPath'), codexVersion: nonEmpty(record.codexVersion, 'codexVersion'), codexBinaryDigest: digestField(record.codexBinaryDigest, 'codexBinaryDigest')!, workspace: nonEmpty(record.workspace, 'workspace'),
    supervisor: Object.freeze({ pid: supervisorPid }), child: Object.freeze({ pid: childPid }), startedAt: nonEmpty(record.startedAt, 'startedAt'),
  });
  if (Number.isNaN(Date.parse(out.startedAt))) fail('launch startedAt is invalid');
  return out;
}

export function validateLaunchIntentRecord(value: unknown): LaunchIntentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('launch intent record is malformed');
  const record = value as Record<string, unknown>;
  exactKeys(record, ['schema', 'launchToken', 'commandDigest', 'commandId', 'runId', 'phaseId', 'stepId', 'attempt', 'attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'policyDigest', 'authorityDigest', 'handoffDigest', 'argvDigest', 'codexPath', 'codexVersion', 'codexBinaryDigest', 'workspace', 'supervisor', 'startedAt'], 'launch intent record');
  if (record.schema !== LAUNCH_INTENT_RECORD_SCHEMA) fail('launch intent record schema is invalid');
  const supervisor = record.supervisor;
  if (!supervisor || typeof supervisor !== 'object' || Array.isArray(supervisor) || Object.keys(supervisor as object).join(',') !== 'pid') fail('launch intent supervisor identity is invalid');
  const supervisorPid = nonNegative((supervisor as Record<string, unknown>).pid, 'supervisor.pid');
  if (supervisorPid < 1) fail('supervisor process identity is invalid');
  const out: LaunchIntentRecord = Object.freeze({
    schema: LAUNCH_INTENT_RECORD_SCHEMA,
    launchToken: nonEmpty(record.launchToken, 'launchToken'),
    commandDigest: digestField(record.commandDigest, 'commandDigest')!,
    commandId: nonEmpty(record.commandId, 'commandId'),
    runId: nonEmpty(record.runId, 'runId'), phaseId: nonEmpty(record.phaseId, 'phaseId'), stepId: nonEmpty(record.stepId, 'stepId'),
    attempt: nonNegative(record.attempt, 'attempt'), attemptEpoch: nonNegative(record.attemptEpoch, 'attemptEpoch'), authorityEpoch: nonNegative(record.authorityEpoch, 'authorityEpoch'), barrierEpoch: nonNegative(record.barrierEpoch, 'barrierEpoch'),
    policyDigest: digestField(record.policyDigest, 'policyDigest')!, authorityDigest: digestField(record.authorityDigest, 'authorityDigest')!, handoffDigest: digestField(record.handoffDigest, 'handoffDigest')!, argvDigest: digestField(record.argvDigest, 'argvDigest')!,
    codexPath: nonEmpty(record.codexPath, 'codexPath'), codexVersion: nonEmpty(record.codexVersion, 'codexVersion'), codexBinaryDigest: digestField(record.codexBinaryDigest, 'codexBinaryDigest')!, workspace: nonEmpty(record.workspace, 'workspace'),
    supervisor: Object.freeze({ pid: supervisorPid }), startedAt: nonEmpty(record.startedAt, 'startedAt'),
  });
  if (Number.isNaN(Date.parse(out.startedAt))) fail('launch intent startedAt is invalid');
  return out;
}

export function validateTerminalRecord(value: unknown): TerminalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('terminal record is malformed');
  const record = value as Record<string, unknown>;
  exactKeys(record, ['schema', 'launchToken', 'commandDigest', 'status', 'outcome', 'exitCode', 'signal', 'resultDigest', 'reportPath', 'reportDigest', 'eventsDigest', 'finishedAt'], 'terminal record');
  if (record.schema !== TERMINAL_RECORD_SCHEMA) fail('terminal record schema is invalid');
  const status = record.status; const outcome = record.outcome;
  if (!['PASS', 'NEEDS-DECISION', 'BLOCKED', 'UNKNOWN'].includes(String(status))) fail('terminal status is invalid');
  if (!['normal-completion', 'turn-failure', 'sandbox-denial', 'approval-required', 'cancellation', 'host-evidence-failure', 'unresolved-termination', 'malformed-final-output', 'absent-final-output', 'process-failure'].includes(String(outcome))) fail('terminal outcome is invalid');
  if (record.exitCode !== null && !Number.isSafeInteger(record.exitCode)) fail('terminal exitCode is invalid');
  if (record.signal !== null && typeof record.signal !== 'string') fail('terminal signal is invalid');
  const out: TerminalRecord = Object.freeze({
    schema: TERMINAL_RECORD_SCHEMA, launchToken: nonEmpty(record.launchToken, 'launchToken'), commandDigest: digestField(record.commandDigest, 'commandDigest')!,
    status: status as TerminalStatus, outcome: outcome as TerminalOutcome, exitCode: record.exitCode as number | null, signal: record.signal as string | null,
    resultDigest: digestField(record.resultDigest, 'resultDigest', true), reportPath: record.reportPath === null ? null : nonEmpty(record.reportPath, 'reportPath'), reportDigest: digestField(record.reportDigest, 'reportDigest', true), eventsDigest: digestField(record.eventsDigest, 'eventsDigest')!, finishedAt: nonEmpty(record.finishedAt, 'finishedAt'),
  });
  if (Number.isNaN(Date.parse(out.finishedAt))) fail('terminal finishedAt is invalid');
  return out;
}

export function launchRecordRef(record: LaunchRecord): Ref {
  const bytes = canonicalString(record);
  return { id: `codex-launch:${record.launchToken}`, scope: 'codex/effect/launch', digest: digest(record), bytes };
}
export function launchIntentRecordRef(record: LaunchIntentRecord): Ref {
  const bytes = canonicalString(record);
  return { id: `codex-launch-intent:${record.launchToken}`, scope: 'codex/effect/launch-intent', digest: digest(record), bytes };
}
export function terminalRecordRef(record: TerminalRecord): Ref {
  const bytes = canonicalString(record);
  return { id: `codex-terminal:${record.launchToken}`, scope: 'codex/effect/terminal', digest: digest(record), bytes };
}

async function immutableWrite(path: string, value: unknown, label: string): Promise<void> {
  const bytes = canonicalString(value);
  if (Buffer.byteLength(bytes) > MAX_EFFECT_RECORD_BYTES) fail(`${label} exceeds output ceiling`);
  await ensurePrivateDirectory(dirname(path), `${label} directory`);
  // Existing parent chains may have been created by an earlier process and
  // therefore cannot be assumed crash-durable. Flush the complete chain
  // before publishing this protocol filename.
  await syncDirectoryChain(dirname(path), `${label} directory`);
  const trustedParent = await inspectTrustedPath(dirname(path), `${label} directory`, { surface: true, kind: 'directory' });
  if (!trustedParent) fail(`${label} directory is absent`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes, 'utf8'); await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await readImmutable(path, label);
      if (existing !== bytes) fail(`${label} conflicts with an existing immutable record`);
      // Even an idempotent writer must close the directory-entry barrier: a
      // restart may otherwise observe the bytes while losing the filename.
      await syncDirectory(dirname(path), `${label} directory`);
      return;
    }
    fail(`${label} could not be published: ${(error as Error).message}`);
  } finally { await handle?.close().catch(() => undefined); }
  const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
  if (!trusted) fail(`${label} disappeared after publication`);
  await syncDirectory(dirname(path), `${label} directory`);
}

/** Publish a one-shot reservation. Unlike ordinary immutable records, an
 * existing reservation is never treated as an idempotent success: the token
 * may already have reached the external process boundary. */
async function immutableCreate(path: string, value: unknown, label: string): Promise<void> {
  const bytes = canonicalString(value);
  if (Buffer.byteLength(bytes) > MAX_EFFECT_RECORD_BYTES) fail(`${label} exceeds output ceiling`);
  await ensurePrivateDirectory(dirname(path), `${label} directory`);
  await syncDirectoryChain(dirname(path), `${label} directory`);
  const trustedParent = await inspectTrustedPath(dirname(path), `${label} directory`, { surface: true, kind: 'directory' });
  if (!trustedParent) fail(`${label} directory is absent`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes, 'utf8'); await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(`${label} already exists for this launch token`);
    fail(`${label} could not be published: ${(error as Error).message}`);
  } finally { await handle?.close().catch(() => undefined); }
  const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
  if (!trusted) fail(`${label} disappeared after publication`);
  await syncDirectory(dirname(path), `${label} directory`);
}

async function readImmutable(path: string, label: string): Promise<string> {
  const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
  if (!trusted) fail(`${label} is absent`);
  const before: FilesystemIdentity = trusted.identity;
  let text: string;
  try { text = await fs.readFile(path, 'utf8'); } catch (error) { fail(`${label} could not be read: ${(error as Error).message}`); }
  const after = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
  if (!after || !sameFilesystemIdentity(before, after.identity)) fail(`${label} changed during read`);
  if (Buffer.byteLength(text!) > MAX_EFFECT_RECORD_BYTES) fail(`${label} exceeds output ceiling`);
  return text!;
}

export async function writeLaunchRecord(policy: CodexHostPolicy, record: LaunchRecord): Promise<EffectPaths> {
  const checked = validateLaunchRecord(record); const paths = effectPaths(policy, checked.launchToken);
  if (checked.policyDigest !== codexHostPolicyDigest(policy)) fail('launch policy digest does not match current policy');
  await immutableWrite(paths.launch, checked, 'launch record');
  return paths;
}

/** Atomically reserve a launch token before spawning its external child. */
export async function writeLaunchIntentRecord(policy: CodexHostPolicy, record: LaunchIntentRecord): Promise<EffectPaths> {
  const checked = validateLaunchIntentRecord(record); const paths = effectPaths(policy, checked.launchToken);
  if (checked.policyDigest !== codexHostPolicyDigest(policy)) fail('launch intent policy digest does not match current policy');
  await immutableCreate(paths.launchIntent, checked, 'launch intent record');
  return paths;
}

export async function writeTerminalRecord(policy: CodexHostPolicy, record: TerminalRecord): Promise<EffectPaths> {
  const checked = validateTerminalRecord(record); const paths = effectPaths(policy, checked.launchToken);
  await immutableWrite(paths.terminal, checked, 'terminal record');
  return paths;
}

export async function readLaunchRecord(policy: CodexHostPolicy, launchToken: string): Promise<LaunchRecord | undefined> {
  const paths = effectPaths(policy, launchToken);
  try { return validateLaunchRecord(parseCanonical(await readImmutable(paths.launch, 'launch record'))); }
  catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === 'ENOENT' || /(?:is absent|does not exist)/.test(String((error as Error).message))) return undefined;
    throw error;
  }
}

export async function readLaunchIntentRecord(policy: CodexHostPolicy, launchToken: string): Promise<LaunchIntentRecord | undefined> {
  const paths = effectPaths(policy, launchToken);
  try { return validateLaunchIntentRecord(parseCanonical(await readImmutable(paths.launchIntent, 'launch intent record'))); }
  catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === 'ENOENT' || /(?:is absent|does not exist)/.test(String((error as Error).message))) return undefined;
    throw error;
  }
}

export async function readTerminalRecord(policy: CodexHostPolicy, launchToken: string): Promise<TerminalRecord | undefined> {
  const paths = effectPaths(policy, launchToken);
  try { return validateTerminalRecord(parseCanonical(await readImmutable(paths.terminal, 'terminal record'))); }
  catch (error) {
    if (String((error as NodeJS.ErrnoException).code) === 'ENOENT' || /(?:is absent|does not exist)/.test(String((error as Error).message))) return undefined;
    throw error;
  }
}

export function assertRecordBinding(policy: CodexHostPolicy, launch: LaunchRecord, launchToken: string, commandDigest: string): LaunchRecord {
  const checked = validateLaunchRecord(launch);
  if (checked.launchToken !== launchToken || checked.commandDigest !== commandDigest) fail('launch record token/digest mismatch');
  if (checked.attempt !== checked.attemptEpoch) fail('launch attempt is not bound to attemptEpoch');
  if (checked.policyDigest !== codexHostPolicyDigest(policy) || checked.codexPath !== policy.codexPath || checked.codexVersion !== policy.codexVersion || checked.codexBinaryDigest !== policy.codexBinaryDigest || checked.workspace !== policy.workspace) fail('launch record policy/binary binding mismatch');
  const frame: CodexCommandFrame = {
    commandId: checked.commandId, runId: checked.runId, phaseId: checked.phaseId, stepId: checked.stepId,
    attemptEpoch: checked.attemptEpoch, authorityEpoch: checked.authorityEpoch, barrierEpoch: checked.barrierEpoch,
    modeEpoch: 0, launchToken: checked.launchToken, commandDigest: checked.commandDigest as Sha256, planDigest: policy.planDigest as Sha256,
  };
  const expectedDigest = digest({ commandId: frame.commandId, runId: frame.runId, phaseId: frame.phaseId, stepId: frame.stepId, attemptEpoch: frame.attemptEpoch, launchToken: frame.launchToken });
  if (expectedDigest !== checked.commandDigest) fail('launch command digest is not canonical');
  const effort = reasoningEffortFor(policy, frame);
  const paths = effectPaths(policy, checked.launchToken);
  // Linux production launches commit descriptor-valued argv/handoff paths;
  // injected deterministic spawn seams intentionally commit durable snapshot
  // paths so their in-process fake child can write the effect file.  The
  // launch record's immutable argv/handoff digests select exactly one of the
  // two deterministic spellings during restart reconciliation.
  const bindingCandidates = process.platform === 'linux' ? [true, false] : [false];
  const matchesBinding = bindingCandidates.some((descriptorBound) => {
    const descriptorWorkspace = descriptorBound ? '/proc/self/fd/4' : undefined;
    const descriptorRunRoot = descriptorBound ? '/proc/self/fd/5' : undefined;
    const authorityPaths = descriptorBound ? launchAuthorityDescriptorPaths(policy, frame) : launchAuthoritySnapshotPaths(policy, frame);
    const handoff = buildWorkerHandoff(policy, frame, { authorityPaths });
    const workerSchemaSnapshot = authorityPaths.get(policy.workerSchemaPath);
    if (!workerSchemaSnapshot) return false;
    const args = buildCodexArguments(policy, frame, effort, paths.output, {
      outputPath: launchDirectoryPath(policy, paths.output, descriptorWorkspace, descriptorRunRoot),
      workerSchemaPath: workerSchemaSnapshot,
      workspacePath: launchDirectoryPath(policy, policy.workspace, descriptorWorkspace, descriptorRunRoot),
      writableRoots: launchWritableRoots(policy, descriptorWorkspace, descriptorRunRoot),
    });
    return handoff.digest === checked.handoffDigest && digest(args) === checked.argvDigest;
  });
  if (!matchesBinding) fail('launch handoff/argv binding mismatch');
  return checked;
}

export function assertTerminalBinding(policy: CodexHostPolicy, terminal: TerminalRecord, launch: LaunchRecord): TerminalRecord {
  const boundLaunch = validateLaunchRecord(launch);
  const checked = validateTerminalRecord(terminal);
  if (checked.launchToken !== boundLaunch.launchToken || checked.commandDigest !== boundLaunch.commandDigest) fail('terminal record token/digest mismatch');
  if (checked.reportPath !== null) {
    const reportPath = assertCanonicalPath(checked.reportPath, 'terminal reportPath');
    if (!pathWithin(policy.runRoot, reportPath)) fail('terminal report path escapes runRoot');
  }
  return checked;
}

/** Reconcile terminal metadata against the exact final-output/report bytes.
 * This is used after a bridge restart, when no in-memory supervisor exists. */
export async function verifyTerminalEvidence(policy: CodexHostPolicy, launch: LaunchRecord, terminal: TerminalRecord): Promise<TerminalRecord | undefined> {
  try {
    const checkedLaunch = assertRecordBinding(policy, launch, launch.launchToken, launch.commandDigest);
    const checked = assertTerminalBinding(policy, terminal, checkedLaunch);
    const paths = effectPaths(policy, checked.launchToken);
    const output = await readBoundedUtf8File(paths.output, 'Codex final output', policy.maxOutputBytes);
    if (checked.resultDigest === null) {
      if (output.kind !== 'absent') return undefined;
    } else if ((output.kind !== 'ok' && output.kind !== 'invalid-utf8') || output.digest !== checked.resultDigest) return undefined;
    const result = output.kind === 'ok' ? parseWorkerResultText(output.text) : undefined;
    if (checked.outcome === 'normal-completion') {
      if (output.kind !== 'ok' || !result || checked.status !== result.status || result.reportPath !== expectedReportPath(policy, checkedLaunch) || checked.reportPath !== result.reportPath || checked.reportDigest !== result.reportDigest) return undefined;
      const report = await readBoundedUtf8File(String(result.reportPath), 'worker report', policy.maxReportBytes);
      if (report.kind !== 'ok' || report.digest !== checked.reportDigest || reportControlStatus(report.text) !== result.status) return undefined;
    } else {
      if (checked.status === 'PASS' || checked.reportPath !== null || checked.reportDigest !== null) return undefined;
      const expectedStatus = checked.outcome === 'approval-required' ? 'NEEDS-DECISION' : checked.outcome === 'unresolved-termination' ? 'UNKNOWN' : 'BLOCKED';
      if (checked.status !== expectedStatus) return undefined;
    }
    return checked;
  } catch { return undefined; }
}

/** A worker report is control evidence only when it contains exactly one
 * supported Status line. Multiple lines are ambiguous even when they agree. */
export function reportControlStatus(text: string): TerminalStatus | undefined {
  const matches = [...text.matchAll(/^\s*Status\s*:\s*(PASS|NEEDS-DECISION|BLOCKED)\s*$/gm)];
  return matches.length === 1 ? matches[0]![1] as TerminalStatus : undefined;
}
