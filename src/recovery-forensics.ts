import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import type { CodexHostPolicy } from './codex-host-policy.js';
import { codexHostPolicyDigest, validateCodexHostPolicy } from './codex-host-policy.js';
import { canonicalString, digest, parseCanonical } from './canonical.js';
import { FileArtifactStore, isCanonicalRootPath } from './store.js';
import { inspectTrustedPath, sameFilesystemIdentity, trustedIdentity, type FilesystemIdentity } from './filesystem.js';
import { JOURNAL_BYTE_CEILING, JOURNAL_EVENT_CEILING, CURRENT_BYTE_CEILING } from './limits.js';
import { MAX_EFFECT_RECORD_BYTES, readBoundedUtf8File, validateHistoricalCodexEffect, validateLaunchIntentRecord, validateLaunchRecord, validateTerminalRecord, type BoundedUtf8File, type TerminalRecord } from './codex-effect-records.js';
import type { MachineState, OutboxCommand } from './model.js';

/** Private diagnostic schema.  It deliberately contains only identities,
 * digests, bounded counters and stable status classes; no payloads or paths. */
export const RECOVERY_SCHEMA = 'lunacy-recovery/v1' as const;
export const RECOVERY_OUTPUT_BYTE_CEILING = 16 * 1024;
const SEGMENT_EVENT_CEILING = 1000;
const MAX_NAMESPACE_ENTRIES = 512;
const SHA256 = /^[0-9a-f]{64}$/;
/** The capsule schema intentionally keeps run/phase identities small.  Step
 * identities are opaque runtime keys, so unsafe/path-like values are exposed
 * only as this bounded digest representation below. */
const CAPSULE_ID_MAX_LENGTH = 256;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const CAPSULE_STEP_PATTERN = /^(?:sha256:[0-9a-f]{64}|[^/\\\u0000-\u001f\u007f]+)$/;

type EvidenceStatus = 'ABSENT' | 'VALID' | 'MALFORMED' | 'INVALID_UTF8' | 'OVERSIZED' | 'UNREADABLE' | 'MISMATCH' | 'UNVERIFIABLE';
export type RecoveryEvidence = Readonly<{
  present: boolean;
  status: EvidenceStatus;
  verified: boolean;
  binding: 'MATCH' | 'MISMATCH' | 'ABSENT' | 'UNVERIFIABLE';
  digest: string | null;
}>;

export type RecoveryCapsule = Readonly<{
  schema: typeof RECOVERY_SCHEMA;
  request: { runId: string; launchTokenDigest: string; commandDigest: string | null };
  run: { runId: string; phaseId: string; generation: number; revision: number; planDigest: string; epochs: { attempt: number; authority: number; barrier: number; mode: number }; writerFenceDigest: string; verified: true };
  journal: { format: 'legacy' | 'segmented'; events: { used: number; ceiling: number | null; remaining: number | null }; bytes: { used: number; ceiling: number | null; remaining: number | null }; activeSuffix: { used: number; ceiling: number | null; remaining: number | null } };
  outbox: { found: boolean; state: OutboxCommand['state'] | null; stepId: string | null; commandDigest: string | null; binding: 'MATCH' | 'MISMATCH' | 'ABSENT'; lease: { present: boolean; status: 'ABSENT' | 'VALID' | 'STALE' | 'MALFORMED'; digest: string | null } };
  effects: { launchIntent: RecoveryEvidence; launch: RecoveryEvidence; terminal: RecoveryEvidence };
  unknown: { active: boolean; cause: string | null };
  fence: { root: 'VERIFIED'; current: 'VERIFIED'; writer: 'VERIFIED' | 'MISMATCH'; lock: 'ABSENT' | 'PRESENT' | 'MALFORMED' | 'UNREADABLE'; namespace: 'UNCHANGED' | 'CHANGED' };
  nextProof: string | null;
}>;

export type RecoveryInspectionInput = Readonly<{
  /** `runRoot` is the operator spelling; `kernelRoot` is accepted for parity
   * with Workfront and is intentionally not an ambient discovery mechanism. */
  runRoot?: string;
  kernelRoot?: string;
  runId?: string;
  expectedRunId?: string;
  launchToken?: string;
  token?: string;
  commandDigest?: string;
  policy?: CodexHostPolicy;
  effectsRoot?: string;
  authorityDigest?: string;
  policyDigest?: string;
}>;

function fail(message: string): never { throw new Error(`Recovery: ${message}`); }
function sha256(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
function capsuleLength(value: string): number { return Array.from(value).length; }
function pathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('/'));
}
function canonicalRoot(input: RecoveryInspectionInput): string {
  if (input.runRoot !== undefined && input.kernelRoot !== undefined && input.runRoot !== input.kernelRoot) fail('runRoot and kernelRoot selectors conflict');
  const root = input.runRoot ?? input.kernelRoot;
  if (!isCanonicalRootPath(root)) fail('runRoot must be an absolute canonical path');
  return root;
}
function requestRunId(input: RecoveryInspectionInput): string {
  if (input.runId !== undefined && input.expectedRunId !== undefined && input.runId !== input.expectedRunId) fail('runId and expectedRunId selectors conflict');
  const runId = input.runId ?? input.expectedRunId;
  if (typeof runId !== 'string' || runId.length === 0 || runId.includes('\0')) fail('runId is required');
  if (capsuleLength(runId) > CAPSULE_ID_MAX_LENGTH) fail('runId exceeds capsule identity limit');
  if (CONTROL_CHARACTER.test(runId)) fail('runId contains control characters');
  return runId;
}
function validateDigest(value: string | undefined, label: string): string | undefined {
  if (value !== undefined && !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}
function tokenDirectory(effectsRoot: string, token: string): string {
  if (typeof token !== 'string' || token.length === 0 || token.includes('\0')) fail('launchToken is required');
  return join(effectsRoot, sha256(token));
}

function requestToken(input: RecoveryInspectionInput): string {
  if (input.launchToken !== undefined && input.token !== undefined && input.launchToken !== input.token) fail('launchToken and token selectors conflict');
  const token = input.launchToken ?? input.token;
  if (typeof token !== 'string' || token.length === 0 || token.includes('\0')) fail('launchToken is required');
  return token;
}

function boundedCapsuleIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is invalid`);
  if (capsuleLength(value) > CAPSULE_ID_MAX_LENGTH) fail(`${label} exceeds capsule identity limit`);
  if (CONTROL_CHARACTER.test(value)) fail(`${label} contains control characters`);
  return value;
}

/** Keep hostile step keys useful for forensics without ever returning a path
 * component or control-bearing string. Internal binding continues to use the
 * exact command.stepId; this representation is capsule-only. */
function capsuleStepId(stepId: string | null | undefined): string | null {
  if (stepId === null || stepId === undefined) return null;
  if (stepId.length > 0 && capsuleLength(stepId) <= CAPSULE_ID_MAX_LENGTH && !CONTROL_CHARACTER.test(stepId) && !stepId.includes('/') && !stepId.includes('\\') && stepId !== '.' && stepId !== '..') return stepId;
  return `sha256:${sha256(stepId)}`;
}

function exactCapsuleKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`capsule schema validation failed: ${label} must be an object`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`capsule schema validation failed: ${label} fields are not closed`);
  return object;
}
function capsuleString(value: unknown, label: string, maxLength: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || capsuleLength(value) > maxLength || (pattern && !pattern.test(value))) fail(`capsule schema validation failed: ${label} is invalid`);
  return value;
}
function capsuleDigest(value: unknown, label: string, allowNull = false): string | null {
  if (allowNull && value === null) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`capsule schema validation failed: ${label} is invalid`);
  return value;
}
function capsuleInteger(value: unknown, label: string, allowNull = false): number | null {
  if (allowNull && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`capsule schema validation failed: ${label} is invalid`);
  return value as number;
}
function capsuleEnum(value: unknown, values: readonly string[], label: string): string {
  if (typeof value !== 'string' || !values.includes(value)) fail(`capsule schema validation failed: ${label} is invalid`);
  return value;
}

/** Dependency-free validation of the frozen nested recovery schema. Keeping
 * this at the inspector boundary prevents future state-derived fields from
 * silently widening the public capsule contract. */
export function validateRecoveryCapsule(value: unknown): asserts value is RecoveryCapsule {
  const capsule = exactCapsuleKeys(value, ['schema', 'request', 'run', 'journal', 'outbox', 'effects', 'unknown', 'fence', 'nextProof'], 'capsule');
  if (capsule.schema !== RECOVERY_SCHEMA) fail('capsule schema validation failed: schema is invalid');
  const request = exactCapsuleKeys(capsule.request, ['runId', 'launchTokenDigest', 'commandDigest'], 'request');
  capsuleString(request.runId, 'request.runId', CAPSULE_ID_MAX_LENGTH); capsuleDigest(request.launchTokenDigest, 'request.launchTokenDigest'); capsuleDigest(request.commandDigest, 'request.commandDigest', true);
  const run = exactCapsuleKeys(capsule.run, ['runId', 'phaseId', 'generation', 'revision', 'planDigest', 'epochs', 'writerFenceDigest', 'verified'], 'run');
  capsuleString(run.runId, 'run.runId', CAPSULE_ID_MAX_LENGTH); capsuleString(run.phaseId, 'run.phaseId', CAPSULE_ID_MAX_LENGTH); capsuleInteger(run.generation, 'run.generation'); capsuleInteger(run.revision, 'run.revision'); capsuleDigest(run.planDigest, 'run.planDigest'); capsuleDigest(run.writerFenceDigest, 'run.writerFenceDigest'); if (run.verified !== true) fail('capsule schema validation failed: run.verified is invalid');
  const epochs = exactCapsuleKeys(run.epochs, ['attempt', 'authority', 'barrier', 'mode'], 'run.epochs');
  for (const field of ['attempt', 'authority', 'barrier', 'mode']) capsuleInteger(epochs[field], `run.epochs.${field}`);
  const journal = exactCapsuleKeys(capsule.journal, ['format', 'events', 'bytes', 'activeSuffix'], 'journal'); capsuleEnum(journal.format, ['legacy', 'segmented'], 'journal.format');
  for (const field of ['events', 'bytes', 'activeSuffix']) { const budget = exactCapsuleKeys(journal[field], ['used', 'ceiling', 'remaining'], `journal.${field}`); capsuleInteger(budget.used, `journal.${field}.used`); capsuleInteger(budget.ceiling, `journal.${field}.ceiling`, true); capsuleInteger(budget.remaining, `journal.${field}.remaining`, true); }
  const outbox = exactCapsuleKeys(capsule.outbox, ['found', 'state', 'stepId', 'commandDigest', 'binding', 'lease'], 'outbox'); if (typeof outbox.found !== 'boolean') fail('capsule schema validation failed: outbox.found is invalid');
  if (outbox.state !== null) capsuleEnum(outbox.state, ['PENDING', 'CLAIMED', 'UNKNOWN', 'ACKED', 'REJECTED', 'CANCELLED'], 'outbox.state');
  if (outbox.stepId !== null) capsuleString(outbox.stepId, 'outbox.stepId', CAPSULE_ID_MAX_LENGTH, CAPSULE_STEP_PATTERN);
  capsuleDigest(outbox.commandDigest, 'outbox.commandDigest', true); capsuleEnum(outbox.binding, ['MATCH', 'MISMATCH', 'ABSENT'], 'outbox.binding');
  const lease = exactCapsuleKeys(outbox.lease, ['present', 'status', 'digest'], 'outbox.lease'); if (typeof lease.present !== 'boolean') fail('capsule schema validation failed: outbox.lease.present is invalid'); capsuleEnum(lease.status, ['ABSENT', 'VALID', 'STALE', 'MALFORMED'], 'outbox.lease.status'); capsuleDigest(lease.digest, 'outbox.lease.digest', true);
  const effects = exactCapsuleKeys(capsule.effects, ['launchIntent', 'launch', 'terminal'], 'effects');
  for (const field of ['launchIntent', 'launch', 'terminal']) { const evidence = exactCapsuleKeys(effects[field], ['present', 'status', 'verified', 'binding', 'digest'], `effects.${field}`); if (typeof evidence.present !== 'boolean' || typeof evidence.verified !== 'boolean') fail(`capsule schema validation failed: effects.${field} flags are invalid`); capsuleEnum(evidence.status, ['ABSENT', 'VALID', 'MALFORMED', 'INVALID_UTF8', 'OVERSIZED', 'UNREADABLE', 'MISMATCH', 'UNVERIFIABLE'], `effects.${field}.status`); capsuleEnum(evidence.binding, ['MATCH', 'MISMATCH', 'ABSENT', 'UNVERIFIABLE'], `effects.${field}.binding`); capsuleDigest(evidence.digest, `effects.${field}.digest`, true); }
  const unknown = exactCapsuleKeys(capsule.unknown, ['active', 'cause'], 'unknown'); if (typeof unknown.active !== 'boolean') fail('capsule schema validation failed: unknown.active is invalid'); if (unknown.cause !== null) capsuleString(unknown.cause, 'unknown.cause', 128);
  const fence = exactCapsuleKeys(capsule.fence, ['root', 'current', 'writer', 'lock', 'namespace'], 'fence'); if (fence.root !== 'VERIFIED' || fence.current !== 'VERIFIED') fail('capsule schema validation failed: fence root/current are invalid'); capsuleEnum(fence.writer, ['VERIFIED', 'MISMATCH'], 'fence.writer'); capsuleEnum(fence.lock, ['ABSENT', 'PRESENT', 'MALFORMED', 'UNREADABLE'], 'fence.lock'); capsuleEnum(fence.namespace, ['UNCHANGED', 'CHANGED'], 'fence.namespace');
  if (capsule.nextProof !== null) capsuleString(capsule.nextProof, 'nextProof', 256);
}
function evidenceFromFile(file: BoundedUtf8File): RecoveryEvidence {
  switch (file.kind) {
    case 'absent': return { present: false, status: 'ABSENT', verified: false, binding: 'ABSENT', digest: null };
    case 'oversized': return { present: true, status: 'OVERSIZED', verified: false, binding: 'UNVERIFIABLE', digest: null };
    case 'invalid-utf8': return { present: true, status: 'INVALID_UTF8', verified: false, binding: 'UNVERIFIABLE', digest: file.digest };
    case 'unreadable': return { present: true, status: 'UNREADABLE', verified: false, binding: 'UNVERIFIABLE', digest: null };
    case 'ok': return { present: true, status: 'MALFORMED', verified: false, binding: 'UNVERIFIABLE', digest: file.digest };
  }
}
function withStatus(base: RecoveryEvidence, status: EvidenceStatus, verified: boolean): RecoveryEvidence {
  const binding = status === 'ABSENT' ? 'ABSENT' : status === 'MISMATCH' ? 'MISMATCH' : verified ? 'MATCH' : 'UNVERIFIABLE';
  return { ...base, status, verified, binding };
}
function recordFromFile<T>(file: BoundedUtf8File, validate: (value: unknown) => T): { evidence: RecoveryEvidence; record?: T } {
  const evidence = evidenceFromFile(file);
  if (file.kind !== 'ok') return { evidence };
  try {
    const parsed = parseCanonical(file.text);
    return { evidence: withStatus(evidence, 'VALID', true), record: validate(parsed) };
  } catch {
    return { evidence: withStatus(evidence, 'MALFORMED', false) };
  }
}
function commandBinding(command: OutboxCommand | undefined, runId: string, requestedDigest?: string): 'MATCH' | 'MISMATCH' | 'ABSENT' {
  if (!command) return 'ABSENT';
  if (command.runId !== runId || command.modeEpoch !== 0) return 'MISMATCH';
  if (requestedDigest !== undefined && command.commandDigest !== requestedDigest) return 'MISMATCH';
  return 'MATCH';
}
function leaseStatus(command: OutboxCommand | undefined, state: MachineState): RecoveryCapsule['outbox']['lease'] {
  if (!command?.leaseId) return { present: false, status: 'ABSENT', digest: null };
  const value = command.leaseId;
  const parts = value.split(':');
  const writer = parts.length >= 3 ? parts.at(-1) ?? '' : '';
  const mode = parts.length >= 3 ? parts.at(-2) ?? '' : '';
  const leaseNonce = parts.length >= 3 ? parts.slice(0, -2).join(':') : '';
  if (leaseNonce.length === 0 || mode.length === 0 || writer.length === 0) return { present: true, status: 'MALFORMED', digest: sha256(value) };
  // A pending command must not carry a claim lease.  A stale lease on an
  // acknowledged/unknown command remains useful forensic evidence, but is
  // never treated as permission to dispatch.
  if (command.state === 'PENDING') return { present: true, status: 'STALE', digest: sha256(value) };
  const valid = mode === String(state.modeEpoch) && writer === state.writerFence;
  return { present: true, status: valid ? 'VALID' : (value.includes(':') ? 'STALE' : 'MALFORMED'), digest: sha256(value) };
}
function reportPathSafe(path: string, root: string): boolean { return typeof path === 'string' && path.length > 0 && resolve(path) === path && pathWithin(root, path); }

async function readCurrent(root: string): Promise<{ value: Record<string, unknown>; identity: FilesystemIdentity }> {
  const identity = await trustedIdentity(join(root, '.kernel', 'CURRENT'), 'CURRENT', { surface: true, kind: 'file' });
  if (!identity) fail('CURRENT is unavailable');
  const file = await readBoundedUtf8File(join(root, '.kernel', 'CURRENT'), 'CURRENT', CURRENT_BYTE_CEILING);
  if (file.kind !== 'ok') fail('CURRENT is unavailable');
  try { return { value: parseCanonical<Record<string, unknown>>(file.text), identity }; } catch { fail('CURRENT is malformed'); }
}

/** Hash the complete bounded effect namespace.  This is an integrity fence,
 * not a projection: names and raw bytes are never returned in the capsule. */
async function namespaceDigest(root: string, toleratedPaths: ReadonlySet<string> = new Set()): Promise<string> {
  const rows: Array<Record<string, unknown>> = [];
  const rootTrusted = await inspectTrustedPath(root, 'effects root', { allowMissing: true, surface: true, kind: 'directory' });
  rows.push(rootTrusted ? { name: '', kind: 'root', identity: { dev: rootTrusted.identity.dev, ino: rootTrusted.identity.ino } } : { name: '', kind: 'root-absent' });
  const visit = async (dir: string, prefix: string): Promise<void> => {
    const entries: import('node:fs').Dirent[] = [];
    let iterator: Awaited<ReturnType<typeof fs.opendir>>;
    try { iterator = await fs.opendir(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      for await (const entry of iterator) {
        if (rows.length + entries.length >= MAX_NAMESPACE_ENTRIES) throw new Error('effect namespace exceeds inspection ceiling');
        entries.push(entry);
      }
    } finally { await iterator.close().catch(() => undefined); }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if (rows.length + entries.length > MAX_NAMESPACE_ENTRIES) throw new Error('effect namespace exceeds inspection ceiling');
    for (const entry of entries) {
      const child = join(dir, entry.name); const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      let trusted: Awaited<ReturnType<typeof inspectTrustedPath>>;
      try { trusted = await inspectTrustedPath(child, 'effect namespace entry', { surface: true }); }
      catch (error) {
        if (toleratedPaths.has(child)) { rows.push({ name, kind: 'untrusted-target' }); continue; }
        throw error;
      }
      if (!trusted) {
        if (toleratedPaths.has(child)) { rows.push({ name, kind: 'untrusted-target' }); continue; }
        throw new Error('effect namespace changed during read');
      }
      const identity = { dev: trusted.identity.dev, ino: trusted.identity.ino };
      if (entry.isDirectory()) { rows.push({ name, kind: 'directory', identity }); await visit(child, name); continue; }
      if (!entry.isFile()) { rows.push({ name, kind: 'other' }); continue; }
      const file = await readBoundedUtf8File(child, 'effect namespace file', MAX_EFFECT_RECORD_BYTES);
      if (file.kind === 'oversized') {
        if (toleratedPaths.has(child)) { rows.push({ name, kind: 'oversized-target', bytes: trusted.stat.size }); continue; }
        throw new Error('effect namespace file exceeds inspection ceiling');
      }
      if (file.kind === 'unreadable' || file.kind === 'absent') throw new Error('effect namespace changed during read');
      rows.push({ name, kind: 'file', identity, digest: file.digest, bytes: file.bytes.length });
    }
  };
  await visit(root, '');
  return sha256(canonicalString(rows));
}

function journalBudget(state: MachineState, current: Record<string, unknown>): RecoveryCapsule['journal'] {
  const usedEvents = state.journal.length;
  const journalBytes = Buffer.byteLength(state.journal.map((entry) => canonicalString(entry)).join('\n') + (usedEvents ? '\n' : ''), 'utf8');
  const segmented = current.format === 'segmented/v1' || current.format === 'segmented/v2';
  const format = segmented ? 'segmented' : 'legacy';
  const eventCeiling = segmented ? null : JOURNAL_EVENT_CEILING;
  const byteCeiling = segmented ? null : JOURNAL_BYTE_CEILING;
  const activeUsed = segmented && Number.isSafeInteger(current.checkpointRevision) ? Math.max(0, usedEvents - Number(current.checkpointRevision)) : usedEvents;
  const persistedCeiling = Number.isSafeInteger(current.activeCeiling) && Number(current.activeCeiling) > 0 ? Number(current.activeCeiling) : undefined;
  const activeCeiling = segmented ? (persistedCeiling ?? SEGMENT_EVENT_CEILING) : null;
  return {
    format,
    events: { used: usedEvents, ceiling: eventCeiling, remaining: eventCeiling === null ? null : Math.max(0, eventCeiling - usedEvents) },
    bytes: { used: journalBytes, ceiling: byteCeiling, remaining: byteCeiling === null ? null : Math.max(0, byteCeiling - journalBytes) },
    activeSuffix: { used: activeUsed, ceiling: activeCeiling, remaining: activeCeiling === null ? null : Math.max(0, activeCeiling - activeUsed) },
  };
}

function unknownCause(command: OutboxCommand | undefined, terminal: TerminalRecord | undefined, terminalVerified: boolean, state: MachineState): string | null {
  if (command?.state !== 'UNKNOWN') return null;
  if (terminalVerified && terminal?.status === 'UNKNOWN' && terminal.outcome === 'unresolved-termination') return 'unresolved-termination';
  for (const entry of state.journal.slice().reverse()) {
    if (entry.event.kind !== 'OBSERVATION' || entry.event.category !== 'RECOVERY' || typeof entry.event.ref.bytes !== 'string') continue;
    try {
      const proof = parseCanonical<Record<string, unknown>>(entry.event.ref.bytes);
      // Recovery observations are evidence, not authority.  A token-only
      // match would let a stale/wrong-digest proof explain a different
      // command, so require the immutable command digest as well.
      if (proof.launchToken === command.launchToken && proof.commandDigest === command.commandDigest && proof.status === 'UNKNOWN') return 'restart-recovery';
    } catch { /* state validator already guards canonical proof */ }
  }
  return 'unknown-dispatch';
}

function nextProof(command: OutboxCommand | undefined, effects: RecoveryCapsule['effects']): string | null {
  if (!command) return null;
  if (command.state === 'UNKNOWN') {
    if (!effects.launch.verified && !effects.launchIntent.verified) return 'observe exact launch token or obtain a human receipt';
    if (!effects.terminal.verified) return 'observe exact launch token or obtain a human receipt';
    return null;
  }
  if (command.state === 'CLAIMED') return 'verify launch evidence before observe';
  if (command.state === 'PENDING') return 'dispatch remains parent-authorized';
  return null;
}

function lockStatus(file: BoundedUtf8File): RecoveryCapsule['fence']['lock'] {
  if (file.kind === 'absent') return 'ABSENT';
  if (file.kind === 'unreadable' || file.kind === 'oversized') return file.kind === 'oversized' ? 'MALFORMED' : 'UNREADABLE';
  if (file.kind !== 'ok') return 'MALFORMED';
  try { const value = parseCanonical<Record<string, unknown>>(file.text); if (!value || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1) return 'MALFORMED'; return 'PRESENT'; } catch { return 'MALFORMED'; }
}

/** Read one exact run/token evidence capsule.  No mutating store operation,
 * dispatch, observation, lock acquisition, quarantine or cache call is made. */
export async function inspectRecovery(input: RecoveryInspectionInput): Promise<RecoveryCapsule> {
  if (!input || typeof input !== 'object') fail('input is malformed');
  const root = canonicalRoot(input); const runId = requestRunId(input);
  const launchToken = requestToken(input);
  const commandDigestRequested = validateDigest(input.commandDigest, 'commandDigest');
  const authorityDigest = validateDigest(input.authorityDigest, 'authorityDigest');
  const policyDigestRequested = validateDigest(input.policyDigest, 'policyDigest');
  const policy = input.policy;
  if (policy) {
    try { validateCodexHostPolicy(policy); } catch (error) { fail(`policy is invalid: ${(error as Error).message}`); }
    if (policy.runRoot !== root || policy.runId !== runId || policy.planDigest.length !== 64) fail('policy is outside requested run');
  }
  const effectsRoot = resolve(input.effectsRoot ?? policy?.effectsRoot ?? join(root, '.codex-effects'));
  if (!isCanonicalRootPath(effectsRoot) || !pathWithin(root, effectsRoot)) fail('effectsRoot is outside run root');
  if (policy && input.effectsRoot !== undefined && resolve(input.effectsRoot) !== policy.effectsRoot) fail('effectsRoot differs from policy');
  const tokenDir = tokenDirectory(effectsRoot, launchToken);
  const rootIdentity = await trustedIdentity(root, 'run root', { surface: true, kind: 'directory' });
  if (!rootIdentity) fail('run root is unavailable');
  const store = new FileArtifactStore(root);
  const loaded = await store.loadReadOnly(runId);
  if (!loaded.state) fail('committed state is absent');
  const state = loaded.state;
  if (state.modeEpoch !== 0) fail('committed state modeEpoch is unsupported');
  boundedCapsuleIdentity(state.runId, 'committed runId');
  boundedCapsuleIdentity(state.phaseId, 'committed phaseId');
  const currentRead = await readCurrent(root); const current = currentRead.value;
  if (current.modeEpoch !== 0) fail('CURRENT modeEpoch is unsupported');
  if (current.generation !== loaded.generation || current.writerFence !== state.writerFence || current.revision !== state.revision || current.attemptEpoch !== state.attemptEpoch || current.authorityEpoch !== state.authorityEpoch || current.barrierEpoch !== state.barrierEpoch || current.modeEpoch !== state.modeEpoch) fail('CURRENT disagrees with committed state');
  const paths = { intent: join(tokenDir, 'launch-intent.json'), launch: join(tokenDir, 'launch.json'), terminal: join(tokenDir, 'terminal.json'), output: join(tokenDir, 'result.json') };
  const toleratedPaths = new Set([paths.intent, paths.launch, paths.terminal, paths.output]);
  const beforeNamespace = await namespaceDigest(effectsRoot, toleratedPaths);
  const command = Object.values(state.outbox).find((candidate) => candidate.launchToken === launchToken);
  const binding = commandBinding(command, runId, commandDigestRequested);
  const lease = leaseStatus(command, state);
  const expectedPolicyDigest = policyDigestRequested ?? (policy ? codexHostPolicyDigest(policy) : undefined);
  const [intentFile, launchFile, terminalFile] = await Promise.all([
    readBoundedUtf8File(paths.intent, 'launch intent', MAX_EFFECT_RECORD_BYTES),
    readBoundedUtf8File(paths.launch, 'launch record', MAX_EFFECT_RECORD_BYTES),
    readBoundedUtf8File(paths.terminal, 'terminal record', MAX_EFFECT_RECORD_BYTES),
  ]);
  const intentParsed = recordFromFile(intentFile, validateLaunchIntentRecord);
  const launchParsed = recordFromFile(launchFile, validateLaunchRecord);
  const terminalParsed = recordFromFile(terminalFile, validateTerminalRecord);
  let intentEvidence = intentParsed.evidence; let launchEvidence = launchParsed.evidence; let terminalEvidence = terminalParsed.evidence;
  let launchChainValid = false;
  if (binding === 'MATCH' && command && intentParsed.record && launchParsed.record) {
    try {
      validateHistoricalCodexEffect({ command, runRoot: root, requiredStage: 'launch', intent: intentParsed.record, launch: launchParsed.record, policy, expectedPolicyDigest, expectedAuthorityDigest: authorityDigest });
      launchChainValid = true;
    } catch {
      intentEvidence = withStatus(intentEvidence, 'MISMATCH', false);
      launchEvidence = withStatus(launchEvidence, 'MISMATCH', false);
    }
  } else if (binding === 'MISMATCH') {
    if (intentParsed.record) intentEvidence = withStatus(intentEvidence, 'MISMATCH', false);
    if (launchParsed.record) launchEvidence = withStatus(launchEvidence, 'MISMATCH', false);
    if (terminalParsed.record) terminalEvidence = withStatus(terminalEvidence, 'MISMATCH', false);
  }
  if (terminalParsed.record && launchChainValid && command) {
    const output = await readBoundedUtf8File(paths.output, 'Codex final output', policy?.maxOutputBytes ?? MAX_EFFECT_RECORD_BYTES);
    let report: BoundedUtf8File | undefined;
    if (terminalParsed.record.outcome === 'normal-completion' && terminalParsed.record.reportPath && reportPathSafe(terminalParsed.record.reportPath, root)) {
      report = await readBoundedUtf8File(terminalParsed.record.reportPath, 'worker report', policy?.maxReportBytes ?? MAX_EFFECT_RECORD_BYTES);
    }
    try {
      validateHistoricalCodexEffect({ command, runRoot: root, requiredStage: 'terminal', intent: intentParsed.record!, launch: launchParsed.record!, terminal: terminalParsed.record, output, report, policy, expectedPolicyDigest, expectedAuthorityDigest: authorityDigest });
    } catch { terminalEvidence = withStatus(terminalEvidence, 'MISMATCH', false); }
  } else if (terminalParsed.record && !launchChainValid) terminalEvidence = withStatus(terminalEvidence, 'MISMATCH', false);
  const afterNamespace = await namespaceDigest(effectsRoot, toleratedPaths);
  if (beforeNamespace !== afterNamespace) {
    fail('effect namespace changed during read');
  }
  const finalLoaded = await store.loadReadOnly(runId);
  if (!finalLoaded.state || finalLoaded.generation !== loaded.generation || digest(finalLoaded.state) !== digest(state)) fail('committed generation changed during read');
  const afterRootIdentity = await trustedIdentity(root, 'run root', { surface: true, kind: 'directory' });
  const afterCurrentIdentity = await trustedIdentity(join(root, '.kernel', 'CURRENT'), 'CURRENT', { surface: true, kind: 'file' });
  if (!afterRootIdentity || !sameFilesystemIdentity(rootIdentity, afterRootIdentity) || !afterCurrentIdentity || !sameFilesystemIdentity(currentRead.identity, afterCurrentIdentity)) fail('run root or CURRENT changed during read');
  const lock = lockStatus(await readBoundedUtf8File(join(root, '.kernel', '.writer.lock'), 'writer lock', CURRENT_BYTE_CEILING));
  const capsule: RecoveryCapsule = { schema: RECOVERY_SCHEMA, request: { runId, launchTokenDigest: sha256(launchToken), commandDigest: commandDigestRequested ?? command?.commandDigest ?? null }, run: { runId: state.runId, phaseId: state.phaseId, generation: loaded.generation, revision: state.revision, planDigest: state.planDigest, epochs: { attempt: state.attemptEpoch, authority: state.authorityEpoch, barrier: state.barrierEpoch, mode: state.modeEpoch }, writerFenceDigest: sha256(state.writerFence), verified: true }, journal: journalBudget(state, current), outbox: { found: Boolean(command), state: command?.state ?? null, stepId: capsuleStepId(command?.stepId), commandDigest: command?.commandDigest ?? null, binding, lease }, effects: { launchIntent: intentEvidence, launch: launchEvidence, terminal: terminalEvidence }, unknown: { active: command?.state === 'UNKNOWN', cause: unknownCause(command, terminalParsed.record, terminalEvidence.verified && terminalEvidence.binding === 'MATCH', state) }, fence: { root: 'VERIFIED', current: 'VERIFIED', writer: current.writerFence === state.writerFence ? 'VERIFIED' : 'MISMATCH', lock, namespace: 'UNCHANGED' }, nextProof: nextProof(command, { launchIntent: intentEvidence, launch: launchEvidence, terminal: terminalEvidence }) };
  validateRecoveryCapsule(capsule);
  if (Buffer.byteLength(canonicalString(capsule), 'utf8') > RECOVERY_OUTPUT_BYTE_CEILING) fail('capsule exceeds output ceiling');
  return capsule;
}
