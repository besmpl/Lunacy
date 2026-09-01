import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { inspectRetentionRun, validateParentAcceptance } from '../dist/run-retention.js';

const repo = resolve('.'); const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = { kind: 'commit', root: repo, oid: 'a'.repeat(40) };
const acceptance = { schema: 'lunacy-parent-acceptance/v1', runId: 'run', disposition: 'ACCEPTED', activeWorkers: 'NONE', authorityDigest: '1'.repeat(64), outcomeDigest: '2'.repeat(64), terminalStateDigest: '3'.repeat(64), resultIdentity: identity, resultIdentityDigest: digest(identity) };
async function metadata(path, prefix = '') { const rows = []; for (const name of (await readdir(path)).sort()) { const full = join(path, name); const info = await stat(full); const relative = prefix ? `${prefix}/${name}` : name; rows.push({ path: relative, mode: info.mode, mtimeMs: info.mtimeMs, ino: String(info.ino), bytes: info.isFile() ? sha(await readFile(full)) : null }); if (info.isDirectory()) rows.push(...await metadata(full, relative)); } return rows; }
async function readyRun(parent) { const root = parent ? join(parent, 'run') : await mkdtemp(join(tmpdir(), 'lunacy-doctor-ready-')); if (parent) await mkdir(root); await mkdir(join(root, '.work')); await mkdir(join(root, '.kernel')); await mkdir(join(root, '.codex-effects')); await mkdir(join(root, 'phases/p1/reports'), { recursive: true }); await writeFile(join(root, 'PLAN.md'), '# Plan\n'); await writeFile(join(root, 'STATE.md'), '# State\n'); await writeFile(join(root, '.lunacy-parent-acceptance.json'), canonicalString(acceptance)); await writeFile(join(root, 'foreign.txt'), 'preserve'); return root; }

test('doctor is byte/mode/mtime/inode inert, deterministic, and protects every observed plane', async () => {
  const root = await readyRun(); const before = await metadata(root); const first = await inspectRetentionRun(root); const second = await inspectRetentionRun(root); assert.deepEqual(second, first); assert.equal(first.code, 'READY_TO_SEAL'); assert.deepEqual(await metadata(root), before);
  for (const path of [dirname(root), root, '.work', '.kernel', '.codex-effects', 'PLAN.md', 'STATE.md', '.lunacy-parent-acceptance.json', 'foreign.txt', 'phases']) assert.ok(first.protectedPaths.includes(path.startsWith('/') ? path : join(root, path)), path);
  assert.throws(() => validateParentAcceptance(first));
});

test('double census reports inconsistency and unsafe nodes fail closed without mutation', async () => {
  const root = await readyRun(); const changed = await inspectRetentionRun(root, { betweenCensuses: () => writeFile(join(root, 'arrived'), 'late') }); assert.equal(changed.code, 'INCONSISTENT_READ');
  const unsafe = await mkdtemp(join(tmpdir(), 'lunacy-doctor-unsafe-')); const fifo = join(unsafe, 'foreign-fifo'); const made = spawnSync('mkfifo', [fifo]); if (made.status === 0) { const before = await metadata(unsafe); const report = await inspectRetentionRun(unsafe); assert.equal(report.code, 'ATTENTION_UNSAFE_PATH'); assert.deepEqual(await metadata(unsafe), before); }
});

test('source and verified installed doctor agree; tamper and every mutation-shaped route refuse', async () => {
  const runParent = await mkdtemp(join(tmpdir(), 'lunacy-doctor-runs-')); const root = await readyRun(runParent); const target = await mkdtemp(join(tmpdir(), 'lunacy-doctor-installed-'));
  let invoked = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, '--retention-admission', 'OFF', '--retention-run-parent', runParent], { cwd: repo, encoding: 'utf8' }); assert.equal(invoked.status, 0, invoked.stderr);
  const source = spawnSync(process.execPath, ['tools/seal-run.mjs', '--doctor', '--run-root', root], { cwd: repo, encoding: 'utf8' }); const installed = spawnSync(process.execPath, [join(target, 'runtime/retention-launcher.mjs'), 'seal-run', '--doctor', '--run-root', root], { cwd: repo, encoding: 'utf8' }); assert.equal(source.status, 0, source.stderr); assert.equal(installed.status, 0, installed.stderr); assert.deepEqual(JSON.parse(installed.stdout), JSON.parse(source.stdout));
  const before = await metadata(root); for (const args of [['seal-run', '--accept', '--run-root', root], ['admit-body', '--run-root', root], ['seal-run', '--abandon', '--run-root', root]]) { invoked = spawnSync(process.execPath, [join(target, 'runtime/retention-launcher.mjs'), ...args], { cwd: repo, encoding: 'utf8' }); assert.notEqual(invoked.status, 0); } assert.deepEqual(await metadata(root), before);
  await chmod(join(target, 'runtime/dist/run-retention.js'), 0o600); await writeFile(join(target, 'runtime/dist/run-retention.js'), 'tampered'); invoked = spawnSync(process.execPath, [join(target, 'runtime/retention-launcher.mjs'), 'seal-run', '--doctor', '--run-root', root], { cwd: repo, encoding: 'utf8' }); assert.notEqual(invoked.status, 0); assert.match(invoked.stderr, /fingerprint|changed/);
});
