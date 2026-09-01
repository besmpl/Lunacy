import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { canonicalString, digest } from '../dist/canonical.js';
import { composeKernel } from '../dist/composition.js';
import { buildCodexArguments, createCodexDeliberationHostPolicy, createCodexHostPolicy } from '../dist/codex-host-policy.js';
import { authorPlan, compileWavePlan, deriveTopology } from '../dist/deliberation.js';
import { commandExecutionOwner, deriveExecutionPlane } from '../dist/execution-plane.js';
import { createManagedCapability, createManagedRolloutPolicy } from '../dist/managed-capability.js';
import { FileArtifactStore } from '../dist/store.js';
import { validatePlan } from '../dist/validator.js';

const ref = (id, value, scope) => ({ id, ...(scope ? { scope } : {}), digest: digest(value), bytes: canonicalString(value) });
const frames = [0, 1, 2, 3].map((index) => ({ frameId: `f${index}`, tag: 'code', text: `frame-${index}` }))
  .concat([{ frameId: 'wild', tag: 'wild', text: 'wild' }]);
const deliberationPolicy = {
  version: ref('policy', { generation: 1 }, 'policy'), frameCatalog: frames,
  maxMaterialDecisions: 4, maxSettlementBytes: 2_000_000, maxResolvedRoleInputBytes: 2_000_000,
  convergeCount: 3, nonObviousNovelty: 5, viableFloor: 5,
};
const capability = createManagedCapability({ ceilings: { waves: 1, calls: 4, refs: 256, reportBytes: 2_000_000, persistedBytes: 2_000_000 } });
const sharedObjects = process.report.getReport().sharedObjects.filter((path) => path.startsWith('/opt/homebrew/') || path.startsWith('/usr/local/'));
const linkedFiles = process.platform === 'darwin'
  ? sharedObjects.flatMap((object) => execFileSync('/usr/bin/otool', ['-L', object], { encoding: 'utf8' }).split('\n')
    .map((line) => line.trim().split(' ')[0]).filter((path) => !path?.endsWith(':') && (path?.startsWith('/opt/homebrew/') || path?.startsWith('/usr/local/'))))
  : [];
const runtimeReadFiles = [...new Set([process.execPath, ...(process.platform === 'darwin' ? ['/opt/homebrew/etc/openssl@3/openssl.cnf'] : []), ...linkedFiles, ...sharedObjects])];
const runtimeReadSubpaths = [...new Set([dirname(dirname(process.execPath)), ...linkedFiles.map(dirname)])];

function input(runId, eventId, event, snapshot, launchToken) {
  return {
    runId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}), event,
    identity: {
      runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0,
      authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0,
      eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}),
    },
  };
}

async function stableLoad(root) {
  const store = new FileArtifactStore(root);
  let prior = await store.load();
  for (let index = 0; index < 100; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = await store.load();
    if (current.generation === prior.generation) return current;
    prior = current;
  }
  throw new Error('artifact store did not become quiescent');
}

function focus(runId) {
  const authored = authorPlan({
    runId, phaseId: 'p1-routing', intent: ref('intent', { goal: 'choose implementation' }, 'intent'),
    evidenceSnapshot: ref('snapshot', { sealed: true }, 'snapshot'), authorityDigest: digest('authority'),
    policyVersion: deliberationPolicy.version, settlements: [],
  }, {
    decisionUnsettled: true, explicitExplore: false, citedWitness: false, planEquivalent: false,
    containedDiscovery: false, openEnded: false, highStakes: false, openlyPhrased: false,
    namedDiscriminator: true,
  }, deliberationPolicy);
  assert.equal(authored.kind, 'DELIBERATION_REQUIRED');
  const wave = JSON.parse(authored.wave.bytes);
  const plan = validatePlan(compileWavePlan(authored.wave, wave).value).plan;
  return { waveRef: authored.wave, wave, plan, topology: deriveTopology(authored.wave, wave) };
}

function decisionValue(runId, fx, state, tokenName, targetPlan) {
  const token = state.decisionTokens[tokenName];
  const result = { kind: 'COMPLETE_PLAN', plan: targetPlan };
  const selection = { generatorReport: token.orderedReportRefs[0], oneBasedOrdinal: 1 };
  const settlement = {
    schema: 'lunacy-deliberation-settlement/v1', authorshipInputDigest: token.authorshipInputDigest,
    decisionKey: token.decisionKey, frontierOrdinal: fx.wave.authorship.prospectiveEffectFrontierOrdinal,
    waveRef: fx.waveRef, orderedReportRefs: token.orderedReportRefs, basis: selection, dissent: { kind: 'NONE' },
    predecessors: [], selection, disposition: 'SELECTION', result, resultDigest: digest(result),
  };
  return { disposition: 'SELECTION', settlementRef: ref(`settlement:${runId}`, settlement, 'deliberation/settlement'), result };
}

async function hostFixture(runId, fx, targetPlan) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lunacy-p1-routing-root-')));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'lunacy-p1-routing-scratch-')));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), 'lunacy-p1-routing-evidence-')));
  const host = await realpath(await mkdtemp(join(tmpdir(), 'lunacy-p1-routing-host-')));
  const schemaPath = join(host, 'report-v2.schema.json'); const authFilePath = join(host, 'auth.json'); const codexPath = join(host, 'deterministic-codex.mjs');
  const script = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === '--version') { console.log('codex-cli 0.145.0'); process.exit(0); }\nconst canonical=(v)=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';\nconst at=process.argv.indexOf('--output-last-message');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',p=>input+=p);process.stdin.on('end',()=>{const role=JSON.parse(input);const wave=${JSON.stringify(fx.waveRef)};let report;if(role.kind==='GENERATOR'){const ordinal=role.lens.text==='counterexample'?0:1;report={schema:'lunacy-deliberation-report/v2',wave,slotOrdinal:ordinal,ideas:[{text:'idea-'+ordinal,rationale:'bounded rationale-'+ordinal}]};}else{const ideas=role.generators.map(bound=>({generatorReport:bound.ref,oneBasedOrdinal:1}));report={schema:'lunacy-deliberation-report/v2',wave,slotOrdinal:2,scores:ideas.map(idea=>({idea,novelty:8,viability:8,fit:8,evidence:[]})),clusters:[{label:'a',ideas:[ideas[0]]},{label:'b',ideas:[ideas[1]]},{label:'c',ideas:[]}]};}writeFileSync(process.argv[at+1],canonical(report),{mode:0o600});});\n`;
  await Promise.all([writeFile(schemaPath, '{}\n', { mode: 0o600 }), writeFile(authFilePath, '{}\n', { mode: 0o600 }), writeFile(codexPath, script, { mode: 0o700 })]);
  await chmod(codexPath, 0o700);
  const managedPolicy = createCodexDeliberationHostPolicy({
    targetWorkspace: root, scratchRoot: scratch, evidenceRoot: evidence, codexPath,
    codexBinaryDigest: createHash('sha256').update(script).digest('hex'), authFilePath,
    authFileDigest: createHash('sha256').update('{}\n').digest('hex'), runtimeReadFiles, runtimeReadSubpaths,
    workerSchemaPath: schemaPath, workerSchemaDigest: createHash('sha256').update('{}\n').digest('hex'),
  });
  const rollout = { policy: createManagedRolloutPolicy({ generation: 1, mode: 'focus-canary' }), wave: fx.waveRef, deliberationPolicy, decisionUnsettled: true };

  const workerSchema = join(host, 'ordinary-worker.schema.json'); await writeFile(workerSchema, '{}\n');
  const skillRoot = join(host, 'skill'); await mkdir(join(skillRoot, 'worker'), { recursive: true }); await writeFile(join(skillRoot, 'worker', 'ENGINEERING.md'), '# test\n');
  await Promise.all([writeFile(join(root, 'PLAN.md'), '# plan\n'), writeFile(join(root, 'DECISIONS.md'), '# decisions\n'), mkdir(join(root, 'phases', targetPlan.phaseId), { recursive: true })]);
  await writeFile(join(root, 'phases', targetPlan.phaseId, 'STEPS.md'), '# steps\n');
  const ordinaryPolicy = createCodexHostPolicy({ runId, planDigest: digest(validatePlan(targetPlan).plan), runRoot: root, workspace: root, skillRoot, codexPath: '/opt/homebrew/bin/codex', codexBinaryDigest: 'a'.repeat(64), workerSchemaPath: workerSchema, workerSchemaDigest: createHash('sha256').update('{}\n').digest('hex') });
  return { root, evidence, managedPolicy, rollout, ordinaryPolicy };
}

test('Focus adopts a distinct Plan and routes actual ordinary Sol/high policy work by command ownership', async () => {
  const runId = 'p1-focus-to-sol'; const fx = focus(runId);
  // Intentionally reuse a Wave step id: consumed Plan authority, not the name,
  // must classify this command as ordinary.
  const targetPlan = validatePlan({ phaseId: 'p1-routing', gateRequired: true, steps: [{ stepId: fx.topology.slots[0].stepId }, { stepId: 'ordinary-second', dependencies: [fx.topology.slots[0].stepId] }] }).plan;
  const host = await hostFixture(runId, fx, targetPlan);
  const launches = [];
  const ordinaryDriver = {
    hostPolicy: host.ordinaryPolicy,
    dispatch(command, launchToken) {
      const frame = { ...command, planDigest: host.ordinaryPolicy.planDigest };
      const args = buildCodexArguments(host.ordinaryPolicy, frame, host.ordinaryPolicy.defaultEffort, join(host.root, '.codex-effects', `${launchToken}.json`));
      launches.push({ command: structuredClone(command), model: args[args.indexOf('--model') + 1], effort: args.at(-1) });
      return { launchToken, commandDigest: command.commandDigest, ref: ref(`ordinary:${launchToken}`, { launched: true }, 'outbox/ordinary') };
    },
    observe(_token, _signal, _anchor, retained) { return retained ? undefined : undefined; },
  };
  const options = { plan: fx.plan, rootDir: host.root, workspace: host.root, maxInFlight: 1, driver: ordinaryDriver, managedCapability: capability, managedRollout: host.rollout, managedDeliberationPolicy: host.managedPolicy };
  let kernel = composeKernel(options);
  let yielded = await kernel.advance(input(runId, 'start', { kind: 'START', intentRef: ref('plan', fx.plan) }));
  assert.equal(yielded.snapshot.activeCount, 2, 'Focus generator plane owns width two independently of ordinary capacity one');
  const completed = new Set(); let serial = 0;
  while (yielded.kind !== 'DECISION_REQUIRED' && serial++ < 500) {
    const state = (await new FileArtifactStore(host.root).load()).state;
    const acked = Object.values(state.outbox).find((command) => command.roleView && command.state === 'ACKED' && !completed.has(command.commandId));
    if (acked) {
      const proof = JSON.parse(acked.receipt.bytes); completed.add(acked.commandId);
      const settled = await stableLoad(host.root);
      const acceptedCount = Object.keys(settled.state.managed.acceptedReports ?? {}).length;
      const refused = await kernel.advance(input(runId, `managed-done-refused-${serial}`, { kind: 'WORKER_ENVELOPE', ref: ref('wrong', { status: 'DONE' }) }, settled.state, acked.launchToken));
      assert.equal(refused.kind, 'BLOCKED');
      const afterRefusal = await new FileArtifactStore(host.root).load();
      assert.equal(afterRefusal.state.journal.some((entry) => entry.identity.eventId === `managed-done-refused-${serial}`), false);
      assert.equal(Object.keys(afterRefusal.state.managed.acceptedReports ?? {}).length, acceptedCount);
      assert.equal(afterRefusal.state.outbox[acked.commandId].state, 'ACKED');
      yielded = await kernel.advance(input(runId, `report-${serial}`, { kind: 'WORKER_ENVELOPE', ref: proof.receipt }, state, acked.launchToken));
    } else if (Object.values(state.outbox).some((command) => command.state === 'CLAIMED')) await new Promise((resolve) => setTimeout(resolve, 20));
    else { yielded = await kernel.advance(input(runId, `resume-wave-${serial}`, { kind: 'RESUME' }, state)); await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.equal(yielded.kind, 'DECISION_REQUIRED');
  let loaded = await new FileArtifactStore(host.root).load();
  const adopted = await kernel.advance(input(runId, 'adopt-distinct', { kind: 'PARENT_DECISION', token: yielded.token, value: decisionValue(runId, fx, loaded.state, yielded.token, targetPlan) }, loaded.state));
  assert.equal(adopted.kind, 'WAITING');
  loaded = await new FileArtifactStore(host.root).load();
  assert.equal(deriveExecutionPlane(loaded.state), 'POST_PLAN');
  const ordinary = Object.values(loaded.state.outbox).find((command) => command.attemptEpoch === loaded.state.attemptEpoch);
  assert.ok(ordinary); assert.equal(commandExecutionOwner(loaded.state, ordinary), 'ORDINARY'); assert.equal(ordinary.roleView, undefined);
  assert.equal(loaded.state.managed.reservations[ordinary.commandId], undefined); assert.equal(loaded.state.managed.attempts[ordinary.commandId], undefined);
  assert.equal(adopted.snapshot.activeCount, 1, 'ordinary capacity is restored immediately after Plan adoption');

  // A restart without an ordinary driver fails before claim and never calls
  // the retained deliberation provider.
  kernel = composeKernel({ ...options, plan: targetPlan, driver: undefined });
  const noDriver = await kernel.advance(input(runId, 'resume-no-ordinary', { kind: 'RESUME' }, loaded.state));
  assert.equal(noDriver.kind, 'BLOCKED'); assert.equal(noDriver.code, 'HumanReceiptRequired', noDriver.reason);
  loaded = await new FileArtifactStore(host.root).load();
  assert.equal(Object.values(loaded.state.outbox).find((command) => command.commandId === ordinary.commandId).state, 'PENDING');
  // Recompose after restart with the actual ordinary host-policy fixture.
  kernel = composeKernel({ ...options, plan: targetPlan });
  yielded = await kernel.advance(input(runId, 'resume-ordinary-1', { kind: 'RESUME' }, loaded.state));
  loaded = await new FileArtifactStore(host.root).load();
  const ackedOrdinary = Object.values(loaded.state.outbox).find((command) => command.attemptEpoch === loaded.state.attemptEpoch && command.state === 'ACKED');
  assert.ok(ackedOrdinary); assert.equal(launches[0].model, 'gpt-5.6-sol'); assert.equal(launches[0].effort, 'model_reasoning_effort="high"');
  loaded = await stableLoad(host.root);
  const refusedReport = await kernel.advance(input(runId, 'ordinary-report-refused', { kind: 'WORKER_ENVELOPE', ref: ref('wrong-report', { schema: 'lunacy-deliberation-report/v2', wave: fx.waveRef, slotOrdinal: 0, ideas: [] }) }, loaded.state, ackedOrdinary.launchToken));
  assert.equal(refusedReport.kind, 'BLOCKED');
  const afterOrdinaryRefusal = await new FileArtifactStore(host.root).load();
  assert.equal(afterOrdinaryRefusal.state.journal.some((entry) => entry.identity.eventId === 'ordinary-report-refused'), false);
  assert.equal(afterOrdinaryRefusal.state.outbox[ackedOrdinary.commandId].state, 'ACKED');
  yielded = await kernel.advance(input(runId, 'ordinary-done-1', { kind: 'WORKER_ENVELOPE', ref: ref('done-1', { status: 'DONE' }) }, loaded.state, ackedOrdinary.launchToken));
  loaded = await new FileArtifactStore(host.root).load();
  yielded = await kernel.advance(input(runId, 'resume-ordinary-2', { kind: 'RESUME' }, loaded.state));
  loaded = await new FileArtifactStore(host.root).load();
  const second = Object.values(loaded.state.outbox).find((command) => command.attemptEpoch === loaded.state.attemptEpoch && command.state === 'ACKED' && command.commandId !== ackedOrdinary.commandId);
  assert.ok(second);
  yielded = await kernel.advance(input(runId, 'ordinary-done-2', { kind: 'WORKER_ENVELOPE', ref: ref('done-2', { status: 'DONE' }) }, loaded.state, second.launchToken));
  assert.equal(yielded.kind, 'FINAL'); assert.equal(yielded.status, 'phase-ready'); assert.equal(yielded.snapshot.gate, 'DUE');
  assert.equal(launches.length, 2); assert.ok(launches.every((launch) => launch.model === 'gpt-5.6-sol' && launch.effort === 'model_reasoning_effort="high"'));
});
