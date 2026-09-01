import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compare = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

async function sourceFixture() {
  const repo = await mkdtemp(join(tmpdir(), 'lunacy-r5b-repo-'));
  await mkdir(join(repo, 'dist'), { recursive: true });
  await mkdir(join(repo, 'docs'), { recursive: true });
  await mkdir(join(repo, 'schemas'), { recursive: true });
  await mkdir(join(repo, 'tools'), { recursive: true });
  await writeFile(join(repo, 'dist', 'bridge-cli.js'), 'export function runBridgeCli() { return 0; }\n');
  // The deployment manager imports this trust helper from ../dist; keep the
  // fixture otherwise tiny so the crash matrix does not serialize 130 files.
  for (const name of ['canonical.js', 'filesystem.js', 'release-admission.js']) {
    await cp(join(root, 'dist', name), join(repo, 'dist', name));
  }
  await cp(join(root, 'tools', 'deploy-skill.mjs'), join(repo, 'tools', 'deploy-skill.mjs'));
  await cp(join(root, 'tools', 'retention-launcher.mjs'), join(repo, 'tools', 'retention-launcher.mjs'));
  await cp(join(root, 'tools', 'seal-run.mjs'), join(repo, 'tools', 'seal-run.mjs'));
  await cp(join(root, 'tools', 'with-body-writer.mjs'), join(repo, 'tools', 'with-body-writer.mjs'));
  await cp(join(root, 'tools', 'audit-run-artifacts.mjs'), join(repo, 'tools', 'audit-run-artifacts.mjs'));
  await cp(join(root, 'tools', 'migrate-run-body.mjs'), join(repo, 'tools', 'migrate-run-body.mjs'));
  for (const name of ['BRIDGE.md', 'BEADS.md', 'WORKFRONT.md', 'CODEX_EXEC.md']) await writeFile(join(repo, 'docs', name), `# ${name}\n`);
  for (const name of ['codex-worker-result.schema.json', 'codex-launch-intent-record.schema.json', 'codex-launch-record.schema.json', 'codex-terminal-record.schema.json']) await writeFile(join(repo, 'schemas', name), '{"type":"object"}\n');
  await writeFile(join(repo, 'tools', 'probe-codex-exec.mjs'), 'export {};\n');
  await writeFile(join(repo, 'tools', 'bind-release-process-snapshot.mjs'), 'export {};\n');
  await writeFile(join(repo, 'tools', 'verify-release-quiescence.mjs'), 'export {};\n');
  await cp(join(root, 'package.json'), join(repo, 'package.json'));
  return repo;
}

function run(repo, target, args = [], env = {}) {
  return spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runAsync(repo, target, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['tools/deploy-skill.mjs', '--target', target, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function waitForPath(path, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function runtimeFiles(runtime) {
  const files = [];
  async function visit(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      const relative = `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, relative);
      else {
        assert.equal(entry.isSymbolicLink(), false, `rollback payload is not a symlink: ${relative}`);
        files.push({ path: relative, digest: hash(await readFile(path)) });
      }
    }
  }
  await visit(runtime, 'runtime');
  return files.sort((a, b) => compare(a.path, b.path));
}

/** Build a disposable, self-attested 0.2.12 payload from the current release. */
async function makeRollbackBundle(repo, bundle) {
  const sourceTarget = await mkdtemp(join(tmpdir(), 'lunacy-r5b-source-target-'));
  const runtime = join(bundle, 'runtime');
  await mkdir(bundle, { recursive: true });
  const deployed = run(repo, sourceTarget);
  assert.equal(deployed.status, 0, deployed.stderr);
  await cp(join(sourceTarget, 'runtime'), runtime, { recursive: true });
  const packagePath = join(runtime, 'package.json');
  const packageValue = JSON.parse(await readFile(packagePath, 'utf8'));
  packageValue.version = '0.2.12';
  await writeFile(packagePath, `${canonical(packageValue)}\n`);
  let launcher = (await readFile(join(runtime, 'bridge.mjs'), 'utf8')).replace('const EXPECTED_RUNTIME_VERSION = "0.3.0";', 'const EXPECTED_RUNTIME_VERSION = "0.2.12";');
  const manifestPath = join(runtime, 'DEPLOYMENT.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.runtimeVersion = '0.2.12';
  manifest.bridgeVersion = '0.1.0';
  const sourceRecords = [];
  for (const path of manifest.files) sourceRecords.push({ path, digest: hash(await readFile(join(bundle, path))) });
  manifest.sourceDigest = hash(Buffer.from(sourceRecords.map((record) => `${record.path}\0${record.digest}`).join('\n')));
  const normalize = (source) => {
    let value = source;
    for (const [name, marker] of [['MANIFEST', '__LUNACY_MANIFEST_DIGEST__'], ['LAUNCHER', '__LUNACY_LAUNCHER_DIGEST__']]) {
      value = value.replace(new RegExp(`(^const EXPECTED_${name}_DIGEST = \")([0-9a-f]{64})(\";)$`, 'm'), `$1${marker}$3`);
    }
    return Buffer.from(value);
  };
  manifest.launcherDigest = hash(normalize(launcher));
  let manifestBytes = Buffer.from(`${canonical(manifest)}\n`);
  const manifestDigest = hash(manifestBytes);
  launcher = launcher
    .replace(/(^const EXPECTED_MANIFEST_DIGEST = ")[0-9a-f]{64}(";$)/m, `$1${manifestDigest}$2`)
    .replace(/(^const EXPECTED_LAUNCHER_DIGEST = ")[0-9a-f]{64}(";$)/m, `$1${manifest.launcherDigest}$2`);
  await writeFile(join(runtime, 'bridge.mjs'), launcher);
  await writeFile(manifestPath, manifestBytes);
  const files = await runtimeFiles(runtime);
  const aggregate = hash(Buffer.from(files.map((record) => `${record.path}\0${record.digest}`).join('\n')));
  const inventory = {
    schema: 1,
    bridgeVersion: '0.1.0',
    runtimeVersion: '0.2.12',
    manifestDigest,
    launcherDigest: manifest.launcherDigest,
    aggregate,
    files,
  };
  await writeFile(join(bundle, 'inventory.json'), `${canonical(inventory)}\n`);
  await rm(sourceTarget, { recursive: true, force: true });
  return { payload: runtime, inventory: join(bundle, 'inventory.json'), aggregate };
}

test('R5-B publication and cleanup crash windows are restart-idempotent', async () => {
  const repo = await sourceFixture();
  const windows = [
    'stage-created', 'stage-verified', 'marker-prepared', 'old-moved',
    'marker-old-moved', 'new-moved', 'marker-published', 'verified', 'committed',
  ];
  try {
    for (const window of windows) {
      const target = await mkdtemp(join(tmpdir(), `lunacy-r5b-publish-${window}-`));
      try {
        let result = run(repo, target);
        assert.equal(result.status, 0, `${window}: initial deploy ${result.stderr}`);
        result = run(repo, target, [], { LUNACY_DEPLOY_CRASH_WINDOW: window });
        assert.equal(result.status, 97, `${window}: crash ${result.stderr}`);
        result = run(repo, target, ['--check']);
        assert.equal(result.status, 0, `${window}: recovery ${result.stderr}`);
        const names = await readdir(target);
        assert.deepEqual(names.filter((name) => name.startsWith('.lunacy-runtime-')), [], `${window}: transaction residue`);
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('R7-B no-marker recovery preserves foreign matching siblings', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r5b-orphan-target-'));
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  try {
    let result = run(repo, target);
    assert.equal(result.status, 0, result.stderr);
    const orphanStage = join(target, `.lunacy-runtime-stage-123-${uuid}`);
    const orphanTemp = join(target, `.lunacy-runtime-deploy.json.tmp-123-${uuid}`);
    await mkdir(orphanStage, { recursive: true });
    await writeFile(join(orphanStage, 'orphan'), 'orphan');
    await writeFile(orphanTemp, 'orphan marker temp');
    const ordinary = join(target, '.lunacy-runtime-stage-user-file');
    await writeFile(ordinary, 'preserve');
    result = run(repo, target, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(orphanStage, 'orphan'), 'utf8'), 'orphan');
    assert.equal(await readFile(orphanTemp, 'utf8'), 'orphan marker temp');
    assert.equal(await readFile(ordinary, 'utf8'), 'preserve');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('R5-B recovery crash boundaries are idempotent and leave no residue', async () => {
  const repo = await sourceFixture();
  const windows = [
    'recovery-runtime-to-failed-before', 'recovery-runtime-to-failed',
    'recovery-backup-to-runtime-before', 'recovery-backup-to-runtime',
    'recovery-restored-verified-before', 'recovery-restored-verified',
    'recovery-failed-deletion-before', 'recovery-failed-deletion',
    'recovery-stage-deletion-before', 'recovery-stage-deletion',
    'recovery-backup-deletion-before', 'recovery-backup-deletion',
    'recovery-marker-deletion-before', 'recovery-marker-deletion',
    'recovery-final-sync-before', 'recovery-final-sync',
  ];
  try {
    for (const window of windows) {
      const target = await mkdtemp(join(tmpdir(), `lunacy-r5b-recovery-${window}-`));
      try {
        let result = run(repo, target);
        assert.equal(result.status, 0, `${window}: initial deploy ${result.stderr}`);
        result = run(repo, target, [], { LUNACY_DEPLOY_CRASH_WINDOW: 'verified' });
        assert.equal(result.status, 97, `${window}: seed transaction ${result.stderr}`);
        result = run(repo, target, ['--check'], { LUNACY_DEPLOY_CRASH_WINDOW: window });
        assert.equal(result.status, 97, `${window}: injected recovery crash ${result.stderr}`);
        result = run(repo, target, ['--check']);
        assert.equal(result.status, 0, `${window}: retry recovery ${result.stderr}`);
        const names = await readdir(target);
        assert.deepEqual(names.filter((name) => name.startsWith('.lunacy-runtime-')), [], `${window}: transaction residue`);
      } finally {
        await rm(target, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('R5-B closed 0.2.12 restore preserves unowned files and rolls back on first red', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r5b-restore-target-'));
  const bundle = await mkdtemp(join(tmpdir(), 'lunacy-r5b-restore-bundle-'));
  try {
    const attestation = await makeRollbackBundle(repo, bundle);
    let result = run(repo, target);
    assert.equal(result.status, 0, result.stderr);
    const sentinel = join(target, 'runtime', 'operator-sentinel');
    const stale = join(target, 'runtime', 'dist', 'candidate-only-extra.js');
    await writeFile(sentinel, 'preserve me');
    await writeFile(stale, 'remove me');
    result = run(repo, target, ['--restore', '--payload', attestation.payload, '--inventory', attestation.inventory, '--aggregate', attestation.aggregate], { LUNACY_DEPLOY_CRASH_WINDOW: 'verified' });
    assert.equal(result.status, 97, result.stderr);
    result = run(repo, target, ['--check']);
    // The exact prior tree includes the deliberately injected candidate-owned
    // extra; it is removed by the successful 0.2.12 restore below.
    assert.notEqual(result.status, 0, `first-red rollback must restore the exact prior tree: ${result.stderr}`);
    assert.equal(JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8')).runtimeVersion, '0.3.0');
    assert.equal(await readFile(stale, 'utf8'), 'remove me');
    result = run(repo, target, ['--restore', '--payload', attestation.payload, '--inventory', attestation.inventory, '--aggregate', attestation.aggregate]);
    assert.equal(result.status, 0, result.stderr);
    const restored = JSON.parse(result.stdout);
    assert.equal(restored.status, 'restored');
    assert.equal(restored.runtimeVersion, '0.2.12');
    assert.equal(restored.rollbackAggregate, attestation.aggregate);
    assert.equal(JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8')).runtimeVersion, '0.2.12');
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve me');
    await assert.rejects(() => readFile(stale));
    result = run(repo, target);
    assert.equal(result.status, 0, `identical 0.3.0 redeploy: ${result.stderr}`);
    result = run(repo, target, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve me');
    const names = await readdir(target);
    assert.deepEqual(names.filter((name) => name.startsWith('.lunacy-runtime-')), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(bundle, { recursive: true, force: true });
  }
});

test('R5-B restore rejects incomplete or extra mutable inputs before publication', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r5b-closed-target-'));
  const bundle = await mkdtemp(join(tmpdir(), 'lunacy-r5b-closed-bundle-'));
  try {
    const attestation = await makeRollbackBundle(repo, bundle);
    let result = run(repo, target);
    assert.equal(result.status, 0, result.stderr);
    const currentManifest = JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8'));

    result = run(repo, target, ['--restore', '--payload', attestation.payload, '--inventory', attestation.inventory]);
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8')), currentManifest);

    const malformedInventory = join(bundle, 'malformed-inventory.json');
    const descriptor = JSON.parse(await readFile(attestation.inventory, 'utf8'));
    descriptor.operatorField = 'must reject';
    await writeFile(malformedInventory, `${canonical(descriptor)}\n`);
    result = run(repo, target, ['--restore', '--payload', attestation.payload, '--inventory', malformedInventory, '--aggregate', attestation.aggregate]);
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8')), currentManifest);

    await writeFile(join(attestation.payload, 'mutable-extra.js'), 'not attested');
    result = run(repo, target, ['--restore', '--payload', attestation.payload, '--inventory', attestation.inventory, '--aggregate', attestation.aggregate]);
    assert.notEqual(result.status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8')), currentManifest);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(bundle, { recursive: true, force: true });
  }
});

test('R7-B target ownership rejects overlapping deploy and check operations', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r7b-lock-target-'));
  try {
    const first = runAsync(repo, target, [], { LUNACY_DEPLOY_TEST_HOLD_MS: '500' });
    await waitForPath(join(target, '.lunacy-runtime-deploy.lock'));
    const second = run(repo, target, ['--check']);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /deployment target is busy/);
    const completed = await first;
    assert.equal(completed.status, 0, completed.stderr);
    const checked = run(repo, target, ['--check']);
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('R7-B target ownership serializes deploy/deploy, check/deploy, and restore/deploy', async () => {
  const repo = await sourceFixture();
  const bundle = await mkdtemp(join(tmpdir(), 'lunacy-r7b-overlap-bundle-'));
  try {
    const overlap = async (target, firstArgs, secondArgs) => {
      const first = runAsync(repo, target, firstArgs, { LUNACY_DEPLOY_TEST_HOLD_MS: '500' });
      await waitForPath(join(target, '.lunacy-runtime-deploy.lock'));
      const second = run(repo, target, secondArgs);
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /deployment target is busy/);
      const completed = await first;
      assert.equal(completed.status, 0, completed.stderr);
    };

    const deployTarget = await mkdtemp(join(tmpdir(), 'lunacy-r7b-overlap-deploy-'));
    const checkTarget = await mkdtemp(join(tmpdir(), 'lunacy-r7b-overlap-check-'));
    const restoreTarget = await mkdtemp(join(tmpdir(), 'lunacy-r7b-overlap-restore-'));
    try {
      let result = run(repo, deployTarget);
      assert.equal(result.status, 0, result.stderr);
      await overlap(deployTarget, [], []);

      result = run(repo, checkTarget);
      assert.equal(result.status, 0, result.stderr);
      await overlap(checkTarget, ['--check'], []);

      const rollback = await makeRollbackBundle(repo, bundle);
      result = run(repo, restoreTarget);
      assert.equal(result.status, 0, result.stderr);
      await overlap(restoreTarget, ['--restore', '--payload', rollback.payload, '--inventory', rollback.inventory, '--aggregate', rollback.aggregate], []);
    } finally {
      await rm(deployTarget, { recursive: true, force: true });
      await rm(checkTarget, { recursive: true, force: true });
      await rm(restoreTarget, { recursive: true, force: true });
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(bundle, { recursive: true, force: true });
  }
});

test('R7-B interrupted owner is reclaimed only when dead and live owner fails closed', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r7b-owner-target-'));
  const lock = join(target, '.lunacy-runtime-deploy.lock');
  const ownerId = '550e8400-e29b-41d4-a716-446655440000';
  const lockBytes = (pid) => `${canonical({ id: ownerId, pid, schema: 1, startedAt: Date.now() })}\n`;
  try {
    let result = run(repo, target);
    assert.equal(result.status, 0, result.stderr);

    // A well-formed lock left by a terminated owner is reclaimable after the
    // inode is rechecked; --check then proceeds and removes the exact name.
    const interruptedOwner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    await new Promise((resolve, reject) => {
      interruptedOwner.once('spawn', resolve);
      interruptedOwner.once('error', reject);
    });
    const deadPid = interruptedOwner.pid;
    interruptedOwner.kill('SIGKILL');
    await new Promise((resolve) => interruptedOwner.once('close', resolve));
    await writeFile(lock, lockBytes(deadPid), { mode: 0o600 });
    result = run(repo, target, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(() => access(lock));

    // A lock naming this test process is a live owner even though it is not a
    // child deploy process.  Recovery must fail closed and leave the lock.
    const liveLockBytes = lockBytes(process.pid);
    await writeFile(lock, liveLockBytes, { mode: 0o600 });
    result = run(repo, target, ['--check']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /deployment target is busy/);
    assert.equal(await readFile(lock, 'utf8'), liveLockBytes);
    await rm(lock, { force: true });
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('R7-B final fence rejects an unowned mutation and leaves it intact', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r7b-fence-target-'));
  try {
    let result = run(repo, target);
    assert.equal(result.status, 0, result.stderr);
    const sentinel = join(target, 'runtime', 'operator-sentinel');
    await writeFile(sentinel, 'before');
    const child = runAsync(repo, target, [], { LUNACY_DEPLOY_TEST_DELAY_BEFORE_PRESERVED_FENCE_MS: '300' });
    const namesStarted = Date.now();
    let stage;
    while (Date.now() - namesStarted < 5000 && !stage) {
      const names = await readdir(target);
      stage = names.find((name) => name.startsWith('.lunacy-runtime-stage-'));
      if (!stage) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(stage, 'deployment stage did not appear');
    await writeFile(sentinel, 'mutated');
    result = await child;
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(await readFile(sentinel, 'utf8'), 'mutated');
    const names = await readdir(target);
    assert.deepEqual(names.filter((name) => name.startsWith('.lunacy-runtime-')), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('R7-B damaged candidate recovers exact backup without candidate equality', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r7b-damaged-target-'));
  try {
    let result = run(repo, target);
    assert.equal(result.status, 0, result.stderr);
    result = run(repo, target, [], { LUNACY_DEPLOY_CRASH_WINDOW: 'new-moved' });
    assert.equal(result.status, 97, result.stderr);
    await writeFile(join(target, 'runtime', 'dist', 'bridge-cli.js'), 'truncated\n');
    result = run(repo, target, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8'));
    assert.equal(manifest.runtimeVersion, '0.3.0');
    const names = await readdir(target);
    assert.deepEqual(names.filter((name) => name.startsWith('.lunacy-runtime-')), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('R7-B nested stage directory creation crash recovers without residue', async () => {
  const repo = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-r7b-nested-target-'));
  try {
    let result = run(repo, target);
    assert.equal(result.status, 0, result.stderr);
    result = run(repo, target, [], { LUNACY_DEPLOY_CRASH_WINDOW: 'stage-directory-created' });
    assert.equal(result.status, 97, result.stderr);
    result = run(repo, target, ['--check']);
    assert.equal(result.status, 0, result.stderr);
    const names = await readdir(target);
    assert.deepEqual(names.filter((name) => name.startsWith('.lunacy-runtime-')), []);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
