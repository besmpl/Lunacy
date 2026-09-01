import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalString, digest } from '../dist/canonical.js';
import { createManagedCapability, createManagedRolloutPolicy } from '../dist/managed-capability.js';
import { applyManagedRolloutPolicy, createInitialState } from '../dist/reducer.js';
import { acquireOwnedFileClaim, verifyClosedReleaseRoots } from '../dist/release-admission.js';
import { withReleaseExclusion } from '../dist/release-operation.js';
import { verifyReleaseGenerationCensus } from '../dist/release-quiescence.js';
import { FileArtifactStore } from '../dist/store.js';

const cleanup = [];
after(async () => Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true }))));

async function directory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix)); cleanup.push(path); return path;
}

const plan = { phaseId: 'p5', steps: [{ stepId: 'one' }] };
const bridgeSourceDigest = digest('lunacy-runtime-skill-bridge/v1');

async function configuredRoot(parent, name, generation) {
  const root = join(parent, name); await mkdir(root);
  let state = createInitialState(name, plan, digest(plan), 'p5-census');
  if (generation !== null) state = applyManagedRolloutPolicy(state, createManagedCapability(), createManagedRolloutPolicy({ generation, mode: 'disabled' }));
  await new FileArtifactStore(root).commit(0, state);
  await writeFile(join(root, '.kernel', 'BRIDGE.json'), canonicalString({
    bridgeVersion: '0.2.0', mode: 'runtime', planDigest: state.planDigest,
    rootPath: root, runId: state.runId, phaseId: state.phaseId,
    runtimeVersion: '0.3.0', schema: 1, sourceDigest: bridgeSourceDigest, status: 'enabled',
  }));
  return root;
}

function manifest(target, parent, roots) {
  return {
    schema: 'lunacy-release-operation/v1', operation: 'deploy', installedTarget: target,
    discoveryParents: [parent], runRoots: [...roots].sort(),
    processSnapshotPath: join(target, '..', `snapshot-${digest(roots).slice(0, 12)}.json`),
  };
}

async function censusUnderRelease(item, candidateFloor) {
  const manifestDigest = digest(item.manifest);
  return withReleaseExclusion({ manifest: item.manifest, manifestDigest }, async (ownership) => {
    const targetLock = await acquireOwnedFileClaim(join(item.target, '.lunacy-runtime-deploy.lock'), ownership.owner, { waitMs: 100, label: 'target transaction' });
    try {
      const releaseOwnership = {
        ownerBytes: ownership.ownerBytes,
        releaseClaimPaths: ownership.releaseClaims.map((claim) => claim.path),
        bridgeClaimPaths: ownership.bridgeClaims.map((claim) => claim.path),
        writerClaimPaths: ownership.writerClaims.map((claim) => claim.path),
        targetLock: { path: targetLock.path, bytes: targetLock.bytes },
      };
      const quiescence = { status: 'QUIESCENT', installedTarget: item.target, runRoots: item.manifest.runRoots, runCount: item.manifest.runRoots.length, effectCount: 0, processCount: 0, capturedAt: new Date().toISOString() };
      return await verifyReleaseGenerationCensus({ installedTarget: item.target, runRoots: item.manifest.runRoots, candidateFloor, quiescence, releaseOwnership });
    } finally { await targetLock.release(); }
  });
}

test('in-fence census classifies every configured root and proves floor 22 over generation 21', async () => {
  const parent = await directory('lunacy-p5-census-parent-'); const target = await directory('lunacy-p5-census-target-');
  const direct = await configuredRoot(parent, 'direct', null); const historical = await configuredRoot(parent, 'managed-21', 21);
  const item = { parent, target, manifest: manifest(target, parent, [direct, historical]) };
  assert.deepEqual(await verifyClosedReleaseRoots(item.manifest), item.manifest.runRoots);
  const census = await censusUnderRelease(item, 22);
  assert.equal(census.candidateFloor, 22);
  assert.equal(census.maximumSupportedGeneration, 21);
  assert.deepEqual(census.roots.map(({ classification, generations }) => ({ classification, generations })), [
    { classification: 'DIRECT', generations: [] },
    { classification: 'MANAGED_ROLLOUT', generations: [21] },
  ]);
  assert.match(census.digest, /^[0-9a-f]{64}$/);
});

test('census refuses a configured root at the candidate floor and unreadable retained state', async () => {
  const parent = await directory('lunacy-p5-floor-parent-'); const target = await directory('lunacy-p5-floor-target-');
  const root = await configuredRoot(parent, 'managed-22', 22);
  const item = { parent, target, manifest: manifest(target, parent, [root]) };
  await assert.rejects(() => censusUnderRelease(item, 22), /not strictly newer than supported generation 22/);
  const current = join(root, '.kernel', 'CURRENT'); const bytes = await readFile(current, 'utf8');
  await writeFile(current, bytes.replace(/"generation":1/, '"generation":2'));
  await assert.rejects(() => censusUnderRelease(item, 23), /unreadable|ManifestMismatch|generation/i);
});

test('closed discovery rejects omitted roots and census digests reject retained-root drift', async () => {
  const parent = await directory('lunacy-p5-drift-parent-'); const target = await directory('lunacy-p5-drift-target-');
  const first = await configuredRoot(parent, 'managed-20', 20);
  const item = { parent, target, manifest: manifest(target, parent, [first]) };
  const before = await censusUnderRelease(item, 22);
  const second = await configuredRoot(parent, 'omitted', null);
  await assert.rejects(() => verifyClosedReleaseRoots(item.manifest), /differs from release manifest/);
  item.manifest = manifest(target, parent, [first, second]);
  const after = await censusUnderRelease(item, 22);
  assert.notEqual(after.digest, before.digest);
});
