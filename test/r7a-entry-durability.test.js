import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { digest } from '../dist/canonical.js';
import { codexHostPolicyDigest, createCodexHostPolicy, launchAuthoritySnapshotRoot } from '../dist/codex-host-policy.js';
import { CodexExecSupervisor } from '../dist/codex-exec-supervisor.js';
import { effectPaths, readLaunchIntentRecord, readLaunchRecord, readTerminalRecord, writeLaunchIntentRecord, writeLaunchRecord, writeTerminalRecord } from '../dist/codex-effect-records.js';
import { ensurePrivateDirectory, syncDirectory } from '../dist/filesystem.js';
import { promises as fs } from 'node:fs';

class FakeChild extends EventEmitter {
  constructor() {
    super(); this.pid = 7777; this.stdout = new EventEmitter(); this.stderr = new EventEmitter();
    this.stdin = { end: () => process.nextTick(() => this.emit('close', 0, null)) };
  }
  kill(signal) { this.killed = signal; return true; }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r7a-durable-'));
  const workspace = join(root, 'workspace'); const skillRoot = join(root, 'skill'); const codexPath = join(root, 'codex');
  await mkdir(join(workspace, '.git'), { recursive: true }); await mkdir(join(skillRoot, 'worker'), { recursive: true });
  await mkdir(join(root, 'phases', 'phase-a'), { recursive: true });
  await writeFile(join(root, 'PLAN.md'), '# test plan\n'); await writeFile(join(root, 'DECISIONS.md'), '# test decisions\n');
  await writeFile(join(root, 'phases', 'phase-a', 'STEPS.md'), '# test steps\n');
  await writeFile(join(skillRoot, 'worker', 'ENGINEERING.md'), '# test engineering\n');
  await writeFile(join(root, 'schema.json'), '{}\n'); await writeFile(codexPath, '#!/bin/sh\nexit 0\n'); await chmod(codexPath, 0o755);
  const codexBinaryDigest = createHash('sha256').update(await readFile(codexPath)).digest('hex');
  const workerSchemaDigest = createHash('sha256').update('{}\n').digest('hex');
  const policy = createCodexHostPolicy({ runId: 'run-r7a', planDigest: '1'.repeat(64), runRoot: root, workspace, skillRoot, codexPath, codexBinaryDigest, workerSchemaPath: join(root, 'schema.json'), workerSchemaDigest, maxSupported: true });
  const command = { commandId: 'command-r7a', runId: policy.runId, phaseId: 'phase-a', stepId: 'step-a', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0, launchToken: 'launch-r7a' };
  command.commandDigest = digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken });
  command.planDigest = policy.planDigest;
  return { root, workspace, policy, command };
}

const attestationFor = (policy) => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 501, gid: 20, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion });

function replaceFileSameBytes(path) {
  const parent = dirname(path); const parentMode = lstatSync(parent).mode & 0o777;
  chmodSync(parent, 0o700);
  const backup = `${path}.r7a-old`;
  renameSync(path, backup);
  writeFileSync(path, readFileSync(backup));
  chmodSync(path, lstatSync(backup).mode & 0o777);
  unlinkSync(backup);
  chmodSync(parent, parentMode);
}

function replaceDirectory(path) {
  const parent = dirname(path); const parentMode = lstatSync(parent).mode & 0o777;
  try { chmodSync(parent, 0o700); } catch { /* sticky system-temp parent */ }
  const backup = `${path}.r7a-old`;
  renameSync(path, backup);
  mkdirSync(path, { recursive: false, mode: 0o700 });
  try { chmodSync(parent, parentMode); } catch { /* sticky system-temp parent */ }
}

// Keep this test platform-neutral: Windows has no directory-fsync primitive,
// and syncDirectory intentionally treats its unsupported error as a bounded
// compatibility case while still exercising the creation path.
test('private directory publication flushes each newly-created parent chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r7a-chain-')); const target = join(root, 'one', 'two', 'three');
  const originalOpen = fs.open; const synced = [];
  fs.open = async (...args) => {
    const handle = await originalOpen.call(fs, ...args); const originalSync = handle.sync.bind(handle);
    handle.sync = async () => { synced.push(String(args[0])); return originalSync(); };
    return handle;
  };
  try { await ensurePrivateDirectory(target, 'R7-A test directory'); }
  finally { fs.open = originalOpen; }
  assert.ok(synced.length >= 6, `expected each directory and parent to be synchronized, got ${synced.length}`);
  assert.equal(lstatSync(target).isDirectory(), true);
});

test('directory-fsync fault fails closed instead of claiming a published name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r7a-fault-')); const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen.call(fs, ...args); const originalSync = handle.sync.bind(handle);
    handle.sync = async () => { throw Object.assign(new Error('simulated power-loss barrier failure'), { code: 'EIO' }); };
    return handle;
  };
  try { await assert.rejects(() => syncDirectory(root, 'R7-A injected fsync'), /could not be synchronized/); }
  finally { fs.open = originalOpen; }
});

test('effect records fsync containing names and remain restart-visible', async () => {
  const { policy, command } = await fixture(); const paths = effectPaths(policy, command.launchToken);
  const startedAt = new Date(0).toISOString(); const digestField = 'a'.repeat(64);
  const intent = {
    schema: 'lunacy-codex-launch-intent/v1', launchToken: command.launchToken, commandDigest: command.commandDigest, commandId: command.commandId,
    runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attempt: 0, attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0,
    policyDigest: codexHostPolicyDigest(policy), authorityDigest: digestField, handoffDigest: digestField, argvDigest: digestField, codexPath: policy.codexPath,
    codexVersion: policy.codexVersion, codexBinaryDigest: policy.codexBinaryDigest, workspace: policy.workspace, supervisor: { pid: process.pid }, startedAt,
  };
  const launch = { ...intent, schema: 'lunacy-codex-launch/v1', child: { pid: 8888 } };
  const terminal = {
    schema: 'lunacy-codex-terminal/v1', launchToken: command.launchToken, commandDigest: command.commandDigest, status: 'BLOCKED', outcome: 'process-failure',
    exitCode: 1, signal: null, resultDigest: null, reportPath: null, reportDigest: null, eventsDigest: digestField, finishedAt: startedAt,
  };
  const originalOpen = fs.open; const syncCalls = [];
  fs.open = async (...args) => {
    const handle = await originalOpen.call(fs, ...args); const originalSync = handle.sync.bind(handle);
    handle.sync = async () => { syncCalls.push(String(args[0])); return originalSync(); };
    return handle;
  };
  try {
    await writeLaunchIntentRecord(policy, intent);
    await writeLaunchRecord(policy, launch);
    await writeTerminalRecord(policy, terminal);
  } finally { fs.open = originalOpen; }
  assert.ok(syncCalls.includes(dirname(paths.launchIntent)), 'launch-intent parent was not synchronized');
  assert.ok(syncCalls.includes(dirname(paths.launch)), 'launch parent was not synchronized');
  assert.ok(syncCalls.includes(dirname(paths.terminal)), 'terminal parent was not synchronized');
  assert.equal((await readLaunchIntentRecord(policy, command.launchToken))?.launchToken, command.launchToken);
  assert.equal((await readLaunchRecord(policy, command.launchToken))?.child.pid, 8888);
  assert.equal((await readTerminalRecord(policy, command.launchToken))?.status, 'BLOCKED');
});

test('Darwin final fence rejects a copied-image replacement immediately after sealing', { skip: process.platform !== 'darwin' }, async () => {
  const { policy, command } = await fixture(); let spawned = 0; let armed = false;
  const snapshotRoot = launchAuthoritySnapshotRoot(policy, command); const target = join(snapshotRoot, 'codex-executable');
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; return new FakeChild(); },
    attestExecutable: async () => attestationFor(policy),
    sealImmutable: (path, enabled) => {
      if (!enabled) return;
      if (path === target) { armed = true; return; }
      if (armed) { armed = false; replaceFileSameBytes(target); }
    },
  });
  await assert.rejects(() => supervisor.start({ command, policy }), /authority snapshot .*changed|metadata changed|could not be synchronized/);
  assert.equal(spawned, 0);
});

test('Darwin final fence rejects a snapshot-entry replacement immediately after sealing', { skip: process.platform !== 'darwin' }, async () => {
  const { policy, command } = await fixture(); let spawned = 0; let armed = false;
  const snapshotRoot = launchAuthoritySnapshotRoot(policy, command); const target = join(snapshotRoot, 'run', 'PLAN.md');
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; return new FakeChild(); },
    attestExecutable: async () => attestationFor(policy),
    sealImmutable: (path, enabled) => {
      if (!enabled) return;
      if (path === target) { armed = true; return; }
      if (armed) { armed = false; replaceFileSameBytes(target); }
    },
  });
  await assert.rejects(() => supervisor.start({ command, policy }), /authority snapshot .*changed|metadata changed/);
  assert.equal(spawned, 0);
});

test('Darwin final fence rejects an authority snapshot-root replacement after sealing', { skip: process.platform !== 'darwin' }, async () => {
  const { policy, command } = await fixture(); let spawned = 0; let armed = false;
  const snapshotRoot = launchAuthoritySnapshotRoot(policy, command);
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; return new FakeChild(); },
    attestExecutable: async () => attestationFor(policy),
    sealImmutable: (path, enabled) => {
      if (!enabled) return;
      if (path === snapshotRoot) { armed = true; return; }
      if (armed) { armed = false; replaceDirectory(snapshotRoot); }
    },
  });
  await assert.rejects(() => supervisor.start({ command, policy }), /authority snapshot .*changed|metadata changed|could not be synchronized/);
  assert.equal(spawned, 0);
});

test('Darwin final fence rejects workspace and run-root replacements after sealing', { skip: process.platform !== 'darwin' }, async () => {
  for (const targetKind of ['workspace', 'runRoot']) {
    const { root, workspace, policy, command } = await fixture(); let spawned = 0; let workspaceSealed = false;
    const supervisor = new CodexExecSupervisor({
      policy,
      spawnProcess: () => { spawned += 1; return new FakeChild(); },
      attestExecutable: async () => attestationFor(policy),
      sealImmutable: (path, enabled) => {
        if (!enabled) return;
        if (path === workspace) { workspaceSealed = true; return; }
        if (targetKind === 'workspace' && workspaceSealed && path === root) replaceDirectory(workspace);
        if (targetKind === 'runRoot' && path === root) replaceDirectory(root);
      },
    });
    await assert.rejects(() => supervisor.start({ command, policy }), /run root|workspace changed before spawn/);
    assert.equal(spawned, 0, targetKind);
  }
});
