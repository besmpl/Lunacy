import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { currentReleaseOwner } from '../dist/release-admission.js';
import {
  RELEASE_OPERATION_ENVELOPE_MARKER,
  createReleaseOperationEnvelope,
  readReleaseOperationEnvelope,
  releaseOperationStatus,
  transitionReleaseOperationEnvelope,
  writeReleaseOperationEnvelope,
} from '../dist/release-operation.js';

const cleanup = [];
after(async () => Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e-envelope-')); cleanup.push(root);
  const target = join(root, 'target'); const discovery = join(root, 'discovery'); const evidence = await mkdtemp(join(tmpdir(), 'lunacy-r11e-evidence-')); cleanup.push(evidence);
  await mkdir(target); await mkdir(discovery);
  const manifest = { schema: 'lunacy-release-operation/v1', operation: 'deploy', installedTarget: target, discoveryParents: [discovery], runRoots: [], processSnapshotPath: join(evidence, 'snapshot-response.json') };
  const owner = { ...currentReleaseOwner(digest(manifest)), epoch: 0 };
  const envelope = createReleaseOperationEnvelope({ operation: 'deploy', manifest, manifestDigest: digest(manifest), targetIdentity: { pathDigest: digest(target), dev: String((await stat(target)).dev), ino: String((await stat(target)).ino) }, owner });
  return { root, target, manifest, envelope };
}

test('v2 envelope is closed, exact-name, resumable, and status is mutation-free', async () => {
  const item = await fixture();
  assert.equal((await readReleaseOperationEnvelope(item.target)).state, 'ABSENT');
  const published = await writeReleaseOperationEnvelope(item.target, item.envelope);
  assert.equal(published.state, 'VALID');
  const before = await readFile(join(item.target, RELEASE_OPERATION_ENVELOPE_MARKER));
  const status = await releaseOperationStatus({ target: item.target, manifest: item.manifest, manifestDigest: digest(item.manifest) });
  assert.deepEqual({ status: status.status, phase: status.phase, nextAction: status.nextAction }, { status: 'VALID', phase: 'prepared', nextAction: 'admit' });
  assert.deepEqual(await readFile(join(item.target, RELEASE_OPERATION_ENVELOPE_MARKER)), before);
  const admitted = await transitionReleaseOperationEnvelope(item.target, published, { ...item.envelope, phase: 'admitted' });
  assert.equal(admitted.envelope.phase, 'admitted');
  assert.equal((await releaseOperationStatus({ target: item.target, manifest: item.manifest, manifestDigest: digest(item.manifest) })).nextAction, 'quiesce');
});

test('tampered envelope and manifest bindings fail closed without mutation', async () => {
  const item = await fixture(); await writeReleaseOperationEnvelope(item.target, item.envelope);
  const marker = join(item.target, RELEASE_OPERATION_ENVELOPE_MARKER); const original = await readFile(marker);
  const tampered = JSON.parse(original); tampered.manifestDigest = 'f'.repeat(64); await (await import('node:fs/promises')).writeFile(marker, `${JSON.stringify(tampered)}\n`);
  const read = await readReleaseOperationEnvelope(item.target); assert.equal(read.state, 'MALFORMED');
  const status = await releaseOperationStatus({ target: item.target }); assert.equal(status.status, 'MALFORMED');
  assert.deepEqual(await readFile(marker), Buffer.from(`${JSON.stringify(tampered)}\n`));
});

test('phase CAS cannot retarget the operation or swap owners outside a stale prepared rebind', async () => {
  const item = await fixture();
  const published = await writeReleaseOperationEnvelope(item.target, item.envelope);
  const retargeted = {
    ...item.envelope,
    phase: 'admitted',
    installedTarget: { ...item.envelope.installedTarget, pathDigest: 'f'.repeat(64) },
  };
  await assert.rejects(
    () => transitionReleaseOperationEnvelope(item.target, published, retargeted),
    /transition identity changed/,
  );
  const foreignOwner = {
    ...item.envelope.owner,
    id: '22222222-2222-4222-8222-222222222222',
    epoch: item.envelope.owner.epoch,
  };
  await assert.rejects(
    () => transitionReleaseOperationEnvelope(item.target, published, { ...item.envelope, phase: 'admitted', owner: foreignOwner }),
    /owner identity changed outside prepared rebind/,
  );
  assert.equal((await readReleaseOperationEnvelope(item.target)).envelope.operationId, item.envelope.operationId);
});

test('committed envelopes require an attested inner aggregate', async () => {
  const item = await fixture();
  assert.throws(
    () => createReleaseOperationEnvelope({
      operation: item.envelope.operation,
      manifest: item.manifest,
      manifestDigest: digest(item.manifest),
      targetIdentity: item.envelope.installedTarget,
      owner: item.envelope.owner,
      phase: 'committed',
      status: 'COMMITTED',
    }),
    /committed phase lacks inner aggregate/,
  );
});

test('resume never creates a fresh envelope when the prior marker is absent', async () => {
  const item = await fixture();
  const manifestPath = join(item.root, 'release-manifest.json');
  await (await import('node:fs/promises')).writeFile(manifestPath, canonicalString(item.manifest));
  const result = spawnSync(process.execPath, [
    'tools/deploy-skill.mjs', '--target', item.target, '--resume-release', '--release-manifest', manifestPath,
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot resume release without an outer envelope/);
  assert.equal((await readReleaseOperationEnvelope(item.target)).state, 'ABSENT');
});

test('resume rejects a well-formed inner marker owned by another release', async () => {
  const item = await fixture();
  const deadOwner = {
    schema: 'lunacy-release-owner/v1',
    id: '33333333-3333-4333-8333-333333333333',
    pid: 99_999_999,
    processStartedAt: '1970-01-01T00:00:00.000Z',
    acquiredAt: '1970-01-01T00:00:00.000Z',
    manifestDigest: digest(item.manifest),
  };
  const envelope = createReleaseOperationEnvelope({
    operation: 'deploy', manifest: item.manifest, manifestDigest: digest(item.manifest),
    targetIdentity: item.envelope.installedTarget, owner: { ...deadOwner, epoch: 0 },
  });
  await writeReleaseOperationEnvelope(item.target, envelope);
  const markerId = '44444444-4444-4444-8444-444444444444';
  const markerDigest = (value) => createHash('sha256').update(value).digest('hex');
  const inventoryDigest = markerDigest(`runtime/README.md\0${'a'.repeat(64)}`);
  const emptyDigest = markerDigest('');
  const transaction = {
    schema: 1, id: markerId, target: 'runtime', phase: 'prepared', ownerPid: deadOwner.pid,
    ownerId: '55555555-5555-4555-8555-555555555555', tempName: `.lunacy-runtime-deploy.json.tmp-${markerId}`,
    stageName: `.lunacy-runtime-stage-${deadOwner.pid}-${markerId}`, backupName: null,
    failedName: `.lunacy-runtime-failed-${deadOwner.pid}-${markerId}`, recoveryPhase: null,
    inventory: [{ path: 'runtime/README.md', digest: 'a'.repeat(64) }], aggregate: inventoryDigest,
    previousInventory: [], previousAggregate: emptyDigest,
  };
  const transactionPath = join(item.target, '.lunacy-runtime-deploy.json');
  await writeFile(transactionPath, `${canonicalString(transaction)}\n`);
  const manifestPath = join(item.root, 'release-manifest.json');
  await writeFile(manifestPath, canonicalString(item.manifest));
  const result = spawnSync(process.execPath, [
    'tools/deploy-skill.mjs', '--target', item.target, '--resume-release', '--release-manifest', manifestPath,
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inner deployment transaction is not bound to the outer release owner/);
  assert.deepEqual(await readFile(transactionPath, 'utf8'), `${canonicalString(transaction)}\n`);
});

test('fresh release-envelope CLI creates and commits an outer envelope', async () => {
  const item = await fixture();
  const baseline = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', item.target], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(baseline.status, 0, baseline.stderr);
  const manifestPath = join(item.root, 'release-manifest.json');
  await writeFile(manifestPath, canonicalString(item.manifest));
  const child = spawn(process.execPath, [
    'tools/deploy-skill.mjs', '--target', item.target, '--release-envelope', '--release-manifest', manifestPath,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let done = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolvePromise) => child.once('exit', (status, signal) => { done = true; resolvePromise({ status, signal }); }));

  const ownerPath = join(item.manifest.discoveryParents[0], '.lunacy-release-exclusion.lock');
  const expectedManifestDigest = digest(item.manifest);
  const deadline = Date.now() + 10_000;
  let owner;
  while (!done && !owner) {
    try {
      const observed = JSON.parse(await readFile(ownerPath, 'utf8'));
      if (observed.manifestDigest === expectedManifestDigest) owner = observed;
    } catch { /* the envelope owner is still being acquired */ }
    if (!owner) {
      if (Date.now() >= deadline) { child.kill('SIGKILL'); break; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  if (!done) {
    const sourcePath = join(item.root, 'raw-snapshot.json');
    await writeFile(sourcePath, canonicalString({ schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [] }));
    const bound = spawnSync(process.execPath, ['tools/bind-release-process-snapshot.mjs', '--release-manifest', manifestPath, '--snapshot', sourcePath], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(bound.status, 0, bound.stderr);
    assert.equal(JSON.parse(bound.stdout).status, 'BOUND');
  }
  const result = await exited;
  assert.equal(result.status, 0, stderr);
  assert.equal(JSON.parse(stdout).status, 'deployed');
  const published = await readReleaseOperationEnvelope(item.target);
  assert.equal(published.state, 'VALID');
  assert.equal(published.envelope.phase, 'committed');
  assert.equal(published.envelope.status, 'COMMITTED');
  assert.equal(published.envelope.installedTarget.pathDigest, digest(item.target));
  assert.equal(published.envelope.snapshot?.pathDigest, digest(item.manifest.processSnapshotPath));
  assert.equal((await stat(join(item.target, 'runtime'))).isDirectory(), true);
});
