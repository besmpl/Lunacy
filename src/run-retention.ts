import { execFileSync } from 'node:child_process';
import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalString, digest, digestBytes, parseCanonical } from './canonical.js';
import { inspectTrustedPath, sameFilesystemIdentity, syncDirectory, syncFile } from './filesystem.js';
import { withBodyWriterAdmission, withRunFinalizationExclusion } from './release-admission.js';
import { inventoryRetentionBody, nativeRetentionPlatform, type BodyCleanupEntry, type BodyInventory, type RetentionPlatform, type TrustedIdentity } from './run-retention-platform.js';
import { constructParentDecisionSubmission, submitParentDecision, type DecisionInboxEntry, type DecisionInboxSelection } from './decision-inbox.js';
import { FileArtifactStore } from './store.js';
import type { Plan } from './model.js';

export type RetentionDisposition = 'ACCEPTED' | 'ABANDONED';
export type RetentionRefusalCode =
  | 'ACCEPTANCE_INVALID' | 'AUTHORITY_OPEN' | 'WRITER_ACTIVE'
  | 'QUIESCENCE_UNAVAILABLE' | 'RESULT_DRIFT' | 'UNSAFE_BODY' | 'BODY_DRIFT'
  | 'CUSTODY_COLLISION' | 'FINALIZATION_CONFLICT' | 'LIMIT_EXCEEDED';
export type RetentionDoctorCode =
  | 'LEGACY_LAYOUT' | 'BODY_ACTIVE' | 'READY_TO_SEAL' | 'RESUME_PRE_RENAME'
  | 'RESUME_PRE_PUBLISH' | 'RESUME_CLEANUP' | 'SEALED_CLEAN' | 'ABANDONED_CLEAN'
  | 'ATTENTION_UNSAFE_PATH' | 'ATTENTION_IDENTITY_DRIFT' | 'ATTENTION_CUSTODY'
  | 'ATTENTION_UNKNOWN_COMBINATION' | 'INCONSISTENT_READ';
export type RetentionNextAction = 'NOOP' | 'DRY_RUN' | 'RESUME_EXACT' | 'REINIT_FRESH_ROOT' | 'PRESERVE_AND_ESCALATE';

type ResultIdentity = Readonly<Record<string, unknown>>;
export type ParentAcceptance = Readonly<Record<string, unknown>>;
export type ParentAbandonment = Readonly<Record<string, unknown>>;
export type RunReceipt = Readonly<Record<string, unknown>>;
export type FinalizationMarker = Readonly<Record<string, unknown>>;
export type SnapshotPresence = 'ABSENT' | 'VALID' | 'INVALID';
export type RetentionSnapshot = Readonly<{
  body: SnapshotPresence;
  receipt: SnapshotPresence;
  abandonmentReceipt: SnapshotPresence;
  marker: SnapshotPresence;
  stagedReceipt: SnapshotPresence;
  tombstone: SnapshotPresence;
  acceptanceInput: SnapshotPresence;
  writerActive?: boolean;
  authorityOpen?: boolean;
  unsafePath?: boolean;
  identityDrift?: boolean;
  custodyCollision?: boolean;
  inconsistentRead?: boolean;
}>;
export type DoctorResult = Readonly<{
  schema: 'lunacy-retention-doctor/v1';
  code: RetentionDoctorCode;
  nextAction: RetentionNextAction;
}>;
export type RetentionDoctorReport = DoctorResult & Readonly<{
  protectedPaths: readonly string[];
  observed: Readonly<{ body: boolean; receipt: boolean; marker: boolean; tombstone: boolean }>;
}>;

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_CENSUS_ENTRIES = 4096;
const FIXED = Object.freeze({
  receipt: 'RUN-RECEIPT.json',
  abandonReceipt: 'ABANDON-RECEIPT.json',
  marker: '.lunacy-run-finalization.json',
  stagedReceipt: '.RUN-RECEIPT.json.tmp',
  acceptance: '.lunacy-parent-acceptance.json',
  stagedAbandonReceipt: '.ABANDON-RECEIPT.json.tmp',
  abandonment: '.lunacy-parent-abandonment.json',
  body: '.work',
});

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError(`${label} is malformed`);
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const item = record(value, label);
  const actual = Object.keys(item).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} fields are not closed`);
  return item;
}
function text(value: unknown, label: string): string { if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) throw new TypeError(`${label} is invalid`); return value; }
function sha(value: unknown, label: string): string { const result = text(value, label); if (!SHA256.test(result)) throw new TypeError(`${label} is invalid`); return result; }
function integer(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} is invalid`); return value as number; }
function fixedPath(value: unknown, expected: string, label: string): string { if (value !== expected) throw new TypeError(`${label} is invalid`); return expected; }
function canonicalCopy<T extends Record<string, unknown>>(value: T): Readonly<T> { return Object.freeze(parseCanonical<T>(canonicalString(value))); }

function validateResultIdentity(value: unknown): ResultIdentity {
  const item = record(value, 'result identity');
  if (item.kind === 'commit') {
    const commit = exact(item, ['kind', 'root', 'oid'], 'commit result identity');
    text(commit.root, 'commit root');
    if (resolve(commit.root as string) !== commit.root) throw new TypeError('commit root must be absolute and canonical');
    if (typeof commit.oid !== 'string' || !COMMIT.test(commit.oid)) throw new TypeError('commit oid is invalid');
    return canonicalCopy(commit);
  }
  const manifest = exact(item, ['kind', 'schema', 'roots', 'entries'], 'manifest result identity');
  if (manifest.kind !== 'manifest' || manifest.schema !== 'lunacy-product-manifest/v1' || !Array.isArray(manifest.roots) || !Array.isArray(manifest.entries)) throw new TypeError('manifest result identity is invalid');
  const roots = manifest.roots.map((root, index) => text(root, `manifest root ${index}`));
  if (roots.length === 0 || roots.some((root) => root.startsWith('/') || root.includes('\\') || root.split('/').some((part) => !part || part === '.' || part === '..')) || [...roots].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).some((root, index) => root !== roots[index]) || new Set(roots).size !== roots.length) throw new TypeError('manifest roots are not canonical');
  let prior = '';
  for (const [index, entryValue] of manifest.entries.entries()) {
    const entry = exact(entryValue, ['path', 'digest'], `manifest entry ${index}`);
    const path = text(entry.path, `manifest entry ${index} path`);
    sha(entry.digest, `manifest entry ${index} digest`);
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..') || path === 'Lunacy' || path.startsWith('Lunacy/') || !roots.some((root) => path === root || path.startsWith(`${root}/`)) || (prior && Buffer.compare(Buffer.from(prior), Buffer.from(path)) >= 0)) throw new TypeError('manifest entries are not canonical');
    prior = path;
  }
  return canonicalCopy(manifest);
}

function validateManualAcceptance(value: unknown): ParentAcceptance {
  const item = exact(value, ['schema', 'runId', 'disposition', 'activeWorkers', 'authorityDigest', 'outcomeDigest', 'terminalStateDigest', 'resultIdentity', 'resultIdentityDigest'], 'parent acceptance');
  if (item.schema !== 'lunacy-parent-acceptance/v1' || item.disposition !== 'ACCEPTED' || item.activeWorkers !== 'NONE') throw new TypeError('parent acceptance is invalid');
  text(item.runId, 'acceptance runId'); sha(item.authorityDigest, 'acceptance authorityDigest'); sha(item.outcomeDigest, 'acceptance outcomeDigest'); sha(item.terminalStateDigest, 'acceptance terminalStateDigest');
  const identity = validateResultIdentity(item.resultIdentity);
  if (sha(item.resultIdentityDigest, 'acceptance resultIdentityDigest') !== digest(identity)) throw new TypeError('acceptance result identity digest disagrees');
  return canonicalCopy(item);
}

function validateRuntimeAcceptance(value: unknown): ParentAcceptance {
  const item = exact(value, ['schema', 'runId', 'candidate', 'passRecord', 'terminal'], 'runtime acceptance');
  if (item.schema !== 'lunacy-runtime-acceptance/v1') throw new TypeError('runtime acceptance schema is invalid');
  text(item.runId, 'runtime acceptance runId');
  const candidate = exact(item.candidate, ['schema', 'runId', 'prePass', 'gate', 'activeWorkers', 'authorityDigest', 'outcomeDigest', 'resultIdentity', 'resultIdentityDigest'], 'runtime acceptance candidate');
  if (candidate.schema !== 'lunacy-runtime-acceptance-candidate/v1' || candidate.runId !== item.runId || candidate.activeWorkers !== 'NONE') throw new TypeError('runtime acceptance candidate is invalid');
  const prePass = exact(candidate.prePass, ['generation', 'revision', 'stateDigest'], 'runtime prePass'); integer(prePass.generation, 'prePass generation'); integer(prePass.revision, 'prePass revision'); sha(prePass.stateDigest, 'prePass stateDigest');
  const gate = exact(candidate.gate, ['token', 'eventDigest', 'eventIdentityDigest'], 'runtime gate'); text(gate.token, 'gate token'); sha(gate.eventDigest, 'gate eventDigest'); sha(gate.eventIdentityDigest, 'gate eventIdentityDigest');
  sha(candidate.authorityDigest, 'candidate authorityDigest'); sha(candidate.outcomeDigest, 'candidate outcomeDigest'); const identity = validateResultIdentity(candidate.resultIdentity); if (sha(candidate.resultIdentityDigest, 'candidate resultIdentityDigest') !== digest(identity)) throw new TypeError('candidate result identity digest disagrees');
  const passRecord = exact(item.passRecord, ['revision', 'eventDigest', 'eventIdentityDigest'], 'runtime passRecord'); integer(passRecord.revision, 'pass revision'); sha(passRecord.eventDigest, 'pass eventDigest'); sha(passRecord.eventIdentityDigest, 'pass eventIdentityDigest');
  if (passRecord.revision !== (prePass.revision as number) + 1 || passRecord.eventDigest !== gate.eventDigest || passRecord.eventIdentityDigest !== gate.eventIdentityDigest) throw new TypeError('runtime PASS is not the bound next record');
  const terminal = exact(item.terminal, ['generation', 'stateDigest'], 'runtime terminal'); integer(terminal.generation, 'terminal generation'); sha(terminal.stateDigest, 'terminal stateDigest');
  return canonicalCopy(item);
}

export function validateParentAcceptance(value: unknown): ParentAcceptance {
  const item = record(value, 'parent acceptance');
  return item.schema === 'lunacy-parent-acceptance/v1' ? validateManualAcceptance(item) : validateRuntimeAcceptance(item);
}

function validateCustodySummary(value: unknown): Record<string, unknown> {
  const item = exact(value, ['schema', 'pending', 'claimed', 'unknown', 'malformed'], 'custody summary');
  if (item.schema !== 'lunacy-run-custody-summary/v1') throw new TypeError('custody summary schema is invalid');
  for (const key of ['pending', 'claimed', 'unknown', 'malformed'] as const) integer(item[key], `custody ${key}`);
  if (item.pending !== 0 || item.claimed !== 0) throw new TypeError('abandonment has unresolved actionable custody');
  return item;
}

export function validateParentAbandonment(value: unknown): ParentAbandonment {
  const item = exact(value, ['schema', 'runId', 'disposition', 'status', 'reasonCode', 'activeWorkers', 'authorityDigest', 'terminalStateDigest', 'custody'], 'parent abandonment');
  if (item.schema !== 'lunacy-run-abandonment/v1' || item.disposition !== 'ABANDONED' || (item.status !== 'BLOCKED' && item.status !== 'STOPPED') || item.activeWorkers !== 'NONE') throw new TypeError('parent abandonment is invalid');
  text(item.runId, 'abandonment runId'); sha(item.authorityDigest, 'abandonment authorityDigest'); sha(item.terminalStateDigest, 'abandonment terminalStateDigest');
  const reason = text(item.reasonCode, 'abandonment reasonCode'); if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reason)) throw new TypeError('abandonment reasonCode is invalid');
  validateCustodySummary(item.custody);
  return canonicalCopy(item);
}

function validateQuiescence(value: unknown): Record<string, unknown> {
  const item = exact(value, ['schema', 'digest', 'openHandles', 'publicationGate'], 'receipt quiescence');
  if (item.schema !== 'lunacy-run-quiescence/v1' || item.openHandles !== 0 || item.publicationGate !== 'REQUIRED_ZERO_HANDLES') throw new TypeError('receipt quiescence is invalid');
  sha(item.digest, 'quiescence digest'); return item;
}

export function validateRunReceipt(value: unknown): RunReceipt {
  const item = exact(value, ['schema', 'runId', 'disposition', 'authorityDigest', 'seedDigest', 'terminalStateDigest', 'quiescence', 'outcome', 'acceptance', 'resultIdentity', 'body'], 'run receipt');
  if (item.schema !== 'lunacy-run-receipt/v1' || item.disposition !== 'ACCEPTED') throw new TypeError('run receipt is invalid');
  text(item.runId, 'receipt runId'); sha(item.authorityDigest, 'receipt authorityDigest'); sha(item.seedDigest, 'receipt seedDigest'); sha(item.terminalStateDigest, 'receipt terminalStateDigest'); const quiescence = validateQuiescence(item.quiescence);
  const outcome = exact(item.outcome, ['path', 'digest'], 'receipt outcome'); fixedPath(outcome.path, 'OUTCOME.md', 'outcome path'); sha(outcome.digest, 'outcome digest');
  const acceptance = exact(item.acceptance, ['kind', 'digest', 'witness'], 'receipt acceptance'); if (acceptance.kind !== 'manual-parent/v1' && acceptance.kind !== 'runtime-pass/v1') throw new TypeError('receipt acceptance kind is invalid'); const witness = validateParentAcceptance(acceptance.witness); const witnessSchema = (witness as Record<string, unknown>).schema; if ((acceptance.kind === 'manual-parent/v1' && witnessSchema !== 'lunacy-parent-acceptance/v1') || (acceptance.kind === 'runtime-pass/v1' && witnessSchema !== 'lunacy-runtime-acceptance/v1')) throw new TypeError('receipt acceptance kind disagrees with witness schema'); if (sha(acceptance.digest, 'acceptance digest') !== digest(witness)) throw new TypeError('receipt acceptance digest disagrees');
  const resultIdentity = validateResultIdentity(item.resultIdentity); const body = exact(item.body, ['root', 'treeDigest', 'files', 'bytes', 'action'], 'receipt body'); fixedPath(body.root, '.work', 'body root'); sha(body.treeDigest, 'body treeDigest'); integer(body.files, 'body files'); integer(body.bytes, 'body bytes'); if (body.action !== 'PRUNE') throw new TypeError('body action is invalid');
  const witnessRecord = witness as Record<string, unknown>; const manual = witnessRecord.schema === 'lunacy-parent-acceptance/v1'; const nested = manual ? witnessRecord : record(witnessRecord.candidate, 'runtime candidate'); const terminal = manual ? witnessRecord.terminalStateDigest : record(witnessRecord.terminal, 'runtime terminal').stateDigest;
  if (nested.authorityDigest !== item.authorityDigest || nested.outcomeDigest !== outcome.digest || terminal !== item.terminalStateDigest || digest(resultIdentity) !== nested.resultIdentityDigest) throw new TypeError('receipt witness disagrees with receipt');
  if (canonicalString(resultIdentity) !== canonicalString(nested.resultIdentity)) throw new TypeError('receipt result identity disagrees');
  void quiescence;
  return canonicalCopy(item);
}

export function validateAbandonReceipt(value: unknown): RunReceipt {
  const item = exact(value, ['schema', 'runId', 'disposition', 'status', 'authorityDigest', 'seedDigest', 'terminalStateDigest', 'quiescence', 'reasonCode', 'retainedCustody', 'abandonment', 'body'], 'abandon receipt');
  if (item.schema !== 'lunacy-run-abandon-receipt/v1' || item.disposition !== 'ABANDONED' || (item.status !== 'BLOCKED' && item.status !== 'STOPPED')) throw new TypeError('abandon receipt is invalid');
  text(item.runId, 'abandon receipt runId'); sha(item.authorityDigest, 'abandon receipt authorityDigest'); sha(item.seedDigest, 'abandon receipt seedDigest'); sha(item.terminalStateDigest, 'abandon receipt terminalStateDigest'); validateQuiescence(item.quiescence);
  const reasonCode = text(item.reasonCode, 'abandon receipt reasonCode'); if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)) throw new TypeError('abandon receipt reasonCode is invalid');
  const retainedCustody = validateCustodySummary(item.retainedCustody);
  const abandonment = exact(item.abandonment, ['digest', 'witness'], 'receipt abandonment'); const witness = validateParentAbandonment(abandonment.witness); if (sha(abandonment.digest, 'abandonment digest') !== digest(witness)) throw new TypeError('receipt abandonment digest disagrees');
  const body = exact(item.body, ['root', 'treeDigest', 'files', 'bytes', 'action'], 'abandon receipt body'); fixedPath(body.root, '.work', 'body root'); sha(body.treeDigest, 'body treeDigest'); integer(body.files, 'body files'); integer(body.bytes, 'body bytes'); if (body.action !== 'PRUNE') throw new TypeError('body action is invalid');
  const authority = witness as Record<string, unknown>;
  if (authority.runId !== item.runId || authority.status !== item.status || authority.authorityDigest !== item.authorityDigest || authority.terminalStateDigest !== item.terminalStateDigest || authority.reasonCode !== reasonCode || canonicalString(authority.custody) !== canonicalString(retainedCustody)) throw new TypeError('abandon receipt authority disagrees with receipt');
  return canonicalCopy(item);
}

function validateIdentity(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const item = exact(value, keys, label); for (const key of ['path', 'sourcePath'] as const) if (key in item) text(item[key], `${label} ${key}`); for (const key of ['dev', 'ino'] as const) if (key in item) text(item[key], `${label} ${key}`); if ('digest' in item) sha(item.digest, `${label} digest`); if ('treeDigest' in item) sha(item.treeDigest, `${label} treeDigest`); return item;
}
export function validateFinalizationMarker(value: unknown): FinalizationMarker {
  const item = exact(value, ['schema', 'runId', 'receiptDigest', 'disposition', 'receiptPath', 'acceptanceDigest', 'authorityDigest', 'resultIdentityDigest', 'quiescenceDigest', 'acceptanceInput', 'stagedReceipt', 'body', 'tombstonePath', 'cleanupEntries'], 'finalization marker');
  if (item.schema !== 'lunacy-run-finalization/v1' || (item.disposition !== 'ACCEPTED' && item.disposition !== 'ABANDONED')) throw new TypeError('finalization marker is invalid'); text(item.runId, 'marker runId'); sha(item.receiptDigest, 'marker receiptDigest'); sha(item.acceptanceDigest, 'marker acceptanceDigest'); sha(item.authorityDigest, 'marker authorityDigest'); sha(item.resultIdentityDigest, 'marker resultIdentityDigest'); sha(item.quiescenceDigest, 'marker quiescenceDigest');
  fixedPath(item.receiptPath, item.disposition === 'ACCEPTED' ? 'RUN-RECEIPT.json' : 'ABANDON-RECEIPT.json', 'marker receiptPath');
  validateIdentity(item.acceptanceInput, ['path', 'dev', 'ino', 'digest'], 'marker acceptanceInput'); validateIdentity(item.stagedReceipt, ['path', 'dev', 'ino', 'digest'], 'marker stagedReceipt'); validateIdentity(item.body, ['sourcePath', 'dev', 'ino', 'treeDigest'], 'marker body');
  const acceptanceInput = item.acceptanceInput as Record<string, unknown>; const stagedReceipt = item.stagedReceipt as Record<string, unknown>; const markerBody = item.body as Record<string, unknown>;
  if (item.disposition === 'ACCEPTED') { fixedPath(acceptanceInput.path, '.lunacy-parent-acceptance.json', 'marker acceptance input path'); fixedPath(stagedReceipt.path, '.RUN-RECEIPT.json.tmp', 'marker staged receipt path'); }
  else { fixedPath(acceptanceInput.path, '.lunacy-parent-abandonment.json', 'marker abandonment input path'); fixedPath(stagedReceipt.path, '.ABANDON-RECEIPT.json.tmp', 'marker staged abandonment receipt path'); }
  fixedPath(markerBody.sourcePath, '.work', 'marker body source path'); if (stagedReceipt.digest !== item.receiptDigest) throw new TypeError('marker staged receipt digest disagrees'); if (item.disposition === 'ABANDONED' && item.resultIdentityDigest !== '0'.repeat(64)) throw new TypeError('abandonment marker result identity is invalid');
  const tombstone = text(item.tombstonePath, 'marker tombstonePath'); if (!tombstone.startsWith('.work.prune-') || tombstone !== `.work.prune-${item.receiptDigest}`) throw new TypeError('marker tombstonePath is invalid');
  if (!Array.isArray(item.cleanupEntries) || item.cleanupEntries.length > MAX_CENSUS_ENTRIES) throw new TypeError('marker cleanupEntries are invalid'); let prior = '';
  for (const [index, entryValue] of item.cleanupEntries.entries()) { const entryRecord = record(entryValue, `cleanup entry ${index}`); const directory = !Object.prototype.hasOwnProperty.call(entryRecord, 'digest'); const entry = validateIdentity(entryRecord, directory ? ['relativePath', 'dev', 'ino', 'mode'] : ['relativePath', 'dev', 'ino', 'mode', 'size', 'digest'], `cleanup entry ${index}`); const path = entry.relativePath === '.' && directory ? '.' : text(entry.relativePath, `cleanup entry ${index} path`); if (path.includes('\\') || path.startsWith('/') || (path !== '.' && path.split('/').some((part) => !part || part === '.' || part === '..')) || (prior && Buffer.compare(Buffer.from(prior), Buffer.from(path)) >= 0)) throw new TypeError('cleanup entries are not canonical'); integer(entry.mode, `cleanup entry ${index} mode`); if (!directory) integer(entry.size, `cleanup entry ${index} size`); prior = path; }
  return canonicalCopy(item);
}

const ACTIONS: Readonly<Record<RetentionDoctorCode, RetentionNextAction>> = Object.freeze({
  LEGACY_LAYOUT: 'NOOP', BODY_ACTIVE: 'NOOP', READY_TO_SEAL: 'DRY_RUN', RESUME_PRE_RENAME: 'RESUME_EXACT', RESUME_PRE_PUBLISH: 'RESUME_EXACT', RESUME_CLEANUP: 'RESUME_EXACT', SEALED_CLEAN: 'NOOP', ABANDONED_CLEAN: 'NOOP', ATTENTION_UNSAFE_PATH: 'PRESERVE_AND_ESCALATE', ATTENTION_IDENTITY_DRIFT: 'PRESERVE_AND_ESCALATE', ATTENTION_CUSTODY: 'PRESERVE_AND_ESCALATE', ATTENTION_UNKNOWN_COMBINATION: 'PRESERVE_AND_ESCALATE', INCONSISTENT_READ: 'PRESERVE_AND_ESCALATE',
});
function result(code: RetentionDoctorCode): DoctorResult { return Object.freeze({ schema: 'lunacy-retention-doctor/v1', code, nextAction: ACTIONS[code] }); }

export function classifyRetentionSnapshot(snapshot: RetentionSnapshot): DoctorResult {
  if (snapshot.inconsistentRead) return result('INCONSISTENT_READ');
  if (snapshot.unsafePath) return result('ATTENTION_UNSAFE_PATH');
  if (snapshot.identityDrift) return result('ATTENTION_IDENTITY_DRIFT');
  if (snapshot.custodyCollision) return result('ATTENTION_CUSTODY');
  if ([snapshot.body, snapshot.receipt, snapshot.abandonmentReceipt, snapshot.marker, snapshot.stagedReceipt, snapshot.tombstone, snapshot.acceptanceInput].includes('INVALID')) return result('ATTENTION_UNKNOWN_COMBINATION');
  const present = (value: SnapshotPresence): boolean => value === 'VALID';
  const body = present(snapshot.body); const receipt = present(snapshot.receipt); const abandoned = present(snapshot.abandonmentReceipt); const marker = present(snapshot.marker); const staged = present(snapshot.stagedReceipt); const tombstone = present(snapshot.tombstone); const acceptance = present(snapshot.acceptanceInput);
  if (!body && !receipt && !abandoned && !marker && !staged && !tombstone && !acceptance) return result('LEGACY_LAYOUT');
  if (receipt && !abandoned && !body && !marker && !staged && !tombstone) return result('SEALED_CLEAN');
  if (abandoned && !receipt && !body && !marker && !staged && !tombstone) return result('ABANDONED_CLEAN');
  if (marker && receipt !== abandoned && !body && !staged) return result('RESUME_CLEANUP');
  if (marker && !receipt && !abandoned && tombstone && !body && staged) return result('RESUME_PRE_PUBLISH');
  if (marker && !receipt && !abandoned && body && staged && !tombstone) return result('RESUME_PRE_RENAME');
  if (!marker && !receipt && !abandoned && body && staged && !tombstone) return result(acceptance && !snapshot.writerActive && !snapshot.authorityOpen ? 'READY_TO_SEAL' : 'BODY_ACTIVE');
  if (!receipt && !abandoned && body && !marker && !staged && !tombstone) return result(acceptance && !snapshot.writerActive && !snapshot.authorityOpen ? 'READY_TO_SEAL' : 'BODY_ACTIVE');
  return result('ATTENTION_UNKNOWN_COMBINATION');
}

type CensusEntry = Readonly<{ name: string; kind: 'file' | 'directory' | 'other'; dev: string; ino: string; mode: number; nlink: number; size: number; mtimeNs: string; digest?: string }>;
type Census = Readonly<{ root: CensusEntry; entries: readonly CensusEntry[] }>;
function statEntry(name: string, stat: Stats, contentDigest?: string): CensusEntry { return Object.freeze({ name, kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other', dev: String(stat.dev), ino: String(stat.ino), mode: stat.mode, nlink: stat.nlink, size: stat.size, mtimeNs: String(Math.trunc(stat.mtimeMs * 1_000_000)), ...(contentDigest === undefined ? {} : { digest: contentDigest }) }); }
async function readBoundedRecord(path: string, stat: Stats): Promise<Uint8Array> { if (!stat.isFile() || stat.size > MAX_RECORD_BYTES || stat.size < 0) throw new TypeError('record is not a bounded regular file'); const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); try { const bound = await handle.stat({ bigint: false }); if (String(bound.dev) !== String(stat.dev) || String(bound.ino) !== String(stat.ino) || bound.size !== stat.size) throw new TypeError('record changed before read'); const bytes = await handle.readFile(); if (bytes.byteLength !== stat.size) throw new TypeError('record changed during read'); return bytes; } finally { await handle.close(); } }
async function census(runRoot: string): Promise<Census> {
  const root = await inspectTrustedPath(runRoot, 'retention run root', { surface: true, kind: 'directory' }); if (!root) throw new TypeError('run root is absent');
  const dirents = await fs.readdir(runRoot, { withFileTypes: true }); if (dirents.length > MAX_CENSUS_ENTRIES) throw new TypeError('run root entry limit exceeded'); dirents.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const entries: CensusEntry[] = [];
  for (const dirent of dirents) { const path = join(runRoot, dirent.name); const stat = await fs.lstat(path, { bigint: false }); let contentDigest: string | undefined; if ([FIXED.receipt, FIXED.abandonReceipt, FIXED.marker, FIXED.stagedReceipt, FIXED.stagedAbandonReceipt, FIXED.acceptance, FIXED.abandonment].includes(dirent.name as never) && stat.isFile() && stat.size <= MAX_RECORD_BYTES) contentDigest = digestBytes(await readBoundedRecord(path, stat)); entries.push(statEntry(dirent.name, stat, contentDigest)); }
  return Object.freeze({ root: statEntry('', root.stat), entries: Object.freeze(entries) });
}
function sameCensus(left: Census, right: Census): boolean { return canonicalString(left) === canonicalString(right); }
function find(censusValue: Census, name: string): CensusEntry | undefined { return censusValue.entries.find((entry) => entry.name === name); }
async function validatedPresence(runRoot: string, entry: CensusEntry | undefined, validator?: (value: unknown) => unknown): Promise<SnapshotPresence | 'DRIFT'> {
  if (!entry) return 'ABSENT'; if (entry.kind !== (validator ? 'file' : 'directory')) return 'INVALID'; if (!validator) return 'VALID';
  if (entry.size < 0 || entry.size > MAX_RECORD_BYTES || entry.nlink !== 1) return 'INVALID';
  let stat: Stats; let bytes: Uint8Array;
  try { stat = await fs.lstat(join(runRoot, entry.name)); if (String(stat.dev) !== entry.dev || String(stat.ino) !== entry.ino || stat.mode !== entry.mode || stat.nlink !== entry.nlink || stat.size !== entry.size || String(Math.trunc(stat.mtimeMs * 1_000_000)) !== entry.mtimeNs) return 'DRIFT'; bytes = await readBoundedRecord(join(runRoot, entry.name), stat); if (digestBytes(bytes) !== entry.digest) return 'DRIFT'; } catch { return 'DRIFT'; }
  try { const value = parseCanonical<unknown>(bytes); validator(value); return 'VALID'; } catch { return 'INVALID'; }
}

export async function inspectRetentionRun(runRootInput: string, options: Readonly<{ betweenCensuses?: () => void | Promise<void> }> = {}): Promise<RetentionDoctorReport> {
  const runRoot = resolve(runRootInput); if (runRoot !== runRootInput) throw new TypeError('run root must be absolute and canonical');
  let first: Census;
  try { first = await census(runRoot); } catch { const core = result('ATTENTION_UNSAFE_PATH'); return Object.freeze({ ...core, protectedPaths: Object.freeze([dirname(runRoot), runRoot]), observed: Object.freeze({ body: false, receipt: false, marker: false, tombstone: false }) }); }
  await options.betweenCensuses?.(); const second = await census(runRoot).catch(() => undefined);
  const protectedPaths = Object.freeze([dirname(runRoot), runRoot, ...first.entries.map((entry) => join(runRoot, entry.name))]);
  const bodyEntry = find(first, FIXED.body); const receiptEntry = find(first, FIXED.receipt); const abandonReceiptEntry = find(first, FIXED.abandonReceipt); const markerEntry = find(first, FIXED.marker); const acceptedStagedEntry = find(first, FIXED.stagedReceipt); const abandonedStagedEntry = find(first, FIXED.stagedAbandonReceipt); const acceptanceEntry = find(first, FIXED.acceptance); const abandonmentEntry = find(first, FIXED.abandonment); const tombstones = first.entries.filter((entry) => entry.name.startsWith('.work.prune-'));
  const observed = Object.freeze({ body: Boolean(bodyEntry), receipt: Boolean(receiptEntry), marker: Boolean(markerEntry), tombstone: tombstones.length > 0 });
  if (!second || !sameCensus(first, second)) { const core = result('INCONSISTENT_READ'); return Object.freeze({ ...core, protectedPaths, observed }); }
  const presences = { body: await validatedPresence(runRoot, bodyEntry), receipt: await validatedPresence(runRoot, receiptEntry, validateRunReceipt), abandonmentReceipt: await validatedPresence(runRoot, abandonReceiptEntry, validateAbandonReceipt), marker: await validatedPresence(runRoot, markerEntry, validateFinalizationMarker), acceptedStagedReceipt: await validatedPresence(runRoot, acceptedStagedEntry, validateRunReceipt), abandonedStagedReceipt: await validatedPresence(runRoot, abandonedStagedEntry, validateAbandonReceipt), acceptanceInput: await validatedPresence(runRoot, acceptanceEntry, validateParentAcceptance), abandonmentInput: await validatedPresence(runRoot, abandonmentEntry, validateParentAbandonment) };
  if (Object.values(presences).includes('DRIFT')) { const core = result('INCONSISTENT_READ'); return Object.freeze({ ...core, protectedPaths, observed }); }
  const bothStaged = acceptedStagedEntry && abandonedStagedEntry; const bothInputs = acceptanceEntry && abandonmentEntry;
  let markerMismatch = false;
  if (presences.marker === 'VALID' && markerEntry) { const marker = await readCanonicalFile<FinalizationMarker>(join(runRoot, FIXED.marker), 'finalization marker', validateFinalizationMarker); const abandoned = (marker.value as Record<string, unknown>).disposition === 'ABANDONED'; markerMismatch = abandoned ? Boolean(acceptedStagedEntry || receiptEntry || acceptanceEntry) : Boolean(abandonedStagedEntry || abandonReceiptEntry || abandonmentEntry); }
  const snapshot: RetentionSnapshot = Object.freeze({ body: presences.body as SnapshotPresence, receipt: presences.receipt as SnapshotPresence, abandonmentReceipt: presences.abandonmentReceipt as SnapshotPresence, marker: presences.marker as SnapshotPresence, stagedReceipt: (bothStaged ? 'INVALID' : presences.acceptedStagedReceipt !== 'ABSENT' ? presences.acceptedStagedReceipt : presences.abandonedStagedReceipt) as SnapshotPresence, tombstone: tombstones.length === 0 ? 'ABSENT' : tombstones.length === 1 && tombstones[0]!.kind === 'directory' && /^\.work\.prune-[0-9a-f]{64}$/.test(tombstones[0]!.name) ? 'VALID' : 'INVALID', acceptanceInput: (bothInputs ? 'INVALID' : presences.acceptanceInput !== 'ABSENT' ? presences.acceptanceInput : presences.abandonmentInput) as SnapshotPresence, identityDrift: markerMismatch, unsafePath: first.entries.some((entry) => entry.kind === 'other' || (entry.kind === 'file' && entry.nlink !== 1)) });
  const core = classifyRetentionSnapshot(snapshot); return Object.freeze({ ...core, protectedPaths, observed });
}

export type RetentionFaultPoint =
  | 'STAGED_RECEIPT_FSYNC' | 'MARKER_FSYNC' | 'BODY_RENAME' | 'BODY_RENAME_FSYNC'
  | 'FROZEN_REVALIDATED' | 'BEFORE_RECEIPT_RENAME' | 'RECEIPT_RENAME'
  | 'RECEIPT_RENAME_FSYNC' | 'CLEANUP_ENTRY' | 'TOMBSTONE_REMOVED'
  | 'ACCEPTANCE_REMOVED' | 'MARKER_REMOVED';
export type SealRunOptions = Readonly<{
  mode: 'dry-run' | 'accept' | 'abandon' | 'resume';
  installedRuntime?: string;
  signal?: AbortSignal;
  platform?: RetentionPlatform;
  fault?: (point: RetentionFaultPoint, detail?: string) => void | Promise<void>;
}>;
export type SealRunResult = Readonly<{
  schema: 'lunacy-run-seal-result/v1';
  status: 'READY' | 'SEALED' | 'RESUMED' | 'ALREADY_SEALED';
  runId: string;
  receiptDigest: string;
  body: Readonly<{ files: number; bytes: number; treeDigest: string }>;
}>;

function within(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
async function readCanonicalFile<T>(path: string, label: string, validator?: (value: unknown) => unknown): Promise<{ value: T; bytes: Buffer; stat: Stats; digest: string }> {
  const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
  if (!trusted || trusted.stat.nlink !== 1 || trusted.stat.size < 1 || trusted.stat.size > MAX_RECORD_BYTES) throw new Error(`${label} is absent or unsafe`);
  const bytes = Buffer.from(await readBoundedRecord(path, trusted.stat)); const value = parseCanonical<T>(bytes); validator?.(value);
  return { value, bytes, stat: trusted.stat, digest: digestBytes(bytes) };
}
async function writeExclusiveDurable(path: string, bytes: string, label: string): Promise<Stats> {
  const handle = await fs.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); const stat = await handle.stat(); await syncDirectory(dirname(path), `${label} parent`); return stat; }
  catch (error) { await handle.close().catch(() => undefined); await fs.unlink(path).catch(() => undefined); throw error; }
  finally { await handle.close().catch(() => undefined); }
}
async function unlinkIdentity(path: string, expected: Readonly<{ dev: string; ino: string }>, label: string): Promise<void> {
  const trusted = await inspectTrustedPath(path, label, { allowMissing: true, surface: true });
  if (!trusted) return;
  if (!sameFilesystemIdentity(trusted.identity, expected)) throw new Error(`${label} identity drift`);
  await fs.unlink(path); await syncDirectory(dirname(path), `${label} parent`);
}
async function collectSeedRecords(runRoot: string, includeStateOutcome: boolean, requireOutcome = true): Promise<readonly Readonly<{ path: string; digest: string }>[]> {
  const candidates: string[] = ['PLAN.md', 'USER_NOTES.md', 'DECISIONS.md']; if (includeStateOutcome) candidates.push('STATE.md', 'OUTCOME.md');
  const phases = join(runRoot, 'phases');
  const phaseDir = await inspectTrustedPath(phases, 'phases', { allowMissing: true, surface: true, kind: 'directory' });
  if (phaseDir) for (const name of (await fs.readdir(phases)).sort()) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('authority phase path is unsafe');
    candidates.push(`phases/${name}/STEPS.md`);
  }
  const records: { path: string; digest: string }[] = [];
  for (const name of candidates.sort()) {
    const path = join(runRoot, name); if (!within(runRoot, path)) throw new Error('authority path escapes run root');
    const found = await inspectTrustedPath(path, `Seed ${name}`, { allowMissing: true, surface: true, kind: 'file' });
    if (!found) { if (name === 'PLAN.md' || (includeStateOutcome && (name === 'STATE.md' || (name === 'OUTCOME.md' && requireOutcome)))) throw new Error(`required Seed file is absent: ${name}`); continue; }
    if (found.stat.nlink !== 1 || found.stat.size > MAX_RECORD_BYTES) throw new Error(`Seed file is unsafe: ${name}`);
    records.push({ path: name, digest: digestBytes(await readBoundedRecord(path, found.stat)) });
  }
  return Object.freeze(records);
}
async function seedDigest(runRoot: string, includeStateOutcome: boolean, requireOutcome = true): Promise<string> { return digest(await collectSeedRecords(runRoot, includeStateOutcome, requireOutcome)); }

async function verifyResultIdentity(identityValue: unknown): Promise<ResultIdentity> {
  const identity = validateResultIdentity(identityValue);
  if (identity.kind === 'commit') {
    const root = identity.root as string; const oid = identity.oid as string;
    let head: string;
    try {
      head = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const dirty = execFileSync('/usr/bin/git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude)Lunacy/**'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (dirty.length !== 0) throw new Error('product tree is dirty');
    } catch (error) { throw new Error(`RESULT_DRIFT: ${(error as Error).message}`); }
    if (head !== oid) throw new Error('RESULT_DRIFT: commit identity changed');
  } else {
    const base = resolve('.');
    const observed = new Map<string, string>();
    const visit = async (relativeRoot: string): Promise<void> => {
      const path = resolve(base, relativeRoot); if (!within(base, path) || relativeRoot === 'Lunacy' || relativeRoot.startsWith('Lunacy/')) throw new Error('RESULT_DRIFT: manifest root escapes product root');
      const stat = await fs.lstat(path).catch(() => undefined); if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`RESULT_DRIFT: unsafe manifest root ${relativeRoot}`);
      if (stat.isFile()) { if (stat.nlink !== 1) throw new Error(`RESULT_DRIFT: hardlinked product ${relativeRoot}`); observed.set(relativeRoot, digestBytes(await readBoundedRecord(path, stat))); return; }
      for (const name of (await fs.readdir(path)).sort()) { if (!name || name.includes('/') || name.includes('\\')) throw new Error('RESULT_DRIFT: unsafe product path'); await visit(`${relativeRoot}/${name}`); }
    };
    for (const root of identity.roots as readonly string[]) await visit(root);
    const expectedEntries = identity.entries as readonly Record<string, unknown>[];
    if (observed.size !== expectedEntries.length) throw new Error('RESULT_DRIFT: manifest inventory changed');
    for (const entryValue of identity.entries as readonly unknown[]) {
      const entry = entryValue as Record<string, unknown>; const path = resolve(base, entry.path as string);
      if (!within(base, path) || relative(base, path) === 'Lunacy' || relative(base, path).startsWith(`Lunacy${sep}`)) throw new Error('RESULT_DRIFT: manifest path escapes product root');
      const trusted = await inspectTrustedPath(path, `manifest product ${entry.path as string}`, { surface: true, kind: 'file' });
      if (!trusted || trusted.stat.nlink !== 1 || observed.get(entry.path as string) !== entry.digest || digestBytes(await readBoundedRecord(path, trusted.stat)) !== entry.digest) throw new Error(`RESULT_DRIFT: manifest entry changed: ${entry.path as string}`);
    }
  }
  return identity;
}

export async function prepareManualAcceptance(runRootInput: string, acceptancePathInput: string): Promise<ParentAcceptance> {
  const runRoot = resolve(runRootInput); const acceptancePath = resolve(acceptancePathInput);
  if (runRoot !== runRootInput || acceptancePath !== acceptancePathInput || acceptancePath === join(runRoot, FIXED.acceptance)) throw new Error('acceptance paths must be distinct absolute canonical paths');
  const source = await readCanonicalFile<ParentAcceptance>(acceptancePath, 'manual acceptance source', validateParentAcceptance); const witness = validateParentAcceptance(source.value) as Record<string, unknown>;
  if (witness.schema !== 'lunacy-parent-acceptance/v1') throw new Error('manual preparation requires manual parent acceptance');
  const outcome = await inspectTrustedPath(join(runRoot, 'OUTCOME.md'), 'accepted Outcome', { surface: true, kind: 'file' }); const state = await inspectTrustedPath(join(runRoot, 'STATE.md'), 'terminal STATE', { surface: true, kind: 'file' });
  if (!outcome || !state || digestBytes(await readBoundedRecord(join(runRoot, 'OUTCOME.md'), outcome.stat)) !== witness.outcomeDigest || digestBytes(await readBoundedRecord(join(runRoot, 'STATE.md'), state.stat)) !== witness.terminalStateDigest) throw new Error('ACCEPTANCE_INVALID: Outcome or terminal state disagrees');
  if (await seedDigest(runRoot, false) !== witness.authorityDigest) throw new Error('ACCEPTANCE_INVALID: authority changed');
  await verifyResultIdentity(witness.resultIdentity);
  const destination = join(runRoot, FIXED.acceptance); const existing = await inspectTrustedPath(destination, 'parent acceptance', { allowMissing: true, surface: true });
  if (existing) { const current = await readCanonicalFile<ParentAcceptance>(destination, 'parent acceptance', validateParentAcceptance); if (!current.bytes.equals(source.bytes)) throw new Error('FINALIZATION_CONFLICT: acceptance already differs'); return current.value; }
  await writeExclusiveDurable(destination, source.bytes.toString('utf8'), 'parent acceptance');
  return source.value;
}

export async function prepareRunAbandonment(runRootInput: string, authorityPathInput: string): Promise<ParentAbandonment> {
  const runRoot = resolve(runRootInput); const authorityPath = resolve(authorityPathInput);
  if (runRoot !== runRootInput || authorityPath !== authorityPathInput || authorityPath === join(runRoot, FIXED.abandonment)) throw new Error('abandonment paths must be distinct absolute canonical paths');
  const source = await readCanonicalFile<ParentAbandonment>(authorityPath, 'parent abandonment source', validateParentAbandonment); const witness = validateParentAbandonment(source.value) as Record<string, unknown>;
  await assertObservedAbandonmentCustody(runRoot, witness);
  const published = await inspectTrustedPath(join(runRoot, FIXED.abandonReceipt), 'abandon receipt', { allowMissing: true, surface: true });
  if (published) { const receipt = await readCanonicalFile<RunReceipt>(join(runRoot, FIXED.abandonReceipt), 'abandon receipt', validateAbandonReceipt); const retained = ((receipt.value as Record<string, unknown>).abandonment as Record<string, unknown>).witness; if (canonicalString(retained) !== canonicalString(witness)) throw new Error('FINALIZATION_CONFLICT: abandonment receipt authority differs'); return source.value; }
  if (await seedDigest(runRoot, false) !== witness.authorityDigest) throw new Error('ACCEPTANCE_INVALID: abandonment authority changed');
  const state = await inspectTrustedPath(join(runRoot, 'STATE.md'), 'abandoned STATE', { surface: true, kind: 'file' });
  if (!state || digestBytes(await readBoundedRecord(join(runRoot, 'STATE.md'), state.stat)) !== witness.terminalStateDigest) throw new Error('ACCEPTANCE_INVALID: abandoned STATE changed');
  const destination = join(runRoot, FIXED.abandonment); const existing = await inspectTrustedPath(destination, 'parent abandonment', { allowMissing: true, surface: true });
  if (existing) { const current = await readCanonicalFile<ParentAbandonment>(destination, 'parent abandonment', validateParentAbandonment); if (!current.bytes.equals(source.bytes)) throw new Error('FINALIZATION_CONFLICT: abandonment already differs'); return current.value; }
  await writeExclusiveDurable(destination, source.bytes.toString('utf8'), 'parent abandonment');
  return source.value;
}

async function replaceExactCanonical(path: string, expectedDigest: string, value: unknown, label: string): Promise<void> {
  const current = await readCanonicalFile<unknown>(path, label); if (current.digest !== expectedDigest) throw new Error(`${label} changed before replacement`);
  const temporary = `${path}.replace-${process.pid}`; const bytes = canonicalString(value); await writeExclusiveDurable(temporary, bytes, `${label} replacement`);
  const check = await readCanonicalFile<unknown>(path, label); if (check.digest !== expectedDigest || String(check.stat.dev) !== String(current.stat.dev) || String(check.stat.ino) !== String(current.stat.ino)) { await fs.unlink(temporary).catch(() => undefined); throw new Error(`${label} changed before replacement`); }
  await fs.rename(temporary, path); await syncDirectory(dirname(path), `${label} parent`);
}

/**
 * Finish the one intentional acceptance crash window: the candidate was
 * durable and its bound PASS committed, but the candidate-to-witness rename
 * did not.  This never submits a decision.  It reconstructs the final witness
 * only from the exact terminal journal record already committed by the
 * runtime, then replaces the same candidate bytes atomically.
 */
async function materializeCommittedRuntimeCandidate(runRoot: string, candidateRead: Awaited<ReturnType<typeof readCanonicalFile<Record<string, unknown>>>>): Promise<void> {
  const candidate = exact(candidateRead.value, ['schema', 'runId', 'prePass', 'gate', 'activeWorkers', 'authorityDigest', 'outcomeDigest', 'resultIdentity', 'resultIdentityDigest'], 'runtime acceptance candidate');
  if (candidate.schema !== 'lunacy-runtime-acceptance-candidate/v1' || candidate.activeWorkers !== 'NONE') throw new Error('ACCEPTANCE_INVALID: runtime candidate is malformed');
  const runId = text(candidate.runId, 'runtime candidate runId');
  const prePass = exact(candidate.prePass, ['generation', 'revision', 'stateDigest'], 'runtime prePass'); integer(prePass.generation, 'prePass generation'); const revision = integer(prePass.revision, 'prePass revision'); sha(prePass.stateDigest, 'prePass stateDigest');
  const gate = exact(candidate.gate, ['token', 'eventDigest', 'eventIdentityDigest'], 'runtime gate'); text(gate.token, 'gate token'); sha(gate.eventDigest, 'gate eventDigest'); sha(gate.eventIdentityDigest, 'gate eventIdentityDigest');
  sha(candidate.authorityDigest, 'candidate authorityDigest'); sha(candidate.outcomeDigest, 'candidate outcomeDigest'); const identity = validateResultIdentity(candidate.resultIdentity); if (sha(candidate.resultIdentityDigest, 'candidate result identity digest') !== digest(identity)) throw new Error('ACCEPTANCE_INVALID: runtime candidate result differs');
  const loaded = await new FileArtifactStore(runRoot).loadReadOnly(runId); const terminal = loaded.state;
  if (!terminal || terminal.status !== 'COMPLETE' || terminal.gate !== 'PASS' || terminal.barrier !== 'CLOSED' || terminal.revision !== revision + 1 || Object.values(terminal.outbox).some((entry) => ['ACTIVE', 'PENDING', 'CLAIMED', 'UNKNOWN'].includes(entry.state))) throw new Error('AUTHORITY_OPEN: candidate PASS is not closed and terminal');
  const journal = terminal.journal.find((entry) => entry.revision === revision + 1);
  if (!journal || journal.digest !== gate.eventDigest || digest(journal.identity) !== gate.eventIdentityDigest) throw new Error('ACCEPTANCE_INVALID: candidate PASS record differs');
  const witness = validateRuntimeAcceptance({ schema: 'lunacy-runtime-acceptance/v1', runId, candidate, passRecord: { revision: journal.revision, eventDigest: journal.digest, eventIdentityDigest: digest(journal.identity) }, terminal: { generation: loaded.generation, stateDigest: digest(terminal) } });
  await replaceExactCanonical(join(runRoot, FIXED.acceptance), candidateRead.digest, witness, 'runtime acceptance candidate');
}

async function acceptRuntimePassUnderBodyExclusion(input: Readonly<{ runRoot: string; runId: string; token: string; eventId: string; inbox: DecisionInboxEntry; plan: Plan; resultIdentity: unknown }>): Promise<ParentAcceptance> {
  const runRoot = resolve(input.runRoot); if (runRoot !== input.runRoot || !input.runId || !input.token || !input.eventId) throw new Error('runtime acceptance input is invalid');
  const selection: DecisionInboxSelection = Object.freeze({ runRoot, runId: input.runId, token: input.token, planDigest: input.inbox.run.planDigest, ...(input.inbox.run.policyDigest === null ? {} : { policyDigest: input.inbox.run.policyDigest }) });
  if (input.inbox.status !== 'READY' || input.inbox.run.runId !== input.runId || input.inbox.token.value !== input.token || input.inbox.run.runRoot !== runRoot) throw new Error('ACCEPTANCE_INVALID: inbox binding is not ready');
  const loaded = await new FileArtifactStore(runRoot).loadReadOnly(input.runId); const state = loaded.state; if (!state || loaded.generation !== input.inbox.run.generation || state.revision !== input.inbox.run.revision) throw new Error('ACCEPTANCE_INVALID: inbox cursor changed');
  const resultIdentity = await verifyResultIdentity(input.resultIdentity); const authorityDigest = await seedDigest(runRoot, false); const outcome = await inspectTrustedPath(join(runRoot, 'OUTCOME.md'), 'accepted Outcome', { surface: true, kind: 'file' }); if (!outcome) throw new Error('ACCEPTANCE_INVALID: Outcome is absent'); const outcomeDigest = digestBytes(await readBoundedRecord(join(runRoot, 'OUTCOME.md'), outcome.stat));
  const submission = constructParentDecisionSubmission({ selection, inbox: input.inbox, state, value: 'PASS', eventId: input.eventId });
  const candidate = Object.freeze({ schema: 'lunacy-runtime-acceptance-candidate/v1', runId: input.runId, prePass: { generation: loaded.generation, revision: state.revision, stateDigest: digest(state) }, gate: { token: input.token, eventDigest: submission.eventDigest, eventIdentityDigest: submission.eventIdentityDigest }, activeWorkers: 'NONE', authorityDigest, outcomeDigest, resultIdentity, resultIdentityDigest: digest(resultIdentity) });
  validateRuntimeAcceptance({ schema: 'lunacy-runtime-acceptance/v1', runId: input.runId, candidate, passRecord: { revision: state.revision + 1, eventDigest: submission.eventDigest, eventIdentityDigest: submission.eventIdentityDigest }, terminal: { generation: loaded.generation, stateDigest: '0'.repeat(64) } });
  const path = join(runRoot, FIXED.acceptance); let candidateDigest = digest(candidate); const existing = await inspectTrustedPath(path, 'runtime acceptance candidate', { allowMissing: true, surface: true });
  if (!existing) await writeExclusiveDurable(path, canonicalString(candidate), 'runtime acceptance candidate');
  else {
    const current = await readCanonicalFile<Record<string, unknown>>(path, 'runtime acceptance candidate');
    if (current.value.schema === 'lunacy-runtime-acceptance/v1') return validateParentAcceptance(current.value);
    if (current.digest !== candidateDigest || canonicalString(current.value) !== canonicalString(candidate)) throw new Error('FINALIZATION_CONFLICT: runtime acceptance candidate differs');
  }
  const submitted = await submitParentDecision({ selection, inbox: input.inbox, value: 'PASS', eventId: input.eventId, plan: input.plan });
  if (!['committed', 'replayed'].includes(submitted.status) || submitted.revision !== state.revision + 1) throw new Error(`ACCEPTANCE_INVALID: bound PASS did not commit (${submitted.code ?? submitted.status})`);
  const terminalLoaded = await new FileArtifactStore(runRoot).loadReadOnly(input.runId); const terminal = terminalLoaded.state; if (!terminal || terminal.status !== 'COMPLETE' || terminal.gate !== 'PASS' || terminal.barrier !== 'CLOSED' || terminal.revision !== state.revision + 1 || Object.values(terminal.outbox).some((entry) => ['ACTIVE', 'PENDING', 'CLAIMED', 'UNKNOWN'].includes(entry.state))) throw new Error('AUTHORITY_OPEN: PASS successor is not closed and terminal');
  const journal = terminal.journal.find((entry) => entry.revision === state.revision + 1); if (!journal || journal.digest !== submission.eventDigest || digest(journal.identity) !== submission.eventIdentityDigest) throw new Error('ACCEPTANCE_INVALID: committed PASS record differs');
  const witness = validateRuntimeAcceptance({ schema: 'lunacy-runtime-acceptance/v1', runId: input.runId, candidate, passRecord: { revision: journal.revision, eventDigest: journal.digest, eventIdentityDigest: digest(journal.identity) }, terminal: { generation: terminalLoaded.generation, stateDigest: digest(terminal) } });
  await replaceExactCanonical(path, candidateDigest, witness, 'runtime acceptance candidate'); return witness;
}

export async function acceptRuntimePass(input: Readonly<{ runRoot: string; runId: string; token: string; eventId: string; inbox: DecisionInboxEntry; plan: Plan; resultIdentity: unknown }>): Promise<ParentAcceptance> {
  const runRoot = resolve(input.runRoot); if (runRoot !== input.runRoot) throw new Error('runtime acceptance input is invalid');
  // A supported Body writer retains this same claim for its entire child and
  // publication lifetime. Holding it across candidate publication and PASS
  // therefore makes activeWorkers:NONE an observed fact rather than prose.
  return withBodyWriterAdmission(runRoot, undefined, () => acceptRuntimePassUnderBodyExclusion(input));
}

async function acceptancePreflight(runRoot: string): Promise<Readonly<{ witness: ParentAcceptance; acceptance: Awaited<ReturnType<typeof readCanonicalFile<ParentAcceptance>>>; resultIdentity: ResultIdentity; authorityDigest: string; outcomeDigest: string; terminalStateDigest: string; seedDigest: string }>> {
  const acceptancePath = join(runRoot, FIXED.acceptance); const initial = await readCanonicalFile<Record<string, unknown>>(acceptancePath, 'parent acceptance');
  if (initial.value.schema === 'lunacy-runtime-acceptance-candidate/v1') await materializeCommittedRuntimeCandidate(runRoot, initial);
  const acceptance = await readCanonicalFile<ParentAcceptance>(acceptancePath, 'parent acceptance', validateParentAcceptance);
  const witness = validateParentAcceptance(acceptance.value); const item = witness as Record<string, unknown>; const nested = item.schema === 'lunacy-parent-acceptance/v1' ? item : record(item.candidate, 'runtime candidate');
  const terminalStateDigest = item.schema === 'lunacy-parent-acceptance/v1' ? item.terminalStateDigest as string : record(item.terminal, 'runtime terminal').stateDigest as string;
  const authorityDigest = await seedDigest(runRoot, false); if (authorityDigest !== nested.authorityDigest) throw new Error('ACCEPTANCE_INVALID: authority changed');
  const outcome = await inspectTrustedPath(join(runRoot, 'OUTCOME.md'), 'accepted Outcome', { surface: true, kind: 'file' }); const state = await inspectTrustedPath(join(runRoot, 'STATE.md'), 'terminal STATE', { surface: true, kind: 'file' }); if (!outcome || !state) throw new Error('ACCEPTANCE_INVALID: Seed is incomplete');
  const outcomeDigest = digestBytes(await readBoundedRecord(join(runRoot, 'OUTCOME.md'), outcome.stat));
  if (outcomeDigest !== nested.outcomeDigest) throw new Error('ACCEPTANCE_INVALID: accepted Outcome changed');
  if (item.schema === 'lunacy-parent-acceptance/v1') {
    if (digestBytes(await readBoundedRecord(join(runRoot, 'STATE.md'), state.stat)) !== terminalStateDigest) throw new Error('ACCEPTANCE_INVALID: accepted STATE changed');
  } else {
    const terminal = (await new FileArtifactStore(runRoot).loadReadOnly(item.runId as string)).state;
    if (!terminal || terminal.status !== 'COMPLETE' || terminal.gate !== 'PASS' || terminal.barrier !== 'CLOSED' || digest(terminal) !== terminalStateDigest || Object.values(terminal.outbox).some((entry) => ['ACTIVE', 'PENDING', 'CLAIMED', 'UNKNOWN'].includes(entry.state))) throw new Error('AUTHORITY_OPEN: accepted runtime state changed');
  }
  const resultIdentity = await verifyResultIdentity(nested.resultIdentity); const finalSeedDigest = await seedDigest(runRoot, true);
  return Object.freeze({ witness, acceptance, resultIdentity, authorityDigest, outcomeDigest, terminalStateDigest, seedDigest: finalSeedDigest });
}

function asTrusted(path: string, stat: Stats): TrustedIdentity { return Object.freeze({ path, identity: Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) }) }); }
async function captureQuiescence(runRoot: string, bodyPath: string, platform: RetentionPlatform, installedRuntimeInput?: string) {
  const runtime = resolve(installedRuntimeInput ?? '.'); const runtimeStat = await fs.stat(runtime); const runStat = await fs.stat(runRoot); const bodyStat = await fs.stat(bodyPath);
  if (!runtimeStat.isDirectory() || !runStat.isDirectory() || !bodyStat.isDirectory()) throw new Error('QUIESCENCE_UNAVAILABLE: trusted roots unavailable');
  try { return await platform.captureRunSealQuiescence(asTrusted(runtime, runtimeStat), asTrusted(runRoot, runStat), asTrusted(bodyPath, bodyStat)); }
  catch (error) { const message = (error as Error).message; throw new Error(message.includes('WRITER_ACTIVE') ? 'WRITER_ACTIVE' : `QUIESCENCE_UNAVAILABLE: ${message}`); }
}

type AcceptedPreflight = Awaited<ReturnType<typeof acceptancePreflight>>;
type AbandonmentPreflight = Readonly<{ witness: ParentAbandonment; acceptance: Awaited<ReturnType<typeof readCanonicalFile<ParentAbandonment>>>; authorityDigest: string; terminalStateDigest: string; seedDigest: string }>;
type FinalizationPreflight = AcceptedPreflight | AbandonmentPreflight;
type FinalizationVariant = Readonly<{ disposition: RetentionDisposition; receipt: string; stagedReceipt: string; input: string; validator: (value: unknown) => RunReceipt }>;

const ACCEPTED_VARIANT: FinalizationVariant = Object.freeze({ disposition: 'ACCEPTED', receipt: FIXED.receipt, stagedReceipt: FIXED.stagedReceipt, input: FIXED.acceptance, validator: validateRunReceipt });
const ABANDONED_VARIANT: FinalizationVariant = Object.freeze({ disposition: 'ABANDONED', receipt: FIXED.abandonReceipt, stagedReceipt: FIXED.stagedAbandonReceipt, input: FIXED.abandonment, validator: validateAbandonReceipt });

async function assertObservedAbandonmentCustody(runRoot: string, witness: Record<string, unknown>): Promise<void> {
  const custody = record(witness.custody, 'abandonment custody');
  const kernel = await inspectTrustedPath(join(runRoot, '.kernel'), 'runtime Custody', { allowMissing: true, surface: true, kind: 'directory' });
  if (!kernel) return;
  let state;
  try { state = (await new FileArtifactStore(runRoot).loadReadOnly()).state; }
  catch (error) {
    if ((custody.malformed as number) < 1) throw new Error(`AUTHORITY_OPEN: malformed durable Custody is not reflected by abandonment authority: ${(error as Error).message}`);
    return;
  }
  if (!state || state.runId !== witness.runId) throw new Error('AUTHORITY_OPEN: durable Custody run identity disagrees with abandonment authority');
  const active = Object.values(state.steps).filter((step) => step.status === 'ACTIVE').length;
  const pending = Object.values(state.outbox).filter((command) => command.state === 'PENDING').length;
  const claimed = Object.values(state.outbox).filter((command) => command.state === 'CLAIMED').length;
  const unknown = Object.values(state.outbox).filter((command) => command.state === 'UNKNOWN').length;
  if (active || pending || claimed) throw new Error(`AUTHORITY_OPEN: durable Custody remains actionable (ACTIVE=${active}, PENDING=${pending}, CLAIMED=${claimed})`);
  if (pending !== custody.pending || claimed !== custody.claimed || unknown > (custody.unknown as number)) throw new Error('AUTHORITY_OPEN: durable Custody classification disagrees with abandonment authority');
}

async function abandonmentPreflight(runRoot: string): Promise<AbandonmentPreflight> {
  const acceptance = await readCanonicalFile<ParentAbandonment>(join(runRoot, FIXED.abandonment), 'parent abandonment', validateParentAbandonment);
  const witness = validateParentAbandonment(acceptance.value); const item = witness as Record<string, unknown>;
  await assertObservedAbandonmentCustody(runRoot, item);
  const authorityDigest = await seedDigest(runRoot, false); if (authorityDigest !== item.authorityDigest) throw new Error('ACCEPTANCE_INVALID: abandonment authority changed');
  const state = await inspectTrustedPath(join(runRoot, 'STATE.md'), 'abandoned STATE', { surface: true, kind: 'file' }); if (!state) throw new Error('ACCEPTANCE_INVALID: abandoned STATE is absent');
  const terminalStateDigest = digestBytes(await readBoundedRecord(join(runRoot, 'STATE.md'), state.stat)); if (terminalStateDigest !== item.terminalStateDigest) throw new Error('ACCEPTANCE_INVALID: abandoned STATE changed');
  return Object.freeze({ witness, acceptance, authorityDigest, terminalStateDigest, seedDigest: await seedDigest(runRoot, true, false) });
}

function receiptFor(preflight: FinalizationPreflight, inventory: BodyInventory, quiescenceDigest: string): RunReceipt {
  const item = preflight.witness as Record<string, unknown>;
  if (item.schema === 'lunacy-run-abandonment/v1') {
    return validateAbandonReceipt({ schema: 'lunacy-run-abandon-receipt/v1', runId: item.runId, disposition: 'ABANDONED', status: item.status, authorityDigest: preflight.authorityDigest, seedDigest: preflight.seedDigest, terminalStateDigest: preflight.terminalStateDigest, quiescence: { schema: 'lunacy-run-quiescence/v1', digest: quiescenceDigest, openHandles: 0, publicationGate: 'REQUIRED_ZERO_HANDLES' }, reasonCode: item.reasonCode, retainedCustody: item.custody, abandonment: { digest: digest(preflight.witness), witness: preflight.witness }, body: { root: '.work', treeDigest: inventory.treeDigest, files: inventory.files, bytes: inventory.bytes, action: 'PRUNE' } });
  }
  const accepted = preflight as AcceptedPreflight; const kind = item.schema === 'lunacy-parent-acceptance/v1' ? 'manual-parent/v1' : 'runtime-pass/v1';
  return validateRunReceipt({ schema: 'lunacy-run-receipt/v1', runId: item.runId, disposition: 'ACCEPTED', authorityDigest: accepted.authorityDigest, seedDigest: accepted.seedDigest, terminalStateDigest: accepted.terminalStateDigest, quiescence: { schema: 'lunacy-run-quiescence/v1', digest: quiescenceDigest, openHandles: 0, publicationGate: 'REQUIRED_ZERO_HANDLES' }, outcome: { path: 'OUTCOME.md', digest: accepted.outcomeDigest }, acceptance: { kind, digest: digest(accepted.witness), witness: accepted.witness }, resultIdentity: accepted.resultIdentity, body: { root: '.work', treeDigest: inventory.treeDigest, files: inventory.files, bytes: inventory.bytes, action: 'PRUNE' } });
}

function markerFor(receipt: RunReceipt, receiptDigest: string, preflight: FinalizationPreflight, inventory: BodyInventory, staged: Stats, variant: FinalizationVariant): FinalizationMarker {
  const bodyStat = inventory.root.identity; const accepted = variant.disposition === 'ACCEPTED'; const resultIdentityDigest = accepted ? digest((preflight as AcceptedPreflight).resultIdentity) : '0'.repeat(64);
  const marker = { schema: 'lunacy-run-finalization/v1', runId: (receipt as Record<string, unknown>).runId, receiptDigest, disposition: variant.disposition, receiptPath: variant.receipt, acceptanceDigest: digest(preflight.witness), authorityDigest: preflight.authorityDigest, resultIdentityDigest, quiescenceDigest: ((receipt as Record<string, unknown>).quiescence as Record<string, unknown>).digest, acceptanceInput: { path: variant.input, dev: String(preflight.acceptance.stat.dev), ino: String(preflight.acceptance.stat.ino), digest: preflight.acceptance.digest }, stagedReceipt: { path: variant.stagedReceipt, dev: String(staged.dev), ino: String(staged.ino), digest: receiptDigest }, body: { sourcePath: FIXED.body, dev: bodyStat.dev, ino: bodyStat.ino, treeDigest: inventory.treeDigest }, tombstonePath: `.work.prune-${receiptDigest}`, cleanupEntries: inventory.cleanupEntries };
  return validateFinalizationMarker(marker);
}

function variantForMarker(marker: FinalizationMarker): FinalizationVariant { return (marker as Record<string, unknown>).disposition === 'ABANDONED' ? ABANDONED_VARIANT : ACCEPTED_VARIANT; }
async function preflightFor(runRoot: string, variant: FinalizationVariant): Promise<FinalizationPreflight> { return variant.disposition === 'ABANDONED' ? abandonmentPreflight(runRoot) : acceptancePreflight(runRoot); }
function receiptAuthorityDigest(receipt: RunReceipt): string { const item = receipt as Record<string, unknown>; return item.schema === 'lunacy-run-abandon-receipt/v1' ? (item.abandonment as Record<string, unknown>).digest as string : (item.acceptance as Record<string, unknown>).digest as string; }
function sealResult(status: SealRunResult['status'], receipt: { value: RunReceipt; digest: string }): SealRunResult { const value = receipt.value as Record<string, unknown>; const body = value.body as Record<string, unknown>; return Object.freeze({ schema: 'lunacy-run-seal-result/v1', status, runId: value.runId as string, receiptDigest: receipt.digest, body: Object.freeze({ files: body.files as number, bytes: body.bytes as number, treeDigest: body.treeDigest as string }) }); }

async function remainingPaths(root: string): Promise<readonly string[]> {
  const result: string[] = ['.']; const visit = async (directory: string, prefix: string) => { for (const name of (await fs.readdir(directory)).sort()) { if (!name || name.includes('/') || name.includes('\\')) throw new Error('BODY_DRIFT: unsafe remaining path'); const rel = prefix ? `${prefix}/${name}` : name; result.push(rel); const stat = await fs.lstat(join(directory, name)); if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(join(directory, name), rel); } }; await visit(root, ''); return result.sort();
}
async function verifyMarkerBody(runRoot: string, marker: FinalizationMarker, tombstoneExpected: boolean): Promise<string> {
  const item = marker as Record<string, unknown>; const body = item.body as Record<string, unknown>; const tombstone = item.tombstonePath as string; const root = join(runRoot, tombstoneExpected ? tombstone : FIXED.body);
  const trusted = await inspectTrustedPath(root, 'finalization Body', { surface: true, kind: 'directory' }); if (!trusted || trusted.identity.dev !== body.dev || trusted.identity.ino !== body.ino) throw new Error('BODY_DRIFT: Body identity changed');
  const cleanup = item.cleanupEntries as readonly BodyCleanupEntry[]; const expected = new Map(cleanup.map((entry) => [entry.relativePath, entry]));
  for (const relativePath of await remainingPaths(root)) if (!expected.has(relativePath)) throw new Error(`BODY_DRIFT: unexpected entry ${relativePath}`);
  for (const entry of cleanup) {
    const path = entry.relativePath === '.' ? root : join(root, entry.relativePath); const found = await inspectTrustedPath(path, `cleanup entry ${entry.relativePath}`, { allowMissing: true, surface: true }); if (!found) continue;
    if (found.identity.dev !== entry.dev || found.identity.ino !== entry.ino || (found.stat.mode & 0o777) !== entry.mode) throw new Error(`BODY_DRIFT: changed entry ${entry.relativePath}`);
    if (entry.digest !== undefined) { if (!found.stat.isFile() || found.stat.nlink !== 1 || found.stat.size !== entry.size || digestBytes(await readBoundedRecord(path, found.stat)) !== entry.digest) throw new Error(`BODY_DRIFT: changed file ${entry.relativePath}`); }
    else if (!found.stat.isDirectory()) throw new Error(`BODY_DRIFT: changed directory ${entry.relativePath}`);
  }
  return root;
}

async function removeReceiptBoundInput(runRoot: string, marker: FinalizationMarker, receipt: RunReceipt): Promise<void> {
  const item = marker as Record<string, unknown>; const bound = item.acceptanceInput as Record<string, unknown>;
  if (bound.digest !== receiptAuthorityDigest(receipt)) throw new Error('FINALIZATION_CONFLICT: authority input digest disagrees');
  const path = join(runRoot, bound.path as string); const found = await inspectTrustedPath(path, 'receipt-bound authority input', { allowMissing: true, surface: true, kind: 'file' }); if (!found) return;
  if (found.identity.dev !== bound.dev || found.identity.ino !== bound.ino || digestBytes(await readBoundedRecord(path, found.stat)) !== bound.digest) throw new Error('FINALIZATION_CONFLICT: authority input drift');
  await fs.unlink(path); await syncDirectory(runRoot, 'run root');
}

async function cleanupPublished(runRoot: string, marker: FinalizationMarker, receipt: RunReceipt, fault?: SealRunOptions['fault']): Promise<void> {
  const item = marker as Record<string, unknown>; const root = join(runRoot, item.tombstonePath as string); const foundRoot = await inspectTrustedPath(root, 'finalization tombstone', { allowMissing: true, surface: true, kind: 'directory' });
  if (foundRoot) {
    await verifyMarkerBody(runRoot, marker, true);
    const entries = [...item.cleanupEntries as readonly BodyCleanupEntry[]].filter((entry) => entry.relativePath !== '.').sort((a, b) => b.relativePath.split('/').length - a.relativePath.split('/').length || (a.digest === undefined ? 1 : -1) || Buffer.compare(Buffer.from(b.relativePath), Buffer.from(a.relativePath)));
    for (const entry of entries) {
      const path = join(root, entry.relativePath); const found = await inspectTrustedPath(path, `cleanup entry ${entry.relativePath}`, { allowMissing: true, surface: true }); if (!found) continue;
      if (found.identity.dev !== entry.dev || found.identity.ino !== entry.ino) throw new Error(`BODY_DRIFT: cleanup identity changed ${entry.relativePath}`);
      if (entry.digest !== undefined) await fs.unlink(path); else await fs.rmdir(path);
      await syncDirectory(dirname(path), 'cleanup parent'); await fault?.('CLEANUP_ENTRY', entry.relativePath);
    }
    const currentRoot = await inspectTrustedPath(root, 'finalization tombstone', { allowMissing: true, surface: true, kind: 'directory' });
    if (currentRoot) { const body = item.body as Record<string, unknown>; if (currentRoot.identity.dev !== body.dev || currentRoot.identity.ino !== body.ino) throw new Error('BODY_DRIFT: tombstone identity changed'); await fs.rmdir(root); await syncDirectory(runRoot, 'run root'); }
    await fault?.('TOMBSTONE_REMOVED');
  }
  await removeReceiptBoundInput(runRoot, marker, receipt); await fault?.('ACCEPTANCE_REMOVED');
  const markerPath = join(runRoot, FIXED.marker); const currentMarker = await readCanonicalFile<FinalizationMarker>(markerPath, 'finalization marker', validateFinalizationMarker); if (digest(currentMarker.value) !== digest(marker)) throw new Error('FINALIZATION_CONFLICT: marker changed');
  await fs.unlink(markerPath); await syncDirectory(runRoot, 'run root'); await fault?.('MARKER_REMOVED');
}

async function sealUnderExclusion(runRoot: string, options: SealRunOptions): Promise<SealRunResult> {
  const platform = options.platform ?? nativeRetentionPlatform; const markerPath = join(runRoot, FIXED.marker);
  const acceptedReceiptFound = await inspectTrustedPath(join(runRoot, FIXED.receipt), 'run receipt', { allowMissing: true, surface: true }); const abandonedReceiptFound = await inspectTrustedPath(join(runRoot, FIXED.abandonReceipt), 'abandon receipt', { allowMissing: true, surface: true });
  const acceptedStagedFound = await inspectTrustedPath(join(runRoot, FIXED.stagedReceipt), 'staged receipt', { allowMissing: true, surface: true }); const abandonedStagedFound = await inspectTrustedPath(join(runRoot, FIXED.stagedAbandonReceipt), 'staged abandon receipt', { allowMissing: true, surface: true });
  const markerFound = await inspectTrustedPath(markerPath, 'finalization marker', { allowMissing: true, surface: true }); const bodyFound = await inspectTrustedPath(join(runRoot, FIXED.body), 'run Body', { allowMissing: true, surface: true });
  if ((acceptedReceiptFound && abandonedReceiptFound) || (acceptedStagedFound && abandonedStagedFound)) throw new Error('FINALIZATION_CONFLICT: accepted and abandoned state collide');
  if ((acceptedReceiptFound || abandonedReceiptFound) && !markerFound) {
    if (bodyFound || acceptedStagedFound || abandonedStagedFound) throw new Error('FINALIZATION_CONFLICT: sealed receipt collides with Body or staged state');
    const variant = abandonedReceiptFound ? ABANDONED_VARIANT : ACCEPTED_VARIANT; const receipt = await readCanonicalFile<RunReceipt>(join(runRoot, variant.receipt), variant.disposition === 'ABANDONED' ? 'abandon receipt' : 'run receipt', variant.validator);
    return sealResult('ALREADY_SEALED', receipt);
  }
  let markerRead = markerFound ? await readCanonicalFile<FinalizationMarker>(markerPath, 'finalization marker', validateFinalizationMarker) : undefined;
  let variant = markerRead ? variantForMarker(markerRead.value) : options.mode === 'abandon' ? ABANDONED_VARIANT : ACCEPTED_VARIANT;
  if (markerRead && ((options.mode === 'accept' && variant.disposition !== 'ACCEPTED') || (options.mode === 'abandon' && variant.disposition !== 'ABANDONED'))) throw new Error('FINALIZATION_CONFLICT: requested disposition differs from marker');
  const foreignReceipt = variant.disposition === 'ACCEPTED' ? abandonedReceiptFound : acceptedReceiptFound; const foreignStaged = variant.disposition === 'ACCEPTED' ? abandonedStagedFound : acceptedStagedFound; const foreignInput = await inspectTrustedPath(join(runRoot, variant.disposition === 'ACCEPTED' ? FIXED.abandonment : FIXED.acceptance), 'foreign finalization authority', { allowMissing: true, surface: true });
  if (foreignReceipt || foreignStaged || foreignInput) throw new Error('FINALIZATION_CONFLICT: accepted and abandoned authority collide');
  let stagedFound = variant.disposition === 'ACCEPTED' ? acceptedStagedFound : abandonedStagedFound;
  if (!markerRead && stagedFound) {
    if (!bodyFound || acceptedReceiptFound || abandonedReceiptFound) throw new Error('FINALIZATION_CONFLICT: orphan staged receipt state is ambiguous');
    const staged = await readCanonicalFile<RunReceipt>(join(runRoot, variant.stagedReceipt), 'staged receipt', variant.validator); await unlinkIdentity(join(runRoot, variant.stagedReceipt), { dev: String(staged.stat.dev), ino: String(staged.stat.ino) }, 'orphan staged receipt'); stagedFound = undefined;
  }
  if (!markerRead) {
    if (options.mode === 'resume') throw new Error('FINALIZATION_CONFLICT: nothing resumable');
    const preflight = await preflightFor(runRoot, variant); const inventory = await inventoryRetentionBody(join(runRoot, FIXED.body), platform); const initial = await captureQuiescence(runRoot, join(runRoot, FIXED.body), platform, options.installedRuntime);
    const receipt = receiptFor(preflight, inventory, initial.digest); const receiptBytes = canonicalString(receipt); const receiptDigest = digestBytes(Buffer.from(receiptBytes)); const stagedStat = await writeExclusiveDurable(join(runRoot, variant.stagedReceipt), receiptBytes, 'staged receipt'); await options.fault?.('STAGED_RECEIPT_FSYNC');
    const marker = markerFor(receipt, receiptDigest, preflight, inventory, stagedStat, variant); await writeExclusiveDurable(markerPath, canonicalString(marker), 'finalization marker'); await options.fault?.('MARKER_FSYNC'); markerRead = await readCanonicalFile<FinalizationMarker>(markerPath, 'finalization marker', validateFinalizationMarker);
  }
  const marker = markerRead.value; variant = variantForMarker(marker); const markerItem = marker as Record<string, unknown>; const tombstonePath = join(runRoot, markerItem.tombstonePath as string); let tombstoneFound = await inspectTrustedPath(tombstonePath, 'finalization tombstone', { allowMissing: true, surface: true }); const currentBody = await inspectTrustedPath(join(runRoot, FIXED.body), 'run Body', { allowMissing: true, surface: true }); const currentReceipt = await inspectTrustedPath(join(runRoot, variant.receipt), 'published receipt', { allowMissing: true, surface: true }); const currentStaged = await inspectTrustedPath(join(runRoot, variant.stagedReceipt), 'staged receipt', { allowMissing: true, surface: true });
  if (currentReceipt) {
    if (currentBody || currentStaged) throw new Error('FINALIZATION_CONFLICT: published state collides');
    const receipt = await readCanonicalFile<RunReceipt>(join(runRoot, variant.receipt), 'published receipt', variant.validator); if (receipt.digest !== markerItem.receiptDigest) throw new Error('FINALIZATION_CONFLICT: receipt differs from marker'); if (variant.disposition === 'ABANDONED') await assertObservedAbandonmentCustody(runRoot, record(record(receipt.value, 'abandon receipt').abandonment, 'receipt abandonment').witness as Record<string, unknown>); await cleanupPublished(runRoot, marker, receipt.value, options.fault); return sealResult('RESUMED', receipt);
  }
  const staged = await readCanonicalFile<RunReceipt>(join(runRoot, variant.stagedReceipt), 'staged receipt', variant.validator); if (staged.digest !== markerItem.receiptDigest) throw new Error('FINALIZATION_CONFLICT: staged receipt differs from marker');
  if (variant.disposition === 'ABANDONED' && currentBody && !tombstoneFound) await abandonmentPreflight(runRoot);
  if (currentBody && !tombstoneFound) {
    await verifyMarkerBody(runRoot, marker, false); await fs.rename(join(runRoot, FIXED.body), tombstonePath); await options.fault?.('BODY_RENAME'); await syncDirectory(runRoot, 'run root'); await options.fault?.('BODY_RENAME_FSYNC'); tombstoneFound = await inspectTrustedPath(tombstonePath, 'finalization tombstone', { surface: true, kind: 'directory' });
  }
  if (!tombstoneFound || await inspectTrustedPath(join(runRoot, FIXED.body), 'run Body', { allowMissing: true, surface: true })) throw new Error('FINALIZATION_CONFLICT: Body/tombstone state is ambiguous');
  await verifyMarkerBody(runRoot, marker, true); const preflight = await preflightFor(runRoot, variant); const resultIdentityDigest = variant.disposition === 'ACCEPTED' ? digest((preflight as AcceptedPreflight).resultIdentity) : '0'.repeat(64); if (digest(preflight.witness) !== markerItem.acceptanceDigest || preflight.authorityDigest !== markerItem.authorityDigest || resultIdentityDigest !== markerItem.resultIdentityDigest) throw new Error('RESULT_DRIFT: frozen Seed/result changed'); await options.fault?.('FROZEN_REVALIDATED');
  await captureQuiescence(runRoot, tombstonePath, platform, options.installedRuntime); await options.fault?.('BEFORE_RECEIPT_RENAME'); await fs.rename(join(runRoot, variant.stagedReceipt), join(runRoot, variant.receipt)); await options.fault?.('RECEIPT_RENAME'); await syncDirectory(runRoot, 'run root'); await options.fault?.('RECEIPT_RENAME_FSYNC');
  const receipt = await readCanonicalFile<RunReceipt>(join(runRoot, variant.receipt), 'published receipt', variant.validator); await cleanupPublished(runRoot, marker, receipt.value, options.fault);
  return sealResult(options.mode === 'resume' ? 'RESUMED' : 'SEALED', receipt);
}

export async function sealRetentionRun(runRootInput: string, options: SealRunOptions): Promise<SealRunResult> {
  const runRoot = resolve(runRootInput); if (runRoot !== runRootInput || !['dry-run', 'accept', 'abandon', 'resume'].includes(options.mode)) throw new Error('seal-run input is invalid');
  if (options.mode === 'dry-run') {
    const receiptFound = await inspectTrustedPath(join(runRoot, FIXED.receipt), 'run receipt', { allowMissing: true, surface: true }); if (receiptFound) { const receipt = await readCanonicalFile<RunReceipt>(join(runRoot, FIXED.receipt), 'run receipt', validateRunReceipt); return sealResult('ALREADY_SEALED', receipt); }
    if (await inspectTrustedPath(join(runRoot, FIXED.abandonReceipt), 'abandon receipt', { allowMissing: true, surface: true })) throw new Error('FINALIZATION_CONFLICT: abandoned run cannot be accepted');
    const preflight = await acceptancePreflight(runRoot); const inventory = await inventoryRetentionBody(join(runRoot, FIXED.body), options.platform ?? nativeRetentionPlatform); const receipt = receiptFor(preflight, inventory, '0'.repeat(64)); return Object.freeze({ schema: 'lunacy-run-seal-result/v1', status: 'READY', runId: (receipt as Record<string, unknown>).runId as string, receiptDigest: digest(receipt), body: Object.freeze({ files: inventory.files, bytes: inventory.bytes, treeDigest: inventory.treeDigest }) });
  }
  if (options.mode === 'accept' || options.mode === 'abandon') {
    const marker = await inspectTrustedPath(join(runRoot, FIXED.marker), 'finalization marker', { allowMissing: true, surface: true }); const receipt = await inspectTrustedPath(join(runRoot, options.mode === 'abandon' ? FIXED.abandonReceipt : FIXED.receipt), 'run receipt', { allowMissing: true, surface: true });
    if (!marker && !receipt) { await preflightFor(runRoot, options.mode === 'abandon' ? ABANDONED_VARIANT : ACCEPTED_VARIANT); await inventoryRetentionBody(join(runRoot, FIXED.body), options.platform ?? nativeRetentionPlatform); }
  }
  return withRunFinalizationExclusion(runRoot, options.signal, () => sealUnderExclusion(runRoot, options));
}
