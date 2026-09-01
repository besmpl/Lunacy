import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { authorPlan, deriveTopology, validateWave } from '../dist/deliberation.js';
import { canonicalString, digest, digestBytes } from '../dist/canonical.js';

const retained = ['maxModelCalls', 'maxWaveBytes', 'maxRefs', 'maxResolvedRoleInputBytes', 'maxReportBytes', 'maxTotalReportBytes'];
const legacy = ['maxInputTokens', 'maxOutputTokens', 'maxWallClockMs'];
const repo = fileURLToPath(new URL('..', import.meta.url));
const fleetRoot = '/Users/mark/Documents/Codex/2026-08-31/lunacy-execution-evidence/l3a-fleet-proof';
const ref = (id, value) => ({ id, digest: digest(value), scope: 'l3b', bytes: canonicalString(value) });
const policy = {
  version: ref('policy', { generation: 1 }),
  frameCatalog: [
    { frameId: 'f0', tag: 'code', text: 'counterexample' },
    { frameId: 'f1', tag: 'code', text: 'simplify' },
    { frameId: 'f2', tag: 'code', text: 'failure' },
    { frameId: 'f3', tag: 'design', text: 'boundary' },
    { frameId: 'wild', tag: 'wild', text: 'provocation' },
  ],
  maxMaterialDecisions: 4,
  maxSettlementBytes: 1_000_000,
  maxResolvedRoleInputBytes: 1_000_000,
  convergeCount: 3,
  nonObviousNovelty: 5,
  viableFloor: 5,
};
const context = { runId: 'l3b-run', phaseId: 'l3b-phase', policy, committedEvidence: new Set(), reachableConstraints: new Set() };
const predicates = { decisionUnsettled: true, explicitExplore: false, citedWitness: false, planEquivalent: false, containedDiscovery: false, openEnded: false, highStakes: false, openlyPhrased: false, namedDiscriminator: true };

function authoredWave() {
  const result = authorPlan({ runId: context.runId, phaseId: context.phaseId, intent: ref('intent', 'decision'), evidenceSnapshot: ref('snapshot', 'sealed'), authorityDigest: digest('authority'), policyVersion: policy.version, settlements: [] }, predicates, policy);
  assert.equal(result.kind, 'DELIBERATION_REQUIRED');
  return { wave: JSON.parse(result.wave.bytes), waveRef: result.wave };
}

function expectNormalized(reader, input) {
  const result = reader(input, context);
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.path}: ${result.message}`);
  assert.deepEqual(Object.keys(result.value.limits).sort(), retained.slice().sort());
}

test('L3b six-key writer contraction', () => {
  const { wave, waveRef } = authoredWave();
  assert.deepEqual(Object.keys(wave.limits).sort(), retained.slice().sort());
  assert.deepEqual(wave.generatorLenses, [{ text: 'counterexample' }, { text: 'simplify' }]);
  assert.equal(wave.limits.maxModelCalls, 3);
  assert.equal(deriveTopology(waveRef, wave).slots.length, wave.limits.maxModelCalls);
  assert.equal(digestBytes(new TextEncoder().encode(waveRef.bytes)), waveRef.digest);
  expectNormalized(validateWave, waveRef);

  const archivedNine = { ...wave, limits: { ...wave.limits, maxInputTokens: 1, maxOutputTokens: 2, maxWallClockMs: 3 } };
  const archivedNineRef = ref('archived-nine', archivedNine);
  const originalBytes = archivedNineRef.bytes;
  const originalDigest = archivedNineRef.digest;
  expectNormalized(validateWave, archivedNineRef);
  assert.equal(archivedNineRef.bytes, originalBytes);
  assert.equal(archivedNineRef.digest, originalDigest);

  for (let mask = 1; mask < 8; mask += 1) {
    const limits = { ...wave.limits };
    legacy.forEach((key, index) => { if (mask & (1 << index)) limits[key] = archivedNine.limits[key]; });
    expectNormalized(validateWave, ref(`archived-mixed-${mask}`, { ...wave, limits }));
  }
});

test('L3b deployment inventory', async (t) => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-l3b-deploy-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const deployed = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: repo, encoding: 'utf8' });
  assert.equal(deployed.status, 0, deployed.stderr);
  const manifest = JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8'));
  for (const name of ['deliberation.js', 'deliberation.js.map', 'deliberation.d.ts', 'deliberation.d.ts.map']) {
    await access(join(repo, 'dist', name));
    await access(join(target, 'runtime', 'dist', name));
    assert.equal(manifest.files.includes(`runtime/dist/${name}`), true, name);
  }
  assert.equal(manifest.files.filter((path) => path.startsWith('runtime/dist/deliberation.')).length, 4);
});

test('L3b rollback reader smoke', async () => {
  const { wave, waveRef } = authoredWave();
  assert.deepEqual(Object.keys(wave.limits).sort(), retained.slice().sort());
  const inventory = JSON.parse(await readFile(join(fleetRoot, 'reader-inventory.json'), 'utf8'));
  const accepted = JSON.parse(await readFile(join(fleetRoot, 'accepted-l3a.json'), 'utf8'));
  for (const reader of inventory.readers) {
    assert.equal(reader.deployedCommit, accepted.commit);
    assert.equal(reader.strictNineOnly, false);
    const module = await import(`${pathToFileURL(reader.binaryPath).href}?l3b=${encodeURIComponent(reader.readerId)}`);
    expectNormalized(module.validateWave, waveRef);
  }
  assert.equal(Object.keys(wave.limits).length === 9, false, 'a strict-nine reader must refuse the first six-key artifact');
  for (const key of legacy) assert.equal(Object.hasOwn(wave.limits, key), false);
});
