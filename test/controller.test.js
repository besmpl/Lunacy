import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { initRun, runRun, resumeRun, LifecycleError, lifecycleResultBytes } from '../dist/orchestration.js';
import { BridgeError, transition } from '../dist/bridge.js';
import { FileArtifactStore } from '../dist/store.js';

const ref = (id, value, scope = 'test') => ({ id, scope, digest: digest(value), bytes: canonicalString(value) });
const terminal = (command) => ({ schema: 'lunacy-codex-terminal/v1', launchToken: command.launchToken, commandDigest: command.commandDigest, status: 'PASS', outcome: 'normal-completion', exitCode: 0, signal: null, resultDigest: null, reportPath: null, reportDigest: null, eventsDigest: digest('events'), finishedAt: '2025-01-01T00:00:00Z' });

function driverFor() {
  const commands = new Map();
  return {
    commands,
    dispatch(command, token) { commands.set(token, command); return { launchToken: token, commandDigest: command.commandDigest, ref: ref(`launch:${token}`, { launched: true }, 'effect') }; },
    terminal(token) { return terminal(commands.get(token)); },
  };
}

test('R1 init is idempotent and duplicate START replays exact bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-controller-init-'));
  const plan = { phaseId: 'controller-init', steps: [{ stepId: 'one' }] };
  const first = await initRun({ runDir: root, runId: 'controller-init-run', plan });
  const second = await initRun({ runDir: root, runId: 'controller-init-run', plan });
  assert.equal(first.stop, 'initialized');
  assert.equal(second.stop, 'initialized');
  assert.equal(first.yield.kind, 'WAITING');
  assert.equal(canonicalString(first.yield), canonicalString(second.yield));
  assert.equal(first.yield.snapshot.revision, 1);
  assert.equal((await new FileArtifactStore(root).load()).state.journal.length, 1);
});

test('R1 run drives dependent steps and returns bounded terminal result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-controller-run-'));
  const plan = { phaseId: 'controller-run', steps: [{ stepId: 'first' }, { stepId: 'second', dependencies: ['first'] }] };
  const driver = driverFor();
  const result = await runRun({ runDir: root, runId: 'controller-run-run', plan, driver });
  assert.equal(result.status, 'terminal');
  assert.equal(result.stop, 'parent-boundary');
  assert.equal(result.yield.kind, 'FINAL');
  assert.equal(result.yield.status, 'phase-ready');
  assert.deepEqual([...driver.commands.values()].map((command) => command.stepId), ['first', 'second']);
  assert.match(lifecycleResultBytes(result), /lunacy-lifecycle\/v1/);
});

test('R1 resume of UNKNOWN observes once and never relaunches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-controller-unknown-'));
  const plan = { phaseId: 'controller-unknown', steps: [{ stepId: 'one' }] };
  const started = await initRun({ runDir: root, runId: 'controller-unknown-run', plan });
  let resolveDispatch;
  await transition({ runDir: root, runId: 'controller-unknown-run', mode: 'runtime', plan, driver: { dispatch() { return new Promise((resolve) => { resolveDispatch = resolve; }); } }, dispatcher: { timeoutMs: 0 } }, { event: { kind: 'RESUME' }, eventId: 'unknown-resume', expectedRevision: started.yield.snapshot.revision });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const command = Object.values((await new FileArtifactStore(root).load()).state.outbox).find((candidate) => candidate.state === 'UNKNOWN');
  assert.ok(command);
  let dispatches = 0; let observes = 0;
  const result = await resumeRun({ runDir: root, runId: 'controller-unknown-run', plan, driver: {
    dispatch() { dispatches += 1; throw new Error('must not relaunch'); },
    observe(token) { observes += 1; return { launchToken: token, commandDigest: command.commandDigest, ref: ref('observed', { recovered: true }, 'effect') }; },
    terminal: () => terminal(command),
  } });
  assert.equal(result.status, 'terminal');
  assert.equal(result.yield.kind, 'FINAL');
  assert.equal(dispatches, 0);
  assert.equal(observes, 1);
  resolveDispatch?.();
});

test('R1 invalid driver fails before touching root and max transition is bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-controller-invalid-'));
  const plan = { phaseId: 'controller-invalid', steps: [{ stepId: 'one' }] };
  await assert.rejects(() => runRun({ runDir: root, runId: 'invalid-run', plan }), (error) => error instanceof LifecycleError && error.code === 'InvalidPolicy');
  await assert.rejects(() => runRun({ runDir: root, runId: 'invalid-policy-run', plan, policy: {} }), (error) => error instanceof LifecycleError && error.code === 'InvalidPolicy');
  const limited = await runRun({ runDir: root, runId: 'limited-run', plan, driver: driverFor(), maxTransitions: 1 });
  assert.equal(limited.stop, 'limit');
  assert.equal(limited.transitions, 1);
});

test('R1 duplicate RESUME invocations share one launch and exact final state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-controller-duplicate-resume-'));
  const plan = { phaseId: 'controller-duplicate-resume', steps: [{ stepId: 'one' }] };
  const driver = driverFor();
  const [left, right] = await Promise.all([
    resumeRun({ runDir: root, runId: 'controller-duplicate-run', plan, driver }),
    resumeRun({ runDir: root, runId: 'controller-duplicate-run', plan, driver }),
  ]);
  assert.equal(driver.commands.size, 1);
  assert.equal(canonicalString(left.yield), canonicalString(right.yield));
  assert.equal(left.status, 'terminal');
  assert.equal(right.status, 'terminal');
});

test('R1 cancellation returns attention without relaunching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-controller-cancel-'));
  const plan = { phaseId: 'controller-cancel', steps: [{ stepId: 'one' }] };
  const controller = new AbortController();
  let resolveDispatch;
  let seen;
  const driver = {
    dispatch(command, token) { seen = command; return new Promise((resolve) => { resolveDispatch = resolve; }); },
    cancel() { controller.abort(); },
  };
  const running = runRun({ runDir: root, runId: 'controller-cancel-run', plan, driver, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 40));
  controller.abort();
  const result = await running;
  assert.equal(result.stop, 'cancelled');
  assert.equal(result.status, 'attention');
  resolveDispatch?.({ launchToken: seen.launchToken, commandDigest: seen.commandDigest, ref: ref('late', { late: true }, 'effect') });
});

test('R1 projection failure keeps committed START replayable without a second transition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-controller-projection-'));
  const plan = { phaseId: 'controller-projection', steps: [{ stepId: 'one' }] };
  const first = await initRun({ runDir: root, runId: 'controller-projection-run', plan });
  const statePath = join(root, 'STATE.md');
  await fs.writeFile(statePath, (await fs.readFile(statePath, 'utf8')).replace('"revision":1', '"revision":999'), 'utf8');
  const originalRename = fs.rename;
  let barrierHit = false;
  fs.rename = async (...args) => {
    if (!barrierHit && String(args[1]).endsWith('/STATE.md')) {
      barrierHit = true;
      const error = new Error('projection barrier'); error.code = 'EIO'; throw error;
    }
    return originalRename(...args);
  };
  try {
    await assert.rejects(() => initRun({ runDir: root, runId: 'controller-projection-run', plan }), (error) => error instanceof BridgeError && error.code === 'ProjectionFailed');
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(barrierHit, true);
  const retry = await initRun({ runDir: root, runId: 'controller-projection-run', plan });
  assert.equal(canonicalString(retry.yield), canonicalString(first.yield));
  assert.equal((await new FileArtifactStore(root).load()).state.journal.length, 1);
});
