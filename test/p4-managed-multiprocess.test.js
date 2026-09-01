import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { canonicalString, digest } from '../dist/canonical.js';
import { createCodexDeliberationHostPolicy, createCodexHostPolicy } from '../dist/codex-host-policy.js';
import { compileWavePlan, deliberationPolicyFromAsset, policyVersionForAsset } from '../dist/deliberation.js';
import { createManagedCapability, createManagedRolloutPolicy } from '../dist/managed-capability.js';
import { ONE_SHOT_ROLLOUT_GENERATION_FLOOR } from '../dist/one-shot.js';
import { resolveTypedPrePlan } from '../dist/pre-plan-request.js';
import { FileArtifactStore } from '../dist/store.js';
import { validatePlan } from '../dist/validator.js';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const bridgeCli = process.env.LUNACY_BRIDGE_CLI ?? join(repoRoot, 'dist/bridge-cli.js');
const assetPath = join(repoRoot, 'assets/deliberation-policy/036186605438d7e4275e81b95d3e86b5cd72c3836ce3bad0668296a90f1f0da0.json');
const asset = JSON.parse(await readFile(assetPath, 'utf8'));
const policyVersion = policyVersionForAsset(asset).value;
const ref = (id, value, scope) => ({ id, ...(scope ? { scope } : {}), digest: digest(value), bytes: canonicalString(value) });
const sharedObjects = process.report.getReport().sharedObjects.filter((path) => path.startsWith('/opt/homebrew/') || path.startsWith('/usr/local/'));
const linkedFiles = process.platform === 'darwin'
  ? sharedObjects.flatMap((object) => execFileSync('/usr/bin/otool', ['-L', object], { encoding: 'utf8' }).split('\n')
    .map((line) => line.trim().split(' ')[0]).filter((path) => !path?.endsWith(':') && (path?.startsWith('/opt/homebrew/') || path?.startsWith('/usr/local/'))))
  : [];
const runtimeReadFiles = [...new Set([process.execPath, ...(process.platform === 'darwin' ? ['/opt/homebrew/etc/openssl@3/openssl.cnf'] : []), ...linkedFiles, ...sharedObjects])];
const runtimeReadSubpaths = [...new Set([dirname(dirname(process.execPath)), ...linkedFiles.map(dirname)])];

function run(args, timeout = 30_000) {
  const result = spawnSync(process.execPath, [bridgeCli, ...args], { cwd: repoRoot, encoding: 'utf8', timeout });
  assert.equal(result.status, 0, `${args[0]} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.notEqual(result.stdout, '', `${args[0]} returned no output\nstderr: ${result.stderr}\nsignal: ${result.signal}`);
  return JSON.parse(result.stdout);
}

function managedFlags(paths) {
  return ['--managed-capability', paths.capability, '--managed-rollout', paths.rollout, '--managed-deliberation-policy', paths.asset, '--managed-host-policy', paths.host];
}

function decisionValue(runId, waveRef, wave, state, tokenName, targetPlan) {
  const token = state.decisionTokens[tokenName];
  const result = { kind: 'COMPLETE_PLAN', plan: targetPlan };
  const selection = { generatorReport: token.orderedReportRefs[0], oneBasedOrdinal: 1 };
  const settlement = {
    schema: 'lunacy-deliberation-settlement/v1', authorshipInputDigest: token.authorshipInputDigest,
    decisionKey: token.decisionKey, frontierOrdinal: wave.authorship.prospectiveEffectFrontierOrdinal,
    waveRef, orderedReportRefs: token.orderedReportRefs, basis: selection, dissent: { kind: 'NONE' },
    predecessors: [], selection, disposition: 'SELECTION', result, resultDigest: digest(result),
  };
  return { disposition: 'SELECTION', settlementRef: ref(`settlement:${runId}`, settlement, 'deliberation/settlement'), result };
}

test('built CLI reconstructs retained managed composition across processes and adopts a distinct ordinary Plan', { timeout: 60_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lunacy-managed-multiprocess-root-')));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'lunacy-managed-multiprocess-scratch-')));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), 'lunacy-managed-multiprocess-evidence-')));
  const hostDir = await realpath(await mkdtemp(join(tmpdir(), 'lunacy-managed-multiprocess-host-')));
  const runId = 'managed-multiprocess';
  const targetPlan = validatePlan({ schema: 'lunacy-plan-v1', phaseId: 'p1', steps: [{ stepId: 'ordinary-deliver' }] }).plan;
  const request = {
    mode: 'AUTO',
    authorship: {
      runId, phaseId: 'p1', intent: ref('intent', targetPlan, 'intent'),
      evidenceSnapshot: ref('snapshot', { evidence: [], constraints: [] }, 'snapshot'),
      authorityDigest: digest('authority'), policyVersion, settlements: [],
    },
    frontier: [{ key: 'boundary', prospectiveEffectFrontierOrdinal: 0, status: 'UNSETTLED', discriminator: 'Which exact boundary owns restart-safe composition?', context: { problem: 'Choose the production composition seam.', decisionImpact: 'This controls durable restart behavior.', evidence: [], constraints: [] } }],
  };
  const policy = deliberationPolicyFromAsset(asset, policyVersion);
  assert.equal(policy.ok, true);
  const authored = resolveTypedPrePlan(request, policy.value);
  assert.equal(authored.kind, 'DELIBERATION_REQUIRED');
  const waveRef = authored.wave; const wave = JSON.parse(waveRef.bytes);
  const compiled = compileWavePlan(waveRef, wave); assert.equal(compiled.ok, true);
  const wavePlan = validatePlan(compiled.value).plan;

  const logPath = join(root, 'provider-log.jsonl');
  const codexPath = join(hostDir, 'deterministic-codex.mjs');
  const script = `#!${process.execPath}\nimport { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\nimport { dirname, join } from 'node:path';\nif (process.argv[2] === '--version') { console.log('codex-cli 0.145.0'); process.exit(0); }\nconst canonical=(v)=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';\nconst at=process.argv.indexOf('--output-last-message');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',p=>input+=p);process.stdin.on('end',()=>{let role;try{role=JSON.parse(input);}catch{}if(role&&typeof role.kind==='string'){const wave=${JSON.stringify(waveRef)};let report;if(role.kind==='GENERATOR'){const ordinal=role.lens.text==='counterexample'?0:1;const retainedRoute=process.argv.includes('gpt-5.6-luna')&&process.argv.includes('model_reasoning_effort="max"');const bridgeLock=existsSync(join(${JSON.stringify(root)},'.kernel','.bridge.lock'));report={schema:'lunacy-deliberation-report/v2',wave,slotOrdinal:ordinal,ideas:[{text:'candidate-'+ordinal+'-retained-route-'+retainedRoute+'-bridge-lock-'+bridgeLock,rationale:'bounded rationale-'+ordinal}]};}else{const ideas=role.generators.map(bound=>({generatorReport:bound.ref,oneBasedOrdinal:1}));report={schema:'lunacy-deliberation-report/v2',wave,slotOrdinal:2,scores:ideas.map((idea,index)=>({idea,novelty:8-index,viability:9,fit:8,evidence:[]})),clusters:[{label:'a',ideas:[ideas[0]]},{label:'b',ideas:[ideas[1]]}]};}writeFileSync(process.argv[at+1],canonical(report),{mode:0o600});return;}const match=input.match(/^Report: (.+)\\.$/m);if(!match)process.exit(82);const reportPath=match[1];mkdirSync(dirname(reportPath),{recursive:true});const report='## Control\\nStatus: PASS\\nACCEPTED-PROOF\\nACCEPTED-RISK\\n';writeFileSync(reportPath,report);const reportDigest=createHash('sha256').update(report).digest('hex');appendFileSync(${JSON.stringify(logPath)},canonical({kind:'ordinary',argv:process.argv.slice(2),handoff:input,bridgeLock:existsSync(join(${JSON.stringify(root)},'.kernel','.bridge.lock'))})+'\\n');writeFileSync(process.argv[at+1],canonical({status:'PASS',reportPath,reportDigest}),{mode:0o600});});\n`;
  await writeFile(codexPath, script, { mode: 0o700 }); await chmod(codexPath, 0o700);
  const schemaPath = join(hostDir, 'schema.json'); const authPath = join(hostDir, 'auth.json');
  await Promise.all([writeFile(schemaPath, '{}\n', { mode: 0o600 }), writeFile(authPath, '{}\n', { mode: 0o600 })]);
  const managedHost = createCodexDeliberationHostPolicy({ targetWorkspace: root, scratchRoot: scratch, evidenceRoot: evidence, codexPath, codexBinaryDigest: createHash('sha256').update(script).digest('hex'), authFilePath: authPath, authFileDigest: createHash('sha256').update('{}\n').digest('hex'), runtimeReadFiles, runtimeReadSubpaths, workerSchemaPath: schemaPath, workerSchemaDigest: createHash('sha256').update('{}\n').digest('hex') });
  const rollout = createManagedRolloutPolicy({ generation: ONE_SHOT_ROLLOUT_GENERATION_FLOOR, mode: 'automatic-focus' });
  const capability = createManagedCapability({ ceilings: { waves: 1, calls: 3, refs: 256, reportBytes: 2_000_000, persistedBytes: 2_000_000 } });
  const paths = { request: join(hostDir, 'request.json'), asset: join(hostDir, 'asset.json'), rollout: join(hostDir, 'rollout.json'), capability: join(hostDir, 'capability.json'), host: join(hostDir, 'host.json'), wavePlan: join(hostDir, 'wave-plan.json'), targetPlan: join(hostDir, 'target-plan.json'), wavePolicy: join(hostDir, 'wave-policy.json'), targetPolicy: join(hostDir, 'target-policy.json'), inbox: join(hostDir, 'inbox.json'), decision: join(hostDir, 'decision.json') };
  for (const [path, value] of [[paths.request, request], [paths.asset, asset], [paths.rollout, rollout], [paths.capability, capability], [paths.host, managedHost], [paths.wavePlan, wavePlan], [paths.targetPlan, targetPlan]]) await writeFile(path, canonicalString(value));

  const skillRoot = join(hostDir, 'skill'); await mkdir(join(skillRoot, 'worker'), { recursive: true });
  await writeFile(join(skillRoot, 'worker', 'ENGINEERING.md'), '# Engineering\n');
  await mkdir(join(root, 'phases', 'p1'), { recursive: true });
  await Promise.all([writeFile(join(root, 'PLAN.md'), 'ADOPTED-PLAN\nACCEPTED-PROOF\nACCEPTED-RISK\n'), writeFile(join(root, 'DECISIONS.md'), 'ACCEPTED-DECISION\n'), writeFile(join(root, 'phases', 'p1', 'STEPS.md'), '# Steps\n')]);
  const policyBase = { runId, runRoot: root, workspace: root, skillRoot, codexPath, codexBinaryDigest: createHash('sha256').update(script).digest('hex'), workerSchemaPath: schemaPath, workerSchemaDigest: createHash('sha256').update('{}\n').digest('hex') };
  const wavePolicy = createCodexHostPolicy({ ...policyBase, planDigest: digest(wavePlan) });
  const targetPolicy = createCodexHostPolicy({ ...policyBase, planDigest: digest(targetPlan) });
  await Promise.all([writeFile(paths.wavePolicy, canonicalString(wavePolicy)), writeFile(paths.targetPolicy, canonicalString(targetPolicy))]);

  const resolved = run(['resolve-plan', '--input', paths.request, '--deliberation-policy', paths.asset, '--rollout-policy', paths.rollout, '--run-dir', root, '--capability', paths.capability, '--host-policy', paths.host]);
  assert.equal(resolved.start.kind, 'WAITING');
  let state = (await new FileArtifactStore(root).load()).state;
  assert.equal(state.journal.filter((row) => row.identity.eventId === 'resolve-plan:start').length, 1);

  const driven = run(['drive', '--run-dir', root, '--run-id', runId, '--mode', 'runtime', '--plan', paths.wavePlan, '--policy', paths.wavePolicy, ...managedFlags(paths)], 45_000);
  assert.equal(driven.yield.kind, 'DECISION_REQUIRED');
  state = (await new FileArtifactStore(root).load()).state;
  assert.equal(Object.keys(state.managed.acceptedReports).length, 3);
  const generatorReports = Object.values(state.managed.acceptedReports).map((accepted) => accepted.report).filter((report) => Array.isArray(report.ideas));
  assert.equal(generatorReports.length, 2);
  for (const report of generatorReports) assert.match(report.ideas[0].text, /retained-route-true-bridge-lock-false$/);
  const token = driven.yield.token;
  const inboxList = run(['inbox', '--run-root', root, '--run-id', runId, '--token', token, '--policy-digest', digest(targetPolicy)]);
  assert.equal(inboxList.entries[0].status, 'READY');
  await writeFile(paths.inbox, canonicalString(inboxList.entries[0]));
  const value = decisionValue(runId, waveRef, wave, state, token, targetPlan); await writeFile(paths.decision, canonicalString(value));

  const submitted = run(['submit-decision', '--inbox', paths.inbox, '--plan', paths.targetPlan, '--run-root', root, '--run-id', runId, '--token', token, '--value', canonicalString(value), '--policy', paths.targetPolicy, ...managedFlags(paths)], 45_000);
  assert.equal(submitted.status, 'committed');
  state = (await new FileArtifactStore(root).load()).state;
  assert.equal(state.planDigest, digest(targetPlan));
  assert.equal(state.gate, 'DUE');
  const launches = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(launches.length, 1);
  assert.ok(launches[0].argv.includes('gpt-5.6-sol'));
  assert.ok(launches[0].argv.includes('model_reasoning_effort="high"'));
  assert.equal(launches[0].bridgeLock, false, 'provider entry must occur after the bridge lock is released');
  assert.match(launches[0].handoff, /PLAN\.md/);
});
