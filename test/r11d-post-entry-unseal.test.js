import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/canonical.js';
import { createCodexHostPolicy } from '../dist/codex-host-policy.js';
import { CodexExecSupervisor } from '../dist/codex-exec-supervisor.js';
import { readLaunchIntentRecord, readLaunchRecord, writeLaunchRecord } from '../dist/codex-effect-records.js';

class LiveChild extends EventEmitter {
  constructor(pid = 7301) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { end: () => undefined, destroy: () => undefined };
    this.signals = [];
    this.closed = false;
  }

  kill(signal) {
    this.signals.push(signal);
    if (!this.closed) {
      this.closed = true;
      queueMicrotask(() => this.emit('close', null, signal));
    }
    return true;
  }
}

async function fixture(label) {
  const root = await mkdtemp(join(tmpdir(), `lunacy-r11d-${label}-`));
  const workspace = join(root, 'workspace');
  const skillRoot = join(root, 'skill');
  const codexPath = join(root, 'codex');
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(skillRoot, 'worker'), { recursive: true });
  await mkdir(join(root, 'phases', 'phase-a'), { recursive: true });
  await writeFile(join(root, 'PLAN.md'), '# test plan\n');
  await writeFile(join(root, 'DECISIONS.md'), '# test decisions\n');
  await writeFile(join(root, 'phases', 'phase-a', 'STEPS.md'), '# test steps\n');
  await writeFile(join(skillRoot, 'worker', 'ENGINEERING.md'), '# engineering\n');
  await writeFile(join(root, 'schema.json'), '{}\n');
  await writeFile(codexPath, '#!/bin/sh\nexit 0\n');
  await chmod(codexPath, 0o755);
  const codexBinaryDigest = createHash('sha256').update(await readFile(codexPath)).digest('hex');
  const workerSchemaDigest = createHash('sha256').update('{}\n').digest('hex');
  const policy = createCodexHostPolicy({
    runId: `run-r11d-${label}`,
    planDigest: '1'.repeat(64),
    runRoot: root,
    workspace,
    skillRoot,
    codexPath,
    codexBinaryDigest,
    workerSchemaPath: join(root, 'schema.json'),
    workerSchemaDigest,
    timeoutMs: 10_000,
    cancellationGraceMs: 0,
    maxSupported: true,
  });
  const command = {
    commandId: `command-${label}`,
    runId: policy.runId,
    phaseId: 'phase-a',
    stepId: 'step-a',
    attemptEpoch: 0,
    authorityEpoch: 0,
    barrierEpoch: 0,
    modeEpoch: 0,
    launchToken: `launch-${label}`,
    planDigest: policy.planDigest,
  };
  command.commandDigest = digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken });
  return { root, workspace, policy, command };
}

const attestationFor = (policy) => ({
  requestedPath: policy.codexPath,
  physicalPath: policy.codexPath,
  requestedPathIsSymlink: false,
  uid: 501,
  gid: 20,
  mode: '755',
  digest: policy.codexBinaryDigest,
  version: policy.codexVersion,
});

function simulatedFlags(events, root, workspace, behavior = () => true) {
  const flags = new Map();
  return {
    flags,
    setter(path, enabled) {
      const result = behavior(path, enabled, flags);
      if (result !== false) flags.set(path, enabled);
      if (path === workspace) events.push(`workspace:${enabled ? 'on' : 'off'}`);
      if (path === root) events.push(`root:${enabled ? 'on' : 'off'}`);
      return result;
    },
  };
}

test('pre-seal flag observation failure neither adopts nor clears an unproved caller flag', async () => {
  const { root, workspace, policy, command } = await fixture('preseal-observation-failure');
  const events = [];
  const simulated = simulatedFlags(events, root, workspace);
  simulated.flags.set(workspace, true);
  let spawns = 0;
  let publications = 0;
  const supervisor = new CodexExecSupervisor({
    policy,
    sealImmutable: simulated.setter,
    observeImmutable: (path) => {
      if (path === workspace) throw new Error('injected pre-seal observation failure');
      return simulated.flags.get(path) ?? false;
    },
    attestExecutable: async () => attestationFor(policy),
    spawnProcess: () => { spawns += 1; return new LiveChild(); },
    writeLaunch: (...args) => { publications += 1; return writeLaunchRecord(...args); },
  });

  await assert.rejects(() => supervisor.start({ command, policy }), /injected pre-seal observation failure/);
  assert.equal(spawns, 0);
  assert.equal(publications, 0);
  assert.equal(events.filter((event) => event === 'workspace:on' || event === 'workspace:off' || event === 'root:on' || event === 'root:off').length, 0);
  assert.equal(simulated.flags.get(workspace), true, 'an unproved caller-owned flag must not be adopted or cleared');
  assert.equal((await readLaunchIntentRecord(policy, command.launchToken))?.launchToken, command.launchToken);
  assert.equal(await readLaunchRecord(policy, command.launchToken), undefined);
});

test('post-clear observation failure terminates the unpublished child and exactly cleans a partial release', async () => {
  const { root, workspace, policy, command } = await fixture('postclear-observation-failure');
  const events = [];
  const simulated = simulatedFlags(events, root, workspace);
  const child = new LiveChild();
  let injected = false;
  let publications = 0;
  const supervisor = new CodexExecSupervisor({
    policy,
    sealImmutable: simulated.setter,
    observeImmutable: (path) => {
      if (path === workspace && simulated.flags.get(path) === false && events.includes('workspace:off') && !injected) {
        injected = true;
        throw new Error('injected post-clear observation failure');
      }
      return simulated.flags.get(path) ?? false;
    },
    attestExecutable: async () => attestationFor(policy),
    spawnProcess: () => child,
    writeLaunch: (...args) => { publications += 1; return writeLaunchRecord(...args); },
  });

  await assert.rejects(() => supervisor.start({ command, policy }), /post-entry run-root\/workspace immutable release failed before launch publication: injected post-clear observation failure/);
  assert.equal(publications, 0);
  assert.ok(child.signals.includes('SIGTERM'), 'owned child termination must begin synchronously');
  assert.equal(child.closed, true);
  assert.equal((await readLaunchIntentRecord(policy, command.launchToken))?.launchToken, command.launchToken);
  assert.equal(await readLaunchRecord(policy, command.launchToken), undefined);
  assert.equal(simulated.flags.get(workspace), false);
  assert.equal(simulated.flags.get(root), false);
  assert.equal(events.filter((event) => event === 'workspace:off').length, 1);
  assert.equal(events.filter((event) => event === 'root:off').length, 1);
});

test('flag-observer test seam cannot be paired with production spawn', async () => {
  const { policy } = await fixture('observer-production-spawn');
  assert.throws(() => new CodexExecSupervisor({ policy, observeImmutable: () => false }), /immutable flag seams are test-only/);
});

test('entry-only root flags are cleared synchronously before publication and projection while the child is live', async () => {
  const { root, workspace, policy, command } = await fixture('live-order');
  const events = [];
  const child = new LiveChild();
  const simulated = simulatedFlags(events, root, workspace);
  const supervisor = new CodexExecSupervisor({
    policy,
    sealImmutable: simulated.setter,
    attestExecutable: async () => attestationFor(policy),
    spawnProcess: () => {
      events.push('spawn');
      queueMicrotask(() => events.push('microtask-after-spawn'));
      return child;
    },
    writeLaunch: (launchPolicy, launch) => {
      events.push('publish-launch');
      return writeLaunchRecord(launchPolicy, launch);
    },
  });

  await supervisor.start({ command, policy });
  const entryEvents = events.filter((event) => ['workspace:on', 'root:on', 'spawn', 'workspace:off', 'root:off', 'publish-launch', 'microtask-after-spawn'].includes(event));
  assert.deepEqual(entryEvents.slice(0, 6), ['workspace:on', 'root:on', 'spawn', 'workspace:off', 'root:off', 'publish-launch']);
  assert.ok(entryEvents.indexOf('root:off') < entryEvents.indexOf('microtask-after-spawn'), 'an event-loop/await window opened before root release');
  assert.equal(simulated.flags.get(root), false);
  assert.equal(simulated.flags.get(workspace), false);
  await writeFile(join(root, 'STATE.md.tmp-r11d-live'), '# projection can publish before child terminal\n');
  await writeFile(join(workspace, 'entry-release-visible.txt'), 'workspace mutable while child live\n');
  assert.equal(child.closed, false);

  await supervisor.cancel();
  const terminal = await supervisor.wait();
  assert.equal(terminal.outcome, 'cancellation');
  assert.equal(simulated.flags.get(root), false);
  assert.equal(simulated.flags.get(workspace), false);
});

for (const failure of ['clear-throws', 'clear-does-not-stick']) {
  test(`post-entry ${failure} kills the owned child, publishes no receipt, and retains one-shot intent`, async () => {
    const { root, workspace, policy, command } = await fixture(failure);
    const events = [];
    const child = new LiveChild();
    let injected = false;
    const simulated = simulatedFlags(events, root, workspace, (path, enabled) => {
      if (path === workspace && !enabled && !injected) {
        injected = true;
        if (failure === 'clear-throws') throw new Error('injected flag-clear failure');
        return false;
      }
      return true;
    });
    let publications = 0;
    const supervisor = new CodexExecSupervisor({
      policy,
      sealImmutable: simulated.setter,
      attestExecutable: async () => attestationFor(policy),
      spawnProcess: () => child,
      writeLaunch: (...args) => { publications += 1; return writeLaunchRecord(...args); },
    });

    await assert.rejects(() => supervisor.start({ command, policy }), /post-entry run-root\/workspace immutable release failed before launch publication/);
    assert.equal(publications, 0);
    assert.ok(child.signals.includes('SIGTERM'));
    assert.equal((await readLaunchIntentRecord(policy, command.launchToken))?.launchToken, command.launchToken);
    assert.equal(await readLaunchRecord(policy, command.launchToken), undefined);
    assert.equal(simulated.flags.get(root), false);
    assert.equal(simulated.flags.get(workspace), false);
  });
}

test('post-entry identity drift is fenced before publication and replacement flags are not cleared', async () => {
  const { root, workspace, policy, command } = await fixture('identity-drift');
  const events = [];
  const child = new LiveChild();
  let replaced = false;
  const backup = `${workspace}.entered-original`;
  const simulated = simulatedFlags(events, root, workspace, (path, enabled) => {
    if (path === workspace && !enabled && !replaced) {
      replaced = true;
      // Synchronous replacement inside the flag transition models pathname
      // drift at the exact post-entry boundary.
      const renamed = spawnSync('/bin/mv', [workspace, backup], { stdio: 'ignore' });
      assert.equal(renamed.status, 0);
      const created = spawnSync('/bin/mkdir', [workspace], { stdio: 'ignore' });
      assert.equal(created.status, 0);
    }
    return true;
  });
  let publications = 0;
  const supervisor = new CodexExecSupervisor({
    policy,
    sealImmutable: simulated.setter,
    attestExecutable: async () => attestationFor(policy),
    spawnProcess: () => child,
    writeLaunch: (...args) => { publications += 1; return writeLaunchRecord(...args); },
  });
  await assert.rejects(() => supervisor.start({ command, policy }), /identity changed during post-entry immutable release/);
  assert.equal(publications, 0);
  assert.ok(child.signals.includes('SIGTERM'));
  assert.equal(await readLaunchRecord(policy, command.launchToken), undefined);
  assert.equal(simulated.flags.get(root), false);
  assert.equal(events.filter((event) => event === 'workspace:off').length, 1, 'cleanup must not clear a replacement path');
});

test('spawn, invalid-pid, publication, normal-close, error, and cancel paths leave no stale entry flags', async () => {
  for (const path of ['spawn-throw', 'invalid-pid', 'publication-failure', 'normal-close', 'child-error', 'cancel']) {
    const { root, workspace, policy, command } = await fixture(path);
    const events = [];
    const child = new LiveChild(path === 'invalid-pid' ? 0 : 7400);
    const simulated = simulatedFlags(events, root, workspace);
    const supervisor = new CodexExecSupervisor({
      policy,
      sealImmutable: simulated.setter,
      attestExecutable: async () => attestationFor(policy),
      spawnProcess: () => {
        if (path === 'spawn-throw') throw new Error('injected spawn failure');
        return child;
      },
      ...(path === 'publication-failure' ? { writeLaunch: async () => { throw new Error('injected launch publication failure'); } } : {}),
    });

    if (path === 'spawn-throw' || path === 'invalid-pid' || path === 'publication-failure') {
      await assert.rejects(() => supervisor.start({ command, policy }));
    } else {
      await supervisor.start({ command, policy });
      if (path === 'normal-close') child.emit('close', 0, null);
      else if (path === 'child-error') child.emit('error', new Error('injected child error'));
      else await supervisor.cancel();
      await supervisor.wait();
    }
    assert.equal(simulated.flags.get(root), false, `${path}: run root flag`);
    assert.equal(simulated.flags.get(workspace), false, `${path}: workspace flag`);
  }
});

test('native Darwin chflags releases entry roots before a live child terminal', { skip: process.platform !== 'darwin' }, async (t) => {
  const { root, workspace, policy, command } = await fixture('native-chflags');
  const probe = spawnSync('/usr/bin/chflags', ['uchg', root], { stdio: 'ignore' });
  if (probe.status !== 0) {
    t.skip('temporary filesystem does not support caller-owned uchg');
    return;
  }
  spawnSync('/usr/bin/chflags', ['nouchg', root], { stdio: 'ignore' });
  const child = new LiveChild(7500);
  const supervisor = new CodexExecSupervisor({
    policy,
    attestExecutable: async () => attestationFor(policy),
    spawnProcess: () => child,
  });
  const immutable = (path) => {
    const result = spawnSync('/usr/bin/stat', ['-f', '%f', path], { encoding: 'utf8' });
    return result.status === 0 && (Number.parseInt(result.stdout.trim(), 16) & 0x2) !== 0;
  };
  try {
    await supervisor.start({ command, policy });
    assert.equal(child.closed, false);
    assert.equal(immutable(root), false);
    assert.equal(immutable(workspace), false);
    await writeFile(join(root, 'STATE.md.tmp-r11d-native'), '# native projection allowed\n');
    await supervisor.cancel();
    await supervisor.wait();
  } finally {
    // Snapshot/executable evidence intentionally remains immutable for its
    // launch lifetime. The disposable native fixture must nevertheless clean
    // up safely even when an assertion fails.
    spawnSync('/usr/bin/chflags', ['-R', 'nouchg', root], { stdio: 'ignore' });
    spawnSync('/bin/chmod', ['-R', 'u+rwx', root], { stdio: 'ignore' });
    await rm(root, { recursive: true, force: true });
  }
});
