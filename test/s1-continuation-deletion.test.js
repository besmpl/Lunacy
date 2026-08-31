import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const crashChild = fileURLToPath(new URL('./fixtures/c1-claimed-crash-child.mjs', import.meta.url));
const bridgeCli = fileURLToPath(new URL('../dist/bridge-cli.js', import.meta.url));
const deployTool = fileURLToPath(new URL('../tools/deploy-skill.mjs', import.meta.url));
const plan = { phaseId: 'c1', steps: [{ stepId: 'worker' }] };
const obsoleteSources = [
  'docs/CONTINUATION.md',
  'docs/WORKER_PROOF.md',
  'schemas/lunacy-continuation.schema.json',
  'src/codex-worker-proof.ts',
  'src/continuation.ts',
  'test/codex-worker-proof.test.js',
  'test/continuation.test.js',
];
const obsoleteDist = [
  'codex-worker-proof.js',
  'codex-worker-proof.js.map',
  'codex-worker-proof.d.ts',
  'codex-worker-proof.d.ts.map',
  'continuation.js',
  'continuation.js.map',
  'continuation.d.ts',
  'continuation.d.ts.map',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonRef = (id, value) => ({ id, scope: 'outbox', digest: digest(value), bytes: canonicalString(value) });
const absent = async (path) => access(path).then(() => false, () => true);

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
    const child = spawn(process.execPath, [crashChild, root, runId], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
  assert.equal(result.code, 0, result.stderr || `child signal ${result.signal}`);
  const loaded = await new FileArtifactStore(root).load();
  const command = Object.values(loaded.state.outbox)[0];
  assert.equal(command.state, 'CLAIMED');
  return { loaded, command, archive: await readFile(join(root, 'CLAIMED_AFTER_PASS.json')) };
}

async function recoverClaimed(root, runId) {
  const before = await new FileArtifactStore(root).load();
  const counters = { dispatch: 0, observe: 0 };
  const driver = {
    dispatch() {
      counters.dispatch += 1;
      throw new Error('recovery must not redispatch');
    },
    observe(token, _signal, _anchor, retained) {
      counters.observe += 1;
      const value = { accepted: true, archiveSha256: sha256(readFileSync(join(root, 'CLAIMED_AFTER_PASS.json'))) };
      return { launchToken: token, commandDigest: retained.commandDigest, ref: jsonRef('S1.CLAIMED_AFTER_PASS', value) };
    },
  };
  const kernel = composeKernel({ plan, rootDir: root, driver, timeoutMs: 1_000 });
  const resume = eventInput(runId, 'explicit-resume', { kind: 'RESUME' }, snapshotOf(before.state));
  const yielded = await kernel.advance(resume);
  return { before, counters, kernel, resume, yielded, after: await new FileArtifactStore(root).load() };
}

test('S1 direct continuation parity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s1-direct-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = 's1-direct';
  const crashed = await crashClaimed(root, runId);
  const oldSidecar = Buffer.from('{"schema":"lunacy-continuation/v1","obsolete":true}\n');
  const sidecarPath = join(root, '.kernel', 'continuation.json');
  await writeFile(sidecarPath, oldSidecar);

  const absoluteHelp = spawnSync(process.execPath, [bridgeCli, '--help'], { encoding: 'utf8' });
  assert.equal(absoluteHelp.status, 0, absoluteHelp.stderr);
  assert.match(absoluteHelp.stdout, /lunacy-bridge init\|run\|resume/);

  const recovered = await recoverClaimed(root, runId);
  assert.equal(recovered.yielded.kind, 'WAITING');
  assert.equal(recovered.yielded.snapshot.pendingDispatchCount, 0);
  assert.equal(recovered.yielded.snapshot.unknownDispatchCount, 0);
  assert.equal(recovered.yielded.snapshot.gate, crashed.loaded.state.gate);
  assert.deepEqual(recovered.counters, { dispatch: 0, observe: 1 });
  assert.equal(Object.values(recovered.after.state.outbox)[0].state, 'ACKED');
  const replay = await recovered.kernel.advance(recovered.resume);
  assert.equal(canonicalString(replay), canonicalString(recovered.yielded));
  assert.deepEqual(await readFile(sidecarPath), oldSidecar);
  assert.deepEqual(await readFile(join(root, 'CLAIMED_AFTER_PASS.json')), crashed.archive);

  const present = [];
  for (const path of obsoleteSources) if (!(await absent(join(repo, path)))) present.push(path);
  assert.deepEqual(present, [], `obsolete maintained surfaces remain: ${present.join(', ')}`);
});

test('S1 deployment inventory', async (t) => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-s1-deploy-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const deployed = spawnSync(process.execPath, [deployTool, '--target', target], { cwd: repo, encoding: 'utf8' });
  assert.equal(deployed.status, 0, deployed.stderr);
  const manifest = JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8'));
  for (const name of obsoleteDist) {
    assert.equal(await absent(join(repo, 'dist', name)), true, `clean dist retained ${name}`);
    assert.equal(await absent(join(target, 'runtime', 'dist', name)), true, `deployment retained ${name}`);
    assert.equal(manifest.files.includes(`runtime/dist/${name}`), false, `manifest retained ${name}`);
  }
  const installedHelp = spawnSync(process.execPath, [join(target, 'runtime', 'bridge.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(installedHelp.status, 0, installedHelp.stderr);
  assert.match(installedHelp.stdout, /Usage: lunacy-bridge/);
  const driveHelp = spawnSync(process.execPath, [join(target, 'runtime', 'bridge.mjs'), 'drive', '--help'], { encoding: 'utf8' });
  assert.equal(driveHelp.status, 0, driveHelp.stderr);
  assert.match(driveHelp.stdout, /Usage: lunacy-bridge drive/);
});

test('S1 rollback reader smoke', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s1-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await crashClaimed(root, 's1-reader');
  const sidecarPath = join(root, '.kernel', 'continuation.json');
  const oldSidecar = Buffer.from('{"malformed":"old-sidecar-is-inert"}\n');
  await writeFile(sidecarPath, oldSidecar);
  const loaded = await new FileArtifactStore(root).load();
  assert.equal(Object.values(loaded.state.outbox)[0].state, 'CLAIMED');
  assert.deepEqual(await readFile(sidecarPath), oldSidecar);
});
