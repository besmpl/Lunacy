import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { transition } from '../dist/bridge.js';
import { drive } from '../dist/orchestration.js';
import { FileArtifactStore } from '../dist/store.js';

const ref = (id, value, scope = 'test') => ({ id, scope, digest: digest(value), bytes: canonicalString(value) });
const terminal = (command, status = 'PASS', outcome = 'normal-completion') => ({
  schema: 'lunacy-codex-terminal/v1', launchToken: command.launchToken, commandDigest: command.commandDigest,
  status, outcome, exitCode: status === 'PASS' ? 0 : 1, signal: null, resultDigest: null,
  reportPath: null, reportDigest: null, eventsDigest: digest('events'), finishedAt: new Date().toISOString(),
});

test('drive lets the kernel select each successor and stops at phase-ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-pump-'));
  const plan = { phaseId: 'pump-phase', steps: [{ stepId: 'first' }, { stepId: 'second', dependencies: ['first'] }] };
  const commands = new Map(); const launches = [];
  const driver = {
    dispatch(command, launchToken) {
      launches.push(command.stepId); commands.set(launchToken, command);
      return { launchToken, commandDigest: command.commandDigest, ref: ref(`launch:${launchToken}`, { launched: true }, 'effect') };
    },
    terminal(launchToken) { return terminal(commands.get(launchToken)); },
  };
  const result = await drive({ runDir: root, runId: 'pump-run', plan, driver });
  assert.equal(result.stopped, 'parent-boundary');
  assert.equal(result.yield.kind, 'FINAL');
  assert.equal(result.yield.status, 'phase-ready');
  assert.equal(result.transitions, 5);
  assert.deepEqual(launches, ['first', 'second']);
});

test('non-pass terminal status is enveloped once and prevents successor launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-pump-stop-'));
  const plan = { phaseId: 'pump-stop', steps: [{ stepId: 'first' }, { stepId: 'second', dependencies: ['first'] }] };
  const commands = new Map(); const launches = [];
  const driver = {
    dispatch(command, launchToken) { launches.push(command.stepId); commands.set(launchToken, command); return { launchToken, commandDigest: command.commandDigest, ref: ref('launch', { ok: true }, 'effect') }; },
    terminal(launchToken) { return terminal(commands.get(launchToken), 'NEEDS-DECISION', 'approval-required'); },
  };
  const result = await drive({ runDir: root, runId: 'pump-stop-run', plan, driver });
  assert.equal(result.stopped, 'parent-boundary');
  assert.equal(result.terminal.status, 'NEEDS-DECISION');
  assert.deepEqual(launches, ['first']);
  assert.equal(result.yield.snapshot.runStatus, 'BLOCKED');
});

test('restart reconciles a claimed token through observe without relaunching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-pump-restart-'));
  const plan = { phaseId: 'pump-restart', steps: [{ stepId: 'first' }] };
  const started = await transition({ runDir: root, runId: 'pump-restart-run', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: ref('plan', plan) }, eventId: 'start' });
  let claimed; let resolveDispatch;
  const interrupted = { dispatch(command) { claimed = command; return new Promise((resolvePromise) => { resolveDispatch = resolvePromise; }); } };
  await transition({ runDir: root, runId: 'pump-restart-run', mode: 'runtime', plan, driver: interrupted, dispatcher: { timeoutMs: 0 } }, { event: { kind: 'RESUME' }, eventId: 'resume', expectedRevision: started.yield.snapshot.revision });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  claimed = Object.values((await new FileArtifactStore(root).load()).state.outbox).find((command) => command.state === 'UNKNOWN');
  assert.ok(claimed);
  let dispatches = 0; let observes = 0;
  const recovered = {
    dispatch() { dispatches += 1; throw new Error('restart must not relaunch'); },
    observe(launchToken) { observes += 1; return { launchToken, commandDigest: claimed.commandDigest, ref: ref('launch', { recovered: true }, 'effect') }; },
    terminal() { return terminal(claimed); },
  };
  const result = await drive({ runDir: root, runId: 'pump-restart-run', plan, driver: recovered });
  assert.equal(result.yield.kind, 'FINAL');
  assert.equal(dispatches, 0);
  assert.equal(observes, 1);
  resolveDispatch?.();
});

test('restart performs one asynchronous exact-token observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-pump-async-restart-'));
  const plan = { phaseId: 'pump-async-restart', steps: [{ stepId: 'first' }] };
  const started = await transition({ runDir: root, runId: 'pump-async-run', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: ref('plan', plan) }, eventId: 'start' });
  let resolveDispatch;
  await transition({ runDir: root, runId: 'pump-async-run', mode: 'runtime', plan, driver: { dispatch() { return new Promise((resolvePromise) => { resolveDispatch = resolvePromise; }); } }, dispatcher: { timeoutMs: 0 } }, { event: { kind: 'RESUME' }, eventId: 'resume', expectedRevision: started.yield.snapshot.revision });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  const state = (await new FileArtifactStore(root).load()).state;
  const command = Object.values(state.outbox).find((candidate) => candidate.state === 'UNKNOWN');
  assert.ok(command);
  let observes = 0;
  const driver = {
    dispatch() { throw new Error('restart must not relaunch'); },
    async observe(launchToken) {
      observes += 1;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      return { launchToken, commandDigest: command.commandDigest, ref: ref('launch', { recovered: true }, 'effect') };
    },
    terminal() { return terminal(command); },
  };
  const result = await drive({ runDir: root, runId: 'pump-async-run', plan, driver });
  assert.equal(result.yield.kind, 'FINAL');
  assert.equal(observes, 1);
  resolveDispatch?.();
});

test('receipt settlement tolerates early and late callbacks', async () => {
  for (const order of ['terminal-before-receipt', 'receipt-before-terminal']) {
    const root = await mkdtemp(join(tmpdir(), `lunacy-pump-settlement-${order}-`));
    const plan = { phaseId: `pump-settlement-${order}`, steps: [{ stepId: 'first' }] };
    let command;
    let resolveReceipt;
    let resolveTerminal;
    let terminalSeenResolve;
    let dispatchSeenResolve;
    let terminalCalled = false;
    const dispatchSeen = new Promise((resolvePromise) => { dispatchSeenResolve = resolvePromise; });
    const terminalSeen = new Promise((resolvePromise) => { terminalSeenResolve = resolvePromise; });
    const driver = {
      dispatch(candidate) {
        command = candidate;
        dispatchSeenResolve();
        const receipt = { launchToken: candidate.launchToken, commandDigest: candidate.commandDigest, ref: ref(`launch:${order}`, { order }, 'effect') };
        return new Promise((resolvePromise) => { resolveReceipt = () => resolvePromise(receipt); });
      },
      terminal(candidateToken) {
        terminalCalled = true;
        terminalSeenResolve();
        const value = terminal({ launchToken: candidateToken, commandDigest: command.commandDigest });
        if (order === 'terminal-before-receipt') return Promise.resolve(value);
        return new Promise((resolvePromise) => { resolveTerminal = () => resolvePromise(value); });
      },
    };
    const running = drive({ runDir: root, runId: `pump-settlement-${order}-run`, plan, driver });
    await dispatchSeen;
    if (order === 'terminal-before-receipt') {
      // The child has already finished, but its receipt callback is delayed.
      // The pump must retain the early/late notification without polling.
      resolveReceipt();
    } else {
      // Let the pump attach its waiter before publishing the receipt.
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      resolveReceipt();
    }
    if (order === 'receipt-before-terminal') {
      await terminalSeen;
      assert.equal(terminalCalled, true);
      resolveTerminal();
    }
    const result = await running;
    assert.equal(result.stopped, 'parent-boundary');
    assert.equal(result.yield.kind, 'FINAL');
    assert.equal(result.yield.status, 'phase-ready');
  }
});

test('competing pumps settle one launch and do not strand a waiter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-pump-competing-'));
  const plan = { phaseId: 'pump-competing', steps: [{ stepId: 'first' }] };
  const commands = new Map();
  let dispatches = 0;
  const driver = {
    dispatch(command, launchToken) {
      dispatches += 1;
      commands.set(launchToken, command);
      return Promise.resolve({ launchToken, commandDigest: command.commandDigest, ref: ref(`launch:${launchToken}`, { dispatches }, 'effect') });
    },
    terminal(launchToken) { return terminal(commands.get(launchToken)); },
  };
  const [left, right] = await Promise.all([
    drive({ runDir: root, runId: 'pump-competing-run', plan, driver }),
    drive({ runDir: root, runId: 'pump-competing-run', plan, driver }),
  ]);
  assert.equal(dispatches, 1);
  assert.ok([left, right].every((result) => result.yield?.kind === 'FINAL' && result.yield.status === 'phase-ready'));
  assert.ok([left, right].every((result) => result.stopped === 'parent-boundary'));
});

test('abort closes the notification channel while a late receipt is still pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-pump-abort-'));
  const plan = { phaseId: 'pump-abort', steps: [{ stepId: 'first' }] };
  let command;
  let resolveReceipt;
  let dispatchSeenResolve;
  const dispatchSeen = new Promise((resolvePromise) => { dispatchSeenResolve = resolvePromise; });
  const driver = {
    dispatch(candidate) {
      command = candidate;
      dispatchSeenResolve();
      return new Promise((resolvePromise) => { resolveReceipt = resolvePromise; });
    },
    terminal() { return undefined; },
  };
  const controller = new AbortController();
  const running = drive({ runDir: root, runId: 'pump-abort-run', plan, driver, signal: controller.signal });
  await dispatchSeen;
  controller.abort();
  const result = await running;
  assert.equal(result.stopped, 'cancelled');
  resolveReceipt?.({ launchToken: command.launchToken, commandDigest: command.commandDigest, ref: ref('late', { late: true }, 'effect') });
});
