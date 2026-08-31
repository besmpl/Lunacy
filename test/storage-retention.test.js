import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactStore } from '../dist/store.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { Conflict, makeRunKernel } from '../dist/index.js';

const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
const input = (runId, eventId, event, revision) => ({
  runId,
  expectedRevision: revision,
  identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId, payloadDigest: digest(event) },
  event,
});
const start = (runId = 'retention', eventId = 'start') => input(runId, eventId, { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, undefined);
const generations = async (root) => (await readdir(join(root, '.kernel', 'generations'))).sort();

async function makeTwoGenerations() {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-storage-retention-'));
  const kernel = makeRunKernel({ plan, rootDir: root });
  const first = await kernel.advance(start());
  const second = await kernel.advance(input('retention', 'resume-1', { kind: 'RESUME' }, first.snapshot.revision));
  return { root, kernel, first, second };
}

test('routine history retains only CURRENT and its exact predecessor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-storage-retention-bounded-'));
  const kernel = makeRunKernel({ plan, rootDir: root });
  let yieldValue = await kernel.advance(start());
  for (let index = 0; index < 5; index += 1) {
    yieldValue = await kernel.advance(input('retention', `resume-${index}`, { kind: 'RESUME' }, yieldValue.snapshot.revision));
  }
  const current = JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8'));
  assert.deepEqual(await generations(root), [`g${current.generation - 1}`, `g${current.generation}`]);
  assert.deepEqual(await readdir(join(root, '.kernel', 'quarantine')).catch(() => []), []);
});

test('malformed or missing CURRENT fails without moving canonical generations', async () => {
  for (const mode of ['malformed', 'missing']) {
    const { root, kernel } = await makeTwoGenerations();
    const currentPath = join(root, '.kernel', 'CURRENT');
    const before = await generations(root);
    if (mode === 'malformed') await writeFile(currentPath, '{}');
    else await unlink(currentPath);
    await assert.rejects(() => kernel.advance(input('retention', `broken-${mode}`, { kind: 'RESUME' }, 2)), /ManifestMismatch/);
    assert.deepEqual(await generations(root), before);
  }
});

test('unsafe exact predecessor fails before deletion or successor publication', async () => {
  const { root, kernel } = await makeTwoGenerations();
  const predecessor = join(root, '.kernel', 'generations', 'g1');
  const outside = await mkdtemp(join(tmpdir(), 'lunacy-storage-retention-outside-'));
  await rm(predecessor, { recursive: true, force: true });
  await symlink(outside, predecessor);
  await assert.rejects(() => kernel.advance(input('retention', 'unsafe', { kind: 'RESUME' }, 2)), /ManifestMismatch/);
  assert.ok((await readdir(join(root, '.kernel', 'generations'))).includes('g2'));
  assert.ok((await readdir(join(root, '.kernel', 'generations'))).includes('g1'));
  assert.ok(!(await readdir(join(root, '.kernel', 'generations'))).includes('g3'));
});

test('partial predecessor deletion is idempotent across restart', async () => {
  const { root } = await makeTwoGenerations();
  await unlink(join(root, '.kernel', 'generations', 'g1', 'state.json'));
  const restarted = new FileArtifactStore(root);
  const loaded = await restarted.load();
  assert.equal(loaded.generation, 2);
  await restarted.commit(loaded.generation, loaded.state);
  assert.deepEqual(await generations(root), ['g2', 'g3']);
});

test('load does not create absent reuse namespace and leaves legacy decoration inert', async () => {
  const { root } = await makeTwoGenerations();
  const reuse = join(root, '.kernel', 'reuse');
  assert.equal(await readdir(join(root, '.kernel')).then((entries) => entries.includes('reuse')), false);
  await new FileArtifactStore(root).load();
  assert.equal(await readdir(join(root, '.kernel')).then((entries) => entries.includes('reuse')), false);
  await mkdir(reuse);
  const decoration = join(reuse, 'legacy.json');
  await writeFile(decoration, 'legacy decoration bytes');
  const before = { entries: await readdir(reuse), bytes: await readFile(decoration) };
  await new FileArtifactStore(root).load();
  assert.deepEqual({ entries: await readdir(reuse), bytes: await readFile(decoration) }, before);
});

test('filesystem and memory stores preserve the same deterministic yields under retention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-storage-retention-parity-'));
  const fileKernel = makeRunKernel({ plan, rootDir: root });
  const memoryKernel = makeRunKernel({ plan });
  let fileYield = await fileKernel.advance(start('parity', 'start'));
  let memoryYield = await memoryKernel.advance(start('parity', 'start'));
  assert.equal(canonicalString(fileYield), canonicalString(memoryYield));
  fileYield = await fileKernel.advance(input('parity', 'resume', { kind: 'RESUME' }, fileYield.snapshot.revision));
  memoryYield = await memoryKernel.advance(input('parity', 'resume', { kind: 'RESUME' }, memoryYield.snapshot.revision));
  assert.equal(canonicalString(fileYield), canonicalString(memoryYield));
});

test('same-generation filesystem writers remain fenced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-storage-retention-concurrency-'));
  const first = makeRunKernel({ plan, rootDir: root });
  const second = makeRunKernel({ plan, rootDir: root });
  const results = await Promise.allSettled([first.advance(start('concurrent', 'one')), second.advance(start('concurrent', 'two'))]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason instanceof Conflict).length, 1);
});
