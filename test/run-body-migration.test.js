import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { auditRunArtifacts, migrateRunBody, validateBodyMigrationMarker } from '../dist/run-body-migration.js';
import { canonicalString, digest, digestBytes, parseCanonical } from '../dist/canonical.js';
import { prepareManualAcceptance, sealRetentionRun } from '../dist/run-retention.js';

const sourceFiles = Object.freeze({
  'phases/p1/evidence/log.md': 'proof log\n',
  'phases/p1/hard-gate-01.md': '# Gate\nPASS\n',
});
const controlFiles = Object.freeze({
  'PLAN.md': '# Plan\n',
  'STATE.md': '# State\nStatus: COMPLETE\nGate barrier: CLOSED\n',
  'OUTCOME.md': '# Outcome\nAccepted.\n',
  'phases/p1/STEPS.md': '# Steps\n',
});
const syntheticPlatform = Object.freeze({
  async captureMountIdentity() { return { schema: 'lunacy-retention-mounts/v1', platform: process.platform === 'darwin' ? 'darwin' : 'linux', digest: 'a'.repeat(64), mountPoints: ['/'] }; },
  async captureRunSealQuiescence() { return { schema: 'lunacy-run-quiescence/v1', digest: 'b'.repeat(64), openHandles: 0, publicationGate: 'REQUIRED_ZERO_HANDLES', platform: process.platform === 'darwin' ? 'darwin' : 'linux', inspectedProcesses: 0 }; },
});

function git(root, args, options = {}) { return execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim(); }
async function fixture({ references = true, files = sourceFiles } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lunacy-migration-'))); git(root, ['init', '-q']); git(root, ['config', 'user.email', 'fixture@example.test']); git(root, ['config', 'user.name', 'fixture']);
  const runRoot = join(root, 'Lunacy/runs/pilot');
  for (const [path, bytes] of Object.entries({ ...controlFiles, ...files })) { await mkdir(dirname(join(runRoot, path)), { recursive: true }); await writeFile(join(runRoot, path), bytes); }
  await writeFile(join(root, 'README.md'), references ? 'See Lunacy/runs/pilot/phases/p1/evidence/log.md and Lunacy/runs/pilot/phases/p1/hard-gate-01.md.\n' : '# Product\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'fixture']);
  return { root, runRoot, files };
}
async function snapshot(root) {
  const entries = [];
  const visit = async (path) => {
    const value = await lstat(path, { bigint: true }); const rel = relative(root, path) || '.'; entries.push({ path: rel, dev: String(value.dev), ino: String(value.ino), mode: String(value.mode), size: String(value.size), mtimeNs: String(value.mtimeNs), digest: value.isFile() ? digestBytes(await readFile(path)) : undefined });
    if (value.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  };
  await visit(root); return entries;
}
function manifest(root, paths) {
  const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return { kind: 'manifest', schema: 'lunacy-product-manifest/v1', roots: sorted, entries: sorted.map((path) => ({ path, digest: digestBytes(execFileSync('/bin/cat', [join(root, path)])) })) };
}
async function acceptAndSeal(item, identity) {
  const authority = [
    { path: 'PLAN.md', digest: digestBytes(Buffer.from(controlFiles['PLAN.md'])) },
    { path: 'phases/p1/STEPS.md', digest: digestBytes(Buffer.from(controlFiles['phases/p1/STEPS.md'])) },
  ];
  const acceptance = { schema: 'lunacy-parent-acceptance/v1', runId: 'pilot', disposition: 'ACCEPTED', activeWorkers: 'NONE', authorityDigest: digest(authority), outcomeDigest: digestBytes(Buffer.from(controlFiles['OUTCOME.md'])), terminalStateDigest: digestBytes(Buffer.from(controlFiles['STATE.md'])), resultIdentity: identity, resultIdentityDigest: digest(identity) };
  const acceptancePath = join(await realpath(await mkdtemp(join(tmpdir(), 'lunacy-acceptance-'))), 'acceptance.json'); await writeFile(acceptancePath, canonicalString(acceptance));
  const before = process.cwd(); process.chdir(item.root);
  try { await prepareManualAcceptance(item.runRoot, acceptancePath); return await sealRetentionRun(item.runRoot, { mode: 'accept', installedRuntime: item.root, platform: syntheticPlatform }); }
  finally { process.chdir(before); await rm(dirname(acceptancePath), { recursive: true, force: true }); }
}
async function publishedFixture(options) { const item = await fixture(options); await migrateRunBody(item.runRoot, { platform: syntheticPlatform }); item.marker = parseCanonical(await readFile(join(item.runRoot, '.lunacy-body-migration.json'))); return item; }
async function assertFinalMarkerAbsentOrCanonical(runRoot) {
  const names = await readdir(runRoot); if (!names.includes('.lunacy-body-migration.json')) return;
  const bytes = await readFile(join(runRoot, '.lunacy-body-migration.json')); const marker = validateBodyMigrationMarker(parseCanonical(bytes)); assert.equal(canonicalString(marker), bytes.toString('utf8'));
}

test('closed migration marker validator binds sorted source and Body identities', () => {
  const marker = { schema: 'lunacy-body-migration/v1', runId: 'pilot', sourceRoot: { dev: '1', ino: '2' }, entries: [{ relativePath: 'phases/p/evidence/a.md', dev: '1', ino: '3', mode: 0o644, size: 1, digest: 'a'.repeat(64) }], body: { dev: '1', ino: '4', treeDigest: 'b'.repeat(64), files: 1, bytes: 1 }, phase: 'BODY_PUBLISHED' };
  assert.deepEqual(validateBodyMigrationMarker(marker), marker);
  assert.throws(() => validateBodyMigrationMarker({ ...marker, extra: true }), /closed/);
  assert.throws(() => validateBodyMigrationMarker({ ...marker, entries: [...marker.entries, marker.entries[0]] }), /sorted/);
  assert.throws(() => validateBodyMigrationMarker({ ...marker, body: { ...marker.body, bytes: 2 } }), /counts/);
});

test('audit is byte, mode, mtime, and inode inert and reports eligibility, references, custody, and counts', async (t) => {
  const item = await fixture(); t.after(() => rm(item.root, { recursive: true, force: true })); const before = await snapshot(item.runRoot); const report = await auditRunArtifacts(item.runRoot); const after = await snapshot(item.runRoot);
  assert.deepEqual(after, before); assert.equal(report.eligible, true); assert.equal(report.recovery.code, 'ELIGIBLE_LEGACY'); assert.deepEqual(report.references.unresolved, ['README.md']); assert.deepEqual(report.references.baseline, ['README.md']); assert.deepEqual(report.references.unscannable, []); assert.deepEqual(report.custody, { paths: [], runtimeBoundPaths: [] }); assert.equal(report.source.files, 2); assert.equal(report.source.bytes, 22); assert.deepEqual(report.artifacts, { evidence: { files: 1, bytes: 10 }, reports: { files: 0, bytes: 0 }, gates: { files: 1, bytes: 12 } });
});

test('audit refuses nonterminal, ambiguous reports, custody, untracked Body, and unscannable durable text', async (t) => {
  const item = await fixture(); t.after(() => rm(item.root, { recursive: true, force: true })); await writeFile(join(item.runRoot, 'STATE.md'), '# State\nStatus: ACTIVE\nGate barrier: OPEN\n'); await mkdir(join(item.runRoot, '.kernel')); await writeFile(join(item.runRoot, '.kernel/CURRENT'), 'custody'); await mkdir(join(item.runRoot, 'phases/p1/reports')); await writeFile(join(item.runRoot, 'phases/p1/reports/S1-worker-01.md'), 'ambiguous'); await writeFile(join(item.runRoot, 'phases/p1/evidence/untracked.md'), 'new'); await writeFile(join(item.root, 'large.md'), Buffer.alloc(4 * 1024 * 1024 + 1, 65));
  const report = await auditRunArtifacts(item.runRoot); assert.equal(report.eligible, false); for (const code of ['NOT_COMPLETE', 'BARRIER_OPEN', 'AMBIGUOUS_PATH', 'CUSTODY_PRESENT', 'UNTRACKED_SOURCE', 'REFERENCE_UNSCANNABLE']) assert.ok(report.refusals.includes(code), code); assert.deepEqual(report.custody.runtimeBoundPaths, ['phases/p1/reports/S1-worker-01.md']);
});

test('current binary bytes are scanned for exact source references despite invalid UTF-8', async (t) => {
  const item = await fixture({ references: false }); t.after(() => rm(item.root, { recursive: true, force: true })); const token = 'Lunacy/runs/pilot/phases/p1/evidence/log.md'; await writeFile(join(item.root, 'asset.bin'), Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(token), Buffer.from([0xfe])]));
  const audit = await auditRunArtifacts(item.runRoot); assert.deepEqual(audit.references.unresolved, ['asset.bin']); assert.deepEqual(audit.references.unscannable, []);
  await migrateRunBody(item.runRoot, { platform: syntheticPlatform }); await acceptAndSeal(item, manifest(item.root, ['asset.bin'])); await assert.rejects(() => migrateRunBody(item.runRoot, { platform: syntheticPlatform }), /REFERENCE_UNRESOLVED: asset\.bin/);
});

test('HEAD binary references remain manifest-bound after the current bytes are rewritten', async (t) => {
  const item = await fixture({ references: false }); t.after(() => rm(item.root, { recursive: true, force: true })); const token = 'Lunacy/runs/pilot/phases/p1/evidence/log.md'; await writeFile(join(item.root, 'asset.bin'), Buffer.concat([Buffer.from([0xff]), Buffer.from(token), Buffer.from([0xfe])])); git(item.root, ['add', 'asset.bin']); git(item.root, ['commit', '--amend', '--no-edit', '-q']);
  const audit = await auditRunArtifacts(item.runRoot); assert.deepEqual(audit.references.unresolved, ['asset.bin']); assert.deepEqual(audit.references.baseline, ['asset.bin']); assert.deepEqual(audit.references.unscannable, []);
  await migrateRunBody(item.runRoot, { platform: syntheticPlatform }); await writeFile(join(item.root, 'asset.bin'), Buffer.from([0xff, 0x00, 0xfe])); await acceptAndSeal(item, manifest(item.root, ['asset.bin'])); const result = await migrateRunBody(item.runRoot, { platform: syntheticPlatform }); assert.equal(result.status, 'COMPLETED');
});

test('missing current and oversized HEAD candidates refuse as unscannable', async (t) => {
  const missing = await fixture({ references: false }); t.after(() => rm(missing.root, { recursive: true, force: true })); await writeFile(join(missing.root, 'candidate.bin'), 'tracked'); git(missing.root, ['add', 'candidate.bin']); git(missing.root, ['commit', '--amend', '--no-edit', '-q']); await rm(join(missing.root, 'candidate.bin')); let audit = await auditRunArtifacts(missing.runRoot); assert.ok(audit.references.unscannable.includes('candidate.bin')); assert.ok(audit.refusals.includes('REFERENCE_UNSCANNABLE'));
  const large = await fixture({ references: false }); t.after(() => rm(large.root, { recursive: true, force: true })); await writeFile(join(large.root, 'large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1)); git(large.root, ['add', 'large.bin']); git(large.root, ['commit', '--amend', '--no-edit', '-q']); audit = await auditRunArtifacts(large.runRoot); assert.ok(audit.references.unscannable.includes('large.bin')); assert.ok(audit.refusals.includes('REFERENCE_UNSCANNABLE'));
});

test('copy-only pilot publishes exact Body and marker while retaining originals', async (t) => {
  const item = await fixture(); t.after(() => rm(item.root, { recursive: true, force: true })); const result = await migrateRunBody(item.runRoot, { platform: syntheticPlatform }); assert.equal(result.status, 'BODY_PUBLISHED');
  const marker = validateBodyMigrationMarker(parseCanonical(await readFile(join(item.runRoot, '.lunacy-body-migration.json')))); assert.equal(marker.phase, 'BODY_PUBLISHED'); assert.deepEqual(marker.entries.map((entry) => entry.relativePath), Object.keys(sourceFiles).sort()); assert.equal(marker.body.treeDigest, result.body.treeDigest);
  for (const [path, bytes] of Object.entries(sourceFiles)) { assert.equal(await readFile(join(item.runRoot, path), 'utf8'), bytes); assert.equal(await readFile(join(item.runRoot, '.work', path), 'utf8'), bytes); }
  assert.equal((await readdir(item.runRoot)).includes('.work.migrate-tmp'), false); assert.equal((await auditRunArtifacts(item.runRoot)).recovery.code, 'BODY_PUBLISHED');
});

test('every copy, destination fsync, rename, and marker fault prefix resumes without source loss', async (t) => {
  const points = ['COPY_FILE', 'COPY_FILE_FSYNC', 'COPY_DIRECTORY_FSYNC', 'BODY_RENAME', 'BODY_RENAME_FSYNC', 'MARKER_STAGE_PARTIAL', 'MARKER_STAGE_WRITE', 'MARKER_STAGE_FSYNC', 'MARKER_PUBLISH', 'MARKER_PARENT_FSYNC', 'MARKER_STAGE_UNLINK', 'MARKER_STAGE_PARENT_FSYNC'];
  for (const point of points) {
    await t.test(point, async (child) => { const item = await fixture({ references: false }); child.after(() => rm(item.root, { recursive: true, force: true })); let cut = false; await assert.rejects(() => migrateRunBody(item.runRoot, { platform: syntheticPlatform, fault(at) { if (!cut && at === point) { cut = true; throw new Error(`cut:${point}`); } } }), new RegExp(`cut:${point}`)); assert.equal(cut, true); await assertFinalMarkerAbsentOrCanonical(item.runRoot); if (point === 'MARKER_STAGE_PARTIAL') { const stage = (await readdir(item.runRoot)).find((name) => name.startsWith('.lunacy-body-migration.json.stage-')); assert.ok(stage); const stagedBytes = await readFile(join(item.runRoot, stage)); assert.throws(() => parseCanonical(stagedBytes), /JSON|canonical|Unexpected/); } for (const [path, bytes] of Object.entries(sourceFiles)) assert.equal(await readFile(join(item.runRoot, path), 'utf8'), bytes); const resumed = await migrateRunBody(item.runRoot, { platform: syntheticPlatform }); assert.equal(resumed.status, 'BODY_PUBLISHED'); await assertFinalMarkerAbsentOrCanonical(item.runRoot); });
  }
});

test('unbound temp, changed source, and unknown pre-receipt absence refuse without deletion', async (t) => {
  const temp = await fixture({ references: false }); t.after(() => rm(temp.root, { recursive: true, force: true })); await mkdir(join(temp.runRoot, '.work.migrate-tmp')); await writeFile(join(temp.runRoot, '.work.migrate-tmp/foreign'), 'x'); await assert.rejects(() => migrateRunBody(temp.runRoot, { platform: syntheticPlatform }), /unbound migration temp/); for (const path of Object.keys(sourceFiles)) assert.equal((await stat(join(temp.runRoot, path))).isFile(), true);
  const changed = await publishedFixture({ references: false }); t.after(() => rm(changed.root, { recursive: true, force: true })); await writeFile(join(changed.runRoot, Object.keys(sourceFiles)[0]), 'changed'); await assert.rejects(() => migrateRunBody(changed.runRoot, { platform: syntheticPlatform }), /SOURCE_DRIFT/); assert.equal((await stat(join(changed.runRoot, Object.keys(sourceFiles)[1]))).isFile(), true);
  const missing = await publishedFixture({ references: false }); t.after(() => rm(missing.root, { recursive: true, force: true })); await rm(join(missing.runRoot, Object.keys(sourceFiles)[0])); await assert.rejects(() => migrateRunBody(missing.runRoot, { platform: syntheticPlatform }), /UNKNOWN_SOURCE_ABSENCE/); assert.equal((await stat(join(missing.runRoot, Object.keys(sourceFiles)[1]))).isFile(), true);
});

test('foreign marker-stage collisions are preserved and never treated as recoverable prefixes', async (t) => {
  const item = await fixture({ references: false }); t.after(() => rm(item.root, { recursive: true, force: true })); await migrateRunBody(item.runRoot, { platform: syntheticPlatform, fault(at) { if (at === 'BODY_RENAME_FSYNC') throw new Error('cut'); } }).catch(() => undefined); const stage = `.lunacy-body-migration.json.stage-${'a'.repeat(64)}`; await writeFile(join(item.runRoot, stage), 'foreign');
  await assert.rejects(() => migrateRunBody(item.runRoot, { platform: syntheticPlatform }), /STATE_COLLISION|REFUSE_INELIGIBLE/); assert.equal(await readFile(join(item.runRoot, stage), 'utf8'), 'foreign'); assert.equal((await readdir(item.runRoot)).includes('.lunacy-body-migration.json'), false);
});

test('marker plus normal finalizer state defers entirely to sealer recovery', async (t) => {
  const item = await publishedFixture({ references: false }); t.after(() => rm(item.root, { recursive: true, force: true })); await writeFile(join(item.runRoot, '.lunacy-run-finalization.json'), '{}'); const result = await migrateRunBody(item.runRoot, { platform: syntheticPlatform }); assert.equal(result.status, 'DEFER_TO_FINALIZER'); assert.equal((await stat(join(item.runRoot, Object.keys(sourceFiles)[0]))).isFile(), true);
});

test('normal manifest acceptance seals matching Body before any original unlink, then cleanup converges across every unlink prefix', async (t) => {
  const points = ['SOURCE_UNLINK', 'SOURCE_PARENT_FSYNC', 'EMPTY_DIRECTORY_REMOVED', 'MARKER_REMOVED'];
  for (const point of points) await t.test(point, async (child) => {
    const item = await publishedFixture(); child.after(() => rm(item.root, { recursive: true, force: true })); await writeFile(join(item.root, 'README.md'), 'See accepted OUTCOME.md and RUN-RECEIPT.json.\n'); const identity = manifest(item.root, ['README.md']); const sealed = await acceptAndSeal(item, identity); assert.equal(sealed.status, 'SEALED'); assert.equal(sealed.body.treeDigest, item.marker.body.treeDigest); for (const path of Object.keys(sourceFiles)) assert.equal((await stat(join(item.runRoot, path))).isFile(), true);
    let cut = false; await assert.rejects(() => migrateRunBody(item.runRoot, { platform: syntheticPlatform, fault(at) { if (!cut && at === point) { cut = true; throw new Error(`cut:${point}`); } } }), new RegExp(`cut:${point}`)); assert.equal(cut, true); assert.equal((await stat(join(item.runRoot, 'RUN-RECEIPT.json'))).isFile(), true); const resumed = await migrateRunBody(item.runRoot, { platform: syntheticPlatform }); assert.ok(['COMPLETED', 'ALREADY_COMPLETED'].includes(resumed.status)); assert.equal((await readdir(item.runRoot)).includes('.lunacy-body-migration.json'), false); assert.equal((await readdir(item.runRoot)).includes('.work'), false);
  });
});

test('cleanup refuses unresolved references, clean-commit identity, incomplete manifest, and post-receipt source drift before unlink', async (t) => {
  const unresolved = await publishedFixture(); t.after(() => rm(unresolved.root, { recursive: true, force: true })); await acceptAndSeal(unresolved, manifest(unresolved.root, ['README.md'])); await assert.rejects(() => migrateRunBody(unresolved.runRoot, { platform: syntheticPlatform }), /REFERENCE_UNRESOLVED/); for (const path of Object.keys(sourceFiles)) assert.equal((await stat(join(unresolved.runRoot, path))).isFile(), true);
  const commit = await publishedFixture({ references: false }); t.after(() => rm(commit.root, { recursive: true, force: true })); const oid = git(commit.root, ['rev-parse', 'HEAD']); await acceptAndSeal(commit, { kind: 'commit', root: commit.root, oid }); await assert.rejects(() => migrateRunBody(commit.runRoot, { platform: syntheticPlatform }), /RESULT_IDENTITY_INELIGIBLE/);
  const incomplete = await publishedFixture(); t.after(() => rm(incomplete.root, { recursive: true, force: true })); await writeFile(join(incomplete.root, 'README.md'), 'Reference cleared.\n'); await writeFile(join(incomplete.root, 'product.txt'), 'changed\n'); await acceptAndSeal(incomplete, manifest(incomplete.root, ['product.txt'])); await assert.rejects(() => migrateRunBody(incomplete.runRoot, { platform: syntheticPlatform }), /RESULT_MANIFEST_INCOMPLETE/);
  const drift = await publishedFixture({ references: false }); t.after(() => rm(drift.root, { recursive: true, force: true })); await acceptAndSeal(drift, manifest(drift.root, ['README.md'])); await chmod(join(drift.runRoot, Object.keys(sourceFiles)[0]), 0o600); await assert.rejects(() => migrateRunBody(drift.runRoot, { platform: syntheticPlatform }), /SOURCE_DRIFT/); assert.equal((await stat(join(drift.runRoot, Object.keys(sourceFiles)[1]))).isFile(), true);
});

test('Git restore reproduces marker aggregate after completed cleanup', async (t) => {
  const item = await publishedFixture(); t.after(() => rm(item.root, { recursive: true, force: true })); await writeFile(join(item.root, 'README.md'), 'Reference cleared.\n'); await acceptAndSeal(item, manifest(item.root, ['README.md'])); const marker = validateBodyMigrationMarker(item.marker); const completed = await migrateRunBody(item.runRoot, { platform: syntheticPlatform }); assert.equal(completed.status, 'COMPLETED');
  const tracked = marker.entries.map((entry) => `${relative(item.root, item.runRoot)}/${entry.relativePath}`); git(item.root, ['restore', '--', ...tracked]);
  const restored = []; for (const entry of marker.entries) { const path = join(item.runRoot, entry.relativePath); const value = await lstat(path); restored.push({ relativePath: entry.relativePath, mode: value.mode & 0o777, size: value.size, digest: digestBytes(await readFile(path)) }); }
  assert.deepEqual(restored, marker.entries.map(({ relativePath, mode, size, digest }) => ({ relativePath, mode, size, digest })));
});

test('migration tools require explicit CLI shape', async () => {
  const audit = spawnSync(process.execPath, ['tools/audit-run-artifacts.mjs'], { cwd: process.cwd(), encoding: 'utf8' }); assert.notEqual(audit.status, 0); assert.match(audit.stderr, /accepts only/);
  const migrate = spawnSync(process.execPath, ['tools/migrate-run-body.mjs', '--run-root', '/tmp'], { cwd: process.cwd(), encoding: 'utf8' }); assert.notEqual(migrate.status, 0); assert.match(migrate.stderr, /accepts only/);
});
