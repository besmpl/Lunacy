import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalString } from '../dist/canonical.js';
import { validateReleaseManifest } from '../dist/release-admission.js';

const repo = resolve('.');
const cleanup = [];
const compare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = (path) => stat(path).then(() => true, () => false);
const run = (target, args = [], env = {}) => spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });

let base; let discovery; let evidence; let candidate; let predecessor;

async function runtimeFiles(runtime) {
  const files = [];
  async function visit(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      const path = join(directory, entry.name); const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path, relative);
      else { assert.equal(entry.isSymbolicLink(), false); files.push({ path: relative, digest: sha(await readFile(path)) }); }
    }
  }
  await visit(runtime, 'runtime'); return files.sort((a, b) => compare(a.path, b.path));
}

async function writeInventory(bundle) {
  const runtime = join(bundle, 'runtime'); const deploymentBytes = await readFile(join(runtime, 'DEPLOYMENT.json')); const deployment = JSON.parse(deploymentBytes);
  const files = await runtimeFiles(runtime); const aggregate = sha(Buffer.from(files.map((record) => `${record.path}\0${record.digest}`).join('\n')));
  const descriptor = { schema: 1, runtimeVersion: deployment.runtimeVersion, bridgeVersion: deployment.bridgeVersion, manifestDigest: sha(deploymentBytes), launcherDigest: deployment.launcherDigest, files, aggregate };
  const inventoryBytes = Buffer.from(`${canonicalString(descriptor)}\n`); const inventory = join(bundle, 'inventory.json'); await writeFile(inventory, inventoryBytes);
  return Object.freeze({ payload: runtime, inventory, aggregate, identity: Object.freeze({ schema: 'lunacy-deployment-identity/v1', runtimeVersion: deployment.runtimeVersion, bridgeVersion: deployment.bridgeVersion, sourceDigest: deployment.sourceDigest, deploymentManifestDigest: descriptor.manifestDigest, launcherDigest: deployment.launcherDigest, inventoryDigest: sha(inventoryBytes), inventoryAggregate: aggregate, fileCount: files.length }) });
}

function normalizeLauncher(source) {
  let value = source;
  for (const [name, marker] of [['MANIFEST', '__LUNACY_MANIFEST_DIGEST__'], ['LAUNCHER', '__LUNACY_LAUNCHER_DIGEST__']]) value = value.replace(new RegExp(`(^const EXPECTED_${name}_DIGEST = ")([0-9a-f]{64})(";)$`, 'm'), `$1${marker}$3`);
  return Buffer.from(value);
}

async function makePredecessor(candidateBundle) {
  const bundle = join(base, 'predecessor'); await mkdir(bundle); await cp(candidateBundle.payload, join(bundle, 'runtime'), { recursive: true });
  const runtime = join(bundle, 'runtime'); const packagePath = join(runtime, 'package.json'); const packageValue = JSON.parse(await readFile(packagePath, 'utf8')); packageValue.version = '0.2.12'; await writeFile(packagePath, `${canonicalString(packageValue)}\n`);
  const manifestPath = join(runtime, 'DEPLOYMENT.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.runtimeVersion = '0.2.12'; manifest.bridgeVersion = '0.1.0';
  const sourceRecords = []; for (const path of manifest.files) sourceRecords.push({ path, digest: sha(await readFile(join(bundle, path))) });
  manifest.sourceDigest = sha(Buffer.from(sourceRecords.map((record) => `${record.path}\0${record.digest}`).join('\n')));
  let launcher = (await readFile(join(runtime, 'bridge.mjs'), 'utf8'))
    .replace('const EXPECTED_RUNTIME_VERSION = "0.3.0";', 'const EXPECTED_RUNTIME_VERSION = "0.2.12";')
    .replace('manifest.bridgeVersion !== "0.2.0"', 'manifest.bridgeVersion !== "0.1.0"')
    .replace(/(^const EXPECTED_SOURCE_DIGEST = ")[0-9a-f]{64}(";$)/m, `$1${manifest.sourceDigest}$2`);
  manifest.launcherDigest = sha(normalizeLauncher(launcher)); const manifestBytes = Buffer.from(`${canonicalString(manifest)}\n`); const manifestDigest = sha(manifestBytes);
  launcher = launcher.replace(/(^const EXPECTED_MANIFEST_DIGEST = ")[0-9a-f]{64}(";$)/m, `$1${manifestDigest}$2`).replace(/(^const EXPECTED_LAUNCHER_DIGEST = ")[0-9a-f]{64}(";$)/m, `$1${manifest.launcherDigest}$2`);
  await writeFile(join(runtime, 'bridge.mjs'), launcher); await writeFile(manifestPath, manifestBytes); return writeInventory(bundle);
}

function exactArgs(manifestPath) {
  return ['--exact-0.2.12-to-candidate', '--payload', predecessor.payload, '--inventory', predecessor.inventory, '--aggregate', predecessor.aggregate, '--candidate-payload', candidate.payload, '--candidate-inventory', candidate.inventory, '--candidate-aggregate', candidate.aggregate, '--release-manifest', manifestPath];
}

async function manifestFor(target, suffix) {
  const manifest = { schema: 'lunacy-release-operation/v2', operation: 'deploy-exact-0.2.12', installedTarget: target, discoveryParents: [discovery], runRoots: [], processSnapshotPath: join(evidence, `${suffix}-response.json`), installedDeployment: predecessor.identity, candidateDeployment: candidate.identity };
  const path = join(evidence, `${suffix}-manifest.json`); await writeFile(path, canonicalString(manifest)); return { manifest, path };
}

async function captureChild(target, manifestPath, snapshot, env = {}) {
  const child = spawn(process.execPath, ['tools/deploy-skill.mjs', '--target', target, ...exactArgs(manifestPath)], { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let done = false; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolveExit) => child.once('exit', (status, signal) => { done = true; resolveExit({ status, signal }); }));
  const marker = join(discovery, '.lunacy-release-exclusion.lock'); const expectedManifestDigest = sha(await readFile(manifestPath)); const deadline = Date.now() + 10_000;
  let expectedOwner = false;
  while (!done && !expectedOwner) {
    try { expectedOwner = JSON.parse(await readFile(marker, 'utf8')).manifestDigest === expectedManifestDigest; } catch { expectedOwner = false; }
    if (!expectedOwner) { if (Date.now() > deadline) throw new Error('release owner was not acquired'); await new Promise((resolveWait) => setTimeout(resolveWait, 5)); }
  }
  if (!done) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    if (!done) {
      const source = join(evidence, `raw-${Date.now()}-${Math.random()}.json`); await writeFile(source, canonicalString({ ...snapshot, capturedAt: new Date().toISOString() }));
      const bound = spawnSync(process.execPath, ['tools/bind-release-process-snapshot.mjs', '--release-manifest', manifestPath, '--snapshot', source], { cwd: repo, encoding: 'utf8' });
      if (bound.status !== 0) { child.kill('SIGKILL'); await exited; throw new Error(bound.stderr); }
    }
  }
  return { ...await exited, stdout, stderr };
}

async function prepareOldTarget(prefix) {
  const target = await mkdtemp(join(tmpdir(), prefix)); cleanup.push(target); let result = run(target); assert.equal(result.status, 0, result.stderr);
  result = run(target, ['--restore', '--payload', predecessor.payload, '--inventory', predecessor.inventory, '--aggregate', predecessor.aggregate]); assert.equal(result.status, 0, result.stderr); return target;
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'lunacy-r11d7-')); cleanup.push(base); discovery = join(base, 'runs'); evidence = join(base, 'evidence'); await mkdir(discovery); await mkdir(evidence);
  const sourceTarget = join(base, 'candidate-source'); await mkdir(sourceTarget); const deployed = run(sourceTarget); assert.equal(deployed.status, 0, deployed.stderr);
  const candidateBundle = join(base, 'candidate'); await mkdir(candidateBundle); await cp(join(sourceTarget, 'runtime'), join(candidateBundle, 'runtime'), { recursive: true }); candidate = await writeInventory(candidateBundle); predecessor = await makePredecessor(candidate);
});

after(async () => Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true }))));

test('v1 stays closed and v2 requires full exact identities with an empty root set', () => {
  const v1 = { schema: 'lunacy-release-operation/v1', operation: 'check', installedTarget: '/tmp/target', discoveryParents: ['/tmp/runs'], runRoots: [], processSnapshotPath: '/tmp/evidence/snapshot.json' };
  assert.equal(validateReleaseManifest(v1).schema, 'lunacy-release-operation/v1');
  const v2 = { ...v1, schema: 'lunacy-release-operation/v2', operation: 'deploy-exact-0.2.12', installedDeployment: predecessor.identity, candidateDeployment: candidate.identity };
  assert.equal(validateReleaseManifest(v2).operation, 'deploy-exact-0.2.12');
  const versionOnly = structuredClone(v2); delete versionOnly.installedDeployment.inventoryDigest; assert.throws(() => validateReleaseManifest(versionOnly), /fields are not closed/);
  assert.throws(() => validateReleaseManifest({ ...v2, runRoots: ['/tmp/runs/root'] }), /empty run-root set/);
});

test('exact predecessor deploy is repeatable from the same preserved candidate bytes across exact restore', async () => {
  const target = await prepareOldTarget('lunacy-r11d7-repeat-'); const empty = { schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [] };
  let item = await manifestFor(target, 'first'); let result = await captureChild(target, item.path, { ...empty, capturedAt: new Date().toISOString() }); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'deployed-exact-predecessor'); const first = await runtimeFiles(join(target, 'runtime'));
  result = run(target, ['--restore', '--payload', predecessor.payload, '--inventory', predecessor.inventory, '--aggregate', predecessor.aggregate]); assert.equal(result.status, 0, result.stderr);
  const runRoot = join(base, 'canonical-old-run'); const canonicalRun = spawnSync(process.execPath, [join(target, 'runtime/bridge.mjs'), '--run-dir', runRoot, '--run-id', 'example', '--mode', 'runtime', '--plan', join(repo, 'examples/canonical-plan.json'), '--event', join(repo, 'examples/canonical-event.json'), '--event-id', 'start'], { cwd: repo, encoding: 'utf8' }); assert.equal(canonicalRun.status, 0, canonicalRun.stderr);
  item = await manifestFor(target, 'second'); result = await captureChild(target, item.path, { ...empty, capturedAt: new Date().toISOString() }); assert.equal(result.status, 0, result.stderr); assert.deepEqual(await runtimeFiles(join(target, 'runtime')), first);
  assert.equal(sha(Buffer.from(first.map((record) => `${record.path}\0${record.digest}`).join('\n'))), candidate.aggregate);
});

test('payload drift, arbitrary installed bytes, and live target processes are red without publication', async () => {
  const target = await prepareOldTarget('lunacy-r11d7-red-'); let item = await manifestFor(target, 'live');
  let result = await captureChild(target, item.path, { schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [{ pid: 99101, ppid: 1, pgid: 99101, startedAt: new Date().toISOString(), executable: process.execPath, argv: [process.execPath, join(target, 'runtime/bridge.mjs'), 'drive'] }] });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /live installed-target process/); assert.equal(sha(Buffer.from((await runtimeFiles(join(target, 'runtime'))).map((record) => `${record.path}\0${record.digest}`).join('\n'))), predecessor.aggregate);
  await writeFile(join(target, 'runtime/README.md'), 'arbitrary old bytes'); item = await manifestFor(target, 'arbitrary-old'); result = await captureChild(target, item.path, { schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [] }); assert.notEqual(result.status, 0); assert.match(result.stderr, /managed file drift/);
  result = run(target, ['--restore', '--payload', predecessor.payload, '--inventory', predecessor.inventory, '--aggregate', predecessor.aggregate]); assert.equal(result.status, 0, result.stderr); const drift = join(candidate.payload, 'README.md'); const original = await readFile(drift); try { await writeFile(drift, 'candidate drift'); item = await manifestFor(target, 'candidate-drift'); result = await captureChild(target, item.path, { schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [] }); assert.notEqual(result.status, 0); assert.match(result.stderr, /does not match the attested inventory|managed file drift/); } finally { await writeFile(drift, original); }
});

test('preexisting managed discovery root is rejected before snapshot or deployment', async () => {
  const target = await prepareOldTarget('lunacy-r11d7-root-'); const root = join(discovery, 'late-root'); await mkdir(join(root, '.kernel'), { recursive: true }); await writeFile(join(root, '.kernel/CURRENT'), '{}');
  const item = await manifestFor(target, 'nonempty-root'); const result = run(target, exactArgs(item.path)); assert.notEqual(result.status, 0); assert.match(result.stderr, /discovered run-root set differs/); await rm(root, { recursive: true, force: true });
});

test('exact predecessor route reuses crash recovery and converges from exact old or candidate bytes', async () => {
  for (const [window, expectedAfterCrash] of [['stage-verified', predecessor.aggregate], ['marker-published', candidate.aggregate]]) {
    const target = await prepareOldTarget(`lunacy-r11d7-crash-${window}-`); let item = await manifestFor(target, `crash-${window}`);
    let result = await captureChild(target, item.path, { schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [] }, { LUNACY_DEPLOY_CRASH_WINDOW: window });
    assert.equal(result.status, 97, `${window}: ${result.stderr}`);
    const afterCrash = await runtimeFiles(join(target, 'runtime')); assert.equal(sha(Buffer.from(afterCrash.map((record) => `${record.path}\0${record.digest}`).join('\n'))), expectedAfterCrash);
    item = await manifestFor(target, `recover-${window}`); result = await captureChild(target, item.path, { schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [] }); assert.equal(result.status, 0, result.stderr);
    const recovered = await runtimeFiles(join(target, 'runtime')); assert.equal(sha(Buffer.from(recovered.map((record) => `${record.path}\0${record.digest}`).join('\n'))), candidate.aggregate);
    assert.deepEqual((await readdir(target)).filter((name) => name.startsWith('.lunacy-runtime-')), []);
  }
});

test('foreign well-formed stale transaction is untouched and blocks before recovery', async () => {
  const target = await prepareOldTarget('lunacy-r11d7-foreign-'); let item = await manifestFor(target, 'foreign-seed');
  let result = await captureChild(target, item.path, { schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [] }, { LUNACY_DEPLOY_CRASH_WINDOW: 'stage-verified' }); assert.equal(result.status, 97, result.stderr);
  const markerPath = join(target, '.lunacy-runtime-deploy.json'); const transaction = JSON.parse(await readFile(markerPath, 'utf8'));
  transaction.inventory[0].digest = transaction.inventory[0].digest === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
  transaction.aggregate = sha(Buffer.from(transaction.inventory.map((record) => `${record.path}\0${record.digest}`).join('\n')));
  const foreignBytes = Buffer.from(`${canonicalString(transaction)}\n`); await writeFile(markerPath, foreignBytes);
  const stagePath = join(target, transaction.stageName); const stageBefore = await runtimeFiles(stagePath);
  item = await manifestFor(target, 'foreign-retry'); result = await captureChild(target, item.path, { schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [] });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /stale deployment transaction is not bound/);
  assert.deepEqual(await readFile(markerPath), foreignBytes); assert.deepEqual(await runtimeFiles(stagePath), stageBefore);
  const old = await runtimeFiles(join(target, 'runtime')); assert.equal(sha(Buffer.from(old.map((record) => `${record.path}\0${record.digest}`).join('\n'))), predecessor.aggregate);
});
