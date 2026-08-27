import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/canonical.js';
import { transition } from '../dist/bridge.js';

const plan = { phaseId: 'r11e2', steps: [{ stepId: 'only' }] };
const start = { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' };

test('bridge snapshots only supported own-enumerable dispatcher controls once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-dispatcher-projection-'));
  const reads = { timeoutMs: 0, signal: 0, onYield: 0, unrelated: 0, symbol: 0 };
  const dispatcher = {};
  Object.defineProperties(dispatcher, {
    timeoutMs: { enumerable: true, get() { reads.timeoutMs += 1; return 1_000; } },
    unrelated: { enumerable: true, get() { reads.unrelated += 1; throw new Error('unrelated getter was read'); } },
    signal: { enumerable: true, get() { reads.signal += 1; return undefined; } },
    onYield: { enumerable: true, get() { reads.onYield += 1; return undefined; } },
  });
  Object.defineProperty(dispatcher, Symbol('unrelated'), {
    enumerable: true,
    get() { reads.symbol += 1; throw new Error('symbol getter was read'); },
  });
  try {
    const result = await transition(
      { runDir: root, runId: 'r11e2-dispatcher-projection', mode: 'runtime', plan, dispatcher },
      start,
    );
    assert.equal(result.projected, true);
    assert.deepEqual(reads, { timeoutMs: 1, signal: 1, onYield: 1, unrelated: 0, symbol: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dispatcher projection failure occurs before bridge filesystem mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-dispatcher-preflight-'));
  let timeoutReads = 0;
  let signalReads = 0;
  const dispatcher = {};
  Object.defineProperties(dispatcher, {
    timeoutMs: { enumerable: true, get() { timeoutReads += 1; return 1_000; } },
    signal: { enumerable: true, get() { signalReads += 1; throw new Error('dispatcher signal failure'); } },
  });
  try {
    await assert.rejects(
      () => transition({ runDir: root, runId: 'r11e2-dispatcher-preflight', mode: 'runtime', plan, dispatcher }, start),
      /dispatcher signal failure/,
    );
    assert.equal(timeoutReads, 1);
    assert.equal(signalReads, 1);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('omitted and null dispatcher ignore poisoned inherited controls', async () => {
  const roots = [
    await mkdtemp(join(tmpdir(), 'lunacy-r11e2-dispatcher-omitted-')),
    await mkdtemp(join(tmpdir(), 'lunacy-r11e2-dispatcher-null-')),
  ];
  const inheritedReads = { timeoutMs: 0, signal: 0, onYield: 0 };
  const prior = Object.fromEntries(['timeoutMs', 'signal', 'onYield'].map((key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  const installPoison = () => {
    for (const key of Object.keys(inheritedReads)) {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() { inheritedReads[key] += 1; throw new Error(`inherited ${key} getter was read`); },
      });
    }
  };
  const restorePrototype = () => {
    for (const key of Object.keys(inheritedReads)) {
      const descriptor = prior[key];
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
  };
  try {
    installPoison();
    const omittedTransition = transition(
      { runDir: roots[0], runId: 'r11e2-dispatcher-omitted', mode: 'runtime', plan },
      start,
    );
    restorePrototype();
    const omitted = await omittedTransition;
    installPoison();
    const nullTransition = transition(
      { runDir: roots[1], runId: 'r11e2-dispatcher-null', mode: 'runtime', plan, dispatcher: null },
      start,
    );
    restorePrototype();
    const withNull = await nullTransition;
    assert.equal(omitted.projected, true);
    assert.equal(withNull.projected, true);
    assert.deepEqual(inheritedReads, { timeoutMs: 0, signal: 0, onYield: 0 });
  } finally {
    restorePrototype();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});
