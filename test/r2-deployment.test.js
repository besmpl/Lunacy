import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
    // The generated release owns its exact runtime payload; the complete verified tree
    // also contains the one explicitly preserved operator sentinel above.
    assert.equal(report.managedFiles, 198);
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

test('R2 verified launcher carries coupled admission, writer, and sealer routes with exact policy parity', async () => {
  const repo = await sourceFixture(); const target = await mkdtemp(join(tmpdir(), 'lunacy-retention-r2-target-')); const runParent = await mkdtemp(join(tmpdir(), 'lunacy-retention-r2-runs-')); const runRoot = join(runParent, 'run-one'); await mkdir(runRoot);
  try {
    let result = runDeploy(repo, target, '--retention-admission', 'ON', '--retention-run-parent', runParent); assert.equal(result.status, 0, result.stderr);
    const launcher = join(target, 'runtime/retention-launcher.mjs'); result = spawnSync(process.execPath, [launcher, 'admit-body', '--run-root', runRoot], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'ADMITTED');
    result = spawnSync(process.execPath, [launcher, 'with-body-writer', '--run-root', runRoot, '--destination', 'raw.txt', '--', process.execPath, '-e', `process.stdout.write('raw')`], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.equal(await readFile(join(runRoot, '.work/raw.txt'), 'utf8'), 'raw');
    result = spawnSync(process.execPath, [join(target, 'runtime/tools/seal-run.mjs'), '--doctor', '--run-root', runRoot], { encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /direct installed retention tool invocation is forbidden/);
    for (const tool of ['audit-run-artifacts.mjs', 'migrate-run-body.mjs']) { result = spawnSync(process.execPath, [join(target, 'runtime/tools', tool), '--run-root', runRoot, ...(tool.startsWith('migrate') ? ['--accept'] : [])], { encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /direct installed retention tool invocation is forbidden/); }
    result = spawnSync(process.execPath, [launcher, 'with-body-writer', '--run-root', runRoot, '--destination', 'bypass.txt', '--', process.execPath, join(target, 'runtime/tools/seal-run.mjs'), '--doctor', '--run-root', runRoot], { encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /direct installed retention tool invocation is forbidden/);
    result = runDeploy(repo, target, '--check', '--retention-admission', 'OFF', '--retention-run-parent', runParent); assert.notEqual(result.status, 0); assert.match(result.stderr, /drift|fingerprint|retention-policy|canonical source/);
    result = runDeploy(repo, target, '--check', '--retention-admission', 'ON', '--retention-run-parent', runParent); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).retentionStateSchemas, ['BODY/lunacy-body/v1']);
    for (const relativePath of ['runtime/tools/audit-run-artifacts.mjs', 'runtime/tools/migrate-run-body.mjs', 'runtime/dist/run-body-migration.js']) { const path = join(target, relativePath); const bytes = await readFile(path); await writeFile(path, Buffer.concat([bytes, Buffer.from('x')])); result = spawnSync(process.execPath, [launcher, 'audit-run-artifacts', '--run-root', runRoot], { encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /fingerprint|changed/); await writeFile(path, bytes); }
    const secondRun = join(runParent, 'run-two'); await mkdir(secondRun); const deploy = spawn(process.execPath, ['tools/deploy-skill.mjs', '--target', target, '--retention-admission', 'OFF', '--retention-run-parent', runParent], { cwd: repo, encoding: 'utf8', env: { ...process.env, LUNACY_DEPLOY_TEST_HOLD_MS: '300' } }); let deployError = ''; deploy.stderr.on('data', (chunk) => { deployError += chunk; });
    for (let attempt = 0; attempt < 200; attempt += 1) { try { await readFile(join(target, '.lunacy-retention-admission.lock')); break; } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 5)); } }
    result = spawnSync(process.execPath, [launcher, 'admit-body', '--run-root', secondRun], { encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /admission is OFF/); const deployCode = await new Promise((resolvePromise) => deploy.once('exit', resolvePromise)); assert.equal(deployCode, 0, deployError); await rm(secondRun, { recursive: true, force: true });
    const helpers = join(target, 'runtime/retention-platform-helpers.json'); await writeFile(helpers, Buffer.concat([await readFile(helpers), Buffer.from('x')])); result = spawnSync(process.execPath, [launcher, 'seal-run', '--doctor', '--run-root', runRoot], { encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /fingerprint|changed|canonical/);
  } finally { await rm(repo, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); await rm(runParent, { recursive: true, force: true }); }
});

test('R4 verified launcher audits and copy-publishes one explicit temporary Git-backed run', async () => {
  const repo = await sourceFixture(); const target = await mkdtemp(join(tmpdir(), 'lunacy-retention-r4-target-')); const product = await mkdtemp(join(tmpdir(), 'lunacy-retention-r4-product-')); const runParent = join(product, 'Lunacy/runs'); const runRoot = join(runParent, 'pilot');
  try {
    spawnSync('/usr/bin/git', ['-C', product, 'init', '-q']); spawnSync('/usr/bin/git', ['-C', product, 'config', 'user.email', 'fixture@example.test']); spawnSync('/usr/bin/git', ['-C', product, 'config', 'user.name', 'fixture']); await mkdir(join(runRoot, 'phases/p1/evidence'), { recursive: true });
    for (const [path, bytes] of Object.entries({ 'PLAN.md': '# Plan\n', 'STATE.md': '# State\nStatus: COMPLETE\nGate barrier: CLOSED\n', 'OUTCOME.md': '# Outcome\n', 'phases/p1/STEPS.md': '# Steps\n', 'phases/p1/evidence/log.md': 'proof\n' })) await writeFile(join(runRoot, path), bytes);
    assert.equal(spawnSync('/usr/bin/git', ['-C', product, 'add', '.']).status, 0); assert.equal(spawnSync('/usr/bin/git', ['-C', product, 'commit', '-qm', 'fixture']).status, 0);
    let result = runDeploy(repo, target, '--retention-admission', 'OFF', '--retention-run-parent', runParent); assert.equal(result.status, 0, result.stderr); const launcher = join(target, 'runtime/retention-launcher.mjs');
    result = spawnSync(process.execPath, [launcher, 'audit-run-artifacts', '--run-root', runRoot], { cwd: product, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).eligible, true);
    result = spawnSync(process.execPath, [launcher, 'migrate-run-body', '--run-root', runRoot, '--accept'], { cwd: product, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'BODY_PUBLISHED'); assert.equal((await readdir(runRoot)).includes('.lunacy-body-migration.json'), true); assert.equal(await readFile(join(runRoot, 'phases/p1/evidence/log.md'), 'utf8'), 'proof\n');
  } finally { await rm(repo, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); await rm(product, { recursive: true, force: true }); }
});

test('R2 deployment requires an explicit bounded run-parent census and recognizes migration recovery state', async () => {
  const repo = await sourceFixture(); const target = await mkdtemp(join(tmpdir(), 'lunacy-retention-census-target-')); const runParent = await mkdtemp(join(tmpdir(), 'lunacy-retention-census-runs-')); const runRoot = join(runParent, 'run'); await mkdir(runRoot); await mkdir(join(runRoot, '.work'));
  try {
    let result = runDeploy(repo, target, '--retention-admission', 'OFF'); assert.notEqual(result.status, 0); assert.match(result.stderr, /retention-run-parent is required/);
    result = runDeploy(repo, target, '--retention-admission', 'OFF', '--retention-run-parent', runParent); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).retentionStateSchemas, ['BODY/lunacy-body/v1']);
    await mkdir(join(runRoot, '.work.migrate-tmp')); const stage = `.lunacy-body-migration.json.stage-${'a'.repeat(64)}`; await writeFile(join(runRoot, stage), '{"schema":');
    result = runDeploy(repo, target, '--check', '--retention-admission', 'OFF', '--retention-run-parent', runParent); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).retentionStateSchemas, ['BODY/lunacy-body/v1', 'MIGRATION_MARKER_STAGE/lunacy-body-migration/v1', 'MIGRATION_TEMP/lunacy-body-migration/v1']);
    await writeFile(join(runRoot, '.lunacy-body-migration.json'), '{"schema":"lunacy-body-migration/v1"}\n'); result = runDeploy(repo, target, '--check', '--retention-admission', 'OFF', '--retention-run-parent', runParent); assert.notEqual(result.status, 0); assert.match(result.stderr, /stage collides with final marker/); assert.equal(await readFile(join(runRoot, stage), 'utf8'), '{"schema":');
    await rm(join(runRoot, stage)); result = runDeploy(repo, target, '--check', '--retention-admission', 'OFF', '--retention-run-parent', runParent); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).retentionStateSchemas, ['.lunacy-body-migration.json/lunacy-body-migration/v1', 'BODY/lunacy-body/v1', 'MIGRATION_TEMP/lunacy-body-migration/v1']); const foreign = '.lunacy-body-migration.json.stage-foreign'; await writeFile(join(runRoot, foreign), 'foreign'); result = runDeploy(repo, target, '--check', '--retention-admission', 'OFF', '--retention-run-parent', runParent); assert.notEqual(result.status, 0); assert.match(result.stderr, /non-managed migration marker stage/); assert.equal(await readFile(join(runRoot, foreign), 'utf8'), 'foreign');
  } finally { await rm(repo, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); await rm(runParent, { recursive: true, force: true }); }
});
