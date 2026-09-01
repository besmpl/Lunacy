import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { canonicalString, digest } from '../dist/canonical.js';
import { createCodexDeliberationHostPolicy } from '../dist/codex-host-policy.js';
import { policyVersionForAsset } from '../dist/deliberation.js';
import { createManagedCapability, createManagedRolloutPolicy } from '../dist/managed-capability.js';
import { ONE_SHOT_ROLLOUT_GENERATION_FLOOR } from '../dist/one-shot.js';
import { resolveTypedPrePlan, parsePrePlanRequest } from '../dist/pre-plan-request.js';
import { FileArtifactStore } from '../dist/store.js';
import { validatePlan } from '../dist/validator.js';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const policyAssetPath = join(repoRoot, 'assets/deliberation-policy/036186605438d7e4275e81b95d3e86b5cd72c3836ce3bad0668296a90f1f0da0.json');
const policyAsset = JSON.parse(await readFile(policyAssetPath, 'utf8'));
const policyVersion = policyVersionForAsset(policyAsset).value;
const ref = (id, value, scope) => ({ id, ...(scope ? { scope } : {}), digest: digest(value), bytes: canonicalString(value) });
const snapshot = (id) => ref(id, { evidence: [], constraints: [] }, 'snapshot');
const completePlan = (phaseId) => validatePlan({ schema: 'lunacy-plan-v1', phaseId, steps: [{ stepId: 'deliver' }] }).plan;
const authorship = (runId, plan = completePlan('p4')) => ({
  runId, phaseId: plan.phaseId, intent: ref(`intent:${runId}`, plan, 'intent'), evidenceSnapshot: snapshot(`snapshot:${runId}`),
  authorityDigest: digest('authority'), policyVersion, settlements: [],
});
const context = { problem: 'Choose the safest implementation boundary.', decisionImpact: 'This determines the implementation and rollback path.', evidence: [], constraints: [] };
const autoFocus = (input) => ({ mode: 'AUTO', authorship: input, frontier: [{ key: 'boundary', prospectiveEffectFrontierOrdinal: 0, status: 'UNSETTLED', discriminator: 'Which boundary owns durable provider intent?', context }] });
const explicitExplore = (input) => ({
  mode: 'EXPLORE', authorship: input, decisionKey: 'mechanism', prospectiveEffectFrontierOrdinal: 0, context, taskProfile: 'CODE',
  requestAuthority: { schema: 'lunacy-explore-request-authority/v1', runId: input.runId, phaseId: input.phaseId, intentDigest: input.intent.digest, authorityDigest: input.authorityDigest, decisionKey: 'mechanism', prospectiveEffectFrontierOrdinal: 0, cutoff: 'OPEN' },
});

function runResolve(args, cwd = repoRoot) {
  return spawnSync(process.execPath, ['dist/bridge-cli.js', 'resolve-plan', ...args], { cwd, encoding: 'utf8', timeout: 20_000 });
}

test('real CLI Direct and AUTO→Direct are physically isolated from poisoned managed inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunacy-direct-tripwire-'));
  try {
    const plan = completePlan('direct');
    for (const request of [
      { mode: 'DIRECT', authorship: authorship('direct-explicit', plan) },
      { mode: 'AUTO', authorship: authorship('direct-auto', plan), frontier: [] },
    ]) {
      const input = join(dir, `${request.authorship.runId}.json`); await writeFile(input, canonicalString(request));
      const before = (await readdir(dir)).sort();
      const result = runResolve(['--input', input, '--deliberation-policy', join(dir, 'POISON-policy'), '--rollout-policy', join(dir, 'POISON-rollout'), '--run-dir', join(dir, 'POISON-run'), '--capability', join(dir, 'POISON-capability'), '--host-policy', join(dir, 'POISON-host')]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${canonicalString({ gear: 'DIRECT', kind: 'COMPLETE_PLAN', plan })}\n`);
      assert.deepEqual((await readdir(dir)).sort(), before);
    }
    const nonExactPlan = { schema: 'lunacy-plan-v1', phaseId: 'not-normalized', steps: [{ stepId: 'deliver' }] };
    const refusal = join(dir, 'normalization-refusal.json');
    await writeFile(refusal, canonicalString({ mode: 'DIRECT', authorship: authorship('normalization-refusal', nonExactPlan) }));
    const refused = runResolve(['--input', refusal]);
    assert.equal(refused.status, 0, refused.stderr); assert.equal(JSON.parse(refused.stdout).kind, 'NO_SETTLEMENT');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('typed AUTO table and explicit Explore authority are closed and truthful', () => {
  const plan = completePlan('table'); const input = authorship('table', plan);
  const cases = [
    [{ mode: 'AUTO', authorship: input, frontier: [] }, 'COMPLETE_PLAN'],
    [{ mode: 'AUTO', authorship: input, frontier: [{ key: 'x', prospectiveEffectFrontierOrdinal: 0, status: 'UNSETTLED', context }] }, 'NO_SETTLEMENT'],
  ];
  for (const [request, kind] of cases) assert.equal(resolveTypedPrePlan(parsePrePlanRequest(request)).kind, kind);
  assert.throws(() => parsePrePlanRequest({ ...explicitExplore(input), prose: 'ADHD mode' }), /fields are not exact/);
  assert.throws(() => parsePrePlanRequest({ ...explicitExplore(input), requestAuthority: { ...explicitExplore(input).requestAuthority, cutoff: 'CLOSED' } }), /does not bind/);
});

const sharedObjects = process.report.getReport().sharedObjects.filter((path) => path.startsWith('/opt/homebrew/') || path.startsWith('/usr/local/'));
const linkedFiles = process.platform === 'darwin' ? sharedObjects.flatMap((object) => execFileSync('/usr/bin/otool', ['-L', object], { encoding: 'utf8' }).split('\n').map((line) => line.trim().split(' ')[0]).filter((path) => !path?.endsWith(':') && (path?.startsWith('/opt/homebrew/') || path?.startsWith('/usr/local/')))) : [];
const runtimeReadFiles = [...new Set([process.execPath, ...(process.platform === 'darwin' ? ['/opt/homebrew/etc/openssl@3/openssl.cnf'] : []), ...linkedFiles, ...sharedObjects])];
const runtimeReadSubpaths = [...new Set([dirname(dirname(process.execPath)), ...linkedFiles.map(dirname)])];

async function managedFixture(base, gear) {
  const runId = `managed-${gear.toLowerCase()}`; const plan = completePlan('p4'); const input = authorship(runId, plan);
  const request = gear === 'EXPLORE' ? explicitExplore(input) : autoFocus(input);
  const runDir = await realpath(await mkdir(join(base, `run-${gear}`), { recursive: true }).then(() => join(base, `run-${gear}`)));
  const scratch = await realpath(await mkdir(join(base, `scratch-${gear}`), { recursive: true }).then(() => join(base, `scratch-${gear}`)));
  const evidence = await realpath(await mkdir(join(base, `evidence-${gear}`), { recursive: true }).then(() => join(base, `evidence-${gear}`)));
  const hostDir = await realpath(await mkdir(join(base, `host-${gear}`)).then(() => join(base, `host-${gear}`)));
  let codexPath = join(hostDir, 'codex.mjs'); let schemaPath = join(hostDir, 'schema.json'); let authPath = join(hostDir, 'auth.json');
  const script = `#!${process.execPath}\nif (process.argv[2] === '--version') { console.log('codex-cli 0.145.0'); process.exit(0); } process.exit(73);\n`;
  await Promise.all([writeFile(codexPath, script, { mode: 0o700 }), writeFile(schemaPath, '{}\n', { mode: 0o600 }), writeFile(authPath, '{}\n', { mode: 0o600 })]); await chmod(codexPath, 0o700);
  [codexPath, schemaPath, authPath] = await Promise.all([realpath(codexPath), realpath(schemaPath), realpath(authPath)]);
  const host = createCodexDeliberationHostPolicy({ targetWorkspace: runDir, scratchRoot: scratch, evidenceRoot: evidence, codexPath, codexBinaryDigest: createHash('sha256').update(script).digest('hex'), authFilePath: authPath, authFileDigest: createHash('sha256').update('{}\n').digest('hex'), runtimeReadFiles, runtimeReadSubpaths, workerSchemaPath: schemaPath, workerSchemaDigest: createHash('sha256').update('{}\n').digest('hex') });
  const rollout = createManagedRolloutPolicy({ generation: ONE_SHOT_ROLLOUT_GENERATION_FLOOR, mode: gear === 'EXPLORE' ? 'explicit-explore-canary' : 'automatic-focus' });
  const capability = createManagedCapability({ ceilings: { waves: 1, calls: gear === 'EXPLORE' ? 9 : 3, refs: 256, reportBytes: 2_000_000, persistedBytes: 2_000_000 } });
  const docs = { input: request, policy: policyAsset, rollout, capability, host }; const paths = {};
  for (const [name, value] of Object.entries(docs)) { paths[name] = join(base, `${gear}-${name}.json`); await writeFile(paths[name], canonicalString(value)); }
  return { runDir, paths };
}

test('AUTO Focus and explicit Explore enter one root-bound managed START after attestation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'lunacy-managed-admission-'));
  try {
    for (const gear of ['FOCUS', 'EXPLORE']) {
      const fx = await managedFixture(base, gear);
      const result = runResolve(['--input', fx.paths.input, '--deliberation-policy', fx.paths.policy, '--rollout-policy', fx.paths.rollout, '--run-dir', fx.runDir, '--capability', fx.paths.capability, '--host-policy', fx.paths.host]);
      assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout); assert.equal(output.gear, gear, result.stdout); assert.equal(output.kind, 'DELIBERATION_REQUIRED');
      const state = (await new FileArtifactStore(fx.runDir).load()).state; assert.equal(state.schema, 2); assert.equal(state.journal.filter((entry) => entry.identity.eventId === 'resolve-plan:start').length, 1);
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});
