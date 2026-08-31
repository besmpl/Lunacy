import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { canonicalString, digest } from '../dist/canonical.js';
import { composeKernel } from '../dist/composition.js';
import { createCodexDeliberationHostPolicy } from '../dist/codex-host-policy.js';
import { authorPlan, compileWavePlan } from '../dist/deliberation.js';
import { createManagedCapability, createManagedRolloutPolicy } from '../dist/managed-capability.js';
import { validatePlan } from '../dist/validator.js';

const ref = (id, value, scope) => ({ id, ...(scope ? { scope } : {}), digest: digest(value), bytes: canonicalString(value) });
const frames = [0, 1, 2, 3].map((index) => ({ frameId: `f${index}`, tag: 'code', text: `frame-${index}` }))
  .concat([{ frameId: 'wild', tag: 'wild', text: 'wild' }]);
const deliberationPolicy = {
  version: ref('policy', { generation: 1 }, 'policy'), frameCatalog: frames,
  maxMaterialDecisions: 4, maxSettlementBytes: 2_000_000, maxResolvedRoleInputBytes: 2_000_000,
  convergeCount: 3, nonObviousNovelty: 5, viableFloor: 5,
};
const capability = createManagedCapability({ ceilings: { waves: 1, calls: 9, refs: 256, reportBytes: 2_000_000, persistedBytes: 2_000_000 } });
const sharedObjects = process.report.getReport().sharedObjects.filter((path) => path.startsWith('/opt/homebrew/') || path.startsWith('/usr/local/'));
const linkedFiles = process.platform === 'darwin'
  ? sharedObjects.flatMap((object) => execFileSync('/usr/bin/otool', ['-L', object], { encoding: 'utf8' }).split('\n')
    .map((line) => line.trim().split(' ')[0]).filter((path) => !path?.endsWith(':') && (path?.startsWith('/opt/homebrew/') || path?.startsWith('/usr/local/'))))
  : [];
const runtimeReadFiles = [...new Set([process.execPath, ...(process.platform === 'darwin' ? ['/opt/homebrew/etc/openssl@3/openssl.cnf'] : []), ...linkedFiles, ...sharedObjects])];
const runtimeReadSubpaths = [...new Set([dirname(dirname(process.execPath)), ...linkedFiles.map(dirname)])];

function fixture(runId, gear) {
  const explore = gear === 'EXPLORE';
  const authored = authorPlan({
    runId, phaseId: 'p4', intent: ref('intent', { goal: explore ? 'explore' : 'choose' }, 'intent'),
    evidenceSnapshot: ref('snapshot', { sealed: true }, 'snapshot'), authorityDigest: digest('authority'),
    policyVersion: deliberationPolicy.version, settlements: [],
  }, {
    decisionUnsettled: true, explicitExplore: explore, citedWitness: false, planEquivalent: false,
    containedDiscovery: false, openEnded: explore, highStakes: explore, openlyPhrased: explore,
    namedDiscriminator: !explore,
  }, deliberationPolicy);
  assert.equal(authored.kind, 'DELIBERATION_REQUIRED');
  const wave = JSON.parse(authored.wave.bytes);
  assert.equal(wave.gear, gear);
  const compiled = compileWavePlan(authored.wave, wave);
  assert.equal(compiled.ok, true);
  return { waveRef: authored.wave, wave, plan: validatePlan(compiled.value).plan };
}

function input(runId, eventId, event, state, launchToken) {
  return {
    runId, ...(state ? { expectedRevision: state.revision } : {}), event,
    identity: {
      runId, phaseId: 'run', stepId: 'run', attemptEpoch: state?.attemptEpoch ?? 0,
      authorityEpoch: state?.authorityEpoch ?? 0, barrierEpoch: state?.barrierEpoch ?? 0,
      eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}),
    },
  };
}

function containsAuthorityMetadata(value) {
  if (!value || typeof value !== 'object') return false;
  const forbidden = new Set(['commandDigest', 'resultDigest', 'attemptEpoch', 'barrierEpoch', 'modeEpoch', 'launchToken', 'receipt', 'roleDigest', 'predecessorGeneration', 'predecessorReportDigests', 'publicationLeaseSetId']);
  return Object.keys(value).some((key) => forbidden.has(key) || /authority|anchor/i.test(key)) || Object.values(value).some(containsAuthorityMetadata);
}

async function runProgression(storeKind, gear) {
  const runId = `p4-s21-${gear.toLowerCase()}-${storeKind}`;
  const target = await realpath(await mkdtemp(join(tmpdir(), `${runId}-target-`)));
  const scratch = await realpath(await mkdtemp(join(tmpdir(), `${runId}-scratch-`)));
  const evidence = await realpath(await mkdtemp(join(tmpdir(), `${runId}-evidence-`)));
  const host = await realpath(await mkdtemp(join(tmpdir(), `${runId}-host-`)));
  try {
    const fx = fixture(runId, gear);
    const schemaPath = join(host, 'report-v2.schema.json');
    const codexPath = join(host, 'deterministic-codex.mjs');
    const authFilePath = join(host, 'auth.json');
    const script = `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nif (process.argv[2] === '--version') { console.log('codex-cli 0.145.0'); process.exit(0); }\nconst canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';\nconst forbidden = new Set(['commandDigest','resultDigest','attemptEpoch','barrierEpoch','modeEpoch','launchToken','receipt','roleDigest','predecessorGeneration','predecessorReportDigests','publicationLeaseSetId']);\nconst hasAuthority = (value) => value && typeof value === 'object' && (Object.keys(value).some((key) => forbidden.has(key) || /authority|anchor/i.test(key)) || Object.values(value).some(hasAuthority));\nconst sameLocator = (a, b) => a.oneBasedOrdinal === b.oneBasedOrdinal && canonical(a.generatorReport) === canonical(b.generatorReport);\nconst score = (row) => 35 * row.novelty + 40 * row.viability + 25 * row.fit;\nconst at = process.argv.indexOf('--output-last-message'); let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (part) => { input += part; }); process.stdin.on('end', () => { const role = JSON.parse(input); if (canonical(role) !== input || hasAuthority(role)) process.exit(89); const wave = ${JSON.stringify(fx.waveRef)}; const lensTexts = ${JSON.stringify(fx.wave.generatorLenses.map((lens) => gear === 'EXPLORE' ? frames.find((frame) => frame.frameId === lens.frameId).text : lens.text))}; const generatorCount = ${gear === 'EXPLORE' ? 5 : fx.wave.generatorLenses.length}; let report; if (role.kind === 'GENERATOR') { const ordinal = lensTexts.indexOf(role.lens.text); const count = ${gear === 'EXPLORE' ? 6 : 1}; report = { schema: 'lunacy-deliberation-report/v2', wave, slotOrdinal: ordinal, ideas: Array.from({ length: count }, (_, index) => ({ text: 'idea-' + ordinal + '-' + (index + 1), rationale: 'deterministic bounded rationale-' + ordinal + '-' + (index + 1) })) }; } else if (role.kind === 'CRITIC') { const ideas = role.generators.flatMap((bound) => bound.report.ideas.map((_, index) => ({ generatorReport: bound.ref, oneBasedOrdinal: index + 1 }))); const scores = ideas.map((idea, index) => ({ idea, novelty: index < 3 ? 10 - index : 5, viability: 9, fit: 8, evidence: [] })); const clusters = generatorCount === 5 ? [{ label: 'a', ideas: ideas.slice(0, 10) }, { label: 'b', ideas: ideas.slice(10, 20) }, { label: 'c', ideas: ideas.slice(20) }] : [{ label: 'a', ideas: ideas.slice(0, 1) }, { label: 'b', ideas: ideas.slice(1) }, { label: 'c', ideas: [] }]; report = { schema: 'lunacy-deliberation-report/v2', wave, slotOrdinal: generatorCount, scores, clusters }; } else { const ranked = [...role.critic.report.scores].filter((row) => !row.trap).sort((a, b) => score(b) - score(a)); const rank = ranked.findIndex((row) => sameLocator(row.idea, { generatorReport: role.selected.generatorReport, oneBasedOrdinal: role.selected.oneBasedOrdinal })); report = { schema: 'lunacy-deliberation-report/v2', wave, slotOrdinal: generatorCount + 1 + rank, sketch: 'One sentence. Two sentence. Three sentence. Four sentence.', loadBearingRisk: 'bounded risk', firstConcreteStep: 'first concrete step', childIdeas: ['one', 'two', 'three'] }; } writeFileSync(process.argv[at + 1], canonical(report), { mode: 0o600 }); });\n`;
    await writeFile(schemaPath, '{}\n', { mode: 0o600 });
    await writeFile(authFilePath, '{}\n', { mode: 0o600 });
    await writeFile(codexPath, script, { mode: 0o700 });
    await chmod(codexPath, 0o700);
    const profile = createCodexDeliberationHostPolicy({
      targetWorkspace: target, scratchRoot: scratch, evidenceRoot: evidence, codexPath,
      codexBinaryDigest: createHash('sha256').update(script).digest('hex'), authFilePath,
      authFileDigest: createHash('sha256').update('{}\n').digest('hex'), runtimeReadFiles, runtimeReadSubpaths,
      workerSchemaPath: schemaPath, workerSchemaDigest: createHash('sha256').update('{}\n').digest('hex'),
    });
    const rollout = {
      policy: createManagedRolloutPolicy({ generation: 1, mode: gear === 'EXPLORE' ? 'explicit-explore-canary' : 'focus-canary' }),
      wave: fx.waveRef, deliberationPolicy, decisionUnsettled: true, ...(gear === 'EXPLORE' ? { explicitExplore: true } : {}),
    };
    const kernel = composeKernel({
      plan: fx.plan, ...(storeKind === 'file' ? { rootDir: target } : {}), workspace: target,
      managedCapability: capability, managedRollout: rollout, managedDeliberationPolicy: profile,
      maxInFlight: gear === 'EXPLORE' ? 5 : 3,
    });
    const startEvent = { kind: 'START', intentRef: ref('plan', fx.plan) };
    let yielded = await kernel.advance(input(runId, 'start', startEvent));
    const acceptedCommands = new Set();
    for (let serial = 0; serial < 1_500 && yielded.kind !== 'DECISION_REQUIRED'; serial += 1) {
      const state = (await kernel.store.load()).state;
      assert.ok(state);
      const acked = Object.values(state.outbox).find((command) => command.state === 'ACKED' && !acceptedCommands.has(command.commandId));
      if (acked) {
        const proof = JSON.parse(acked.receipt.bytes);
        assert.ok(proof.authorityAnchor);
        acceptedCommands.add(acked.commandId);
        yielded = await kernel.advance(input(runId, `worker-${serial}`, { kind: 'WORKER_ENVELOPE', ref: proof.receipt }, state, acked.launchToken));
      } else if (Object.values(state.outbox).some((command) => command.state === 'CLAIMED')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      } else {
        yielded = await kernel.advance(input(runId, `resume-${serial}`, { kind: 'RESUME' }, state));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(yielded.kind, 'DECISION_REQUIRED');
    const beforeSnapshot = await kernel.store.load();
    const before = beforeSnapshot.state;
    const token = before.decisionTokens[yielded.token];
    const expectedReports = gear === 'EXPLORE' ? 9 : fx.wave.generatorLenses.length + 1;
    assert.equal(token.orderedReportRefs.length, expectedReports);
    const anchors = token.orderedReportRefs.map((report) => before.managed.acceptedReports[report.digest].authorityAnchor);
    assert.equal(new Set(anchors.map(canonicalString)).size, expectedReports);
    for (const report of token.orderedReportRefs) {
      const row = before.managed.acceptedReports[report.digest];
      const attempt = before.managed.attempts[row.commandId];
      const command = before.outbox[row.commandId];
      const proof = JSON.parse(command.receipt.bytes);
      assert.deepEqual(row.authorityAnchor, attempt.authorityAnchor);
      assert.deepEqual(row.authorityAnchor, proof.authorityAnchor);
      assert.equal(row.receipt.authorityAnchorDigest, row.authorityAnchor.digest);
      assert.equal(command.roleView.bytes, canonicalString(JSON.parse(command.roleView.bytes)));
      assert.equal(containsAuthorityMetadata(JSON.parse(command.roleView.bytes)), false);
    }

    const omitted = structuredClone(before);
    delete omitted.managed.acceptedReports[token.orderedReportRefs[0].digest].authorityAnchor;
    await assert.rejects(() => kernel.store.commit(beforeSnapshot.generation, omitted), /ManifestMismatch/);
    const divergent = structuredClone(before);
    divergent.managed.acceptedReports[token.orderedReportRefs[0].digest].receipt.authorityAnchorDigest = '0'.repeat(64);
    await assert.rejects(() => kernel.store.commit(beforeSnapshot.generation, divergent), /ManifestMismatch/);
    assert.equal((await kernel.store.load()).generation, beforeSnapshot.generation);

    const result = { kind: 'COMPLETE_PLAN', plan: fx.plan };
    const selection = { generatorReport: token.orderedReportRefs[0], oneBasedOrdinal: 1 };
    const settlementValue = {
      schema: 'lunacy-deliberation-settlement/v1', authorshipInputDigest: token.authorshipInputDigest,
      decisionKey: token.decisionKey, frontierOrdinal: fx.wave.authorship.prospectiveEffectFrontierOrdinal,
      waveRef: token.waveRef, orderedReportRefs: token.orderedReportRefs, basis: selection,
      dissent: { kind: 'NONE' }, predecessors: [], selection, disposition: 'SELECTION', result,
      resultDigest: digest(result),
    };
    const settlement = ref(`settlement:${digest(settlementValue).slice(0, 16)}`, settlementValue, 'deliberation/settlement');
    const decision = { kind: 'PARENT_DECISION', token: yielded.token, value: { disposition: 'SELECTION', settlementRef: settlement, result } };
    const decisionInput = input(runId, 'selection', decision, before);
    const selected = await kernel.advance(decisionInput);
    assert.deepEqual(await kernel.advance(decisionInput), selected);
    const after = (await kernel.store.load()).state;
    const record = after.decisionTokens[yielded.token];
    assert.equal(record.consumed, true);
    assert.equal(after.managed.settlements[settlement.digest].digest, settlement.digest);
    const closure = after.managed.leaseSets[record.publicationLeaseSetId].closedRefGraph;
    const expectedClosure = [token.waveRef, ...token.orderedReportRefs, ...anchors, settlement];
    assert.equal(closure.length, expectedClosure.length);
    for (const owner of expectedClosure) assert.equal(closure.some((candidate) => canonicalString(candidate) === canonicalString(owner)), true);
  } finally {
    await Promise.all([target, scratch, evidence, host].map((path) => rm(path, { recursive: true, force: true })));
  }
}

test('anchored managed Focus and Explore progress through closed predecessor views on Memory and File', { skip: process.platform !== 'darwin', timeout: 180_000 }, async (t) => {
  for (const storeKind of ['memory', 'file']) {
    for (const gear of ['FOCUS', 'EXPLORE']) {
      await t.test(`${storeKind} ${gear}`, () => runProgression(storeKind, gear));
    }
  }
});
