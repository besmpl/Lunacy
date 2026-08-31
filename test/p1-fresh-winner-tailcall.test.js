import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalString, digest } from '../dist/canonical.js';
import { listDecisionInbox, submitParentDecision } from '../dist/decision-inbox.js';
import { initRun, resumeRun, runRun } from '../dist/orchestration.js';
import { FileArtifactStore } from '../dist/store.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const childPath = fileURLToPath(new URL('./fixtures/p1-pending-crash-child.mjs', import.meta.url));
const deployTool = fileURLToPath(new URL('../tools/deploy-skill.mjs', import.meta.url));
const predecessor = 'fa83f5d3a2c440bb1ad2c28fe34970f7dc6a5b2e';
const plan = { phaseId: 'p1', steps: [{ stepId: 'worker' }] };

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ref = (id, value) => ({ id, scope: 'test', digest: digest(value), bytes: canonicalString(value) });
function completingDriver(onDispatch = () => undefined) {
  const commands = new Map();
  return {
    dispatch(command, launchToken) {
      commands.set(launchToken, command);
      onDispatch(command, launchToken);
      return { launchToken, commandDigest: command.commandDigest, ref: ref('p1-launch', { accepted: true }) };
    },
    terminal(launchToken) {
      const command = commands.get(launchToken);
      return { schema: 'lunacy-codex-terminal/v1', launchToken, commandDigest: command.commandDigest, status: 'PASS', outcome: 'normal-completion', exitCode: 0, signal: null, resultDigest: null, reportPath: null, reportDigest: null, eventsDigest: digest('p1-events'), finishedAt: '2025-01-01T00:00:00Z' };
    },
  };
}

async function freshDecision(t, prefix = 'lunacy-p1-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = 'p1-run';
  await initRun({ runDir: root, runId, plan });
  await runRun({ runDir: root, runId, plan, driver: completingDriver() });
  const inbox = (await listDecisionInbox({ entries: [{ runRoot: root, runId }] })).entries[0];
  assert.equal(inbox.status, 'READY');
  return { root, runId, input: { selection: { runRoot: root, runId, token: inbox.token.value }, inbox, plan, value: 'FINDINGS' } };
}

async function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [childPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

async function waitFor(paths, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await Promise.all(paths.map((path) => access(path).then(() => true, () => false)))).every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${paths.join(', ')}`);
}

async function journey(t, prefix) {
  const prepared = await freshDecision(t, prefix);
  let dispatches = 0;
  const result = await submitParentDecision({ ...prepared.input, driver: completingDriver(() => { dispatches += 1; }) });
  const state = (await new FileArtifactStore(prepared.root).loadReadOnly(prepared.runId)).state;
  return {
    result,
    dispatches,
    receipt: canonicalString({
      status: result.status,
      consumed: result.consumed,
      decisionYield: result.yield,
      dispatches,
      journalKinds: state.journal.map((row) => row.event.kind),
      outboxStates: Object.values(state.outbox).map((command) => command.state).sort(),
    }),
  };
}

// The predecessor commits FINDINGS and returns its durable PENDING yield, but
// does not continue the winning live submission through the existing pump.
test('P1 fresh CAS winner tailcalls once', async (t) => {
  const first = await journey(t, 'lunacy-p1-winner-a-');
  const second = await journey(t, 'lunacy-p1-winner-b-');
  assert.equal(first.result.status, 'committed');
  assert.equal(first.dispatches, 1);
  assert.equal(second.dispatches, 1);
  assert.equal(first.receipt, second.receipt);
});

test('P1 replay does not tailcall', async (t) => {
  const prepared = await freshDecision(t, 'lunacy-p1-replay-');
  const first = await submitParentDecision(prepared.input);
  let dispatches = 0;
  const retry = await submitParentDecision({ ...prepared.input, driver: completingDriver(() => { dispatches += 1; }) });
  assert.equal(first.status, 'committed');
  assert.equal(retry.status, 'replayed');
  assert.equal(dispatches, 0);
});

test('P1 losing CAS does not tailcall', async (t) => {
  const prepared = await freshDecision(t, 'lunacy-p1-race-');
  const configA = join(prepared.root, 'input-a.json'); const configB = join(prepared.root, 'input-b.json');
  const marker = join(prepared.root, 'dispatches.log');
  const readyA = join(prepared.root, 'ready-a'); const readyB = join(prepared.root, 'ready-b');
  const release = join(prepared.root, 'release');
  await writeFile(configA, JSON.stringify({ ...prepared.input, eventId: 'race-a' }));
  await writeFile(configB, JSON.stringify({ ...prepared.input, eventId: 'race-b' }));
  const a = runChild(['race', configA, marker, readyA, release]);
  const b = runChild(['race', configB, marker, readyB, release]);
  await waitFor([readyA, readyB]);
  await writeFile(release, 'go\n');
  const results = await Promise.all([a, b]);
  for (const result of results) assert.equal(result.code, 0, result.stderr || `child signal ${result.signal}`);
  const outcomes = results.map((result) => JSON.parse(result.stdout)).sort((a, b) => a.status.localeCompare(b.status));
  assert.deepEqual(outcomes.map(({ status, code }) => ({ status, code })), [
    { status: 'attention', code: 'KernelConflict' },
    { status: 'committed', code: null },
  ]);
  const dispatchPids = (await readFile(marker, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(dispatchPids.length, 1);
});

test('P1 driverless fallback does not tailcall', async (t) => {
  const prepared = await freshDecision(t, 'lunacy-p1-driverless-');
  const result = await submitParentDecision(prepared.input);
  const state = (await new FileArtifactStore(prepared.root).loadReadOnly(prepared.runId)).state;
  assert.equal(result.status, 'committed');
  assert.equal(Object.values(state.outbox).filter((command) => command.state === 'PENDING').length, 1);
});

test('P1 crash after PENDING is recoverable', async (t) => {
  const prepared = await freshDecision(t, 'lunacy-p1-crash-');
  const config = join(prepared.root, 'input.json');
  await writeFile(config, JSON.stringify(prepared.input));
  const crashed = await runChild(['crash', config]);
  assert.equal(crashed.code, null, crashed.stderr);
  assert.equal(crashed.signal, 'SIGKILL');
  assert.deepEqual(JSON.parse(crashed.stdout), { status: 'committed', pending: true });
  const before = (await new FileArtifactStore(prepared.root).loadReadOnly(prepared.runId)).state;
  assert.equal(Object.values(before.outbox).filter((command) => command.state === 'PENDING').length, 1);
  let dispatches = 0;
  await resumeRun({ command: 'resume', runDir: prepared.root, runId: prepared.runId, plan, driver: completingDriver(() => { dispatches += 1; }) });
  assert.equal(dispatches, 1);
  const after = (await new FileArtifactStore(prepared.root).loadReadOnly(prepared.runId)).state;
  assert.equal(Object.values(after.outbox).some((command) => command.state === 'PENDING'), false);
});

test('P1 deployment inventory', async (t) => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-p1-deploy-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const deployed = spawnSync(process.execPath, [deployTool, '--target', target], { cwd: repo, encoding: 'utf8' });
  assert.equal(deployed.status, 0, deployed.stderr);
  const manifest = JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8'));
  assert.ok(manifest.files.includes('runtime/dist/decision-inbox.js'));
  assert.equal(manifest.files.some((path) => path.includes('p1-fresh-winner-tailcall')), false);
  assert.ok(await readFile(join(target, 'runtime', 'dist', 'decision-inbox.js'), 'utf8'));
});

test('P1 rollback reader smoke', async (t) => {
  const prepared = await freshDecision(t, 'lunacy-p1-rollback-');
  const committed = await submitParentDecision(prepared.input);
  assert.equal(committed.status, 'committed');
  const archiveRoot = await mkdtemp(join(tmpdir(), 'lunacy-p1-predecessor-reader-'));
  t.after(() => rm(archiveRoot, { recursive: true, force: true }));
  const archive = spawnSync('git', ['archive', '--format=tar', predecessor], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(archive.status, 0, archive.stderr?.toString('utf8'));
  const tarPath = join(archiveRoot, 'dist.tar');
  await writeFile(tarPath, archive.stdout);
  const extracted = spawnSync('tar', ['-xf', tarPath, '-C', archiveRoot], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const linked = spawnSync('ln', ['-s', join(repo, 'node_modules'), join(archiveRoot, 'node_modules')], { encoding: 'utf8' });
  assert.equal(linked.status, 0, linked.stderr);
  const built = spawnSync('npm', ['run', 'build'], { cwd: archiveRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const predecessorStore = await import(`${pathToFileURL(join(archiveRoot, 'dist', 'store.js')).href}?receipt=${sha256(archive.stdout)}`);
  const loaded = await new predecessorStore.FileArtifactStore(prepared.root).loadReadOnly(prepared.runId);
  assert.ok(loaded.state.journal.some((row) => row.event.kind === 'PARENT_DECISION'));
  assert.ok(Object.values(loaded.state.outbox).some((command) => command.state === 'PENDING'));
  const durableBytes = JSON.stringify(loaded.state);
  assert.equal(/winnerWitness|freshWinner/.test(durableBytes), false);
  assert.ok((await readdir(join(prepared.root, '.kernel'))).length > 0);
});
