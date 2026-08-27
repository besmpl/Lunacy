import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalString } from '../dist/canonical.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function recomputeSelfDescribedManifest(target) {
  const manifestPath = join(target, 'runtime', 'DEPLOYMENT.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const records = [];
  for (const item of manifest.files) records.push({ path: item, digest: hash(await readFile(join(target, item))) });
  manifest.sourceDigest = hash(Buffer.from(records.map((record) => `${record.path}\0${record.digest}`).join('\n')));
  await writeFile(manifestPath, `${canonicalString(manifest)}\n`, 'utf8');
}

function runWrapper(target) {
  return spawnSync(process.execPath, [join(target, 'runtime', 'bridge.mjs'), '--help'], { encoding: 'utf8' });
}

test('managed launcher rejects a tampered tree even when its mutable manifest is recomputed', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-deploy-adversary-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: root, stdio: 'pipe' });
  const bridgeCli = join(target, 'runtime', 'dist', 'bridge-cli.js');
  await writeFile(bridgeCli, `${await readFile(bridgeCli, 'utf8')}\n// attacker mutation\n`, 'utf8');
  await recomputeSelfDescribedManifest(target);
  const result = runWrapper(target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trusted release|fingerprint/);
});

test('managed launcher rejects tampering with its own executable provenance', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-deploy-launcher-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: root, stdio: 'pipe' });
  const launcher = join(target, 'runtime', 'bridge.mjs');
  await writeFile(launcher, `${await readFile(launcher, 'utf8')}\n// launcher mutation\n`, 'utf8');
  const result = runWrapper(target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trusted release|fingerprint/);
});

test('managed launcher uses its attested absolute Node image instead of ambient PATH', { skip: process.platform === 'win32' }, async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-deploy-node-path-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: root, stdio: 'pipe' });
  const launcher = join(target, 'runtime', 'bridge.mjs');
  const firstLine = (await readFile(launcher, 'utf8')).split('\n', 1)[0];
  assert.match(firstLine, /^#!\//);
  assert.notEqual(firstLine, '#!/usr/bin/env node');
  await chmod(launcher, 0o755);

  // If the launcher used an env-based shebang, this executable would run and
  // leave a marker. An absolute shebang must bypass this ambient PATH entry.
  const fakeBin = await mkdtemp(join(tmpdir(), 'lunacy-deploy-fake-node-'));
  const marker = join(fakeBin, 'used');
  await writeFile(join(fakeBin, 'node'), `#!/bin/sh\nprintf used > ${JSON.stringify(marker)}\nexit 97\n`, 'utf8');
  await chmod(join(fakeBin, 'node'), 0o755);
  const result = spawnSync(launcher, ['--help'], { cwd: target, env: { ...process.env, PATH: fakeBin }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(marker).catch(() => undefined)), undefined);
});

test('managed launcher rejects a symlinked runtime module outside the deployed physical tree', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-deploy-containment-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: root, stdio: 'pipe' });
  const outside = await mkdtemp(join(tmpdir(), 'lunacy-deploy-outside-'));
  const bridgeCli = join(target, 'runtime', 'dist', 'bridge-cli.js');
  const original = await readFile(bridgeCli);
  const outsideFile = join(outside, 'bridge-cli.js');
  await writeFile(outsideFile, original);
  // Keep the manifest's trusted expected digest unchanged; only redirect the
  // mutable module pathname.  O_NOFOLLOW plus physical containment must fail.
  await writeFile(bridgeCli, original);
  const moved = join(target, 'runtime', 'dist', 'bridge-cli.original.js');
  execFileSync(process.execPath, ['-e', `require('node:fs').renameSync(${JSON.stringify(bridgeCli)}, ${JSON.stringify(moved)}); require('node:fs').symlinkSync(${JSON.stringify(outsideFile)}, ${JSON.stringify(bridgeCli)})`]);
  const result = runWrapper(target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink|physical|trusted|fingerprint/);
});

test('managed release carries the private Codex schemas and capability tooling', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-deploy-codex-payload-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: root, stdio: 'pipe' });
  const manifest = JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8'));
  const expected = [
    'runtime/CODEX_EXEC.md',
    'runtime/schemas/codex-launch-intent-record.schema.json',
    'runtime/schemas/codex-launch-record.schema.json',
    'runtime/schemas/codex-terminal-record.schema.json',
    'runtime/schemas/codex-worker-result.schema.json',
    'runtime/tools/probe-codex-exec.mjs',
    'runtime/tools/verify-release-quiescence.mjs',
  ];
  for (const path of expected) {
    assert.ok(manifest.files.includes(path), `manifest includes ${path}`);
    assert.equal((await readFile(join(target, path))).byteLength > 0, true, `${path} is non-empty`);
  }
  const check = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /"status":"current"/);
});
