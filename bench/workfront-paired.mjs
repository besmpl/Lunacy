import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonicalString, digest } from '../dist/canonical.js';
import { transition } from '../dist/bridge.js';
import { inspectWorkfront } from '../dist/workfront.js';

const fixture = JSON.parse(await readFile(new URL('./workfront-corpus.json', import.meta.url), 'utf8'));
if (fixture.schema !== 'lunacy-workfront-paired-v1' || !Number.isSafeInteger(fixture.repetitions) || fixture.repetitions <= 0 || !Array.isArray(fixture.scenarios)) throw new Error('workfront corpus is malformed');
const expectedFixtureDigest = digest({ schema: fixture.schema, seed: fixture.seed, repetitions: fixture.repetitions, scenarios: fixture.scenarios, notes: fixture.notes });
const FROZEN_FIXTURE_DIGEST = '3517bac6faae7b165332edd68f9405e04d298056f1191b273e8b0b57636c8659';
if (fixture.fixtureDigest !== FROZEN_FIXTURE_DIGEST || expectedFixtureDigest !== FROZEN_FIXTURE_DIGEST) throw new Error('workfront corpus digest mismatch');
const GOLDEN_CAPSULE_DIGESTS = Object.freeze({ small: '56476cd43a274cbfbb12c91724845a482a24bfa8efaf2b21a52a0cb6415b2622', wide: 'e1d3319db68b01a11ac0705c59de02b0f5ad634c6f19c3b1dd516eee10d45420', 'max-bound': '90738eb7b14eb2d615bc77f8dc2481b773fd6bd1839d901cee5203ec9abfac28', deep: '6759a108e33c9b9715e94d6f33a8510077e107c4f68f0c448e050fe8a1eaaf9e' });
const expand = (scenario) => ({ phaseId: scenario.phaseId, steps: scenario.steps === 'GENERATE_80_INDEPENDENT' ? Array.from({ length: 80 }, (_, index) => ({ stepId: `s${String(index).padStart(2, '0')}`, goal: `step-${index}` })) : scenario.steps === 'GENERATE_500_INDEPENDENT' ? Array.from({ length: 500 }, (_, index) => ({ stepId: `s${String(index).padStart(3, '0')}`, goal: `step-${index}` })) : scenario.steps });
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const pairs = [];
for (let repetition = 0; repetition < fixture.repetitions; repetition += 1) {
  for (const scenario of fixture.scenarios) {
    const plan = expand(scenario);
    const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-paired-'));
    try {
      await transition({ runDir: root, runId: `${scenario.id}-${repetition}`, mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
      const baselinePaths = [join(root, 'STATE.md'), join(root, 'phases', plan.phaseId, 'STEPS.md')];
      const baselineBytes = (await Promise.all(baselinePaths.map((path) => readFile(path, 'utf8')))).reduce((sum, text) => sum + bytes(text), 0) + bytes(canonicalString(plan));
      const inspection = { kernelRoot: root, expectedRunId: `${scenario.id}-${repetition}`, ...(scenario.id === 'deep' ? { focusStepId: 's4' } : {}) };
      const coldStart = performance.now();
      const capsule = await inspectWorkfront(inspection);
      const coldMilliseconds = performance.now() - coldStart;
      const warmStart = performance.now();
      const warmCapsule = await inspectWorkfront(inspection);
      const warmMilliseconds = performance.now() - warmStart;
      if (canonicalString(warmCapsule) !== canonicalString(capsule)) throw new Error('cold/warm Workfront capsules differ');
      const candidateBytes = bytes(canonicalString(capsule));
      const normalizedCapsule = structuredClone(capsule); normalizedCapsule.run.runId = '<run>';
      if (digest(normalizedCapsule) !== GOLDEN_CAPSULE_DIGESTS[scenario.id]) throw new Error(`Workfront semantic regression for ${scenario.id}`);
      pairs.push({ repetition, scenario: scenario.id, baselineBytes, candidateBytes, coldMilliseconds, warmMilliseconds, capsule, facts: { active: capsule.active.map((item) => item.stepId), eligible: capsule.eligible.map((item) => item.stepId), blocked: capsule.blocked.map((item) => [item.stepId, item.waitsFor]) } });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
}
const reductions = pairs.map((pair) => pair.baselineBytes === 0 ? null : (pair.baselineBytes - pair.candidateBytes) / pair.baselineBytes).filter((value) => value !== null);
const sorted = [...reductions].sort((a, b) => a - b);
const median = sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
const p90 = sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
const percentile95 = (values) => { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)]; };
const coldP95Milliseconds = percentile95(pairs.map((pair) => pair.coldMilliseconds));
const warmP95Milliseconds = percentile95(pairs.map((pair) => pair.warmMilliseconds));
const thresholds = { requiredCheckpoints: 30, medianInputByteReduction: 0.5, p90InputByteReduction: 0.3, inspectorP95Milliseconds: 50, outputBytesMaximum: 16 * 1024 };
if (pairs.length < thresholds.requiredCheckpoints) throw new Error('Workfront checkpoint count regression');
if (median === null || median < thresholds.medianInputByteReduction || p90 === null || p90 < thresholds.p90InputByteReduction) throw new Error('Workfront input-byte reduction regression');
if (pairs.some((pair) => pair.candidateBytes > thresholds.outputBytesMaximum)) throw new Error('Workfront output-byte regression');
if (coldP95Milliseconds > thresholds.inspectorP95Milliseconds || warmP95Milliseconds > thresholds.inspectorP95Milliseconds) throw new Error(`Workfront local latency regression: cold p95=${coldP95Milliseconds.toFixed(3)}ms warm p95=${warmP95Milliseconds.toFixed(3)}ms`);
console.log(canonicalString({ schema: 'lunacy-workfront-paired-v1', fixture: 'workfront-corpus.json', fixtureDigest: FROZEN_FIXTURE_DIGEST, checkpoints: pairs.length, pairs, measurements: { medianInputByteReduction: median, p90InputByteReduction: p90, coldP95Milliseconds, warmP95Milliseconds }, thresholds, localPerformanceGate: 'PASS', result: 'NOT_CLAIMED', reason: 'Synthetic local fixture has no provider/token/native host counters and does not alter default behavior.', providerCounters: 'unavailable', tokenCounters: 'unavailable', nativeCounters: 'unavailable' }));
