import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { createCodexHostPolicy } from '../dist/codex-host-policy.js';
import { CodexExecDriver } from '../dist/codex-exec-driver.js';
import { drive } from '../dist/orchestration.js';
import { verifyReleaseQuiescence } from '../dist/release-quiescence.js';
import {
  RELEASE_EXCLUSION_LOCK, acquireOwnedFileClaim, currentReleaseOwner,
} from '../dist/release-admission.js';
import { withReleaseExclusion } from '../dist/release-operation.js';
import { FileArtifactStore } from '../dist/store.js';

const cleanup = [];
const sha = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const exists = async (path) => stat(path).then(() => true, () => false);

after(async () => { await Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true }))); });

async function directory(prefix) { const path = await mkdtemp(join(tmpdir(), prefix)); cleanup.push(path); return path; }

async function fixture({ managed = true, empty = false } = {}) {
  const discovery = await directory('lunacy-r11a2-discovery-');
  const target = await directory('lunacy-r11a2-target-');
  const evidence = await directory('lunacy-r11a2-evidence-');
  const roots = [];
  if (managed && !empty) {
    const root = join(discovery, 'run');
    await mkdir(join(root, '.kernel'), { recursive: true });
    await writeFile(join(root, '.kernel', 'CURRENT'), '{}');
    roots.push(root);
  }
  const manifest = Object.freeze({
    schema: 'lunacy-release-operation/v1', operation: 'deploy', installedTarget: target,
    discoveryParents: Object.freeze([discovery]), runRoots: Object.freeze(roots),
    processSnapshotPath: join(evidence, 'snapshot-response.json'),
  });
  return { discovery, target, evidence, roots, manifest, manifestDigest: sha(canonicalString(manifest)) };
}

function ownershipProof(ownership, targetClaim) {
  return {
    ownerBytes: ownership.ownerBytes,
    releaseClaimPaths: ownership.releaseClaims.map((claim) => claim.path),
    bridgeClaimPaths: ownership.bridgeClaims.map((claim) => claim.path),
    writerClaimPaths: ownership.writerClaims.map((claim) => claim.path),
    targetLock: targetClaim && { path: targetClaim.path, bytes: targetClaim.bytes },
  };
}

async function fileTree(root) {
  const out = [];
  async function visit(path, relative = '') {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(path, entry.name); const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { out.push(`d:${rel}`); await visit(child, rel); }
      else out.push(`f:${rel}:${sha(await readFile(child))}`);
    }
  }
  await visit(root); return out;
}

test('writer held before acquisition settles before release ownership', async () => {
  const item = await fixture(); const writer = join(item.roots[0], '.kernel', '.writer.lock');
  await writeFile(writer, canonicalString({ pid: process.pid, started: Date.now(), nonce: 'ordinary-writer' }));
  setTimeout(() => { void unlink(writer); }, 40);
  const started = Date.now();
  await withReleaseExclusion({ manifest: item.manifest, manifestDigest: item.manifestDigest, waitMs: 500 }, async () => undefined);
  assert.ok(Date.now() - started >= 25);
});

test('writer, drive, and newly created root cannot enter after release green', async () => {
  const item = await fixture(); let dispatches = 0;
  await withReleaseExclusion({ manifest: item.manifest, manifestDigest: item.manifestDigest }, async () => {
    await assert.rejects(() => new FileArtifactStore(item.roots[0]).load(), /ReleaseExclusion/);
    await assert.rejects(() => drive({
      runDir: item.roots[0], runId: 'excluded-drive', plan: { phaseId: 'p', steps: [{ stepId: 's' }] },
      driver: { dispatch() { dispatches += 1; throw new Error('must not spawn'); } }, maxTransitions: 2,
    }), /ReleaseExclusion/);
    const newRoot = join(item.discovery, 'new-root'); await mkdir(newRoot);
    await assert.rejects(() => new FileArtifactStore(newRoot).load(), /ReleaseExclusion/);
  });
  assert.equal(dispatches, 0);
});

test('explicit empty root set is sound and still excludes a new root under discovery', async () => {
  const item = await fixture({ managed: false, empty: true });
  await withReleaseExclusion({ manifest: item.manifest, manifestDigest: item.manifestDigest }, async () => {
    const newRoot = join(item.discovery, 'late'); await mkdir(newRoot);
    await assert.rejects(() => new FileArtifactStore(newRoot).load(), /ReleaseExclusion/);
  });
});

test('claim admitted before the fence remains red and verifier does not mutate bytes', async () => {
  const discovery = await directory('lunacy-r11a2-active-');
  const target = await directory('lunacy-r11a2-active-target-');
  const evidence = await directory('lunacy-r11a2-active-evidence-');
  const deployed = await import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: resolve('.'), encoding: 'utf8' }));
  assert.equal(deployed.status, 0, deployed.stderr);
  const root = join(discovery, 'run');
  await drive({
    runDir: root, runId: 'claimed-before-fence', plan: { phaseId: 'phase', steps: [{ stepId: 'only' }] },
    driver: { dispatch() { throw new Error('must not launch'); } }, maxTransitions: 1,
  });
  const currentPath = join(root, '.kernel', 'CURRENT'); const current = JSON.parse(await readFile(currentPath, 'utf8'));
  const statePath = join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')); const command = Object.values(state.outbox)[0]; command.state = 'CLAIMED';
  await writeFile(statePath, canonicalString(state)); await writeFile(currentPath, canonicalString({ ...current, stateDigest: digest(state) }));
  await mkdir(join(root, '.codex-effects', sha(command.launchToken)), { recursive: true });
  const manifest = { schema: 'lunacy-release-operation/v1', operation: 'deploy', installedTarget: target, discoveryParents: [discovery], runRoots: [root], processSnapshotPath: join(evidence, 'snapshot.json') };
  await withReleaseExclusion({ manifest, manifestDigest: sha(canonicalString(manifest)) }, async (ownership) => {
    const targetClaim = await acquireOwnedFileClaim(join(target, '.lunacy-runtime-deploy.lock'), ownership.owner, { waitMs: 100, label: 'target transaction' });
    try {
      const before = await fileTree(root);
      await assert.rejects(() => verifyReleaseQuiescence({
        installedTarget: target, runRoots: [root], processSnapshot: { schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [] }, releaseOwnership: ownershipProof(ownership, targetClaim),
      }), /CLAIMED|invalid/i);
      assert.deepEqual(await fileTree(root), before);
    } finally { await targetClaim.release(); }
  });
});

test('copied-child supervisor admission cannot cross an ancestor release claim', async () => {
  const item = await fixture();
  const root = item.roots[0]; const workspace = join(root, 'workspace'); const skillRoot = join(root, 'skill');
  await mkdir(join(workspace, '.git'), { recursive: true }); await mkdir(join(skillRoot, 'worker'), { recursive: true }); await mkdir(join(root, 'phases', 'p'), { recursive: true });
  await writeFile(join(root, 'schema.json'), '{}\n'); await writeFile(join(root, 'PLAN.md'), '# plan\n'); await writeFile(join(root, 'DECISIONS.md'), '# decisions\n'); await writeFile(join(root, 'phases/p/STEPS.md'), '# steps\n'); await writeFile(join(skillRoot, 'worker/ENGINEERING.md'), '# engineering\n');
  const policy = createCodexHostPolicy({ runId: 'driver-run', planDigest: 'a'.repeat(64), runRoot: root, workspace, skillRoot, codexPath: '/opt/homebrew/bin/codex', codexBinaryDigest: 'b'.repeat(64), workerSchemaPath: join(root, 'schema.json'), workerSchemaDigest: sha('{}\n') });
  const command = { commandId: 'c', runId: policy.runId, phaseId: 'p', stepId: 's', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0, launchToken: 'token', state: 'CLAIMED' };
  command.commandDigest = digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken });
  let supervisors = 0;
  const driver = new CodexExecDriver({ policy, supervisorFactory() { supervisors += 1; throw new Error('must not construct'); } });
  await withReleaseExclusion({ manifest: item.manifest, manifestDigest: item.manifestDigest }, async () => {
    await assert.rejects(() => driver.dispatch(command, command.launchToken), /ReleaseExclusion/);
  });
  assert.equal(supervisors, 0);

  let entered; const launchEntered = new Promise((resolvePromise) => { entered = resolvePromise; });
  let releaseLaunch; const launchGate = new Promise((resolvePromise) => { releaseLaunch = resolvePromise; });
  const admittedCommand = { ...command, commandId: 'admitted', launchToken: 'admitted-token' };
  admittedCommand.commandDigest = digest({ commandId: admittedCommand.commandId, runId: admittedCommand.runId, phaseId: admittedCommand.phaseId, stepId: admittedCommand.stepId, attemptEpoch: admittedCommand.attemptEpoch, launchToken: admittedCommand.launchToken });
  const admitted = new CodexExecDriver({ policy, supervisorFactory() {
    return { async start() { entered(); await launchGate; throw new Error('admitted launch settled'); } };
  } });
  const dispatch = admitted.dispatch(admittedCommand, admittedCommand.launchToken);
  await launchEntered;
  let green = false;
  const release = withReleaseExclusion({ manifest: item.manifest, manifestDigest: item.manifestDigest, waitMs: 500 }, async () => { green = true; });
  await sleep(30); assert.equal(green, false);
  releaseLaunch();
  await assert.rejects(() => dispatch, /admitted launch settled/);
  await release; assert.equal(green, true);
});

test('deploy-vs-drive order is bounded in both directions and target ownership is last', async () => {
  const item = await fixture(); const bridge = join(item.roots[0], '.kernel', '.bridge.lock');
  await writeFile(bridge, canonicalString({ pid: process.pid, started: Date.now(), nonce: 'drive-first' }));
  setTimeout(() => { void unlink(bridge); }, 35);
  await withReleaseExclusion({ manifest: item.manifest, manifestDigest: item.manifestDigest, waitMs: 500 }, async (ownership) => {
    const targetClaim = await acquireOwnedFileClaim(join(item.target, '.lunacy-runtime-deploy.lock'), ownership.owner, { waitMs: 100, label: 'target transaction' });
    try { await assert.rejects(() => new FileArtifactStore(item.roots[0]).load(), /ReleaseExclusion/); }
    finally { await targetClaim.release(); }
  });
  assert.equal(await exists(join(item.target, '.lunacy-runtime-deploy.lock')), false);
});

test('live owner is retained, exact stale owner is reclaimed, and replacement is never unlinked', async () => {
  const item = await fixture({ managed: false, empty: true }); const marker = join(item.discovery, RELEASE_EXCLUSION_LOCK);
  const live = currentReleaseOwner(item.manifestDigest); await writeFile(marker, canonicalString(live));
  await assert.rejects(() => withReleaseExclusion({ manifest: item.manifest, manifestDigest: item.manifestDigest, waitMs: 20 }, async () => undefined), /busy/);
  assert.equal(await readFile(marker, 'utf8'), canonicalString(live)); await unlink(marker);
  const stale = { ...live, pid: 99_999_999, processStartedAt: 'dead-owner' }; await writeFile(marker, canonicalString(stale));
  await withReleaseExclusion({ manifest: item.manifest, manifestDigest: item.manifestDigest, waitMs: 100 }, async () => undefined);
  assert.equal(await exists(marker), false);
  const replacement = canonicalString(currentReleaseOwner(item.manifestDigest));
  let backup;
  await assert.rejects(() => withReleaseExclusion({ manifest: item.manifest, manifestDigest: item.manifestDigest }, async () => {
    backup = `${marker}.old`; await rename(marker, backup); await writeFile(marker, replacement);
  }), /ownership changed/);
  assert.equal(await readFile(marker, 'utf8'), replacement);
  await unlink(marker); await unlink(backup);
});

test('red, throw, cancellation, and hard-crash recovery release only exact claims', async () => {
  const red = await fixture({ managed: false, empty: true });
  assert.equal(await withReleaseExclusion({ manifest: red.manifest, manifestDigest: red.manifestDigest }, async () => 'RED'), 'RED');
  assert.equal(await exists(join(red.discovery, RELEASE_EXCLUSION_LOCK)), false);
  await assert.rejects(() => withReleaseExclusion({ manifest: red.manifest, manifestDigest: red.manifestDigest }, async () => { throw new Error('operation failed'); }), /operation failed/);
  assert.equal(await exists(join(red.discovery, RELEASE_EXCLUSION_LOCK)), false);
  await withReleaseExclusion({ manifest: red.manifest, manifestDigest: red.manifestDigest }, async () => undefined);

  const cancelled = await fixture({ managed: false, empty: true });
  const secondParent = await directory('lunacy-r11a2-second-parent-');
  cancelled.manifest = { ...cancelled.manifest, discoveryParents: [cancelled.discovery, secondParent].sort() };
  cancelled.manifestDigest = sha(canonicalString(cancelled.manifest));
  const live = currentReleaseOwner(cancelled.manifestDigest); await writeFile(join(secondParent, RELEASE_EXCLUSION_LOCK), canonicalString(live));
  const controller = new AbortController(); setTimeout(() => controller.abort(), 30);
  await assert.rejects(() => withReleaseExclusion({ manifest: cancelled.manifest, manifestDigest: cancelled.manifestDigest, waitMs: 500, signal: controller.signal }, async () => undefined), /cancelled/);
  assert.equal(await exists(join(cancelled.discovery, RELEASE_EXCLUSION_LOCK)), false);
  await unlink(join(secondParent, RELEASE_EXCLUSION_LOCK));

  const crashed = await fixture(); const ready = join(crashed.evidence, 'ready');
  const script = `import { writeFile } from 'node:fs/promises'; import { withReleaseExclusion } from ${JSON.stringify(new URL('../dist/release-operation.js', import.meta.url).href)}; const manifest=JSON.parse(process.argv[1]); await withReleaseExclusion({manifest,manifestDigest:process.argv[2]},async()=>{await writeFile(process.argv[3],'ready');process.exit(88);});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(crashed.manifest), crashed.manifestDigest, ready], { stdio: 'ignore' });
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  while (!(await exists(ready))) await sleep(5);
  const exit = await exited; assert.equal(exit, 88);
  await withReleaseExclusion({ manifest: crashed.manifest, manifestDigest: crashed.manifestDigest, waitMs: 500 }, async () => undefined);
  assert.equal(await exists(join(crashed.discovery, RELEASE_EXCLUSION_LOCK)), false);
});

test('production deploy/check path requires a fresh owner-bound post-acquisition snapshot', async () => {
  const item = await fixture({ managed: false, empty: true });
  const { spawnSync } = await import('node:child_process');
  const deployed = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', item.target], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(deployed.status, 0, deployed.stderr);
  const crashedManifest = { ...item.manifest, operation: 'check', processSnapshotPath: join(item.evidence, 'crashed-response.json') };
  const stale = { schema: 'lunacy-release-owner/v1', id: '11111111-1111-4111-8111-111111111111', pid: 99_999_999, processStartedAt: 'dead-owner', acquiredAt: new Date(1).toISOString(), manifestDigest: sha(canonicalString(crashedManifest)) };
  await writeFile(join(item.discovery, RELEASE_EXCLUSION_LOCK), canonicalString(stale));
  await writeFile(join(item.target, RELEASE_EXCLUSION_LOCK), canonicalString(stale));
  await writeFile(join(item.target, '.lunacy-runtime-deploy.lock'), `${canonicalString({ schema: 1, id: stale.id, pid: stale.pid, startedAt: Date.parse(stale.acquiredAt), processStartedAt: stale.processStartedAt, manifestDigest: stale.manifestDigest })}\n`);
  assert.equal(await exists(join(item.discovery, RELEASE_EXCLUSION_LOCK)), true);
  assert.equal(await exists(join(item.target, '.lunacy-runtime-deploy.lock')), true);

  const manifest = { ...item.manifest, operation: 'check' };
  const manifestPath = join(item.evidence, 'release-manifest.json'); await writeFile(manifestPath, canonicalString(manifest));
  const child = spawn(process.execPath, ['tools/deploy-skill.mjs', '--target', item.target, '--check', '--release-manifest', manifestPath], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
  const marker = join(item.discovery, RELEASE_EXCLUSION_LOCK);
  const expectedOwnerDigest = sha(canonicalString(manifest));
  while (true) {
    try { if (JSON.parse(await readFile(marker, 'utf8')).manifestDigest === expectedOwnerDigest) break; }
    catch { /* the prior crashed owner is being reclaimed */ }
    await sleep(5);
  }
  const sourcePath = join(item.evidence, 'raw-snapshot.json');
  await writeFile(sourcePath, canonicalString({ schema: 'lunacy-process-snapshot/v1', capturedAt: new Date().toISOString(), processes: [] }));
  const bound = spawnSync(process.execPath, ['tools/bind-release-process-snapshot.mjs', '--release-manifest', manifestPath, '--snapshot', sourcePath], { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(JSON.parse(bound.stdout).status, 'BOUND');
  assert.equal(await exited, 0, stderr);
  assert.equal(JSON.parse(stdout).status, 'current');
  assert.equal(await exists(join(item.discovery, RELEASE_EXCLUSION_LOCK)), false);
  assert.equal(await exists(join(item.target, RELEASE_EXCLUSION_LOCK)), false);
  assert.equal(await exists(join(item.target, '.lunacy-runtime-deploy.lock')), false);
});
