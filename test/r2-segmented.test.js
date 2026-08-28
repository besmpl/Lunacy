import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactStore, MemoryArtifactStore } from '../dist/store.js';
import { appendJournal, createInitialState, markUnboundedJournal } from '../dist/reducer.js';
import { canonicalString, digest } from '../dist/canonical.js';

const plan = { phaseId: 'r2', steps: [{ stepId: 'step' }] };
function stateWithEvents(count, unbounded = false) {
  const state = createInitialState('run-r2', plan, digest(plan), 'wf');
  if (unbounded) markUnboundedJournal(state);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const event = { kind: 'OBSERVATION', category: 'HOST', ref: { id: `r2-${i}`, digest: digest({ i }), bytes: canonicalString({ i }) } };
    entries.push({ identity: { runId: state.runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: `e-${i}`, payloadDigest: digest(event) }, event, digest: digest(event), revision: i + 1 });
  }
  state.journal = entries; state.revision = count;
  return state;
}

test('segmented file reader preserves a long logical prefix and active suffix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r2-'));
  try {
    const store = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 257 });
    const state = stateWithEvents(10_001, true);
    await store.commit(0, state);
    const loaded = await store.load();
    assert.equal(loaded.state.journal.length, 10_001);
    const head = JSON.parse(await readFile(join(root, '.kernel', 'generations', 'g1', 'head.json'), 'utf8'));
    assert.equal(head.format, 'segmented/v1');
    assert.ok(head.segments.length > 1);
    assert.ok(head.active.endRevision - head.active.startRevision + 1 <= 257);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('segmented transitions over 10,000 records match the deterministic semantic oracle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r2-oracle-'));
  try {
    const store = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 257 });
    const state = createInitialState('run-r2-oracle', plan, digest(plan), 'wf');
    const oracle = [];
    for (let i = 0; i < 10_001; i += 1) {
      const event = { kind: 'OBSERVATION', category: 'HOST', ref: { id: `oracle-${i}`, digest: digest({ i }), bytes: canonicalString({ i }) } };
      const identity = { runId: state.runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: `oracle-event-${i}`, payloadDigest: digest(event) };
      appendJournal(state, identity, event, true);
      oracle.push(state.journal.at(-1));
    }
    await store.commit(0, state);
    assert.deepEqual((await store.load()).state.journal, oracle);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('memory and file segmented stores expose identical logical history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r2-parity-'));
  try {
    const state = stateWithEvents(1_234, true);
    const memory = new MemoryArtifactStore({ format: 'segmented', segmentEventCeiling: 100 });
    await memory.commit(0, state);
    const file = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 100 });
    await file.commit(0, state);
    assert.deepEqual((await file.load()).state.journal, (await memory.load()).state.journal);
    assert.deepEqual((await file.load()).state, (await memory.load()).state);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration, rollback, and explicit compaction retain crash-safe generations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r2-migrate-'));
  try {
    const store = new FileArtifactStore(root);
    await store.commit(0, stateWithEvents(3));
    const segmentedGeneration = await store.migrateToSegmented();
    assert.equal((await store.load()).generation, segmentedGeneration);
    assert.equal(JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8')).format, 'segmented/v1');
    const legacyGeneration = await store.rollbackSegmented();
    assert.equal((await store.load()).generation, legacyGeneration);
    assert.equal(JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8')).format, undefined);
    const result = await store.compact();
    assert.ok(result.removed >= 1);
    const names = await readdir(join(root, '.kernel', 'generations'));
    assert.deepEqual(names.filter((name) => /^g\d+$/.test(name)), [`g${legacyGeneration}`]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown segmented version is rejected before state use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r2-malformed-'));
  try {
    const store = new FileArtifactStore(root, undefined, { format: 'segmented' });
    await store.commit(0, stateWithEvents(1, true));
    const currentPath = join(root, '.kernel', 'CURRENT');
    const current = JSON.parse(await readFile(currentPath, 'utf8')); current.format = 'segmented/v9';
    await writeFile(currentPath, canonicalString(current));
    await assert.rejects(() => new FileArtifactStore(root).load(), /ManifestMismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('segmented reader rejects mixed legacy files before state use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r2-mixed-'));
  try {
    const store = new FileArtifactStore(root, undefined, { format: 'segmented' });
    await store.commit(0, stateWithEvents(1));
    await writeFile(join(root, '.kernel', 'generations', 'g1', 'journal.ndjson'), 'legacy-mixed\n');
    await assert.rejects(() => new FileArtifactStore(root).load(), /ManifestMismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('P2-ORPHAN-GENERATION quarantines a renamed successor and permits retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r2-orphan-'));
  try {
    const first = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 2 });
    await first.commit(0, stateWithEvents(2));
    const successor = stateWithEvents(3);
    let armed = true;
    const interrupted = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 2, faultInjector: (point) => { if (armed && point === 'generation-rename') { armed = false; throw new Error('injected generation rename failure'); } } });
    await assert.rejects(() => interrupted.commit(1, successor), /injected generation rename failure/);
    const restarted = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 2 });
    assert.equal((await restarted.load()).generation, 1);
    assert.equal((await restarted.commit(1, successor)), 2);
    assert.equal((await restarted.load()).state.journal.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('P2-READONLY-SEGMENTED verifies head identity without a legacy journal path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r2-readonly-'));
  try {
    const store = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 2 });
    const state = stateWithEvents(3);
    await store.commit(0, state);
    await mkdir(join(root, '.kernel'), { recursive: true });
    await writeFile(join(root, '.kernel', 'BRIDGE.json'), canonicalString({
      schema: 1, bridgeVersion: 'test', runtimeVersion: 'test', mode: 'runtime', status: 'enabled',
      runId: state.runId, phaseId: state.phaseId, rootPath: root, planDigest: state.planDigest,
      sourceDigest: digest('lunacy-runtime-skill-bridge/v1'),
    }));
    const readOnly = await new FileArtifactStore(root).loadReadOnly(state.runId);
    assert.deepEqual(readOnly.state, (await store.load()).state);
    await assert.rejects(() => stat(join(root, '.kernel', 'generations', 'g1', 'journal.ndjson')), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('P2-CURRENT-CONTINUITY rejects independently tampered segmented fields without mutation or reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r2-current-continuity-'));
  try {
    const store = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 2 });
    const state = stateWithEvents(3);
    await store.commit(0, state);
    await writeFile(join(root, '.kernel', 'BRIDGE.json'), canonicalString({
      schema: 1, bridgeVersion: 'test', runtimeVersion: 'test', mode: 'runtime', status: 'enabled',
      runId: state.runId, phaseId: state.phaseId, rootPath: root, planDigest: state.planDigest,
      sourceDigest: digest('lunacy-runtime-skill-bridge/v1'),
    }));
    const currentPath = join(root, '.kernel', 'CURRENT');
    const generationDir = join(root, '.kernel', 'generations', 'g1');
    const originalBytes = await readFile(currentPath, 'utf8');
    const original = JSON.parse(originalBytes);
    const fields = ['writerFence', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch', 'modeEpoch', 'segmentCount'];
    for (const field of fields) {
      const mutated = { ...original, [field]: field === 'writerFence' ? 'tampered-writer-fence' : original[field] + 1 };
      const mutatedBytes = canonicalString(mutated);
      await writeFile(currentPath, mutatedBytes);
      const beforeGeneration = await readdir(generationDir);
      await assert.rejects(() => new FileArtifactStore(root).load(), /ManifestMismatch/);
      await assert.rejects(() => new FileArtifactStore(root).loadReadOnly(state.runId), /ManifestMismatch/);
      // A rejected manifest is observational only: CURRENT and the verified
      // generation remain byte-identical, and commit cannot consume the
      // tampered pointer as a predecessor.
      assert.equal(await readFile(currentPath, 'utf8'), mutatedBytes);
      assert.deepEqual(await readdir(generationDir), beforeGeneration);
      await assert.rejects(() => new FileArtifactStore(root, undefined, { format: 'segmented' }).commit(original.generation, state), /ManifestMismatch/);
      assert.equal(await readFile(currentPath, 'utf8'), mutatedBytes);
      assert.deepEqual(await readdir(generationDir), beforeGeneration);
      await writeFile(currentPath, originalBytes);
      assert.equal((await new FileArtifactStore(root).load()).generation, original.generation);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('P2-MARKER-LEGACY never lets an object-local marker lift legacy ceilings', async () => {
  const segmented = new MemoryArtifactStore({ format: 'segmented', segmentEventCeiling: 257 });
  const state = stateWithEvents(10_001, true);
  await segmented.commit(0, state);
  const loaded = (await segmented.load()).state;
  assert.ok(loaded);
  const legacy = new MemoryArtifactStore({ format: 'legacy' });
  await assert.rejects(() => legacy.commit(0, loaded), /JournalCeiling/);
});

test('P2-ROLLBACK-GC preserves marker-referenced history and is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r2-rollback-gc-'));
  try {
    const store = new FileArtifactStore(root);
    await store.commit(0, stateWithEvents(2));
    await store.migrateToSegmented();
    await store.commit(2, stateWithEvents(3));
    await writeFile(join(root, '.kernel', 'ROLLBACK.json'), canonicalString({ schema: 1, from: 'segmented/v1', to: 'legacy', priorGeneration: 2 }));
    const first = await store.compact();
    assert.ok(first.removed >= 1);
    await stat(join(root, '.kernel', 'generations', 'g2'));
    const second = await store.compact();
    assert.equal(second.removed, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('P2-FAULT-MATRIX leaves only old-or-new authority across publication boundaries', async () => {
  const points = ['segment-fsync', 'head-fsync', 'seal-fsync', 'generation-rename', 'generation-published', 'CURRENT-fsync', 'CURRENT-rename', 'CURRENT-published'];
  for (const point of points) {
    const root = await mkdtemp(join(tmpdir(), `lunacy-r2-fault-${point}-`));
    try {
      const baseline = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 2 });
      await baseline.commit(0, stateWithEvents(2));
      let armed = true;
      const faulty = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 2, faultInjector: (observed) => { if (armed && observed === point) { armed = false; throw new Error(`fault:${point}`); } } });
      const candidate = stateWithEvents(3);
      await assert.rejects(() => faulty.commit(1, candidate), new RegExp(`fault:${point}`));
      const restart = new FileArtifactStore(root, undefined, { format: 'segmented', segmentEventCeiling: 2 });
      const loaded = await restart.load();
      assert.ok(loaded.generation === 1 || loaded.generation === 2);
      if (loaded.generation === 1) await restart.commit(1, candidate);
      assert.equal((await restart.load()).state.journal.length, 3);
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  const migrationRoot = await mkdtemp(join(tmpdir(), 'lunacy-r2-fault-migration-'));
  try {
    const baseline = new FileArtifactStore(migrationRoot);
    await baseline.commit(0, stateWithEvents(1));
    const faulty = new FileArtifactStore(migrationRoot, undefined, { faultInjector: (point) => { if (point === 'migration-marker') throw new Error('fault:migration-marker'); } });
    await assert.rejects(() => faulty.migrateToSegmented(), /fault:migration-marker/);
    assert.equal((await new FileArtifactStore(migrationRoot).load()).generation, 1);
  } finally { await rm(migrationRoot, { recursive: true, force: true }); }

  const rollbackRoot = await mkdtemp(join(tmpdir(), 'lunacy-r2-fault-rollback-'));
  try {
    const baseline = new FileArtifactStore(rollbackRoot);
    await baseline.commit(0, stateWithEvents(1)); await baseline.migrateToSegmented();
    const faulty = new FileArtifactStore(rollbackRoot, undefined, { faultInjector: (point) => { if (point === 'rollback-marker') throw new Error('fault:rollback-marker'); } });
    await assert.rejects(() => faulty.rollbackSegmented(), /fault:rollback-marker/);
    assert.equal(JSON.parse(await readFile(join(rollbackRoot, '.kernel', 'CURRENT'), 'utf8')).format, 'segmented/v1');
  } finally { await rm(rollbackRoot, { recursive: true, force: true }); }

  const gcRoot = await mkdtemp(join(tmpdir(), 'lunacy-r2-fault-gc-'));
  try {
    const baseline = new FileArtifactStore(gcRoot);
    await baseline.commit(0, stateWithEvents(1)); await baseline.commit(1, stateWithEvents(2));
    let gcCalls = 0;
    const faulty = new FileArtifactStore(gcRoot, undefined, { faultInjector: (point) => { if (point === 'gc-unlink' && ++gcCalls === 2) throw new Error('fault:gc-unlink'); } });
    await assert.rejects(() => faulty.compact(), /fault:gc-unlink/);
    const restarted = new FileArtifactStore(gcRoot);
    await restarted.compact();
    await assert.rejects(() => stat(join(gcRoot, '.kernel', 'generations', 'g1')), /ENOENT/);
  } finally { await rm(gcRoot, { recursive: true, force: true }); }

  const raceRoot = await mkdtemp(join(tmpdir(), 'lunacy-r2-race-'));
  try {
    const baseline = new FileArtifactStore(raceRoot, undefined, { format: 'segmented', segmentEventCeiling: 2 });
    await baseline.commit(0, stateWithEvents(2));
    const candidate = stateWithEvents(3);
    const left = new FileArtifactStore(raceRoot, undefined, { format: 'segmented', segmentEventCeiling: 2 });
    const right = new FileArtifactStore(raceRoot, undefined, { format: 'segmented', segmentEventCeiling: 2 });
    const outcomes = await Promise.allSettled([left.commit(1, candidate), right.commit(1, candidate)]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
    assert.equal((await new FileArtifactStore(raceRoot).load()).state.journal.length, 3);
  } finally { await rm(raceRoot, { recursive: true, force: true }); }

  const hardLinkRoot = await mkdtemp(join(tmpdir(), 'lunacy-r2-hard-link-'));
  try {
    const baseline = new FileArtifactStore(hardLinkRoot, undefined, { format: 'segmented', segmentEventCeiling: 2 });
    await baseline.commit(0, stateWithEvents(2));
    let calls = 0;
    const fallback = new FileArtifactStore(hardLinkRoot, undefined, { format: 'segmented', segmentEventCeiling: 2, faultInjector: (point) => { if (point === 'hard-link') { calls += 1; throw new Error('fault:hard-link'); } } });
    await fallback.commit(1, stateWithEvents(3));
    assert.ok(calls > 0);
    assert.equal((await fallback.load()).state.journal.length, 3);
  } finally { await rm(hardLinkRoot, { recursive: true, force: true }); }
});
