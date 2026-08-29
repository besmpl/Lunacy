import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { initRun, runRun } from '../dist/orchestration.js';
import { listDecisionInbox, submitParentDecision, promotePhase } from '../dist/decision-inbox.js';
import { FileArtifactStore } from '../dist/store.js';
import { canonicalizeDeclaration } from '../dist/bridge.js';

const ref = (id, value) => ({ id, scope: 'test', digest: digest(value), bytes: canonicalString(value) });
function driver() {
  const commands = new Map();
  return {
    dispatch(command, token) { commands.set(token, command); return { launchToken: token, commandDigest: command.commandDigest, ref: ref('launch', { ok: true }) }; },
    terminal(token) { const command = commands.get(token); return { schema: 'lunacy-codex-terminal/v1', launchToken: token, commandDigest: command.commandDigest, status: 'PASS', outcome: 'normal-completion', exitCode: 0, signal: null, resultDigest: null, reportPath: null, reportDigest: null, eventsDigest: digest('events'), finishedAt: '2025-01-01T00:00:00Z' }; },
  };
}

test('decision inbox listing is deterministic, redacted, and mutation-free', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-inbox-list-'));
  const plan = { phaseId: 'inbox', steps: [{ stepId: 'one' }] };
  await initRun({ runDir: root, runId: 'inbox-run', plan });
  const before = JSON.stringify(await new FileArtifactStore(root).load());
  const first = await listDecisionInbox({ entries: [{ runRoot: root, runId: 'inbox-run' }] });
  const second = await listDecisionInbox({ entries: [{ runRoot: root, runId: 'inbox-run' }] });
  assert.equal(canonicalString(first), canonicalString(second));
  assert.equal(first.entries[0].status, 'ABSENT');
  assert.equal(JSON.stringify(first).includes('goal'), false);
  assert.equal(JSON.stringify(await new FileArtifactStore(root).load()), before);
});

test('valid decision submission commits once and exact retry replays', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-inbox-submit-'));
  const plan = { phaseId: 'inbox-submit', steps: [{ stepId: 'one' }] };
  await initRun({ runDir: root, runId: 'submit-run', plan });
  await runRun({ runDir: root, runId: 'submit-run', plan, driver: driver() });
  const entry = (await listDecisionInbox({ entries: [{ runRoot: root, runId: 'submit-run' }] })).entries[0];
  assert.equal(entry.status, 'READY');
  const input = { selection: { runRoot: root, runId: 'submit-run', token: entry.token.value }, inbox: entry, plan, value: 'PASS' };
  const first = await submitParentDecision(input); const retry = await submitParentDecision(input);
  assert.equal(first.status, 'committed'); assert.equal(retry.status, 'replayed');
  assert.equal((await new FileArtifactStore(root).load()).state.journal.filter((row) => row.event.kind === 'PARENT_DECISION').length, 1);
});

test('stale bindings do not consume a token and identical concurrent submits journal once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-inbox-race-'));
  const plan = { phaseId: 'inbox-race', steps: [{ stepId: 'one' }] };
  await initRun({ runDir: root, runId: 'race-run', plan }); await runRun({ runDir: root, runId: 'race-run', plan, driver: driver() });
  const entry = (await listDecisionInbox({ entries: [{ runRoot: root, runId: 'race-run' }] })).entries[0];
  const stale = { ...entry, run: { ...entry.run, planDigest: 'f'.repeat(64) } };
  const invalid = await submitParentDecision({ selection: { runRoot: root, runId: 'race-run', token: entry.token.value }, inbox: stale, plan, value: 'PASS' });
  assert.equal(invalid.status, 'attention'); assert.equal(invalid.consumed, false);
  const staleEvidence = { ...entry, evidenceDigest: 'f'.repeat(64) };
  const invalidEvidence = await submitParentDecision({ selection: { runRoot: root, runId: 'race-run', token: entry.token.value }, inbox: staleEvidence, plan, value: 'PASS' });
  assert.equal(invalidEvidence.status, 'attention'); assert.equal(invalidEvidence.consumed, false);
  const input = { selection: { runRoot: root, runId: 'race-run', token: entry.token.value }, inbox: entry, plan, value: 'PASS' };
  await Promise.all([submitParentDecision(input), submitParentDecision(input)]);
  const state = (await new FileArtifactStore(root).load()).state;
  assert.equal(state.journal.filter((row) => row.event.kind === 'PARENT_DECISION').length, 1);
});

test('phase binding is exact and a tampered inbox phase cannot consume a token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-inbox-phase-'));
  const plan = { phaseId: 'inbox-phase', steps: [{ stepId: 'one' }] };
  await initRun({ runDir: root, runId: 'phase-run', plan });
  await runRun({ runDir: root, runId: 'phase-run', plan, driver: driver() });
  const entry = (await listDecisionInbox({ entries: [{ runRoot: root, runId: 'phase-run' }] })).entries[0];
  const tampered = { ...entry, run: { ...entry.run, phaseId: 'attacker-phase' } };
  const result = await submitParentDecision({ selection: { runRoot: root, runId: 'phase-run', token: entry.token.value }, inbox: tampered, plan, value: 'PASS' });
  assert.equal(result.status, 'attention');
  assert.equal(result.code, 'BindingMismatch');
  assert.equal(result.consumed, false);
  const state = (await new FileArtifactStore(root).load()).state;
  assert.equal(state.journal.filter((row) => row.event.kind === 'PARENT_DECISION').length, 0);
  assert.equal(state.decisionTokens[entry.token.value].consumed, false);
  const committed = await submitParentDecision({ selection: { runRoot: root, runId: 'phase-run', token: entry.token.value }, inbox: entry, plan, value: 'PASS' });
  assert.equal(committed.status, 'committed');
  const staleRetry = await submitParentDecision({ selection: { runRoot: root, runId: 'phase-run', token: entry.token.value }, inbox: tampered, plan, value: 'PASS' });
  assert.equal(staleRetry.status, 'attention');
  assert.equal(staleRetry.code, 'BindingMismatch');
});

test('submit snapshots caller plan before the verified read can yield', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-inbox-plan-snapshot-'));
  const plan = { phaseId: 'inbox-plan-snapshot', steps: [{ stepId: 'one' }] };
  await initRun({ runDir: root, runId: 'snapshot-run', plan });
  await runRun({ runDir: root, runId: 'snapshot-run', plan, driver: driver() });
  const entry = (await listDecisionInbox({ entries: [{ runRoot: root, runId: 'snapshot-run' }] })).entries[0];
  const originalLoadReadOnly = FileArtifactStore.prototype.loadReadOnly;
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  let first = true;
  FileArtifactStore.prototype.loadReadOnly = async function loadReadOnlyWithPause(...args) {
    const loaded = await originalLoadReadOnly.apply(this, args);
    if (first) { first = false; await paused; }
    return loaded;
  };
  try {
    const pending = submitParentDecision({ selection: { runRoot: root, runId: 'snapshot-run', token: entry.token.value }, inbox: entry, plan, value: 'PASS' });
    await Promise.resolve();
    plan.steps[0].goal = 'mutated after submit started';
    release();
    const result = await pending;
    assert.equal(result.status, 'committed');
  } finally {
    FileArtifactStore.prototype.loadReadOnly = originalLoadReadOnly;
  }
});

test('exact phase promotion requires predecessor PASS and is retry-safe', async () => {
  const predecessorRoot = await mkdtemp(join(tmpdir(), 'lunacy-handoff-predecessor-'));
  const predecessorPlan = { phaseId: 'predecessor', steps: [{ stepId: 'one' }] };
  await initRun({ runDir: predecessorRoot, runId: 'predecessor-run', plan: predecessorPlan });
  await runRun({ runDir: predecessorRoot, runId: 'predecessor-run', plan: predecessorPlan, driver: driver() });
  const inbox = (await listDecisionInbox({ entries: [{ runRoot: predecessorRoot, runId: 'predecessor-run' }] })).entries[0];
  await submitParentDecision({ selection: { runRoot: predecessorRoot, runId: 'predecessor-run', token: inbox.token.value }, inbox, plan: predecessorPlan, value: 'PASS' });
  const loaded = await new FileArtifactStore(predecessorRoot).loadReadOnly('predecessor-run'); const state = loaded.state;
  const proofDigest = digest({ runId: state.runId, phaseId: state.phaseId, planDigest: state.planDigest, revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, gate: state.gate, status: state.status });
  const successorRoot = await mkdtemp(join(tmpdir(), 'lunacy-handoff-successor-')); const successorPlan = { phaseId: 'successor', steps: [{ stepId: 'two' }] }; const normalized = canonicalizeDeclaration(successorPlan);
  const authorization = { kind: 'PROMOTE_PHASE', predecessorRunId: 'predecessor-run', predecessorPhaseId: 'predecessor', successorRunId: 'successor-run', successorPhaseId: 'successor', successorPlanDigest: digest(normalized), eventId: 'promote' };
  const handoff = { schema: 'lunacy-phase-handoff/v1', version: 1, predecessor: { runRoot: predecessorRoot, runId: 'predecessor-run', phaseId: 'predecessor', generation: loaded.generation, revision: state.revision, planDigest: state.planDigest, proofDigest }, successor: { runRoot: successorRoot, runId: 'successor-run', phaseId: 'successor', plan: successorPlan, planDigest: digest(normalized) }, authorization, authorizationDigest: digest(authorization) };
  // Hold the predecessor verification read open, then mutate the caller's
  // handoff. Promotion must use the canonical snapshot captured at entry,
  // rather than adopting this post-call plan mutation.
  const originalLoadReadOnly = FileArtifactStore.prototype.loadReadOnly;
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  let firstRead = true;
  FileArtifactStore.prototype.loadReadOnly = async function loadReadOnlyWithPause(...args) {
    const loadedValue = await originalLoadReadOnly.apply(this, args);
    if (firstRead) { firstRead = false; await paused; }
    return loadedValue;
  };
  const originalSuccessorPlan = structuredClone(handoff.successor.plan);
  let first;
  try {
    const pending = promotePhase({ handoff });
    await Promise.resolve();
    handoff.successor.plan.steps[0].stepId = 'mutated-after-promote-start';
    release();
    first = await pending;
  } finally {
    FileArtifactStore.prototype.loadReadOnly = originalLoadReadOnly;
    handoff.successor.plan = originalSuccessorPlan;
  }
  const retry = await promotePhase({ handoff });
  assert.equal(first.status, 'initialized'); assert.equal(retry.status, 'replayed');
  assert.equal((await new FileArtifactStore(successorRoot).load()).state.planDigest, handoff.successor.planDigest);
  assert.equal((await new FileArtifactStore(successorRoot).load()).state.journal.length, 1);
});
