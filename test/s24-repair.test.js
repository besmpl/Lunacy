import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunKernel } from '../dist/index.js';
import { digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';

const plan = { phaseId: 's24', steps: [{ stepId: 'step' }] };

function input(runId, eventId, event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }) {
  return {
    runId,
    identity: { runId, phaseId: 's24', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId, payloadDigest: digest(event) },
    event,
  };
}

async function directoryBytes(path) {
  const names = (await readdir(path)).sort();
  return Promise.all(names.map(async (name) => ({ name, bytes: await readFile(join(path, name)) })));
}

test('S24 generation-state trust failure is fail-closed before reuse cache mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s24-generation-fence-'));
  const store = new FileArtifactStore(root);
  const quarantine = join(root, '.kernel', 'reuse', 'quarantine');
  const blobs = join(root, '.kernel', 'reuse', 'blobs');
  const pins = join(root, '.kernel', 'reuse', 'pins');
  let statePath;
  try {
    const first = await makeRunKernel({ plan, rootDir: root }).advance(input('s24-run', 'start'));
    const current = JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8'));
    const state = JSON.parse(await readFile(join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json'), 'utf8'));
    statePath = join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json');
    const bytes = 's24-generation-fence-bytes';
    const record = {
      key: digest('s24-generation-fence-key'),
      contentAddress: digest(bytes),
      bytes,
      runId: state.runId,
      generation: current.generation,
      authorityDigest: state.planDigest,
      authorityEpoch: state.authorityEpoch,
      cellDigest: null,
      snapshotDigest: null,
      reuseEpoch: null,
      writerFence: state.writerFence,
      schema: 'safe-fixed-base/v1',
    };
    await store.reuseStage(record);
    await mkdir(quarantine, { mode: 0o700, recursive: true });
    const before = {
      quarantine: await directoryBytes(quarantine),
      blobs: await directoryBytes(blobs),
      pins: await directoryBytes(pins),
    };

    await chmod(statePath, 0o666);
    await assert.rejects(
      () => store.reusePublish(record),
      /ManifestMismatch: reuse generation state is group\/world-writable/,
    );

    assert.deepEqual(await directoryBytes(quarantine), before.quarantine);
    assert.deepEqual(await directoryBytes(blobs), before.blobs);
    assert.deepEqual(await directoryBytes(pins), before.pins);
    assert.equal(first.snapshot.revision, 1);
  } finally {
    if (statePath) await chmod(statePath, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
