import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactStore, MemoryArtifactStore } from '../dist/store.js';
import { createInitialState } from '../dist/reducer.js';
import { canonicalString, digest } from '../dist/canonical.js';

const plan = { phaseId: 'p3-v2', steps: [{ stepId: 'step' }] };
function makeState(count) {
  const state = createInitialState('run-p3-v2', plan, digest(plan), 'writer-fence');
  state.journal = [];
  for (let i = 0; i < count; i += 1) {
    const event = { kind: 'OBSERVATION', category: 'HOST', ref: { id: `v2-${i}`, digest: digest({ i }), bytes: canonicalString({ i }) } };
    state.journal.push({ identity: { runId: state.runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: `event-${i}`, payloadDigest: digest(event) }, event, digest: digest(event), revision: i + 1 });
  }
  state.revision = count;
  return state;
}

test('segmented/v2 reconstructs a journal-free state and reuses its sealed prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-v2-'));
  try {
    const store = new FileArtifactStore(root, undefined, { format: 'segmented/v2', segmentEventCeiling: 2 });
    await store.commit(0, makeState(4));
    const first = JSON.parse(await readFile(join(root, '.kernel', 'generations', 'g1', 'head.json'), 'utf8'));
    const prefixPath = join(root, '.kernel', 'generations', 'g1', first.segments[0].name);
    const prefixIdentity = await stat(prefixPath);
    const rawState = JSON.parse(await readFile(join(root, '.kernel', 'generations', 'g1', 'state.json'), 'utf8'));
    assert.equal(Object.hasOwn(rawState, 'journal'), false);
    assert.equal(canonicalString((await store.load()).state), canonicalString(makeState(4)));
    await store.commit(1, makeState(5));
    const second = JSON.parse(await readFile(join(root, '.kernel', 'generations', 'g2', 'head.json'), 'utf8'));
    assert.equal(second.format, 'segmented/v2');
    assert.equal((await stat(join(root, '.kernel', 'generations', 'g2', second.segments[0].name))).ino, prefixIdentity.ino);
    assert.equal(canonicalString((await new FileArtifactStore(root).load()).state), canonicalString(makeState(5)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('segmented/v2 read-only inspection tolerates inert legacy decoration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-v2-readonly-decoration-'));
  try {
    const state = makeState(3);
    const store = new FileArtifactStore(root, undefined, { format: 'segmented/v2', segmentEventCeiling: 2 });
    await store.commit(0, state);
    await writeFile(join(root, '.kernel', 'BRIDGE.json'), canonicalString({ bridgeVersion: 'test', mode: 'runtime', planDigest: state.planDigest, rootPath: root, runId: state.runId, phaseId: state.phaseId, runtimeVersion: 'test', schema: 1, sourceDigest: digest('lunacy-runtime-skill-bridge/v1'), status: 'enabled' }));
    const decorationDir = join(root, '.kernel', 'reuse');
    await (await import('node:fs/promises')).mkdir(decorationDir, { recursive: true });
    const decorationPath = join(decorationDir, 'index.json');
    await writeFile(decorationPath, '{legacy-decoration}');
    const readonly = await new FileArtifactStore(root).loadReadOnly(state.runId);
    assert.equal(readonly.generation, 1); assert.equal(readonly.state.revision, state.revision); assert.equal(await readFile(decorationPath, 'utf8'), '{legacy-decoration}');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('segmented/v2 refuses a tampered sealed source before publishing CURRENT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-v2-link-tamper-'));
  try {
    const baseline = new FileArtifactStore(root, undefined, { format: 'segmented/v2', segmentEventCeiling: 2 });
    await baseline.commit(0, makeState(4));
    const head = JSON.parse(await readFile(join(root, '.kernel', 'generations', 'g1', 'head.json'), 'utf8'));
    const sourcePath = join(root, '.kernel', 'generations', 'g1', head.segments[0].name);
    let armed = true;
    const faulty = new FileArtifactStore(root, undefined, {
      format: 'segmented/v2', segmentEventCeiling: 2,
      faultInjector: (point) => {
        if (armed && point === 'hard-link') {
          armed = false;
          // Simulate an in-place source mutation in the hard-link window.
          writeFileSync(sourcePath, 'tampered\n');
        }
      },
    });
    await assert.rejects(() => faulty.commit(1, makeState(5)), /ManifestMismatch/);
    assert.equal(JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8')).generation, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('segmented/v1 refuses a tampered reused source before publishing CURRENT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-v1-link-tamper-'));
  try {
    const baseline = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 2 });
    await baseline.commit(0, makeState(4));
    const head = JSON.parse(await readFile(join(root, '.kernel', 'generations', 'g1', 'head.json'), 'utf8'));
    const sourcePath = join(root, '.kernel', 'generations', 'g1', head.segments[0].name);
    let armed = true;
    const faulty = new FileArtifactStore(root, undefined, {
      format: 'segmented', segmentEventCeiling: 2,
      faultInjector: (point) => {
        if (armed && point === 'hard-link') {
          armed = false;
          // Simulate an in-place source mutation in the hard-link window.
          writeFileSync(sourcePath, 'tampered-v1\n');
        }
      },
    });
    await assert.rejects(() => faulty.commit(1, makeState(5)), /ManifestMismatch/);
    assert.equal(JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8')).generation, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('segmented/v2 compaction rejects an extra journal field in historical projections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-v2-gc-projection-'));
  try {
    const store = new FileArtifactStore(root, undefined, { format: 'segmented/v2', segmentEventCeiling: 2 });
    await store.commit(0, makeState(2));
    await store.commit(1, makeState(3));
    const historicalPath = join(root, '.kernel', 'generations', 'g1', 'state.json');
    const projection = JSON.parse(await readFile(historicalPath, 'utf8'));
    projection.journal = [];
    await writeFile(historicalPath, canonicalString(projection));
    await assert.rejects(() => store.compact(), /ManifestMismatch/);
    assert.equal(JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8')).generation, 2);
    assert.equal((await stat(historicalPath)).isFile(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('segmented/v2 selection over v1 cannot prune the verified prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-v2-v1-prune-'));
  try {
    const store = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 2 });
    await store.commit(0, makeState(3));
    await store.selectFormat('segmented/v2');
    await assert.rejects(() => store.commit(1, makeState(2)), /prune canonical history/);
    assert.equal(JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8')).format, 'segmented/v1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('segmented/v2 rejects prefix tamper before exposing state and preserves Memory parity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-v2-tamper-'));
  try {
    const state = makeState(5);
    const memory = new MemoryArtifactStore({ format: 'segmented/v2', segmentEventCeiling: 2 });
    await memory.commit(0, state);
    const file = new FileArtifactStore(root, undefined, { format: 'segmented/v2', segmentEventCeiling: 2 });
    await file.commit(0, state);
    assert.deepEqual((await file.load()).state, (await memory.load()).state);
    const head = JSON.parse(await readFile(join(root, '.kernel', 'generations', 'g1', 'head.json'), 'utf8'));
    await writeFile(join(root, '.kernel', 'generations', 'g1', head.segments[0].name), 'tampered\n');
    await assert.rejects(() => new FileArtifactStore(root).load(), /ManifestMismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy migration to segmented/v2 and explicit rollback retain exact logical history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-v2-migration-'));
  try {
    const state = makeState(3);
    const store = new FileArtifactStore(root);
    await store.commit(0, state);
    await store.migrateToSegmentedV2();
    assert.equal(JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8')).format, 'segmented/v2');
    assert.equal(canonicalString((await store.load()).state), canonicalString(state));
    await store.rollbackSegmented();
    assert.equal(JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8')).format, undefined);
    assert.equal(canonicalString((await store.load()).state), canonicalString(state));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit v2 migration preference still migrates a legacy CURRENT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-v2-explicit-migration-'));
  try {
    const state = makeState(2);
    await new FileArtifactStore(root).commit(0, state);
    const explicit = new FileArtifactStore(root, undefined, { format: 'segmented/v2', segmentEventCeiling: 2 });
    await explicit.migrateToSegmentedV2();
    assert.equal(JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8')).format, 'segmented/v2');
    assert.equal(canonicalString((await explicit.load()).state), canonicalString(state));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('segmented/v2 migration retry rejects a foreign marker instead of deleting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p3-v2-marker-'));
  try {
    const store = new FileArtifactStore(root, undefined, { format: 'segmented/v2' });
    await store.commit(0, makeState(1));
    await writeFile(join(root, '.kernel', 'MIGRATION.json'), canonicalString({ from: 'foreign', priorGeneration: 1, schema: 1, to: 'segmented/v2' }));
    const retry = new FileArtifactStore(root);
    await assert.rejects(() => retry.migrateToSegmentedV2(), /ManifestMismatch/);
    assert.equal((await stat(join(root, '.kernel', 'MIGRATION.json'))).isFile(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('segmented/v2 publication faults converge to one complete old-or-new generation', async () => {
  for (const point of ['state-fsync', 'segment-fsync', 'head-fsync', 'seal-fsync', 'generation-rename', 'generation-published', 'CURRENT-fsync', 'CURRENT-rename', 'CURRENT-published']) {
    const root = await mkdtemp(join(tmpdir(), `lunacy-p3-v2-fault-${point}-`));
    try {
      const baseline = new FileArtifactStore(root, undefined, { format: 'segmented/v2', segmentEventCeiling: 2 });
      await baseline.commit(0, makeState(2));
      let armed = true;
      const faulty = new FileArtifactStore(root, undefined, { format: 'segmented/v2', segmentEventCeiling: 2, faultInjector: (observed) => { if (armed && observed === point) { armed = false; throw new Error(`fault:${point}`); } } });
      await assert.rejects(() => faulty.commit(1, makeState(3)), new RegExp(`fault:${point}`));
      const restart = new FileArtifactStore(root);
      const loaded = await restart.load();
      assert.ok(loaded.generation === 1 || loaded.generation === 2);
      if (loaded.generation === 1) await restart.commit(1, makeState(3));
      assert.equal((await restart.load()).state.journal.length, 3);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
