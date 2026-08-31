import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { createCodexHostPolicy, expectedReportPath } from '../dist/codex-host-policy.js';
import { CodexExecSupervisor } from '../dist/codex-exec-supervisor.js';
import { readBoundedUtf8File } from '../dist/codex-effect-records.js';
import { effectPaths, readLaunchIntentRecord, readLaunchRecord, readTerminalRecord } from '../dist/codex-effect-records.js';

class FakeChild extends EventEmitter {
  constructor(onInput) {
    super(); this.pid = 4444; this.stdout = new EventEmitter(); this.stderr = new EventEmitter();
    this.stdin = { end: (text) => { void onInput(String(text)); } };
  }
  kill(signal) { this.killed = signal; return true; }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-codex-supervisor-')); const workspace = join(root, 'workspace'); const skillRoot = join(root, 'skill'); const codexPath = join(root, 'codex');
  await mkdir(join(workspace, '.git'), { recursive: true }); await writeFile(join(root, 'schema.json'), '{}\n');
  await writeFile(codexPath, '#!/bin/sh\nexit 0\n'); await chmod(codexPath, 0o755);
  await mkdir(join(skillRoot, 'worker'), { recursive: true });
  await mkdir(join(root, 'phases', 'phase-a'), { recursive: true });
  await writeFile(join(root, 'PLAN.md'), '# test plan\n');
  await writeFile(join(root, 'DECISIONS.md'), '# test decisions\n');
  await writeFile(join(root, 'phases', 'phase-a', 'STEPS.md'), '# test steps\n');
  await writeFile(join(skillRoot, 'worker', 'ENGINEERING.md'), '# test engineering\n');
  const workerSchemaDigest = (await import('node:crypto')).createHash('sha256').update('{}\n').digest('hex');
  const policy = createCodexHostPolicy({ runId: 'run-supervisor', planDigest: '1'.repeat(64), runRoot: root, workspace, skillRoot, codexPath, codexBinaryDigest: '2'.repeat(64), workerSchemaPath: join(root, 'schema.json'), workerSchemaDigest, maxSupported: true });
  const command = { commandId: 'command-a', runId: policy.runId, phaseId: 'phase-a', stepId: 'step-a', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0, launchToken: 'launch-a' };
  command.commandDigest = digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken });
  return { root, workspace, policy, command: { ...command, planDigest: policy.planDigest } };
}

test('supervisor publishes launch evidence before returning and terminal binds report/result', async () => {
  const { policy, command } = await fixture(); let captured;
  let child;
  const spawnBound = (_executable, args, options) => { child = new FakeChild(async (handoff) => {
    captured = { args, options }; const report = expectedReportPath(policy, command); await mkdir(join(policy.runRoot, 'phases', 'phase-a', 'reports'), { recursive: true }); await writeFile(report, '## Control\nStatus: PASS\n', 'utf8'); const output = args[args.indexOf('--output-last-message') + 1]; const reportDigest = (await import('node:crypto')).createHash('sha256').update(await import('node:fs/promises').then(({ readFile }) => readFile(report))).digest('hex'); await writeFile(output, JSON.stringify({ status: 'PASS', reportPath: report, reportDigest })); child.stdout.emit('data', `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'sandbox boundaries are blocked unless explicitly authorized' } })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', status: 'completed', command: 'cat blocked.md', aggregated_output: 'normal completion' } })}\n`); process.nextTick(() => child.emit('close', 0, null));
  }); return child; };
  const supervisor = new CodexExecSupervisor({ policy, spawnProcess: spawnBound, attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }) });
  const launch = await supervisor.start({ command, policy });
  assert.equal(launch.launchToken, command.launchToken); assert.equal(captured.options.shell, false); assert.equal(captured.options.cwd, policy.workspace);
  const storedLaunch = await readLaunchRecord(policy, command.launchToken); assert.deepEqual(storedLaunch, launch);
  const terminal = await supervisor.wait(); assert.equal(terminal.status, 'PASS'); assert.equal(terminal.outcome, 'normal-completion');
  assert.deepEqual(await readTerminalRecord(policy, command.launchToken), terminal);
});

test('one supervisor cannot launch a successor token', async () => {
  const { policy, command } = await fixture(); const child = new FakeChild(() => undefined);
  const rejected = new CodexExecSupervisor({ policy, spawnProcess: () => child, attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }) });
  await assert.rejects(() => rejected.start({ command: { ...command, modeEpoch: 1 }, policy }), /modeEpoch.*unsupported/);
  const supervisor = new CodexExecSupervisor({ policy, spawnProcess: () => child, attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }) });
  await supervisor.start({ command, policy });
  await assert.rejects(() => supervisor.start({ command: { ...command, launchToken: 'launch-b' }, policy }), /already owns/);
  const cancellation = supervisor.cancel(); child.emit('close', null, 'SIGTERM'); await cancellation; const terminal = await supervisor.wait(); assert.equal(terminal.outcome, 'cancellation');
});

test('malformed structured final output is blocked and distinct from absence', async () => {
  const { policy, command } = await fixture(); let child;
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: (_executable, args) => {
      child = new FakeChild(async () => {
        const output = args[args.indexOf('--output-last-message') + 1];
        await writeFile(output, '{"status":"PASS"}', 'utf8');
        process.nextTick(() => child.emit('close', 0, null));
      });
      return child;
    },
    attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }),
  });
  await supervisor.start({ command, policy });
  const terminal = await supervisor.wait();
  assert.equal(terminal.status, 'BLOCKED');
  assert.equal(terminal.outcome, 'malformed-final-output');
});

test('duplicate structured final output keys are blocked rather than last-write-wins', async () => {
  const { policy, command } = await fixture(); let child;
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: (_executable, args) => {
      child = new FakeChild(async () => {
        const output = args[args.indexOf('--output-last-message') + 1];
        await writeFile(output, '{"status":"PASS","status":"BLOCKED","reportPath":"/tmp/report","reportDigest":"' + '0'.repeat(64) + '"}', 'utf8');
        process.nextTick(() => child.emit('close', 0, null));
      });
      return child;
    },
    attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }),
  });
  await supervisor.start({ command, policy });
  const terminal = await supervisor.wait();
  assert.equal(terminal.status, 'BLOCKED');
  assert.equal(terminal.outcome, 'malformed-final-output');
});

test('authority bytes changed after initial attestation block spawn', async () => {
  const { policy, command } = await fixture(); let spawned = 0;
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; return new FakeChild(() => undefined); },
    attestExecutable: async () => {
      await writeFile(join(policy.skillRoot, 'worker', 'ENGINEERING.md'), '# changed during launch\n');
      return { requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion };
    },
  });
  await assert.rejects(() => supervisor.start({ command, policy }), /authority changed before spawn/);
  assert.equal(spawned, 0);
});

test('the command-selected phase STEPS file is mandatory for launch authority', async () => {
  const { policy, command } = await fixture(); let spawned = 0;
  await (await import('node:fs/promises')).unlink(join(policy.runRoot, 'phases', 'phase-a', 'STEPS.md'));
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; return new FakeChild(() => undefined); },
    attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }),
  });
  await assert.rejects(() => supervisor.start({ command, policy }), /STEPS|authority file/);
  assert.equal(spawned, 0);
});

async function replaceDirectory(path, replacement) {
  const backup = `${path}-old`;
  await rename(path, backup);
  await replacement();
  return backup;
}

/** Hold the final authority read after its bytes have been obtained.  This
 * gives mutation regressions a deterministic window after the final
 * executable/root witness and during aggregate traversal, without relying on
 * timer races. */
async function withAuthorityReadGate(targetPath, mutate) {
  const originalReadFile = fs.readFile;
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  let armed = false;
  let held = false;
  fs.readFile = async (path, ...args) => {
    const bytes = await originalReadFile.call(fs, path, ...args);
    if (armed && !held && String(path) === targetPath) {
      held = true;
      enteredResolve();
      await release;
    }
    return bytes;
  };
  armed = true;
  try {
    await mutate({ entered, release: () => releaseResolve() });
  } finally {
    fs.readFile = originalReadFile;
  }
}

function replacementTreeSpec(policy) {
  return async () => {
    await mkdir(join(policy.runRoot, 'workspace', '.git'), { recursive: true });
    await mkdir(join(policy.runRoot, 'skill', 'worker'), { recursive: true });
    await mkdir(join(policy.runRoot, 'phases', 'phase-a'), { recursive: true });
    await writeFile(join(policy.runRoot, 'PLAN.md'), '# test plan\n');
    await writeFile(join(policy.runRoot, 'DECISIONS.md'), '# test decisions\n');
    await writeFile(join(policy.runRoot, 'phases', 'phase-a', 'STEPS.md'), '# test steps\n');
    await writeFile(join(policy.runRoot, 'skill', 'worker', 'ENGINEERING.md'), '# test engineering\n');
    await writeFile(join(policy.runRoot, 'schema.json'), '{}\n');
  };
}

test('immutable launch image rejects executable replacement after final attestation while authority is blocked', async () => {
  const { policy, command } = await fixture(); let spawned = 0; let calls = 0; let mutation;
  const base = { requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion };
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; return new FakeChild(() => undefined); },
    attestExecutable: async () => {
      calls += 1;
      if (calls === 3) {
        mutation = withAuthorityReadGate(join(policy.runRoot, 'phases', 'phase-a', 'STEPS.md'), async ({ entered, release }) => {
          await entered;
          await writeFile(policy.codexPath, '#!/bin/sh\nreplacement-after-final-attestation\n');
          release();
        });
      }
      return base;
    },
  });
  await assert.rejects(() => supervisor.start({ command, policy }), /executable changed before spawn/);
  await mutation;
  assert.equal(calls, 3); assert.equal(spawned, 0);
  assert.equal((await readLaunchIntentRecord(policy, command.launchToken))?.launchToken, command.launchToken);
});

test('immutable launch directories reject workspace and run-root replacement after final inspection', async () => {
  for (const [label, replace] of [
    ['workspace', async (policy) => replaceDirectory(policy.workspace, async () => mkdir(policy.workspace, { recursive: true }))],
    ['run root', async (policy) => replaceDirectory(policy.runRoot, replacementTreeSpec(policy))],
  ]) {
    const { policy, command } = await fixture(); let spawned = 0; let calls = 0; let mutation;
    const base = { requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion };
    const supervisor = new CodexExecSupervisor({
      policy,
      spawnProcess: () => { spawned += 1; return new FakeChild(() => undefined); },
      attestExecutable: async () => {
        calls += 1;
        if (calls === 3) {
          mutation = withAuthorityReadGate(join(policy.runRoot, 'phases', 'phase-a', 'STEPS.md'), async ({ entered, release }) => {
            await entered;
            await replace(policy);
            release();
          });
        }
        return base;
      },
    });
    await assert.rejects(() => supervisor.start({ command, policy }), /authority|workspace|run root/, label);
    await mutation;
    assert.equal(spawned, 0, label);
  }
});

test('authority snapshot rejects same-byte inode replacement and transient mutate/restore after STEPS read', async () => {
  for (const [label, mutate] of [
    ['same-byte inode replacement', async (policy) => {
      const steps = join(policy.runRoot, 'phases', 'phase-a', 'STEPS.md'); const replacement = `${steps}.replacement`;
      await writeFile(replacement, '# test steps\n'); await rename(replacement, steps);
    }],
    ['transient mutate/restore', async (policy) => {
      const steps = join(policy.runRoot, 'phases', 'phase-a', 'STEPS.md');
      await writeFile(steps, '# transient mutation\n'); await writeFile(steps, '# test steps\n');
    }],
  ]) {
    const { policy, command } = await fixture(); let spawned = 0; let calls = 0; let mutation;
    const base = { requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion };
    const supervisor = new CodexExecSupervisor({
      policy,
      spawnProcess: () => { spawned += 1; return new FakeChild(() => undefined); },
      attestExecutable: async () => {
        calls += 1;
        if (calls === 3) {
          mutation = withAuthorityReadGate(join(policy.runRoot, 'phases', 'phase-a', 'STEPS.md'), async ({ entered, release }) => {
            await entered;
            await mutate(policy);
            release();
          });
        }
        return base;
      },
    });
    await assert.rejects(() => supervisor.start({ command, policy }), /authority|STEPS/, label);
    await mutation;
    assert.equal(spawned, 0, label);
  }
});

test('all parent authority and identity mutations after reservation fence spawn', async () => {
  const cases = [
    ['dynamic STEPS bytes', async (policy) => writeFile(join(policy.runRoot, 'phases', 'phase-a', 'STEPS.md'), '# changed after reservation\n')],
    ['instruction bytes', async (policy) => writeFile(join(policy.runRoot, 'DECISIONS.md'), '# changed after reservation\n')],
    ['skill bytes', async (policy) => writeFile(join(policy.skillRoot, 'worker', 'ENGINEERING.md'), '# changed after reservation\n')],
    ['workspace identity', async (policy) => replaceDirectory(policy.workspace, async () => mkdir(policy.workspace, { recursive: true }))],
    ['run-root identity', async (policy) => replaceDirectory(policy.runRoot, async () => {
      await mkdir(join(policy.runRoot, 'workspace'), { recursive: true });
      await mkdir(join(policy.runRoot, 'skill', 'worker'), { recursive: true });
      await mkdir(join(policy.runRoot, 'phases', 'phase-a'), { recursive: true });
      await writeFile(join(policy.runRoot, 'PLAN.md'), '# test plan\n');
      await writeFile(join(policy.runRoot, 'DECISIONS.md'), '# test decisions\n');
      await writeFile(join(policy.runRoot, 'phases', 'phase-a', 'STEPS.md'), '# test steps\n');
      await writeFile(join(policy.runRoot, 'skill', 'worker', 'ENGINEERING.md'), '# test engineering\n');
      await writeFile(join(policy.runRoot, 'schema.json'), '{}\n');
    })],
  ];
  for (const [label, mutate] of cases) {
    const { policy, command } = await fixture(); let spawned = 0; let calls = 0; let mutation;
    const base = { requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion };
    const intentPath = effectPaths(policy, command.launchToken).launchIntent;
    const supervisor = new CodexExecSupervisor({
      policy,
      spawnProcess: () => { spawned += 1; return new FakeChild(() => undefined); },
      attestExecutable: async () => {
        calls += 1;
        if (calls === 3) {
          mutation = (async () => {
            for (let attempt = 0; attempt < 1000; attempt += 1) {
              try { await access(intentPath); break; }
              catch { await new Promise((resolve) => setImmediate(resolve)); }
              if (attempt === 999) throw new Error('launch intent reservation did not appear');
            }
            await mutate(policy);
          })();
          await mutation;
        }
        return base;
      },
    });
    await assert.rejects(() => supervisor.start({ command, policy }), /authority|run root\/workspace/ , label);
    await mutation;
    assert.equal(spawned, 0, label);
  }
});

test('raw-byte reads reject invalid UTF-8 and distinguish byte aliases', async () => {
  const { root } = await fixture(); const path = join(root, 'invalid-result.json');
  await writeFile(path, Buffer.from([0xc3, 0x28]));
  const first = await readBoundedUtf8File(path, 'invalid result', 1024);
  assert.equal(first.kind, 'invalid-utf8');
  await writeFile(path, Buffer.from([0xe2, 0x28, 0xa1]));
  const second = await readBoundedUtf8File(path, 'invalid result', 1024);
  assert.equal(second.kind, 'invalid-utf8');
  assert.notEqual(first.digest, second.digest);
  const reportPath = join(root, 'invalid-report.md');
  await writeFile(reportPath, Buffer.from([0xc3, 0x28]));
  const report = await readBoundedUtf8File(reportPath, 'invalid report', 1024);
  assert.equal(report.kind, 'invalid-utf8');
  await writeFile(reportPath, Buffer.from([0xe2, 0x28, 0xa1]));
  const reportAlias = await readBoundedUtf8File(reportPath, 'invalid report', 1024);
  assert.equal(reportAlias.kind, 'invalid-utf8');
  assert.notEqual(report.digest, reportAlias.digest);
});

test('invalid UTF-8 report bytes cannot produce a passing terminal', async () => {
  const { policy, command } = await fixture(); let child;
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: (_executable, args) => {
      child = new FakeChild(async () => {
        const report = expectedReportPath(policy, command);
        await mkdir(join(policy.runRoot, 'phases', 'phase-a', 'reports'), { recursive: true });
        const reportBytes = Buffer.from([0xc3, 0x28]);
        await writeFile(report, reportBytes);
        const output = args[args.indexOf('--output-last-message') + 1];
        const reportDigest = createHash('sha256').update(reportBytes).digest('hex');
        await writeFile(output, JSON.stringify({ status: 'PASS', reportPath: report, reportDigest }), 'utf8');
        process.nextTick(() => child.emit('close', 0, null));
      });
      return child;
    },
    attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }),
  });
  await supervisor.start({ command, policy });
  const terminal = await supervisor.wait();
  assert.equal(terminal.status, 'BLOCKED');
  assert.equal(terminal.outcome, 'malformed-final-output');
});

test('launch intent is durable before spawn and blocks a retry after launch publication fails', async () => {
  const { policy, command } = await fixture(); let spawned = 0; let child;
  const first = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; child = new FakeChild(() => undefined); child.pid = 0; return child; },
    attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }),
  });
  await assert.rejects(() => first.start({ command, policy }), /valid pid/);
  const intent = await readLaunchIntentRecord(policy, command.launchToken);
  assert.equal(intent?.launchToken, command.launchToken);
  assert.equal(await readLaunchRecord(policy, command.launchToken), undefined);

  const second = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; return new FakeChild(() => undefined); },
    attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }),
  });
  await assert.rejects(() => second.start({ command, policy }), /launch intent already exists/);
  assert.equal(spawned, 1);
});

test('executable is re-attested immediately before reserving and spawning', async () => {
  const { policy, command } = await fixture(); let spawned = 0; let calls = 0;
  const base = { requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion };
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; return new FakeChild(() => undefined); },
    attestExecutable: async () => {
      calls += 1;
      if (calls === 1) { await writeFile(policy.codexPath, '#!/bin/sh\nreplacement\n'); return base; }
      return { ...base, digest: 'f'.repeat(64) };
    },
  });
  await assert.rejects(() => supervisor.start({ command, policy }), /executable changed before spawn/);
  assert.equal(calls, 2);
  assert.equal(spawned, 0);
  assert.equal(await readLaunchIntentRecord(policy, command.launchToken), undefined);
});

test('executable is re-attested after launch reservation before spawn', async () => {
  const { policy, command } = await fixture(); let spawned = 0; let calls = 0;
  const base = { requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion };
  const intentPath = effectPaths(policy, command.launchToken).launchIntent;
  let mutation;
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; return new FakeChild(() => undefined); },
    attestExecutable: async () => {
      calls += 1;
      if (calls === 2) {
        // Hold the mutation until the O_EXCL reservation is visible. The
        // third attestation therefore exercises the actual post-reservation
        // await gap rather than the earlier preflight witness.
        mutation = (async () => {
          for (let attempt = 0; attempt < 1000; attempt += 1) {
            try { await access(intentPath); break; }
            catch { await new Promise((resolve) => setImmediate(resolve)); }
            if (attempt === 999) throw new Error('launch intent reservation did not appear');
          }
          await writeFile(policy.codexPath, '#!/bin/sh\nreplacement-after-reservation\n');
        })();
      }
      if (calls === 3) {
        await mutation;
        return { ...base, digest: 'f'.repeat(64) };
      }
      return base;
    },
  });
  await assert.rejects(() => supervisor.start({ command, policy }), /executable changed before spawn/);
  await mutation;
  assert.equal(calls, 3);
  assert.equal(spawned, 0);
  assert.equal((await readLaunchIntentRecord(policy, command.launchToken))?.launchToken, command.launchToken);
});

test('cancellation during final executable attestation fences spawn', async () => {
  const { policy, command } = await fixture(); const controller = new AbortController(); let spawned = 0; let calls = 0;
  const base = { requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion };
  const supervisor = new CodexExecSupervisor({
    policy,
    spawnProcess: () => { spawned += 1; return new FakeChild(() => undefined); },
    attestExecutable: async () => {
      calls += 1;
      if (calls === 3) controller.abort();
      return base;
    },
  });
  await assert.rejects(() => supervisor.start({ command, policy, signal: controller.signal }), /launch was cancelled before spawn/);
  assert.equal(calls, 3);
  assert.equal(spawned, 0);
  assert.equal((await readLaunchIntentRecord(policy, command.launchToken))?.launchToken, command.launchToken);
});
