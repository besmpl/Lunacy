import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunKernel } from '../dist/index.js';
import { BridgeError, transition } from '../dist/bridge.js';
import { digest } from '../dist/canonical.js';

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

test('S22 legacy decoration mode and bytes remain inert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s22-inert-decoration-'));
  const decorationPath = join(root, '.kernel', 'reuse', 'index.json');
  try {
    const first = await makeRunKernel({ plan, rootDir: root }).advance(input('start'));
    await mkdir(join(root, '.kernel', 'reuse'), { recursive: true }); await writeFile(decorationPath, '{legacy-decoration}'); await chmod(decorationPath, 0o666);
    await makeRunKernel({ plan, rootDir: root }).advance(input('resume', { kind: 'RESUME' }, first.snapshot.revision));
    assert.equal((await stat(decorationPath)).mode & 0o777, 0o666); assert.equal(await readFile(decorationPath, 'utf8'), '{legacy-decoration}');
  } finally { await chmod(decorationPath, 0o600).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
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
