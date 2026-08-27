import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { canonicalizeDeclaration, transition } from '../dist/bridge.js';
import { runBridgeCli } from '../dist/bridge-cli.js';
import { drive } from '../dist/orchestration.js';
import { CodexExecDriver } from '../dist/codex-exec-driver.js';
import { CodexExecSupervisor } from '../dist/codex-exec-supervisor.js';
import { createCodexHostPolicy, expectedReportPath } from '../dist/codex-host-policy.js';
import { effectPaths, readLaunchIntentRecord, readTerminalRecord } from '../dist/codex-effect-records.js';

const ref = (id, value, scope = 'test') => ({ id, scope, digest: digest(value), bytes: canonicalString(value) });

class FakeChild extends EventEmitter {
  constructor(onInput = () => undefined) {
    super();
    this.pid = 6444;
    this.stdout = new EventEmitter(); this.stdout.destroy = () => { this.stdout.destroyed = true; };
    this.stderr = new EventEmitter(); this.stderr.destroy = () => { this.stderr.destroyed = true; };
    this.stdin = { end: (text) => { void onInput(String(text)); }, destroy: () => { this.stdin.destroyed = true; } };
    this.signals = [];
  }
  kill(signal) { this.signals.push(signal); return true; }
}

async function policyFixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r9a-'));
  const workspace = join(root, 'workspace'); const skillRoot = join(root, 'skill'); const codexPath = join(root, 'codex');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(skillRoot, 'worker'), { recursive: true });
  await mkdir(join(root, 'phases', 'phase-a'), { recursive: true });
  await writeFile(join(root, 'PLAN.md'), '# plan\n'); await writeFile(join(root, 'DECISIONS.md'), '# decisions\n');
  await writeFile(join(root, 'phases', 'phase-a', 'STEPS.md'), '# steps\n');
  await writeFile(join(skillRoot, 'worker', 'ENGINEERING.md'), '# engineering\n');
  await writeFile(join(root, 'schema.json'), '{}\n'); await writeFile(codexPath, '#!/bin/sh\nexit 0\n'); await chmod(codexPath, 0o755);
  const workerSchemaDigest = createHash('sha256').update('{}\n').digest('hex');
  const plan = overrides.plan ?? { phaseId: 'phase-a', steps: [{ stepId: 'step-a' }] };
  const policy = createCodexHostPolicy({
    runId: overrides.runId ?? 'run-r9a', planDigest: overrides.planDigest ?? digest(canonicalizeDeclaration(plan)), runRoot: overrides.runRoot ?? root,
    workspace, skillRoot, codexPath, codexBinaryDigest: '2'.repeat(64), workerSchemaPath: join(root, 'schema.json'), workerSchemaDigest,
    timeoutMs: overrides.timeoutMs ?? 10_000, cancellationGraceMs: overrides.cancellationGraceMs ?? 0,
  });
  const command = { commandId: 'command-r9a', runId: policy.runId, phaseId: 'phase-a', stepId: 'step-a', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0, launchToken: 'launch-r9a', state: 'CLAIMED' };
  command.commandDigest = digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken });
  return { root, workspace, skillRoot, codexPath, plan, policy, command };
}

const attestation = (policy) => async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion });

function noDispatchDriver(policy, counters, extra = {}) {
  return { hostPolicy: policy, dispatch() { counters.dispatch += 1; throw new Error('must not dispatch'); }, observe() { counters.observe += 1; return undefined; }, ...extra };
}

test('managed drive rejects run-root, run-id, input-plan, committed-plan, and restart-policy mismatches before effects', async () => {
  // Literal root and run-id mismatches.
  for (const mismatch of ['run-root', 'run-id']) {
    const fixture = await policyFixture(); const counters = { dispatch: 0, observe: 0 };
    const options = mismatch === 'run-root'
      ? { runDir: await mkdtemp(join(tmpdir(), 'lunacy-r9a-other-root-')), runId: fixture.policy.runId, plan: fixture.plan }
      : { runDir: fixture.root, runId: 'other-run', plan: fixture.plan };
    await assert.rejects(() => drive({ ...options, driver: noDispatchDriver(fixture.policy, counters) }), /policy run root mismatch|policy run id mismatch/);
    assert.deepEqual(counters, { dispatch: 0, observe: 0 }, mismatch);
  }

  // Validated input plan must equal policy authority.
  {
    const fixture = await policyFixture(); const counters = { dispatch: 0, observe: 0 };
    const otherPlan = { phaseId: 'phase-a', steps: [{ stepId: 'different' }] };
    await assert.rejects(() => drive({ runDir: fixture.root, runId: fixture.policy.runId, plan: otherPlan, driver: noDispatchDriver(fixture.policy, counters) }), /input plan mismatch/);
    assert.deepEqual(counters, { dispatch: 0, observe: 0 });
  }

  // A restart cannot join a different committed normalized plan even if its
  // fresh input and policy agree with each other.
  {
    const fixture = await policyFixture();
    await transition({ runDir: fixture.root, runId: fixture.policy.runId, mode: 'runtime', plan: fixture.plan }, { event: { kind: 'START', intentRef: ref('plan', fixture.plan) }, eventId: 'start' });
    const otherPlan = { phaseId: 'phase-a', steps: [{ stepId: 'different' }] };
    const other = createCodexHostPolicy({ ...fixture.policy, planDigest: digest(canonicalizeDeclaration(otherPlan)) });
    const counters = { dispatch: 0, observe: 0 };
    await assert.rejects(() => drive({ runDir: fixture.root, runId: fixture.policy.runId, plan: otherPlan, driver: noDispatchDriver(other, counters) }), /committed run\/plan/);
    assert.deepEqual(counters, { dispatch: 0, observe: 0 });
  }

  // A policy getter swapped after composition is rejected before restart
  // observation; the captured policy cannot be exchanged between checks.
  {
    const fixture = await policyFixture();
    await transition({ runDir: fixture.root, runId: fixture.policy.runId, mode: 'runtime', plan: fixture.plan }, { event: { kind: 'START', intentRef: ref('plan', fixture.plan) }, eventId: 'start' });
    const changed = createCodexHostPolicy({ ...fixture.policy, timeoutMs: fixture.policy.timeoutMs + 1 });
    let reads = 0; const counters = { dispatch: 0, observe: 0 };
    const driver = noDispatchDriver(fixture.policy, counters);
    Object.defineProperty(driver, 'hostPolicy', { get() { reads += 1; return reads <= 2 ? fixture.policy : changed; } });
    await assert.rejects(() => drive({ runDir: fixture.root, runId: fixture.policy.runId, plan: fixture.plan, driver }), /managed policy changed/);
    assert.deepEqual(counters, { dispatch: 0, observe: 0 });
  }
});

test('cancellation is serialized SIGINT -> SIGTERM -> SIGKILL for the owned child tree and zero grace advances', async () => {
  const { policy, command } = await policyFixture({ cancellationGraceMs: 0 });
  let child; const groupSignals = []; const descendant = { interrupt: 'ignored', terminate: 'ignored', killed: false };
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { child = new FakeChild(); return child; },
    attestExecutable: attestation(policy),
    signalProcessTree: (_pid, signal) => {
      groupSignals.push(signal);
      if (signal === 'SIGKILL') { descendant.killed = true; process.nextTick(() => child.emit('close', null, 'SIGKILL')); }
    },
  });
  await supervisor.start({ command: { ...command, planDigest: policy.planDigest }, policy });
  await Promise.all([supervisor.cancel(), supervisor.cancel(), supervisor.cancel()]);
  const terminal = await supervisor.wait();
  assert.deepEqual(groupSignals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.equal(descendant.killed, true); assert.equal(terminal.outcome, 'cancellation'); assert.equal(terminal.status, 'BLOCKED');
  assert.equal(child.listenerCount('close'), 0); assert.equal(child.listenerCount('error'), 0);
  assert.equal(child.stdout.listenerCount('data'), 0); assert.equal(child.stderr.listenerCount('data'), 0);
  assert.equal(supervisor.child, undefined); assert.equal(supervisor.timeoutTimer, undefined); assert.equal(supervisor.reapTimer, undefined);
});

test('timeout creates a bounded unresolved fence, admits no relaunch, and releases driver/process resources', async () => {
  const { policy, command } = await policyFixture({ timeoutMs: 5, cancellationGraceMs: 0 });
  let child; const signals = [];
  const driver = new CodexExecDriver({
    policy,
    supervisor: { spawnProcess: () => { child = new FakeChild(); return child; }, attestExecutable: attestation(policy), signalProcessTree: (_pid, signal) => { signals.push(signal); } },
  });
  await driver.dispatch(command, command.launchToken);
  const terminal = await driver.waitTerminal(command.launchToken);
  assert.equal(terminal?.status, 'UNKNOWN'); assert.equal(terminal?.outcome, 'unresolved-termination');
  assert.deepEqual(signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.equal(driver.supervisors.size, 0); assert.equal(child.listenerCount('close'), 0); assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stdout.destroyed, true); assert.equal(child.stderr.destroyed, true); assert.equal(child.stdin.destroyed, true);
  await assert.rejects(() => driver.dispatch(command, command.launchToken), /launch intent already exists|launch record already exists/);
  assert.equal(driver.supervisors.size, 0);

  const pumpRoot = await mkdtemp(join(tmpdir(), 'lunacy-r9a-unresolved-pump-'));
  const pumpPlan = { phaseId: 'unresolved-pump', steps: [{ stepId: 'first' }, { stepId: 'successor', dependencies: ['first'] }] };
  const launches = []; const commands = new Map();
  const pumpResult = await drive({
    runDir: pumpRoot, runId: 'unresolved-pump-run', plan: pumpPlan,
    driver: {
      dispatch(candidate, token) { launches.push(candidate.stepId); commands.set(token, candidate); return { launchToken: token, commandDigest: candidate.commandDigest, ref: ref('launch', { token }, 'effect') }; },
      terminal(token) { const candidate = commands.get(token); return { schema: 'lunacy-codex-terminal/v1', launchToken: token, commandDigest: candidate.commandDigest, status: 'UNKNOWN', outcome: 'unresolved-termination', exitCode: null, signal: null, resultDigest: null, reportPath: null, reportDigest: null, eventsDigest: digest('events'), finishedAt: new Date().toISOString() }; },
    },
  });
  assert.equal(pumpResult.stopped, 'terminal-invalid'); assert.deepEqual(launches, ['first']);
});

test('launch-record publication failure performs bounded tree termination and deterministic cleanup', async () => {
  const { policy, command } = await policyFixture({ cancellationGraceMs: 0 });
  let child; const signals = [];
  const supervisor = new CodexExecSupervisor({
    policy, spawnProcess: () => { child = new FakeChild(); return child; }, attestExecutable: attestation(policy),
    signalProcessTree: (_pid, signal) => { signals.push(signal); if (signal === 'SIGKILL') process.nextTick(() => child.emit('close', null, 'SIGKILL')); },
    writeLaunch: async () => { throw new Error('injected launch-record failure'); },
  });
  await assert.rejects(() => supervisor.start({ command: { ...command, planDigest: policy.planDigest }, policy }), /injected launch-record failure/);
  assert.deepEqual(signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  assert.equal((await readLaunchIntentRecord(policy, command.launchToken))?.launchToken, command.launchToken);
  assert.equal(await readTerminalRecord(policy, command.launchToken), undefined);
  assert.equal(supervisor.child, undefined); assert.equal(child.listenerCount('close'), 0); assert.equal(child.stdout.listenerCount('data'), 0);
});

async function runSupervisorCase({ stdout, stderr = '', report = '## Control\nStatus: PASS\n', resultStatus = 'PASS', exitCode = 0, closeSignal = null }) {
  const { policy, command } = await policyFixture(); let child;
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: (_executable, args) => {
      child = new FakeChild(async () => {
        const reportPath = expectedReportPath(policy, command); await mkdir(join(policy.runRoot, 'phases', 'phase-a', 'reports'), { recursive: true });
        const reportBytes = Buffer.from(report); await writeFile(reportPath, reportBytes);
        const outputPath = args[args.indexOf('--output-last-message') + 1];
        const result = { reportDigest: createHash('sha256').update(reportBytes).digest('hex'), reportPath, status: resultStatus };
        await writeFile(outputPath, JSON.stringify(result));
        if (stdout) child.stdout.emit('data', stdout); if (stderr) child.stderr.emit('data', stderr);
        process.nextTick(() => child.emit('close', exitCode, closeSignal));
      });
      return child;
    },
    attestExecutable: attestation(policy),
  });
  await supervisor.start({ command: { ...command, planDigest: policy.planDigest }, policy });
  return { terminal: await supervisor.wait(), policy, command };
}

test('closed host classifier ignores prose/commands/success output and recognizes only structural lifecycle evidence', async () => {
  const benign = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'cancellation approval required turn failed provider error' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', status: 'completed', command: 'echo approval required', aggregated_output: 'cancelled; turn failed; provider error' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n') + '\n';
  assert.equal((await runSupervisorCase({ stdout: benign })).terminal.status, 'PASS');

  const cases = [
    ['approval-required', { type: 'item.completed', item: { type: 'command_execution_output', status: 'approval_required', message: 'approval required' } }],
    ['cancellation', { type: 'turn.cancelled' }],
    ['turn-failure', { type: 'turn.failed', error: { message: 'provider error' } }],
    ['sandbox-denial', { type: 'item.completed', item: { type: 'command_execution_output', status: 'denied', message: 'sandbox denied' } }],
  ];
  for (const [outcome, event] of cases) {
    const terminal = (await runSupervisorCase({ stdout: `${JSON.stringify(event)}\n` })).terminal;
    assert.equal(terminal.outcome, outcome); assert.notEqual(terminal.status, 'PASS');
  }
});

test('malformed/truncated JSONL fails closed and reports require exactly one Status line with raw binding intact', async () => {
  for (const stdout of ['{not-json}\n{"type":"turn.completed"}\n', '{"type":"turn.comp']) {
    const terminal = (await runSupervisorCase({ stdout })).terminal;
    assert.equal(terminal.outcome, 'host-evidence-failure'); assert.equal(terminal.status, 'BLOCKED');
  }
  const duplicate = await runSupervisorCase({ stdout: '{"type":"turn.completed"}\n', report: 'Status: PASS\nStatus: PASS\n' });
  assert.equal(duplicate.terminal.status, 'BLOCKED'); assert.equal(duplicate.terminal.outcome, 'malformed-final-output');
  assert.equal((await new CodexExecDriver({ policy: duplicate.policy, supervisor: { attestExecutable: attestation(duplicate.policy) } }).terminal(duplicate.command.launchToken))?.status, 'BLOCKED');

  // Property order remains irrelevant; the exact raw report/result bytes are
  // still the values whose digests bind live and restart acceptance.
  const reordered = await runSupervisorCase({ stdout: '{"type":"turn.completed"}\n', report: '## report\nStatus: PASS\n' });
  assert.equal(reordered.terminal.status, 'PASS');
  const paths = effectPaths(reordered.policy, reordered.command.launchToken);
  await writeFile(paths.output, JSON.stringify({ status: 'PASS', reportPath: expectedReportPath(reordered.policy, reordered.command), reportDigest: reordered.terminal.reportDigest, extra: true }));
  assert.equal(await new CodexExecDriver({ policy: reordered.policy, supervisor: { attestExecutable: attestation(reordered.policy) } }).terminal(reordered.command.launchToken), undefined);
});

test('managed CLI owns and removes SIGINT/SIGTERM/external AbortSignal listeners while cancelling the exact drive', async () => {
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signalName of signals) {
    const root = await mkdtemp(join(tmpdir(), 'lunacy-r9a-cli-')); const plan = { phaseId: 'cli-phase', steps: [{ stepId: 'one' }] }; const planPath = join(root, 'plan.json'); await writeFile(planPath, canonicalString(plan));
    let cancelCalls = 0; let resolveDispatch; let dispatchSeenResolve; const dispatchSeen = new Promise((resolve) => { dispatchSeenResolve = resolve; });
    const driver = { dispatch() { dispatchSeenResolve(); return new Promise((resolve) => { resolveDispatch = resolve; }); }, cancel() { cancelCalls += 1; } };
    const before = new Set(process.listeners(signalName));
    const running = runBridgeCli(['drive', '--run-dir', root, '--run-id', 'cli-run', '--mode', 'runtime', '--plan', planPath], driver);
    let owned;
    for (let attempt = 0; attempt < 1000 && !owned; attempt += 1) { owned = process.listeners(signalName).find((listener) => !before.has(listener)); if (!owned) await new Promise((resolve) => setImmediate(resolve)); }
    assert.ok(owned, `${signalName} listener installed`); await dispatchSeen; owned();
    assert.equal(await running, 0); assert.equal(cancelCalls, 1); assert.deepEqual(process.listeners(signalName), [...before]); resolveDispatch?.();
  }

  const root = await mkdtemp(join(tmpdir(), 'lunacy-r9a-cli-abort-')); const plan = { phaseId: 'cli-abort', steps: [{ stepId: 'one' }] }; const planPath = join(root, 'plan.json'); await writeFile(planPath, canonicalString(plan));
  const controller = new AbortController(); let cancelCalls = 0; let resolveDispatch; let dispatchSeenResolve; const dispatchSeen = new Promise((resolve) => { dispatchSeenResolve = resolve; });
  const running = runBridgeCli(['drive', '--run-dir', root, '--run-id', 'cli-abort-run', '--mode', 'runtime', '--plan', planPath], { dispatch() { dispatchSeenResolve(); return new Promise((resolve) => { resolveDispatch = resolve; }); }, cancel() { cancelCalls += 1; } }, controller.signal);
  await dispatchSeen; controller.abort();
  assert.equal(await running, 0); assert.equal(cancelCalls, 1); resolveDispatch?.();
});
