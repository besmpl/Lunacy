import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString } from '../dist/canonical.js';
import { drive } from '../dist/orchestration.js';
import { withManagedLaunchAdmission } from '../dist/release-admission.js';
import { FileArtifactStore, isFileArtifactStoreAbort } from '../dist/store.js';

async function initializeRun(root, runId) {
  await drive({
    runDir: root,
    runId,
    plan: { phaseId: 'r11e2', steps: [{ stepId: 'only' }] },
    driver: { dispatch() { throw new Error('must not launch'); } },
    maxTransitions: 1,
  });
}

async function assertBoundedContendedOwner(root, ownerBytes) {
  const kernel = join(root, '.kernel');
  const lock = join(kernel, '.writer.lock');
  const originalCreateExclusiveFence = FileArtifactStore.prototype.createExclusiveFence;
  const originalReclaimFence = FileArtifactStore.prototype.reclaimFence;
  const originalSetTimeout = globalThis.setTimeout;
  let polls = 0;
  try {
    await writeFile(lock, ownerBytes, { mode: 0o600 });
    FileArtifactStore.prototype.createExclusiveFence = async function (owner) {
      if (polls === 0) return originalCreateExclusiveFence.call(this, owner);
      return false;
    };
    FileArtifactStore.prototype.reclaimFence = async function () {
      const result = polls === 0 ? await originalReclaimFence.call(this) : 'CONTENDED';
      assert.equal(result, 'CONTENDED');
      polls += 1;
      return result;
    };
    globalThis.setTimeout = (callback, milliseconds, ...args) => originalSetTimeout(
      callback,
      milliseconds === 5 ? 0 : milliseconds,
      ...args,
    );
    await assert.rejects(() => new FileArtifactStore(root).load(), /concurrent commit fence timeout/);
    assert.equal(polls, 500);
    assert.equal(await readFile(lock, 'utf8'), ownerBytes);
    const entries = await readdir(kernel);
    assert.equal(entries.includes('.writer.lock.reclaim'), false);
    assert.deepEqual(entries.filter((name) => name.startsWith('.writer.lock.new-')), []);
  } finally {
    FileArtifactStore.prototype.createExclusiveFence = originalCreateExclusiveFence;
    FileArtifactStore.prototype.reclaimFence = originalReclaimFence;
    globalThis.setTimeout = originalSetTimeout;
    await unlink(lock).catch(() => undefined);
  }
}

test('managed launch claim may disappear between writer-lock trust probes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-writer-lock-race-'));
  const kernel = join(root, '.kernel');
  const lock = join(kernel, '.writer.lock');
  const originalAssertRegular = FileArtifactStore.prototype.assertRegular;
  let releaseLaunch;
  let admittedLaunch;
  try {
    await drive({
      runDir: root,
      runId: 'r11e2-writer-lock-race',
      plan: { phaseId: 'r11e2', steps: [{ stepId: 'only' }] },
      driver: { dispatch() { throw new Error('must not launch'); } },
      maxTransitions: 1,
    });

    let launchEntered;
    const entered = new Promise((resolve) => { launchEntered = resolve; });
    const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
    admittedLaunch = withManagedLaunchAdmission(root, undefined, async () => {
      launchEntered();
      await launchGate;
    });
    await entered;
    assert.equal((await stat(lock)).isFile(), true);

    let releasedBetweenProbes = false;
    FileArtifactStore.prototype.assertRegular = async function (path, label) {
      const result = await originalAssertRegular.call(this, path, label);
      if (path === lock && label === 'writer lock' && !releasedBetweenProbes) {
        releasedBetweenProbes = true;
        releaseLaunch();
        await admittedLaunch;
      }
      return result;
    };

    const loaded = await new FileArtifactStore(root).load();
    assert.ok(loaded.state);
    assert.equal(releasedBetweenProbes, true);
    const afterRace = await readdir(kernel);
    assert.equal(afterRace.includes('.writer.lock'), false);
    assert.equal(afterRace.includes('.writer.lock.reclaim'), false);
    assert.deepEqual(afterRace.filter((name) => name.startsWith('.writer.lock.new-')), []);

    FileArtifactStore.prototype.assertRegular = originalAssertRegular;
    await writeFile(lock, '{}', { mode: 0o600 });
    await chmod(lock, 0o666);
    await mkdir(`${lock}.reclaim`, { mode: 0o700 });
    await assert.rejects(
      () => new FileArtifactStore(root).load(),
      /ManifestMismatch: writer lock is group\/world-writable/,
    );
    assert.equal((await stat(lock)).mode & 0o777, 0o666);
    assert.equal(await readFile(lock, 'utf8'), '{}');
    const afterUnsafe = await readdir(kernel);
    assert.equal(afterUnsafe.includes('.writer.lock.reclaim'), true);
    assert.deepEqual(afterUnsafe.filter((name) => name.startsWith('.writer.lock.new-')), []);
    await rmdir(`${lock}.reclaim`);
  } finally {
    FileArtifactStore.prototype.assertRegular = originalAssertRegular;
    releaseLaunch?.();
    await admittedLaunch?.catch(() => undefined);
    await chmod(lock, 0o600).catch(() => undefined);
    await unlink(lock).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('live managed owner outlives the legacy poll cap and fake deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-writer-lock-wait-'));
  const kernel = join(root, '.kernel');
  const lock = join(kernel, '.writer.lock');
  const originalCreateExclusiveFence = FileArtifactStore.prototype.createExclusiveFence;
  const originalReclaimFence = FileArtifactStore.prototype.reclaimFence;
  const originalSetTimeout = globalThis.setTimeout;
  const originalDateNow = Date.now;
  let releaseLaunch;
  let admittedLaunch;
  try {
    await drive({
      runDir: root,
      runId: 'r11e2-writer-lock-wait',
      plan: { phaseId: 'r11e2', steps: [{ stepId: 'only' }] },
      driver: { dispatch() { throw new Error('must not launch'); } },
      maxTransitions: 1,
    });

    let launchEntered;
    const entered = new Promise((resolve) => { launchEntered = resolve; });
    const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
    admittedLaunch = withManagedLaunchAdmission(root, undefined, async () => {
      launchEntered();
      await launchGate;
    });
    await entered;
    assert.equal((await stat(lock)).isFile(), true);
    await mkdir(`${lock}.reclaim`, { mode: 0o700 });

    let polls = 0;
    let fakeNow = originalDateNow();
    Date.now = () => fakeNow;
    FileArtifactStore.prototype.createExclusiveFence = async function (owner) {
      if (polls > 0 && polls <= 500) return false;
      return originalCreateExclusiveFence.call(this, owner);
    };
    FileArtifactStore.prototype.reclaimFence = async function () {
      const result = polls === 0 ? await originalReclaimFence.call(this) : 'LIVE';
      assert.equal(result, 'LIVE');
      polls += 1;
      if (polls === 1) fakeNow += 1_000_000;
      if (polls === 501) {
        await rmdir(`${lock}.reclaim`);
        releaseLaunch();
        await admittedLaunch;
      }
      return result;
    };
    globalThis.setTimeout = (callback, milliseconds, ...args) => originalSetTimeout(
      callback,
      milliseconds === 5 ? 0 : milliseconds,
      ...args,
    );

    const loaded = await new FileArtifactStore(root).load();
    assert.ok(loaded.state);
    assert.equal(polls, 501);
    const afterWait = await readdir(kernel);
    assert.equal(afterWait.includes('.writer.lock'), false);
    assert.equal(afterWait.includes('.writer.lock.reclaim'), false);
    assert.deepEqual(afterWait.filter((name) => name.startsWith('.writer.lock.new-')), []);
  } finally {
    FileArtifactStore.prototype.createExclusiveFence = originalCreateExclusiveFence;
    FileArtifactStore.prototype.reclaimFence = originalReclaimFence;
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalDateNow;
    releaseLaunch?.();
    await admittedLaunch?.catch(() => undefined);
    await chmod(lock, 0o600).catch(() => undefined);
    await unlink(lock).catch(() => undefined);
    await rmdir(`${lock}.reclaim`).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('managed owner with mismatched current-process start is reclaimed as stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-writer-lock-managed-stale-'));
  const kernel = join(root, '.kernel');
  const lock = join(kernel, '.writer.lock');
  try {
    await initializeRun(root, 'r11e2-writer-lock-managed-stale');
    let ownerBytes;
    await withManagedLaunchAdmission(root, undefined, async () => { ownerBytes = await readFile(lock, 'utf8'); });
    const owner = JSON.parse(ownerBytes);
    owner.processStartedAt = `${owner.processStartedAt}-mismatch`;
    await writeFile(lock, canonicalString(owner), { mode: 0o600 });

    const loaded = await new FileArtifactStore(root).load();
    assert.ok(loaded.state);
    const entries = await readdir(kernel);
    assert.equal(entries.includes('.writer.lock'), false);
    assert.equal(entries.includes('.writer.lock.reclaim'), false);
    assert.deepEqual(entries.filter((name) => name.startsWith('.writer.lock.new-')), []);
  } finally {
    await unlink(lock).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid numeric owners never probe a pid and retain the bounded legacy wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-writer-lock-invalid-pid-'));
  const originalKill = process.kill;
  try {
    await initializeRun(root, 'r11e2-writer-lock-invalid-pid');
    const lock = join(root, '.kernel', '.writer.lock');
    let templateBytes;
    await withManagedLaunchAdmission(root, undefined, async () => { templateBytes = await readFile(lock, 'utf8'); });
    const template = JSON.parse(templateBytes);
    for (const pid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      let probed = false;
      process.kill = function (candidate, ...args) {
        if (candidate === pid) probed = true;
        return originalKill.call(this, candidate, ...args);
      };
      const ownerBytes = canonicalString({ ...template, pid });
      await assertBoundedContendedOwner(root, ownerBytes);
      assert.equal(probed, false, `invalid pid ${pid} was probed`);
      process.kill = originalKill;
    }
  } finally {
    process.kill = originalKill;
    await rm(root, { recursive: true, force: true });
  }
});

test('managed owner with unavailable process-start evidence is bounded and retained', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-writer-lock-unknown-start-'));
  const lock = join(root, '.kernel', '.writer.lock');
  const originalKill = process.kill;
  try {
    await initializeRun(root, 'r11e2-writer-lock-unknown-start');
    let templateBytes;
    await withManagedLaunchAdmission(root, undefined, async () => { templateBytes = await readFile(lock, 'utf8'); });
    const unknownPid = process.pid + 100_000;
    const ownerBytes = canonicalString({ ...JSON.parse(templateBytes), pid: unknownPid });
    let probes = 0;
    process.kill = function (candidate, ...args) {
      if (candidate === unknownPid) {
        probes += 1;
        const error = new Error('process start evidence unavailable');
        error.code = 'EACCES';
        throw error;
      }
      return originalKill.call(this, candidate, ...args);
    };
    await assertBoundedContendedOwner(root, ownerBytes);
    assert.equal(probes, 1);
  } finally {
    process.kill = originalKill;
    await unlink(lock).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('unrelated live legacy owner retains the bounded wait and exact lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-writer-lock-live-legacy-'));
  try {
    await initializeRun(root, 'r11e2-writer-lock-live-legacy');
    const ownerBytes = canonicalString({ nonce: 'unverified-live-owner', pid: process.pid, started: 0 });
    await assertBoundedContendedOwner(root, ownerBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale reclaimer cannot unlink a managed replacement admitted behind its marker', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-writer-lock-replacement-'));
  const kernel = join(root, '.kernel');
  const lock = join(kernel, '.writer.lock');
  const store = new FileArtifactStore(root);
  const originalClassifyFenceOwner = FileArtifactStore.prototype.classifyFenceOwner;
  const originalReclaimFence = FileArtifactStore.prototype.reclaimFence;
  let resumeClassification;
  let resumeLiveContention;
  let releaseManaged;
  let storeLoad;
  let admitted;
  try {
    await initializeRun(root, 'r11e2-writer-lock-replacement');
    let templateBytes;
    await withManagedLaunchAdmission(root, undefined, async () => { templateBytes = await readFile(lock, 'utf8'); });
    const staleOwner = JSON.parse(templateBytes);
    staleOwner.processStartedAt = `${staleOwner.processStartedAt}-stale`;
    const staleBytes = canonicalString(staleOwner);
    await writeFile(lock, staleBytes, { mode: 0o600 });

    let classifiedStale;
    const staleClassified = new Promise((resolve) => { classifiedStale = resolve; });
    const classificationGate = new Promise((resolve) => { resumeClassification = resolve; });
    let liveContentionPaused;
    const liveContention = new Promise((resolve) => { liveContentionPaused = resolve; });
    const liveContentionGate = new Promise((resolve) => { resumeLiveContention = resolve; });
    FileArtifactStore.prototype.classifyFenceOwner = async function () {
      const result = await originalClassifyFenceOwner.call(this);
      if (this === store && result === 'STALE') {
        classifiedStale();
        await classificationGate;
      }
      return result;
    };
    let pausedAfterLiveReclaim = false;
    FileArtifactStore.prototype.reclaimFence = async function () {
      const result = await originalReclaimFence.call(this);
      if (this === store && result === 'LIVE' && !pausedAfterLiveReclaim) {
        pausedAfterLiveReclaim = true;
        liveContentionPaused();
        await liveContentionGate;
      }
      return result;
    };
    storeLoad = store.load();
    await staleClassified;
    assert.equal((await stat(`${lock}.reclaim`)).isDirectory(), true);

    let managedEntered;
    const entered = new Promise((resolve) => { managedEntered = resolve; });
    const managedGate = new Promise((resolve) => { releaseManaged = resolve; });
    let operationEntered = false;
    admitted = withManagedLaunchAdmission(root, undefined, async () => {
      operationEntered = true;
      managedEntered();
      await managedGate;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(operationEntered, false);

    resumeClassification();
    await entered;
    await Promise.race([liveContention, storeLoad]);
    const replacementBytes = await readFile(lock, 'utf8');
    const replacementStat = await stat(lock);
    assert.notEqual(replacementBytes, staleBytes);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stillHeld = await stat(lock);
    assert.equal(stillHeld.dev, replacementStat.dev);
    assert.equal(stillHeld.ino, replacementStat.ino);
    assert.equal(await readFile(lock, 'utf8'), replacementBytes);
    const heldEntries = await readdir(kernel);
    assert.equal(heldEntries.includes('.writer.lock.reclaim'), false);

    resumeLiveContention();
    releaseManaged();
    await admitted;
    await storeLoad;
    const after = await readdir(kernel);
    assert.equal(after.includes('.writer.lock'), false);
    assert.equal(after.includes('.writer.lock.reclaim'), false);
    assert.deepEqual(after.filter((name) => name.startsWith('.writer.lock.new-')), []);
  } finally {
    FileArtifactStore.prototype.classifyFenceOwner = originalClassifyFenceOwner;
    FileArtifactStore.prototype.reclaimFence = originalReclaimFence;
    resumeClassification?.();
    resumeLiveContention?.();
    releaseManaged?.();
    await Promise.allSettled([storeLoad, admitted].filter(Boolean));
    await unlink(lock).catch(() => undefined);
    await rmdir(`${lock}.reclaim`).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellable load aborts before a live owner releases without touching its claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-writer-lock-abort-'));
  const kernel = join(root, '.kernel');
  const lock = join(kernel, '.writer.lock');
  const originalReclaimFence = FileArtifactStore.prototype.reclaimFence;
  let releaseLaunch;
  let admittedLaunch;
  try {
    await drive({
      runDir: root,
      runId: 'r11e2-writer-lock-abort',
      plan: { phaseId: 'r11e2', steps: [{ stepId: 'only' }] },
      driver: { dispatch() { throw new Error('must not launch'); } },
      maxTransitions: 1,
    });
    let launchEntered;
    const entered = new Promise((resolve) => { launchEntered = resolve; });
    const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
    admittedLaunch = withManagedLaunchAdmission(root, undefined, async () => {
      launchEntered();
      await launchGate;
    });
    await entered;
    const ownerBytes = await readFile(lock, 'utf8');
    const ownerStat = await stat(lock);

    let liveObserved;
    const waiting = new Promise((resolve) => { liveObserved = resolve; });
    FileArtifactStore.prototype.reclaimFence = async function () {
      const result = await originalReclaimFence.call(this);
      if (result === 'LIVE') liveObserved();
      return result;
    };
    const controller = new AbortController();
    const load = new FileArtifactStore(root).load(controller.signal);
    await waiting;
    controller.abort();
    await assert.rejects(load, (error) => isFileArtifactStoreAbort(error) && error.name === 'AbortError');

    const afterAbort = await stat(lock);
    assert.equal(afterAbort.dev, ownerStat.dev);
    assert.equal(afterAbort.ino, ownerStat.ino);
    assert.equal(await readFile(lock, 'utf8'), ownerBytes);
    const heldEntries = await readdir(kernel);
    assert.equal(heldEntries.includes('.writer.lock'), true);
    assert.equal(heldEntries.includes('.writer.lock.reclaim'), false);
    assert.deepEqual(heldEntries.filter((name) => name.startsWith('.writer.lock.new-')), []);

    releaseLaunch();
    await admittedLaunch;
    const afterRelease = await readdir(kernel);
    assert.equal(afterRelease.includes('.writer.lock'), false);
    assert.equal(afterRelease.includes('.writer.lock.reclaim'), false);
    assert.deepEqual(afterRelease.filter((name) => name.startsWith('.writer.lock.new-')), []);
  } finally {
    FileArtifactStore.prototype.reclaimFence = originalReclaimFence;
    releaseLaunch?.();
    await admittedLaunch?.catch(() => undefined);
    await chmod(lock, 0o600).catch(() => undefined);
    await unlink(lock).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('abort racing successful fence acquisition releases only the acquired fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-writer-lock-acquire-abort-'));
  const kernel = join(root, '.kernel');
  const originalCreateExclusiveFence = FileArtifactStore.prototype.createExclusiveFence;
  try {
    await drive({
      runDir: root,
      runId: 'r11e2-writer-lock-acquire-abort',
      plan: { phaseId: 'r11e2', steps: [{ stepId: 'only' }] },
      driver: { dispatch() { throw new Error('must not launch'); } },
      maxTransitions: 1,
    });
    const controller = new AbortController();
    let acquired = false;
    FileArtifactStore.prototype.createExclusiveFence = async function (owner) {
      const created = await originalCreateExclusiveFence.call(this, owner);
      if (created) {
        acquired = true;
        controller.abort();
      }
      return created;
    };
    await assert.rejects(
      () => new FileArtifactStore(root).load(controller.signal),
      (error) => isFileArtifactStoreAbort(error) && error.name === 'AbortError',
    );
    assert.equal(acquired, true);
    const after = await readdir(kernel);
    assert.equal(after.includes('.writer.lock'), false);
    assert.equal(after.includes('.writer.lock.reclaim'), false);
    assert.deepEqual(after.filter((name) => name.startsWith('.writer.lock.new-')), []);
  } finally {
    FileArtifactStore.prototype.createExclusiveFence = originalCreateExclusiveFence;
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelled process waiter cannot let a later load bypass its active predecessor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-writer-lock-fifo-'));
  const originalReadVerifiedCurrent = FileArtifactStore.prototype.readVerifiedCurrent;
  const originalAcquireFence = FileArtifactStore.prototype.acquireFence;
  let releaseFirst;
  let first;
  let third;
  try {
    await drive({
      runDir: root,
      runId: 'r11e2-writer-lock-fifo',
      plan: { phaseId: 'r11e2', steps: [{ stepId: 'only' }] },
      driver: { dispatch() { throw new Error('must not launch'); } },
      maxTransitions: 1,
    });
    const firstStore = new FileArtifactStore(root);
    const secondStore = new FileArtifactStore(root);
    const thirdStore = new FileArtifactStore(root);
    let firstEntered;
    const entered = new Promise((resolve) => { firstEntered = resolve; });
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    FileArtifactStore.prototype.readVerifiedCurrent = async function (...args) {
      if (this === firstStore) {
        firstEntered();
        await firstGate;
      }
      return originalReadVerifiedCurrent.apply(this, args);
    };
    let thirdBypassed = false;
    let firstReleased = false;
    FileArtifactStore.prototype.acquireFence = async function (...args) {
      if (this === thirdStore && !firstReleased) thirdBypassed = true;
      return originalAcquireFence.apply(this, args);
    };

    first = firstStore.load();
    await entered;
    const controller = new AbortController();
    let processWaitAttached;
    const waitAttached = new Promise((resolve) => { processWaitAttached = resolve; });
    const signal = {
      get aborted() { return controller.signal.aborted; },
      addEventListener(type, listener, options) {
        controller.signal.addEventListener(type, listener, options);
        if (type === 'abort') processWaitAttached();
      },
      removeEventListener(type, listener, options) { controller.signal.removeEventListener(type, listener, options); },
    };
    const second = secondStore.load(signal);
    await waitAttached;
    controller.abort();
    await assert.rejects(second, (error) => isFileArtifactStoreAbort(error));

    third = thirdStore.load();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(thirdBypassed, false);
    firstReleased = true;
    releaseFirst();
    await first;
    await third;
  } finally {
    FileArtifactStore.prototype.readVerifiedCurrent = originalReadVerifiedCurrent;
    FileArtifactStore.prototype.acquireFence = originalAcquireFence;
    releaseFirst?.();
    await Promise.allSettled([first, third].filter(Boolean));
    await rm(root, { recursive: true, force: true });
  }
});

test('drive cancellation returns before a gated managed dispatch releases its exact owner', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r11e2-drive-abort-'));
  const kernel = join(root, '.kernel');
  const lock = join(kernel, '.writer.lock');
  const controller = new AbortController();
  let releaseDispatch;
  let dispatchPromise;
  let operationSettled = false;
  try {
    let dispatchEntered;
    const entered = new Promise((resolve) => { dispatchEntered = resolve; });
    let outcomeObserved;
    const outcome = new Promise((resolve) => { outcomeObserved = resolve; });
    const dispatchGate = new Promise((resolve) => { releaseDispatch = resolve; });
    const driver = {
      dispatch(_command, _token, signal) {
        dispatchPromise = withManagedLaunchAdmission(root, signal, async () => {
          dispatchEntered();
          await dispatchGate;
          operationSettled = true;
          throw new Error('gated managed dispatch settled');
        });
        return dispatchPromise;
      },
    };
    const running = drive({
      runDir: root,
      runId: 'r11e2-drive-abort',
      plan: { phaseId: 'r11e2', steps: [{ stepId: 'only' }] },
      driver,
      signal: controller.signal,
      dispatcher: { onYield() { outcomeObserved(); } },
      maxTransitions: 4,
    });
    await entered;
    const ownerBytes = await readFile(lock, 'utf8');
    const ownerStat = await stat(lock);
    controller.abort();

    const result = await running;
    assert.equal(result.stopped, 'cancelled');
    assert.equal(operationSettled, false);
    const heldStat = await stat(lock);
    assert.equal(heldStat.dev, ownerStat.dev);
    assert.equal(heldStat.ino, ownerStat.ino);
    assert.equal(await readFile(lock, 'utf8'), ownerBytes);

    releaseDispatch();
    await assert.rejects(dispatchPromise, /gated managed dispatch settled/);
    await outcome;
    await new FileArtifactStore(root).load();
    const after = await readdir(kernel);
    assert.equal(after.includes('.writer.lock'), false);
    assert.equal(after.includes('.writer.lock.reclaim'), false);
    assert.deepEqual(after.filter((name) => name.startsWith('.writer.lock.new-')), []);
  } finally {
    releaseDispatch?.();
    await dispatchPromise?.catch(() => undefined);
    await chmod(lock, 0o600).catch(() => undefined);
    await unlink(lock).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
