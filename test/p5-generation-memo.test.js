import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { makeRunKernel } from '../dist/index.js';
import { FileArtifactStore } from '../dist/store.js';

const plan = { phaseId: 'p5-memo', steps: [{ stepId: 'only' }] };
const clone = (value) => JSON.parse(JSON.stringify(value));
const startInput = (runId) => {
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
  return {
    runId,
    identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'start', payloadDigest: digest(event) },
    event,
  };
};

async function seed(runId = 'memo-run') {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-p5-memo-'));
  await makeRunKernel({ plan, rootDir: root, maxInFlight: 0 }).advance(startInput(runId));
  return { root, store: new FileArtifactStore(root) };
}

function candidate(snapshot, tag = 'memo-candidate') {
  const state = clone(snapshot.state);
  state.writerFence = `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return state;
}

async function replaceFile(path) {
  const temporary = `${path}.replacement-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const mode = (await stat(path)).mode & 0o777;
  await copyFile(path, temporary);
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function replaceGenerationDirectory(path) {
  const temporary = `${path}.replacement-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const backup = `${path}.backup-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await cp(path, temporary, { recursive: true });
  await chmod(join(temporary, 'state.json'), 0o600);
  await chmod(join(temporary, 'journal.ndjson'), 0o600);
  await chmod(temporary, 0o700);
  await rename(path, backup);
  await rename(temporary, path);
  await rm(backup, { recursive: true, force: true });
}

async function replaceGenerationsNamespace(root, generation) {
  const original = join(root, '.kernel', 'generations');
  const temporary = `${original}.replacement-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const backup = `${original}.backup-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await mkdir(temporary, { mode: 0o700 });
  await cp(join(original, `g${generation}`), join(temporary, `g${generation}`), { recursive: true });
  await chmod(join(temporary, `g${generation}`, 'state.json'), 0o600);
  await chmod(join(temporary, `g${generation}`, 'journal.ndjson'), 0o600);
  await chmod(join(temporary, `g${generation}`), 0o700);
  await rename(original, backup);
  await rename(temporary, original);
  await rm(backup, { recursive: true, force: true });
}

async function withVerifierCounter(fn) {
  const original = FileArtifactStore.prototype.readVerifiedCurrent;
  const counts = new Map();
  FileArtifactStore.prototype.readVerifiedCurrent = async function (...args) {
    counts.set(this, (counts.get(this) ?? 0) + 1);
    return original.apply(this, args);
  };
  try { return await fn(counts); }
  finally { FileArtifactStore.prototype.readVerifiedCurrent = original; }
}

test('warm load→commit consumes one private memo and cold/new-store commit retains the full verifier', async () => {
  await withVerifierCounter(async (counts) => {
    const first = await seed('warm');
    try {
      const snapshot = await first.store.load();
      const committed = await first.store.commit(snapshot.generation, candidate(snapshot, 'warm'));
      assert.equal(committed, snapshot.generation + 1);
      assert.equal(counts.get(first.store), 1, 'warm path performs one full predecessor verification');

      const cold = new FileArtifactStore(first.root);
      const coldSnapshot = { generation: committed, state: candidate({ state: snapshot.state }, 'cold') };
      await cold.commit(coldSnapshot.generation, coldSnapshot.state);
      assert.equal(counts.get(cold), 1, 'new store remains cold');
    } finally { await rm(first.root, { recursive: true, force: true }); }
  });
});

test('generation-one and generation-two memo hits retain one-shot full-verifier counts', async () => {
  await withVerifierCounter(async (counts) => {
    const fixture = await seed('memo-retained-predecessor-hits');
    try {
      const generationOne = await fixture.store.load();
      assert.equal(generationOne.generation, 1);
      assert.equal(await fixture.store.commit(generationOne.generation, candidate(generationOne, 'memo-g1')), 2);
      assert.equal(counts.get(fixture.store), 1, 'generation-one memo hit avoids a second verifier');

      const generationTwo = await fixture.store.load();
      assert.equal(generationTwo.generation, 2);
      assert.equal(await fixture.store.commit(generationTwo.generation, candidate(generationTwo, 'memo-g2')), 3);
      assert.equal(counts.get(fixture.store), 2, 'generation-two memo hit avoids a third verifier');
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test('unsafe retained predecessor preserves the cold diagnostic and tree before publication', async () => {
  await withVerifierCounter(async (counts) => {
    const fixture = await seed('memo-retained-predecessor-unsafe');
    try {
      const generationOne = await fixture.store.load();
      assert.equal(await fixture.store.commit(generationOne.generation, candidate(generationOne, 'memo-predecessor-g2')), 2);
      const generationTwo = await fixture.store.load();
      const currentPath = join(fixture.root, '.kernel', 'CURRENT');
      const generationsPath = join(fixture.root, '.kernel', 'generations');
      const beforeCurrent = await readFile(currentPath, 'utf8');
      const beforeGenerations = await readdir(generationsPath);
      const predecessor = join(generationsPath, 'g1');
      await chmod(predecessor, 0o777);
      await assert.rejects(
        () => fixture.store.commit(generationTwo.generation, candidate(generationTwo, 'memo-predecessor-unsafe')),
        /ManifestMismatch: retained generation g1 is group\/world-writable/,
      );
      assert.equal(counts.get(fixture.store), 3, 'unsafe predecessor forces one unchanged cold verifier');
      assert.equal(await readFile(currentPath, 'utf8'), beforeCurrent, 'unsafe predecessor cannot publish CURRENT');
      assert.deepEqual(await readdir(generationsPath), beforeGenerations, 'unsafe predecessor cannot publish a generation');
      assert.equal((await stat(predecessor)).mode & 0o777, 0o777, 'cold rejection does not repair unsafe predecessor');
    } finally {
      await chmod(join(fixture.root, '.kernel', 'generations', 'g1'), 0o700).catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test('missing, wrong-type, and symlink retained predecessors cold-miss before publication', async () => {
  const variants = [
    ['missing', async (path) => rm(path, { recursive: true, force: true })],
    ['wrong-type', async (path) => { await rm(path, { recursive: true, force: true }); await writeFile(path, 'not-a-directory', { mode: 0o600 }); }],
    ['symlink', async (path) => { await rm(path, { recursive: true, force: true }); await symlink(join(path, '..', 'generations'), path); }],
  ];
  for (const [label, mutate] of variants) {
    await withVerifierCounter(async (counts) => {
      const fixture = await seed(`memo-retained-predecessor-${label}`);
      try {
        const generationOne = await fixture.store.load();
        assert.equal(await fixture.store.commit(generationOne.generation, candidate(generationOne, `memo-predecessor-${label}-g2`)), 2);
        const generationTwo = await fixture.store.load();
        const currentPath = join(fixture.root, '.kernel', 'CURRENT');
        const generationsPath = join(fixture.root, '.kernel', 'generations');
        const predecessor = join(generationsPath, 'g1');
        await mutate(predecessor);
        if (label === 'missing') {
          assert.equal(await fixture.store.commit(generationTwo.generation, candidate(generationTwo, `memo-predecessor-${label}`)), 3, 'missing predecessor follows the cold retirement no-op');
          assert.equal(JSON.parse(await readFile(currentPath, 'utf8')).generation, 3, 'missing predecessor still permits publication');
          assert.deepEqual((await readdir(generationsPath)).sort(), ['g2', 'g3'], 'missing predecessor remains absent after publication');
        } else {
          const beforeCurrent = await readFile(currentPath, 'utf8');
          const beforeGenerations = await readdir(generationsPath);
          await assert.rejects(() => fixture.store.commit(generationTwo.generation, candidate(generationTwo, `memo-predecessor-${label}`)), /ManifestMismatch: retained generation g1 is not a directory/);
          assert.equal(await readFile(currentPath, 'utf8'), beforeCurrent, `${label} predecessor cannot publish CURRENT`);
          assert.deepEqual(await readdir(generationsPath), beforeGenerations, `${label} predecessor cannot publish a generation`);
        }
        assert.equal(counts.get(fixture.store), 3, `${label} predecessor takes one cold verifier`);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test('unsafe quarantine is a memo miss and preserves the unchanged cold rejection', async () => {
  await withVerifierCounter(async (counts) => {
    const fixture = await seed('memo-quarantine-unsafe');
    try {
      const snapshot = await fixture.store.load();
      const currentPath = join(fixture.root, '.kernel', 'CURRENT');
      const generationsPath = join(fixture.root, '.kernel', 'generations');
      const beforeCurrent = await readFile(currentPath, 'utf8');
      const beforeGenerations = await readdir(generationsPath);
      await chmod(join(fixture.root, '.kernel', 'quarantine'), 0o777);
      await assert.rejects(() => fixture.store.commit(snapshot.generation, candidate(snapshot, 'quarantine-unsafe')), /ManifestMismatch: quarantine directory is group\/world-writable/);
      assert.equal(counts.get(fixture.store), 2, 'unsafe quarantine forces one unchanged cold verifier');
      assert.equal(await readFile(currentPath, 'utf8'), beforeCurrent, 'unsafe quarantine cannot publish CURRENT');
      assert.deepEqual(await readdir(generationsPath), beforeGenerations, 'unsafe quarantine cannot publish a generation');
      assert.equal((await stat(join(fixture.root, '.kernel', 'quarantine'))).mode & 0o777, 0o777, 'cold rejection does not repair unsafe quarantine');
    } finally {
      await chmod(join(fixture.root, '.kernel', 'quarantine'), 0o700).catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test('missing, wrong-type, and symlink quarantine variants cold-miss before publication', async () => {
  const variants = [
    ['missing', async (path) => rm(path, { recursive: true, force: true })],
    ['wrong-type', async (path) => { await rm(path, { recursive: true, force: true }); await writeFile(path, 'not-a-directory', { mode: 0o600 }); }],
    ['symlink', async (path) => { await rm(path, { recursive: true, force: true }); await symlink(join(path, '..', 'generations'), path); }],
  ];
  for (const [label, mutate] of variants) {
    await withVerifierCounter(async (counts) => {
      const fixture = await seed(`memo-quarantine-${label}`);
      try {
        const snapshot = await fixture.store.load();
        const currentPath = join(fixture.root, '.kernel', 'CURRENT');
        const generationsPath = join(fixture.root, '.kernel', 'generations');
        const beforeCurrent = await readFile(currentPath, 'utf8');
        const beforeGenerations = await readdir(generationsPath);
        const quarantine = join(fixture.root, '.kernel', 'quarantine');
        await mutate(quarantine);
        if (label === 'missing') {
          const committed = await fixture.store.commit(snapshot.generation, candidate(snapshot, `quarantine-${label}`));
          assert.equal(committed, snapshot.generation + 1, 'missing quarantine cold path recreates and publishes');
          assert.equal((await stat(quarantine)).mode & 0o777, 0o700, 'missing quarantine is recreated privately');
        } else {
          await assert.rejects(() => fixture.store.commit(snapshot.generation, candidate(snapshot, `quarantine-${label}`)), /ManifestMismatch/);
          assert.equal(await readFile(currentPath, 'utf8'), beforeCurrent, `${label} quarantine cannot publish CURRENT`);
          assert.deepEqual(await readdir(generationsPath), beforeGenerations, `${label} quarantine cannot publish a generation`);
        }
        assert.equal(counts.get(fixture.store), 2, `${label} quarantine variant takes one cold verifier`);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test('same-store queued commit/load serializes memo invalidation after commit consumption', async () => {
  await withVerifierCounter(async (counts) => {
    const fixture = await seed('memo-fence-order');
    try {
      const snapshot = await fixture.store.load();
      assert.equal(counts.get(fixture.store), 1, 'initial load performs one full predecessor verification');
      const events = [];
      let releaseProbe;
      const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
      let probeEnteredResolve;
      const probeEntered = new Promise((resolve) => { probeEnteredResolve = resolve; });
      const originalProbe = FileArtifactStore.prototype.probeVerifiedGenerationMemo;
      const originalCapture = FileArtifactStore.prototype.captureVerifiedGenerationMemo;
      FileArtifactStore.prototype.probeVerifiedGenerationMemo = async function (memo, ...args) {
        events.push(memo === undefined ? 'commit-cold-probe' : 'commit-memo-probe');
        probeEnteredResolve();
        await probeGate;
        return originalProbe.call(this, memo, ...args);
      };
      FileArtifactStore.prototype.captureVerifiedGenerationMemo = async function (...args) {
        events.push('load-capture');
        return originalCapture.apply(this, args);
      };
      try {
        const nextState = candidate(snapshot, 'fence-order');
        // Hold the commit after fence entry, then queue load behind its
        // occupied slot so the lifecycle ordering is deterministic.
        const commitPromise = fixture.store.commit(snapshot.generation, nextState);
        await probeEntered;
        const loadPromise = fixture.store.load();
        releaseProbe();
        const committed = await commitPromise;
        assert.equal(counts.get(fixture.store), 1, 'memo-consuming commit performs no extra full predecessor verification');
        const later = await loadPromise;
        assert.equal(committed, snapshot.generation + 1);
        assert.equal(later.generation, committed);
        assert.deepEqual(later.state, nextState, 'queued load returns the committed public snapshot');
        assert.deepEqual(events, ['commit-memo-probe', 'load-capture'], 'writer-fence order is commit probe then later-load capture');
        assert.equal(counts.get(fixture.store), 2, 'only the later load performs the second full predecessor verification');
      } finally {
        FileArtifactStore.prototype.probeVerifiedGenerationMemo = originalProbe;
        FileArtifactStore.prototype.captureVerifiedGenerationMemo = originalCapture;
      }
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test('capture failure falls back to the verified snapshot and the following commit is cold', async () => {
  await withVerifierCounter(async (counts) => {
    const fixture = await seed('memo-capture-failure');
    try {
      const expected = await fixture.store.load();
      const originalCapture = FileArtifactStore.prototype.captureVerifiedGenerationMemo;
      FileArtifactStore.prototype.captureVerifiedGenerationMemo = async function () {
        throw new Error('injected memo capture failure');
      };
      let fallback;
      try {
        fallback = await fixture.store.load();
      } finally {
        FileArtifactStore.prototype.captureVerifiedGenerationMemo = originalCapture;
      }

      assert.deepEqual(fallback, expected, 'capture failure preserves the verified public snapshot');
      assert.deepEqual(Object.keys(fallback).sort(), ['generation', 'state'], 'public snapshot keys remain exact');
      assert.equal(fixture.store.verifiedGenerationMemo, undefined, 'failed capture leaves no memo authority');

      const committed = await fixture.store.commit(fallback.generation, candidate(fallback, 'capture-fallback'));
      assert.equal(committed, fallback.generation + 1, 'following commit publishes normally');
      assert.equal(counts.get(fixture.store), 3, 'following commit performs the unchanged cold verifier');
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test('memo identity/stat mutations miss and reproduce the unchanged cold verifier', async () => {
  const scenarios = [
    ['CURRENT replacement', async (root, generation) => replaceFile(join(root, '.kernel', 'CURRENT'))],
    ['CURRENT malformed', async (root, generation) => writeFile(join(root, '.kernel', 'CURRENT'), '{}')],
    ['generations namespace replacement', async (root, generation) => replaceGenerationsNamespace(root, generation)],
    ['generation directory replacement', async (root, generation) => replaceGenerationDirectory(join(root, '.kernel', 'generations', `g${generation}`))],
    ['state replacement', async (root, generation) => replaceFile(join(root, '.kernel', 'generations', `g${generation}`, 'state.json'))],
    ['journal replacement', async (root, generation) => replaceFile(join(root, '.kernel', 'generations', `g${generation}`, 'journal.ndjson'))],
    ['state truncation', async (root, generation) => truncate(join(root, '.kernel', 'generations', `g${generation}`, 'state.json'), 1)],
    ['journal truncation', async (root, generation) => truncate(join(root, '.kernel', 'generations', `g${generation}`, 'journal.ndjson'), 1)],
    ['state deletion', async (root, generation) => rm(join(root, '.kernel', 'generations', `g${generation}`, 'state.json'))],
    ['journal deletion', async (root, generation) => rm(join(root, '.kernel', 'generations', `g${generation}`, 'journal.ndjson'))],
  ];
  for (const [label, mutate] of scenarios) {
    await withVerifierCounter(async (counts) => {
      const fixture = await seed(`mutation-${label}`);
      try {
        const snapshot = await fixture.store.load();
        await mutate(fixture.root, snapshot.generation);
        if (label.endsWith('truncation') || label.endsWith('deletion') || label.endsWith('malformed')) {
          await assert.rejects(() => fixture.store.commit(snapshot.generation, candidate(snapshot, label)), /ManifestMismatch/);
        } else {
          assert.equal(await fixture.store.commit(snapshot.generation, candidate(snapshot, label)), snapshot.generation + 1);
        }
        assert.equal(counts.get(fixture.store), 2, `${label} is a cold miss`);
      } finally { await rm(fixture.root, { recursive: true, force: true }); }
    });
  }
});

test('trusted staged CURRENT forces a cold verifier and is quarantined before publication', async () => {
  await withVerifierCounter(async (counts) => {
    const fixture = await seed('memo-staged-current');
    try {
      const snapshot = await fixture.store.load();
      const staged = join(fixture.root, '.kernel', '.CURRENT.tmp-injected');
      await writeFile(staged, '{}', { mode: 0o600 });
      await chmod(staged, 0o600);
      const committed = await fixture.store.commit(snapshot.generation, candidate(snapshot, 'staged-current'));
      assert.equal(committed, snapshot.generation + 1);
      assert.equal(counts.get(fixture.store), 2, 'staged CURRENT is a cold miss');
      await assert.rejects(() => stat(staged), { code: 'ENOENT' });
      const quarantine = await readdir(join(fixture.root, '.kernel', 'quarantine'));
      assert.ok(quarantine.some((name) => name.startsWith('.CURRENT.tmp-injected')), 'staged CURRENT is quarantined before commit returns');
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test('untrusted staged CURRENT remains visible and rejected on the cold fallback', async () => {
  await withVerifierCounter(async (counts) => {
    const fixture = await seed('memo-staged-current-untrusted');
    try {
      const snapshot = await fixture.store.load();
      const staged = join(fixture.root, '.kernel', '.CURRENT.tmp-untrusted');
      await writeFile(staged, '{}', { mode: 0o600 });
      await chmod(staged, 0o666);
      await assert.rejects(() => fixture.store.commit(snapshot.generation, candidate(snapshot, 'staged-current-untrusted')), /ManifestMismatch|group\/world-writable/);
      assert.equal(counts.get(fixture.store), 2, 'untrusted staged CURRENT is a cold miss');
      assert.deepEqual(await readdir(join(fixture.root, '.kernel')), ['.CURRENT.tmp-untrusted', 'CURRENT', 'generations', 'quarantine']);
    } finally { await chmod(fixture.root, 0o700).catch(() => undefined); await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test('deletion, malformed memo, and stale replay paths fail closed without retaining authority', async () => {
  await withVerifierCounter(async (counts) => {
    const fixture = await seed('memo-fail-closed');
    try {
      const snapshot = await fixture.store.load();
      const currentPath = join(fixture.root, '.kernel', 'CURRENT');
      await rm(currentPath);
      await assert.rejects(() => fixture.store.commit(snapshot.generation, candidate(snapshot, 'deleted-current')), /ManifestMismatch/);
      assert.equal(counts.get(fixture.store), 2);
      assert.equal(fixture.store.verifiedGenerationMemo, undefined, 'failed commit cannot retain memo authority');

      // A fresh fixture proves malformed private fields are a cold miss rather
      // than an authority source or a thrown probe error.
      const second = await seed('memo-corrupt');
      try {
        const loaded = await second.store.load();
        const memo = second.store.verifiedGenerationMemo;
        second.store.verifiedGenerationMemo = { ...memo, current: '{}' };
        assert.equal(await second.store.commit(loaded.generation, candidate(loaded, 'corrupt-memo')), loaded.generation + 1);
        assert.equal(counts.get(second.store), 2);
      } finally { await rm(second.root, { recursive: true, force: true }); }
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test('two stores conflict exactly, while restart and a second load stay cold/one-shot', async () => {
  await withVerifierCounter(async (counts) => {
    const fixture = await seed('memo-concurrency');
    try {
      const left = new FileArtifactStore(fixture.root);
      const right = new FileArtifactStore(fixture.root);
      const leftSnapshot = await left.load();
      const rightSnapshot = await right.load();
      await left.commit(leftSnapshot.generation, candidate(leftSnapshot, 'left'));
      await assert.rejects(() => right.commit(rightSnapshot.generation, candidate(rightSnapshot, 'right')), /manifest revision conflict/);
      assert.equal(counts.get(left), 1);
      assert.equal(counts.get(right), 2, 'stale concurrent memo falls back to one cold verifier');

      const restarted = new FileArtifactStore(fixture.root);
      const current = await restarted.load();
      await restarted.commit(current.generation, candidate(current, 'restart'));
      assert.equal(counts.get(restarted), 1, 'restart has no memo');
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test('OFF, SHADOW, and ON composition paths preserve the public transition contract', async () => {
  for (const graph of ['OFF', 'SHADOW', 'ON']) {
    const root = await mkdtemp(join(tmpdir(), `lunacy-p5-mode-${graph.toLowerCase()}-`));
    try {
      const options = { plan, rootDir: root, maxInFlight: 0, acceleration: { graph } };
      const kernel = composeKernel(options);
      const first = await kernel.advance(startInput(`mode-${graph}`));
      assert.equal(first.kind, 'WAITING');
      const event = { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'host', scope: 'p5', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } };
      const next = await kernel.advance({ runId: `mode-${graph}`, expectedRevision: first.snapshot.revision, identity: { runId: `mode-${graph}`, phaseId: 'run', stepId: 'run', attemptEpoch: first.snapshot.attemptEpoch, authorityEpoch: first.snapshot.authorityEpoch, barrierEpoch: first.snapshot.barrierEpoch, eventId: 'host', payloadDigest: digest(event) }, event });
      assert.ok(['WAITING', 'BLOCKED', 'DECISION_REQUIRED', 'COMPLETE'].includes(next.kind));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
