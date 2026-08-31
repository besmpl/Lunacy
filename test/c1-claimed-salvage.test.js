import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { selectCurrentTokenCommand } from '../dist/dispatch-coordinator.js';
import { FileArtifactStore } from '../dist/store.js';
import { JOURNAL_EVENT_CEILING } from '../dist/public.js';

const plan = { phaseId: 'c1', steps: [{ stepId: 'worker' }] };
const childPath = fileURLToPath(new URL('./fixtures/c1-claimed-crash-child.mjs', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonRef = (id, value, scope = 'c1') => ({ id, scope, digest: digest(value), bytes: canonicalString(value) });

function eventInput(runId, eventId, event, snapshot) {
  return {
    runId,
    expectedRevision: snapshot.revision,
    identity: {
      runId,
      phaseId: 'run',
      stepId: 'run',
      attemptEpoch: snapshot.attemptEpoch,
      authorityEpoch: snapshot.authorityEpoch,
      barrierEpoch: snapshot.barrierEpoch,
      eventId,
      payloadDigest: digest(event),
    },
    event,
  };
}

function snapshotOf(state) {
  return {
    revision: state.revision,
    authorityEpoch: state.authorityEpoch,
    attemptEpoch: state.attemptEpoch,
    barrierEpoch: state.barrierEpoch,
  };
}

async function crashClaimed(root, runId) {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [childPath, root, runId], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
  assert.equal(result.code, 0, result.stderr || `child signal ${result.signal}`);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.state, 'CLAIMED');
  const loaded = await new FileArtifactStore(root).load();
  const command = Object.values(loaded.state.outbox)[0];
  assert.equal(command.state, 'CLAIMED');
  const archiveBytes = await readFile(join(root, 'CLAIMED_AFTER_PASS.json'));
  const archive = JSON.parse(archiveBytes);
  assert.deepEqual(archive, {
    schema: 'C1.CLAIMED_AFTER_PASS/v1',
    launchToken: command.launchToken,
    commandDigest: command.commandDigest,
    status: 'PASS',
  });
  return { loaded, command, archiveBytes };
}

function recoveryDriver(root, mode = 'valid') {
  const counters = { dispatch: 0, observe: 0 };
  let resolveObservation;
  const driver = {
    dispatch() {
      counters.dispatch += 1;
      throw new Error('recovery must never redispatch');
    },
    observe(token, _signal, _anchor, retained) {
      counters.observe += 1;
      const archiveBytes = readFileSync(join(root, 'CLAIMED_AFTER_PASS.json'));
      const archive = JSON.parse(archiveBytes);
      if (mode === 'absent') return undefined;
      if (mode === 'invalid') {
        return {
          launchToken: token,
          commandDigest: retained.commandDigest,
          ref: { id: 'invalid', digest: '0'.repeat(64), bytes: '{}' },
        };
      }
      const value = { accepted: true, archiveSha256: sha256(archiveBytes) };
      const receipt = {
        launchToken: archive.launchToken,
        commandDigest: archive.commandDigest,
        ref: jsonRef('C1.CLAIMED_AFTER_PASS', value, 'outbox'),
      };
      if (mode === 'deferred') {
        return new Promise((resolve) => { resolveObservation = () => resolve(receipt); });
      }
      return receipt;
    },
  };
  return { driver, counters, resolveObservation: () => resolveObservation?.() };
}

async function recoverClaimed(root, runId, eventId = 'recover', mode = 'valid') {
  const before = await new FileArtifactStore(root).load();
  const controls = recoveryDriver(root, mode);
  const kernel = composeKernel({ plan, rootDir: root, driver: controls.driver, timeoutMs: 1_000 });
  const resume = eventInput(runId, eventId, { kind: 'RESUME' }, snapshotOf(before.state));
  const yielded = await kernel.advance(resume);
  return {
    ...controls,
    kernel,
    resume,
    yielded,
    before,
    after: await new FileArtifactStore(root).load(),
  };
}

async function freshRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// The immutable baseline returns UnknownDispatch here and requires a distinct
// manual RESUME. C1 must observe the exact retained lease before this call ends.
test('C1 recovered CLAIMED same-drive observation', async (t) => {
  const root = await freshRoot(t, 'lunacy-c1-red-');
  const runId = 'c1-red';
  const crashed = await crashClaimed(root, runId);
  const result = await recoverClaimed(root, runId);
  assert.equal(result.yielded.kind, 'WAITING');
  assert.equal(result.yielded.snapshot.pendingDispatchCount, 0);
  assert.equal(result.yielded.snapshot.unknownDispatchCount, 0);
  assert.deepEqual(result.counters, { dispatch: 0, observe: 1 });
  assert.equal(Object.values(result.after.state.outbox)[0].state, 'ACKED');
  const replay = await result.kernel.advance(result.resume);
  assert.equal(canonicalString(replay), canonicalString(result.yielded));
  assert.equal(sha256(crashed.archiveBytes), sha256(await readFile(join(root, 'CLAIMED_AFTER_PASS.json'))));
});

test('C1 deployment inventory', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('dist'));
  assert.equal(pkg.files.some((entry) => entry.startsWith('test')), false);
  assert.ok(await readFile(new URL('../dist/dispatch-coordinator.js', import.meta.url), 'utf8'));
});

test('C1 rollback reader smoke', async (t) => {
  const root = await freshRoot(t, 'lunacy-c1-rollback-');
  const runId = 'c1-rollback';
  await crashClaimed(root, runId);
  const result = await recoverClaimed(root, runId, 'unknownize', 'absent');
  assert.equal(result.yielded.code, 'UnknownDispatch');
  const state = result.after.state;
  const command = Object.values(state.outbox)[0];
  assert.equal(command.state, 'UNKNOWN');
  assert.equal(selectCurrentTokenCommand(state, ['UNKNOWN'], command)?.command.launchToken, command.launchToken);
});

test('C1 already UNKNOWN observes exactly once', async (t) => {
  const root = await freshRoot(t, 'lunacy-c1-unknown-');
  const runId = 'c1-unknown';
  await crashClaimed(root, runId);
  const first = await recoverClaimed(root, runId, 'unknownize', 'absent');
  assert.equal(first.yielded.code, 'UnknownDispatch');
  const second = await recoverClaimed(root, runId, 'observe-existing', 'valid');
  assert.equal(second.yielded.kind, 'WAITING');
  assert.deepEqual(second.counters, { dispatch: 0, observe: 1 });
});

test('C1 absent or invalid evidence is bounded', async (t) => {
  for (const mode of ['absent', 'invalid']) {
    const root = await freshRoot(t, `lunacy-c1-${mode}-`);
    const runId = `c1-${mode}`;
    await crashClaimed(root, runId);
    const result = await recoverClaimed(root, runId, `recover-${mode}`, mode);
    assert.equal(result.yielded.kind, 'BLOCKED');
    assert.equal(result.yielded.code, 'UnknownDispatch');
    assert.equal(result.yielded.snapshot.unknownDispatchCount, 1);
    assert.deepEqual(result.counters, { dispatch: 0, observe: 1 });
  }
});

test('C1 filesystem CLAIMED_AFTER_PASS converges with zero dispatch', async (t) => {
  const receipts = [];
  for (let i = 0; i < 2; i += 1) {
    const root = await freshRoot(t, `lunacy-c1-fs-${i}-`);
    const runId = 'c1-filesystem';
    const crashed = await crashClaimed(root, runId);
    const result = await recoverClaimed(root, runId, 'recover');
    assert.equal(result.yielded.kind, 'WAITING');
    assert.deepEqual(result.counters, { dispatch: 0, observe: 1 });
    receipts.push(canonicalString({
      yielded: result.yielded,
      counters: result.counters,
      archive: JSON.parse(crashed.archiveBytes),
    }));
  }
  assert.equal(receipts[0], receipts[1]);
});

test('C1 stale token race cannot settle successor', async (t) => {
  const root = await freshRoot(t, 'lunacy-c1-stale-');
  const runId = 'c1-stale';
  await crashClaimed(root, runId);
  const result = await recoverClaimed(root, runId, 'unknownize', 'absent');
  const state = result.after.state;
  const command = Object.values(state.outbox)[0];
  const successorLease = structuredClone(state);
  successorLease.outbox[command.commandId].leaseId = `${command.leaseId}:successor`;
  assert.equal(selectCurrentTokenCommand(successorLease, ['UNKNOWN'], command), undefined);
  const successorEpoch = structuredClone(state);
  successorEpoch.attemptEpoch += 1;
  assert.equal(selectCurrentTokenCommand(successorEpoch, ['UNKNOWN'], command), undefined);
});

test('C1 exact replay is byte-identical', async (t) => {
  const root = await freshRoot(t, 'lunacy-c1-replay-');
  const runId = 'c1-replay';
  await crashClaimed(root, runId);
  const result = await recoverClaimed(root, runId);
  const duplicate = await result.kernel.advance(result.resume);
  assert.equal(canonicalString(duplicate), canonicalString(result.yielded));
  assert.equal((await new FileArtifactStore(root).load()).generation, result.after.generation);
  assert.deepEqual(result.counters, { dispatch: 0, observe: 1 });
});

test('C1 maxInternalRecords reserves recovery rows', { concurrency: false }, async (t) => {
  const root = await freshRoot(t, 'lunacy-c1-capacity-');
  const runId = 'c1-capacity';
  await crashClaimed(root, runId);
  const originalLoad = FileArtifactStore.prototype.load;
  let inflated = false;
  let observeCalls = 0;
  FileArtifactStore.prototype.load = async function loadAtTwoSlots() {
    const loaded = await originalLoad.call(this);
    if (!inflated && Object.values(loaded.state?.outbox ?? {}).some((command) => command.state === 'CLAIMED')) {
      inflated = true;
      const state = structuredClone(loaded.state);
      state.journal = Array.from({ length: JOURNAL_EVENT_CEILING - 2 }, () => ({}));
      return { ...loaded, state };
    }
    return loaded;
  };
  try {
    const loaded = await originalLoad.call(new FileArtifactStore(root));
    const driver = {
      dispatch() { throw new Error('no dispatch'); },
      observe() { observeCalls += 1; return undefined; },
    };
    const kernel = composeKernel({ plan, rootDir: root, driver });
    const refused = await kernel.advance(eventInput(runId, 'two-slots', { kind: 'RESUME' }, snapshotOf(loaded.state)));
    assert.equal(refused.code, 'JournalCeiling');
    assert.equal(observeCalls, 0);
    assert.equal((await originalLoad.call(new FileArtifactStore(root))).generation, loaded.generation);
  } finally {
    FileArtifactStore.prototype.load = originalLoad;
  }
  const salvaged = await recoverClaimed(root, runId, 'three-plus-slots', 'valid');
  assert.equal(salvaged.yielded.kind, 'WAITING');
  assert.deepEqual(salvaged.counters, { dispatch: 0, observe: 1 });
});
