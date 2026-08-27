import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BridgeError, canonicalizeDeclaration, deleteBridge, transition, disable } from '../dist/bridge.js';
import { FileArtifactStore } from '../dist/store.js';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';

const ref = (id, value, scope = 's6') => ({ id, scope, digest: digest(value), bytes: canonicalString(value) });
const input = (runId, eventId, event, snapshot, launchToken) => ({
  runId,
  ...(snapshot ? { expectedRevision: snapshot.revision } : {}),
  identity: {
    runId, phaseId: 'run', stepId: 'run',
    attemptEpoch: snapshot?.attemptEpoch ?? 0,
    authorityEpoch: snapshot?.authorityEpoch ?? 0,
    barrierEpoch: snapshot?.barrierEpoch ?? 0,
    eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}),
  },
  event,
});
const start = (runId, plan, eventId = 'start') => input(runId, eventId, { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } });
const tokenFor = (runId, phaseId, stepId, attemptEpoch) => `launch-${digest({ runId, phaseId, stepId, attemptEpoch }).slice(0, 32)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bridgePlan = { phaseId: 'bridge-phase', steps: [{ stepId: 'alpha' }] };
const bridgeStart = (value = bridgePlan) => ({ kind: 'START', intentRef: { id: 'plan', digest: digest(value) } });
const bridgeOptions = (runDir, value = bridgePlan) => ({ runDir, runId: 'bridge-s6', mode: 'runtime', plan: value });

test('async dispatch claims before launch, times out to UNKNOWN, and fences a late receipt', async () => {
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  let resolveDispatch;
  const yields = [];
  const driver = { dispatch(command, launchToken, signal) {
    assert.equal(command.state, 'CLAIMED');
    assert.equal(signal.aborted, false);
    return new Promise((resolve) => { resolveDispatch = () => resolve({ launchToken, commandDigest: command.commandDigest, ref: ref('late', { accepted: true }) }); });
  } };
  const kernel = composeKernel({ plan, driver, timeoutMs: 20, onYield: (value) => yields.push(value) });
  let y = await kernel.advance(start('async-timeout', plan));
  const began = Date.now();
  y = await kernel.advance(input('async-timeout', 'resume', { kind: 'RESUME' }, y.snapshot));
  assert.ok(Date.now() - began < 100, 'RESUME must not await the external Promise');
  assert.equal(y.kind, 'WAITING');
  assert.equal(y.snapshot.pendingDispatchCount, 1);
  await sleep(45);
  assert.equal(yields.at(-1)?.code, 'UnknownDispatch');
  assert.equal(yields.at(-1)?.snapshot.unknownDispatchCount, 1);
  resolveDispatch();
  await sleep(25);
  assert.equal(yields.at(-1)?.kind, 'WAITING');
  assert.equal(yields.at(-1)?.snapshot.unknownDispatchCount, 0);
  assert.equal(yields.at(-1)?.snapshot.pendingDispatchCount, 0);
});

test('a timed-out dispatch can be observed while its non-cooperative Promise remains live', async () => {
  const { getEventListeners } = await import('node:events');
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
  };
  const fakeClock = () => {
    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let now = 1700000000000;
    let nextHandle = 1;
    const timers = new Map();
    Date.now = () => now;
    globalThis.setTimeout = (fn, ms, ...args) => {
      const handle = { timerId: nextHandle++ };
      timers.set(handle, { fn, args, due: now + Number(ms) });
      return handle;
    };
    globalThis.clearTimeout = (handle) => { timers.delete(handle); };
    return {
      get now() { return now; },
      get timers() { return timers; },
      advanceTo(value) { assert.equal(value >= now, true); now = value; },
      restore() {
        Date.now = originalDateNow;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      },
    };
  };
  const resources = (kernel, signal, timers) => {
    const values = Object.getOwnPropertyNames(kernel).map((key) => kernel[key]);
    const active = values.find((value) => value instanceof Map);
    return {
      active_tasks: active?.size ?? null,
      active_token_tasks: active,
      external_abort_listeners: getEventListeners(signal, 'abort').length,
      fake_timers: timers.size,
    };
  };
  const inputFor = (runId, eventId, event, snapshot) => ({
    runId,
    ...(snapshot ? { expectedRevision: snapshot.revision } : {}),
    identity: {
      runId, phaseId: 'run', stepId: 'run',
      attemptEpoch: snapshot?.attemptEpoch ?? 0,
      authorityEpoch: snapshot?.authorityEpoch ?? 0,
      barrierEpoch: snapshot?.barrierEpoch ?? 0,
      eventId, payloadDigest: digest(event),
    },
    event,
  });
  const commandFrom = (state) => Object.values(state?.outbox ?? {})[0];
  const clock = fakeClock();
  const controller = new AbortController();
  const pending = deferred();
  pending.promise.catch(() => undefined);
  const firstUnknown = deferred();
  const firstWaiting = deferred();
  const secondWaiting = deferred();
  let kernel;
  let claimed;
  let dispatchSignal;
  let observeSignal;
  let dispatchCalls = 0;
  let observeCalls = 0;
  let dispatchTask;
  let recoveryPromise;
  let unknownCallbacks = 0;
  let waitingCallbacks = 0;
  let unknownTransitionCommits = 0;
  let ackedTransitionCommits = 0;
  let lastCommandState;
  let lastCommittedState;
  const callbacks = [];
  const originalCommit = (await import('../dist/store.js')).MemoryArtifactStore.prototype.commit;
  try {
    const { MemoryArtifactStore } = await import('../dist/store.js');
    MemoryArtifactStore.prototype.commit = async function wrappedCommit(previous, state) {
      const stateName = commandFrom(state)?.state;
      if (stateName === 'UNKNOWN' && lastCommandState !== 'UNKNOWN') unknownTransitionCommits += 1;
      if (stateName === 'ACKED' && lastCommandState !== 'ACKED') ackedTransitionCommits += 1;
      lastCommandState = stateName;
      lastCommittedState = state;
      return originalCommit.call(this, previous, state);
    };
    const driver = {
      dispatch(command, token, signal) {
        dispatchCalls += 1;
        claimed = { command, token };
        dispatchSignal = signal;
        assert.equal(signal.aborted, false);
        return pending.promise;
      },
      observe(token, signal) {
        observeCalls += 1;
        observeSignal = signal;
        assert.equal(controller.signal.aborted, false);
        assert.equal(signal.aborted, false);
        const activeMap = resources(kernel, controller.signal, clock.timers).active_token_tasks;
        assert.equal(activeMap?.has(token), true);
        const observerTask = activeMap.get(token);
        assert.notEqual(observerTask, dispatchTask);
        return { launchToken: token, commandDigest: claimed.command.commandDigest, ref: ref('observed', { accepted: true }) };
      },
    };
    kernel = composeKernel({
      plan,
      signal: controller.signal,
      driver,
      onYield(value) {
        callbacks.push(value.kind);
        if (value.code === 'UnknownDispatch') {
          unknownCallbacks += 1;
          assert.equal(unknownCallbacks, 1);
          assert.equal(controller.signal.aborted, false);
          const activeMap = resources(kernel, controller.signal, clock.timers).active_token_tasks;
          assert.equal(activeMap?.has(claimed.token), false);
          assert.equal(dispatchSignal.aborted, true);
          recoveryPromise = kernel.advance(inputFor('s151-deadline', 'recovery', { kind: 'RESUME' }, value.snapshot));
          firstUnknown.resolve(value);
        } else if (value.kind === 'WAITING') {
          waitingCallbacks += 1;
          if (waitingCallbacks === 1) firstWaiting.resolve(value);
          if (waitingCallbacks === 2) secondWaiting.resolve(value);
        }
      },
    });
    const started = await kernel.advance(inputFor('s151-deadline', 'start', { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }));
    const resume1 = await kernel.advance(inputFor('s151-deadline', 'resume-1', { kind: 'RESUME' }, started.snapshot));
    const activeMap = resources(kernel, controller.signal, clock.timers).active_token_tasks;
    dispatchTask = activeMap?.get(claimed?.token);
    const expectedDue = clock.now + 30000;
    const initial = {
      pending: resume1.snapshot.pendingDispatchCount,
      dispatch_entry: activeMap?.has(claimed?.token) ? 1 : 0,
      dispatch_calls: dispatchCalls,
      timer_count: clock.timers.size,
      timer_due: [...clock.timers.values()][0]?.due,
      expected_due: expectedDue,
      external_abort_listeners: getEventListeners(controller.signal, 'abort').length,
      external_aborted: controller.signal.aborted,
      dispatch_signal_aborted: dispatchSignal?.aborted,
    };
    assert.equal(initial.pending, 1);
    assert.equal(initial.dispatch_entry, 1);
    assert.equal(initial.dispatch_calls, 1);
    assert.equal(initial.timer_count, 1);
    assert.equal(initial.timer_due, initial.expected_due);
    assert.equal(initial.external_abort_listeners, 1);
    assert.equal(initial.external_aborted, false);
    assert.equal(initial.dispatch_signal_aborted, false);

    const dueHandle = [...clock.timers.entries()].find(([, entry]) => entry.due === expectedDue)?.[0];
    assert.ok(dueHandle);
    clock.advanceTo(expectedDue);
    const due = clock.timers.get(dueHandle);
    clock.timers.delete(dueHandle);
    due.fn(...due.args);
    await firstUnknown.promise;
    assert.equal(unknownCallbacks, 1);
    const recovery = await recoveryPromise;
    await firstWaiting.promise;
    assert.equal(observeCalls, 1);
    assert.equal(dispatchCalls, 1);
    assert.equal(controller.signal.aborted, false);
    assert.equal(dispatchSignal.aborted, true);
    assert.equal(observeSignal?.aborted, false);
    assert.equal(recovery.kind, 'WAITING');
    assert.equal(recovery.snapshot.pendingDispatchCount, 0);
    assert.equal(recovery.snapshot.unknownDispatchCount, 0);
    assert.equal(ackedTransitionCommits, 1);
    const lateReceipt = { launchToken: claimed.token, commandDigest: claimed.command.commandDigest, ref: ref('late-observe', { accepted: true }) };
    pending.resolve(lateReceipt);
    await secondWaiting.promise;
    const final = resources(kernel, controller.signal, clock.timers);
    assert.equal(callbacks.filter((kind) => kind === 'BLOCKED').length, 1);
    assert.equal(unknownTransitionCommits, 1);
    assert.equal(callbacks.filter((kind) => kind === 'UNKNOWN').length, 0);
    assert.equal(commandFrom(lastCommittedState)?.state, 'ACKED');
    assert.equal(final.active_tasks, 0);
    assert.equal(final.external_abort_listeners, 0);
    assert.equal(final.fake_timers, 0);
  } finally {
    const { MemoryArtifactStore } = await import('../dist/store.js');
    MemoryArtifactStore.prototype.commit = originalCommit;
    pending.reject(new Error('cleanup'));
    clock.restore();
  }
});

test('a live in-process CLAIMED dispatch is not prematurely recovered by RESUME', async () => {
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  let resolveDispatch;
  let calls = 0;
  const driver = { dispatch(command, launchToken) {
    calls += 1;
    return new Promise((resolve) => { resolveDispatch = () => resolve({ launchToken, commandDigest: command.commandDigest, ref: ref('ok', { accepted: true }) }); });
  } };
  const kernel = composeKernel({ plan, driver, timeoutMs: 250 });
  let y = await kernel.advance(start('live-claim', plan));
  y = await kernel.advance(input('live-claim', 'resume-1', { kind: 'RESUME' }, y.snapshot));
  const again = await kernel.advance(input('live-claim', 'resume-2', { kind: 'RESUME' }, y.snapshot));
  assert.equal(calls, 1);
  assert.equal(again.kind, 'WAITING');
  assert.equal(again.snapshot.unknownDispatchCount, 0);
  assert.equal(again.snapshot.pendingDispatchCount, 1);
  resolveDispatch();
  await sleep(20);
});

test('FINDINGS opens a fresh repair attempt and barrier with new mutable steps', async () => {
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  const root = await mkdtemp(join(tmpdir(), 'lunacy-findings-late-envelope-'));
  const driver = { dispatch(command, launchToken) { return { launchToken, commandDigest: command.commandDigest, ref: ref('receipt', { accepted: true }) }; } };
  const kernel = composeKernel({ plan, driver, rootDir: root });
  let y = await kernel.advance(start('findings', plan));
  y = await kernel.advance(input('findings', 'resume', { kind: 'RESUME' }, y.snapshot));
  const launch = tokenFor('findings', 'p', 'a', 0);
  y = await kernel.advance(input('findings', 'done', { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) }, y.snapshot, launch));
  const gateToken = JSON.parse(y.artifacts[0].bytes).token;
  const before = y.snapshot;
  y = await kernel.advance(input('findings', 'findings', { kind: 'PARENT_DECISION', token: gateToken, value: 'FINDINGS' }, y.snapshot));
  assert.equal(y.kind, 'WAITING');
  assert.equal(y.snapshot.runStatus, 'ACTIVE');
  assert.equal(y.snapshot.gate, 'NOT-DUE');
  assert.equal(y.snapshot.barrier, 'OPEN');
  assert.equal(y.snapshot.attemptEpoch, before.attemptEpoch + 1);
  assert.equal(y.snapshot.barrierEpoch, before.barrierEpoch + 1);
  assert.equal(y.snapshot.activeCount, 1);
  assert.equal(y.snapshot.pendingDispatchCount, 1);
  const late = await kernel.advance(input('findings', 'late-old-envelope', { kind: 'WORKER_ENVELOPE', ref: ref('late-old-worker', { status: 'DONE' }) }, y.snapshot, launch));
  assert.equal(late.kind, 'DECISION_REQUIRED');
  assert.equal(late.snapshot.activeCount, 1);
  assert.equal(late.snapshot.pendingDispatchCount, 1);
  const recovered = (await new FileArtifactStore(root).load()).state;
  assert.equal(recovered.steps.a.status, 'ACTIVE');
  assert.equal(recovered.outbox[Object.keys(recovered.outbox).find((id) => recovered.outbox[id].launchToken === launch)].noEffectEvidence.length, 1);
});

test('authority adoption is digest-bound, recovery-only while old work is live, and rebuilds dependencies', async () => {
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  let calls = 0;
  const driver = { dispatch(command, launchToken) { calls += 1; return { launchToken, commandDigest: command.commandDigest, ref: ref('receipt', { accepted: true }) }; } };
  const kernel = composeKernel({ plan, driver, maxInFlight: 1 });
  let y = await kernel.advance(start('adopt', plan));
  plan.steps.push({ stepId: 'b', dependencies: ['a'] });
  y = await kernel.advance(input('adopt', 'drift', { kind: 'RESUME' }, y.snapshot));
  assert.equal(y.kind, 'DECISION_REQUIRED');
  const adoptionToken = y.token;
  const refused = await kernel.advance(input('adopt', 'adopt-live', { kind: 'PARENT_DECISION', token: adoptionToken, value: { kind: 'ADOPT', digest: digest(plan) } }, y.snapshot));
  assert.equal(refused.kind, 'DECISION_REQUIRED');
  assert.equal(refused.snapshot.attemptEpoch, 0);
  y = await kernel.advance(input('adopt', 'recover-old', { kind: 'RESUME' }, refused.snapshot));
  assert.equal(calls, 1);
  const oldLaunch = tokenFor('adopt', 'p', 'a', 0);
  y = await kernel.advance(input('adopt', 'done-old', { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) }, y.snapshot, oldLaunch));
  y = await kernel.advance(input('adopt', 'adopt', { kind: 'PARENT_DECISION', token: adoptionToken, value: { kind: 'ADOPT', digest: digest(plan) } }, y.snapshot));
  assert.equal(y.kind, 'WAITING');
  assert.equal(y.snapshot.authorityEpoch, 1);
  assert.equal(y.snapshot.attemptEpoch, 1);
  assert.equal(y.snapshot.barrierEpoch, 2);
  assert.equal(y.snapshot.activeCount, 0);
  assert.equal(y.snapshot.pendingDispatchCount, 0);
  assert.equal(y.snapshot.readyCount, 2);
  const nextLaunch = tokenFor('adopt', 'p', 'a', 1);
  assert.notEqual(nextLaunch, oldLaunch);
});

test('bridge rejects injected projection markers before CURRENT/manifest mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-projection-'));
  await writeFile(join(root, 'STATE.md'), '# Parent state\n<!-- lunacy-runtime:state:start -->\nattacker payload\n<!-- lunacy-runtime:state:end -->\n');
  await assert.rejects(() => transition(bridgeOptions(root), { event: bridgeStart(), eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'ProjectionFailed');
  await assert.rejects(() => readFile(join(root, '.kernel', 'BRIDGE.json'), 'utf8'));
  await assert.rejects(() => readFile(join(root, '.kernel', 'CURRENT'), 'utf8'));
});

test('bridge source-digest tampering and ancestor symlink paths fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-manifest-'));
  await transition(bridgeOptions(root), { event: bridgeStart(), eventId: 'start' });
  const manifestPath = join(root, '.kernel', 'BRIDGE.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.sourceDigest = digest('attacker-bridge');
  await writeFile(manifestPath, canonicalString(manifest));
  await assert.rejects(() => transition(bridgeOptions(root), { event: { kind: 'RESUME' }, eventId: 'resume' }), (error) => error instanceof BridgeError && error.code === 'ManifestMismatch');
  manifest.sourceDigest = digest('lunacy-runtime-skill-bridge/v1');
  manifest.planDigest = digest('attacker-plan');
  await writeFile(manifestPath, canonicalString(manifest));
  await assert.rejects(() => transition(bridgeOptions(root), { event: { kind: 'RESUME' }, eventId: 'resume-plan' }), (error) => error instanceof BridgeError && error.code === 'ManifestMismatch');
  const outer = await mkdtemp(join(tmpdir(), 'lunacy-s6-outside-'));
  const parent = await mkdtemp(join(tmpdir(), 'lunacy-s6-parent-'));
  await symlink(outer, join(parent, 'alias'));
  await assert.rejects(() => transition(bridgeOptions(join(parent, 'alias', 'run')), { event: bridgeStart(), eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
});

test('existing run root beneath a symlink ancestor is rejected without outside writes', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'lunacy-s6-existing-outside-'));
  await mkdir(join(outside, 'run'));
  const parent = await mkdtemp(join(tmpdir(), 'lunacy-s6-existing-parent-'));
  await symlink(outside, join(parent, 'alias'));
  await assert.rejects(() => transition(bridgeOptions(join(parent, 'alias', 'run')), { event: bridgeStart(), eventId: 'existing' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
  await assert.rejects(() => readFile(join(outside, 'run', '.kernel', 'CURRENT')));
});

test('markdown mode refuses a symlinked kernel namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-markdown-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'lunacy-s6-markdown-outside-'));
  await symlink(outside, join(root, '.kernel'));
  await assert.rejects(() => transition({ runDir: root, runId: 'bridge-s6', mode: 'markdown' }, { event: { kind: 'RESUME' }, eventId: 'markdown' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
});

test('bridge rejects a STEPS projection outside the committed phase', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-phase-path-'));
  await assert.rejects(() => transition({ ...bridgeOptions(root), stepsPath: join(root, 'phases', 'attacker', 'STEPS.md') }, { event: bridgeStart(), eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
  await assert.rejects(() => readFile(join(root, '.kernel', 'CURRENT')));
});

test('bridge measurement counters reject caller-injected negative values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-counters-'));
  await assert.rejects(() => transition({ ...bridgeOptions(root), counters: { declarationReads: -1, declarationBytes: 0, runtimeReads: 0, runtimeBytes: 0, projectionReads: 0, projectionBytesRead: 0, projectionWrites: 0, projectionBytesWritten: 0, routineWakeups: 0, transitions: 0 } }, { event: bridgeStart(), eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'Unavailable');
});

test('invalid START identity cannot leave a precommit bridge manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-start-boundary-'));
  await assert.rejects(() => transition(bridgeOptions(root), { event: bridgeStart(), eventId: 'start', expectedRevision: -1 }), (error) => error instanceof BridgeError && error.code === 'Unavailable');
  await assert.rejects(() => readFile(join(root, '.kernel', 'BRIDGE.json')));
  await assert.rejects(() => readFile(join(root, '.kernel', 'CURRENT')));
});

test('bridge disable remains blocked for durable UNKNOWN outbox work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-unknown-'));
  await transition(bridgeOptions(root), { event: bridgeStart(), eventId: 'start' });
  const store = new FileArtifactStore(root);
  const loaded = await store.load();
  const next = JSON.parse(JSON.stringify(loaded.state));
  const command = Object.values(next.outbox)[0];
  command.state = 'UNKNOWN';
  await store.commit(loaded.generation, next);
  await assert.rejects(() => disable(bridgeOptions(root)), (error) => error instanceof BridgeError && error.code === 'ActiveWork');
});

test('concurrent bridge START cannot leave manifest and CURRENT from different declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-start-race-'));
  const firstPlan = { phaseId: 'bridge-phase', steps: [{ stepId: 'first' }] };
  const secondPlan = { phaseId: 'bridge-phase', steps: [{ stepId: 'second' }] };
  const startFor = (value) => transition(bridgeOptions(root, value), { event: bridgeStart(value), eventId: 'start' });
  const results = await Promise.allSettled([startFor(firstPlan), startFor(secondPlan)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const manifest = JSON.parse(await readFile(join(root, '.kernel', 'BRIDGE.json'), 'utf8'));
  const state = (await new FileArtifactStore(root).load()).state;
  assert.equal(manifest.planDigest, state.planDigest);
  assert.ok([digest(canonicalizeDeclaration(firstPlan)), digest(canonicalizeDeclaration(secondPlan))].includes(manifest.planDigest));
});

function childStart(root, plan) {
  const bridgeUrl = pathToFileURL(join(process.cwd(), 'dist', 'bridge.js')).href;
  const script = `import { transition } from ${JSON.stringify(bridgeUrl)}; const root = process.argv[1]; const plan = JSON.parse(process.argv[2]); transition({ runDir: root, runId: 'cross-process', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: (await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'dist', 'canonical.js')).href)})).digest(plan) } }, eventId: 'start' }).then(() => process.exit(0)).catch((error) => { process.stderr.write(String(error.code ?? error.message)); process.exit(1); });`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, JSON.stringify(plan)], { cwd: process.cwd() });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('cross-process bridge lock serializes competing START declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-cross-process-'));
  const firstPlan = { phaseId: 'bridge-phase', steps: [{ stepId: 'first' }] };
  const secondPlan = { phaseId: 'bridge-phase', steps: [{ stepId: 'second' }] };
  const results = await Promise.all([childStart(root, firstPlan), childStart(root, secondPlan)]);
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.equal(results.filter((result) => result.code !== 0).length, 1);
  const manifest = JSON.parse(await readFile(join(root, '.kernel', 'BRIDGE.json'), 'utf8'));
  const state = (await new FileArtifactStore(root).load()).state;
  assert.equal(manifest.planDigest, state.planDigest);
});

function manualReceipt(yieldValue) {
  const request = JSON.parse(yieldValue.receipt.bytes);
  return ref('manual-receipt', { launchToken: request.launchToken, commandDigest: request.commandDigest });
}

async function reachPhaseGate(root) {
  let result = await transition(bridgeOptions(root), { event: bridgeStart(), eventId: 'start' });
  result = await transition(bridgeOptions(root), { event: { kind: 'RESUME' }, eventId: 'resume', expectedRevision: result.yield.snapshot.revision });
  assert.equal(result.yield.kind, 'BLOCKED');
  const launchToken = result.yield.launchToken;
  result = await transition(bridgeOptions(root), {
    event: { kind: 'DISPATCH_RECEIPT', ref: manualReceipt(result.yield) }, eventId: 'receipt', launchToken,
    expectedRevision: result.yield.snapshot.revision,
  });
  result = await transition(bridgeOptions(root), {
    event: { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) }, eventId: 'worker', launchToken,
    expectedRevision: result.yield.snapshot.revision,
  });
  assert.equal(result.yield.kind, 'FINAL');
  return result;
}

test('lifecycle lock serializes disable against a gate decision without stranded work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-lifecycle-race-'));
  const gate = await reachPhaseGate(root);
  const gateToken = JSON.parse(gate.yield.artifacts[0].bytes).token;
  const findings = transition(bridgeOptions(root), {
    event: { kind: 'PARENT_DECISION', token: gateToken, value: 'FINDINGS' }, eventId: 'findings',
    expectedRevision: gate.yield.snapshot.revision,
  });
  const disabling = disable(bridgeOptions(root));
  const outcomes = await Promise.allSettled([findings, disabling]);
  const manifest = JSON.parse(await readFile(join(root, '.kernel', 'BRIDGE.json'), 'utf8'));
  const state = (await new FileArtifactStore(root).load()).state;
  assert.ok(state);
  const active = Object.values(state.steps).some((step) => step.status === 'ACTIVE');
  const unresolved = Object.values(state.outbox).some((command) => ['PENDING', 'CLAIMED', 'UNKNOWN'].includes(command.state));
  assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled'));
  // A disabled manifest can only win while the phase remains quiescent; if
  // the decision wins first, disable must lose with ActiveWork instead.
  if (manifest.status === 'disabled') {
    assert.equal(active, false); assert.equal(unresolved, false);
  } else {
    assert.equal(manifest.status, 'enabled');
    assert.equal(outcomes[1].status, 'rejected');
    assert.equal((outcomes[1].reason instanceof BridgeError) && outcomes[1].reason.code, 'ActiveWork');
  }
});

test('manifest disable and tombstone survive a fresh lifecycle read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s6-crash-order-'));
  const gate = await reachPhaseGate(root);
  const enabled = JSON.parse(await readFile(join(root, '.kernel', 'BRIDGE.json'), 'utf8'));
  assert.equal(enabled.status, 'enabled');
  await disable(bridgeOptions(root));
  const disabled = JSON.parse(await readFile(join(root, '.kernel', 'BRIDGE.json'), 'utf8'));
  assert.equal(disabled.status, 'disabled');
  await assert.rejects(() => transition(bridgeOptions(root), { event: { kind: 'RESUME' }, eventId: 'disabled' }), (error) => error instanceof BridgeError && error.code === 'Disabled');
  const deleted = await deleteBridge(bridgeOptions(root));
  assert.equal(deleted.deleted, true);
  await assert.rejects(() => readFile(join(root, '.kernel', 'BRIDGE.json')));
  const tombstone = JSON.parse(await readFile(join(root, '.kernel', 'BRIDGE.DELETED'), 'utf8'));
  assert.equal(tombstone.status, 'deleted');
  await assert.rejects(() => transition(bridgeOptions(root), { event: { kind: 'RESUME' }, eventId: 'deleted' }), (error) => error instanceof BridgeError && error.code === 'ManifestMismatch');
});
