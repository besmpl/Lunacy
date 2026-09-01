import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constructParentDecisionSubmission, listDecisionInbox } from '../dist/decision-inbox.js';
import { acceptRuntimePass, prepareManualAcceptance, sealRetentionRun } from '../dist/run-retention.js';
import { initRun, runRun } from '../dist/orchestration.js';
import { canonicalString, digest, digestBytes } from '../dist/canonical.js';
import { retentionFixture } from './fixtures/session-lifecycle/retention-helper.mjs';

test('manual acceptance is a closed exact witness; Markdown cannot authorize or drift after preparation', async () => {
  const fixture = await retentionFixture(); await assert.rejects(() => prepareManualAcceptance(fixture.runRoot, join(fixture.runRoot, 'STATE.md')), /manual parent acceptance|canonical|valid JSON/);
  await prepareManualAcceptance(fixture.runRoot, fixture.acceptanceSource); const bytes = await readFile(join(fixture.runRoot, '.lunacy-parent-acceptance.json')); assert.deepEqual(JSON.parse(bytes), fixture.acceptance);
  await writeFile(join(fixture.runRoot, 'OUTCOME.md'), '# Outcome\nchanged\n'); await assert.rejects(() => prepareManualAcceptance(fixture.runRoot, fixture.acceptanceSource), /Outcome or terminal state disagrees/);
});

test('parent decision submission facts come from the same immutable constructor used by submission', () => {
  const sha = 'a'.repeat(64); const identity = 'b'.repeat(64); const state = { schema: 1, runId: 'run', phaseId: 'p', revision: 4, authorityEpoch: 1, attemptEpoch: 2, barrierEpoch: 3, modeEpoch: 0, writerFence: 'f', status: 'ACTIVE', gate: 'DUE', barrier: 'OPEN', steps: {}, outbox: {}, processed: {}, decisionTokens: { gate: { kind: 'GATE', identity, consumed: false } }, planDigest: sha, nextAction: 'gate', journal: [] };
  const inbox = { schema: 'lunacy-decision-inbox/v1', version: 1, run: { runRoot: '/tmp/run', runId: 'run', phaseId: 'p', generation: 2, revision: 4, planDigest: sha, policyDigest: null }, token: { value: 'gate', kind: 'GATE', identityDigest: identity, consumed: false, expectedDigest: null, observedDigest: null, targetDigest: null }, cursor: { revision: 4, authorityEpoch: 1, attemptEpoch: 2, barrierEpoch: 3 }, status: 'READY', attention: { code: 'GATE_DUE', nextProof: 'submit the explicit parent gate decision' }, briefDigest: null, evidenceDigest: null, nextProof: 'submit the explicit parent gate decision', redaction: { brief: null, evidence: null, receipts: null, paths: null } };
  const first = constructParentDecisionSubmission({ selection: { runRoot: '/tmp/run', runId: 'run', token: 'gate' }, inbox, state, value: 'PASS', eventId: 'event' }); const second = constructParentDecisionSubmission({ selection: { runRoot: '/tmp/run', runId: 'run', token: 'gate' }, inbox: structuredClone(inbox), state: structuredClone(state), value: 'PASS', eventId: 'event' }); assert.deepEqual(second, first); assert.match(first.eventDigest, /^[0-9a-f]{64}$/); assert.match(first.eventIdentityDigest, /^[0-9a-f]{64}$/);
});

test('runtime acceptance publishes candidate before the exact next PASS and materializes its verified terminal witness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-runtime-acceptance-')); const plan = { phaseId: 'runtime-accept', steps: [{ stepId: 'one' }] };
  const commands = new Map(); const driver = { dispatch(command, token) { commands.set(token, command); return { launchToken: token, commandDigest: command.commandDigest, ref: { id: 'launch', scope: 'test', digest: digest('launch'), bytes: canonicalString('launch') } }; }, terminal(token) { const command = commands.get(token); return { schema: 'lunacy-codex-terminal/v1', launchToken: token, commandDigest: command.commandDigest, status: 'PASS', outcome: 'normal-completion', exitCode: 0, signal: null, resultDigest: null, reportPath: null, reportDigest: null, eventsDigest: digest('events'), finishedAt: '2025-01-01T00:00:00Z' }; } };
  await initRun({ runDir: root, runId: 'runtime-run', plan }); await runRun({ runDir: root, runId: 'runtime-run', plan, driver }); await mkdir(join(root, '.work')); await writeFile(join(root, 'PLAN.md'), '# Plan\n'); await writeFile(join(root, 'OUTCOME.md'), '# Outcome\n'); await writeFile(join(root, 'STATE.md'), '# State\n');
  const entry = (await listDecisionInbox({ entries: [{ runRoot: root, runId: 'runtime-run' }] })).entries[0]; const packageBytes = await readFile('package.json'); const resultIdentity = { kind: 'manifest', schema: 'lunacy-product-manifest/v1', roots: ['package.json'], entries: [{ path: 'package.json', digest: digestBytes(packageBytes) }] };
  const witness = await acceptRuntimePass({ runRoot: root, runId: 'runtime-run', token: entry.token.value, eventId: 'runtime-pass', inbox: entry, plan, resultIdentity }); assert.equal(witness.schema, 'lunacy-runtime-acceptance/v1'); assert.equal(witness.passRecord.revision, entry.run.revision + 1); assert.deepEqual(JSON.parse(await readFile(join(root, '.lunacy-parent-acceptance.json'), 'utf8')), witness);
  // Crash recovery is evidence-only: a durable candidate plus its already
  // committed exact PASS reconstructs the terminal witness without submitting
  // another parent decision.
  await writeFile(join(root, '.lunacy-parent-acceptance.json'), canonicalString(witness.candidate));
  const recovered = await sealRetentionRun(root, { mode: 'dry-run' }); assert.equal(recovered.status, 'READY'); assert.deepEqual(JSON.parse(await readFile(join(root, '.lunacy-parent-acceptance.json'), 'utf8')), witness);
});
