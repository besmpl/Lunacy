import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeKernel } from '../dist/composition.js';
import { makeRunKernel } from '../dist/index.js';
import { makeRunKernelForBridge } from '../dist/public.js';
import { canonicalString, digest } from '../dist/canonical.js';

const capacityPlan = {
  phaseId: 'p3-capacity-ownership',
  steps: [
    { stepId: 'a', claims: [{ resource: 'capacity/a', mode: 'WRITE' }] },
    { stepId: 'b', claims: [{ resource: 'capacity/b', mode: 'WRITE' }] },
  ],
};

function ref(id, value, scope = 'test') {
  return { id, scope, digest: digest(value), bytes: canonicalString(value) };
}

function input(runId, eventId, event, cursor, extra = {}) {
  return {
    runId,
    ...(cursor?.revision === undefined ? {} : { expectedRevision: cursor.revision }),
    identity: {
      runId,
      phaseId: extra.phaseId ?? 'run',
      stepId: extra.stepId ?? 'run',
      attemptEpoch: cursor?.attemptEpoch ?? 0,
      authorityEpoch: cursor?.authorityEpoch ?? 0,
      barrierEpoch: cursor?.barrierEpoch ?? 0,
      eventId,
      payloadDigest: digest(event),
      ...(extra.launchToken === undefined ? {} : { launchToken: extra.launchToken }),
    },
    event,
  };
}

function startInput(runId, plan = capacityPlan) {
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
  return input(runId, 'start', event, { revision: undefined });
}

function counts(value) {
  const steps = Object.values(value.steps ?? {});
  const outbox = Object.values(value.outbox ?? {});
  return {
    ready: value.readyCount ?? steps.filter((step) => step.status === 'READY').length,
    active: value.activeCount ?? steps.filter((step) => step.status === 'ACTIVE').length,
    pending: value.pendingDispatchCount ?? outbox.filter((command) => command.state === 'PENDING' || command.state === 'CLAIMED').length,
    unknown: value.unknownDispatchCount ?? outbox.filter((command) => command.state === 'UNKNOWN').length,
    revision: value.revision,
    journalLength: value.journal?.length,
    gate: value.gate,
    barrier: value.barrier,
    status: value.status ?? value.runStatus,
  };
}

async function fileState(rootDir) {
  const current = JSON.parse(await readFile(join(rootDir, '.kernel', 'CURRENT'), 'utf8'));
  return JSON.parse(await readFile(join(rootDir, '.kernel', 'generations', `g${current.generation}`, 'state.json'), 'utf8'));
}

async function acknowledgeHumanReceipt(kernel, runId, eventPrefix, blocked) {
  assert.equal(blocked.kind, 'BLOCKED');
  assert.equal(blocked.code, 'HumanReceiptRequired');
  const request = JSON.parse(blocked.receipt.bytes);
  const receipt = await kernel.advance(input(runId, `${eventPrefix}-receipt`, {
    kind: 'DISPATCH_RECEIPT',
    ref: ref(`${eventPrefix}-receipt-proof`, { launchToken: request.launchToken, commandDigest: request.commandDigest }),
  }, blocked.snapshot, { launchToken: request.launchToken }));
  return kernel.advance(input(runId, `${eventPrefix}-worker`, {
    kind: 'WORKER_ENVELOPE',
    ref: ref(`${eventPrefix}-worker-result`, { status: 'DONE' }),
  }, receipt.snapshot, { launchToken: request.launchToken }));
}

test('construction-owned capacity rejects sync/async alias mutation for Memory and File stores', async () => {
  for (const store of ['memory', 'file']) {
    for (const variant of ['sync', 'async', 'frozen', 'unchanged']) {
      const rootDir = store === 'file' ? await mkdtemp(join(tmpdir(), `lunacy-p3-capacity-${store}-${variant}-`)) : undefined;
      const runId = `capacity-${store}-${variant}`;
      const options = { plan: capacityPlan, maxInFlight: 0, ...(rootDir ? { rootDir } : {}) };
      if (variant === 'sync') {
        options.admission = () => { options.maxInFlight = 2; return true; };
      } else if (variant === 'async') {
        options.admission = async () => { options.maxInFlight = 2; await Promise.resolve(); return true; };
      } else if (variant === 'frozen') {
        options.admission = () => { try { options.maxInFlight = 2; } catch { /* frozen control */ } return true; };
        Object.freeze(options);
      } else {
        options.admission = () => true;
      }
      const started = await makeRunKernel(options).advance(startInput(runId));
      assert.equal(started.kind, 'WAITING');
      assert.deepEqual(counts(started.snapshot), {
        ready: 2, active: 0, pending: 0, unknown: 0, revision: 1, journalLength: undefined,
        gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE',
      });
      if (rootDir) {
        const state = await fileState(rootDir);
        assert.deepEqual(counts(state), { ready: 2, active: 0, pending: 0, unknown: 0, revision: 1, journalLength: 1, gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE' });
        await rm(rootDir, { recursive: true, force: true });
      }
    }
  }
});

test('validation snapshots getter-backed capacity once for public, composition, and bridge construction', async () => {
  const factories = [
    ['public', (options) => makeRunKernel(options)],
    ['composition', (options) => composeKernel(options)],
    ['bridge', (options) => makeRunKernelForBridge(options, {})],
  ];
  for (const [label, factory] of factories) {
    let reads = 0;
    const values = [0, 2, 0, 2];
    const options = { plan: capacityPlan, admission: () => true };
    Object.defineProperty(options, 'maxInFlight', {
      enumerable: true,
      get() { return values[reads++]; },
    });
    const kernel = factory(options);
    assert.equal(reads, 1, `${label} construction must read maxInFlight once`);
    const started = await kernel.advance(startInput(`capacity-validation-${label}`));
    assert.equal(reads, 1, `${label} advance must not reread maxInFlight`);
    assert.deepEqual(counts(started.snapshot), {
      ready: 2, active: 0, pending: 0, unknown: 0, revision: 1, journalLength: undefined,
      gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE',
    });
  }
});

test('composition snapshots own non-enumerable and inherited capacity getters once', async () => {
  for (const variant of ['own-non-enumerable', 'inherited']) {
    let reads = 0;
    const values = [0, 2, 0, 2];
    const descriptor = {
      configurable: true,
      get() { return values[reads++]; },
    };
    let options;
    if (variant === 'own-non-enumerable') {
      options = { plan: capacityPlan, admission: () => true };
      Object.defineProperty(options, 'maxInFlight', { ...descriptor, enumerable: false });
    } else {
      const prototype = {};
      Object.defineProperty(prototype, 'maxInFlight', descriptor);
      options = Object.assign(Object.create(prototype), { plan: capacityPlan, admission: () => true });
    }
    const kernel = composeKernel(options);
    assert.equal(reads, 1, `${variant} construction must read maxInFlight once`);
    const started = await kernel.advance(startInput(`capacity-composition-${variant}`));
    assert.equal(reads, 1, `${variant} advance must not reread maxInFlight`);
    assert.deepEqual(counts(started.snapshot), {
      ready: 2, active: 0, pending: 0, unknown: 0, revision: 1, journalLength: undefined,
      gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE',
    });
  }
});

test('capacity-one admission is equivalent for package-root graph OFF, SHADOW, and ON', async () => {
  const traces = [];
  for (const mode of ['OFF', 'SHADOW', 'ON']) {
    const rootDir = await mkdtemp(join(tmpdir(), `lunacy-p3-capacity-graph-${mode.toLowerCase()}-`));
    const kernel = makeRunKernel({ plan: capacityPlan, rootDir, maxInFlight: 1, admission: () => true, acceleration: { graph: mode } });
    const started = await kernel.advance(startInput('capacity-graph'));
    const state = await fileState(rootDir);
    assert.deepEqual(counts(started.snapshot), { ready: 1, active: 1, pending: 1, unknown: 0, revision: 1, journalLength: undefined, gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE' });
    traces.push({ mode, started, state });
    await rm(rootDir, { recursive: true, force: true });
  }
  const project = ({ started, state }) => ({ started, state: { steps: state.steps, outbox: state.outbox, planDigest: state.planDigest, revision: state.revision, journal: state.journal } });
  assert.deepEqual(project(traces[1]), project(traces[0]));
  assert.deepEqual(project(traces[2]), project(traces[0]));
});

test('FINDINGS refresh uses the construction snapshot after callback raises the aliased option', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-capacity-findings-'));
  let calls = 0;
  let mutate = false;
  const options = {
    plan: { ...capacityPlan, phaseId: 'p3-capacity-findings' },
    rootDir,
    maxInFlight: 1,
    admission: () => {
      calls += 1;
      if (mutate) options.maxInFlight = 2;
      return true;
    },
  };
  const kernel = makeRunKernel(options);
  const runId = 'capacity-findings';
  let y = await kernel.advance(startInput(runId, options.plan));
  y = await acknowledgeHumanReceipt(kernel, runId, 'a', await kernel.advance(input(runId, 'resume-a', { kind: 'RESUME' }, y.snapshot)));
  y = await acknowledgeHumanReceipt(kernel, runId, 'b', await kernel.advance(input(runId, 'resume-b', { kind: 'RESUME' }, y.snapshot)));
  assert.equal(y.kind, 'FINAL');
  assert.equal(y.status, 'phase-ready');
  const gateToken = JSON.parse(y.artifacts[0].bytes).token;
  mutate = true;
  const beforeCalls = calls;
  const findings = await kernel.advance(input(runId, 'findings', { kind: 'PARENT_DECISION', token: gateToken, value: 'FINDINGS' }, y.snapshot));
  assert.equal(findings.kind, 'WAITING');
  assert.equal(calls, beforeCalls + 1);
  assert.equal(options.maxInFlight, 2);
  assert.deepEqual(counts(findings.snapshot), { ready: 1, active: 1, pending: 1, unknown: 0, revision: 8, journalLength: undefined, gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE' });
  const state = await fileState(rootDir);
  assert.deepEqual(counts(state), { ready: 1, active: 1, pending: 1, unknown: 0, revision: 8, journalLength: 8, gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE' });
  await rm(rootDir, { recursive: true, force: true });
});

test('malformed live plan recovery retains explicit capacity zero', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-capacity-recovery-'));
  const plan = { ...capacityPlan, phaseId: 'p3-capacity-recovery' };
  const started = await makeRunKernel({ plan, rootDir, maxInFlight: 1, admission: () => true }).advance(startInput('capacity-recovery', plan));
  const malformed = { phaseId: plan.phaseId, steps: 'not-an-array' };
  const resumed = await makeRunKernel({ plan: malformed, rootDir, maxInFlight: 2, admission: () => true }).advance(input('capacity-recovery', 'resume', { kind: 'RESUME' }, started.snapshot));
  assert.equal(resumed.kind, 'BLOCKED');
  assert.equal(resumed.code, 'HumanReceiptRequired');
  assert.deepEqual(counts(resumed.snapshot), { ready: 1, active: 1, pending: 1, unknown: 0, revision: 2, journalLength: undefined, gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE' });
  const state = await fileState(rootDir);
  assert.deepEqual(counts(state), { ready: 1, active: 1, pending: 1, unknown: 0, revision: 2, journalLength: 2, gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE' });
  await rm(rootDir, { recursive: true, force: true });
});

test('malformed live plan FINDINGS recovery admits no successors', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-capacity-recovery-findings-'));
  const plan = { ...capacityPlan, phaseId: 'p3-capacity-recovery-findings' };
  const runId = 'capacity-recovery-findings';
  const kernel = makeRunKernel({ plan, rootDir, maxInFlight: 1, admission: () => true });
  let y = await kernel.advance(startInput(runId, plan));
  y = await acknowledgeHumanReceipt(kernel, runId, 'a', await kernel.advance(input(runId, 'resume-a', { kind: 'RESUME' }, y.snapshot)));
  y = await acknowledgeHumanReceipt(kernel, runId, 'b', await kernel.advance(input(runId, 'resume-b', { kind: 'RESUME' }, y.snapshot)));
  assert.equal(y.kind, 'FINAL');
  assert.equal(y.status, 'phase-ready');
  const gateToken = JSON.parse(y.artifacts[0].bytes).token;

  const malformed = { phaseId: plan.phaseId, steps: 'not-an-array' };
  const recovered = makeRunKernel({ plan: malformed, rootDir, maxInFlight: 2, admission: () => true });
  const findings = await recovered.advance(input(runId, 'findings', {
    kind: 'PARENT_DECISION', token: gateToken, value: 'FINDINGS',
  }, y.snapshot));
  assert.equal(findings.kind, 'WAITING');
  assert.deepEqual(counts(findings.snapshot), {
    ready: 2, active: 0, pending: 0, unknown: 0, revision: 8, journalLength: undefined,
    gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE',
  });
  const state = await fileState(rootDir);
  assert.deepEqual(counts(state), {
    ready: 2, active: 0, pending: 0, unknown: 0, revision: 8, journalLength: 8,
    gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE',
  });
  await rm(rootDir, { recursive: true, force: true });
});

test('duplicate START replays exactly, while a new capacity-two kernel admits its second step', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-capacity-restart-'));
  const plan = { ...capacityPlan, phaseId: 'p3-capacity-restart' };
  let firstCalls = 0;
  const first = makeRunKernel({ plan, rootDir, maxInFlight: 1, admission: () => { firstCalls += 1; return true; } });
  const started = await first.advance(startInput('capacity-restart', plan));
  let restartedCalls = 0;
  const restarted = makeRunKernel({ plan, rootDir, maxInFlight: 2, admission: () => { restartedCalls += 1; return true; } });
  const duplicate = await restarted.advance(startInput('capacity-restart', plan));
  assert.deepEqual(duplicate, started);
  assert.equal(firstCalls, 1);
  assert.equal(restartedCalls, 0);
  const blocked = await restarted.advance(input('capacity-restart', 'resume', { kind: 'RESUME' }, started.snapshot));
  const request = JSON.parse(blocked.receipt.bytes);
  const receipt = await restarted.advance(input('capacity-restart', 'receipt', { kind: 'DISPATCH_RECEIPT', ref: ref('receipt-proof', { launchToken: request.launchToken, commandDigest: request.commandDigest }) }, blocked.snapshot, { launchToken: request.launchToken }));
  assert.deepEqual(counts(receipt.snapshot), { ready: 0, active: 2, pending: 1, unknown: 0, revision: 3, journalLength: undefined, gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE' });
  const state = await fileState(rootDir);
  assert.deepEqual(counts(state), { ready: 0, active: 2, pending: 1, unknown: 0, revision: 3, journalLength: 3, gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE' });
  await rm(rootDir, { recursive: true, force: true });
});

test('composition self-aliased dispatcher does not reread enumerable capacity', async () => {
  let reads = 0;
  const options = { plan: capacityPlan, admission: () => true };
  Object.defineProperty(options, 'maxInFlight', {
    enumerable: true,
    get() {
      reads += 1;
      if (reads > 1) throw new Error('maxInFlight was reread');
      return 0;
    },
  });
  options.dispatcher = options;
  const kernel = composeKernel(options);
  assert.equal(reads, 1);
  const started = await kernel.advance(startInput('capacity-composition-self-alias'));
  assert.equal(reads, 1);
  assert.deepEqual(counts(started.snapshot), {
    ready: 2, active: 0, pending: 0, unknown: 0, revision: 1, journalLength: undefined,
    gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE',
  });
});

test('composition outer projection avoids the supported Node 22 capacity reread', { skip: !existsSync('/opt/homebrew/Cellar/node@22/22.23.1/bin/node') }, () => {
  const node22 = '/opt/homebrew/Cellar/node@22/22.23.1/bin/node';
  const compositionUrl = new URL('../dist/composition.js', import.meta.url).href;
  const script = `
    import { composeKernel } from ${JSON.stringify(compositionUrl)};
    let reads = 0;
    const options = {
      plan: { phaseId: 'p', steps: [{ stepId: 'a', claims: [{ resource: 'r', mode: 'WRITE' }] }] },
      admission: () => true,
    };
    Object.defineProperty(options, 'maxInFlight', {
      configurable: true,
      enumerable: true,
      get() {
        if (++reads === 1) return 0;
        throw new Error('capacity reread');
      },
    });
    composeKernel(options);
    if (reads !== 1) throw new Error(\`expected one capacity read, got \${reads}\`);
    console.log(\`reads=\${reads}\`);
  `;
  const child = spawnSync(node22, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.stdout.trim(), 'reads=1');
});

test('composition outer projection preserves remaining key order and descriptor transitions', () => {
  const symbol = Symbol('remaining');
  const options = { plan: capacityPlan, admission: () => true };
  const reads = [];
  let skippedReads = 0;
  Object.defineProperty(options, 'first', {
    configurable: true,
    enumerable: true,
    get() {
      reads.push('first');
      Object.defineProperty(options, 'skipped', { configurable: true, enumerable: false, value: 'hidden' });
      Object.defineProperty(options, 'replaced', {
        configurable: true,
        enumerable: true,
        get() {
          reads.push('replaced');
          return 'replacement';
        },
      });
      return 'first-value';
    },
  });
  Object.defineProperty(options, 'skipped', {
    configurable: true,
    enumerable: true,
    get() {
      skippedReads += 1;
      throw new Error('descriptor transition was not rechecked');
    },
  });
  Object.defineProperty(options, 'replaced', { configurable: true, enumerable: true, value: 'initial' });
  Object.defineProperty(options, symbol, {
    configurable: true,
    enumerable: true,
    get() {
      reads.push('symbol');
      return 'symbol-value';
    },
  });

  const kernel = composeKernel(options);
  const projected = kernel.options;
  assert.equal(Object.getPrototypeOf(projected), null);
  assert.deepEqual(Reflect.ownKeys(projected), ['plan', 'admission', 'first', 'replaced', 'maxInFlight', symbol]);
  assert.deepEqual(reads, ['first', 'replaced', 'symbol']);
  assert.equal(skippedReads, 0);
  assert.equal(projected.plan, capacityPlan, 'plan remains live rather than cloned');
  assert.equal(projected.first, 'first-value');
  assert.equal(projected.replaced, 'replacement');
  assert.equal(projected[symbol], 'symbol-value');
  assert.equal(Object.hasOwn(projected, 'skipped'), false);
  for (const key of ['first', 'replaced', symbol]) {
    const descriptor = Object.getOwnPropertyDescriptor(projected, key);
    assert.deepEqual(descriptor && {
      writable: descriptor.writable,
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
    }, { writable: true, enumerable: true, configurable: true });
  }
});

test('composition outer projection reads excluded controls once and includes post-binding keys', () => {
  const options = { plan: capacityPlan, admission: () => true };
  const reads = Object.fromEntries(['driver', 'dispatcher', 'timeoutMs', 'dispatchTimeoutMs', 'signal', 'abortSignal', 'onYield', 'maxInFlight'].map((key) => [key, 0]));
  for (const key of Object.keys(reads)) {
    Object.defineProperty(options, key, {
      configurable: true,
      enumerable: true,
      get() {
        reads[key] += 1;
        if (key === 'timeoutMs') Object.defineProperty(options, 'addedAfterBinding', { configurable: true, enumerable: true, value: 'included' });
        return key === 'maxInFlight' ? 0 : undefined;
      },
    });
  }

  const kernel = composeKernel(options);
  assert.deepEqual(reads, Object.fromEntries(Object.keys(reads).map((key) => [key, 1])));
  assert.equal(kernel.options.addedAfterBinding, 'included');
  for (const key of Object.keys(reads).filter((key) => key !== 'maxInFlight')) assert.equal(Object.hasOwn(kernel.options, key), false);
  assert.equal(Object.hasOwn(kernel.options, 'maxInFlight'), true);
  assert.equal(kernel.options.maxInFlight, 0);
});

test('composition outer projection preserves direct, nested, and legacy dispatcher precedence', () => {
  const nestedController = new AbortController();
  const directController = new AbortController();
  const kernel = composeKernel({
    plan: capacityPlan,
    admission: () => true,
    maxInFlight: 0,
    dispatcher: { timeoutMs: 1, signal: nestedController.signal },
    timeoutMs: 2,
    dispatchTimeoutMs: 3,
    signal: directController.signal,
  });
  assert.equal(kernel.dispatchOptions.timeoutMs, 2);
  assert.equal(kernel.dispatchOptions.signal, directController.signal);
});

test('composition outer projection retains the live plan and driver receiver', async () => {
  const plan = { ...capacityPlan, phaseId: 'p3-capacity-composition-driver' };
  const driver = {
    calls: 0,
    dispatch(command, launchToken) {
      assert.equal(this, driver);
      this.calls += 1;
      return {
        launchToken,
        commandDigest: command.commandDigest,
        ref: ref('composition-driver-receipt', { ok: true }),
      };
    },
  };
  const kernel = composeKernel({ plan, maxInFlight: 1, admission: () => true, driver });
  assert.equal(kernel.options.plan, plan, 'outer projection must retain the caller plan reference');
  const runId = 'capacity-composition-driver';
  const started = await kernel.advance(startInput(runId, plan));
  assert.equal(started.kind, 'WAITING');
  await kernel.advance(input(runId, 'resume-driver', { kind: 'RESUME' }, started.snapshot));
  assert.equal(driver.calls, 1);
});

test('composition nested dispatcher projection ignores unrelated getters', async () => {
  let reads = 0;
  const dispatcher = { timeoutMs: 0 };
  Object.defineProperty(dispatcher, 'unrelated', {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error('unrelated dispatcher property was read');
    },
  });
  const kernel = composeKernel({ plan: capacityPlan, maxInFlight: 0, dispatcher, admission: () => true });
  assert.equal(reads, 0);
  const started = await kernel.advance(startInput('capacity-composition-nested-sentinel'));
  assert.equal(reads, 0);
  assert.deepEqual(counts(started.snapshot), {
    ready: 2, active: 0, pending: 0, unknown: 0, revision: 1, journalLength: undefined,
    gate: 'NOT-DUE', barrier: 'OPEN', status: 'ACTIVE',
  });
});

test('composition dispatcher projection uses a null-prototype target for inherited-setter parity', () => {
  const saved = Object.getOwnPropertyDescriptor(Object.prototype, 'timeoutMs');
  let setterCalls = 0;
  const dispatcher = {};
  Object.defineProperty(dispatcher, 'timeoutMs', {
    enumerable: true,
    configurable: true,
    get() {
      Object.defineProperty(Object.prototype, 'timeoutMs', {
        configurable: true,
        set() { setterCalls += 1; },
      });
      return 17;
    },
  });

  try {
    const native = { ...dispatcher };
    assert.equal(Object.hasOwn(native, 'timeoutMs'), true);
    assert.equal(native.timeoutMs, 17);
    assert.equal(setterCalls, 0);

    const kernel = composeKernel({ plan: capacityPlan, maxInFlight: 0, dispatcher, admission: () => true });
    assert.equal(setterCalls, 0, 'projected assignment must not invoke an inherited setter');
    assert.equal(Object.hasOwn(kernel.dispatchOptions, 'timeoutMs'), true);
    assert.equal(kernel.dispatchOptions.timeoutMs, 17);
  } finally {
    if (saved) Object.defineProperty(Object.prototype, 'timeoutMs', saved);
    else delete Object.prototype.timeoutMs;
  }
});

test('composition dispatcher projection preserves spread descriptor-change semantics', () => {
  let inheritedSignalReads = 0;
  const symbol = Symbol('unrelated');
  const prototype = {};
  Object.defineProperty(prototype, 'signal', {
    enumerable: true,
    get() {
      inheritedSignalReads += 1;
      throw new Error('inherited signal getter was read');
    },
  });

  const dispatcher = Object.create(prototype);
  let timeoutReads = 0;
  let signalReads = 0;
  let onYieldReads = 0;
  Object.defineProperty(dispatcher, 'timeoutMs', {
    enumerable: true,
    configurable: true,
    get() {
      timeoutReads += 1;
      delete dispatcher.signal;
      return 0;
    },
  });
  Object.defineProperty(dispatcher, 'signal', {
    enumerable: true,
    configurable: true,
    get() {
      signalReads += 1;
      return new AbortController().signal;
    },
  });
  Object.defineProperty(dispatcher, 'onYield', {
    enumerable: true,
    configurable: true,
    get() {
      onYieldReads += 1;
      return () => {};
    },
  });
  Object.defineProperty(dispatcher, 'unrelated', {
    enumerable: true,
    get() {
      throw new Error('unrelated dispatcher getter was read');
    },
  });
  Object.defineProperty(dispatcher, symbol, {
    enumerable: true,
    get() {
      throw new Error('unrelated dispatcher symbol getter was read');
    },
  });

  const kernel = composeKernel({ plan: capacityPlan, maxInFlight: 0, dispatcher, admission: () => true });
  assert.equal(timeoutReads, 1);
  assert.equal(signalReads, 0, 'deleted own signal must not fall through to an inherited getter');
  assert.equal(onYieldReads, 1);
  assert.equal(inheritedSignalReads, 0);

  const acceptedReads = { timeoutMs: 0, signal: new AbortController().signal, onYield: () => {} };
  for (const key of ['timeoutMs', 'signal', 'onYield']) {
    let reads = 0;
    const value = acceptedReads[key];
    Object.defineProperty(acceptedReads, key, {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return value;
      },
    });
    Object.defineProperty(acceptedReads, `${key}Reads`, { value: () => reads, enumerable: false });
  }
  composeKernel({ plan: capacityPlan, maxInFlight: 0, dispatcher: acceptedReads, admission: () => true });
  assert.equal(acceptedReads.timeoutMsReads(), 1);
  assert.equal(acceptedReads.signalReads(), 1);
  assert.equal(acceptedReads.onYieldReads(), 1);

  let addedSignalReads = 0;
  const added = { timeoutMs: 0 };
  Object.defineProperty(added, 'timeoutMs', {
    enumerable: true,
    configurable: true,
    get() {
      Object.defineProperty(added, 'signal', {
        enumerable: true,
        configurable: true,
        get() {
          addedSignalReads += 1;
          throw new Error('supported key added after snapshot was read');
        },
      });
      return 0;
    },
  });
  composeKernel({ plan: capacityPlan, maxInFlight: 0, dispatcher: added, admission: () => true });
  assert.equal(addedSignalReads, 0, 'supported keys added after the initial snapshot remain excluded');

  let nonEnumerableSignalReads = 0;
  const madeNonEnumerable = Object.create(null);
  Object.defineProperty(madeNonEnumerable, 'timeoutMs', {
    enumerable: true,
    configurable: true,
    get() {
      Object.defineProperty(madeNonEnumerable, 'signal', { enumerable: false });
      return 0;
    },
  });
  Object.defineProperty(madeNonEnumerable, 'signal', {
    enumerable: true,
    configurable: true,
    get() {
      nonEnumerableSignalReads += 1;
      throw new Error('supported key made non-enumerable was read');
    },
  });
  composeKernel({ plan: capacityPlan, maxInFlight: 0, dispatcher: madeNonEnumerable, admission: () => true });
  assert.equal(nonEnumerableSignalReads, 0, 'supported keys made non-enumerable remain excluded');
});

test('composition dispatcher projection includes initially non-enumerable supported keys made enumerable', () => {
  const makeDispatcher = () => {
    const dispatcher = {};
    Object.defineProperty(dispatcher, 'timeoutMs', {
      enumerable: true,
      configurable: true,
      get() {
        Object.defineProperty(dispatcher, 'signal', { enumerable: true });
        return 0;
      },
    });
    Object.defineProperty(dispatcher, 'signal', {
      enumerable: false,
      configurable: true,
      value: 1,
    });
    return dispatcher;
  };

  const nativeDispatcher = makeDispatcher();
  assert.equal(({ ...nativeDispatcher }).signal, 1, 'native spread includes the existing signal key after it becomes enumerable');
  const dispatcher = makeDispatcher();
  assert.throws(
    () => composeKernel({ plan: capacityPlan, maxInFlight: 0, dispatcher, admission: () => true }),
    { name: 'InvalidPlan', message: 'dispatcher signal is invalid' },
  );
});

test('composition dispatcher projection preserves native order for noncanonical transitions', () => {
  const makeDispatcher = (operation) => {
    const dispatcher = {};
    const define = (key, descriptor) => Object.defineProperty(dispatcher, key, {
      configurable: true,
      enumerable: true,
      ...descriptor,
    });
    // Deliberately noncanonical order: onYield precedes signal for the
    // mutation cases, so native spread processes the transition first.
    const order = operation === 'toggle'
      ? ['timeoutMs', 'onYield', 'signal']
      : operation === 'replace'
        ? ['onYield', 'timeoutMs', 'signal']
        : ['timeoutMs', 'onYield', 'signal'];
    for (const key of order) {
      if (key === 'timeoutMs') define(key, { get: () => 0 });
      else if (key === 'signal' && operation === 'replace') define(key, { value: new AbortController().signal, writable: true });
      else if (key === 'signal') define(key, { get: () => { throw new Error(`${operation} signal getter was read`); } });
      else define(key, {
        get: () => {
          if (operation === 'delete') delete dispatcher.signal;
          else if (operation === 'replace') Object.defineProperty(dispatcher, 'signal', {
            configurable: true,
            enumerable: true,
            get: () => { throw new Error('replacement signal getter was read'); },
          });
          else Object.defineProperty(dispatcher, 'signal', {
            configurable: true,
            enumerable: false,
            get: () => { throw new Error('toggled signal getter was read'); },
          });
          return () => {};
        },
      });
    }
    return dispatcher;
  };

  const deleted = composeKernel({ plan: capacityPlan, maxInFlight: 0, dispatcher: makeDispatcher('delete'), admission: () => true });
  assert.equal(deleted.dispatchOptions.signal, undefined);
  const toggled = composeKernel({ plan: capacityPlan, maxInFlight: 0, dispatcher: makeDispatcher('toggle'), admission: () => true });
  assert.equal(toggled.dispatchOptions.signal, undefined);
  assert.throws(
    () => composeKernel({ plan: capacityPlan, maxInFlight: 0, dispatcher: makeDispatcher('replace'), admission: () => true }),
    { message: 'replacement signal getter was read' },
  );
});
