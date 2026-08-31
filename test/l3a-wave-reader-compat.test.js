import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorPlan, validateWave } from '../dist/deliberation.js';
import { canonicalString, digest, digestBytes } from '../dist/canonical.js';

const retainedLimitKeys = [
  'maxModelCalls',
  'maxWaveBytes',
  'maxRefs',
  'maxResolvedRoleInputBytes',
  'maxReportBytes',
  'maxTotalReportBytes',
];
const legacyLimitKeys = ['maxInputTokens', 'maxOutputTokens', 'maxWallClockMs'];
const allLimitKeys = [...retainedLimitKeys, ...legacyLimitKeys].sort();
const repo = fileURLToPath(new URL('..', import.meta.url));
const deployTool = fileURLToPath(new URL('../tools/deploy-skill.mjs', import.meta.url));
const deliberationArtifacts = ['deliberation.js', 'deliberation.js.map', 'deliberation.d.ts', 'deliberation.d.ts.map'];

const ref = (id, value) => ({ id, digest: digest(value), scope: 'l3a', bytes: canonicalString(value) });
const frames = [
  { frameId: 'f0', tag: 'code', text: 'counterexample' },
  { frameId: 'f1', tag: 'code', text: 'simplify' },
  { frameId: 'f2', tag: 'code', text: 'failure mode' },
  { frameId: 'f3', tag: 'design', text: 'boundary' },
  { frameId: 'wild', tag: 'wild', text: 'provocation' },
];
const policy = {
  version: ref('policy', { generation: 1 }),
  frameCatalog: frames,
  maxMaterialDecisions: 4,
  maxSettlementBytes: 1_000_000,
  maxResolvedRoleInputBytes: 1_000_000,
  convergeCount: 3,
  nonObviousNovelty: 5,
  viableFloor: 5,
};
const context = { runId: 'l3a-run', phaseId: 'l3a-phase', policy, committedEvidence: new Set(), reachableConstraints: new Set() };
const predicates = {
  decisionUnsettled: true,
  explicitExplore: false,
  citedWitness: false,
  planEquivalent: false,
  containedDiscovery: false,
  openEnded: false,
  highStakes: false,
  openlyPhrased: false,
  namedDiscriminator: true,
};

function authoredWave() {
  const authored = authorPlan({
    runId: context.runId,
    phaseId: context.phaseId,
    intent: ref('intent', { question: 'which boundary?' }),
    evidenceSnapshot: ref('snapshot', { sealed: true }),
    authorityDigest: digest({ authority: 'owner' }),
    policyVersion: policy.version,
    settlements: [],
  }, predicates, policy);
  assert.equal(authored.kind, 'DELIBERATION_REQUIRED');
  return { wave: JSON.parse(authored.wave.bytes), waveRef: authored.wave };
}

function withLegacySubset(sixKeyWave, nineKeyWave, mask) {
  const limits = { ...sixKeyWave.limits };
  legacyLimitKeys.forEach((key, index) => {
    if (mask & (1 << index)) limits[key] = nineKeyWave.limits[key];
  });
  return { ...sixKeyWave, limits };
}

function withArchivedLegacy(sixKeyWave) {
  return { ...sixKeyWave, limits: { ...sixKeyWave.limits, maxInputTokens: 1, maxOutputTokens: 2, maxWallClockMs: 3 } };
}

function expectNormalized(result) {
  assert.equal(result.ok, true, result.ok ? '' : `${result.code}: ${result.path}: ${result.message}`);
  assert.deepEqual(Object.keys(result.value.limits).sort(), retainedLimitKeys.slice().sort());
  for (const key of legacyLimitKeys) assert.equal(Object.hasOwn(result.value.limits, key), false);
}

test('L3a six-key reader compatibility', async (t) => {
  const { wave: sixKeyWave, waveRef } = authoredWave();
  assert.deepEqual(Object.keys(sixKeyWave.limits).sort(), retainedLimitKeys.slice().sort());
  const nineKeyWave = withArchivedLegacy(sixKeyWave);
  assert.deepEqual(Object.keys(nineKeyWave.limits).sort(), allLimitKeys);

  const originalBytes = waveRef.bytes;
  const originalDigest = waveRef.digest;
  assert.equal(digestBytes(new TextEncoder().encode(originalBytes)), originalDigest);
  expectNormalized(validateWave(waveRef, context));
  assert.equal(waveRef.bytes, originalBytes);
  assert.equal(waveRef.digest, originalDigest);

  expectNormalized(validateWave(sixKeyWave, context));
  expectNormalized(validateWave(canonicalString(sixKeyWave), context));
  expectNormalized(validateWave(nineKeyWave, context));

  const inventory = [];
  for (let mask = 1; mask < 8; mask += 1) {
    const mixed = withLegacySubset(sixKeyWave, nineKeyWave, mask);
    const mixedRef = ref(`mixed-${mask}`, mixed);
    expectNormalized(validateWave(mixedRef, context));
    inventory.push({ mask, inputDigest: mixedRef.digest, normalizedDigest: digest(validateWave(mixedRef, context).value) });
  }

  const missing = structuredClone(sixKeyWave);
  delete missing.limits.maxRefs;
  assert.deepEqual(validateWave(missing, context), { ok: false, code: 'MISSING_KEY', path: 'wave.limits', message: 'missing key maxRefs' });
  const malformedRetained = structuredClone(sixKeyWave);
  malformedRetained.limits.maxRefs = '128';
  assert.equal(validateWave(malformedRetained, context).code, 'INVALID_LIMIT');
  for (const key of legacyLimitKeys) {
    const malformedLegacy = structuredClone(sixKeyWave);
    malformedLegacy.limits[key] = -1;
    assert.equal(validateWave(malformedLegacy, context).code, 'INVALID_LIMIT', key);
  }
  const extra = structuredClone(sixKeyWave);
  extra.limits.unknownLimit = 1;
  assert.deepEqual(validateWave(extra, context), { ok: false, code: 'EXTRA_KEY', path: 'wave.limits', message: 'unknown key unknownLimit' });

  const malformedAndMismatchedRef = { id: 'archived', digest: '0'.repeat(64), scope: 'deliberation/wave', bytes: '{ not canonical json' };
  const digestFirst = validateWave(malformedAndMismatchedRef, context);
  assert.equal(digestFirst.ok, false);
  assert.equal(digestFirst.code, 'INVALID_REF');

  const authoredAgain = authoredWave();
  assert.deepEqual(Object.keys(JSON.parse(authoredAgain.waveRef.bytes).limits).sort(), retainedLimitKeys.slice().sort());
  assert.equal(digestBytes(new TextEncoder().encode(authoredAgain.waveRef.bytes)), authoredAgain.waveRef.digest);

  const roots = await Promise.all([mkdtemp(join(tmpdir(), 'lunacy-l3a-journey-a-')), mkdtemp(join(tmpdir(), 'lunacy-l3a-journey-b-'))]);
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  const inventoryBytes = canonicalString(inventory);
  await Promise.all(roots.map((root) => writeFile(join(root, 'inventory.json'), inventoryBytes)));
  const replayDigests = await Promise.all(roots.map(async (root) => digestBytes(new TextEncoder().encode(await readFile(join(root, 'inventory.json'), 'utf8')))));
  assert.equal(replayDigests[0], replayDigests[1]);
});

test('L3a deployment inventory', async (t) => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-l3a-deploy-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const deployed = spawnSync(process.execPath, [deployTool, '--target', target], { cwd: repo, encoding: 'utf8' });
  assert.equal(deployed.status, 0, deployed.stderr);
  const manifest = JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8'));
  for (const name of deliberationArtifacts) {
    await access(join(repo, 'dist', name));
    await access(join(target, 'runtime', 'dist', name));
    assert.equal(manifest.files.includes(`runtime/dist/${name}`), true, name);
  }
  assert.equal(manifest.files.filter((path) => path.startsWith('runtime/dist/deliberation.')).length, 4);
});

test('L3a rollback reader smoke', () => {
  const { wave: authoredSixKeyWave, waveRef } = authoredWave();
  expectNormalized(validateWave(waveRef, context));
  const archivedNineKeyWave = withArchivedLegacy(authoredSixKeyWave);
  const archivedMixedWave = structuredClone(archivedNineKeyWave);
  delete archivedMixedWave.limits.maxInputTokens;
  expectNormalized(validateWave(ref('archived-mixed', archivedMixedWave), context));
  const futureSixKeyWave = structuredClone(archivedMixedWave);
  delete futureSixKeyWave.limits.maxOutputTokens;
  delete futureSixKeyWave.limits.maxWallClockMs;
  expectNormalized(validateWave(ref('future-six', futureSixKeyWave), context));
});
