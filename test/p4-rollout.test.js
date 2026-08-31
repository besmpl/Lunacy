import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { connect as connectTcp } from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalString, digest } from '../dist/canonical.js';
import { authorPlan, compileWavePlan, deriveTopology } from '../dist/deliberation.js';
import {
  createManagedCapability, createManagedRolloutPolicy, managedRolloutDecision,
  verifyManagedRolloutPolicy,
} from '../dist/managed-capability.js';
import { applyAuthorityAdoption, applyManagedRolloutPolicy, applyParentDecision, createInitialState } from '../dist/reducer.js';
import { makeComposedKernel, makeRunKernel } from '../dist/public.js';
import { FileArtifactStore, MemoryArtifactStore } from '../dist/store.js';
import { AccelerationMetrics } from '../dist/metrics.js';
import { buildCodexDeliberationArguments, buildCodexDeliberationIsolationProfile, createCodexDeliberationHostPolicy, validateCodexDeliberationHostPolicy } from '../dist/codex-host-policy.js';
import * as composition from '../dist/composition.js';
import { CodexDeliberationDriver } from '../dist/codex-deliberation-driver.js';

const { composeKernel } = composition;
const TEST_AUTH_BYTES = '{}\n';
const TEST_NODE_SHARED_OBJECTS = process.report.getReport().sharedObjects.filter((path) => path.startsWith('/opt/homebrew/') || path.startsWith('/usr/local/'));
const TEST_NODE_LINKED_FILES = process.platform === 'darwin'
  ? TEST_NODE_SHARED_OBJECTS.flatMap((object) => execFileSync('/usr/bin/otool', ['-L', object], { encoding: 'utf8' }).split('\n').map((line) => line.trim().split(' ')[0]).filter((path) => !path?.endsWith(':') && (path?.startsWith('/opt/homebrew/') || path?.startsWith('/usr/local/'))))
  : [];
const TEST_NODE_RUNTIME_FILES = [...new Set([
  process.execPath,
  ...(process.platform === 'darwin' ? ['/opt/homebrew/etc/openssl@3/openssl.cnf'] : []),
  ...TEST_NODE_LINKED_FILES,
  ...TEST_NODE_SHARED_OBJECTS,
])];
const TEST_NODE_RUNTIME_SUBPATHS = [...new Set([dirname(dirname(process.execPath)), ...TEST_NODE_LINKED_FILES.map(dirname)])];

const ref = (id, value, scope) => ({ id, ...(scope ? { scope } : {}), digest: digest(value), bytes: canonicalString(value) });
const capability = createManagedCapability({ ceilings: { waves: 1, calls: 4, refs: 128, reportBytes: 1_000_000, persistedBytes: 1_000_000 } });
const frames = [0, 1, 2, 3].map((i) => ({ frameId: `f${i}`, tag: 'code', text: `frame-${i}` })).concat([{ frameId: 'wild', tag: 'wild', text: 'wild' }]);
const deliberationPolicy = { version: ref('policy', { generation: 1 }, 'policy'), frameCatalog: frames, maxMaterialDecisions: 4, maxSettlementBytes: 1_000_000, maxResolvedRoleInputBytes: 1_000_000, convergeCount: 3, nonObviousNovelty: 5, viableFloor: 5 };

function focusFixture(runId = 'p4-focus') {
  const authored = authorPlan({ runId, phaseId: 'p4', intent: ref('intent', { goal: 'choose' }, 'intent'), evidenceSnapshot: ref('snapshot', { sealed: true }, 'snapshot'), authorityDigest: digest('authority'), policyVersion: deliberationPolicy.version, settlements: [] }, {
    decisionUnsettled: true, explicitExplore: false, citedWitness: false, planEquivalent: false,
    containedDiscovery: false, openEnded: false, highStakes: false, openlyPhrased: false, namedDiscriminator: true,
  }, deliberationPolicy);
  assert.equal(authored.kind, 'DELIBERATION_REQUIRED');
  const wave = JSON.parse(authored.wave.bytes);
  const compiled = compileWavePlan(authored.wave, wave);
  assert.equal(compiled.ok, true);
  return { wave: authored.wave, plan: compiled.value };
}

function exploreFixture(runId = 'p4-explore') {
  const authored = authorPlan({ runId, phaseId: 'p4', intent: ref('intent', { goal: 'explore' }, 'intent'), evidenceSnapshot: ref('snapshot', { sealed: true }, 'snapshot'), authorityDigest: digest('authority'), policyVersion: deliberationPolicy.version, settlements: [] }, {
    decisionUnsettled: true, explicitExplore: true, citedWitness: false, planEquivalent: false,
    containedDiscovery: false, openEnded: true, highStakes: true, openlyPhrased: true, namedDiscriminator: false,
  }, deliberationPolicy);
  assert.equal(authored.kind, 'DELIBERATION_REQUIRED');
  const wave = JSON.parse(authored.wave.bytes);
  const compiled = compileWavePlan(authored.wave, wave);
  assert.equal(compiled.ok, true);
  return { wave: authored.wave, parsedWave: wave, topology: deriveTopology(authored.wave, wave), plan: compiled.value };
}

function reportRef(report) {
  const reportDigest = digest(report);
  return { id: `report:${reportDigest.slice(0, 16)}`, scope: 'deliberation/report', digest: reportDigest, bytes: canonicalString(report) };
}

function pendingCommand(runId, stepId) {
  const commandId = digest({ runId, phaseId: 'p4', stepId, attemptEpoch: 0 }).slice(0, 32);
  const launchToken = `launch-${commandId}`;
  return { commandId, runId, phaseId: 'p4', stepId, attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0, launchToken, commandDigest: digest({ commandId, runId, phaseId: 'p4', stepId, attemptEpoch: 0, launchToken }), state: 'PENDING' };
}

function acceptedRow(runId, report, index) {
  const acceptedRef = reportRef(report);
  const owner = pendingCommand(runId, `accepted-${index}`);
  owner.state = 'ACKED';
  return { owner, row: { ref: acceptedRef, report, commandId: owner.commandId, receipt: { commandDigest: owner.commandDigest, resultDigest: acceptedRef.digest, attemptEpoch: 0 }, attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0 } };
}

function preparationState(runId, planDigest, waveRef, target, accepted = []) {
  const outbox = { [target.commandId]: target };
  const acceptedReports = {};
  for (const item of accepted) { outbox[item.owner.commandId] = item.owner; acceptedReports[item.row.ref.digest] = item.row; }
  return { schema: 2, runId, phaseId: 'p4', revision: 0, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0, modeEpoch: 0, writerFence: 'writer', status: 'ACTIVE', gate: 'NOT-DUE', barrier: 'OPEN', steps: {}, outbox, processed: {}, decisionTokens: {}, planDigest, nextAction: 'dispatch-outbox', journal: [], managed: { proposal: { key: digest('proposal'), leaseSetId: 'lease', planDigest, waveRef, roleWaveRef: waveRef }, acceptedReports } };
}

function start(runId, plan) {
  const event = { kind: 'START', intentRef: ref('plan', plan) };
  return { runId, event, identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'start', payloadDigest: digest(event) } };
}

const d1Facts = Object.freeze({ gear: 'FOCUS', synthetic: false, disposable: false, effectDenied: true, oneDecisionKey: true, staticTopology: true, childDelegation: false, claimsOrEffects: false, sealedEvidenceOnly: true, explicitExplore: false, decisionUnsettled: true, openEnded: false, highStakes: false, openlyPhrased: false });

test('rollout policies are closed, content-addressed, and exact replay is inert', () => {
  const shadow = createManagedRolloutPolicy({ generation: 7, mode: 'shadow' });
  assert.equal(verifyManagedRolloutPolicy(shadow), true);
  assert.throws(() => createManagedRolloutPolicy({ ...shadow, mode: 'focus-canary' }), /digest mismatch/);
  const initial = createInitialState('rollout-state', { phaseId: 'p4', steps: [{ stepId: 's' }] }, digest({ phaseId: 'p4', steps: [{ stepId: 's' }] }), 'none');
  const first = applyManagedRolloutPolicy(initial, capability, shadow);
  assert.deepEqual(applyManagedRolloutPolicy(first, capability, shadow).managed.rollout, first.managed.rollout);
  assert.throws(() => applyManagedRolloutPolicy(first, capability, createManagedRolloutPolicy({ generation: 6, mode: 'disabled' })), /regressed/);
  assert.throws(() => applyManagedRolloutPolicy(first, capability, createManagedRolloutPolicy({ generation: 7, mode: 'disabled' })), /conflicts/);
  const rollback = applyManagedRolloutPolicy(first, capability, createManagedRolloutPolicy({ generation: 8, mode: 'disabled' }));
  assert.equal(rollback.managed.rollout.mode, 'disabled');
});

test('D0-D4 corridor is exact and never promotes implicit Explore early', () => {
  const decision = (mode, facts = d1Facts) => managedRolloutDecision(createManagedRolloutPolicy({ generation: 1, mode }), capability, facts);
  assert.equal(decision('disabled').admitted, false);
  assert.equal(decision('shadow', { ...d1Facts, synthetic: true, disposable: true }).authorityDenied, true);
  assert.equal(decision('shadow').admitted, false);
  assert.equal(decision('focus-canary').reason, 'D1_CORRIDOR');
  const explore = { ...d1Facts, gear: 'EXPLORE', explicitExplore: true };
  assert.equal(decision('focus-canary', explore).admitted, false);
  assert.equal(decision('explicit-explore-canary', explore).reason, 'D2_EXPLICIT');
  for (const mode of ['explicit-explore-canary', 'automatic-focus', 'automatic-explore']) {
    assert.equal(decision(mode, { ...explore, decisionUnsettled: false }).admitted, false, `${mode} must reject a settled explicit Explore decision`);
  }
  assert.equal(decision('automatic-focus', { ...explore, explicitExplore: false, openEnded: true, highStakes: true, openlyPhrased: true }).admitted, false);
  assert.equal(decision('automatic-explore', { ...explore, explicitExplore: false, openEnded: true, highStakes: true, openlyPhrased: true }).reason, 'D4_EXPLORE');
  assert.equal(decision('automatic-explore', { ...explore, explicitExplore: false, openEnded: true, highStakes: true, openlyPhrased: false }).admitted, false);
});

test('installed D3 profile enters eligible Focus at generation 1 and advances an existing run by exactly one', async () => {
  const fixture = focusFixture('p4-d3-profile');
  const root = await mkdtemp(join(tmpdir(), 'p4-d3-profile-'));
  try {
    const firstPolicy = createManagedRolloutPolicy({ generation: 1, mode: 'automatic-focus' });
    const rollout = { policy: firstPolicy, wave: fixture.wave, deliberationPolicy, decisionUnsettled: true };
    const first = await makeRunKernel({ plan: fixture.plan, rootDir: root, managedCapability: capability, managedRollout: rollout }).advance(start('p4-d3-profile', fixture.plan));
    assert.equal(first.kind, 'WAITING');
    let state = (await new FileArtifactStore(root).load()).state;
    assert.deepEqual(state.managed.rollout, { generation: 1, mode: 'automatic-focus', digest: firstPolicy.digest });

    const nextPolicy = createManagedRolloutPolicy({ generation: state.managed.rollout.generation + 1, mode: 'automatic-focus' });
    const event = { kind: 'RESUME' };
    await makeRunKernel({ plan: fixture.plan, rootDir: root, managedCapability: capability, managedRollout: { ...rollout, policy: nextPolicy } }).advance({
      runId: 'p4-d3-profile', expectedRevision: first.snapshot.revision, event,
      identity: { runId: 'p4-d3-profile', phaseId: 'run', stepId: 'run', attemptEpoch: first.snapshot.attemptEpoch, authorityEpoch: first.snapshot.authorityEpoch, barrierEpoch: first.snapshot.barrierEpoch, eventId: 'resume-d3', payloadDigest: digest(event) },
    });
    state = (await new FileArtifactStore(root).load()).state;
    assert.deepEqual(state.managed.rollout, { generation: 2, mode: 'automatic-focus', digest: nextPolicy.digest });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('omitted, explicit disabled, and Direct rollout preserve schema-1 public bytes', async () => {
  const plan = { phaseId: 'p4-direct', steps: [{ stepId: 'only' }] };
  const cases = [
    {},
    { managedCapability: capability, managedRollout: { policy: createManagedRolloutPolicy({ generation: 1, mode: 'disabled' }) } },
    { managedCapability: capability, managedRollout: { policy: createManagedRolloutPolicy({ generation: 1, mode: 'automatic-explore' }) } },
  ];
  let expected;
  for (let index = 0; index < cases.length; index += 1) {
    const root = await mkdtemp(join(tmpdir(), 'p4-direct-'));
    try {
      const value = await makeRunKernel({ plan, rootDir: root, ...cases[index] }).advance(start('same-direct-run', plan));
      expected ??= canonicalString(value);
      assert.equal(canonicalString(value), expected);
      const state = (await new FileArtifactStore(root).load()).state;
      assert.equal(state.schema, 1);
      assert.equal(state.managed, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('shadow admission persists policy projection and mechanically denies authority', async () => {
  const fixture = focusFixture('p4-shadow');
  const root = await mkdtemp(join(tmpdir(), 'p4-shadow-'));
  try {
    const rollout = { policy: createManagedRolloutPolicy({ generation: 3, mode: 'shadow' }), wave: fixture.wave, deliberationPolicy, synthetic: true, disposable: true, decisionUnsettled: true };
    const yielded = await makeRunKernel({ plan: fixture.plan, rootDir: root, managedCapability: capability, managedRollout: rollout }).advance(start('p4-shadow', fixture.plan));
    assert.equal(yielded.kind, 'WAITING');
    const state = (await new FileArtifactStore(root).load()).state;
    assert.deepEqual(state.managed.rollout, { generation: 3, mode: 'shadow', digest: rollout.policy.digest });
    state.decisionTokens.shadow = { kind: 'DELIBERATION', consumed: false, identity: digest('token') };
    assert.equal(applyParentDecision(state, { runId: state.runId, phaseId: state.phaseId, stepId: 'run', attemptEpoch: state.attemptEpoch, authorityEpoch: state.authorityEpoch, barrierEpoch: state.barrierEpoch, eventId: 'decision', payloadDigest: digest('decision') }, 'shadow', { disposition: 'SELECTION' }).reason, 'managed shadow denies parent decision');
    state.decisionTokens.adopt = { kind: 'AUTHORITY_ADOPTION', consumed: false, identity: digest('adopt'), expectedDigest: state.planDigest, observedDigest: state.planDigest, targetDigest: state.planDigest };
    assert.equal(applyAuthorityAdoption(state, { runId: state.runId, phaseId: state.phaseId, stepId: 'run', attemptEpoch: state.attemptEpoch, authorityEpoch: state.authorityEpoch, barrierEpoch: state.barrierEpoch, eventId: 'adopt', payloadDigest: digest('adopt') }, 'adopt', { kind: 'ADOPT', digest: state.planDigest }, fixture.plan, state.planDigest).reason, 'managed shadow denies authority adoption');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('newer disabled generation revokes an existing D3 cohort before resume work', async () => {
  const fixture = focusFixture('p4-rollback');
  const root = await mkdtemp(join(tmpdir(), 'p4-rollback-'));
  try {
    const enabled = { policy: createManagedRolloutPolicy({ generation: 10, mode: 'automatic-focus' }), wave: fixture.wave, deliberationPolicy, decisionUnsettled: true };
    const first = await makeRunKernel({ plan: fixture.plan, rootDir: root, managedCapability: capability, managedRollout: enabled }).advance(start('p4-rollback', fixture.plan));
    assert.equal(first.kind, 'WAITING');
    const event = { kind: 'RESUME' };
    const disabled = { policy: createManagedRolloutPolicy({ generation: 11, mode: 'disabled' }) };
    const stopped = await makeRunKernel({ plan: fixture.plan, rootDir: root, managedCapability: capability, managedRollout: disabled }).advance({ runId: 'p4-rollback', expectedRevision: first.snapshot.revision, event, identity: { runId: 'p4-rollback', phaseId: 'run', stepId: 'run', attemptEpoch: first.snapshot.attemptEpoch, authorityEpoch: first.snapshot.authorityEpoch, barrierEpoch: first.snapshot.barrierEpoch, eventId: 'resume', payloadDigest: digest(event) } });
    assert.equal(stopped.kind, 'BLOCKED');
    const state = (await new FileArtifactStore(root).load()).state;
    assert.equal(state.managed.rollout.generation, 11);
    assert.equal(state.managed.rollout.mode, 'disabled');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deliberation host branch is exact Luna/max, isolated, network-denied, and has no fallback/add-dir', () => {
  const policy = createCodexDeliberationHostPolicy({ targetWorkspace: '/tmp/lunacy-target', scratchRoot: '/tmp/lunacy-deliberation-scratch', evidenceRoot: '/tmp/lunacy-deliberation-evidence', codexPath: '/opt/codex', codexBinaryDigest: 'a'.repeat(64), authFilePath: '/opt/auth.json', authFileDigest: 'c'.repeat(64), workerSchemaPath: '/opt/report-v2.schema.json', workerSchemaDigest: 'b'.repeat(64) });
  assert.deepEqual(validateCodexDeliberationHostPolicy(policy), policy);
  const args = buildCodexDeliberationArguments(policy, '/tmp/lunacy-deliberation-scratch/attempt-test/result.json');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-luna');
  assert.equal(args.includes('model_reasoning_effort="max"'), true);
  assert.equal(args.some((arg) => arg.includes('model_reasoning_effort="xhigh"') || arg.includes('model_reasoning_effort="high"')), false);
  assert.equal(args.includes('sandbox_workspace_write.network_access=false'), true);
  assert.equal(args.includes('--add-dir'), false);
  assert.equal(args.includes('/tmp/lunacy-target'), false);
  assert.equal(args[args.indexOf('--cd') + 1], '/tmp/lunacy-deliberation-scratch/attempt-test');
  assert.equal(policy.fallback, false);
  assert.equal(policy.readIsolation, 'darwin-seatbelt/v1');
  const isolation = buildCodexDeliberationIsolationProfile(policy, '/tmp/lunacy-deliberation-scratch/attempt-test');
  assert.match(isolation, /^\(version 1\)\n\(deny default\)/);
  assert.doesNotMatch(isolation, /\/tmp\/lunacy-target/);
  assert.doesNotMatch(isolation, /allow process-fork|com\.apple\.FSEvents/);
  assert.doesNotMatch(isolation, /configd|mDNSResponder|remote tcp "\*:443"|\(subpath "\/(?:System|usr\/lib|usr\/share|Library\/Apple|private\/etc)"\)/);
  assert.match(isolation, /remote tcp "localhost:1"/);
  assert.throws(() => createCodexDeliberationHostPolicy({ ...policy, effort: 'xhigh' }), /profile is invalid/);
  assert.throws(() => createCodexDeliberationHostPolicy({ ...policy, effort: 'high' }), /profile is invalid/);
  assert.throws(() => createCodexDeliberationHostPolicy({ ...policy, scratchRoot: '/tmp/lunacy-target/scratch' }), /isolated/);
  assert.throws(() => createCodexDeliberationHostPolicy({ ...policy, runtimeReadFiles: ['/Users/shared-runtime'] }), /sealed native runtime prefix/);
  assert.throws(() => createCodexDeliberationHostPolicy({ ...policy, runtimeReadSubpaths: ['/opt/homebrew'] }), /narrow versioned runtime subtree/);
  assert.throws(() => buildCodexDeliberationIsolationProfile(policy, '/tmp/lunacy-deliberation-scratch/attempt-test', 0), /transport port/);
});

test('managed composition constructs only a real attested Codex driver and preserves legacy routing/replay', async () => {
  const fixture = focusFixture('p4-managed-host');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p4-managed-host-')));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'p4-managed-scratch-')));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), 'p4-managed-evidence-')));
  const host = await realpath(await mkdtemp(join(tmpdir(), 'p4-managed-provider-')));
  const schemaPath = join(host, 'report-v2.schema.json');
  const codexPath = join(host, 'deterministic-codex.mjs');
  const authFilePath = join(host, 'auth.json');
  const report = { schema: 'lunacy-deliberation-report/v2', wave: fixture.wave, slotOrdinal: 0, ideas: [{ text: 'attested idea', rationale: 'deterministic test capability' }] };
  const reportBytes = canonicalString(report);
  const script = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === '--version') { console.log('codex-cli 0.145.0'); process.exit(0); }\nconst at = process.argv.indexOf('--output-last-message');\nif (at < 0) process.exit(2);\nprocess.stdin.resume();\nprocess.stdin.on('end', () => writeFileSync(process.argv[at + 1], ${JSON.stringify(reportBytes)}, { mode: 0o600 }));\n`;
  await writeFile(schemaPath, '{}\n', { mode: 0o600 });
  await writeFile(authFilePath, TEST_AUTH_BYTES, { mode: 0o600 });
  await writeFile(codexPath, script, { mode: 0o700 });
  await chmod(codexPath, 0o700);
  const rollout = { policy: createManagedRolloutPolicy({ generation: 1, mode: 'focus-canary' }), wave: fixture.wave, deliberationPolicy, decisionUnsettled: true };
  let legacyCalls = 0;
  const legacy = { dispatch() { legacyCalls += 1; throw new Error('legacy action driver must not enter managed Wave'); } };
  const profile = createCodexDeliberationHostPolicy({ targetWorkspace: root, scratchRoot: scratch, evidenceRoot: evidence, codexPath, codexBinaryDigest: createHash('sha256').update(script).digest('hex'), authFilePath, authFileDigest: createHash('sha256').update(TEST_AUTH_BYTES).digest('hex'), runtimeReadFiles: TEST_NODE_RUNTIME_FILES, runtimeReadSubpaths: TEST_NODE_RUNTIME_SUBPATHS, workerSchemaPath: schemaPath, workerSchemaDigest: createHash('sha256').update('{}\n').digest('hex') });
  try {
    assert.equal(Object.prototype.hasOwnProperty.call(composition, 'bindManagedDeliberationDriver'), false);
    assert.throws(() => composeKernel({ plan: fixture.plan, rootDir: root, workspace: root, driver: legacy, managedCapability: capability, managedRollout: rollout }), /host policy is unavailable/);
    assert.throws(() => composeKernel({ plan: fixture.plan, rootDir: root, driver: legacy, managedDeliberationPolicy: profile, managedCapability: capability, managedRollout: rollout }), /target workspace is required/);
    assert.throws(() => composeKernel({ plan: fixture.plan, rootDir: root, workspace: scratch, driver: legacy, managedDeliberationPolicy: profile, managedCapability: capability, managedRollout: rollout }), /target workspace mismatch/);
    assert.throws(() => composeKernel({ plan: fixture.plan, rootDir: root, workspace: root, driver: legacy, managedDeliberationPolicy: createCodexDeliberationHostPolicy({ ...profile, codexPath: '/definitely/not/codex' }), managedCapability: capability, managedRollout: rollout }), /host identity is unavailable/);

    const kernel = composeKernel({ plan: fixture.plan, rootDir: root, workspace: root, driver: legacy, managedDeliberationPolicy: profile, managedCapability: capability, managedRollout: rollout });
    const yielded = await kernel.advance(start('p4-managed-host', fixture.plan));
    if (yielded.kind !== 'BLOCKED') {
      const event = { kind: 'RESUME' };
      await kernel.advance({ runId: 'p4-managed-host', expectedRevision: yielded.snapshot.revision, event, identity: { runId: 'p4-managed-host', phaseId: 'run', stepId: 'run', attemptEpoch: yielded.snapshot.attemptEpoch, authorityEpoch: yielded.snapshot.authorityEpoch, barrierEpoch: yielded.snapshot.barrierEpoch, eventId: 'resume', payloadDigest: digest(event) } });
    }
    for (let index = 0; index < 500 && !(await readdir(evidence)).some((name) => name.endsWith('.receipt.json')); index += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(legacyCalls, 0);
    assert.equal((await readdir(evidence)).some((name) => name.endsWith('.receipt.json')), true);
    let loaded;
    for (let index = 0; index < 500; index += 1) {
      loaded = await new FileArtifactStore(root).load();
      if (Object.values(loaded.state?.managed?.attempts ?? {}).some((attempt) => attempt.authorityAnchor)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const state = loaded.state;
    const command = Object.values(state.outbox)[0];
    const attempt = state.managed.attempts[command.commandId];
    const authorityAnchor = attempt.authorityAnchor;
    assert.equal(authorityAnchor.scope, 'outbox/managed-receipt-authority');
    assert.equal(authorityAnchor.digest, digest(JSON.parse(authorityAnchor.bytes)));
    assert.deepEqual(JSON.parse(command.receipt.bytes).authorityAnchor, authorityAnchor);
    assert.equal(state.managed.leaseSets[state.managed.proposal.leaseSetId].closedRefGraph.some((item) => canonicalString(item) === canonicalString(authorityAnchor)), true);
    assert.deepEqual(Object.keys(JSON.parse(command.roleView.bytes)).sort(), ['constraints', 'contract', 'decisionImpact', 'evidence', 'kind', 'lens', 'question']);
    assert.equal((await readdir(scratch)).some((name) => name.startsWith('attempt-')), false);
    const replay = await new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy }).observe(command.launchToken, undefined, authorityAnchor);
    assert.equal(replay?.commandDigest, command.commandDigest);
    assert.equal(replay?.ref.digest, digest(report));
    assert.deepEqual(replay?.authorityAnchor, authorityAnchor);

    const claimed = { ...command, state: 'CLAIMED' };
    await assert.rejects(() => new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy }).dispatch(claimed, claimed.launchToken), /already has durable evidence/);
    const receiptName = (await readdir(evidence)).find((name) => name.endsWith('.receipt.json'));
    assert.equal(typeof receiptName, 'string');
    const receiptPath = join(evidence, receiptName);
    const receiptBytes = await readFile(receiptPath, 'utf8');
    const receipt = JSON.parse(receiptBytes);
    assert.equal(profile.effort, 'max');
    assert.equal(receipt.attestation.policyDigest, digest(profile));
    const oldXhighPolicyDigest = digest({ ...profile, effort: 'xhigh' });
    await writeFile(receiptPath, canonicalString({ ...receipt, attestation: { ...receipt.attestation, policyDigest: oldXhighPolicyDigest } }), { mode: 0o600 });
    assert.equal(await new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy }).observe(command.launchToken), undefined);
    await writeFile(receiptPath, canonicalString({ ...receipt, argvDigest: '0'.repeat(64) }), { mode: 0o600 });
    assert.equal(await new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy }).observe(command.launchToken), undefined);
    const transportSummary = JSON.parse(receipt.transport.bytes);
    const transportMutations = [
      { ...transportSummary, totalConnections: transportSummary.totalConnections + 1 },
      { ...transportSummary, bytesUp: transportSummary.bytesUp + 1 },
      { ...transportSummary, listener: { ...transportSummary.listener, port: transportSummary.listener.port === 65535 ? 65534 : transportSummary.listener.port + 1 } },
      { ...transportSummary, policyDigest: '0'.repeat(64) },
    ];
    for (const mutation of transportMutations) {
      const bytes = canonicalString(mutation); const transportDigest = digest(mutation);
      const rewritten = { id: `model-transport:${transportDigest}`, scope: 'outbox/model-transport', digest: transportDigest, bytes };
      await writeFile(receiptPath, canonicalString({ ...receipt, transport: rewritten }), { mode: 0o600 });
      assert.equal(await new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy }).observe(command.launchToken), undefined);
    }
    const transportName = (await readdir(evidence)).find((name) => name.endsWith('.transport.json'));
    assert.equal(typeof transportName, 'string');
    const transportPath = join(evidence, transportName);
    const rewrittenSummary = transportMutations[0]; const rewrittenBytes = canonicalString(rewrittenSummary); const rewrittenDigest = digest(rewrittenSummary);
    await writeFile(transportPath, rewrittenBytes, { mode: 0o600 });
    await writeFile(receiptPath, canonicalString({ ...receipt, transport: { id: `model-transport:${rewrittenDigest}`, scope: 'outbox/model-transport', digest: rewrittenDigest, bytes: rewrittenBytes } }), { mode: 0o600 });
    assert.equal(await new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy }).observe(command.launchToken), undefined);
    await writeFile(transportPath, receipt.transport.bytes, { mode: 0o600 });
    await writeFile(receiptPath, receiptBytes, { mode: 0o600 });
    assert.equal((await new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy }).observe(command.launchToken, undefined, authorityAnchor))?.commandDigest, command.commandDigest);

    // A coordinated rewrite of all sibling evidence remains self-consistent,
    // but cannot move the authority already accepted by RunKernel CAS.
    const teardownName = (await readdir(evidence)).find((name) => name.endsWith('.teardown.json'));
    assert.equal(typeof teardownName, 'string');
    const teardownPath = join(evidence, teardownName);
    const teardownBytes = await readFile(teardownPath, 'utf8');
    const rewrittenValidSummary = transportMutations[1];
    const rewrittenValidBytes = canonicalString(rewrittenValidSummary);
    const rewrittenValidDigest = digest(rewrittenValidSummary);
    const rewrittenTransport = { id: `model-transport:${rewrittenValidDigest}`, scope: 'outbox/model-transport', digest: rewrittenValidDigest, bytes: rewrittenValidBytes };
    const rewrittenTeardownValue = { ...JSON.parse(teardownBytes), transportDigest: rewrittenValidDigest };
    const rewrittenTeardownBytes = canonicalString(rewrittenTeardownValue);
    const rewrittenTeardown = { id: `teardown:${digest(rewrittenTeardownValue)}`, scope: 'outbox/teardown', digest: digest(rewrittenTeardownValue), bytes: rewrittenTeardownBytes };
    const rewrittenReceipt = { ...receipt, transport: rewrittenTransport, teardown: rewrittenTeardown };
    await writeFile(transportPath, rewrittenValidBytes, { mode: 0o600 });
    await writeFile(teardownPath, rewrittenTeardownBytes, { mode: 0o600 });
    await writeFile(receiptPath, canonicalString(rewrittenReceipt), { mode: 0o600 });
    const evidenceOnlyReplay = await new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy }).observe(command.launchToken);
    assert.notEqual(evidenceOnlyReplay?.authorityAnchor.digest, authorityAnchor.digest);
    assert.equal(await new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy }).observe(command.launchToken, undefined, authorityAnchor), undefined);

    // Even a fully coordinated candidate state cannot rewrite an anchor from
    // its accepted generation: the store transition itself is append-only.
    const divergent = structuredClone(state);
    const divergentProof = { ...JSON.parse(divergent.outbox[command.commandId].receipt.bytes), authorityAnchor: evidenceOnlyReplay.authorityAnchor };
    const divergentProofBytes = canonicalString(divergentProof);
    const divergentReceipt = { ...divergent.outbox[command.commandId].receipt, digest: digest(divergentProof), bytes: divergentProofBytes };
    divergent.outbox[command.commandId].receipt = divergentReceipt;
    divergent.managed.attempts[command.commandId].receipt = divergentReceipt;
    divergent.managed.attempts[command.commandId].resultDigest = divergentReceipt.digest;
    divergent.managed.attempts[command.commandId].authorityAnchor = evidenceOnlyReplay.authorityAnchor;
    const proposalLease = divergent.managed.leaseSets[divergent.managed.proposal.leaseSetId];
    proposalLease.closedRefGraph = proposalLease.closedRefGraph.map((item) => canonicalString(item) === canonicalString(authorityAnchor) ? evidenceOnlyReplay.authorityAnchor : item);
    await assert.rejects(() => new FileArtifactStore(root).commit(loaded.generation, divergent), /authority anchor changed/);

    const missing = structuredClone(state);
    delete missing.managed.attempts[command.commandId].authorityAnchor;
    await assert.rejects(() => new FileArtifactStore(root).commit(loaded.generation, missing), /ManifestMismatch/);
    const memory = new MemoryArtifactStore();
    const proposal = state.managed.proposal;
    const proposalGraph = state.managed.leaseSets[proposal.leaseSetId].closedRefGraph;
    await memory.acquirePublicationLease(proposal.leaseSetId, proposalGraph, 1);
    await memory.commit(0, state);
    const memoryLoaded = await memory.load();
    const memoryMissing = structuredClone(memoryLoaded.state);
    delete memoryMissing.managed.attempts[command.commandId].authorityAnchor;
    await assert.rejects(() => memory.commit(memoryLoaded.generation, memoryMissing), /ManifestMismatch/);
    const cas = await Promise.allSettled([
      memory.commit(memoryLoaded.generation, structuredClone(memoryLoaded.state)),
      memory.commit(memoryLoaded.generation, structuredClone(memoryLoaded.state)),
    ]);
    assert.equal(cas.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(cas.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await memory.collectPublicationLeases(Date.now() + 1_000)).removed, 0);
    assert.deepEqual((await memory.load()).state.managed.attempts[command.commandId].authorityAnchor, authorityAnchor);

    await writeFile(transportPath, receipt.transport.bytes, { mode: 0o600 });
    await writeFile(teardownPath, teardownBytes, { mode: 0o600 });
    await writeFile(receiptPath, receiptBytes, { mode: 0o600 });
    assert.deepEqual((await new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy }).observe(command.launchToken, undefined, authorityAnchor))?.authorityAnchor, authorityAnchor);

    const workerEvent = { kind: 'WORKER_ENVELOPE', ref: replay.ref };
    await kernel.advance({
      runId: state.runId, expectedRevision: state.revision, event: workerEvent,
      identity: {
        runId: state.runId, phaseId: 'run', stepId: 'run', attemptEpoch: state.attemptEpoch,
        authorityEpoch: state.authorityEpoch, barrierEpoch: state.barrierEpoch,
        eventId: 'authority-anchored-worker', payloadDigest: digest(workerEvent), launchToken: command.launchToken,
      },
    });
    const acceptedState = (await new FileArtifactStore(root).load()).state;
    const accepted = acceptedState.managed.acceptedReports[replay.ref.digest];
    assert.deepEqual(accepted.authorityAnchor, authorityAnchor);
    assert.equal(accepted.receipt.authorityAnchorDigest, authorityAnchor.digest);
    const wrongBinary = createCodexDeliberationHostPolicy({ ...profile, codexBinaryDigest: 'a'.repeat(64) });
    await assert.rejects(() => new CodexDeliberationDriver({ policy: wrongBinary, wave: fixture.wave, deliberationPolicy }).dispatch(claimed, claimed.launchToken), /executable digest changed/);
    const wrongSchema = createCodexDeliberationHostPolicy({ ...profile, workerSchemaDigest: 'b'.repeat(64) });
    await assert.rejects(() => new CodexDeliberationDriver({ policy: wrongSchema, wave: fixture.wave, deliberationPolicy }).dispatch(claimed, claimed.launchToken), /worker schema digest changed/);
    assert.throws(() => createCodexDeliberationHostPolicy({ ...profile, model: 'gpt-5.6-sol' }), /profile is invalid/);

    const directPlan = { phaseId: 'p4-direct-driver', steps: [{ stepId: 'only' }] };
    let directCalls = 0;
    const directKernel = composeKernel({ plan: directPlan, rootDir: `${root}-direct`, driver: { dispatch() { directCalls += 1; throw new Error('legacy direct probe'); } } });
    const directStart = await directKernel.advance(start('p4-direct-driver', directPlan));
    const directResume = { kind: 'RESUME' };
    await directKernel.advance({ runId: 'p4-direct-driver', expectedRevision: directStart.snapshot.revision, event: directResume, identity: { runId: 'p4-direct-driver', phaseId: 'run', stepId: 'run', attemptEpoch: directStart.snapshot.attemptEpoch, authorityEpoch: directStart.snapshot.authorityEpoch, barrierEpoch: directStart.snapshot.barrierEpoch, eventId: 'resume', payloadDigest: digest(directResume) } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(directCalls > 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
    await rm(evidence, { recursive: true, force: true });
    await rm(host, { recursive: true, force: true });
    await rm(`${root}-direct`, { recursive: true, force: true });
  }
});

test('managed provider receives exact role views for every role with predecessor binding, isolated concurrency, and durable recovery', async () => {
  const fixture = exploreFixture('p4-role-isolation');
  const target = await realpath(await mkdtemp(join(tmpdir(), 'p4-role-target-')));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'p4-role-scratch-')));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), 'p4-role-evidence-')));
  const host = await realpath(await mkdtemp(join(tmpdir(), 'p4-role-host-')));
  const schemaPath = join(host, 'report-v2.schema.json');
  const codexPath = join(host, 'role-codex.mjs');
  const authFilePath = join(host, 'auth.json');
  await writeFile(join(target, 'private-target'), 'target-secret', { mode: 0o600 });
  await mkdir(join(scratch, 'attempt-forbidden-sibling'), { mode: 0o700 });
  await writeFile(join(scratch, 'attempt-forbidden-sibling', 'private-marker'), 'sibling-secret', { mode: 0o600 });
  const script = `#!${process.execPath}\nimport { readFileSync, readdirSync, writeFileSync } from 'node:fs';\nif (process.argv[2] === '--version') { console.log('codex-cli 0.145.0'); process.exit(0); }\nconst canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';\nconst at = process.argv.indexOf('--output-last-message');\nlet input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (part) => { input += part; });\nprocess.stdin.on('end', () => {\n  const attempts = [\n    () => readFileSync(${JSON.stringify(join(target, 'private-target'))}, 'utf8'),\n    () => readdirSync(${JSON.stringify(evidence)}),\n    () => readdirSync(${JSON.stringify(scratch)}),\n    () => readFileSync(${JSON.stringify(join(scratch, 'attempt-forbidden-sibling', 'private-marker'))}, 'utf8'),\n  ];\n  for (const attempt of attempts) { try { attempt(); process.exit(90); } catch (error) { if (error?.code !== 'EPERM') process.exit(91); } }\n  const role = JSON.parse(input); const wave = ${JSON.stringify(fixture.wave)}; let report;\n  if (role.kind === 'GENERATOR') {\n    const frames = ['frame-0', 'frame-1', 'frame-2', 'frame-3', 'wild']; const slotOrdinal = frames.indexOf(role.lens.text);\n    report = { schema: 'lunacy-deliberation-report/v2', wave, slotOrdinal, ideas: Array.from({ length: 6 }, (_, index) => ({ text: 'idea-' + slotOrdinal + '-' + (index + 1), rationale: 'rationale-' + slotOrdinal + '-' + (index + 1) })) };\n  } else if (role.kind === 'CRITIC') {\n    const locators = role.generators.flatMap((bound) => bound.report.ideas.map((_, index) => ({ generatorReport: bound.ref, oneBasedOrdinal: index + 1 })));\n    report = { schema: 'lunacy-deliberation-report/v2', wave, slotOrdinal: 5, scores: locators.map((idea, index) => ({ idea, novelty: 10 - (index % 4), viability: 9 - (index % 3), fit: 8 - (index % 2), evidence: [] })), clusters: [{ label: 'a', ideas: locators.slice(0, 10) }, { label: 'b', ideas: locators.slice(10, 20) }, { label: 'c', ideas: locators.slice(20) }] };\n  } else report = { schema: 'lunacy-deliberation-report/v2', wave, slotOrdinal: 6, sketch: 'One sentence. Two sentence. Three sentence. Four sentence.', loadBearingRisk: 'risk', firstConcreteStep: 'first', childIdeas: ['one', 'two', 'three'] };\n  const finish = () => writeFileSync(process.argv[at + 1], canonical(report), { mode: 0o600 });\n  if (role.lens?.text === 'frame-2') setTimeout(finish, 5000); else setTimeout(finish, 100);\n});\n`;
  await writeFile(schemaPath, '{}\n', { mode: 0o600 });
  await writeFile(authFilePath, TEST_AUTH_BYTES, { mode: 0o600 });
  await writeFile(codexPath, script, { mode: 0o700 });
  await chmod(codexPath, 0o700);
  const profile = createCodexDeliberationHostPolicy({ targetWorkspace: target, scratchRoot: scratch, evidenceRoot: evidence, codexPath, codexBinaryDigest: createHash('sha256').update(script).digest('hex'), authFilePath, authFileDigest: createHash('sha256').update(TEST_AUTH_BYTES).digest('hex'), runtimeReadFiles: TEST_NODE_RUNTIME_FILES, runtimeReadSubpaths: TEST_NODE_RUNTIME_SUBPATHS, workerSchemaPath: schemaPath, workerSchemaDigest: createHash('sha256').update('{}\n').digest('hex') });
  const driver = new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy });
  const planDigest = digest(fixture.plan);
  const generatorReports = fixture.topology.slots.slice(0, 5).map((slot) => ({
    schema: 'lunacy-deliberation-report/v2', wave: fixture.wave, slotOrdinal: slot.slotOrdinal,
    ideas: Array.from({ length: 6 }, (_, index) => ({ text: `idea-${slot.slotOrdinal}-${index + 1}`, rationale: `rationale-${slot.slotOrdinal}-${index + 1}` })),
  }));
  const generatorRows = generatorReports.map((report, index) => acceptedRow('p4-role-isolation', report, index));
  const locators = generatorReports.flatMap((report) => report.ideas.map((_, index) => {
    const full = reportRef(report);
    return { generatorReport: { id: full.id, scope: full.scope, digest: full.digest }, oneBasedOrdinal: index + 1 };
  }));
  const criticReport = {
    schema: 'lunacy-deliberation-report/v2', wave: fixture.wave, slotOrdinal: 5,
    scores: locators.map((idea, index) => ({ idea, novelty: 10 - (index % 4), viability: 9 - (index % 3), fit: 8 - (index % 2), evidence: [] })),
    clusters: [
      { label: 'a', ideas: locators.slice(0, 10) },
      { label: 'b', ideas: locators.slice(10, 20) },
      { label: 'c', ideas: locators.slice(20) },
    ],
  };
  const criticRow = acceptedRow('p4-role-isolation', criticReport, 5);
  const deepenerReport = { schema: 'lunacy-deliberation-report/v2', wave: fixture.wave, slotOrdinal: 6, sketch: 'One sentence. Two sentence. Three sentence. Four sentence.', loadBearingRisk: 'risk', firstConcreteStep: 'first', childIdeas: ['one', 'two', 'three'] };
  try {
    const generatorCommands = fixture.topology.slots.slice(0, 2).map((slot) => pendingCommand('p4-role-isolation', slot.stepId));
    for (const command of generatorCommands) driver.prepare(command, preparationState('p4-role-isolation', planDigest, fixture.wave, command));
    const criticCommand = pendingCommand('p4-role-isolation', fixture.topology.slots[5].stepId);
    driver.prepare(criticCommand, preparationState('p4-role-isolation', planDigest, fixture.wave, criticCommand, generatorRows));
    const deepenerCommand = pendingCommand('p4-role-isolation', fixture.topology.slots[6].stepId);
    driver.prepare(deepenerCommand, preparationState('p4-role-isolation', planDigest, fixture.wave, deepenerCommand, [...generatorRows, criticRow]));
    const cancelCommand = pendingCommand('p4-role-isolation', fixture.topology.slots[2].stepId);
    driver.prepare(cancelCommand, preparationState('p4-role-isolation', planDigest, fixture.wave, cancelCommand));

    assert.deepEqual(generatorCommands.map((command) => JSON.parse(command.roleView.bytes).kind), ['GENERATOR', 'GENERATOR']);
    assert.equal(JSON.parse(criticCommand.roleView.bytes).generators.length, 5);
    assert.equal(JSON.parse(deepenerCommand.roleView.bytes).critic.report.slotOrdinal, 5);
    assert.equal(criticCommand.predecessorReportDigests.length, 5);
    assert.deepEqual(deepenerCommand.predecessorReportDigests, [criticRow.row.ref.digest]);
    for (const command of [...generatorCommands, criticCommand, deepenerCommand]) {
      const role = JSON.parse(command.roleView.bytes);
      assert.equal(Object.prototype.hasOwnProperty.call(role, 'wave'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(role, 'authorship'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(role, 'generatorLenses'), false);
    }
    const recursivelyForbidden = (value) => {
      if (!value || typeof value !== 'object') return false;
      if (Object.keys(value).some((key) => ['bytes', 'authorship', 'authorityDigest', 'gear', 'generatorLenses'].includes(key))) return true;
      return Object.values(value).some(recursivelyForbidden);
    };
    assert.equal(recursivelyForbidden(JSON.parse(criticCommand.roleView.bytes).generators), false);
    assert.equal(recursivelyForbidden(JSON.parse(deepenerCommand.roleView.bytes).critic), false);

    const missing = pendingCommand('p4-role-isolation', fixture.topology.slots[5].stepId);
    assert.throws(() => driver.prepare(missing, preparationState('p4-role-isolation', planDigest, fixture.wave, missing, generatorRows.slice(0, 4))), /requires exactly one accepted predecessor/);

    const claimed = (command) => ({ ...command, state: 'CLAIMED' });
    const generatorReceipts = await Promise.all(generatorCommands.map((command) => driver.dispatch(claimed(command), command.launchToken)));
    const criticReceipt = await driver.dispatch(claimed(criticCommand), criticCommand.launchToken);
    const deepenerReceipt = await driver.dispatch(claimed(deepenerCommand), deepenerCommand.launchToken);
    assert.equal(new Set([...generatorReceipts, criticReceipt, deepenerReceipt].map((receipt) => receipt.ref.id)).size, 4);
    for (const command of [...generatorCommands, criticCommand, deepenerCommand]) {
      assert.equal((await driver.observe(command.launchToken))?.commandDigest, command.commandDigest);
      assert.equal((await driver.observeTeardown(command.launchToken, command.commandDigest))?.scope, 'outbox/teardown');
    }
    assert.deepEqual((await readdir(scratch)).filter((name) => name.startsWith('attempt-') && name !== 'attempt-forbidden-sibling'), []);
    assert.equal((await readdir(evidence)).filter((name) => name.endsWith('.receipt.json')).length, 4);
    assert.equal((await readdir(evidence)).filter((name) => name.endsWith('.teardown.json')).length, 4);

    const controller = new AbortController();
    const cancelled = driver.dispatch(claimed(cancelCommand), cancelCommand.launchToken, controller.signal);
    for (let index = 0; index < 200 && !(await readdir(scratch)).some((name) => name.startsWith('attempt-') && name !== 'attempt-forbidden-sibling'); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    assert.equal((await readdir(scratch)).some((name) => name.startsWith('attempt-') && name !== 'attempt-forbidden-sibling'), false);
    assert.equal(await driver.observe(cancelCommand.launchToken), undefined);
    assert.equal((await driver.observeTeardown(cancelCommand.launchToken, cancelCommand.commandDigest))?.scope, 'outbox/teardown');

    const targetReceipt = (await readdir(evidence)).find((name) => name.includes(digest(deepenerCommand.launchToken)) && name.endsWith('.receipt.json'));
    assert.equal(typeof targetReceipt, 'string');
    const receiptPath = join(evidence, targetReceipt);
    const receiptBytes = await readFile(receiptPath, 'utf8');
    const receipt = JSON.parse(receiptBytes);
    await writeFile(receiptPath, canonicalString({ ...receipt, roleView: { ...receipt.roleView, digest: '0'.repeat(64) } }), { mode: 0o600 });
    assert.equal(await driver.observe(deepenerCommand.launchToken), undefined);
    const wrongReportDigest = digest(generatorReports[0]);
    await writeFile(receiptPath, canonicalString({ ...receipt, report: { id: `managed-report:${receipt.roleView.digest}:${wrongReportDigest}`, scope: 'deliberation/report', digest: wrongReportDigest, bytes: canonicalString(generatorReports[0]) } }), { mode: 0o600 });
    assert.equal(await driver.observe(deepenerCommand.launchToken), undefined);
    await writeFile(receiptPath, receiptBytes, { mode: 0o600 });
  } finally {
    await Promise.all([target, scratch, evidence, host].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test('sealed provider denies unrelated reads, credential env, tools, and detached descendants before teardown', async () => {
  const fixture = focusFixture('p4-sealed-provider');
  const target = await realpath(await mkdtemp(join(tmpdir(), 'p4-sealed-target-')));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'p4-sealed-scratch-')));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), 'p4-sealed-evidence-')));
  const host = await realpath(await mkdtemp(join(tmpdir(), 'p4-sealed-host-')));
  const unrelated = await realpath(await mkdtemp(join(tmpdir(), 'p4-sealed-unrelated-')));
  const schemaPath = join(host, 'report-v2.schema.json');
  const codexPath = join(host, 'sealed-codex.mjs');
  const authFilePath = join(host, 'auth.json');
  const sibling = join(scratch, 'attempt-forbidden-sibling');
  const lateMarker = join(unrelated, 'detached-descendant-ran');
  await mkdir(sibling, { mode: 0o700 });
  const forbidden = [
    join(target, 'private-target'),
    join(evidence, 'private-evidence'),
    join(scratch, 'private-parent'),
    join(sibling, 'private-sibling'),
    join(unrelated, 'private-unrelated'),
    authFilePath,
    '/private/etc/passwd',
    '/private/etc/ssh/ssh_config',
    '/usr/share/misc/flowers',
    '/System/Library/CoreServices/SystemVersion.plist',
    '/opt/homebrew/etc/openssl@3/ct_log_list.cnf',
  ];
  for (const path of forbidden.slice(0, 5)) await writeFile(path, 'private', { mode: 0o600 });
  await writeFile(schemaPath, '{}\n', { mode: 0o600 });
  await writeFile(authFilePath, TEST_AUTH_BYTES, { mode: 0o600 });
  const report = { schema: 'lunacy-deliberation-report/v2', wave: { id: fixture.wave.id, digest: fixture.wave.digest, scope: fixture.wave.scope }, slotOrdinal: 0, ideas: [{ text: 'sealed idea', rationale: 'closed capability' }] };
  const script = [
    `#!${process.execPath}`,
    `import { readFileSync, writeFileSync } from 'node:fs';`,
    `import { spawnSync } from 'node:child_process';`,
    `import { connect } from 'node:net';`,
    `if (process.argv[2] === '--version') { console.log('codex-cli 0.145.0'); process.exit(0); }`,
    `const expectedEnv = ['CODEX_HOME', 'HOME', 'HTTPS_PROXY', 'NO_COLOR', 'SSL_CERT_FILE'];`,
    `if (Object.keys(process.env).sort().join(',') !== expectedEnv.join(',')) process.exit(80);`,
    `if (['OPENAI_API_KEY', 'CODEX_AUTH_TOKEN', 'CHATGPT_API_KEY'].some((name) => Object.hasOwn(process.env, name))) process.exit(81);`,
    `for (const path of ${JSON.stringify(forbidden)}) {`,
    `  try { readFileSync(path); process.exit(82); } catch (error) { if (error?.code !== 'EPERM') process.exit(83); }`,
    `}`,
    `const at = process.argv.indexOf('--output-last-message');`,
    `let input = ''; process.stdin.setEncoding('utf8');`,
    `process.stdin.on('data', (part) => { input += part; });`,
    `const proxy = new URL(process.env.HTTPS_PROXY);`,
    `const proxyRequest = (line) => new Promise((resolve, reject) => {`,
    `  let response = ''; const socket = connect({ host: proxy.hostname, port: Number(proxy.port) });`,
    `  socket.setTimeout(3000, () => socket.destroy(new Error('proxy timeout')));`,
    `  socket.on('connect', () => socket.end(line + '\\r\\nHost: chatgpt.com:443\\r\\n\\r\\n'));`,
    `  socket.on('data', (chunk) => { response += chunk; }); socket.on('end', () => resolve(response)); socket.on('error', reject);`,
    `});`,
    `const partialRequest = (waitForTimeout) => new Promise((resolve, reject) => {`,
    `  const socket = connect({ host: proxy.hostname, port: Number(proxy.port) }); let settled = false;`,
    `  const done = () => { if (settled) return; settled = true; clearTimeout(deadline); resolve(); };`,
    `  const deadline = setTimeout(() => { socket.destroy(); reject(new Error('partial request did not settle')); }, 1500);`,
    `  socket.on('close', done); socket.on('error', done);`,
    `  socket.on('connect', () => { socket.write('CONNECT chatgpt.com:443 HTTP/1.1\\r\\n'); if (!waitForTimeout) setTimeout(() => socket.destroy(), 20); });`,
    `});`,
    `const handlerErrorRequest = () => new Promise((resolve) => {`,
    `  const socket = connect({ host: proxy.hostname, port: Number(proxy.port) });`,
    `  socket.on('error', () => resolve()); socket.on('close', () => resolve());`,
    `  socket.on('connect', () => { socket.write('CONNECT chatgpt.com:443 HTTP/1.1\\r\\n'); socket.destroy(new Error('intentional reset')); });`,
    `});`,
    `const directDenied = () => new Promise((resolve) => {`,
    `  const socket = connect({ host: '93.184.216.34', port: 443 }); socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });`,
    `  socket.on('connect', () => { socket.destroy(); resolve(false); }); socket.on('error', (error) => resolve(['EPERM', 'EACCES'].includes(error?.code)));`,
    `});`,
    `process.stdin.on('end', async () => {`,
    `  const abuse = await Promise.all([proxyRequest('CONNECT example.com:443 HTTP/1.1'), proxyRequest('CONNECT chatgpt.com:444 HTTP/1.1'), proxyRequest('GET https://chatgpt.com/ HTTP/1.1')]);`,
    `  if (abuse.some((response) => !response.startsWith('HTTP/1.1 403 Forbidden'))) process.exit(87);`,
    `  await Promise.all([partialRequest(false), partialRequest(true), handlerErrorRequest()]);`,
    `  if (!await directDenied()) process.exit(88);`,
    `  const child = spawnSync('/bin/sh', ['-c', ${JSON.stringify(`sleep 0.05; printf late > ${lateMarker}`)}], { detached: true, stdio: 'ignore' });`,
    `  if (!child.error || !['EPERM', 'EACCES'].includes(child.error.code)) process.exit(85);`,
    `  if (JSON.parse(input).kind !== 'GENERATOR') process.exit(86);`,
    `  writeFileSync(process.argv[at + 1], ${JSON.stringify(canonicalString(report))}, { mode: 0o600 });`,
    `});`,
    '',
  ].join('\n');
  await writeFile(codexPath, script, { mode: 0o700 });
  await chmod(codexPath, 0o700);
  const profile = createCodexDeliberationHostPolicy({
    targetWorkspace: target, scratchRoot: scratch, evidenceRoot: evidence,
    codexPath, codexBinaryDigest: createHash('sha256').update(script).digest('hex'),
    authFilePath, authFileDigest: createHash('sha256').update(TEST_AUTH_BYTES).digest('hex'),
    runtimeReadFiles: TEST_NODE_RUNTIME_FILES,
    runtimeReadSubpaths: TEST_NODE_RUNTIME_SUBPATHS,
    workerSchemaPath: schemaPath, workerSchemaDigest: createHash('sha256').update('{}\n').digest('hex'),
  });
  try {
    const driver = new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy });
    const command = pendingCommand('p4-sealed-provider', fixture.plan.steps[0].stepId);
    driver.prepare(command, preparationState('p4-sealed-provider', digest(fixture.plan), fixture.wave, command));
    const dispatchStarted = Date.now();
    const receipt = await driver.dispatch({ ...command, state: 'CLAIMED' }, command.launchToken);
    assert.equal(Date.now() - dispatchStarted < 5_000, true);
    assert.equal(receipt.ref.digest, digest(report));
    assert.equal((await driver.observe(command.launchToken))?.ref.digest, receipt.ref.digest);
    const receiptName = (await readdir(evidence)).find((name) => name.endsWith('.receipt.json'));
    assert.equal(typeof receiptName, 'string');
    const receiptEvidence = JSON.parse(await readFile(join(evidence, receiptName), 'utf8'));
    const transportEvidence = JSON.parse(receiptEvidence.transport.bytes);
    assert.equal(receiptEvidence.transport.id, `model-transport:${receiptEvidence.transport.digest}`);
    assert.equal(receiptEvidence.transport.digest, digest(transportEvidence));
    assert.equal(transportEvidence.closed, true);
    assert.equal(transportEvidence.refusedConnections, 3);
    assert.equal(transportEvidence.totalConnections, 6);
    assert.equal(transportEvidence.acceptedConnections, 0);
    assert.equal(await new Promise((resolve) => {
      const socket = connectTcp({ host: transportEvidence.listener.host, port: transportEvidence.listener.port });
      socket.on('connect', () => { socket.destroy(); resolve(false); }); socket.on('error', (error) => resolve(error.code === 'ECONNREFUSED'));
    }), true);
    const teardown = await driver.observeTeardown(command.launchToken, command.commandDigest);
    assert.equal(JSON.parse(teardown.bytes).processTreeExited, true);
    assert.equal(JSON.parse(teardown.bytes).transportDigest, receiptEvidence.transport.digest);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await readFile(lateMarker, 'utf8').then(() => true, () => false), false);
    assert.deepEqual((await readdir(scratch)).filter((name) => name.startsWith('attempt-') && name !== 'attempt-forbidden-sibling'), []);
  } finally {
    await Promise.all([target, scratch, evidence, host, unrelated].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test('actual installed Codex Luna/max runs inside the sealed capability', { skip: process.env.LUNACY_ACTUAL_CODEX_SMOKE !== '1' }, async () => {
  const fixture = focusFixture('p4-actual-codex');
  const target = await realpath(await mkdtemp(join(tmpdir(), 'p4-actual-target-')));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'p4-actual-scratch-')));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), 'p4-actual-evidence-')));
  const host = await realpath(await mkdtemp(join(tmpdir(), 'p4-actual-host-')));
  try {
    const codexPath = await realpath('/opt/homebrew/bin/codex');
    const authFilePath = await realpath(join(process.env.HOME, '.codex', 'auth.json'));
    const schemaPath = join(host, 'report-v2.schema.json');
    const wave = { id: fixture.wave.id, digest: fixture.wave.digest, scope: fixture.wave.scope };
    const outputSchema = {
      type: 'object', additionalProperties: false,
      required: ['ideas', 'schema', 'slotOrdinal', 'wave'],
      properties: {
        ideas: {
          type: 'array', minItems: 1, maxItems: 1,
          items: {
            type: 'object', additionalProperties: false, required: ['rationale', 'text'],
            properties: { rationale: { type: 'string', minLength: 1 }, text: { type: 'string', minLength: 1 } },
          },
        },
        schema: { type: 'string', enum: ['lunacy-deliberation-report/v2'] },
        slotOrdinal: { type: 'integer', enum: [0] },
        wave: {
          type: 'object', additionalProperties: false, required: ['digest', 'id', 'scope'],
          properties: {
            digest: { type: 'string', enum: [wave.digest] },
            id: { type: 'string', enum: [wave.id] },
            scope: { type: 'string', enum: [wave.scope] },
          },
        },
      },
    };
    const schemaBytes = JSON.stringify(outputSchema);
    await writeFile(schemaPath, schemaBytes, { mode: 0o600 });
    const codexBytes = await readFile(codexPath);
    const authBytes = await readFile(authFilePath);
    const profile = createCodexDeliberationHostPolicy({
      targetWorkspace: target, scratchRoot: scratch, evidenceRoot: evidence,
      codexPath, codexBinaryDigest: createHash('sha256').update(codexBytes).digest('hex'),
      authFilePath, authFileDigest: createHash('sha256').update(authBytes).digest('hex'),
      runtimeReadFiles: [], workerSchemaPath: schemaPath,
      workerSchemaDigest: createHash('sha256').update(schemaBytes).digest('hex'), timeoutMs: 120_000,
    });
    const driver = new CodexDeliberationDriver({ policy: profile, wave: fixture.wave, deliberationPolicy });
    const command = pendingCommand('p4-actual-codex', fixture.plan.steps[0].stepId);
    driver.prepare(command, preparationState('p4-actual-codex', digest(fixture.plan), fixture.wave, command));
    const receipt = await driver.dispatch({ ...command, state: 'CLAIMED' }, command.launchToken);
    const actual = JSON.parse(receipt.ref.bytes);
    assert.equal(actual.schema, 'lunacy-deliberation-report/v2');
    assert.equal(actual.ideas.length, 1);
    assert.equal((await driver.observe(command.launchToken))?.ref.digest, receipt.ref.digest);
    const receiptName = (await readdir(evidence)).find((name) => name.endsWith('.receipt.json'));
    assert.equal(typeof receiptName, 'string');
    const receiptEvidence = JSON.parse(await readFile(join(evidence, receiptName), 'utf8'));
    const transportEvidence = JSON.parse(receiptEvidence.transport.bytes);
    assert.deepEqual(transportEvidence.destinations, ['chatgpt.com:443']);
    assert.equal(transportEvidence.acceptedConnections >= 1, true);
    assert.equal(transportEvidence.tlsValidatedConnections >= transportEvidence.acceptedConnections, true);
    assert.equal(transportEvidence.tlsRootsDigest, receiptEvidence.attestation.readIsolation.tlsRoots.digest);
    assert.equal(transportEvidence.closed, true);
    assert.equal(JSON.parse((await driver.observeTeardown(command.launchToken, command.commandDigest)).bytes).processTreeExited, true);
    assert.deepEqual((await readdir(scratch)).filter((name) => name.startsWith('attempt-')), []);
  } finally {
    await Promise.all([target, scratch, evidence, host].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test('rollout origin survives promotion and File/Memory CAS reject origin tampering', async () => {
  const fixture = focusFixture('p4-origin-store');
  const root = await mkdtemp(join(tmpdir(), 'p4-origin-store-'));
  try {
    const shadow = { policy: createManagedRolloutPolicy({ generation: 1, mode: 'shadow' }), wave: fixture.wave, deliberationPolicy, synthetic: true, disposable: true, decisionUnsettled: true };
    await makeRunKernel({ plan: fixture.plan, rootDir: root, managedCapability: capability, managedRollout: shadow }).advance(start('p4-origin-store', fixture.plan));
    const file = new FileArtifactStore(root);
    const loaded = await file.load();
    assert.deepEqual(loaded.state.managed.rolloutOrigin, { generation: 1, mode: 'shadow', digest: shadow.policy.digest });
    assert.deepEqual(loaded.state.managed.proposal.rolloutOrigin, loaded.state.managed.rolloutOrigin);
    const tampered = structuredClone(loaded.state);
    tampered.managed.proposal.rolloutOrigin = { ...tampered.managed.rollout, mode: 'focus-canary' };
    await assert.rejects(() => file.commit(loaded.generation, tampered), /ManifestMismatch/);

    const memory = new MemoryArtifactStore();
    await memory.commit(0, loaded.state);
    const memoryLoaded = await memory.load();
    const missing = structuredClone(memoryLoaded.state);
    delete missing.managed.proposal.rolloutOrigin;
    await assert.rejects(() => memory.commit(memoryLoaded.generation, missing), /ManifestMismatch/);

    let promoted = applyManagedRolloutPolicy(loaded.state, capability, createManagedRolloutPolicy({ generation: 2, mode: 'focus-canary' }));
    promoted.decisionTokens.adopt = { kind: 'AUTHORITY_ADOPTION', consumed: false, identity: digest('adopt'), expectedDigest: promoted.planDigest, observedDigest: promoted.planDigest, targetDigest: promoted.planDigest, rolloutOrigin: promoted.managed.rolloutOrigin };
    const result = applyAuthorityAdoption(promoted, { runId: promoted.runId, phaseId: promoted.phaseId, stepId: 'run', attemptEpoch: promoted.attemptEpoch, authorityEpoch: promoted.authorityEpoch, barrierEpoch: promoted.barrierEpoch, eventId: 'adopt', payloadDigest: digest('adopt') }, 'adopt', { kind: 'ADOPT', digest: promoted.planDigest }, fixture.plan, promoted.planDigest);
    assert.equal(result.outcome, 'BLOCKED');
    assert.equal(promoted.managed.rollout.mode, 'focus-canary');
    assert.equal(promoted.managed.rolloutOrigin.mode, 'shadow');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shadow origin stays non-authoritative through every promotion mode', () => {
  const plan = { phaseId: 'p4-origin-matrix', steps: [{ stepId: 'only' }] };
  const identity = { runId: 'p4-origin-matrix', phaseId: 'p4-origin-matrix', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'decision', payloadDigest: digest('decision') };
  for (const mode of ['focus-canary', 'explicit-explore-canary', 'automatic-focus', 'automatic-explore']) {
    let state = createInitialState('p4-origin-matrix', plan, digest(plan), 'none');
    state = applyManagedRolloutPolicy(state, capability, createManagedRolloutPolicy({ generation: 1, mode: 'shadow' }));
    state = applyManagedRolloutPolicy(state, capability, createManagedRolloutPolicy({ generation: 2, mode }));
    state.decisionTokens.deliberation = { kind: 'DELIBERATION', consumed: false, identity: digest('deliberation'), rolloutOrigin: state.managed.rolloutOrigin };
    assert.equal(applyParentDecision(state, identity, 'deliberation', { disposition: 'SELECTION' }).reason, 'managed shadow denies parent decision');
    state.decisionTokens.adoption = { kind: 'AUTHORITY_ADOPTION', consumed: false, identity: digest('adoption'), expectedDigest: state.planDigest, observedDigest: state.planDigest, targetDigest: state.planDigest, rolloutOrigin: state.managed.rolloutOrigin };
    assert.equal(applyAuthorityAdoption(state, identity, 'adoption', { kind: 'ADOPT', digest: state.planDigest }, plan, state.planDigest).reason, 'managed shadow denies authority adoption');
  }
});

test('managed diagnostics saturate and remain bounded/non-authoritative', () => {
  const metrics = new AccelerationMetrics();
  metrics.increment('managedCalls', Number.MAX_SAFE_INTEGER);
  metrics.increment('managedCalls', 1);
  metrics.observeManaged({ inputTokens: 3, outputTokens: 4, bytes: 5, refs: 2, wallTimeMs: 1_001 });
  metrics.observeManaged({ calls: -1, wallTimeMs: Number.NaN });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.managedCalls, Number.MAX_SAFE_INTEGER);
  assert.equal(snapshot.managedInputTokens, 3);
  assert.equal(snapshot.managedLatencyLe10s, 1);
  assert.equal(Object.isFrozen(snapshot), true);
});

test('managed timeout cannot publish UNKNOWN or a fresh epoch before teardown is durably bound', async () => {
  const fixture = focusFixture('p4-teardown-order');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'p4-teardown-order-')));
  let teardown;
  let providerExited = false;
  let abortObserved = false;
  const driver = {
    prepare(command) {
      const role = { kind: 'GENERATOR' }; const roleDigest = digest(role);
      command.roleView = { id: `role-view:${roleDigest}`, scope: 'deliberation/role-view', digest: roleDigest, bytes: canonicalString(role) };
      command.predecessorReportDigests = [];
      command.launchToken = `launch-${digest({ commandId: command.commandId, attemptEpoch: command.attemptEpoch, roleDigest, predecessorReportDigests: [] }).slice(0, 32)}`;
      command.commandDigest = digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken });
    },
    dispatch(command, _token, signal) {
      return new Promise((_resolve, reject) => {
        const finish = () => { abortObserved = true; setTimeout(() => {
          providerExited = true;
          const commandEvidence = Object.fromEntries(['commandId', 'runId', 'phaseId', 'stepId', 'attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'modeEpoch', 'launchToken', 'commandDigest'].map((key) => [key, command[key]]));
          const evidence = { schema: 'lunacy-codex-deliberation-teardown/v1', command: commandEvidence, roleDigest: command.roleView.digest, predecessorReportDigests: [], providerExited: true, processTreeExited: true, scratchRemoved: true };
          teardown = { id: `teardown:${digest(evidence)}`, scope: 'outbox/teardown', digest: digest(evidence), bytes: canonicalString(evidence) };
          reject(new Error('cancelled after owned process exit'));
        }, 100); };
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    },
    observeTeardown(_token, expectedDigest) { return teardown && JSON.parse(teardown.bytes).command.commandDigest === expectedDigest ? teardown : undefined; },
  };
  const rollout = { policy: createManagedRolloutPolicy({ generation: 1, mode: 'focus-canary' }), wave: fixture.wave, deliberationPolicy, decisionUnsettled: true };
  try {
    const kernel = makeComposedKernel({ plan: fixture.plan, rootDir: root, managedCapability: capability, managedRollout: rollout }, driver, { timeoutMs: 800 });
    const begun = await kernel.advance(start('p4-teardown-order', fixture.plan));
    const resumeEvent = { kind: 'RESUME' };
    await kernel.advance({ runId: 'p4-teardown-order', expectedRevision: begun.snapshot.revision, event: resumeEvent, identity: { runId: 'p4-teardown-order', phaseId: 'run', stepId: 'run', attemptEpoch: begun.snapshot.attemptEpoch, authorityEpoch: begun.snapshot.authorityEpoch, barrierEpoch: begun.snapshot.barrierEpoch, eventId: 'resume-timeout', payloadDigest: digest(resumeEvent) } });
    for (let index = 0; index < 200 && !abortObserved; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(abortObserved, true);
    let state = (await new FileArtifactStore(root).load()).state;
    assert.equal(providerExited, false);
    assert.equal(Object.values(state.outbox)[0].state, 'CLAIMED');
    for (let index = 0; index < 200; index += 1) {
      state = (await new FileArtifactStore(root).load()).state;
      if (Object.values(state.outbox)[0].state === 'UNKNOWN') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const retired = Object.values(state.outbox)[0];
    assert.equal(providerExited, true);
    assert.equal(retired.state, 'UNKNOWN');
    assert.equal(retired.noEffectEvidence.some((item) => item.scope === 'outbox/teardown'), true);
    const recoverEvent = { kind: 'RESUME' };
    await kernel.advance({ runId: 'p4-teardown-order', expectedRevision: state.revision, event: recoverEvent, identity: { runId: 'p4-teardown-order', phaseId: 'run', stepId: 'run', attemptEpoch: state.attemptEpoch, authorityEpoch: state.authorityEpoch, barrierEpoch: state.barrierEpoch, eventId: 'resume-recover', payloadDigest: digest(recoverEvent) } });
    state = (await new FileArtifactStore(root).load()).state;
    assert.equal(state.attemptEpoch, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
