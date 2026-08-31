import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFixture() {
  const repo = await mkdtemp(join(tmpdir(), 'lunacy-r2-deploy-repo-'));
  for (const name of ['dist', 'docs', 'schemas', 'tools']) await cp(join(root, name), join(repo, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) await cp(join(root, name), join(repo, name));
  return repo;
}

function runDeploy(repo, target, ...args) {
  return spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, ...args], { cwd: repo, encoding: 'utf8' });
}

function crashDeploy(repo, target, window) {
  return spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, LUNACY_DEPLOY_CRASH_WINDOW: window },
  });
}

test('R2 complete-tree publication removes owned stale files but preserves unrelated runtime files', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r2-stale-target-'));
  try {
    let result = runDeploy(repo, target);
    assert.equal(result.status, 0, result.stderr);
    await writeFile(join(target, 'runtime', 'dist', 'stale-extra.js'), 'stale');
    await writeFile(join(target, 'runtime', 'operator-sentinel'), 'keep me');
    result = runDeploy(repo, target);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(target, 'runtime', 'operator-sentinel'), 'utf8'), 'keep me');
    await assert.rejects(() => readFile(join(target, 'runtime', 'dist', 'stale-extra.js')));
    result = runDeploy(repo, target, '--check');
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    // The generated release owns 190 exact files; the complete verified tree
    // also contains the one explicitly preserved operator sentinel above.
    assert.equal(report.managedFiles, 179);
    assert.match(report.managedAggregate, /^[0-9a-f]{64}$/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('R2 crash windows recover a complete tree before the next publication', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r2-crash-target-'));
  const windows = ['marker-prepared', 'old-moved', 'marker-old-moved', 'new-moved', 'marker-published', 'verified'];
  try {
    let result = runDeploy(repo, target);
    assert.equal(result.status, 0, result.stderr);
    for (const window of windows) {
      result = crashDeploy(repo, target, window);
      assert.equal(result.status, 97, `${window}: ${result.stderr}`);
      // Recovery is performed before either --check or a subsequent deploy;
      // no stage, backup, or marker may remain visible after that fence.
      result = runDeploy(repo, target, '--check');
      assert.equal(result.status, 0, `${window}: ${result.stderr}`);
      const names = await readdir(target);
      assert.equal(names.some((name) => name.startsWith('.lunacy-runtime-')), false, `${window}: transaction residue`);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('R2 first-install crash after exchange removes only the uncommitted tree', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r2-first-crash-target-'));
  try {
    let result = crashDeploy(repo, target, 'new-moved');
    assert.equal(result.status, 97, result.stderr);
    result = runDeploy(repo, target, '--check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed runtime is absent/);
    const names = await readdir(target);
    assert.equal(names.some((name) => name.startsWith('.lunacy-runtime-')), false);
    result = runDeploy(repo, target);
    assert.equal(result.status, 0, result.stderr);
    result = runDeploy(repo, target, '--check');
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('R2 rejects a malformed transaction identity before constructing a sibling path', async () => {
  const repo = await sourceFixture();
  const container = await mkdtemp(join(tmpdir(), 'lunacy-r2-identity-container-'));
  const target = join(container, 'target');
  const escaped = join(container, 'escaped-runtime');
  await mkdir(target, { mode: 0o700 });
  try {
    let result = runDeploy(repo, target);
    assert.equal(result.status, 0, result.stderr);
    result = crashDeploy(repo, target, 'old-moved');
    assert.equal(result.status, 97, result.stderr);

    const markerPath = join(target, '.lunacy-runtime-deploy.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    marker.id = '../../../escaped-runtime';
    // The generated marker is canonical and id is replaced in-place, so this
    // remains a deterministic canonical-byte mutation for the recovery fence.
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, 'utf8');
    result = runDeploy(repo, target, '--check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /deployment transaction id is unsafe/);
    assert.equal((await readdir(container)).includes('escaped-runtime'), false);
    assert.equal((await readdir(target)).includes('.lunacy-runtime-deploy.json'), true);
    assert.equal((await readdir(target)).some((name) => name.startsWith('.lunacy-runtime-stage-')), true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(container, { recursive: true, force: true });
  }
});

test('R4 managed wrapper carries and resolves the private recovery route', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r4-managed-target-'));
  try {
    const deployed = runDeploy(repo, target);
    assert.equal(deployed.status, 0, deployed.stderr);
    const bridge = join(target, 'runtime', 'bridge.mjs');
    const result = spawnSync(process.execPath, [bridge, 'inspect-recovery', '--help'], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /inspect-recovery/);
    assert.equal(result.stderr, '');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
