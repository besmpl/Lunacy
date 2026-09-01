import { execFileSync } from 'node:child_process';
import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalString, digestBytes, parseCanonical } from './canonical.js';
import { inspectTrustedPath, sameFilesystemIdentity, syncDirectory } from './filesystem.js';
import { withRunFinalizationExclusion } from './release-admission.js';
import { inventoryRetentionBody, nativeRetentionPlatform, type BodyInventory, type RetentionPlatform } from './run-retention-platform.js';
import { validateRunReceipt, type RunReceipt } from './run-retention.js';

const MARKER = '.lunacy-body-migration.json';
const MARKER_STAGE_PREFIX = `${MARKER}.stage-`;
const TEMP = '.work.migrate-tmp';
const BODY = '.work';
const RECEIPT = 'RUN-RECEIPT.json';
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_BYTES = 64 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SEED_ROOT_FILES = new Set(['PLAN.md', 'STATE.md', 'USER_NOTES.md', 'DECISIONS.md', 'OUTCOME.md', 'intake.md', RECEIPT, 'ABANDON-RECEIPT.json']);

export type MigrationEntry = Readonly<{ relativePath: string; dev: string; ino: string; mode: number; size: number; digest: string }>;
export type BodyMigrationMarker = Readonly<{
  schema: 'lunacy-body-migration/v1';
  runId: string;
  sourceRoot: Readonly<{ dev: string; ino: string }>;
  entries: readonly MigrationEntry[];
  body: Readonly<{ dev: string; ino: string; treeDigest: string; files: number; bytes: number }>;
  phase: 'BODY_PUBLISHED';
}>;
export type MigrationRecoveryCode =
  | 'ELIGIBLE_LEGACY' | 'TEMP_ONLY' | 'BODY_WITHOUT_MARKER' | 'BODY_PUBLISHED'
  | 'DEFER_TO_FINALIZER' | 'RECEIPT_CLEANUP' | 'COMPLETED'
  | 'REFUSE_COLLISION' | 'REFUSE_CHANGED_SOURCE' | 'REFUSE_UNKNOWN_ABSENCE' | 'REFUSE_INELIGIBLE';
export type MigrationRefusal =
  | 'RUN_ROOT_UNSAFE' | 'NOT_GIT_BACKED' | 'NOT_COMPLETE' | 'BARRIER_OPEN'
  | 'NO_ALLOWLISTED_BODY' | 'NON_MARKDOWN_BODY' | 'UNTRACKED_SOURCE'
  | 'SOURCE_DIRTY' | 'AMBIGUOUS_PATH' | 'CUSTODY_PRESENT' | 'REFERENCE_UNSCANNABLE'
  | 'REFERENCE_UNRESOLVED' | 'RESULT_IDENTITY_INELIGIBLE' | 'RESULT_MANIFEST_INCOMPLETE'
  | 'FINALIZER_ACTIVE' | 'STATE_COLLISION' | 'SOURCE_DRIFT' | 'UNKNOWN_SOURCE_ABSENCE'
  | 'LIMIT_EXCEEDED';
export type MigrationFaultPoint =
  | 'TEMP_REMOVED' | 'COPY_FILE' | 'COPY_FILE_FSYNC' | 'COPY_DIRECTORY_FSYNC'
  | 'BODY_RENAME' | 'BODY_RENAME_FSYNC' | 'MARKER_STAGE_RECOVERED' | 'MARKER_STAGE_PARTIAL'
  | 'MARKER_STAGE_WRITE' | 'MARKER_STAGE_FSYNC' | 'MARKER_PUBLISH' | 'MARKER_PARENT_FSYNC'
  | 'MARKER_STAGE_UNLINK' | 'MARKER_STAGE_PARENT_FSYNC'
  | 'SOURCE_UNLINK' | 'SOURCE_PARENT_FSYNC' | 'EMPTY_DIRECTORY_REMOVED' | 'MARKER_REMOVED';

export type MigrationAudit = Readonly<{
  schema: 'lunacy-run-artifact-audit/v1';
  runId: string;
  status: string;
  gateBarrier: string;
  eligible: boolean;
  recovery: Readonly<{ code: MigrationRecoveryCode; action: string }>;
  source: Readonly<{ files: number; bytes: number; entries: readonly MigrationEntry[] }>;
  references: Readonly<{ unresolved: readonly string[]; baseline: readonly string[]; unscannable: readonly string[] }>;
  custody: Readonly<{ paths: readonly string[]; runtimeBoundPaths: readonly string[] }>;
  artifacts: Readonly<{ evidence: Readonly<{ files: number; bytes: number }>; reports: Readonly<{ files: number; bytes: number }>; gates: Readonly<{ files: number; bytes: number }> }>;
  refusals: readonly MigrationRefusal[];
}>;

export type MigrationOptions = Readonly<{
  signal?: AbortSignal;
  platform?: RetentionPlatform;
  fault?: (point: MigrationFaultPoint, detail?: string) => void | Promise<void>;
}>;

function stableCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function markerStageName(name: string): boolean { return /^\.lunacy-body-migration\.json\.stage-[0-9a-f]{64}$/.test(name); }
function within(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  const item = value as Record<string, unknown>; const actual = Object.keys(item).sort(stableCompare); const expected = [...keys].sort(stableCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} is not closed`);
  return item;
}
function safeText(value: unknown, label: string): string { if (typeof value !== 'string' || !value || value.includes('\0')) throw new TypeError(`${label} is invalid`); return value; }
function safeInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} is invalid`); return value as number; }
function safeDigest(value: unknown, label: string): string { const result = safeText(value, label); if (!SHA256.test(result)) throw new TypeError(`${label} is invalid`); return result; }
function safeRelative(value: unknown, label: string): string {
  const path = safeText(value, label); if (isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new TypeError(`${label} is invalid`); return path;
}

export function validateBodyMigrationMarker(value: unknown): BodyMigrationMarker {
  const item = exactObject(value, ['schema', 'runId', 'sourceRoot', 'entries', 'body', 'phase'], 'migration marker');
  if (item.schema !== 'lunacy-body-migration/v1' || item.phase !== 'BODY_PUBLISHED') throw new TypeError('migration marker is invalid');
  safeText(item.runId, 'migration runId');
  const root = exactObject(item.sourceRoot, ['dev', 'ino'], 'migration source root'); safeText(root.dev, 'source root dev'); safeText(root.ino, 'source root ino');
  if (!Array.isArray(item.entries) || item.entries.length < 1 || item.entries.length > MAX_ENTRIES) throw new TypeError('migration entries are invalid');
  let previous = ''; let bytes = 0;
  for (const [index, valueEntry] of item.entries.entries()) {
    const entry = exactObject(valueEntry, ['relativePath', 'dev', 'ino', 'mode', 'size', 'digest'], `migration entry ${index}`);
    const path = safeRelative(entry.relativePath, `migration entry ${index} path`); if (index > 0 && stableCompare(previous, path) >= 0) throw new TypeError('migration entries are not strictly sorted'); previous = path;
    safeText(entry.dev, 'migration entry dev'); safeText(entry.ino, 'migration entry ino'); const mode = safeInteger(entry.mode, 'migration entry mode'); if (mode > 0o7777) throw new TypeError('migration entry mode is invalid');
    bytes += safeInteger(entry.size, 'migration entry size'); if (bytes > MAX_BYTES) throw new TypeError('migration entries exceed byte limit'); safeDigest(entry.digest, 'migration entry digest');
  }
  const body = exactObject(item.body, ['dev', 'ino', 'treeDigest', 'files', 'bytes'], 'migration Body'); safeText(body.dev, 'Body dev'); safeText(body.ino, 'Body ino'); safeDigest(body.treeDigest, 'Body treeDigest');
  if (safeInteger(body.files, 'Body files') !== item.entries.length || safeInteger(body.bytes, 'Body bytes') !== bytes) throw new TypeError('migration Body counts disagree');
  return Object.freeze(parseCanonical<BodyMigrationMarker>(canonicalString(item)));
}

async function boundedRead(path: string, stat: Stats, label: string, limit = MAX_RECORD_BYTES): Promise<Buffer> {
  return boundedReadWithLinks(path, stat, label, limit, 1);
}
async function boundedReadWithLinks(path: string, stat: Stats, label: string, limit: number, links: number): Promise<Buffer> {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== links || stat.size < 0 || stat.size > limit) throw new Error(`${label} is unsafe`);
  const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { const bound = await handle.stat(); if (bound.dev !== stat.dev || bound.ino !== stat.ino || bound.size !== stat.size || bound.nlink !== links) throw new Error(`${label} changed before read`); const bytes = await handle.readFile(); const after = await handle.stat(); if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.nlink !== links || bytes.length !== stat.size) throw new Error(`${label} changed during read`); return Buffer.from(bytes); }
  finally { await handle.close(); }
}

function allowlistedBodyFile(path: string): boolean {
  const parts = path.split('/'); if (parts.length < 3 || parts[0] !== 'phases' || !parts[1]) return false;
  if (parts.length === 3 && (/^gate-pack-[0-9]+\.md$/.test(parts[2]!) || /^hard-gate-[0-9]+\.md$/.test(parts[2]!))) return true;
  return parts.length >= 4 && (parts[2] === 'evidence' || parts[2] === 'decision-briefs');
}
function knownRunPath(path: string): boolean {
  const parts = path.split('/');
  if (parts.length === 1) return SEED_ROOT_FILES.has(path) || markerStageName(path) || [MARKER, TEMP, BODY, '.kernel', '.codex-effects', '.lunacy-run-finalization.json', '.RUN-RECEIPT.json.tmp', '.ABANDON-RECEIPT.json.tmp', '.lunacy-parent-acceptance.json', '.lunacy-parent-abandonment.json', '.lunacy-release-exclusion.lock', '.lunacy-body-writer.lock'].includes(path) || path.startsWith('.work.prune-');
  if (parts[0] !== 'phases' || !parts[1]) return false;
  return parts.length === 3 && parts[2] === 'STEPS.md' || parts[2] === 'reports' || allowlistedBodyFile(path);
}

type SourceInventory = Readonly<{ root: Readonly<{ dev: string; ino: string }>; entries: readonly MigrationEntry[]; files: number; bytes: number }>;
async function inventoryLegacySources(runRoot: string): Promise<Readonly<{ inventory: SourceInventory; ambiguous: readonly string[]; custody: readonly string[]; runtimeBound: readonly string[]; counts: MigrationAudit['artifacts'] }>> {
  const trustedRoot = await inspectTrustedPath(runRoot, 'migration run root', { surface: true, kind: 'directory' }); if (!trustedRoot) throw new Error('RUN_ROOT_UNSAFE');
  const entries: MigrationEntry[] = []; const ambiguous: string[] = []; const custody: string[] = []; const runtimeBound: string[] = [];
  const groups = { evidence: { files: 0, bytes: 0 }, reports: { files: 0, bytes: 0 }, gates: { files: 0, bytes: 0 } };
  let seen = 0; let total = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const names = await fs.readdir(directory, { encoding: 'buffer' }); const decoded = names.map((bytes) => { const value = bytes.toString('utf8'); if (!value || !Buffer.from(value).equals(bytes) || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) throw new Error('AMBIGUOUS_PATH'); return value; }).sort(stableCompare);
    if (new Set(decoded).size !== decoded.length) throw new Error('AMBIGUOUS_PATH');
    for (const name of decoded) {
      const relativePath = prefix ? `${prefix}/${name}` : name; if (++seen > MAX_ENTRIES) throw new Error('LIMIT_EXCEEDED'); const path = join(directory, name); const stat = await fs.lstat(path);
      if (String(stat.dev) !== String(trustedRoot.stat.dev) || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) { ambiguous.push(relativePath); continue; }
      if (stat.isDirectory()) {
        if (relativePath === '.kernel' || relativePath === '.codex-effects') { custody.push(relativePath); continue; }
        if (relativePath === BODY || relativePath === TEMP || relativePath.startsWith('.work.prune-')) continue;
        await visit(path, relativePath); continue;
      }
      if (!prefix && (relativePath === MARKER || markerStageName(relativePath))) continue;
      if (stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_BYTES - total) throw new Error(stat.nlink !== 1 ? 'AMBIGUOUS_PATH' : 'LIMIT_EXCEEDED'); total += stat.size;
      if (/^phases\/[^/]+\/reports\//.test(relativePath)) { runtimeBound.push(relativePath); groups.reports.files += 1; groups.reports.bytes += stat.size; continue; }
      if (allowlistedBodyFile(relativePath)) {
        const bytes = await boundedRead(path, stat, `legacy source ${relativePath}`, MAX_BYTES); entries.push(Object.freeze({ relativePath, dev: String(stat.dev), ino: String(stat.ino), mode: stat.mode & 0o777, size: stat.size, digest: digestBytes(bytes) }));
        const group = relativePath.includes('/evidence/') ? groups.evidence : groups.gates; group.files += 1; group.bytes += stat.size; continue;
      }
      if (!knownRunPath(relativePath)) ambiguous.push(relativePath);
    }
  };
  await visit(runRoot, ''); entries.sort((a, b) => stableCompare(a.relativePath, b.relativePath)); ambiguous.sort(stableCompare); custody.sort(stableCompare); runtimeBound.sort(stableCompare);
  return Object.freeze({ inventory: Object.freeze({ root: Object.freeze({ dev: String(trustedRoot.stat.dev), ino: String(trustedRoot.stat.ino) }), entries: Object.freeze(entries), files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) }), ambiguous: Object.freeze(ambiguous), custody: Object.freeze(custody), runtimeBound: Object.freeze(runtimeBound), counts: Object.freeze({ evidence: Object.freeze(groups.evidence), reports: Object.freeze(groups.reports), gates: Object.freeze(groups.gates) }) });
}

function git(root: string, args: readonly string[], encoding: BufferEncoding = 'utf8'): string { return execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) as string; }
function repositoryFor(runRoot: string): Readonly<{ root: string; runRelative: string }> {
  const root = resolve(git(runRoot, ['rev-parse', '--show-toplevel']).trim()); const runRelative = relative(root, runRoot).split(sep).join('/'); if (!runRelative || runRelative.startsWith('../') || !runRelative.startsWith('Lunacy/runs/')) throw new Error('NOT_GIT_BACKED'); return Object.freeze({ root, runRelative });
}
function trackedCandidates(repoRoot: string): Readonly<{ paths: readonly string[]; invalid: boolean }> {
  const output = execFileSync('/usr/bin/git', ['-C', repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const parts = output.subarray(0, Math.max(0, output.length - (output.at(-1) === 0 ? 1 : 0))).toString('binary').split('\0').filter(Boolean).map((value) => Buffer.from(value, 'binary'));
  const invalid = parts.some((bytes) => !Buffer.from(bytes.toString('utf8')).equals(bytes));
  return Object.freeze({ paths: Object.freeze(parts.filter((bytes) => Buffer.from(bytes.toString('utf8')).equals(bytes)).map((bytes) => bytes.toString('utf8')).sort(stableCompare)), invalid });
}
function referenceTokens(repo: Readonly<{ root: string; runRelative: string }>, entries: readonly MigrationEntry[]): readonly string[] {
  const runId = basename(repo.runRelative); return Object.freeze([...new Set([repo.runRelative, ...entries.flatMap((entry) => [entry.relativePath, `${runId}/${entry.relativePath}`, `${repo.runRelative}/${entry.relativePath}`])])].sort((a, b) => b.length - a.length));
}
async function scanCurrentReferences(repo: Readonly<{ root: string; runRelative: string }>, tokens: readonly string[]): Promise<Readonly<{ paths: readonly string[]; unscannable: readonly string[] }>> {
  const paths: string[] = []; const initial = trackedCandidates(repo.root); const unscannable: string[] = initial.invalid ? ['<CURRENT_NON_UTF8_PATH>'] : [];
  const needles = tokens.map((token) => Buffer.from(token));
  for (const candidate of initial.paths) {
    if (candidate === repo.runRelative || candidate.startsWith(`${repo.runRelative}/`)) continue;
    const path = join(repo.root, candidate); const stat = await fs.lstat(path).catch(() => undefined); if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 0 || stat.size > MAX_RECORD_BYTES) { unscannable.push(candidate); continue; }
    let bytes: Buffer; try { bytes = await boundedRead(path, stat, `reference candidate ${candidate}`); } catch { unscannable.push(candidate); continue; }
    if (needles.some((needle) => bytes.includes(needle))) paths.push(candidate);
  }
  const final = trackedCandidates(repo.root); if (initial.invalid !== final.invalid || canonicalString(initial.paths) !== canonicalString(final.paths)) unscannable.push('<CURRENT_INVENTORY_CHANGED>');
  return Object.freeze({ paths: Object.freeze(paths.sort(stableCompare)), unscannable: Object.freeze(unscannable.sort(stableCompare)) });
}
function scanBaselineReferences(repo: Readonly<{ root: string; runRelative: string }>, tokens: readonly string[]): Readonly<{ paths: readonly string[]; unscannable: readonly string[] }> {
  const paths: string[] = []; const unscannable: string[] = []; const needles = tokens.map((token) => Buffer.from(token)); const head = git(repo.root, ['rev-parse', '--verify', 'HEAD']).trim();
  const output = execFileSync('/usr/bin/git', ['-C', repo.root, 'ls-tree', '-rz', '-l', head], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const record of output.subarray(0, Math.max(0, output.length - (output.at(-1) === 0 ? 1 : 0))).toString('binary').split('\0').filter(Boolean).map((value) => Buffer.from(value, 'binary'))) {
    const tab = record.indexOf(9); const metadata = tab < 0 ? '' : record.subarray(0, tab).toString('ascii'); const pathBytes = tab < 0 ? Buffer.alloc(0) : record.subarray(tab + 1); const candidate = pathBytes.toString('utf8');
    if (tab < 0 || !candidate || !Buffer.from(candidate).equals(pathBytes)) { unscannable.push('<HEAD_NON_UTF8_OR_MALFORMED_PATH>'); continue; }
    if (candidate === repo.runRelative || candidate.startsWith(`${repo.runRelative}/`)) continue;
    const match = metadata.match(/^([0-9]{6}) ([a-z]+) ([0-9a-f]{40,64})\s+([0-9]+|-)$/); if (!match || !['100644', '100755'].includes(match[1]!) || match[2] !== 'blob') { unscannable.push(candidate); continue; }
    const size = Number(match[4]); if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RECORD_BYTES) { unscannable.push(candidate); continue; }
    let bytes: Buffer; try { bytes = execFileSync('/usr/bin/git', ['-C', repo.root, 'cat-file', 'blob', match[3]!], { encoding: 'buffer', maxBuffer: MAX_RECORD_BYTES + 1, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { unscannable.push(candidate); continue; }
    if (bytes.length !== size) { unscannable.push(candidate); continue; }
    if (needles.some((needle) => bytes.includes(needle))) paths.push(candidate);
  }
  if (git(repo.root, ['rev-parse', '--verify', 'HEAD']).trim() !== head) unscannable.push('<HEAD_CHANGED>');
  return Object.freeze({ paths: Object.freeze(paths.sort(stableCompare)), unscannable: Object.freeze(unscannable.sort(stableCompare)) });
}

async function readState(runRoot: string): Promise<Readonly<{ status: string; barrier: string }>> {
  const path = join(runRoot, 'STATE.md'); const stat = await fs.lstat(path); const text = (await boundedRead(path, stat, 'legacy STATE')).toString('utf8');
  const status = text.match(/^Status:\s*(\S+)\s*$/m)?.[1] ?? 'UNKNOWN'; const barrier = text.match(/^Gate barrier:\s*(\S+)\b.*$/m)?.[1] ?? 'UNKNOWN'; return Object.freeze({ status, barrier });
}
async function markerStageNames(runRoot: string): Promise<readonly string[]> { return Object.freeze((await fs.readdir(runRoot)).filter((name) => name.startsWith(MARKER_STAGE_PREFIX)).sort(stableCompare)); }
function expectedMarkerStage(marker: BodyMigrationMarker): Readonly<{ name: string; bytes: Buffer }> { const bytes = Buffer.from(canonicalString(marker)); return Object.freeze({ name: `${MARKER_STAGE_PREFIX}${digestBytes(bytes)}`, bytes }); }
async function readMarker(runRoot: string): Promise<BodyMigrationMarker | undefined> {
  const path = join(runRoot, MARKER); const found = await inspectTrustedPath(path, 'migration marker', { allowMissing: true, surface: true, kind: 'file' }); if (!found) return undefined;
  if ((found.stat.mode & 0o777) !== 0o600) throw new Error('STATE_COLLISION: migration marker mode is unsafe');
  let bytes: Buffer;
  if (found.stat.nlink === 1) bytes = await boundedRead(path, found.stat, 'migration marker');
  else {
    const stages = await markerStageNames(runRoot); if (found.stat.nlink !== 2 || stages.length !== 1 || !markerStageName(stages[0]!)) throw new Error('STATE_COLLISION: migration marker has unbound links');
    const staged = await inspectTrustedPath(join(runRoot, stages[0]!), 'linked migration marker stage', { surface: true, kind: 'file' }); if (!staged || !sameFilesystemIdentity(found.identity, staged.identity) || staged.stat.nlink !== 2 || (staged.stat.mode & 0o777) !== 0o600) throw new Error('STATE_COLLISION: migration marker stage is not its publication link');
    bytes = await boundedReadWithLinks(path, found.stat, 'linked migration marker', MAX_RECORD_BYTES, 2); const stagedBytes = await boundedReadWithLinks(staged.path, staged.stat, 'linked migration marker stage', MAX_RECORD_BYTES, 2); if (!bytes.equals(stagedBytes)) throw new Error('STATE_COLLISION: linked migration marker bytes differ');
  }
  const marker = validateBodyMigrationMarker(parseCanonical(bytes)); if (marker.runId !== basename(runRoot)) throw new Error('migration marker run identity differs'); const expected = expectedMarkerStage(marker); const stages = await markerStageNames(runRoot);
  if (found.stat.nlink === 2 && (stages.length !== 1 || stages[0] !== expected.name || !bytes.equals(expected.bytes))) throw new Error('STATE_COLLISION: linked migration marker stage is unbound');
  return marker;
}
async function presence(runRoot: string, name: string, kind?: 'file' | 'directory'): Promise<boolean> { return Boolean(await inspectTrustedPath(join(runRoot, name), `migration state ${name}`, { allowMissing: true, surface: true, ...(kind ? { kind } : {}) })); }
function recoveryAction(code: MigrationRecoveryCode): string {
  const actions: Record<MigrationRecoveryCode, string> = { ELIGIBLE_LEGACY: 'COPY_AND_PUBLISH_BODY', TEMP_ONLY: 'VERIFY_TEMP_THEN_RECOPY', BODY_WITHOUT_MARKER: 'VERIFY_BODY_THEN_PUBLISH_MARKER', BODY_PUBLISHED: 'REWRITE_REFERENCES_ACCEPT_AND_SEAL', DEFER_TO_FINALIZER: 'RESUME_NORMAL_SEALER', RECEIPT_CLEANUP: 'VERIFY_REFERENCES_AND_UNLINK_EXACT_SOURCES', COMPLETED: 'NOOP', REFUSE_COLLISION: 'PRESERVE_AND_ESCALATE', REFUSE_CHANGED_SOURCE: 'PRESERVE_AND_ESCALATE', REFUSE_UNKNOWN_ABSENCE: 'PRESERVE_AND_ESCALATE', REFUSE_INELIGIBLE: 'PRESERVE_AND_ESCALATE' }; return actions[code];
}

export async function auditRunArtifacts(runRootInput: string): Promise<MigrationAudit> {
  if (!isAbsolute(runRootInput) || resolve(runRootInput) !== runRootInput) throw new Error('RUN_ROOT_UNSAFE'); const runRoot = resolve(await fs.realpath(runRootInput)); const runId = basename(runRoot);
  let source; let repo; const refusals = new Set<MigrationRefusal>();
  try { source = await inventoryLegacySources(runRoot); } catch (error) { const code = (error as Error).message as MigrationRefusal; refusals.add(['LIMIT_EXCEEDED', 'AMBIGUOUS_PATH'].includes(code) ? code : 'RUN_ROOT_UNSAFE'); throw error; }
  try { repo = repositoryFor(runRoot); } catch { refusals.add('NOT_GIT_BACKED'); }
  const state = await readState(runRoot); if (state.status !== 'COMPLETE') refusals.add('NOT_COMPLETE'); if (state.barrier !== 'CLOSED') refusals.add('BARRIER_OPEN');
  if (source.inventory.files === 0) refusals.add('NO_ALLOWLISTED_BODY'); if (source.inventory.entries.some((entry) => extname(entry.relativePath).toLowerCase() !== '.md')) refusals.add('NON_MARKDOWN_BODY');
  if (source.ambiguous.length || source.runtimeBound.length) refusals.add('AMBIGUOUS_PATH'); if (source.custody.length) refusals.add('CUSTODY_PRESENT');
  if (repo) for (const entry of source.inventory.entries) {
    try { git(repo.root, ['ls-files', '--error-unmatch', '--', `${repo.runRelative}/${entry.relativePath}`]); } catch { refusals.add('UNTRACKED_SOURCE'); continue; }
    try { execFileSync('/usr/bin/git', ['-C', repo.root, 'diff', '--quiet', 'HEAD', '--', `${repo.runRelative}/${entry.relativePath}`], { stdio: 'ignore' }); } catch { refusals.add('SOURCE_DIRTY'); }
  }
  const tokens = repo ? referenceTokens(repo, source.inventory.entries) : []; const currentRefs = repo ? await scanCurrentReferences(repo, tokens) : { paths: [], unscannable: [] }; const baseline = repo ? scanBaselineReferences(repo, tokens) : { paths: [], unscannable: [] };
  if (currentRefs.unscannable.length || baseline.unscannable.length) refusals.add('REFERENCE_UNSCANNABLE');
  const markerFound = await presence(runRoot, MARKER, 'file'); const body = await presence(runRoot, BODY, 'directory'); const temp = await presence(runRoot, TEMP, 'directory'); const receipt = await presence(runRoot, RECEIPT, 'file'); const finalizer = await presence(runRoot, '.lunacy-run-finalization.json', 'file') || (await fs.readdir(runRoot)).some((name) => name.startsWith('.work.prune-')); const stages = await markerStageNames(runRoot);
  let marker: BodyMigrationMarker | undefined; if (markerFound) try { marker = await readMarker(runRoot); } catch { refusals.add('STATE_COLLISION'); }
  if (stages.length) try {
    if (marker) { if (stages.length !== 1 || markerStageName(stages[0]!) === false) throw new Error('unbound stage'); const final = await inspectTrustedPath(join(runRoot, MARKER), 'migration marker', { surface: true, kind: 'file' }); if (!final || final.stat.nlink !== 2) throw new Error('unbound stage'); }
    else if (body && !receipt) { const inventory = await inventoryRetentionBody(join(runRoot, BODY)); if (!bodyMatchesSources(inventory, source.inventory.entries)) throw new Error('stage Body differs'); await inspectPartialMarkerStage(runRoot, markerFor(runId, source.inventory, inventory)); }
    else throw new Error('stage has no recoverable Body');
  } catch { refusals.add('STATE_COLLISION'); }
  let code: MigrationRecoveryCode;
  if (finalizer && marker) code = 'DEFER_TO_FINALIZER';
  else if (markerFound && !marker) code = 'REFUSE_COLLISION';
  else if (temp && (body || marker || receipt)) code = 'REFUSE_COLLISION';
  else if (temp) code = 'TEMP_ONLY';
  else if (body && !marker && !receipt) code = 'BODY_WITHOUT_MARKER';
  else if (marker && body && !receipt) code = 'BODY_PUBLISHED';
  else if (marker && !body && receipt) code = 'RECEIPT_CLEANUP';
  else if (!marker && !body && !temp && receipt && source.inventory.files === 0) code = 'COMPLETED';
  else if (!marker && !body && !receipt) code = 'ELIGIBLE_LEGACY';
  else code = 'REFUSE_COLLISION';
  if (marker && !finalizer) {
    try {
      if (body) { const inventory = await inventoryRetentionBody(join(runRoot, BODY)); if (inventory.root.identity.dev !== marker.body.dev || inventory.root.identity.ino !== marker.body.ino || inventory.treeDigest !== marker.body.treeDigest || inventory.files !== marker.body.files || inventory.bytes !== marker.body.bytes || !bodyMatchesSources(inventory, marker.entries)) throw new Error('SOURCE_DRIFT'); sourceMatchesMarker(source.inventory, marker, false); }
      else if (receipt) { requireMatchingReceipt(marker, await readReceipt(runRoot)); sourceMatchesMarker(source.inventory, marker, true); }
    } catch (error) { const message = (error as Error).message; if (message.includes('UNKNOWN_SOURCE_ABSENCE')) { refusals.add('UNKNOWN_SOURCE_ABSENCE'); code = 'REFUSE_UNKNOWN_ABSENCE'; } else if (message.includes('RESULT_IDENTITY_INELIGIBLE')) { refusals.add('RESULT_IDENTITY_INELIGIBLE'); code = 'REFUSE_INELIGIBLE'; } else { refusals.add('SOURCE_DRIFT'); code = 'REFUSE_CHANGED_SOURCE'; } }
  }
  if (code === 'RECEIPT_CLEANUP' && currentRefs.paths.length) refusals.add('REFERENCE_UNRESOLVED');
  if (code.startsWith('REFUSE')) refusals.add('STATE_COLLISION');
  if (stages.length && refusals.has('STATE_COLLISION')) code = 'REFUSE_COLLISION';
  if (code === 'COMPLETED') refusals.delete('NO_ALLOWLISTED_BODY');
  const eligible = refusals.size === 0 && ['ELIGIBLE_LEGACY', 'TEMP_ONLY', 'BODY_WITHOUT_MARKER', 'BODY_PUBLISHED', 'RECEIPT_CLEANUP', 'COMPLETED', 'DEFER_TO_FINALIZER'].includes(code);
  if (!eligible && !code.startsWith('REFUSE') && code !== 'DEFER_TO_FINALIZER') code = 'REFUSE_INELIGIBLE';
  return Object.freeze({ schema: 'lunacy-run-artifact-audit/v1', runId, status: state.status, gateBarrier: state.barrier, eligible, recovery: Object.freeze({ code, action: recoveryAction(code) }), source: Object.freeze({ files: source.inventory.files, bytes: source.inventory.bytes, entries: source.inventory.entries }), references: Object.freeze({ unresolved: currentRefs.paths, baseline: baseline.paths, unscannable: Object.freeze([...currentRefs.unscannable, ...baseline.unscannable].sort(stableCompare)) }), custody: Object.freeze({ paths: Object.freeze([...source.custody, ...source.ambiguous].sort(stableCompare)), runtimeBoundPaths: source.runtimeBound }), artifacts: source.counts, refusals: Object.freeze([...refusals].sort(stableCompare)) });
}

function sourceMatchesMarker(source: SourceInventory, marker: BodyMigrationMarker, allowAbsent: boolean): Readonly<{ present: readonly MigrationEntry[]; absent: readonly MigrationEntry[] }> {
  if (source.root.dev !== marker.sourceRoot.dev || source.root.ino !== marker.sourceRoot.ino) throw new Error('SOURCE_DRIFT: source root changed');
  const observed = new Map(source.entries.map((entry) => [entry.relativePath, entry])); const present: MigrationEntry[] = []; const absent: MigrationEntry[] = [];
  for (const expected of marker.entries) { const actual = observed.get(expected.relativePath); if (!actual) { if (!allowAbsent) throw new Error('UNKNOWN_SOURCE_ABSENCE'); absent.push(expected); continue; } if (canonicalString(actual) !== canonicalString(expected)) throw new Error(`SOURCE_DRIFT: ${expected.relativePath}`); observed.delete(expected.relativePath); present.push(expected); }
  if (observed.size) throw new Error('SOURCE_DRIFT: new allowlisted source'); return Object.freeze({ present: Object.freeze(present), absent: Object.freeze(absent) });
}
function bodyMatchesSources(inventory: BodyInventory, sourceEntries: readonly MigrationEntry[]): boolean {
  if (inventory.files !== sourceEntries.length || inventory.bytes !== sourceEntries.reduce((sum, entry) => sum + entry.size, 0)) return false;
  const files = inventory.cleanupEntries.filter((entry) => entry.digest !== undefined); if (files.length !== sourceEntries.length) return false;
  return files.every((entry, index) => { const source = sourceEntries[index]; return Boolean(source) && entry.relativePath === source.relativePath && entry.mode === source.mode && entry.size === source.size && entry.digest === source.digest; });
}
async function removeVerifiedTemp(runRoot: string, source: SourceInventory, platform: RetentionPlatform, fault?: MigrationOptions['fault']): Promise<void> {
  const path = join(runRoot, TEMP); const inventory = await inventoryRetentionBody(path, platform); const sourceMap = new Map(source.entries.map((entry) => [entry.relativePath, entry]));
  for (const entry of inventory.cleanupEntries) {
    if (entry.relativePath === '.') continue;
    if (entry.digest !== undefined) { const expected = sourceMap.get(entry.relativePath); if (!expected || entry.mode !== expected.mode || entry.size !== expected.size || entry.digest !== expected.digest) throw new Error('STATE_COLLISION: unbound migration temp'); }
    else if (!source.entries.some((item) => item.relativePath.startsWith(`${entry.relativePath}/`))) throw new Error('STATE_COLLISION: unbound migration temp directory');
  }
  for (const entry of [...inventory.cleanupEntries].sort((a, b) => b.relativePath.split('/').length - a.relativePath.split('/').length || -stableCompare(a.relativePath, b.relativePath))) {
    const current = await inspectTrustedPath(entry.relativePath === '.' ? path : join(path, entry.relativePath), 'migration temp cleanup', { surface: true }); if (!current || current.identity.dev !== entry.dev || current.identity.ino !== entry.ino) throw new Error('STATE_COLLISION: migration temp changed');
    if (entry.digest !== undefined) await fs.unlink(current.path); else await fs.rmdir(current.path); await syncDirectory(dirname(current.path), 'migration temp parent');
  }
  await fault?.('TEMP_REMOVED');
}
async function copySources(runRoot: string, source: SourceInventory, options: MigrationOptions): Promise<BodyInventory> {
  const platform = options.platform ?? nativeRetentionPlatform; const tempPath = join(runRoot, TEMP); await fs.mkdir(tempPath, { mode: 0o700 });
  const directories = new Set<string>(['']); for (const entry of source.entries) { let parent = dirname(entry.relativePath); while (parent !== '.') { directories.add(parent); parent = dirname(parent); } }
  for (const directory of [...directories].filter(Boolean).sort((a, b) => a.split('/').length - b.split('/').length || stableCompare(a, b))) await fs.mkdir(join(tempPath, directory), { mode: 0o700 });
  for (const entry of source.entries) {
    const sourcePath = join(runRoot, entry.relativePath); const found = await inspectTrustedPath(sourcePath, `migration source ${entry.relativePath}`, { surface: true, kind: 'file' }); if (!found || !sameFilesystemIdentity(found.identity, entry) || (found.stat.mode & 0o777) !== entry.mode || found.stat.size !== entry.size) throw new Error(`SOURCE_DRIFT: ${entry.relativePath}`);
    const bytes = await boundedRead(sourcePath, found.stat, `migration source ${entry.relativePath}`, MAX_BYTES); if (digestBytes(bytes) !== entry.digest) throw new Error(`SOURCE_DRIFT: ${entry.relativePath}`);
    const destination = join(tempPath, entry.relativePath); const handle = await fs.open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, entry.mode);
    try { await handle.writeFile(bytes); await handle.chmod(entry.mode); await options.fault?.('COPY_FILE', entry.relativePath); await handle.sync(); await options.fault?.('COPY_FILE_FSYNC', entry.relativePath); const copied = await handle.stat(); if (copied.size !== entry.size || (copied.mode & 0o777) !== entry.mode) throw new Error('copied Body file changed'); }
    finally { await handle.close(); }
  }
  for (const directory of [...directories].sort((a, b) => b.split('/').length - a.split('/').length || stableCompare(a, b))) { await syncDirectory(directory ? join(tempPath, directory) : tempPath, 'migration destination directory'); await options.fault?.('COPY_DIRECTORY_FSYNC', directory || '.'); }
  const inventory = await inventoryRetentionBody(tempPath, platform); if (!bodyMatchesSources(inventory, source.entries)) throw new Error('STATE_COLLISION: copied Body differs from sources');
  await fs.rename(tempPath, join(runRoot, BODY)); await options.fault?.('BODY_RENAME'); await syncDirectory(runRoot, 'migration run root'); await options.fault?.('BODY_RENAME_FSYNC');
  const published = await inventoryRetentionBody(join(runRoot, BODY), platform); if (!bodyMatchesSources(published, source.entries) || published.treeDigest !== inventory.treeDigest) throw new Error('STATE_COLLISION: published Body differs from sources'); return published;
}
function markerFor(runId: string, source: SourceInventory, body: BodyInventory): BodyMigrationMarker { return validateBodyMigrationMarker({ schema: 'lunacy-body-migration/v1', runId, sourceRoot: source.root, entries: source.entries, body: { dev: body.root.identity.dev, ino: body.root.identity.ino, treeDigest: body.treeDigest, files: body.files, bytes: body.bytes }, phase: 'BODY_PUBLISHED' }); }
async function inspectPartialMarkerStage(runRoot: string, marker: BodyMigrationMarker): Promise<Readonly<{ path: string; dev: string; ino: string; bytes: Buffer }> | undefined> {
  const expected = expectedMarkerStage(marker); const stages = await markerStageNames(runRoot); if (stages.length === 0) return undefined;
  if (stages.length !== 1 || stages[0] !== expected.name || !markerStageName(stages[0]!)) throw new Error('STATE_COLLISION: unbound migration marker stage');
  const found = await inspectTrustedPath(join(runRoot, expected.name), 'migration marker stage', { surface: true, kind: 'file' }); const root = await inspectTrustedPath(runRoot, 'migration marker stage root', { surface: true, kind: 'directory' });
  if (!found || !root || found.stat.nlink !== 1 || found.identity.dev !== root.identity.dev || (found.stat.mode & 0o777) !== 0o600 || found.stat.size > expected.bytes.length) throw new Error('STATE_COLLISION: migration marker stage is unsafe');
  const bytes = await boundedRead(found.path, found.stat, 'migration marker stage', expected.bytes.length); if (!expected.bytes.subarray(0, bytes.length).equals(bytes)) throw new Error('STATE_COLLISION: migration marker stage is not an exact owned prefix');
  return Object.freeze({ path: found.path, dev: found.identity.dev, ino: found.identity.ino, bytes });
}
async function settlePublishedMarkerStage(runRoot: string, marker: BodyMigrationMarker, fault?: MigrationOptions['fault']): Promise<void> {
  const stages = await markerStageNames(runRoot); if (stages.length === 0) return; const expected = expectedMarkerStage(marker); if (stages.length !== 1 || stages[0] !== expected.name) throw new Error('STATE_COLLISION: unbound migration marker stage');
  const final = await inspectTrustedPath(join(runRoot, MARKER), 'published migration marker', { surface: true, kind: 'file' }); const staged = await inspectTrustedPath(join(runRoot, expected.name), 'published migration marker stage', { surface: true, kind: 'file' });
  if (!final || !staged || final.stat.nlink !== 2 || staged.stat.nlink !== 2 || !sameFilesystemIdentity(final.identity, staged.identity) || (final.stat.mode & 0o777) !== 0o600 || final.stat.size !== expected.bytes.length) throw new Error('STATE_COLLISION: migration marker stage is not bound to final marker');
  const bytes = await boundedReadWithLinks(final.path, final.stat, 'published migration marker', expected.bytes.length, 2); if (!bytes.equals(expected.bytes)) throw new Error('STATE_COLLISION: published migration marker differs from stage binding');
  const current = await inspectTrustedPath(staged.path, 'migration marker stage unlink', { surface: true, kind: 'file' }); if (!current || !sameFilesystemIdentity(current.identity, staged.identity) || current.stat.nlink !== 2) throw new Error('STATE_COLLISION: migration marker stage changed before unlink');
  await fs.unlink(staged.path); await fault?.('MARKER_STAGE_UNLINK'); await syncDirectory(runRoot, 'migration marker stage parent'); await fault?.('MARKER_STAGE_PARENT_FSYNC');
}
async function publishMarker(runRoot: string, marker: BodyMigrationMarker, fault?: MigrationOptions['fault']): Promise<void> {
  const expected = expectedMarkerStage(marker); const existing = await inspectPartialMarkerStage(runRoot, marker);
  if (existing) {
    const current = await inspectTrustedPath(existing.path, 'migration marker stage recovery', { surface: true, kind: 'file' }); if (!current || current.identity.dev !== existing.dev || current.identity.ino !== existing.ino || current.stat.nlink !== 1) throw new Error('STATE_COLLISION: migration marker stage changed before recovery');
    await fs.unlink(existing.path); await syncDirectory(runRoot, 'migration marker stage recovery parent'); await fault?.('MARKER_STAGE_RECOVERED');
  }
  const stagePath = join(runRoot, expected.name); const finalPath = join(runRoot, MARKER); const handle = await fs.open(stagePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600); const split = Math.max(1, Math.floor(expected.bytes.length / 2)); await handle.writeFile(expected.bytes.subarray(0, split)); await fault?.('MARKER_STAGE_PARTIAL'); await handle.writeFile(expected.bytes.subarray(split)); await fault?.('MARKER_STAGE_WRITE'); await handle.sync(); await fault?.('MARKER_STAGE_FSYNC');
  } finally { await handle.close(); }
  try { await fs.link(stagePath, finalPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('STATE_COLLISION: migration marker publication collision'); throw error; }
  await fault?.('MARKER_PUBLISH'); await syncDirectory(runRoot, 'migration marker parent'); await fault?.('MARKER_PARENT_FSYNC');
  await settlePublishedMarkerStage(runRoot, marker, fault);
}
async function readReceipt(runRoot: string): Promise<RunReceipt> { const found = await inspectTrustedPath(join(runRoot, RECEIPT), 'migration receipt', { surface: true, kind: 'file' }); if (!found) throw new Error('STATE_COLLISION: receipt absent'); return validateRunReceipt(parseCanonical(await boundedRead(join(runRoot, RECEIPT), found.stat, 'migration receipt'))); }
function requireMatchingReceipt(marker: BodyMigrationMarker, receipt: RunReceipt): Record<string, unknown> {
  const item = receipt as Record<string, unknown>; const body = item.body as Record<string, unknown>; if (item.runId !== marker.runId || body.treeDigest !== marker.body.treeDigest || body.files !== marker.body.files || body.bytes !== marker.body.bytes) throw new Error('STATE_COLLISION: receipt does not bind migration Body');
  const identity = item.resultIdentity as Record<string, unknown>; if (identity.kind !== 'manifest' || identity.schema !== 'lunacy-product-manifest/v1') throw new Error('RESULT_IDENTITY_INELIGIBLE: migration requires product manifest'); return identity;
}
async function cleanupOriginals(runRoot: string, marker: BodyMigrationMarker, source: SourceInventory, options: MigrationOptions): Promise<Readonly<{ status: string; removed: number }>> {
  const receipt = await readReceipt(runRoot); const manifest = requireMatchingReceipt(marker, receipt); const match = sourceMatchesMarker(source, marker, true); const repo = repositoryFor(runRoot); const tokens = referenceTokens(repo, marker.entries); const refs = await scanCurrentReferences(repo, tokens); if (refs.unscannable.length) throw new Error(`REFERENCE_UNSCANNABLE: ${refs.unscannable.join(',')}`); if (refs.paths.length) throw new Error(`REFERENCE_UNRESOLVED: ${refs.paths.join(',')}`);
  const baseline = scanBaselineReferences(repo, tokens); if (baseline.unscannable.length) throw new Error(`REFERENCE_UNSCANNABLE: ${baseline.unscannable.join(',')}`); const manifestPaths = new Set(((manifest.entries as readonly Record<string, unknown>[]) ?? []).map((entry) => entry.path)); for (const path of baseline.paths) if (!manifestPaths.has(path)) throw new Error(`RESULT_MANIFEST_INCOMPLETE: ${path}`);
  for (const entry of match.present) { const path = join(runRoot, entry.relativePath); const current = await inspectTrustedPath(path, `migration source ${entry.relativePath}`, { surface: true, kind: 'file' }); if (!current || current.identity.dev !== entry.dev || current.identity.ino !== entry.ino || (current.stat.mode & 0o777) !== entry.mode || current.stat.size !== entry.size || digestBytes(await boundedRead(path, current.stat, `migration source ${entry.relativePath}`, MAX_BYTES)) !== entry.digest) throw new Error(`SOURCE_DRIFT: ${entry.relativePath}`); }
  let removed = 0;
  for (const entry of match.present) { const path = join(runRoot, entry.relativePath); const current = await inspectTrustedPath(path, `migration source unlink ${entry.relativePath}`, { surface: true, kind: 'file' }); if (!current || current.identity.dev !== entry.dev || current.identity.ino !== entry.ino || (current.stat.mode & 0o777) !== entry.mode || current.stat.size !== entry.size || digestBytes(await boundedRead(path, current.stat, `migration source unlink ${entry.relativePath}`, MAX_BYTES)) !== entry.digest) throw new Error(`SOURCE_DRIFT: ${entry.relativePath}`); await fs.unlink(path); removed += 1; await options.fault?.('SOURCE_UNLINK', entry.relativePath); await syncDirectory(dirname(path), `migration source parent ${entry.relativePath}`); await options.fault?.('SOURCE_PARENT_FSYNC', entry.relativePath); }
  const directories = new Set<string>(); for (const entry of marker.entries) { let current = dirname(entry.relativePath); while (current !== '.') { if (!['phases', `phases/${entry.relativePath.split('/')[1]}`].includes(current)) directories.add(current); current = dirname(current); } }
  for (const directory of [...directories].sort((a, b) => b.split('/').length - a.split('/').length || -stableCompare(a, b))) {
    const path = join(runRoot, directory); const found = await inspectTrustedPath(path, `migration empty directory ${directory}`, { allowMissing: true, surface: true, kind: 'directory' }); if (!found || found.identity.dev !== marker.sourceRoot.dev) continue; const names = await fs.readdir(path); if (names.length !== 0) continue; await fs.rmdir(path); await syncDirectory(dirname(path), `migration empty directory parent ${directory}`); await options.fault?.('EMPTY_DIRECTORY_REMOVED', directory);
  }
  const markerFound = await inspectTrustedPath(join(runRoot, MARKER), 'migration marker', { surface: true, kind: 'file' }); if (!markerFound) throw new Error('STATE_COLLISION: migration marker absent'); const currentMarker = validateBodyMigrationMarker(parseCanonical(await boundedRead(join(runRoot, MARKER), markerFound.stat, 'migration marker'))); if (canonicalString(currentMarker) !== canonicalString(marker)) throw new Error('STATE_COLLISION: migration marker changed'); await fs.unlink(join(runRoot, MARKER)); await syncDirectory(runRoot, 'migration marker parent'); await options.fault?.('MARKER_REMOVED');
  return Object.freeze({ schema: 'lunacy-body-migration-result/v1', status: 'COMPLETED', runId: marker.runId, removed });
}

export async function migrateRunBody(runRootInput: string, options: MigrationOptions = {}): Promise<Readonly<Record<string, unknown>>> {
  if (!isAbsolute(runRootInput) || resolve(runRootInput) !== runRootInput) throw new Error('RUN_ROOT_UNSAFE: run root must be absolute and canonical'); const runRoot = resolve(await fs.realpath(runRootInput));
  return withRunFinalizationExclusion(runRoot, options.signal, async () => {
    const sourceDetail = await inventoryLegacySources(runRoot); const source = sourceDetail.inventory; const markerPresent = await presence(runRoot, MARKER, 'file'); let marker = markerPresent ? await readMarker(runRoot) : undefined; if (marker) await settlePublishedMarkerStage(runRoot, marker, options.fault);
    if (sourceDetail.ambiguous.length || sourceDetail.runtimeBound.length || sourceDetail.custody.length) throw new Error(`AMBIGUOUS_PATH: ${[...sourceDetail.ambiguous, ...sourceDetail.runtimeBound, ...sourceDetail.custody].join(',')}`);
    const bodyPresent = await presence(runRoot, BODY, 'directory'); const tempPresent = await presence(runRoot, TEMP, 'directory'); const receiptPresent = await presence(runRoot, RECEIPT, 'file'); const finalizerPresent = await presence(runRoot, '.lunacy-run-finalization.json', 'file') || (await fs.readdir(runRoot)).some((name) => name.startsWith('.work.prune-'));
    if (marker && finalizerPresent) return Object.freeze({ schema: 'lunacy-body-migration-result/v1', status: 'DEFER_TO_FINALIZER', runId: marker.runId });
    if (tempPresent && (bodyPresent || markerPresent || receiptPresent)) throw new Error('STATE_COLLISION: migration temp collides with durable state');
    if (marker && !bodyPresent && receiptPresent) return cleanupOriginals(runRoot, marker, source, options);
    if (marker && !bodyPresent && !receiptPresent) throw new Error('STATE_COLLISION: marker has neither Body nor receipt');
    if (marker && bodyPresent && receiptPresent) throw new Error('STATE_COLLISION: receipt collides with Body');
    if (marker && bodyPresent) { sourceMatchesMarker(source, marker, false); return Object.freeze({ schema: 'lunacy-body-migration-result/v1', status: 'BODY_PUBLISHED', runId: marker.runId, body: marker.body, originalsRetained: marker.entries.length }); }
    if (!marker && !bodyPresent && receiptPresent && source.files === 0) return Object.freeze({ schema: 'lunacy-body-migration-result/v1', status: 'ALREADY_COMPLETED', runId: basename(runRoot), removed: 0 });
    if (receiptPresent) throw new Error('STATE_COLLISION: receipt is not bound by a migration marker');
    const audit = await auditRunArtifacts(runRoot); if (!audit.eligible && !['TEMP_ONLY', 'BODY_WITHOUT_MARKER'].includes(audit.recovery.code)) throw new Error(`REFUSE_INELIGIBLE: ${audit.refusals.join(',')}`);
    if (tempPresent) await removeVerifiedTemp(runRoot, source, options.platform ?? nativeRetentionPlatform, options.fault);
    let inventory: BodyInventory;
    if (bodyPresent) { inventory = await inventoryRetentionBody(join(runRoot, BODY), options.platform ?? nativeRetentionPlatform); if (!bodyMatchesSources(inventory, source.entries)) throw new Error('STATE_COLLISION: Body without marker differs from sources'); }
    else inventory = await copySources(runRoot, source, options);
    marker = markerFor(basename(runRoot), source, inventory); await publishMarker(runRoot, marker, options.fault); return Object.freeze({ schema: 'lunacy-body-migration-result/v1', status: 'BODY_PUBLISHED', runId: marker.runId, body: marker.body, originalsRetained: marker.entries.length });
  });
}
