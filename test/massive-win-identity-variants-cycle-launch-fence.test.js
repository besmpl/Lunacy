import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { BridgeError, canonicalizeDeclaration, deleteBridge, disable, transition } from '../dist/bridge.js';
import { makeRunKernel } from '../dist/index.js';
import { claim } from '../dist/outbox.js';
import { FileArtifactStore, MemoryArtifactStore, storeLinearizedDispatch } from '../dist/store.js';

const plan = { phaseId: 'massive-win', steps: [{ stepId: 'a' }] };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const ref = (id, value, scope = 'massive-win') => ({ id, scope, digest: digest(value), bytes: canonicalString(value) });
const receipt = (command, launchToken, id = 'receipt') => ({ launchToken, commandDigest: command.commandDigest, ref: ref(id, { accepted: true }) });
const input = (runId, eventId, event, cursor, launchToken) => ({
  runId,
  ...(cursor?.revision === undefined ? {} : { expectedRevision: cursor.revision }),
  identity: {
    runId, phaseId: 'run', stepId: 'run',
    attemptEpoch: cursor?.attemptEpoch ?? 0,
    authorityEpoch: cursor?.authorityEpoch ?? 0,
    barrierEpoch: cursor?.barrierEpoch ?? 0,
    eventId, payloadDigest: digest(event),
    ...(launchToken ? { launchToken } : {}),
  },
  event,
});
const startInput = (runId, rootPlan = plan) => input(runId, 'start', { kind: 'START', intentRef: { id: 'plan', digest: digest(rootPlan) } });
const commandFrom = (state) => Object.values(state.outbox)[0];
const authorityFrom = (snapshot) => {
  const command = commandFrom(snapshot.state);
  return {
    generation: snapshot.generation,
    writerFence: snapshot.state.writerFence,
    runId: snapshot.state.runId,
    phaseId: snapshot.state.phaseId,
    authorityEpoch: snapshot.state.authorityEpoch,
    attemptEpoch: snapshot.state.attemptEpoch,
    barrierEpoch: snapshot.state.barrierEpoch,
    modeEpoch: snapshot.state.modeEpoch,
    command: clone(command),
  };
};
const recoveryInput = (runId, eventId, state) => {
  const command = commandFrom(state);
  const event = { kind: 'OBSERVATION', category: 'RECOVERY', ref: ref(`never:${command.launchToken}`, { launchToken: command.launchToken, commandDigest: command.commandDigest, status: 'NEVER_LAUNCHED' }, 'outbox/recovery') };
  return input(runId, eventId, event, state, command.launchToken);
};
async function loadState(root) { return (await new FileArtifactStore(root).load()).state; }
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timeout');
    await wait(5);
  }
}

async function runPausedThreeKernelRace(graph) {
  const root = await mkdtemp(join(tmpdir(), `lunacy-massive-win-${graph.toLowerCase()}-`));
  const calls = { p1: 0, p3: 0 };
  const k1 = composeKernel({ plan, rootDir: root, timeoutMs: 10_000, acceleration: { graph }, driver: { dispatch(command, token) { calls.p1 += 1; return receipt(command, token, 'p1'); } } });
  const start = await k1.advance(startInput(`race-${graph}`));
  const reached = deferred();
  const release = deferred();
  const originalCommit = FileArtifactStore.prototype.commit;
  let paused = false;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const result = await originalCommit.call(this, generation, state);
    const command = Object.values(state.outbox ?? {}).find((candidate) => candidate.state === 'CLAIMED');
    if (!paused && command && state.journal.at(-1)?.event?.kind === 'RESUME') {
      paused = true;
      reached.resolve();
      await release.promise;
    }
    return result;
  };
  try {
    const k2 = composeKernel({ plan, rootDir: root, timeoutMs: 10_000, driver: { dispatch() { throw new Error('p2 must not dispatch'); } } });
    const k3 = composeKernel({ plan, rootDir: root, timeoutMs: 10_000, acceleration: { graph }, driver: { dispatch(command, token) { calls.p3 += 1; return receipt(command, token, 'p3'); } } });
    const p1 = k1.advance(input(`race-${graph}`, 'p1-resume', { kind: 'RESUME' }, start.snapshot));
    await reached.promise;
    const claimed = await loadState(root);
    const oldLease = commandFrom(claimed).leaseId;
    const p2 = await k2.advance(input(`race-${graph}`, 'p2-resume', { kind: 'RESUME' }, claimed));
    assert.equal(p2.kind, 'BLOCKED');
    const unknown = await loadState(root);
    assert.equal(commandFrom(unknown).state, 'UNKNOWN');
    await k3.advance(recoveryInput(`race-${graph}`, 'recover', unknown));
    const pending = await loadState(root);
    assert.equal(commandFrom(pending).state, 'PENDING');
    const p3 = await k3.advance(input(`race-${graph}`, 'p3-resume', { kind: 'RESUME' }, pending));
    assert.equal(p3.snapshot.pendingDispatchCount, 0);
    const acked = await loadState(root);
    assert.equal(commandFrom(acked).state, 'ACKED');
    assert.notEqual(commandFrom(acked).leaseId, oldLease);
    release.resolve();
    await p1;
    return { calls, state: await loadState(root) };
  } finally {
    release.resolve();
    FileArtifactStore.prototype.commit = originalCommit;
  }
}

test('massive-win launch fence closes the exact P1/P2/P3 race with graph OFF and ON', async () => {
  for (const graph of ['OFF', 'ON']) {
    const result = await runPausedThreeKernelRace(graph);
    assert.deepEqual(result.calls, { p1: 0, p3: 1 });
    assert.equal(commandFrom(result.state).state, 'ACKED');
  }
});

test('massive-win Memory fence orders writer-first, launcher-first, and same-store Promise reentrancy', async () => {
  async function claimedMemory(runId) {
    const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-memory-seed-'));
    const kernel = makeRunKernel({ plan, rootDir: root });
    await kernel.advance(startInput(runId));
    const pending = await loadState(root);
    const memory = new MemoryArtifactStore();
    await memory.commit(0, pending);
    const claimedState = clone(pending);
    const command = commandFrom(claimedState);
    claim(command, `lease-${runId}`, claimedState.modeEpoch, claimedState.writerFence);
    claimedState.writerFence = `memory-fence-${runId}`;
    await memory.commit(1, claimedState);
    return { memory, snapshot: await memory.load() };
  }

  const writerFirst = await claimedMemory('writer-first');
  const staleAuthority = authorityFrom(writerFirst.snapshot);
  const revoked = clone(writerFirst.snapshot.state);
  // Even a byte-identical later generation revokes the old capability.
  await writerFirst.memory.commit(writerFirst.snapshot.generation, revoked);
  let staleCalls = 0;
  const stale = await storeLinearizedDispatch(writerFirst.memory, {
    authority: staleAuthority, receiver: {}, signal: new AbortController().signal, deadline: Date.now() + 1000,
    dispatch() { staleCalls += 1; return receipt(staleAuthority.command, staleAuthority.command.launchToken); },
  });
  assert.equal(stale.kind, 'STALE');
  assert.equal(staleCalls, 0);

  const launcherFirst = await claimedMemory('launcher-first');
  const launchAuthority = authorityFrom(launcherFirst.snapshot);
  const afterLaunch = clone(launcherFirst.snapshot.state);
  afterLaunch.writerFence = 'queued-writer';
  let queuedWriter;
  let launchCalls = 0;
  const launched = await storeLinearizedDispatch(launcherFirst.memory, {
    authority: launchAuthority, receiver: {}, signal: new AbortController().signal, deadline: Date.now() + 1000,
    dispatch(command, token) {
      launchCalls += 1;
      queuedWriter = launcherFirst.memory.commit(launchAuthority.generation, afterLaunch);
      return queuedWriter.then(() => receipt(command, token, 'reentrant'));
    },
  });
  assert.equal(launched.kind, 'PROMISE');
  assert.equal((await launched.receipt).launchToken, launchAuthority.command.launchToken);
  assert.equal(await queuedWriter, launchAuthority.generation + 1);
  assert.equal(launchCalls, 1);
});

test('massive-win File fence orders a byte-identical writer before launch and a reentrant writer after launch', async () => {
  async function claimedFile(runId) {
    const seed = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-file-seed-'));
    await makeRunKernel({ plan, rootDir: seed }).advance(startInput(runId));
    const pending = await loadState(seed);
    const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-file-order-'));
    const store = new FileArtifactStore(root);
    await store.commit(0, pending);
    const claimedState = clone(pending);
    claim(commandFrom(claimedState), `lease-${runId}`, claimedState.modeEpoch, claimedState.writerFence);
    claimedState.writerFence = `file-fence-${runId}`;
    await store.commit(1, claimedState);
    return { store, snapshot: await store.load() };
  }

  const writerFirst = await claimedFile('file-writer-first');
  const staleAuthority = authorityFrom(writerFirst.snapshot);
  await writerFirst.store.commit(writerFirst.snapshot.generation, clone(writerFirst.snapshot.state));
  let staleCalls = 0;
  const stale = await storeLinearizedDispatch(writerFirst.store, { authority: staleAuthority, receiver: {}, signal: new AbortController().signal, deadline: Date.now() + 3000, dispatch() { staleCalls += 1; } });
  assert.equal(stale.kind, 'STALE');
  assert.equal(staleCalls, 0);

  const launcherFirst = await claimedFile('file-launcher-first');
  const currentAuthority = authorityFrom(launcherFirst.snapshot);
  let queuedCommit;
  let calls = 0;
  const launched = await storeLinearizedDispatch(launcherFirst.store, {
    authority: currentAuthority, receiver: {}, signal: new AbortController().signal, deadline: Date.now() + 3000,
    dispatch(command, token) {
      calls += 1;
      queuedCommit = launcherFirst.store.commit(currentAuthority.generation, clone(launcherFirst.snapshot.state));
      return queuedCommit.then(() => receipt(command, token, 'file-reentrant'));
    },
  });
  assert.equal(launched.kind, 'PROMISE');
  assert.equal((await launched.receipt).launchToken, currentAuthority.command.launchToken);
  assert.equal(await queuedCommit, currentAuthority.generation + 1);
  assert.equal(calls, 1);
});

test('massive-win File launch keeps the verified-read fence through dispatch entry', async () => {
  const seed = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-file-held-seed-'));
  await makeRunKernel({ plan, rootDir: seed }).advance(startInput('file-held'));
  const pending = await loadState(seed);
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-file-held-'));
  const store = new FileArtifactStore(root);
  await store.commit(0, pending);
  const claimed = clone(pending);
  claim(commandFrom(claimed), 'lease-file-held', claimed.modeEpoch, claimed.writerFence);
  claimed.writerFence = 'file-held-fence';
  await store.commit(1, claimed);
  const snapshot = await store.load();
  const authority = authorityFrom(snapshot);
  const reached = deferred();
  const release = deferred();
  const originalRead = FileArtifactStore.prototype.readVerifiedCurrent;
  let paused = false;
  let writerSettled = false;
  let writerPromise;
  let writerWasSettledAtEntry;
  FileArtifactStore.prototype.readVerifiedCurrent = async function (...args) {
    const value = await originalRead.apply(this, args);
    if (this === store && !paused) { paused = true; reached.resolve(); await release.promise; }
    return value;
  };
  try {
    const launch = storeLinearizedDispatch(store, {
      authority, receiver: {}, signal: new AbortController().signal, deadline: Date.now() + 3000,
      dispatch(command, token) { writerWasSettledAtEntry = writerSettled; return receipt(command, token); },
    });
    await reached.promise;
    writerPromise = store.commit(snapshot.generation, clone(snapshot.state)).then((generation) => { writerSettled = true; return generation; });
    release.resolve();
    const result = await launch;
    assert.equal(result.kind, 'RECEIPT');
    assert.equal(writerWasSettledAtEntry, false);
    assert.equal(await writerPromise, snapshot.generation + 1);
  } finally {
    release.resolve();
    FileArtifactStore.prototype.readVerifiedCurrent = originalRead;
  }
});

test('massive-win shared Memory authority rejects an old lease after UNKNOWN to PENDING to a new claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-memory-race-seed-'));
  const kernel = makeRunKernel({ plan, rootDir: root });
  await kernel.advance(startInput('memory-race'));
  const memory = new MemoryArtifactStore();
  await memory.commit(0, await loadState(root));
  const first = clone((await memory.load()).state);
  claim(commandFrom(first), 'lease-old', first.modeEpoch, first.writerFence);
  first.writerFence = 'memory-old-claim';
  await memory.commit(1, first);
  const oldAuthority = authorityFrom(await memory.load());
  const unknown = clone(first); unknown.outbox[commandFrom(unknown).commandId].state = 'UNKNOWN'; unknown.writerFence = 'memory-unknown';
  await memory.commit(2, unknown);
  const pending = clone(unknown); pending.outbox[commandFrom(pending).commandId].state = 'PENDING'; pending.writerFence = 'memory-pending';
  await memory.commit(3, pending);
  const second = clone(pending); claim(commandFrom(second), 'lease-new', second.modeEpoch, second.writerFence); second.writerFence = 'memory-new-claim';
  await memory.commit(4, second);
  const newAuthority = authorityFrom(await memory.load());
  let oldCalls = 0;
  const stale = await storeLinearizedDispatch(memory, { authority: oldAuthority, receiver: {}, signal: new AbortController().signal, deadline: Date.now() + 1000, dispatch() { oldCalls += 1; } });
  assert.equal(stale.kind, 'STALE');
  assert.equal(oldCalls, 0);
  const tamperedAuthority = clone(newAuthority);
  tamperedAuthority.command.stepId = 'different-command-bytes';
  const tampered = await storeLinearizedDispatch(memory, { authority: tamperedAuthority, receiver: {}, signal: new AbortController().signal, deadline: Date.now() + 1000, dispatch() { oldCalls += 1; } });
  assert.equal(tampered.kind, 'STALE');
  assert.equal(oldCalls, 0);
  let newCalls = 0;
  const current = await storeLinearizedDispatch(memory, { authority: newAuthority, receiver: {}, signal: new AbortController().signal, deadline: Date.now() + 1000, dispatch(command, token) { newCalls += 1; return receipt(command, token); } });
  assert.equal(current.kind, 'RECEIPT');
  assert.equal(newCalls, 1);
});

test('massive-win true child-process File race makes only the successor call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-cross-process-'));
  const runId = 'cross-process-race';
  const parentStart = composeKernel({ plan, rootDir: root });
  const start = await parentStart.advance(startInput(runId));
  const control = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-child-control-'));
  const ready = join(control, 'ready');
  const release = join(control, 'release');
  const calls = join(control, 'calls');
  const resultPath = join(control, 'result.json');
  const scriptPath = join(control, 'child.mjs');
  const compositionUrl = new URL('../dist/composition.js', import.meta.url).href;
  const canonicalUrl = new URL('../dist/canonical.js', import.meta.url).href;
  const storeUrl = new URL('../dist/store.js', import.meta.url).href;
  const script = `
    import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
    import { composeKernel } from ${JSON.stringify(compositionUrl)};
    import { digest, canonicalString } from ${JSON.stringify(canonicalUrl)};
    import { FileArtifactStore } from ${JSON.stringify(storeUrl)};
    const [root, ready, release, calls, resultPath] = process.argv.slice(2);
    const plan = ${JSON.stringify(plan)};
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const original = FileArtifactStore.prototype.commit;
    let paused = false;
    FileArtifactStore.prototype.commit = async function(g, state) {
      const result = await original.call(this, g, state);
      if (!paused && Object.values(state.outbox ?? {}).some(c => c.state === 'CLAIMED')) {
        paused = true; writeFileSync(ready, 'ready'); while (!existsSync(release)) await wait(5);
      }
      return result;
    };
    const state = (await new FileArtifactStore(root).load()).state;
    const event = { kind: 'RESUME' };
    const input = { runId: ${JSON.stringify(runId)}, expectedRevision: state.revision, identity: { runId: ${JSON.stringify(runId)}, phaseId: 'run', stepId: 'run', attemptEpoch: state.attemptEpoch, authorityEpoch: state.authorityEpoch, barrierEpoch: state.barrierEpoch, eventId: 'child-resume', payloadDigest: digest(event) }, event };
    const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 10000, driver: { dispatch(command, token) { appendFileSync(calls, 'child\\n'); return { launchToken: token, commandDigest: command.commandDigest, ref: { id: 'child', scope: 'massive-win', digest: digest({ok:true}), bytes: canonicalString({ok:true}) } }; } } });
    try { const value = await kernel.advance(input); writeFileSync(resultPath, JSON.stringify(value)); }
    catch (error) { writeFileSync(resultPath, JSON.stringify({error: error.message})); process.exitCode = 1; }
  `;
  await writeFile(scriptPath, script);
  const child = spawn(process.execPath, [scriptPath, root, ready, release, calls, resultPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await waitFor(() => existsSync(ready), 10_000);
  const claimed = await loadState(root);
  const k2 = composeKernel({ plan, rootDir: root, driver: { dispatch() { throw new Error('must not call'); } } });
  await k2.advance(input(runId, 'parent-recover-claimed', { kind: 'RESUME' }, claimed));
  const unknown = await loadState(root);
  const k3 = composeKernel({ plan, rootDir: root, driver: { dispatch(command, token) { writeFileSync(calls, 'parent\n', { flag: 'a' }); return receipt(command, token, 'parent'); } } });
  await k3.advance(recoveryInput(runId, 'parent-never-launched', unknown));
  const pending = await loadState(root);
  await k3.advance(input(runId, 'parent-resume', { kind: 'RESUME' }, pending));
  await writeFile(release, 'release');
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(await readFile(calls, 'utf8'), 'parent\n');
  assert.equal(commandFrom(await loadState(root)).state, 'ACKED');
  assert.ok(JSON.parse(await readFile(resultPath, 'utf8')).kind);
});

test('massive-win sync throw, malformed result, malicious thenable, sync receipt, and real Promise are classified exactly', async () => {
  let promiseThenGetterCalls = 0;
  const cases = [
    { name: 'throw', make: () => { throw new Error('uncertain'); }, expected: 'UNKNOWN' },
    { name: 'malformed', make: () => ({ nope: true }), expected: 'UNKNOWN' },
    { name: 'receipt', make: (command, token) => receipt(command, token), expected: 'ACKED' },
    { name: 'promise', make: (command, token) => Promise.resolve(receipt(command, token)), expected: 'ACKED' },
    { name: 'promise-own-then', make: (command, token) => {
      const promise = Promise.resolve(receipt(command, token));
      Object.defineProperty(promise, 'then', { get() { promiseThenGetterCalls += 1; throw new Error('must not read'); } });
      return promise;
    }, expected: 'ACKED' },
  ];
  for (const item of cases) {
    const root = await mkdtemp(join(tmpdir(), `lunacy-massive-win-${item.name}-`));
    let calls = 0;
    const kernel = composeKernel({ plan, rootDir: root, driver: { dispatch(command, token) { calls += 1; return item.make(command, token); } } });
    const started = await kernel.advance(startInput(`classify-${item.name}`));
    await kernel.advance(input(`classify-${item.name}`, 'resume', { kind: 'RESUME' }, started.snapshot));
    await waitFor(async () => commandFrom(await loadState(root)).state === item.expected, 3000);
    assert.equal(calls, 1);
    assert.equal(commandFrom(await loadState(root)).state, item.expected);
  }
  assert.equal(promiseThenGetterCalls, 0);

  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-thenable-'));
  let getterCalls = 0;
  const thenable = { get then() { getterCalls += 1; throw new Error('must not read'); } };
  const kernel = composeKernel({ plan, rootDir: root, driver: { dispatch() { return thenable; } } });
  const started = await kernel.advance(startInput('malicious-thenable'));
  const result = await kernel.advance(input('malicious-thenable', 'resume', { kind: 'RESUME' }, started.snapshot));
  assert.equal(result.kind, 'BLOCKED');
  assert.equal(getterCalls, 0);
  assert.equal(commandFrom(await loadState(root)).state, 'UNKNOWN');
});

test('massive-win synchronous onYield throw cannot gate immediate UNKNOWN replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-yield-unknown-'));
  let calls = 0;
  let notifications = 0;
  const kernel = composeKernel({
    plan, rootDir: root, timeoutMs: 0,
    onYield() { notifications += 1; throw new Error('notification failure'); },
    driver: { dispatch() { calls += 1; throw new Error('must not enter'); } },
  });
  const started = await kernel.advance(startInput('yield-unknown'));
  const resume = input('yield-unknown', 'resume', { kind: 'RESUME' }, started.snapshot);
  const result = await kernel.advance(resume);
  const replayed = await kernel.advance(resume);
  await waitFor(() => notifications === 1);

  assert.equal(calls, 0);
  assert.equal(result.kind, 'BLOCKED');
  assert.equal(result.code, 'UnknownDispatch');
  assert.equal(result.snapshot.pendingDispatchCount, 0);
  assert.equal(result.snapshot.unknownDispatchCount, 1);
  assert.equal(commandFrom(await loadState(root)).state, 'UNKNOWN');
  assert.deepEqual(replayed, result);
});

test('massive-win synchronous onYield throw cannot gate immediate ACK replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-yield-ack-'));
  let calls = 0;
  let notifications = 0;
  const kernel = composeKernel({
    plan, rootDir: root,
    onYield() { notifications += 1; throw new Error('notification failure'); },
    driver: { dispatch(command, token) { calls += 1; return receipt(command, token, 'yield-ack'); } },
  });
  const started = await kernel.advance(startInput('yield-ack'));
  const resume = input('yield-ack', 'resume', { kind: 'RESUME' }, started.snapshot);
  const result = await kernel.advance(resume);
  const replayed = await kernel.advance(resume);
  await waitFor(() => notifications === 1);

  assert.equal(calls, 1);
  assert.equal(result.kind, 'WAITING');
  assert.equal(result.snapshot.pendingDispatchCount, 0);
  assert.equal(result.snapshot.unknownDispatchCount, 0);
  assert.equal(commandFrom(await loadState(root)).state, 'ACKED');
  assert.deepEqual(replayed, result);
});

test('massive-win observe intrinsically watches a real Promise with poisoned own then', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-observe-promise-'));
  let dispatchedCommand;
  let observeCalls = 0;
  let thenGetterCalls = 0;
  const kernel = composeKernel({
    plan, rootDir: root,
    driver: {
      dispatch(command) { dispatchedCommand = clone(command); throw new Error('uncertain'); },
      observe() {
        observeCalls += 1;
        const promise = Promise.resolve(receipt(dispatchedCommand, dispatchedCommand.launchToken, 'observed'));
        Object.defineProperty(promise, 'then', { get() { thenGetterCalls += 1; throw new Error('must not read'); } });
        return promise;
      },
    },
  });
  const started = await kernel.advance(startInput('observe-promise'));
  await kernel.advance(input('observe-promise', 'dispatch', { kind: 'RESUME' }, started.snapshot));
  const unknown = await loadState(root);
  assert.equal(commandFrom(unknown).state, 'UNKNOWN');
  await kernel.advance(input('observe-promise', 'observe', { kind: 'RESUME' }, unknown));
  await waitFor(async () => commandFrom(await loadState(root)).state === 'ACKED', 3000);

  assert.equal(observeCalls, 1);
  assert.equal(thenGetterCalls, 0);
  assert.equal(commandFrom(await loadState(root)).state, 'ACKED');
});

test('massive-win malicious observe thenable, Proxy, and accessor fail closed and release the exact task', async () => {
  const variants = [
    {
      name: 'thenable',
      make(counter) {
        const value = {};
        Object.defineProperty(value, 'then', { enumerable: true, get() { counter.count += 1; throw new Error('must not read'); } });
        return value;
      },
    },
    {
      name: 'proxy',
      make(counter) {
        const trap = () => { counter.count += 1; throw new Error('must not trap'); };
        return new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
      },
    },
    {
      name: 'accessor',
      make(counter) {
        const value = {};
        for (const key of ['launchToken', 'commandDigest', 'ref']) Object.defineProperty(value, key, { enumerable: true, get() { counter.count += 1; throw new Error('must not read'); } });
        return value;
      },
    },
  ];

  for (const variant of variants) {
    const root = await mkdtemp(join(tmpdir(), `lunacy-massive-win-observe-${variant.name}-`));
    const counter = { count: 0 };
    let observeCalls = 0;
    const malicious = variant.make(counter);
    const kernel = composeKernel({
      plan, rootDir: root,
      driver: {
        dispatch() { throw new Error('uncertain'); },
        observe() { observeCalls += 1; return observeCalls === 1 ? malicious : undefined; },
      },
    });
    const started = await kernel.advance(startInput(`observe-${variant.name}`));
    await kernel.advance(input(`observe-${variant.name}`, 'dispatch', { kind: 'RESUME' }, started.snapshot));
    let state = await loadState(root);
    const first = await kernel.advance(input(`observe-${variant.name}`, 'observe-1', { kind: 'RESUME' }, state));
    state = await loadState(root);
    const second = await kernel.advance(input(`observe-${variant.name}`, 'observe-2', { kind: 'RESUME' }, state));

    assert.equal(first.kind, 'BLOCKED');
    assert.equal(second.kind, 'BLOCKED');
    assert.equal(observeCalls, 2, `${variant.name} leaked its active task`);
    assert.equal(counter.count, 0, `${variant.name} executed caller code`);
    assert.equal(commandFrom(await loadState(root)).state, 'UNKNOWN');
  }
});

test('massive-win abort during synchronous dispatch and deadline while waiting for File fence become one UNKNOWN', async () => {
  const syncRoot = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-sync-abort-'));
  const controller = new AbortController();
  let calls = 0;
  const syncKernel = composeKernel({ plan, rootDir: syncRoot, signal: controller.signal, driver: { dispatch(command, token) { calls += 1; controller.abort(); return receipt(command, token); } } });
  const started = await syncKernel.advance(startInput('sync-abort'));
  const syncResult = await syncKernel.advance(input('sync-abort', 'resume', { kind: 'RESUME' }, started.snapshot));
  assert.equal(calls, 1);
  assert.equal(syncResult.kind, 'BLOCKED');
  assert.equal(commandFrom(await loadState(syncRoot)).state, 'UNKNOWN');

  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-fence-deadline-'));
  let deadlineCalls = 0;
  const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 30, driver: { dispatch() { deadlineCalls += 1; throw new Error('must not enter'); } } });
  const first = await kernel.advance(startInput('fence-deadline'));
  const originalCommit = FileArtifactStore.prototype.commit;
  let armed = false;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const committed = await originalCommit.call(this, generation, state);
    if (!armed && Object.values(state.outbox ?? {}).some((command) => command.state === 'CLAIMED')) {
      armed = true;
      writeFileSync(join(root, '.kernel', '.writer.lock'), canonicalString({ pid: process.pid, started: Date.now(), nonce: 'held' }), { mode: 0o600 });
      setTimeout(() => { try { unlinkSync(join(root, '.kernel', '.writer.lock')); } catch {} }, 80);
    }
    return committed;
  };
  try {
    const result = await kernel.advance(input('fence-deadline', 'resume', { kind: 'RESUME' }, first.snapshot));
    assert.equal(result.kind, 'BLOCKED');
    assert.equal(deadlineCalls, 0);
    const state = await loadState(root);
    assert.equal(commandFrom(state).state, 'UNKNOWN');
    assert.equal(state.journal.filter((entry) => entry.identity.eventId.startsWith('dispatcher-unknown:')).length, 1);
  } finally { FileArtifactStore.prototype.commit = originalCommit; }

  const abortRoot = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-fence-abort-'));
  const abortController = new AbortController();
  let abortCalls = 0;
  const abortKernel = composeKernel({ plan, rootDir: abortRoot, timeoutMs: 1000, signal: abortController.signal, driver: { dispatch() { abortCalls += 1; throw new Error('must not enter'); } } });
  const abortStart = await abortKernel.advance(startInput('fence-abort'));
  let abortArmed = false;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const committed = await originalCommit.call(this, generation, state);
    if (!abortArmed && Object.values(state.outbox ?? {}).some((command) => command.state === 'CLAIMED')) {
      abortArmed = true;
      const lock = join(abortRoot, '.kernel', '.writer.lock');
      writeFileSync(lock, canonicalString({ pid: process.pid, started: Date.now(), nonce: 'held' }), { mode: 0o600 });
      setTimeout(() => abortController.abort(), 20);
      setTimeout(() => { try { unlinkSync(lock); } catch {} }, 80);
    }
    return committed;
  };
  try {
    const result = await abortKernel.advance(input('fence-abort', 'resume', { kind: 'RESUME' }, abortStart.snapshot));
    assert.equal(result.kind, 'BLOCKED');
    assert.equal(abortCalls, 0);
    const state = await loadState(abortRoot);
    assert.equal(commandFrom(state).state, 'UNKNOWN');
    assert.equal(state.journal.filter((entry) => entry.identity.eventId.startsWith('dispatcher-unknown:')).length, 1);
  } finally { FileArtifactStore.prototype.commit = originalCommit; }
});

test('massive-win synchronous receipt survives cancellation during successful unlock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-sync-receipt-unlock-'));
  const controller = new AbortController();
  const originalRelease = FileArtifactStore.prototype.releaseFence;
  let abortOnRelease = false;
  let calls = 0;
  FileArtifactStore.prototype.releaseFence = async function (...args) {
    if (abortOnRelease) {
      abortOnRelease = false;
      controller.abort();
      await wait(10);
    }
    return originalRelease.apply(this, args);
  };
  try {
    const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 5000, signal: controller.signal, driver: { dispatch(command, token) {
      calls += 1;
      abortOnRelease = true;
      return receipt(command, token, 'sync-before-unlock');
    } } });
    const started = await kernel.advance(startInput('sync-receipt-unlock'));
    const result = await kernel.advance(input('sync-receipt-unlock', 'resume', { kind: 'RESUME' }, started.snapshot));
    assert.equal(calls, 1);
    assert.equal(result.kind, 'WAITING');
    assert.equal(commandFrom(await loadState(root)).state, 'ACKED');
  } finally {
    FileArtifactStore.prototype.releaseFence = originalRelease;
  }
});

test('massive-win Promise returned during synchronous cancellation keeps its late receipt channel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-promise-cancelled-in-call-'));
  const controller = new AbortController();
  const pendingReceipt = deferred();
  let claimedCommand;
  let calls = 0;
  const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 5000, signal: controller.signal, driver: { dispatch(command) {
    calls += 1;
    claimedCommand = command;
    controller.abort();
    return pendingReceipt.promise;
  } } });
  const started = await kernel.advance(startInput('promise-cancelled-in-call'));
  await kernel.advance(input('promise-cancelled-in-call', 'resume', { kind: 'RESUME' }, started.snapshot));
  await waitFor(async () => commandFrom(await loadState(root)).state === 'UNKNOWN', 3000);
  assert.equal(calls, 1);
  pendingReceipt.resolve(receipt(claimedCommand, claimedCommand.launchToken, 'late-after-call-cancel'));
  await waitFor(async () => commandFrom(await loadState(root)).state === 'ACKED', 3000);
});

test('massive-win old rejection cannot mark or erase a successor lease task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-lease-aba-'));
  const firstResult = deferred();
  const secondResult = deferred();
  let calls = 0;
  const driver = { dispatch(command, token) { calls += 1; return calls === 1 ? firstResult.promise : secondResult.promise; } };
  const k1 = composeKernel({ plan, rootDir: root, timeoutMs: 10_000, driver });
  const start = await k1.advance(startInput('lease-aba'));
  await k1.advance(input('lease-aba', 'first-resume', { kind: 'RESUME' }, start.snapshot));
  const firstClaim = await loadState(root);
  const oldLease = commandFrom(firstClaim).leaseId;
  const k2 = composeKernel({ plan, rootDir: root, driver: { dispatch() { throw new Error('must not call'); } } });
  await k2.advance(input('lease-aba', 'recover-claimed', { kind: 'RESUME' }, firstClaim));
  const unknown = await loadState(root);
  await k2.advance(recoveryInput('lease-aba', 'never-launched', unknown));
  const pending = await loadState(root);
  await k1.advance(input('lease-aba', 'second-resume', { kind: 'RESUME' }, pending));
  const secondClaim = await loadState(root);
  const newLease = commandFrom(secondClaim).leaseId;
  assert.notEqual(newLease, oldLease);
  firstResult.reject(new Error('old rejection'));
  await wait(25);
  const stillClaimed = await loadState(root);
  assert.equal(commandFrom(stillClaimed).state, 'CLAIMED');
  assert.equal(commandFrom(stillClaimed).leaseId, newLease);
  const replay = await k1.advance(input('lease-aba', 'same-store-resume', { kind: 'RESUME' }, stillClaimed));
  assert.equal(replay.kind, 'WAITING');
  assert.equal(calls, 2);
  secondResult.resolve(receipt(commandFrom(secondClaim), commandFrom(secondClaim).launchToken, 'new'));
  await waitFor(async () => commandFrom(await loadState(root)).state === 'ACKED', 3000);
  assert.equal(commandFrom(await loadState(root)).state, 'ACKED');
});

test('massive-win delayed old launch cannot displace a successor lease task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-reverse-lease-aba-'));
  const pendingReceipt = deferred();
  let calls = 0;
  const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 10_000, driver: { dispatch() { calls += 1; return pendingReceipt.promise; } } });
  const started = await kernel.advance(startInput('reverse-lease-aba'));
  const reached = deferred();
  const release = deferred();
  const originalCommit = FileArtifactStore.prototype.commit;
  let paused = false;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const committed = await originalCommit.call(this, generation, state);
    if (!paused && Object.values(state.outbox ?? {}).some((command) => command.state === 'CLAIMED')) {
      paused = true;
      reached.resolve();
      await release.promise;
    }
    return committed;
  };
  let successorCommand;
  try {
    const delayed = kernel.advance(input('reverse-lease-aba', 'old-resume', { kind: 'RESUME' }, started.snapshot));
    await reached.promise;
    const firstClaim = await loadState(root);
    const oldLease = commandFrom(firstClaim).leaseId;
    await kernel.advance(input('reverse-lease-aba', 'recover-old', { kind: 'RESUME' }, firstClaim));
    const unknown = await loadState(root);
    await kernel.advance(recoveryInput('reverse-lease-aba', 'never-launched', unknown));
    const pending = await loadState(root);
    await kernel.advance(input('reverse-lease-aba', 'new-resume', { kind: 'RESUME' }, pending));
    const successor = await loadState(root);
    successorCommand = clone(commandFrom(successor));
    assert.notEqual(successorCommand.leaseId, oldLease);
    assert.equal(calls, 1);

    release.resolve();
    await delayed;
    const beforeCheck = await loadState(root);
    const repeated = await kernel.advance(input('reverse-lease-aba', 'same-kernel-resume', { kind: 'RESUME' }, beforeCheck));
    const afterCheck = await loadState(root);
    const observed = { kind: repeated.kind, state: commandFrom(afterCheck).state, calls };

    pendingReceipt.resolve(receipt(successorCommand, successorCommand.launchToken, 'successor'));
    await waitFor(async () => commandFrom(await loadState(root)).state === 'ACKED', 3000);
    assert.deepEqual(observed, { kind: 'WAITING', state: 'CLAIMED', calls: 1 });
  } finally {
    release.resolve();
    if (successorCommand) pendingReceipt.resolve(receipt(successorCommand, successorCommand.launchToken, 'successor-cleanup'));
    FileArtifactStore.prototype.commit = originalCommit;
  }
});

test('massive-win synchronous observe receipt finalizes the exact RESUME replay row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-sync-observe-replay-'));
  let attempts = 0;
  let dispatchedCommand;
  let observeCalls = 0;
  const driver = {
    dispatch(command) { attempts += 1; dispatchedCommand = command; throw new Error('host lost after launch'); },
    observe(launchToken) {
      observeCalls += 1;
      return receipt(dispatchedCommand, launchToken, 'sync-observed');
    },
  };
  const kernel = composeKernel({ plan, rootDir: root, driver, onYield: () => { throw new Error('notification must not gate replay'); } });
  const started = await kernel.advance(startInput('sync-observe-replay'));
  const unknown = await kernel.advance(input('sync-observe-replay', 'dispatch', { kind: 'RESUME' }, started.snapshot));
  assert.equal(unknown.kind, 'BLOCKED');
  const observation = input('sync-observe-replay', 'observe', { kind: 'RESUME' }, unknown.snapshot, unknown.launchToken);
  const first = await kernel.advance(observation);
  const state = await loadState(root);
  assert.equal(commandFrom(state).state, 'ACKED');
  assert.equal(attempts, 1);
  assert.equal(observeCalls, 1);
  const duplicate = await kernel.advance(observation);
  assert.deepEqual(duplicate, first);
  assert.equal(canonicalString(duplicate), canonicalString(first));
});

test('massive-win delayed old observer cannot suppress a successor lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-stale-observer-'));
  const staleObservation = deferred();
  // Keep a rejection handler attached even when the repaired path correctly
  // skips the stale observer before calling the driver.
  staleObservation.promise.catch(() => undefined);
  const successorReceipt = deferred();
  successorReceipt.promise.catch(() => undefined);
  let dispatchCalls = 0;
  let observeCalls = 0;
  let successorCommand;
  const driver = {
    dispatch(command, launchToken) {
      dispatchCalls += 1;
      if (dispatchCalls === 1) throw new Error('old launch lost after claim');
      successorCommand = clone(command);
      return successorReceipt.promise;
    },
    observe(launchToken) {
      observeCalls += 1;
      return staleObservation.promise;
    },
  };
  const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 10_000, driver });
  const started = await kernel.advance(startInput('stale-observer'));
  const unknown = await kernel.advance(input('stale-observer', 'old-dispatch', { kind: 'RESUME' }, started.snapshot));
  assert.equal(unknown.kind, 'BLOCKED');
  const oldCommand = clone(commandFrom(await loadState(root)));

  const loadReached = deferred();
  const releaseOldLoad = deferred();
  const successorReached = deferred();
  const releaseSuccessor = deferred();
  const originalLoad = FileArtifactStore.prototype.load;
  const originalCommit = FileArtifactStore.prototype.commit;
  let armOldLoad = false;
  let oldLoadPaused = false;
  let successorPaused = false;
  FileArtifactStore.prototype.load = async function (...args) {
    if (armOldLoad && !oldLoadPaused) {
      oldLoadPaused = true;
      loadReached.resolve();
      await releaseOldLoad.promise;
    }
    return originalLoad.apply(this, args);
  };
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const committed = await originalCommit.call(this, generation, state);
    const eventId = state.journal.at(-1)?.identity?.eventId;
    const command = Object.values(state.outbox ?? {})[0];
    if (eventId === 'observe-resume' && !armOldLoad) armOldLoad = true;
    if (eventId === 'successor-resume' && command?.state === 'CLAIMED' && !successorPaused) {
      successorPaused = true;
      successorReached.resolve();
      await releaseSuccessor.promise;
    }
    return committed;
  };
  try {
    const oldObservation = kernel.advance(input('stale-observer', 'observe-resume', { kind: 'RESUME' }, unknown.snapshot, oldCommand.launchToken));
    await loadReached.promise;
    // The outer observer is paused after its event commit and before loading
    // the snapshot that will bind its generation and command bytes.
    armOldLoad = false;
    const afterObservationEvent = await loadState(root);
    const recovery = { kind: 'OBSERVATION', category: 'RECOVERY', ref: ref(`never:${oldCommand.launchToken}`, { launchToken: oldCommand.launchToken, commandDigest: oldCommand.commandDigest, status: 'NEVER_LAUNCHED' }, 'outbox/recovery') };
    await kernel.advance(input('stale-observer', 'recover-old', recovery, afterObservationEvent, oldCommand.launchToken));
    const pending = await loadState(root);
    assert.equal(commandFrom(pending).state, 'PENDING');

    const successorAdvance = kernel.advance(input('stale-observer', 'successor-resume', { kind: 'RESUME' }, pending));
    await successorReached.promise;
    const successorClaim = await loadState(root);
    const successorLease = commandFrom(successorClaim).leaseId;
    assert.notEqual(successorLease, oldCommand.leaseId);

    releaseOldLoad.resolve();
    const staleYield = await oldObservation;
    assert.equal(staleYield.kind, 'BLOCKED');
    assert.equal(observeCalls, 0);

    releaseSuccessor.resolve();
    const successorYield = await successorAdvance;
    assert.equal(successorYield.kind, 'WAITING');
    assert.equal(dispatchCalls, 2);
    assert.ok(successorCommand);
    successorReceipt.resolve(receipt(successorCommand, successorCommand.launchToken, 'successor-observed'));
    await waitFor(async () => commandFrom(await loadState(root)).state === 'ACKED', 3000);
    assert.equal(commandFrom(await loadState(root)).state, 'ACKED');
  } finally {
    releaseOldLoad.resolve();
    releaseSuccessor.resolve();
    staleObservation.reject(new Error('stale observer cleanup'));
    if (successorCommand) successorReceipt.resolve(receipt(successorCommand, successorCommand.launchToken, 'successor-cleanup'));
    else successorReceipt.reject(new Error('successor dispatch was not entered'));
    FileArtifactStore.prototype.load = originalLoad;
    FileArtifactStore.prototype.commit = originalCommit;
  }
});

test('massive-win stale synchronous observer receipt cannot acknowledge a successor lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-stale-sync-observer-'));
  let dispatchCalls = 0;
  let observeCalls = 0;
  let oldCommand;
  const driver = {
    dispatch(command, launchToken) {
      dispatchCalls += 1;
      if (dispatchCalls === 1) throw new Error('old launch lost after claim');
      return receipt(command, launchToken, 'successor-dispatch');
    },
    observe(launchToken) {
      observeCalls += 1;
      return receipt(oldCommand, launchToken, 'stale-sync-observer');
    },
  };
  const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 10_000, driver });
  const started = await kernel.advance(startInput('stale-sync-observer'));
  const unknown = await kernel.advance(input('stale-sync-observer', 'old-dispatch', { kind: 'RESUME' }, started.snapshot));
  assert.equal(unknown.kind, 'BLOCKED');
  oldCommand = clone(commandFrom(await loadState(root)));

  const loadReached = deferred();
  const releaseOldLoad = deferred();
  const successorReached = deferred();
  const releaseSuccessor = deferred();
  const originalLoad = FileArtifactStore.prototype.load;
  const originalCommit = FileArtifactStore.prototype.commit;
  let armOldLoad = false;
  let oldLoadPaused = false;
  let successorPaused = false;
  FileArtifactStore.prototype.load = async function (...args) {
    const snapshot = await originalLoad.apply(this, args);
    if (armOldLoad && !oldLoadPaused) {
      oldLoadPaused = true;
      loadReached.resolve();
      await releaseOldLoad.promise;
    }
    return snapshot;
  };
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const committed = await originalCommit.call(this, generation, state);
    const eventId = state.journal.at(-1)?.identity?.eventId;
    const command = Object.values(state.outbox ?? {})[0];
    if (eventId === 'observe-resume' && !armOldLoad) armOldLoad = true;
    if (eventId === 'successor-resume' && command?.state === 'CLAIMED' && !successorPaused) {
      successorPaused = true;
      successorReached.resolve();
      await releaseSuccessor.promise;
    }
    return committed;
  };
  try {
    // Capture a pre-successor UNKNOWN snapshot, then hold its return while a
    // recovery and successor claim advance the durable lease.
    const oldObservation = kernel.advance(input('stale-sync-observer', 'observe-resume', { kind: 'RESUME' }, unknown.snapshot, oldCommand.launchToken));
    await loadReached.promise;
    armOldLoad = false;
    const afterObservationEvent = await loadState(root);
    const recovery = { kind: 'OBSERVATION', category: 'RECOVERY', ref: ref(`never:${oldCommand.launchToken}`, { launchToken: oldCommand.launchToken, commandDigest: oldCommand.commandDigest, status: 'NEVER_LAUNCHED' }, 'outbox/recovery') };
    await kernel.advance(input('stale-sync-observer', 'recover-old', recovery, afterObservationEvent, oldCommand.launchToken));
    const pending = await loadState(root);
    const successorAdvance = kernel.advance(input('stale-sync-observer', 'successor-resume', { kind: 'RESUME' }, pending));
    await successorReached.promise;
    const successorClaim = await loadState(root);
    assert.notEqual(commandFrom(successorClaim).leaseId, oldCommand.leaseId);

    // The stale synchronous observer may run before successor launch enters
    // the fence, but its old lease must not acknowledge the successor.
    releaseOldLoad.resolve();
    const staleYield = await oldObservation;
    assert.equal(staleYield.kind, 'BLOCKED');
    assert.equal(observeCalls, 1);
    assert.equal(dispatchCalls, 1);
    assert.equal(commandFrom(await loadState(root)).state, 'CLAIMED');

    releaseSuccessor.resolve();
    const successorYield = await successorAdvance;
    assert.equal(successorYield.kind, 'WAITING');
    assert.equal(dispatchCalls, 2);
    assert.equal(commandFrom(await loadState(root)).state, 'ACKED');
  } finally {
    releaseOldLoad.resolve();
    releaseSuccessor.resolve();
    FileArtifactStore.prototype.load = originalLoad;
    FileArtifactStore.prototype.commit = originalCommit;
  }
});

test('massive-win post-entry cancellation permits one late matching receipt without relaunch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-late-receipt-'));
  const controller = new AbortController();
  const pendingReceipt = deferred();
  let calls = 0;
  let claimedCommand;
  const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 30_000, signal: controller.signal, driver: { dispatch(command) { calls += 1; claimedCommand = command; return pendingReceipt.promise; } } });
  const started = await kernel.advance(startInput('late-receipt'));
  await kernel.advance(input('late-receipt', 'resume', { kind: 'RESUME' }, started.snapshot));
  await waitFor(() => claimedCommand !== undefined, 30_000);
  assert.equal(calls, 1);
  controller.abort();
  await waitFor(async () => commandFrom(await loadState(root)).state === 'UNKNOWN', 30_000);
  assert.equal(commandFrom(await loadState(root)).state, 'UNKNOWN');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  pendingReceipt.resolve(receipt(claimedCommand, claimedCommand.launchToken, 'late'));
  await waitFor(async () => commandFrom(await loadState(root)).state === 'ACKED', 30_000);
  assert.equal(commandFrom(await loadState(root)).state, 'ACKED');
  assert.equal(calls, 1);
});

test('massive-win stale cancelled launch preserves WAITING after a matching receipt wins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-stale-cancelled-receipt-'));
  const controller = new AbortController();
  let calls = 0;
  const originalCommit = FileArtifactStore.prototype.commit;
  const reached = deferred();
  const release = deferred();
  let paused = false;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const committed = await originalCommit.call(this, generation, state);
    if (!paused && Object.values(state.outbox ?? {}).some((command) => command.state === 'CLAIMED')) {
      paused = true;
      reached.resolve();
      await release.promise;
    }
    return committed;
  };
  try {
    const launcher = composeKernel({ plan, rootDir: root, signal: controller.signal, driver: { dispatch() { calls += 1; throw new Error('must not enter'); } } });
    const started = await launcher.advance(startInput('stale-cancelled-receipt'));
    const delayed = launcher.advance(input('stale-cancelled-receipt', 'resume', { kind: 'RESUME' }, started.snapshot));
    await reached.promise;
    const claimed = await loadState(root);
    const command = commandFrom(claimed);
    const proof = { launchToken: command.launchToken, commandDigest: command.commandDigest, receipt: ref('accepted', { accepted: true }) };
    const receiptEvent = { kind: 'DISPATCH_RECEIPT', ref: ref('matching-proof', proof, 'outbox') };
    const reconciler = composeKernel({ plan, rootDir: root });
    await reconciler.advance(input('stale-cancelled-receipt', 'matching-receipt', receiptEvent, claimed, command.launchToken));
    const acknowledged = await new FileArtifactStore(root).load();
    assert.equal(commandFrom(acknowledged.state).state, 'ACKED');

    controller.abort();
    release.resolve();
    const result = await delayed;
    const after = await new FileArtifactStore(root).load();
    assert.equal(calls, 0);
    assert.equal(result.kind, 'WAITING');
    assert.equal(commandFrom(after.state).state, 'ACKED');
    assert.equal(after.generation, acknowledged.generation);
  } finally {
    release.resolve();
    FileArtifactStore.prototype.commit = originalCommit;
  }
});

test('massive-win an old lease timeout cannot mark a successor lease UNKNOWN', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-old-timeout-'));
  const oldPending = deferred();
  const newPending = deferred();
  oldPending.promise.catch(() => undefined);
  newPending.promise.catch(() => undefined);
  const oldExternal = new AbortController();
  const newExternal = new AbortController();
  const clock = (() => {
    const dateNowDescriptor = Object.getOwnPropertyDescriptor(Date, 'now');
    const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout');
    const timers = new Map();
    const captured = [];
    let now = 1_700_000_000_000;
    let nextHandle = 1;
    Object.defineProperty(Date, 'now', { ...dateNowDescriptor, value: () => now });
    Object.defineProperty(globalThis, 'setTimeout', {
      ...setTimeoutDescriptor,
      value: (fn, ms, ...args) => {
        const handle = { timerId: nextHandle++ };
        const entry = { fn, args, due: now + Number(ms) };
        captured.push({ handle, ...entry });
        assert.equal(captured.length <= 2, true, 'unexpected timer');
        timers.set(handle, entry);
        return handle;
      },
    });
    Object.defineProperty(globalThis, 'clearTimeout', { ...clearTimeoutDescriptor, value: (handle) => { timers.delete(handle); } });
    return {
      timers,
      captured,
      get now() { return now; },
      advanceTo(value) { assert.equal(value >= now, true); now = value; },
      restore() {
        Object.defineProperty(Date, 'now', dateNowDescriptor);
        Object.defineProperty(globalThis, 'setTimeout', setTimeoutDescriptor);
        Object.defineProperty(globalThis, 'clearTimeout', clearTimeoutDescriptor);
      },
      descriptors: { dateNowDescriptor, setTimeoutDescriptor, clearTimeoutDescriptor },
    };
  })();
  let oldDispatchEntries = 0;
  let newDispatchEntries = 0;
  let oldSettlements = 0;
  let newSettlements = 0;
  let oldDispatchSignal;
  let newDispatchSignal;
  let oldCommand;
  let newCommand;
  const oldEntered = deferred();
  const newEntered = deferred();
  const oldSettled = deferred();
  const newSettled = deferred();
  const oldTaskDeleted = deferred();
  const successorAckCommitted = deferred();
  const oldDeadlineLoaded = deferred();
  const oldLateReceiptLoaded = deferred();
  let oldTimerFires = 0;
  let successorTimerFires = 0;
  let oldDeadlineLoads = 0;
  let oldDeadlineCommitAttempts = 0;
  let successorAckCommitAttempts = 0;
  let oldLateReceiptLoads = 0;
  let oldLateReceiptCommitAttempts = 0;
  let tracking = 'none';
  const originalLoadDescriptor = Object.getOwnPropertyDescriptor(FileArtifactStore.prototype, 'load');
  const originalCommitDescriptor = Object.getOwnPropertyDescriptor(FileArtifactStore.prototype, 'commit');
  const originalLoad = FileArtifactStore.prototype.load;
  const originalCommit = FileArtifactStore.prototype.commit;
  const mapDescriptors = [];
  const mapDelete = (kernel, counter, latch) => {
    const active = kernel.activeDispatches;
    const descriptor = Object.getOwnPropertyDescriptor(active, 'delete');
    mapDescriptors.push({ active, descriptor });
    Object.defineProperty(active, 'delete', {
      configurable: true,
      writable: true,
      value(key) {
        const existed = active.has(key);
        const result = Map.prototype.delete.call(active, key);
        if (existed) { counter.value += 1; latch.resolve(); }
        return result;
      },
    });
  };
  const oldDeletes = { value: 0 };
  const newDeletes = { value: 0 };
  let oldKernel;
  let successor;
  try {
    FileArtifactStore.prototype.load = async function (...args) {
      const result = await originalLoad.apply(this, args);
      const command = result.state ? commandFrom(result.state) : undefined;
      if (tracking === 'old-deadline') {
        oldDeadlineLoads += 1;
        oldDeadlineLoaded.resolve(result);
      } else if (tracking === 'old-late-receipt') {
        oldLateReceiptLoads += 1;
        oldLateReceiptLoaded.resolve(result);
      }
      void command;
      return result;
    };
    FileArtifactStore.prototype.commit = async function (generation, state) {
      const command = commandFrom(state);
      if (tracking === 'old-deadline' && command?.state === 'UNKNOWN' && command.leaseId === oldCommand?.leaseId) oldDeadlineCommitAttempts += 1;
      if (tracking === 'successor-ack' && command?.state === 'ACKED' && command.leaseId === newCommand?.leaseId) successorAckCommitAttempts += 1;
      if (tracking === 'old-late-receipt' && command?.state === 'ACKED') oldLateReceiptCommitAttempts += 1;
      const result = await originalCommit.call(this, generation, state);
      if (tracking === 'successor-ack' && command?.state === 'ACKED' && command.leaseId === newCommand?.leaseId) successorAckCommitted.resolve();
      return result;
    };
    oldKernel = composeKernel({
      plan,
      rootDir: root,
      timeoutMs: 500,
      signal: oldExternal.signal,
      driver: {
        dispatch(command, token, signal) {
          oldDispatchEntries += 1;
          oldCommand = clone(command);
          oldDispatchSignal = signal;
          oldEntered.resolve();
          return oldPending.promise.then((value) => { oldSettlements += 1; oldSettled.resolve(); return value; });
        },
      },
    });
    mapDelete(oldKernel, oldDeletes, oldTaskDeleted);
    const started = await oldKernel.advance(startInput('old-timeout'));
    const g1 = await new FileArtifactStore(root).load();
    assert.equal(g1.generation, 1);
    assert.equal(commandFrom(g1.state).state, 'PENDING');
    await oldKernel.advance(input('old-timeout', 'old-resume', { kind: 'RESUME' }, started.snapshot));
    await oldEntered.promise;
    const oldClaim = await new FileArtifactStore(root).load();
    assert.equal(oldClaim.generation, 2);
    assert.equal(commandFrom(oldClaim.state).state, 'CLAIMED');
    assert.equal(oldDispatchEntries, 1);
    const oldLease = commandFrom(oldClaim.state).leaseId;
    assert.equal(oldCommand.leaseId, oldLease);

    const reconciler = composeKernel({ plan, rootDir: root, driver: { dispatch() { throw new Error('must not call'); } } });
    await reconciler.advance(input('old-timeout', 'recover-claim', { kind: 'RESUME' }, oldClaim.state));
    const g3 = await new FileArtifactStore(root).load();
    assert.equal(g3.generation, 3);
    assert.equal(commandFrom(g3.state).state, 'UNKNOWN');
    assert.equal(commandFrom(g3.state).leaseId, oldLease);
    await reconciler.advance(recoveryInput('old-timeout', 'never-launched', g3.state));
    const g4 = await new FileArtifactStore(root).load();
    assert.equal(g4.generation, 4);
    assert.equal(commandFrom(g4.state).state, 'PENDING');

    successor = composeKernel({
      plan,
      rootDir: root,
      timeoutMs: 5000,
      signal: newExternal.signal,
      driver: {
        dispatch(command, token, signal) {
          newDispatchEntries += 1;
          newCommand = clone(command);
          newDispatchSignal = signal;
          newEntered.resolve();
          return newPending.promise.then((value) => { newSettlements += 1; newSettled.resolve(); return value; });
        },
      },
    });
    mapDelete(successor, newDeletes, newSettled);
    await successor.advance(input('old-timeout', 'new-resume', { kind: 'RESUME' }, g4.state));
    await newEntered.promise;
    const g5 = await new FileArtifactStore(root).load();
    assert.equal(g5.generation, 5);
    assert.equal(commandFrom(g5.state).state, 'CLAIMED');
    assert.notEqual(commandFrom(g5.state).leaseId, oldLease);
    newCommand = clone(commandFrom(g5.state));
    const newLease = newCommand.leaseId;
    assert.deepEqual({ oldDispatchEntries, newDispatchEntries }, { oldDispatchEntries: 1, newDispatchEntries: 1 });
    assert.equal(clock.captured.length, 2);
    const oldTimer = clock.captured.find(({ due }) => due === clock.captured[0].due && due === 1_700_000_000_500);
    const successorTimer = clock.captured.find(({ due }) => due === 1_700_000_005_000);
    assert.ok(oldTimer);
    assert.ok(successorTimer);
    assert.equal(oldTimer.due, 1_700_000_000_500);
    assert.equal(successorTimer.due, 1_700_000_005_000);

    const beforeOldDeadline = clone(g5);
    tracking = 'old-deadline';
    clock.advanceTo(1_700_000_000_500);
    assert.equal(clock.timers.delete(oldTimer.handle), true);
    oldTimerFires += 1;
    oldTimer.fn(...oldTimer.args);
    await oldDeadlineLoaded.promise;
    await Promise.resolve();
    tracking = 'none';
    assert.equal(oldDeadlineLoads, 1);
    assert.equal(oldDeadlineCommitAttempts, 0);
    const afterOldDeadline = await new FileArtifactStore(root).load();
    assert.deepEqual(afterOldDeadline, beforeOldDeadline);
    assert.equal(commandFrom(afterOldDeadline.state).leaseId, newLease);
    assert.equal(oldTimerFires, 1);
    assert.equal(successorTimerFires, 0);

    tracking = 'successor-ack';
    newPending.resolve(receipt(newCommand, newCommand.launchToken, 'successor-ack'));
    await successorAckCommitted.promise;
    await newSettled.promise;
    tracking = 'none';
    const g6 = await new FileArtifactStore(root).load();
    assert.equal(g6.generation, 6);
    assert.equal(commandFrom(g6.state).state, 'ACKED');
    assert.equal(commandFrom(g6.state).launchToken, newCommand.launchToken);
    assert.equal(commandFrom(g6.state).commandDigest, newCommand.commandDigest);
    assert.equal(successorAckCommitAttempts, 1);
    assert.equal(newSettlements, 1);

    tracking = 'old-late-receipt';
    oldPending.resolve(receipt(oldCommand, oldCommand.launchToken, 'old-late'));
    await oldLateReceiptLoaded.promise;
    await oldSettled.promise;
    await oldTaskDeleted.promise;
    tracking = 'none';
    const afterLate = await new FileArtifactStore(root).load();
    assert.deepEqual(afterLate, g6);
    assert.equal(oldLateReceiptLoads, 1);
    assert.equal(oldLateReceiptCommitAttempts, 0);
    assert.equal(oldSettlements, 1);
    assert.deepEqual({ oldDeletes: oldDeletes.value, newDeletes: newDeletes.value }, { oldDeletes: 1, newDeletes: 1 });
    assert.equal(oldDispatchSignal.aborted, true);
    assert.equal(newDispatchSignal.aborted, false);
    assert.equal(oldExternal.signal.aborted, false);
    assert.equal(newExternal.signal.aborted, false);
    assert.equal(getEventListeners(oldExternal.signal, 'abort').length, 0);
    assert.equal(getEventListeners(newExternal.signal, 'abort').length, 0);
    assert.equal(oldKernel.activeDispatches.size, 0);
    assert.equal(successor.activeDispatches.size, 0);
    assert.equal(clock.timers.size, 0);
    assert.equal(clock.captured.length, 2);
  } finally {
    tracking = 'none';
    oldPending.resolve(oldCommand ? receipt(oldCommand, oldCommand.launchToken, 'old-cleanup') : undefined);
    newPending.resolve(newCommand ? receipt(newCommand, newCommand.launchToken, 'new-cleanup') : undefined);
    for (const latch of [oldEntered, newEntered, oldSettled, newSettled, oldTaskDeleted, successorAckCommitted, oldDeadlineLoaded, oldLateReceiptLoaded]) latch.resolve();
    for (const { active, descriptor } of mapDescriptors) {
      if (descriptor) Object.defineProperty(active, 'delete', descriptor);
      else delete active.delete;
    }
    Object.defineProperty(FileArtifactStore.prototype, 'load', originalLoadDescriptor);
    Object.defineProperty(FileArtifactStore.prototype, 'commit', originalCommitDescriptor);
    clock.restore();
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(Object.getOwnPropertyDescriptor(Date, 'now'), clock.descriptors.dateNowDescriptor);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'setTimeout'), clock.descriptors.setTimeoutDescriptor);
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout'), clock.descriptors.clearTimeoutDescriptor);
    assert.deepEqual(Object.getOwnPropertyDescriptor(FileArtifactStore.prototype, 'load'), originalLoadDescriptor);
    assert.deepEqual(Object.getOwnPropertyDescriptor(FileArtifactStore.prototype, 'commit'), originalCommitDescriptor);
  }
});

test('massive-win forced immediate-replay CAS loss returns the exact durable winner row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-immediate-cas-'));
  const kernel = composeKernel({ plan, rootDir: root, driver: { dispatch(command, token) { return receipt(command, token); } } });
  const started = await kernel.advance(startInput('immediate-cas'));
  const resumeInput = input('immediate-cas', 'resume', { kind: 'RESUME' }, started.snapshot);
  const originalCommit = FileArtifactStore.prototype.commit;
  let ackCommits = 0;
  let injected = false;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    if (Object.values(state.outbox ?? {}).some((command) => command.state === 'ACKED')) {
      ackCommits += 1;
      if (ackCommits === 2) {
        const competingStore = new FileArtifactStore(root);
        const loaded = await competingStore.load();
        const winner = clone(loaded.state);
        // This is an unrelated generation publication: it deliberately keeps
        // the original processed WAITING row as the exact replay winner.
        winner.writerFence = `${winner.writerFence}-competing`;
        await originalCommit.call(competingStore, loaded.generation, winner);
        injected = true;
      }
    }
    return originalCommit.call(this, generation, state);
  };
  try {
    const result = await kernel.advance(resumeInput);
    assert.equal(injected, true);
    assert.equal(commandFrom(await loadState(root)).state, 'ACKED');
    const duplicate = await kernel.advance(resumeInput);
    assert.deepEqual(result, duplicate);
    assert.equal(result.snapshot.pendingDispatchCount, 1);
  } finally { FileArtifactStore.prototype.commit = originalCommit; }
});

test('massive-win construction snapshot ignores later dispatch mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-driver-snapshot-'));
  let originalCalls = 0;
  let replacementCalls = 0;
  let getterCalls = 0;
  const originalDispatch = (command, token) => { originalCalls += 1; return receipt(command, token); };
  const driver = {};
  Object.defineProperty(driver, 'dispatch', { configurable: true, get() { getterCalls += 1; return originalDispatch; } });
  const kernel = composeKernel({ plan, rootDir: root, driver });
  Object.defineProperty(driver, 'dispatch', { configurable: true, value: () => { replacementCalls += 1; throw new Error('mutated'); } });
  const started = await kernel.advance(startInput('driver-snapshot'));
  await kernel.advance(input('driver-snapshot', 'resume', { kind: 'RESUME' }, started.snapshot));
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
  assert.equal(getterCalls, 1);
  assert.equal(commandFrom(await loadState(root)).state, 'ACKED');
});

test('massive-win trust drift for root, root symlink, and writer-lock symlink fails before call', async () => {
  async function runMutation(kind) {
    const root = await mkdtemp(join(tmpdir(), `lunacy-massive-win-trust-${kind}-`));
    let calls = 0;
    const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 500, driver: { dispatch() { calls += 1; throw new Error('must not call'); } } });
    const started = await kernel.advance(startInput(`trust-${kind}`));
    const reached = deferred();
    const release = deferred();
    const originalCommit = FileArtifactStore.prototype.commit;
    let paused = false;
    FileArtifactStore.prototype.commit = async function (generation, state) {
      const committed = await originalCommit.call(this, generation, state);
      if (!paused && Object.values(state.outbox ?? {}).some((command) => command.state === 'CLAIMED')) { paused = true; reached.resolve(); await release.promise; }
      return committed;
    };
    try {
      const resume = kernel.advance(input(`trust-${kind}`, 'resume', { kind: 'RESUME' }, started.snapshot));
      await reached.promise;
      if (kind === 'lock') {
        const target = join(root, 'lock-target'); await writeFile(target, 'target');
        await symlink(target, join(root, '.kernel', '.writer.lock'));
      } else {
        const old = `${root}-old`; await rename(root, old);
        if (kind === 'root-symlink') await symlink(old, root);
        else await mkdtemp(`${root}-replacement-`).then(async (replacement) => rename(replacement, root));
      }
      release.resolve();
      await resume;
      assert.equal(calls, 0);
    } finally {
      release.resolve();
      FileArtifactStore.prototype.commit = originalCommit;
    }
  }
  for (const kind of ['root', 'root-symlink', 'lock']) await runMutation(kind);
});

test('massive-win held writer-lock identity drift after verified read fails before call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-held-lock-drift-'));
  const lock = join(root, '.kernel', '.writer.lock');
  const target = join(root, 'lock-target');
  const reached = deferred();
  const release = deferred();
  const originalCommit = FileArtifactStore.prototype.commit;
  const originalRead = FileArtifactStore.prototype.readVerifiedCurrent;
  let armed = false;
  let paused = false;
  let calls = 0;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const committed = await originalCommit.call(this, generation, state);
    if (Object.values(state.outbox ?? {}).some((command) => command.state === 'CLAIMED')) armed = true;
    return committed;
  };
  FileArtifactStore.prototype.readVerifiedCurrent = async function (...args) {
    const value = await originalRead.apply(this, args);
    if (armed && !paused) { paused = true; reached.resolve(); await release.promise; }
    return value;
  };
  try {
    const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 2000, driver: { dispatch() { calls += 1; throw new Error('must not enter'); } } });
    const started = await kernel.advance(startInput('held-lock-drift'));
    const delayed = kernel.advance(input('held-lock-drift', 'resume', { kind: 'RESUME' }, started.snapshot));
    await reached.promise;
    await writeFile(target, 'replacement');
    await unlink(lock);
    await symlink(target, lock);
    release.resolve();
    await delayed;
    assert.equal(calls, 0);
  } finally {
    release.resolve();
    FileArtifactStore.prototype.commit = originalCommit;
    FileArtifactStore.prototype.readVerifiedCurrent = originalRead;
    try { await unlink(lock); } catch {}
  }
});

test('massive-win release failure after entry is uncertain and never retried', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-release-failure-'));
  let calls = 0;
  const lock = join(root, '.kernel', '.writer.lock');
  const kernel = composeKernel({ plan, rootDir: root, timeoutMs: 1000, driver: { dispatch(command, token) {
    calls += 1;
    // Removing the owned pathname preserves the entered marker while making
    // release fail its inode proof.  Leaving the pathname absent makes the
    // subsequent lease-scoped UNKNOWN attempt deterministic.
    try { unlinkSync(lock); } catch {}
    return receipt(command, token, 'release-failed');
  } } });
  const started = await kernel.advance(startInput('release-failure'));
  const result = await kernel.advance(input('release-failure', 'resume', { kind: 'RESUME' }, started.snapshot));
  assert.equal(calls, 1);
  assert.equal(result.kind, 'BLOCKED');
  assert.equal(commandFrom(await loadState(root)).state, 'UNKNOWN');
});

test('massive-win direct and bridge no-driver behavior stays HumanReceiptRequired; lifecycle deletes only after quiescence', async () => {
  const direct = makeRunKernel({ plan });
  const directStart = await direct.advance(startInput('direct-no-driver'));
  const directResume = await direct.advance(input('direct-no-driver', 'resume', { kind: 'RESUME' }, directStart.snapshot));
  assert.equal(directResume.code, 'HumanReceiptRequired');

  const root = await mkdtemp(join(tmpdir(), 'lunacy-massive-win-bridge-'));
  const declaration = { phaseId: 'massive-win', steps: [{ stepId: 'a' }] };
  const bridgeOptions = { runDir: root, runId: 'bridge-no-driver', mode: 'runtime', plan: declaration };
  const bridgeStart = await transition(bridgeOptions, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(declaration) } }, eventId: 'start' });
  const bridgeResume = await transition(bridgeOptions, { event: { kind: 'RESUME' }, eventId: 'resume', expectedRevision: bridgeStart.yield.snapshot.revision });
  assert.equal(bridgeResume.yield.code, 'HumanReceiptRequired');
  await assert.rejects(() => disable(bridgeOptions), (error) => error instanceof BridgeError && error.code === 'ActiveWork');
  await assert.rejects(() => deleteBridge(bridgeOptions), (error) => error instanceof BridgeError && error.code === 'ActiveWork');

  const canonicalPlan = canonicalizeDeclaration(declaration);
  const composed = composeKernel({ plan: canonicalPlan, rootDir: root, driver: { dispatch(command, token) { return receipt(command, token, 'bridge-driver'); } } });
  let state = await loadState(root);
  const reached = deferred();
  const release = deferred();
  const originalCommit = FileArtifactStore.prototype.commit;
  let paused = false;
  FileArtifactStore.prototype.commit = async function (generation, candidate) {
    const committed = await originalCommit.call(this, generation, candidate);
    if (!paused && Object.values(candidate.outbox ?? {}).some((command) => command.state === 'CLAIMED')) { paused = true; reached.resolve(); await release.promise; }
    return committed;
  };
  let y;
  try {
    const launch = composed.advance(input('bridge-no-driver', 'composed-resume', { kind: 'RESUME' }, state));
    await reached.promise;
    await assert.rejects(() => disable(bridgeOptions), (error) => error instanceof BridgeError && error.code === 'ActiveWork');
    await assert.rejects(() => deleteBridge(bridgeOptions), (error) => error instanceof BridgeError && error.code === 'ActiveWork');
    release.resolve();
    y = await launch;
  } finally {
    release.resolve();
    FileArtifactStore.prototype.commit = originalCommit;
  }
  state = await loadState(root);
  const command = commandFrom(state);
  y = await composed.advance(input('bridge-no-driver', 'worker-done', { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) }, y.snapshot, command.launchToken));
  const gateToken = JSON.parse(y.artifacts[0].bytes).token;
  y = await composed.advance(input('bridge-no-driver', 'gate-pass', { kind: 'PARENT_DECISION', token: gateToken, value: 'PASS' }, y.snapshot));
  assert.equal(y.status, 'complete');
  const deleted = await deleteBridge(bridgeOptions);
  assert.equal(deleted.deleted, true);
});
