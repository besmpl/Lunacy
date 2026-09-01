import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { authorManagedWave, deliberationPolicyFromAsset, deriveTopology, materializeRoleView, policyVersionForAsset, renderExplore, resolveWaveSemanticClosure, validateReport } from '../dist/deliberation.js';
import { classifyManagedRecovery } from '../dist/one-shot.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const assetDir = `${root}/assets/deliberation-policy`;
const currentName = '036186605438d7e4275e81b95d3e86b5cd72c3836ce3bad0668296a90f1f0da0.json';
const currentBytes = await readFile(`${assetDir}/${currentName}`, 'utf8');
const asset = JSON.parse(currentBytes); const version = policyVersionForAsset(asset).value; const policy = deliberationPolicyFromAsset(asset, version).value;
const ref = (id, value, scope) => ({ id, ...(scope ? { scope } : {}), digest: digest(value), bytes: canonicalString(value) });
const authorship = (runId) => ({ runId, phaseId: 'adaptive-v2', intent: ref(`intent:${runId}`, { goal: 'choose a durable boundary' }, 'intent'), evidenceSnapshot: ref(`snapshot:${runId}`, { evidence: [], constraints: [] }, 'snapshot'), authorityDigest: digest('authority'), policyVersion: version, settlements: [] });
const request = { gear: 'EXPLORE', decisionKey: 'boundary', prospectiveEffectFrontierOrdinal: 0, context: { problem: 'Choose a durable provider boundary.', decisionImpact: 'The choice determines retry safety and recovery.', evidence: [], constraints: [] }, taskProfile: 'CODE' };

function fixture(runId = 'adaptive-v2') {
  const authored = authorManagedWave(authorship(runId), request, policy); assert.equal(authored.kind, 'DELIBERATION_REQUIRED');
  const wave = JSON.parse(authored.wave.bytes); const topology = deriveTopology(authored.wave, wave);
  const generators = Array.from({ length: 5 }, (_, slotOrdinal) => ({ schema: 'lunacy-deliberation-report/v2', wave: authored.wave, slotOrdinal, ideas: Array.from({ length: 6 }, (_, ordinal) => ({ text: `idea ${slotOrdinal + 1}-${ordinal + 1}`, rationale: `mechanism rationale ${slotOrdinal + 1}-${ordinal + 1}` })) }));
  const reportRef = (report) => ({ id: `report:${digest(report).slice(0, 16)}`, digest: digest(report), scope: 'deliberation/report' });
  const locators = generators.flatMap((generator) => generator.ideas.map((_, ordinal) => ({ generatorReport: reportRef(generator), oneBasedOrdinal: ordinal + 1 })));
  const clusters = [0, 1, 2].map((n) => ({ label: `mechanism-${n + 1}`, ideas: locators.filter((_, index) => index % 3 === n) }));
  const scores = locators.map((idea, index) => ({ idea, novelty: 10 - (index % 5), viability: 9 - (index % 3), fit: 8 - (index % 4), evidence: [] }));
  const critic = { schema: 'lunacy-deliberation-report/v2', wave: authored.wave, slotOrdinal: 5, scores, clusters };
  const deepeners = [6, 7, 8].map((slotOrdinal) => ({ schema: 'lunacy-deliberation-report/v2', wave: authored.wave, slotOrdinal, sketch: 'First sentence. Second sentence. Third sentence. Fourth sentence.', loadBearingRisk: 'The boundary may drift.', firstConcreteStep: 'Write the failing recovery test.', childIdeas: ['variation', 'hybrid', 'unlock'] }));
  return { authored, wave, topology, generators, reportRef, critic, deepeners };
}

test('policy assets and compatibility map are exact content-addressed release inputs', async () => {
  for (const name of await readdir(assetDir)) {
    const bytes = await readFile(`${assetDir}/${name}`); assert.equal(createHash('sha256').update(bytes).digest('hex'), name.slice(0, -5)); assert.equal(bytes.at(-1), 0x7d);
  }
  assert.equal(version.digest, currentName.slice(0, -5)); assert.equal(version.bytes, currentBytes);
  const mapBytes = await readFile(`${root}/assets/deliberation-policy-compatibility/map.json`, 'utf8'); const map = JSON.parse(mapBytes); assert.deepEqual(Object.keys(map).sort(), ['mappings', 'schema']); assert.equal(map.mappings.length, 1);
});

test('provider-intent recovery classifier is fail-closed and monotone', () => {
  const classify = (started, kind, completeResultChain = false) => classifyManagedRecovery({ started, providerIntent: { kind }, completeResultChain });
  assert.equal(classify(false, 'ABSENT_PROVED'), 'RETRY_FULL_RESERVATION');
  assert.equal(classify(true, 'ABSENT_PROVED'), 'RETRY_FULL_RESERVATION');
  assert.equal(classify(true, 'PRESENT_VALID'), 'RETAIN_CUSTODY');
  assert.equal(classify(true, 'AMBIGUOUS'), 'RETAIN_CUSTODY');
  assert.equal(classify(false, 'PRESENT_VALID'), 'RETAIN_CUSTODY');
  assert.equal(classify(true, 'PRESENT_VALID', true), 'RECONCILE_COMPLETE');
});

test('fresh Explore selection and role semantics are deterministic and restart-byte stable', () => {
  const a = fixture('deterministic'); const b = fixture('deterministic'); assert.equal(a.authored.wave.bytes, b.authored.wave.bytes);
  assert.equal(a.wave.generatorLenses.length, 5); assert.equal(new Set(a.wave.generatorLenses.map((frame) => frame.frameId)).size, 5);
  const closure = resolveWaveSemanticClosure(a.wave); assert.equal(closure.ok, true);
  const role = materializeRoleView({ waveRef: a.authored.wave, wave: a.wave, slot: a.topology.slots[0], predecessorRefs: [], acceptedReportsByRef: new Map(), resolved: closure.value.resolved, policy });
  assert.equal(role.ok, true); assert.equal(role.value.contract, asset.contracts.exploreGenerator); assert.ok(role.value.lens.tags.length > 0); assert.equal(canonicalString(role.value), canonicalString(JSON.parse(canonicalString(role.value))));
});

test('fresh Explore stops at the six-call critic barrier when fewer than three non-traps survive', () => {
  const fx = fixture('underfilled'); const underfilled = { ...fx.critic, scores: fx.critic.scores.map((score, index) => index < 2 ? score : { ...score, trap: 'Attractive but cannot preserve the recovery invariant.' }) };
  const checked = validateReport(underfilled, { waveRef: fx.authored.wave, wave: fx.wave, slot: fx.topology.slots[5], predecessors: fx.generators, policy });
  assert.equal(checked.ok, false); assert.equal(checked.code, 'CARDINALITY');
});

test('volatile Explore renderer exposes the six named parent sections with traceable targets', () => {
  const fx = fixture('renderer');
  for (const generator of fx.generators) assert.equal(validateReport(generator, { waveRef: fx.authored.wave, wave: fx.wave, slot: fx.topology.slots[generator.slotOrdinal], predecessors: [], policy }).ok, true);
  assert.equal(validateReport(fx.critic, { waveRef: fx.authored.wave, wave: fx.wave, slot: fx.topology.slots[5], predecessors: fx.generators, policy }).ok, true);
  const rendered = renderExplore({ waveRef: fx.authored.wave, wave: fx.wave, reports: [...fx.generators, fx.critic, ...fx.deepeners], policy }); assert.equal(rendered.ok, true);
  assert.deepEqual(Object.keys(rendered.value), ['brief', 'wide', 'converge', 'traps', 'deepened', 'provocation']); assert.match(rendered.value.converge, /★/); assert.match(rendered.value.deepened, /Target:/); assert.match(rendered.value.provocation, /^\[/);
});
