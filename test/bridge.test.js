import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { BridgeError, canonicalizeDeclaration, deleteBridge, disable, transition } from '../dist/bridge.js';
import { FileArtifactStore } from '../dist/store.js';

const plan = { phaseId: 'phase-a', steps: [{ stepId: 'a', goal: 'first' }] };
const startEvent = (value = plan) => ({ kind: 'START', intentRef: { id: 'plan', digest: digest(value) } });
const options = (root, value = plan, mode = 'runtime') => ({ runDir: root, runId: 'bridge-run', mode, plan: value });

test('strict declaration canonicalization rejects prose and unsafe values', () => {
  assert.equal(canonicalizeDeclaration(plan).schema, 'lunacy-plan-v1');
  assert.throws(() => canonicalizeDeclaration('# PLAN\n- run this'), BridgeError);
  assert.throws(() => canonicalizeDeclaration({ ...plan, unknown: true }), /unsupported fields/);
  assert.throws(() => canonicalizeDeclaration({ phaseId: 'phase-a', steps: [{ stepId: '__proto__' }] }), BridgeError);
  assert.throws(() => canonicalizeDeclaration({ phaseId: 'phase-a', steps: [{ stepId: 'a', goal: 1n }] }), BridgeError);
});

test('runtime bridge performs one transition and preserves declaration content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-'));
  await writeFile(join(root, 'STATE.md'), '# Human state\nOwner: parent\n', 'utf8');
  await writeFile(join(root, 'phases-placeholder'), 'not used', 'utf8');
  const first = await transition(options(root), { event: startEvent(), eventId: 'start' });
  assert.equal(first.mode, 'runtime'); assert.equal(first.projected, true); assert.equal(first.yield?.snapshot.revision, 1);
  assert.match(await readFile(join(root, 'STATE.md'), 'utf8'), /Owner: parent/);
  const stepsPath = join(root, 'phases', 'phase-a', 'STEPS.md');
  const steps = await readFile(stepsPath, 'utf8'); assert.match(steps, /Runtime step projection/); assert.match(steps, /"status":"ACTIVE"/);
  const duplicate = await transition(options(root), { event: startEvent(), eventId: 'start' });
  assert.equal(canonicalString(duplicate.yield), canonicalString(first.yield));
  const manifest = JSON.parse(await readFile(join(root, '.kernel', 'BRIDGE.json'), 'utf8'));
  assert.equal(manifest.mode, 'runtime'); assert.equal(manifest.status, 'enabled'); assert.equal(manifest.planDigest, digest(canonicalizeDeclaration(plan)));
});

test('claimed dispatch leaves phase STEPS bytes stable until async settlement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-claimed-projection-'));
  const first = await transition(options(root), { event: startEvent(), eventId: 'start' });
  const stepsPath = join(root, 'phases', 'phase-a', 'STEPS.md');
  const stepsBefore = await readFile(stepsPath);
  let resolveReceipt;
  let receiptResolved;
  const receiptReady = new Promise((resolve) => { receiptResolved = resolve; });
  const driver = {
    dispatch(command) {
      return new Promise((resolve) => {
        resolveReceipt = () => {
          resolve({ launchToken: command.launchToken, commandDigest: command.commandDigest, ref: { id: 'launch:claimed', scope: 'effect', digest: digest({ claimed: true }), bytes: canonicalString({ claimed: true }) } });
          receiptResolved();
        };
      });
    },
  };
  const second = await transition({ ...options(root), driver, dispatcher: { timeoutMs: 1_000 } }, { event: { kind: 'RESUME' }, eventId: 'resume', expectedRevision: first.yield.snapshot.revision });
  assert.equal(second.yield.kind, 'WAITING');
  assert.equal(second.yield.snapshot.pendingDispatchCount, 1);
  // The claim is durable while the private dispatcher is still attesting. A
  // STEPS inode replacement in this window would look like authority drift.
  assert.deepEqual(await readFile(stepsPath), stepsBefore);
  resolveReceipt();
  await receiptReady;
  await new Promise((resolve) => setImmediate(resolve));
});

test('duplicate transition skips both exact projection publications after confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-projection-noop-'));
  await writeFile(join(root, 'STATE.md'), '# Human state\n', 'utf8');
  const first = await transition(options(root), { event: startEvent(), eventId: 'start' });
  const statePath = join(root, 'STATE.md');
  const stepsPath = join(root, 'phases', 'phase-a', 'STEPS.md');
  const stateBefore = await readFile(statePath);
  const stepsBefore = await readFile(stepsPath);
  const duplicate = await transition(options(root), { event: startEvent(), eventId: 'start' });
  assert.equal(duplicate.yield && canonicalString(duplicate.yield), canonicalString(first.yield));
  assert.equal(duplicate.counters.projectionWrites, 0);
  assert.equal(duplicate.counters.projectionBytesWritten, 0);
  assert.equal(duplicate.counters.projectionReads, 6);
  assert.deepEqual(await readFile(statePath), stateBefore);
  assert.deepEqual(await readFile(stepsPath), stepsBefore);
});

test('projection identity replacement during confirmation falls back to ordinary publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-projection-race-'));
  await writeFile(join(root, 'STATE.md'), '# Human state\n', 'utf8');
  await transition(options(root), { event: startEvent(), eventId: 'start' });
  const statePath = join(root, 'STATE.md');
  const replacementPath = `${statePath}.replacement`;
  const originalOpen = fs.open;
  let stateOpenCount = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('/STATE.md')) {
      stateOpenCount += 1;
      if (stateOpenCount === 3) {
        const originalStat = handle.stat.bind(handle);
        handle.stat = async (...statArgs) => {
          await rename(replacementPath, statePath);
          return originalStat(...statArgs);
        };
      }
    }
    return handle;
  };
  try {
    await writeFile(replacementPath, '# replaced before confirmation\n', 'utf8');
    const duplicate = await transition(options(root), { event: startEvent(), eventId: 'start' });
    assert.equal(duplicate.counters.projectionWrites, 1);
    assert.ok(duplicate.counters.projectionBytesWritten > 0);
    assert.match(await readFile(statePath, 'utf8'), /Runtime state projection/);
    assert.doesNotMatch(await readFile(statePath, 'utf8'), /replaced before confirmation/);
  } finally {
    fs.open = originalOpen;
  }
});

test('projection pathname replacement during confirmation read falls back to ordinary publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-projection-late-race-'));
  await writeFile(join(root, 'STATE.md'), '# Human state\n', 'utf8');
  await transition(options(root), { event: startEvent(), eventId: 'start' });
  const statePath = join(root, 'STATE.md');
  const stepsPath = join(root, 'phases', 'phase-a', 'STEPS.md');
  const stateBefore = await readFile(statePath);
  const stepsBefore = await readFile(stepsPath);
  const replacementPath = `${statePath}.replacement`;
  const originalOpen = fs.open;
  let stateOpenCount = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith('/STATE.md')) {
      stateOpenCount += 1;
      if (stateOpenCount === 3) {
        const read = handle.readFile.bind(handle);
        handle.readFile = async (...readArgs) => {
          await rename(replacementPath, statePath);
          return read(...readArgs);
        };
      }
    }
    return handle;
  };
  try {
    await writeFile(replacementPath, '# replaced after pathname check\n', 'utf8');
    const duplicate = await transition(options(root), { event: startEvent(), eventId: 'start' });
    assert.equal(duplicate.counters.projectionWrites, 1);
    assert.equal(duplicate.counters.projectionReads, 5);
    assert.deepEqual(await readFile(statePath), stateBefore);
    assert.deepEqual(await readFile(stepsPath), stepsBefore);
    assert.equal(await fs.access(replacementPath).then(() => true, () => false), false);
  } finally {
    fs.open = originalOpen;
  }
});

test('projection no-op is independent per file and only confirms exact-byte hits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-projection-matrix-'));
  await writeFile(join(root, 'STATE.md'), '# Human state\n', 'utf8');
  await transition(options(root), { event: startEvent(), eventId: 'start' });
  const statePath = join(root, 'STATE.md');
  const stepsPath = join(root, 'phases', 'phase-a', 'STEPS.md');
  const stateBefore = await readFile(statePath);
  const stepsBefore = await readFile(stepsPath);
  await writeFile(stepsPath, (await readFile(stepsPath, 'utf8')).replace('"revision":1', '"revision":999'), 'utf8');
  const oneCurrent = await transition(options(root), { event: startEvent(), eventId: 'start' });
  assert.equal(oneCurrent.counters.projectionReads, 5);
  assert.equal(oneCurrent.counters.projectionWrites, 1);
  assert.deepEqual(await readFile(statePath), stateBefore);
  assert.deepEqual(await readFile(stepsPath), stepsBefore);

  await writeFile(statePath, (await readFile(statePath, 'utf8')).replace('"revision":1', '"revision":999'), 'utf8');
  await writeFile(stepsPath, (await readFile(stepsPath, 'utf8')).replace('"revision":1', '"revision":999'), 'utf8');
  const bothStale = await transition(options(root), { event: startEvent(), eventId: 'start' });
  assert.equal(bothStale.counters.projectionReads, 4);
  assert.equal(bothStale.counters.projectionWrites, 2);

  await fs.unlink(statePath);
  const missingState = await transition(options(root), { event: startEvent(), eventId: 'start' });
  assert.equal(missingState.counters.projectionReads, 3);
  assert.equal(missingState.counters.projectionWrites, 1);
  assert.match(await readFile(statePath, 'utf8'), /Runtime state projection/);
});

test('projection confirmation miss from same-inode byte change or read failure publishes normally', async () => {
  for (const mode of ['byte-change', 'read-failure']) {
    const root = await mkdtemp(join(tmpdir(), `lunacy-bridge-projection-${mode}-`));
    await writeFile(join(root, 'STATE.md'), '# Human state\n', 'utf8');
    await transition(options(root), { event: startEvent(), eventId: 'start' });
    const statePath = join(root, 'STATE.md');
    const originalOpen = fs.open;
    let stateOpenCount = 0;
    fs.open = async (...args) => {
      if (!String(args[0]).endsWith('/STATE.md')) return originalOpen(...args);
      if (mode === 'read-failure' && ++stateOpenCount === 3) {
        const error = new Error('confirmation unavailable'); error.code = 'EIO'; throw error;
      }
      const handle = await originalOpen(...args);
      if (mode === 'byte-change' && ++stateOpenCount === 3) {
        const read = handle.readFile.bind(handle);
        handle.readFile = async (...readArgs) => {
          await writeFile(statePath, '# changed before confirmation\n', 'utf8');
          return read(...readArgs);
        };
      }
      return handle;
    };
    try {
      const duplicate = await transition(options(root), { event: startEvent(), eventId: 'start' });
      assert.equal(duplicate.counters.projectionWrites, 1);
      assert.match(await readFile(statePath, 'utf8'), /Runtime state projection/);
      assert.doesNotMatch(await readFile(statePath, 'utf8'), /changed before confirmation/);
    } finally {
      fs.open = originalOpen;
    }
  }
});

test('projection publication barrier cleans temporary bytes and retries with existing partial semantics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-projection-barrier-'));
  await writeFile(join(root, 'STATE.md'), '# Human state\n', 'utf8');
  await transition(options(root), { event: startEvent(), eventId: 'start' });
  const statePath = join(root, 'STATE.md');
  await writeFile(statePath, (await readFile(statePath, 'utf8')).replace('"revision":1', '"revision":999'), 'utf8');
  const originalRename = fs.rename;
  let barrierHit = false;
  fs.rename = async (...args) => {
    if (!barrierHit && String(args[1]).endsWith('/STATE.md')) {
      barrierHit = true;
      const error = new Error('rename barrier'); error.code = 'EIO'; throw error;
    }
    return originalRename(...args);
  };
  try {
    await assert.rejects(() => transition(options(root), { event: startEvent(), eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'ProjectionFailed');
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(barrierHit, true);
  assert.equal((await fs.readdir(root)).some((entry) => entry.includes('.tmp-')), false);
  const retry = await transition(options(root), { event: startEvent(), eventId: 'start' });
  assert.equal(retry.counters.projectionWrites, 1);
  assert.match(await readFile(statePath, 'utf8'), /Runtime state projection/);
});

test('projection trust rejects a canonical STATE.md symlink without mutating its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-projection-canonical-trust-'));
  await transition(options(root), { event: startEvent(), eventId: 'start' });
  const statePath = join(root, 'STATE.md');
  const savedPath = `${statePath}.saved`;
  const targetPath = join(root, 'outside.md');
  await writeFile(targetPath, 'do not touch\n', 'utf8');
  await rename(statePath, savedPath);
  await symlink(targetPath, statePath);
  await assert.rejects(() => transition(options(root), { event: startEvent(), eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
  assert.equal(await readFile(targetPath, 'utf8'), 'do not touch\n');
});

test('projection partial publication keeps completed STATE visible when STEPS fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-projection-partial-'));
  await writeFile(join(root, 'STATE.md'), '# Human state\n', 'utf8');
  await transition(options(root), { event: startEvent(), eventId: 'start' });
  const statePath = join(root, 'STATE.md');
  const stepsPath = join(root, 'phases', 'phase-a', 'STEPS.md');
  const stateBefore = await readFile(statePath);
  await writeFile(statePath, (await readFile(statePath, 'utf8')).replace('"revision":1', '"revision":999'), 'utf8');
  await writeFile(stepsPath, (await readFile(stepsPath, 'utf8')).replace('"revision":1', '"revision":999'), 'utf8');
  const stepsStale = await readFile(stepsPath);
  const originalRename = fs.rename;
  let stepsBarrierHit = false;
  fs.rename = async (...args) => {
    if (String(args[1]).endsWith('/phases/phase-a/STEPS.md')) {
      stepsBarrierHit = true;
      const error = new Error('STEPS rename barrier'); error.code = 'EIO'; throw error;
    }
    return originalRename(...args);
  };
  try {
    await assert.rejects(() => transition(options(root), { event: startEvent(), eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'ProjectionFailed');
  } finally {
    fs.rename = originalRename;
  }
  assert.equal(stepsBarrierHit, true);
  assert.deepEqual(await readFile(statePath), stateBefore);
  assert.deepEqual(await readFile(stepsPath), stepsStale);
  assert.equal((await fs.readdir(root)).some((entry) => entry.includes('.tmp-')), false);
});

test('markdown mode is inert and cannot mix with an existing runtime root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-markdown-'));
  const result = await transition(options(root, plan, 'markdown'), { event: { kind: 'RESUME' }, eventId: 'resume' });
  assert.equal(result.mode, 'markdown'); assert.equal(result.projected, false);
  await transition(options(root), { event: startEvent(), eventId: 'start' });
  await assert.rejects(() => transition(options(root, plan, 'markdown'), { event: { kind: 'RESUME' }, eventId: 'resume-2' }), (error) => error instanceof BridgeError && error.code === 'ModeConflict');
});

test('missing/corrupt/version/path manifests fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-corrupt-'));
  await transition(options(root), { event: startEvent(), eventId: 'start' });
  const path = join(root, '.kernel', 'BRIDGE.json');
  await writeFile(path, '{"schema":1}\n', 'utf8');
  await assert.rejects(() => transition(options(root), { event: { kind: 'RESUME' }, eventId: 'resume' }), (error) => error instanceof BridgeError && error.code === 'ManifestMismatch');
  await writeFile(path, canonicalString({ schema: 1, bridgeVersion: 'other', runtimeVersion: '0.1.0', mode: 'runtime', status: 'enabled', runId: 'bridge-run', phaseId: 'phase-a', rootPath: root, planDigest: digest(canonicalizeDeclaration(plan)), sourceDigest: digest('lunacy-runtime-skill-bridge/v1') }), 'utf8');
  await assert.rejects(() => transition(options(root), { event: { kind: 'RESUME' }, eventId: 'resume-2' }), (error) => error instanceof BridgeError && error.code === 'VersionMismatch');
});

test('projection symlink and active disable/delete are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-safety-'));
  await transition(options(root), { event: startEvent(), eventId: 'start' });
  const evil = join(root, 'evil.md'); await writeFile(evil, 'do not touch', 'utf8');
  const projection = join(root, 'STATE-link.md'); await symlink(evil, projection);
  await assert.rejects(() => transition({ ...options(root), statePath: projection }, { event: { kind: 'RESUME' }, eventId: 'resume' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
  await assert.rejects(() => disable(options(root)), (error) => error instanceof BridgeError && error.code === 'ActiveWork');
  await assert.rejects(() => deleteBridge(options(root)), (error) => error instanceof BridgeError && error.code === 'ActiveWork');
  assert.equal(await readFile(evil, 'utf8'), 'do not touch');
});

test('restart reloads the same runtime authority and stale revision is fenced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-restart-'));
  const first = await transition(options(root), { event: startEvent(), eventId: 'start' });
  const second = await transition(options(root), { event: { kind: 'RESUME' }, eventId: 'resume', expectedRevision: first.yield.snapshot.revision });
  assert.equal(second.yield.snapshot.revision, 2);
  await assert.rejects(() => transition(options(root), { event: { kind: 'RESUME' }, eventId: 'stale', expectedRevision: 1 }), /Conflict|stale/);
  const loaded = await new FileArtifactStore(root).load(); assert.equal(loaded.state?.revision, 2);
});
