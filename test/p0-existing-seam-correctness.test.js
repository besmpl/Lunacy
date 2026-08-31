import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { composeKernel } from '../dist/composition.js';
import { FileArtifactStore } from '../dist/store.js';
import { selectCurrentCommand } from '../dist/dispatch-coordinator.js';
import { acknowledge, claim, unknown } from '../dist/outbox.js';
import { createInitialState, migrateMachineState } from '../dist/reducer.js';
import { createManagedCapability } from '../dist/managed-capability.js';
import {
  validateHistoricalCodexEffect,
  launchRecordRef,
  terminalRecordRef,
} from '../dist/codex-effect-records.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const ref = (id, value) => ({ id, scope: 'p0-test', digest: digest(value), bytes: canonicalString(value) });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function input(runId, eventId, event, snapshot, launchToken) {
  return {
    runId,
    ...(snapshot?.revision === undefined ? {} : { expectedRevision: snapshot.revision }),
    identity: {
      runId, phaseId: 'run', stepId: 'run', eventId,
      attemptEpoch: snapshot?.attemptEpoch ?? 0,
      authorityEpoch: snapshot?.authorityEpoch ?? 0,
      barrierEpoch: snapshot?.barrierEpoch ?? 0,
      payloadDigest: digest(event),
      ...(launchToken === undefined ? {} : { launchToken }),
    },
    event,
  };
}

async function dueGate(root, runId, livePlan) {
  const driver = {
    dispatch(command) {
      return { launchToken: command.launchToken, commandDigest: command.commandDigest, ref: ref(`launch:${command.launchToken}`, { entered: true }) };
    },
  };
  const kernel = composeKernel({ plan: livePlan, rootDir: root, driver });
  let yielded = await kernel.advance(input(runId, 'start', { kind: 'START', intentRef: { id: 'plan', digest: digest(livePlan) } }));
  yielded = await kernel.advance(input(runId, 'resume', { kind: 'RESUME' }, yielded.snapshot));
  const state = (await new FileArtifactStore(root).load()).state;
  const command = Object.values(state.outbox)[0];
  assert.equal(command.state, 'ACKED');
  const worker = { kind: 'WORKER_ENVELOPE', ref: ref(`worker:${command.launchToken}`, { status: 'DONE' }) };
  yielded = await kernel.advance(input(runId, 'worker', worker, yielded.snapshot, command.launchToken));
  assert.equal(yielded.kind, 'FINAL');
  assert.equal(yielded.status, 'phase-ready');
  assert.equal(yielded.snapshot.gate, 'DUE');
  const token = JSON.parse(yielded.artifacts[0].bytes).token;
  return { kernel, gate: { ...yielded, token }, oldCommand: command };
}

test('valid drift diverts an old due-gate PASS through adoption and fresh epochs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p0-gate-drift-'));
  const plan = { phaseId: 'p0', gateRequired: true, steps: [{ stepId: 'old' }] };
  const { kernel, gate, oldCommand } = await dueGate(root, 'p0-gate-drift', plan);
  const oldEpochs = { authority: gate.snapshot.authorityEpoch, attempt: gate.snapshot.attemptEpoch, barrier: gate.snapshot.barrierEpoch };
  plan.steps.push({ stepId: 'new', dependencies: ['old'] });
  const pass = { kind: 'PARENT_DECISION', token: gate.token, value: 'PASS' };
  const diverted = await kernel.advance(input('p0-gate-drift', 'old-pass', pass, gate.snapshot));
  assert.equal(diverted.kind, 'DECISION_REQUIRED');
  assert.notEqual(diverted.token, gate.token);
  assert.equal(diverted.snapshot.gate, 'DUE');

  const adopt = { kind: 'PARENT_DECISION', token: diverted.token, value: { kind: 'ADOPT', digest: digest(plan) } };
  const adopted = await kernel.advance(input('p0-gate-drift', 'adopt', adopt, diverted.snapshot));
  assert.equal(adopted.kind, 'WAITING');
  assert.equal(adopted.snapshot.gate, 'NOT-DUE');
  assert.equal(adopted.snapshot.authorityEpoch, oldEpochs.authority + 1);
  assert.equal(adopted.snapshot.attemptEpoch, oldEpochs.attempt + 1);
  assert.equal(adopted.snapshot.barrierEpoch, oldEpochs.barrier + 1);
  let resumed = adopted;
  let state; let current;
  for (let index = 0; index < 3 && !current; index += 1) {
    resumed = await kernel.advance(input('p0-gate-drift', `fresh-resume-${index}`, { kind: 'RESUME' }, resumed.snapshot));
    state = (await new FileArtifactStore(root).load()).state;
    current = selectCurrentCommand(state, ['ACKED']);
  }
  assert.ok(current);
  assert.equal(current.command.authorityEpoch, adopted.snapshot.authorityEpoch);
  assert.notEqual(current.command.launchToken, oldCommand.launchToken);
  assert.notEqual(resumed.snapshot.gate, 'PASS');
  let progressed = await kernel.advance(input('p0-gate-drift', 'fresh-worker-1', { kind: 'WORKER_ENVELOPE', ref: ref(`worker:${current.command.launchToken}`, { status: 'DONE' }) }, resumed.snapshot, current.command.launchToken));
  if (progressed.kind === 'WAITING') {
    let next;
    for (let index = 0; index < 3 && !next; index += 1) {
      progressed = await kernel.advance(input('p0-gate-drift', `fresh-new-resume-${index}`, { kind: 'RESUME' }, progressed.snapshot));
      const nextState = (await new FileArtifactStore(root).load()).state;
      next = selectCurrentCommand(nextState, ['ACKED']);
    }
    assert.equal(next?.command.stepId, 'new');
    progressed = await kernel.advance(input('p0-gate-drift', 'fresh-worker-2', { kind: 'WORKER_ENVELOPE', ref: ref(`worker:${next.command.launchToken}`, { status: 'DONE' }) }, progressed.snapshot, next.command.launchToken));
  }
  assert.equal(progressed.kind, 'FINAL');
  assert.equal(progressed.status, 'phase-ready');
  assert.equal(progressed.snapshot.gate, 'DUE');
});

test('malformed live drift preserves non-stranding due-gate PASS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p0-malformed-gate-'));
  const plan = { phaseId: 'p0', gateRequired: true, steps: [{ stepId: 'only' }] };
  const { kernel, gate } = await dueGate(root, 'p0-malformed-gate', plan);
  plan.steps[0].dependencies = ['missing'];
  const pass = { kind: 'PARENT_DECISION', token: gate.token, value: 'PASS' };
  const completed = await kernel.advance(input('p0-malformed-gate', 'pass', pass, gate.snapshot));
  assert.equal(completed.kind, 'FINAL');
  assert.equal(completed.status, 'complete');
});

function command(state = 'ACKED') {
  const value = {
    commandId: 'command', runId: 'run', phaseId: 'phase', stepId: 'step',
    attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0,
    launchToken: 'launch', state,
  };
  value.commandDigest = digest({ commandId: value.commandId, runId: value.runId, phaseId: value.phaseId, stepId: value.stepId, attemptEpoch: value.attemptEpoch, launchToken: value.launchToken });
  if (state !== 'PENDING') value.leaseId = 'lease:0:writer-prior';
  return value;
}

function machine(outboxCommand, managed) {
  return {
    schema: managed ? 2 : 1, runId: 'run', phaseId: 'phase', revision: 1,
    authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0, modeEpoch: 0,
    writerFence: 'writer-current', status: 'ACTIVE', gate: 'NOT-DUE', barrier: 'OPEN',
    steps: { step: { stepId: 'step', status: 'ACTIVE', attempt: 0 } },
    outbox: { command: outboxCommand }, processed: {}, decisionTokens: {},
    planDigest: 'a'.repeat(64), nextAction: 'await', journal: [],
    ...(managed ? { managed } : {}),
  };
}

test('one selector applies exact frame and lease identity to every disposition', () => {
  for (const disposition of ['PENDING', 'CLAIMED', 'UNKNOWN', 'ACKED']) {
    const item = command(disposition);
    const state = machine(item);
    assert.equal(selectCurrentCommand(state, [disposition])?.command, item);
    assert.equal(selectCurrentCommand({ ...state, attemptEpoch: 1 }, [disposition]), undefined);
    assert.equal(selectCurrentCommand({ ...state, modeEpoch: 1 }, [disposition]), undefined);
    assert.equal(selectCurrentCommand(state, [disposition], { ...item, leaseId: 'other' }), undefined);
  }
  const first = command('PENDING');
  const second = { ...command('ACKED'), commandId: 'second', stepId: 'second', launchToken: 'launch-second' };
  second.commandDigest = digest({ commandId: second.commandId, runId: second.runId, phaseId: second.phaseId, stepId: second.stepId, attemptEpoch: second.attemptEpoch, launchToken: second.launchToken });
  const state = machine(first); state.steps.second = { stepId: 'second', status: 'ACTIVE', attempt: 0 }; state.outbox.second = second;
  assert.equal(selectCurrentCommand(state, ['PENDING', 'ACKED'], second)?.command, second);
});

test('managed ACKED selection requires the exact retained authority anchor', () => {
  const item = { ...command('ACKED'), roleView: ref('role', { role: true }), predecessorReportDigests: [] };
  const baseManaged = { capability: { schema: 'invalid-test-only' }, killSwitch: false, waveCounters: {}, reservations: {}, leaseSets: {}, attempts: { command: { commandId: 'command', epoch: 0, reservationId: 'command', status: 'SUCCESS', leaseId: item.leaseId } }, acceptedReports: {}, settlements: {}, settlementOrigins: {} };
  assert.equal(selectCurrentCommand(machine(item, baseManaged), ['ACKED']), undefined);
  const authorityAnchor = ref('anchor', { authority: true });
  const managed = clone(baseManaged); managed.attempts.command.authorityAnchor = authorityAnchor;
  assert.deepEqual(selectCurrentCommand(machine(item, managed), ['ACKED'])?.authorityAnchor, authorityAnchor);
});

function effectChain() {
  const retainedCommand = command('ACKED');
  const common = {
    launchToken: retainedCommand.launchToken, commandDigest: retainedCommand.commandDigest,
    commandId: retainedCommand.commandId, runId: retainedCommand.runId, phaseId: retainedCommand.phaseId, stepId: retainedCommand.stepId,
    attempt: 0, attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0,
    policyDigest: '1'.repeat(64), authorityDigest: '2'.repeat(64), handoffDigest: '3'.repeat(64), argvDigest: '4'.repeat(64),
    codexPath: '/codex', codexVersion: '1.0.0', codexBinaryDigest: '5'.repeat(64), workspace: '/workspace', supervisor: { pid: 1 }, startedAt: '2026-01-01T00:00:00.000Z',
  };
  const intent = { schema: 'lunacy-codex-launch-intent/v1', ...common };
  const launch = { schema: 'lunacy-codex-launch/v1', ...common, child: { pid: 2 } };
  const reportText = 'Status: PASS\n';
  const reportDigest = sha256(reportText);
  const reportPath = '/run/phases/phase/reports/step-worker-0.md';
  const outputText = canonicalString({ status: 'PASS', reportPath, reportDigest });
  const terminal = { schema: 'lunacy-codex-terminal/v1', launchToken: retainedCommand.launchToken, commandDigest: retainedCommand.commandDigest, status: 'PASS', outcome: 'normal-completion', exitCode: 0, signal: null, resultDigest: sha256(outputText), reportPath, reportDigest, eventsDigest: '6'.repeat(64), finishedAt: '2026-01-01T00:00:01.000Z' };
  const output = { kind: 'ok', bytes: Buffer.from(outputText), text: outputText, digest: terminal.resultDigest };
  const report = { kind: 'ok', bytes: Buffer.from(reportText), text: reportText, digest: reportDigest };
  return { retainedCommand, intent, launch, terminal, output, report };
}

test('staged historical validator owns command -> intent -> launch -> terminal/result/report', () => {
  const chain = effectChain();
  const launchFacts = validateHistoricalCodexEffect({ command: chain.retainedCommand, runRoot: '/run', requiredStage: 'launch', intent: chain.intent, launch: chain.launch });
  assert.deepEqual(launchFacts.launchRef, launchRecordRef(chain.launch));
  const terminalFacts = validateHistoricalCodexEffect({ command: chain.retainedCommand, runRoot: '/run', requiredStage: 'terminal', ...chain });
  assert.deepEqual(terminalFacts.terminalRef, terminalRecordRef(chain.terminal));

  for (const mutation of [
    (value) => { value.intent.authorityEpoch = 1; },
    (value) => { value.launch.barrierEpoch = 1; },
    (value) => { value.terminal.finishedAt = '2025-12-31T23:59:59.000Z'; },
    (value) => { value.output.digest = '7'.repeat(64); },
    (value) => { value.report.text = 'Status: PASS\nStatus: PASS\n'; },
    (value) => { value.retainedCommand.modeEpoch = 1; },
  ]) {
    const changed = clone(chain);
    changed.output.bytes = Buffer.from(changed.output.text); changed.report.bytes = Buffer.from(changed.report.text);
    mutation(changed);
    assert.throws(() => validateHistoricalCodexEffect({ command: changed.retainedCommand, runRoot: '/run', requiredStage: 'terminal', ...changed }));
  }
});

test('state and CURRENT persistence reject nonzero modeEpoch without deleting the field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p0-mode-'));
  const plan = { phaseId: 'mode', steps: [{ stepId: 'step' }] };
  const kernel = composeKernel({ plan, rootDir: root, maxInFlight: 0 });
  await kernel.advance(input('mode-zero', 'start', { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }));
  const store = new FileArtifactStore(root);
  const loaded = await store.load();
  const changed = clone(loaded.state); changed.modeEpoch = 1;
  await assert.rejects(() => store.commit(loaded.generation, changed), /modeEpoch.*zero|modeEpoch.*unsupported/i);
  assert.equal((await store.load()).state.modeEpoch, 0);
  const currentPath = join(root, '.kernel', 'CURRENT');
  const current = JSON.parse(await readFile(currentPath, 'utf8')); current.modeEpoch = 1;
  await writeFile(currentPath, canonicalString(current));
  await assert.rejects(() => store.load(), /CURRENT.*modeEpoch|modeEpoch.*unsupported/i);
});

test('supported persisted schema-1/schema-2 roots retain pre-tightening zero-mode bytes without migration', async () => {
  const plan = { phaseId: 'compat', steps: [{ stepId: 'step' }] };
  const legacy = createInitialState('compat-schema-1', plan, digest(plan), 'compat-writer');
  const fixtures = [
    {
      schema: 1,
      state: legacy,
      stateSha256: '9e287ebcfb7ebde0f291e40fd215c3ffe0c46baab3b37ee69da806d7e920d01d',
      currentSha256: '6eb5f791d64c00c778f768630b1e7d4ac2ea24097de3d3de78af5039115b7096',
    },
    {
      schema: 2,
      state: migrateMachineState(createInitialState('compat-schema-2', plan, digest(plan), 'compat-writer'), createManagedCapability()),
      stateSha256: 'bff950a4832086d5038d41b1b524683033fc1b16fd4268a1e51b9ac9861ab5bb',
      currentSha256: 'ebf8d30319b3a4c62f187c6cabd683c7d8efa20d500a43aa37cb6355ca43b688',
    },
  ];
  for (const fixture of fixtures) {
    const root = await mkdtemp(join(tmpdir(), `lunacy-p0-compat-schema-${fixture.schema}-`));
    try {
      const expectedStateBytes = canonicalString(fixture.state);
      assert.equal(fixture.state.schema, fixture.schema);
      assert.equal(fixture.state.modeEpoch, 0);
      assert.equal(sha256(expectedStateBytes), fixture.stateSha256);
      const store = new FileArtifactStore(root);
      await store.commit(0, fixture.state);
      const currentPath = join(root, '.kernel', 'CURRENT');
      const currentBefore = await readFile(currentPath, 'utf8');
      const current = JSON.parse(currentBefore);
      const statePath = join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json');
      const stateBefore = await readFile(statePath, 'utf8');
      assert.equal(stateBefore, expectedStateBytes);
      assert.equal(sha256(currentBefore), fixture.currentSha256);
      assert.equal(JSON.parse(stateBefore).modeEpoch, 0);
      assert.equal(current.modeEpoch, 0);
      const loaded = await store.load();
      assert.equal(loaded.state.schema, fixture.schema);
      assert.equal(loaded.state.modeEpoch, 0);
      assert.equal(await readFile(statePath, 'utf8'), stateBefore);
      assert.equal(await readFile(currentPath, 'utf8'), currentBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('fresh claim, recovery, and receipt transitions reject nonzero modeEpoch', () => {
  assert.throws(() => claim({ ...command('PENDING'), modeEpoch: 1 }, 'lease', 1, 'writer'), /modeEpoch.*unsupported/i);
  assert.throws(() => unknown({ ...command('CLAIMED'), modeEpoch: 1 }), /modeEpoch.*unsupported/i);
  assert.throws(() => acknowledge({ ...command('PENDING'), modeEpoch: 1 }, { launchToken: 'launch', commandDigest: command('PENDING').commandDigest, ref: ref('receipt', { ok: true }) }), /modeEpoch.*unsupported/i);
});
