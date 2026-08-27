import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunKernel } from '../dist/index.js';
import { BridgeError, transition } from '../dist/bridge.js';
import { digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';

const plan = { phaseId: 's22', steps: [{ stepId: 'step' }] };
const startEvent = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };

function input(eventId, event = startEvent, expectedRevision) {
  return {
    runId: 's22-lock',
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    identity: { runId: 's22-lock', phaseId: 's22', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId, payloadDigest: digest(event) },
    event,
  };
}

test('S22 writer-lock mode drift is rejected before stale-lock reclamation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s22-writer-lock-'));
  const lockPath = join(root, '.kernel', '.writer.lock');
  try {
    const first = await makeRunKernel({ plan, rootDir: root }).advance(input('start'));
    await writeFile(lockPath, '{}');
    await chmod(lockPath, 0o666);
    await assert.rejects(
      () => makeRunKernel({ plan, rootDir: root }).advance(input('resume', { kind: 'RESUME' }, first.snapshot.revision)),
      /ManifestMismatch: writer lock is group\/world-writable/,
    );
    assert.equal((await stat(lockPath)).mode & 0o777, 0o666);
    assert.equal(await readFile(lockPath, 'utf8'), '{}');
  } finally {
    await chmod(join(root, '.kernel'), 0o700).catch(() => undefined);
    await chmod(lockPath, 0o600).catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('S22 reuse-index mode drift is rejected before cache quarantine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s22-reuse-index-'));
  const indexPath = join(root, '.kernel', 'reuse', 'index.json');
  try {
    const first = await makeRunKernel({ plan, rootDir: root }).advance(input('start'));
    await mkdir(join(root, '.kernel', 'reuse', 'blobs'), { recursive: true });
    await mkdir(join(root, '.kernel', 'reuse', 'pins'));
    await mkdir(join(root, '.kernel', 'reuse', 'quarantine'));
    await writeFile(indexPath, '{}');
    await chmod(indexPath, 0o666);
    await assert.rejects(
      () => makeRunKernel({ plan, rootDir: root }).advance(input('resume', { kind: 'RESUME' }, first.snapshot.revision)),
      /ManifestMismatch: reuse index is group\/world-writable/,
    );
    assert.equal((await stat(indexPath)).mode & 0o777, 0o666);
    assert.deepEqual(await (await import('node:fs/promises')).readdir(join(root, '.kernel', 'reuse', 'quarantine')), []);
  } finally {
    await chmod(join(root, '.kernel', 'reuse'), 0o700).catch(() => undefined);
    await chmod(indexPath, 0o600).catch(() => undefined);
    await unlink(indexPath).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('S22 reuse-pin mode drift is rejected before cache quarantine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s22-reuse-pin-'));
  const pinsDir = join(root, '.kernel', 'reuse', 'pins');
  const pinPath = join(pinsDir, 'untrusted.pin');
  try {
    const first = await makeRunKernel({ plan, rootDir: root }).advance(input('start'));
    await mkdir(join(root, '.kernel', 'reuse', 'blobs'), { recursive: true });
    await mkdir(pinsDir);
    await mkdir(join(root, '.kernel', 'reuse', 'quarantine'));
    await writeFile(pinPath, '{}');
    await chmod(pinPath, 0o666);
    await assert.rejects(
      () => makeRunKernel({ plan, rootDir: root }).advance(input('resume', { kind: 'RESUME' }, first.snapshot.revision)),
      /ManifestMismatch: reuse pin is group\/world-writable/,
    );
    assert.equal((await stat(pinPath)).mode & 0o777, 0o666);
    assert.deepEqual(await (await import('node:fs/promises')).readdir(join(root, '.kernel', 'reuse', 'quarantine')), []);
  } finally {
    await chmod(pinsDir, 0o700).catch(() => undefined);
    await chmod(join(root, '.kernel', 'reuse'), 0o700).catch(() => undefined);
    await chmod(pinPath, 0o600).catch(() => undefined);
    await unlink(pinPath).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('S22 reuse-GC pin mode drift is rejected before cache quarantine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s22-reuse-gc-pin-'));
  const pinsDir = join(root, '.kernel', 'reuse', 'pins');
  const unsafePin = join(pinsDir, 'untrusted.pin');
  try {
    const first = await makeRunKernel({ plan, rootDir: root }).advance(input('start'));
    const current = JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8'));
    const state = JSON.parse(await readFile(join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json'), 'utf8'));
    const record = {
      key: digest('s22-gc-key'), contentAddress: digest('s22-gc-bytes'), bytes: 's22-gc-bytes',
      runId: state.runId, generation: current.generation, authorityDigest: state.planDigest,
      authorityEpoch: state.authorityEpoch, cellDigest: null, snapshotDigest: null, reuseEpoch: null,
      writerFence: state.writerFence, schema: 'safe-fixed-base/v1',
    };
    const store = new FileArtifactStore(root);
    await store.reuseStage(record);
    await writeFile(unsafePin, '{}');
    await chmod(unsafePin, 0o666);
    await assert.rejects(() => store.reusePublish(record), /ManifestMismatch: reuse pin is group\/world-writable/);
    assert.equal((await stat(unsafePin)).mode & 0o777, 0o666);
    assert.deepEqual(await (await import('node:fs/promises')).readdir(join(root, '.kernel', 'reuse', 'quarantine')), []);
    assert.equal(first.snapshot.revision, 1);
  } finally {
    await chmod(pinsDir, 0o700).catch(() => undefined);
    await chmod(join(root, '.kernel', 'reuse'), 0o700).catch(() => undefined);
    await chmod(unsafePin, 0o600).catch(() => undefined);
    await unlink(unsafePin).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function bridgeOptions(runDir) { return { runDir, runId: 's22-bridge-lock', mode: 'runtime', plan }; }

test('S22 bridge-lock mode drift is rejected before stale-lock reclamation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s22-bridge-lock-'));
  const options = bridgeOptions(root);
  const lockPath = join(root, '.kernel', '.bridge.lock');
  try {
    const first = await transition(options, { event: startEvent, eventId: 'start' });
    await writeFile(lockPath, '{}');
    await chmod(lockPath, 0o666);
    await assert.rejects(
      () => transition(options, { event: { kind: 'RESUME' }, eventId: 'resume', expectedRevision: first.yield.snapshot.revision }),
      (error) => error instanceof BridgeError && error.code === 'PathMismatch' && /bridge lock is group\/world-writable/.test(error.message),
    );
    assert.equal((await stat(lockPath)).mode & 0o777, 0o666);
    assert.equal(await readFile(lockPath, 'utf8'), '{}');
  } finally {
    await chmod(join(root, '.kernel'), 0o700).catch(() => undefined);
    await chmod(lockPath, 0o600).catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
