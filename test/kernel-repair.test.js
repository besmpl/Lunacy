import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { Conflict, KernelError, makeRunKernel } from '../dist/index.js';
import { FileArtifactStore } from '../dist/store.js';

const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
const commandToken = (runId = 'r', phaseId = 'p', stepId = 'a', attemptEpoch = 0) => `launch-${digest({ runId, phaseId, stepId, attemptEpoch }).slice(0, 32)}`;
function input(runId, eventId, event, cursor, launchToken) {
  const epochs = cursor ?? { revision: undefined, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 };
  return {
    runId,
    expectedRevision: epochs.revision,
    identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: epochs.attemptEpoch, authorityEpoch: epochs.authorityEpoch, barrierEpoch: epochs.barrierEpoch, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) },
    event,
  };
}
function jsonRef(id, value, scope = 'test') { return { id, scope, digest: digest(value), bytes: canonicalString(value) }; }
function startInput(runId = 'r', eventId = 'start') { return input(runId, eventId, { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, { revision: undefined, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 }); }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

 test('private composition driver receipt-to-completion reaches gate and finality', async () => {
  const seen = [];
  const driver = { dispatch(command, launchToken) { seen.push(command.commandId); return { launchToken, commandDigest: command.commandDigest, ref: jsonRef('driver-receipt', { accepted: true }) }; } };
  const kernel = composeKernel({ plan, driver });
  let y = await kernel.advance(startInput());
  y = await kernel.advance(input('r', 'resume', { kind: 'RESUME' }, y.snapshot));
  assert.deepEqual(seen.length, 1);
  assert.equal(y.kind, 'WAITING');
  assert.equal(y.snapshot.pendingDispatchCount, 0);
  const duplicate = await kernel.advance(input('r', 'resume', { kind: 'RESUME' }, y.snapshot));
  assert.deepEqual(duplicate, y);
  const token = commandToken();
  y = await kernel.advance(input('r', 'done', { kind: 'WORKER_ENVELOPE', ref: jsonRef('worker', { status: 'DONE' }) }, y.snapshot, token));
  assert.equal(y.kind, 'FINAL');
  assert.equal(y.status, 'phase-ready');
  const gateToken = JSON.parse(y.artifacts[0].bytes).token;
  y = await kernel.advance(input('r', 'pass', { kind: 'PARENT_DECISION', token: gateToken, value: 'PASS' }, y.snapshot));
  assert.deepEqual(y.kind, 'FINAL');
  assert.equal(y.status, 'complete');
});

test('UNKNOWN dispatch is never retried blindly and can recover by observation', async () => {
  let attempts = 0;
  const receipt = (command, launchToken) => ({ launchToken, commandDigest: command.commandDigest, ref: jsonRef('observed', { accepted: true }) });
  const driver = { dispatch(command, launchToken) { attempts += 1; throw new Error('host lost after launch'); }, observe(launchToken) { return attempts === 1 ? receipt({ commandDigest: digest({}) }, launchToken) : undefined; } };
  // The observation must echo the actual command digest, so capture it from dispatch.
  let commandDigest;
  driver.dispatch = (command, launchToken) => { attempts += 1; commandDigest = command.commandDigest; throw new Error('host lost after launch'); };
  driver.observe = (launchToken) => attempts === 1 ? { launchToken, commandDigest, ref: jsonRef('observed', { accepted: true }) } : undefined;
  const kernel = composeKernel({ plan, driver });
  let y = await kernel.advance(startInput());
  y = await kernel.advance(input('r', 'resume-1', { kind: 'RESUME' }, y.snapshot));
  assert.equal(y.kind, 'BLOCKED');
  assert.equal(y.code, 'UnknownDispatch');
  assert.equal(y.snapshot.unknownDispatchCount, 1);
  y = await kernel.advance(input('r', 'resume-2', { kind: 'RESUME' }, y.snapshot));
  assert.equal(y.kind, 'WAITING');
  assert.equal(y.snapshot.unknownDispatchCount, 0);
  assert.equal(y.snapshot.pendingDispatchCount, 0);
  assert.equal(attempts, 1);
});

test('truthful prose receipt exposes launch token and accepts one manual receipt', async () => {
  const kernel = makeRunKernel({ plan });
  let y = await kernel.advance(startInput());
  y = await kernel.advance(input('r', 'resume', { kind: 'RESUME' }, y.snapshot));
  assert.equal(y.kind, 'BLOCKED');
  assert.equal(y.code, 'HumanReceiptRequired');
  assert.ok(y.launchToken);
  const request = JSON.parse(y.receipt.bytes);
  assert.equal(request.launchToken, y.launchToken);
  const receipt = jsonRef('manual-receipt', { launchToken: y.launchToken, commandDigest: request.commandDigest });
  y = await kernel.advance(input('r', 'receipt', { kind: 'DISPATCH_RECEIPT', ref: receipt }, y.snapshot, y.launchToken));
  assert.equal(y.kind, 'WAITING');
  assert.equal(y.snapshot.pendingDispatchCount, 0);
});

test('delimiter-safe identity rejects conflicting reuse without splitting fields', async () => {
  const runId = 'r|tenant|1';
  const kernel = makeRunKernel({ plan });
  const first = startInput(runId, 'event|with|delimiter');
  await kernel.advance(first);
  const event = { kind: 'OBSERVATION', category: 'HOST', ref: jsonRef('host', { ok: true }) };
  await assert.rejects(() => kernel.advance(input(runId, 'event|with|delimiter', event, { revision: 1, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 })), Conflict);
});

test('deterministic bounded claims admit a stable batch', async () => {
  const batchPlan = { phaseId: 'p', steps: [{ stepId: 'b' }, { stepId: 'a' }, { stepId: 'c' }] };
  const kernel = makeRunKernel({ plan: batchPlan, maxInFlight: 2 });
  const e = { kind: 'START', intentRef: { id: 'plan', digest: digest(batchPlan) } };
  const y = await kernel.advance(input('batch', 'start', e, { revision: undefined, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 }));
  assert.equal(y.snapshot.activeCount, 2);
  assert.equal(y.snapshot.pendingDispatchCount, 2);
});

test('claims serialize conflicting resources while preserving deterministic batch order', async () => {
  const claimsPlan = { phaseId: 'p', steps: [
    { stepId: 'write', claims: [{ resource: 'shared', mode: 'WRITE' }] },
    { stepId: 'read', claims: [{ resource: 'shared', mode: 'READ' }] },
    { stepId: 'other', claims: [{ resource: 'other', mode: 'WRITE' }] },
  ] };
  const kernel = makeRunKernel({ plan: claimsPlan, maxInFlight: 2, admission: () => true });
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(claimsPlan) } };
  const y = await kernel.advance(input('claims', 'start', event, { revision: undefined, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 }));
  assert.equal(y.snapshot.activeCount, 2);
  assert.equal(y.snapshot.pendingDispatchCount, 2);
});

test('authority drift yields a decision without overwriting the committed plan digest', async () => {
  const mutablePlan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  const kernel = makeRunKernel({ plan: mutablePlan });
  const start = { kind: 'START', intentRef: { id: 'plan', digest: digest(mutablePlan) } };
  const first = await kernel.advance(input('authority', 'start', start, { revision: undefined, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 }));
  mutablePlan.steps[0].goal = 'changed parent declaration';
  const changed = await kernel.advance(input('authority', 'resume', { kind: 'RESUME' }, first.snapshot));
  assert.equal(changed.kind, 'DECISION_REQUIRED');
  assert.match(changed.brief.bytes, /expected/);
  const duplicate = await kernel.advance(input('authority', 'resume', { kind: 'RESUME' }, first.snapshot));
  assert.deepEqual(duplicate, changed);
});

test('CURRENT metadata and journal bytes are verified before state trust', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-repair-current-'));
  const kernel = makeRunKernel({ plan, rootDir });
  await kernel.advance(startInput());
  const currentPath = join(rootDir, '.kernel', 'CURRENT');
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  current.journalEnd += 1;
  await writeFile(currentPath, canonicalString(current));
  await assert.rejects(() => makeRunKernel({ plan, rootDir }).advance(startInput('r', 'again')), (error) => error instanceof KernelError && error.code === 'ManifestMismatch');

  const rootDir2 = await mkdtemp(join(tmpdir(), 'lunacy-repair-journal-'));
  await makeRunKernel({ plan, rootDir: rootDir2 }).advance(startInput());
  const c2 = JSON.parse(await readFile(join(rootDir2, '.kernel', 'CURRENT'), 'utf8'));
  const journalPath = join(rootDir2, '.kernel', 'generations', `g${c2.generation}`, 'journal.ndjson');
  await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}\n{"tampered":true}`);
  await assert.rejects(() => makeRunKernel({ plan, rootDir: rootDir2 }).advance(startInput('r', 'again')), /ManifestMismatch/);
});

test('crash debris is quarantined instead of becoming a trusted generation', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-repair-debris-'));
  const kernel = makeRunKernel({ plan, rootDir });
  await kernel.advance(startInput());
  const generations = join(rootDir, '.kernel', 'generations');
  await mkdir(join(generations, 'g999'));
  await writeFile(join(generations, '.g1000.tmp-crash'), 'debris');
  await writeFile(join(rootDir, '.kernel', '.CURRENT.tmp-crash'), '{}');
  await makeRunKernel({ plan, rootDir }).advance(input('r', 'resume', { kind: 'RESUME' }, { revision: 1, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 }));
  const quarantined = await readdir(join(rootDir, '.kernel', 'quarantine'));
  assert.ok(quarantined.some((name) => name.startsWith('g999')));
  assert.ok(quarantined.some((name) => name.startsWith('.g1000.tmp-crash')));
  assert.ok(quarantined.some((name) => name.startsWith('.CURRENT.tmp-crash')));
});

test('concurrent filesystem writers are fenced by generation CAS', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-repair-concurrent-'));
  const first = makeRunKernel({ plan, rootDir });
  const second = makeRunKernel({ plan, rootDir });
  const results = await Promise.allSettled([first.advance(startInput('r', 's1')), second.advance(startInput('r', 's2'))]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason instanceof Conflict).length, 1);
});

test('exact duplicate START CAS losers replay the one durable row without a second generation', { concurrency: false }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-repair-replay-start-'));
  const originalCommit = FileArtifactStore.prototype.commit;
  const reached = deferred();
  let startAttempts = 0;
  let commitAttempts = 0;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    commitAttempts += 1;
    const entry = state.journal.at(-1);
    if (state.revision === 1 && entry?.event.kind === 'START') {
      startAttempts += 1;
      if (startAttempts === 2) reached.resolve();
      await reached.promise;
    }
    return originalCommit.call(this, generation, state);
  };
  try {
    const first = makeRunKernel({ plan, rootDir });
    const second = makeRunKernel({ plan, rootDir });
    const results = await Promise.all([first.advance(startInput('replay-start', 'same')), second.advance(startInput('replay-start', 'same'))]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(startAttempts, 2);
    assert.equal(commitAttempts, 2);
    const loaded = await new FileArtifactStore(rootDir).load();
    assert.equal(loaded.generation, 1);
    assert.equal(loaded.state.revision, 1);
    assert.equal(loaded.state.journal.length, 1);
    assert.equal(Object.keys(loaded.state.processed).length, 1);
  } finally {
    reached.resolve();
    FileArtifactStore.prototype.commit = originalCommit;
  }
});

test('exact duplicate dispatching RESUME replays WAITING and only the claim winner launches', { concurrency: false }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-repair-replay-resume-'));
  const originalCommit = FileArtifactStore.prototype.commit;
  const reached = deferred();
  const receiptReady = deferred();
  const receiptObserved = deferred();
  let resumeAttempts = 0;
  let dispatchCalls = 0;
  let claimedCommand;
  const driver = {
    dispatch(command, launchToken) {
      dispatchCalls += 1;
      claimedCommand = command;
      return receiptReady.promise.then(() => ({ launchToken, commandDigest: command.commandDigest, ref: jsonRef('driver-receipt', { accepted: true }) }));
    },
  };
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const entry = state.journal.at(-1);
    if (state.outbox && state.revision === 3 && entry?.event.kind === 'RESUME' && Object.values(state.outbox).some((command) => command.state === 'CLAIMED')) {
      resumeAttempts += 1;
      if (resumeAttempts === 2) reached.resolve();
      await reached.promise;
    }
    return originalCommit.call(this, generation, state);
  };
  try {
    const observeYield = (value) => { if (value.kind === 'WAITING' && value.snapshot.pendingDispatchCount === 0) receiptObserved.resolve(value); };
    const first = composeKernel({ plan, rootDir, driver, onYield: observeYield });
    const second = composeKernel({ plan, rootDir, driver, onYield: observeYield });
    const started = await first.advance(startInput('replay-resume'));
    const results = await Promise.all([
      first.advance(input('replay-resume', 'resume', { kind: 'RESUME' }, started.snapshot)),
      second.advance(input('replay-resume', 'resume', { kind: 'RESUME' }, started.snapshot)),
    ]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].kind, 'WAITING');
    assert.equal(resumeAttempts, 2);
    assert.equal(dispatchCalls, 1);
    const loaded = await new FileArtifactStore(rootDir).load();
    assert.equal(loaded.generation, 2);
    assert.equal(loaded.state.revision, 3);
    assert.equal(loaded.state.journal.length, 3);
    assert.equal(Object.keys(loaded.state.processed).length, 2);
    assert.equal(Object.values(loaded.state.outbox)[0].state, 'CLAIMED');
    assert.equal(typeof Object.values(loaded.state.outbox)[0].leaseId, 'string');
    assert.ok(claimedCommand);
    receiptReady.resolve();
    await receiptObserved.promise;
  } finally {
    receiptReady.resolve();
    reached.resolve();
    FileArtifactStore.prototype.commit = originalCommit;
  }
});

test('same eventId with a conflicting identity remains Conflict and never replays winner bytes', { concurrency: false }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-repair-replay-conflict-'));
  const started = await makeRunKernel({ plan, rootDir }).advance(startInput('replay-conflict'));
  const originalCommit = FileArtifactStore.prototype.commit;
  const reached = deferred();
  let observationAttempts = 0;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const entry = state.journal.at(-1);
    if (state.revision === 2 && entry?.event.kind === 'OBSERVATION') {
      observationAttempts += 1;
      if (observationAttempts === 2) reached.resolve();
      await reached.promise;
    }
    return originalCommit.call(this, generation, state);
  };
  try {
    const observation = (value) => ({ kind: 'OBSERVATION', category: 'HOST', ref: jsonRef(`host-${value}`, { value }) });
    const first = makeRunKernel({ plan, rootDir });
    const second = makeRunKernel({ plan, rootDir });
    const results = await Promise.allSettled([
      first.advance(input('replay-conflict', 'same-event', observation(1), started.snapshot)),
      second.advance(input('replay-conflict', 'same-event', observation(2), started.snapshot)),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.ok(rejected.reason instanceof Conflict);
    assert.equal(observationAttempts, 2);
    const loaded = await new FileArtifactStore(rootDir).load();
    assert.equal(loaded.generation, 2);
    assert.equal(loaded.state.revision, 2);
    assert.equal(loaded.state.journal.length, 2);
    assert.equal(Object.keys(loaded.state.processed).length, 2);
  } finally {
    reached.resolve();
    FileArtifactStore.prototype.commit = originalCommit;
  }
});

test('durable publication followed by release failure replays without retrying the commit', { concurrency: false }, async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-repair-replay-release-'));
  const originalCommit = FileArtifactStore.prototype.commit;
  const originalRelease = FileArtifactStore.prototype.releaseFence;
  let targetCommit = false;
  let failedRelease = false;
  let commitAttempts = 0;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const target = state.revision === 1 && state.journal.at(-1)?.event.kind === 'START';
    if (target) { targetCommit = true; commitAttempts += 1; }
    try { return await originalCommit.call(this, generation, state); }
    finally { targetCommit = false; }
  };
  FileArtifactStore.prototype.releaseFence = async function (...args) {
    const result = await originalRelease.apply(this, args);
    if (targetCommit && !failedRelease) { failedRelease = true; throw new Error('simulated release failure'); }
    return result;
  };
  try {
    const result = await makeRunKernel({ plan, rootDir }).advance(startInput('replay-release'));
    assert.equal(result.kind, 'WAITING');
    assert.equal(failedRelease, true);
    assert.equal(commitAttempts, 1);
    const loaded = await new FileArtifactStore(rootDir).load();
    assert.equal(loaded.generation, 1);
    assert.equal(loaded.state.revision, 1);
    assert.equal(loaded.state.journal.length, 1);
    assert.equal(Object.keys(loaded.state.processed).length, 1);
  } finally {
    FileArtifactStore.prototype.commit = originalCommit;
    FileArtifactStore.prototype.releaseFence = originalRelease;
  }
});

test('replay misses preserve the original mapped commit error for no-row and recovery failures', { concurrency: false }, async () => {
  const noRowRoot = await mkdtemp(join(tmpdir(), 'lunacy-repair-replay-miss-'));
  const originalCommit = FileArtifactStore.prototype.commit;
  let noRowAttempts = 0;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    if (state.revision === 1 && state.journal.at(-1)?.event.kind === 'START') { noRowAttempts += 1; throw new Error('manifest revision conflict'); }
    return originalCommit.call(this, generation, state);
  };
  try {
    await assert.rejects(() => makeRunKernel({ plan, rootDir: noRowRoot }).advance(startInput('replay-no-row')), (error) => error instanceof Conflict && error.message === 'manifest revision conflict');
    assert.equal(noRowAttempts, 1);
  } finally { FileArtifactStore.prototype.commit = originalCommit; }

  const loadErrorRoot = await mkdtemp(join(tmpdir(), 'lunacy-repair-replay-load-error-'));
  const originalLoad = FileArtifactStore.prototype.load;
  let loadCalls = 0;
  FileArtifactStore.prototype.load = async function (...args) {
    loadCalls += 1;
    if (loadCalls === 2) throw new Error('recovery load failed');
    return originalLoad.apply(this, args);
  };
  FileArtifactStore.prototype.commit = async function (generation, state) {
    if (state.revision === 1 && state.journal.at(-1)?.event.kind === 'START') throw new Error('manifest revision conflict');
    return originalCommit.call(this, generation, state);
  };
  try {
    await assert.rejects(() => makeRunKernel({ plan, rootDir: loadErrorRoot }).advance(startInput('replay-load-error')), (error) => error instanceof Conflict && error.message === 'manifest revision conflict');
    assert.equal(loadCalls, 2);
  } finally {
    FileArtifactStore.prototype.load = originalLoad;
    FileArtifactStore.prototype.commit = originalCommit;
  }

  const parseErrorRoot = await mkdtemp(join(tmpdir(), 'lunacy-repair-replay-parse-error-'));
  const parseOriginalCommit = FileArtifactStore.prototype.commit;
  const parseOriginalRelease = FileArtifactStore.prototype.releaseFence;
  const parseOriginalLoad = FileArtifactStore.prototype.load;
  let parseTargetCommit = false;
  let parseFailedRelease = false;
  let parseLoadCalls = 0;
  FileArtifactStore.prototype.commit = async function (generation, state) {
    const target = state.revision === 1 && state.journal.at(-1)?.event.kind === 'START';
    if (target) parseTargetCommit = true;
    try { return await parseOriginalCommit.call(this, generation, state); }
    finally { parseTargetCommit = false; }
  };
  FileArtifactStore.prototype.releaseFence = async function (...args) {
    const result = await parseOriginalRelease.apply(this, args);
    if (parseTargetCommit && !parseFailedRelease) { parseFailedRelease = true; throw new Error('simulated release failure'); }
    return result;
  };
  FileArtifactStore.prototype.load = async function (...args) {
    parseLoadCalls += 1;
    const loaded = await parseOriginalLoad.apply(this, args);
    if (parseLoadCalls === 2 && loaded.state) {
      const corrupted = JSON.parse(JSON.stringify(loaded.state));
      const key = Object.keys(corrupted.processed)[0];
      corrupted.processed[key].yieldBytes = '{not-canonical';
      return { ...loaded, state: corrupted };
    }
    return loaded;
  };
  try {
    await assert.rejects(() => makeRunKernel({ plan, rootDir: parseErrorRoot }).advance(startInput('replay-parse-error')), (error) => error instanceof Conflict && error.message === 'simulated release failure');
    assert.equal(parseLoadCalls, 2);
  } finally {
    FileArtifactStore.prototype.commit = parseOriginalCommit;
    FileArtifactStore.prototype.releaseFence = parseOriginalRelease;
    FileArtifactStore.prototype.load = parseOriginalLoad;
  }
});
