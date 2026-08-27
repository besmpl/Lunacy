import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRunKernel, InvalidPlan } from '../dist/index.js';
import { makeRunKernelForBridge } from '../dist/public.js';
import { composeKernel } from '../dist/composition.js';
import { ContextCompiler } from '../dist/compiler.js';
import { AccelerationMetrics } from '../dist/metrics.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { makeCellHandle, makeSnapshotHandle } from '../dist/reuse.js';

const plan = { phaseId: 'p7-context-off', steps: [{ stepId: 'a' }] };
const payload = { observed: true };

function input(runId, eventId, event, previous) {
  return {
    runId,
    ...(previous ? { expectedRevision: previous.snapshot.revision } : {}),
    identity: {
      runId,
      phaseId: 'run',
      stepId: 'run',
      attemptEpoch: previous?.snapshot.attemptEpoch ?? 0,
      authorityEpoch: previous?.snapshot.authorityEpoch ?? 0,
      barrierEpoch: previous?.snapshot.barrierEpoch ?? 0,
      eventId,
      payloadDigest: digest(event),
    },
    event,
  };
}

function startEvent() {
  return { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
}

function hostEvent(id = 'host') {
  return {
    kind: 'OBSERVATION',
    category: 'HOST',
    ref: { id, scope: 'p7', digest: digest(payload), bytes: canonicalString(payload) },
  };
}

async function trace(options, runId = 'trace') {
  const kernel = makeRunKernel({ plan, maxInFlight: 0, ...options });
  const yields = [];
  let previous = await kernel.advance(input(runId, 'start', startEvent()));
  yields.push(canonicalString(previous));
  previous = await kernel.advance(input(runId, 'host', hostEvent(), previous));
  yields.push(canonicalString(previous));
  return { yields, metrics: options.acceleration?.metrics?.snapshot() };
}

function handles() {
  const cell = makeCellHandle({
    tenant: 'tenant',
    principal: 'principal',
    workspace: 'workspace',
    sensitivity: 'RUN_PRIVATE',
    accessEpoch: 0,
    policyEpoch: 0,
  });
  const snapshot = makeSnapshotHandle({
    generation: 1,
    treeDigest: digest('tree'),
    symlinkDigest: digest('symlink'),
    mountDigest: digest('mount'),
    readSetDigest: digest('read'),
    sourceDigests: [],
  });
  return { cell, snapshot };
}

test('default and explicit context OFF skip all private context/reuse work', async () => {
  const defaultMetrics = new AccelerationMetrics();
  const offMetrics = new AccelerationMetrics();
  const defaultTrace = await trace({ acceleration: { metrics: defaultMetrics } }, 'default-off');
  const offTrace = await trace({ acceleration: { context: 'OFF', reuse: 'ON', metrics: offMetrics, ...handles() } }, 'explicit-off');
  assert.deepEqual(offTrace.yields, defaultTrace.yields);
  for (const metrics of [defaultMetrics.snapshot(), offMetrics.snapshot()]) {
    assert.equal(metrics.contextPrepare, 0);
    assert.equal(metrics.contextMiss, 0);
    assert.equal(metrics.contextHit, 0);
    assert.equal(metrics.reuseBypass, 0);
    assert.equal(metrics.reuseMiss, 0);
    assert.equal(metrics.reuseHit, 0);
  }
});

test('OFF ignores malformed handles and hostile getters without changing construction validation', async () => {
  let reads = 0;
  const hostile = new Proxy({}, {
    get() { reads += 1; throw new Error('dead OFF handle read'); },
    ownKeys() { reads += 1; throw new Error('dead OFF handle enumeration'); },
    getOwnPropertyDescriptor() { reads += 1; throw new Error('dead OFF handle descriptor read'); },
  });
  const metrics = new AccelerationMetrics();
  const result = await trace({ acceleration: { context: 'OFF', cell: hostile, snapshot: hostile, metrics } }, 'hostile-off');
  assert.equal(reads, 0);
  assert.equal(metrics.snapshot().contextPrepare, 0);
  assert.throws(() => makeRunKernel({ plan, acceleration: { context: 'INVALID' } }), InvalidPlan);
  assert.throws(() => makeRunKernel({ plan, acceleration: { metrics: null } }), InvalidPlan);
});

test('context mode is captured once and active SHADOW/ON behavior remains observable', async () => {
  const shadowMetrics = new AccelerationMetrics();
  const shadowAcceleration = { context: 'SHADOW', reuse: 'SHADOW', metrics: shadowMetrics };
  const shadow = makeRunKernel({ plan, maxInFlight: 0, acceleration: shadowAcceleration });
  shadowAcceleration.context = 'OFF';
  let shadowValue = await shadow.advance(input('captured-shadow', 'start', startEvent()));
  assert.equal(shadowValue.kind, 'WAITING');
  assert.ok(shadowMetrics.snapshot().contextPrepare > 0);

  const onMetrics = new AccelerationMetrics();
  const onAcceleration = { context: 'ON', reuse: 'ON', metrics: onMetrics, ...handles() };
  const on = await trace({ acceleration: onAcceleration }, 'active-on');
  assert.ok(on.metrics.contextPrepare > 0);
  assert.ok(on.metrics.reuseBypass + on.metrics.reuseMiss + on.metrics.reuseHit > 0);

  const off = await trace({ acceleration: { context: 'OFF', metrics: new AccelerationMetrics() } }, 'active-off');
  assert.deepEqual(on.yields, off.yields);
});

test('hard-private context capture survives string-key mutation across all factory surfaces', async () => {
  const factories = [
    ['public', (options) => makeRunKernel(options)],
    ['bridge', (options) => makeRunKernelForBridge(options, {})],
    ['driver', (options) => composeKernel({ ...options, driver: { dispatch() { throw new Error('dispatch must not run'); } } })],
  ];
  for (const [label, factory] of factories) {
    for (const mode of ['OFF', 'SHADOW', 'ON']) {
      const metrics = new AccelerationMetrics();
      const kernel = factory({ plan, maxInFlight: 0, acceleration: { context: mode, reuse: mode, metrics, ...(mode === 'OFF' ? handles() : {}) } });
      const attemptedMode = mode === 'OFF' ? 'ON' : 'OFF';
      kernel.contextMode = attemptedMode;
      Object.defineProperty(kernel, 'contextMode', { value: attemptedMode, writable: true, configurable: true, enumerable: true });
      const started = await kernel.advance(input(`hard-private-${label}-${mode}`, 'start', startEvent()));
      assert.equal(started.kind, 'WAITING');
      const counts = metrics.snapshot();
      assert.equal(counts.contextPrepare > 0, mode !== 'OFF', `${label}/${mode} construction capture must survive string-key mutation`);
      assert.equal(counts.contextMiss > 0, mode !== 'OFF', `${label}/${mode} compiler mode must remain captured`);
      assert.equal(counts.reuseBypass + counts.reuseMiss + counts.reuseHit > 0, mode !== 'OFF', `${label}/${mode} reuse mode must remain captured`);
    }
  }
});

test('acceleration island ignores S65B compiler/prepareContext shadowing across all factories', async () => {
  const factories = [
    ['public', (options) => makeRunKernel(options)],
    ['bridge', (options) => makeRunKernelForBridge(options, {})],
    ['composition', (options) => composeKernel({ ...options, driver: { dispatch() { throw new Error('dispatch must not run'); } } })],
  ];
  for (const [label, factory] of factories) {
    const shadowCalls = { compiler: 0, prepareContext: 0 };
    const metrics = new AccelerationMetrics();
    const kernel = factory({ plan, maxInFlight: 0, acceleration: { context: 'OFF', reuse: 'ON', metrics } });
    const fakeCompiler = { prepare: async () => { shadowCalls.compiler += 1; throw new Error('S65B shadow compiler must not run'); } };
    kernel.compiler = fakeCompiler;
    kernel.prepareContext = fakeCompiler.prepare.bind(fakeCompiler);
    const started = await kernel.advance(input(`s65b-${label}`, 'start', startEvent()));
    assert.equal(started.kind, 'WAITING');
    assert.deepEqual(shadowCalls, { compiler: 0, prepareContext: 0 }, `${label} string-key shadows must not enter private context work`);
    assert.equal(metrics.snapshot().contextPrepare, 0, `${label} OFF must remain zero-entry`);
    assert.equal(metrics.snapshot().contextMiss, 0, `${label} OFF must not record a compiler miss`);
    assert.equal(metrics.snapshot().reuseBypass, 0, `${label} OFF must not enter reuse`);
  }
});

test('all acceleration private-island string/symbol/prototype shadows preserve mode routing', async () => {
  const factories = [
    ['public', (options) => makeRunKernel(options)],
    ['bridge', (options) => makeRunKernelForBridge(options, {})],
    ['composition', (options) => composeKernel({ ...options, driver: { dispatch() { throw new Error('dispatch must not run'); } } })],
  ];
  const keys = ['contextMode', 'compiler', 'graphMode', 'graph', 'prepareContext', 'prepareGraph'];
  for (const [label, factory] of factories) {
    for (const mode of ['OFF', 'SHADOW', 'ON']) {
      const metrics = new AccelerationMetrics();
      const kernel = factory({ plan, maxInFlight: 0, acceleration: { context: mode, reuse: mode, graph: mode, metrics } });
      const shadowCompiler = { prepare: async () => { throw new Error('shadow compiler must not run'); } };
      const shadowGraph = { prepare: () => { throw new Error('shadow graph must not run'); } };
      const shadowMethods = {
        prepareContext: async () => { throw new Error('shadow prepareContext must not run'); },
        prepareGraph: () => { throw new Error('shadow prepareGraph must not run'); },
      };
      Object.assign(kernel, { contextMode: mode === 'OFF' ? 'ON' : 'OFF', compiler: shadowCompiler, graphMode: mode === 'OFF' ? 'ON' : 'OFF', graph: shadowGraph, ...shadowMethods });
      for (const key of keys) kernel[Symbol(key)] = `symbol-shadow:${key}`;
      const originalPrototype = Object.getPrototypeOf(kernel);
      const hostilePrototype = Object.create(originalPrototype);
      for (const key of keys) Object.defineProperty(hostilePrototype, key, { configurable: true, get() { throw new Error(`prototype shadow ${key} must not be read`); } });
      Object.setPrototypeOf(kernel, hostilePrototype);
      const started = await kernel.advance(input(`island-${label}-${mode}`, 'start', startEvent()));
      assert.equal(started.kind, 'WAITING');
      const counts = metrics.snapshot();
      assert.equal(counts.contextPrepare > 0, mode !== 'OFF', `${label}/${mode} context routing must remain constructor-captured`);
      assert.equal(counts.graphPrepare > 0, mode !== 'OFF', `${label}/${mode} graph routing must remain constructor-captured`);
      assert.equal(counts.contextMiss > 0, mode !== 'OFF', `${label}/${mode} context compiler must remain active`);
      assert.equal(counts.reuseBypass > 0, mode !== 'OFF', `${label}/${mode} reuse mode must remain active`);
    }
  }
});

test('direct ContextCompiler OFF callers still receive a prepared context', async () => {
  const metrics = new AccelerationMetrics();
  const compiler = new ContextCompiler({ mode: 'OFF', reuseMode: 'OFF', metrics });
  const prepared = await compiler.prepare({
    proof: { runId: 'direct', authorityDigest: digest(plan), authorityEpoch: 0, generation: 1, revision: 0 },
    scope: { workspace: 'workspace', sensitivity: 'RUN_PRIVATE' },
    sources: [{ id: 'source', digest: digest('source') }],
    kind: 'BASE',
    derivation: { id: 'direct', version: '1', schema: 'context-base/v1' },
    dynamicTail: { bytes: 'tail', eventId: 'event', snapshotDigest: digest({ runId: 'direct', generation: 1, revision: 0 }) },
  });
  assert.equal(prepared.mode, 'OFF');
  assert.equal(typeof prepared.requestBytes, 'string');
  assert.ok(prepared.stableRef.bytes);
  assert.equal(metrics.snapshot().contextPrepare, 1);
  assert.equal(metrics.snapshot().reuseBypass, 1);
});

test('context/reuse/graph mode matrix preserves exact yields and only active paths prepare', async () => {
  const baseline = await trace({ acceleration: { graph: 'OFF', context: 'OFF', reuse: 'OFF' } }, 'matrix-off-off-off');
  for (const graph of ['OFF', 'SHADOW', 'ON']) {
    for (const context of ['OFF', 'SHADOW', 'ON']) {
      const metrics = new AccelerationMetrics();
      const result = await trace({ acceleration: { graph, context, reuse: context, metrics } }, `matrix-${graph}-${context}`);
      assert.deepEqual(result.yields, baseline.yields);
      const counts = result.metrics;
      assert.equal(counts.graphPrepare > 0, graph !== 'OFF');
      assert.equal(counts.contextPrepare > 0, context !== 'OFF');
      assert.equal(counts.reuseBypass > 0, context !== 'OFF');
    }
  }
});
