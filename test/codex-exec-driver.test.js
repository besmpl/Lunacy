import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/canonical.js';
import { createCodexHostPolicy, expectedReportPath } from '../dist/codex-host-policy.js';
import { effectPaths } from '../dist/codex-effect-records.js';
import { CodexExecDriver } from '../dist/codex-exec-driver.js';

class Child extends EventEmitter { constructor() { super(); this.pid = 5555; this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.stdin = { end: () => undefined }; } kill() { return true; } }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-codex-driver-')); const workspace = join(root, 'workspace'); const skillRoot = join(root, 'skill'); await mkdir(join(workspace, '.git'), { recursive: true }); await writeFile(join(root, 'schema.json'), '{}\n');
  await mkdir(join(skillRoot, 'worker'), { recursive: true }); await mkdir(join(root, 'phases', 'phase-a'), { recursive: true });
  await writeFile(join(root, 'PLAN.md'), '# test plan\n');
  await writeFile(join(root, 'DECISIONS.md'), '# test decisions\n');
  await writeFile(join(root, 'phases', 'phase-a', 'STEPS.md'), '# test steps\n');
  await writeFile(join(skillRoot, 'worker', 'ENGINEERING.md'), '# test engineering\n');
  const workerSchemaDigest = (await import('node:crypto')).createHash('sha256').update('{}\n').digest('hex');
  const policy = createCodexHostPolicy({ runId: 'run-driver', planDigest: 'a'.repeat(64), runRoot: root, workspace, skillRoot, codexPath: '/opt/homebrew/bin/codex', codexBinaryDigest: 'b'.repeat(64), workerSchemaPath: join(root, 'schema.json'), workerSchemaDigest });
  const command = { commandId: 'command-driver', runId: policy.runId, phaseId: 'phase-a', stepId: 'step-a', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0, launchToken: 'launch-driver', state: 'CLAIMED' };
  command.commandDigest = digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken });
  return { root, policy, command };
}

test('driver echoes exact token/digest and observe fails closed for malformed evidence', async () => {
  const { policy, command } = await fixture(); let child;
  const driver = new CodexExecDriver({ policy, supervisor: { spawnProcess: (_executable, args) => { child = new Child(); return child; }, attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }) } });
  const promise = driver.dispatch(command, command.launchToken); while (!child) await new Promise((resolve) => setImmediate(resolve)); child.emit('close', null, 'SIGTERM');
  const receipt = await promise.catch((error) => { throw error; });
  assert.equal(receipt.launchToken, command.launchToken); assert.equal(receipt.commandDigest, command.commandDigest); assert.match(receipt.ref.id, /^codex-launch:/);
  const observed = await driver.observe(command.launchToken); assert.equal(observed?.commandDigest, command.commandDigest);
  assert.equal(await driver.observe('missing-token'), undefined);
});

test('driver rejects dispatch for wrong token or command digest before spawning', async () => {
  const { policy, command } = await fixture(); let spawned = false;
  const driver = new CodexExecDriver({ policy, supervisor: { spawnProcess: () => { spawned = true; return new Child(); }, attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }) } });
  await assert.rejects(() => driver.dispatch(command, 'wrong-token'), /token mismatch/); assert.equal(spawned, false);
  await assert.rejects(() => driver.dispatch({ ...command, commandDigest: 'd'.repeat(64) }, command.launchToken), /digest mismatch/); assert.equal(spawned, false);
});

test('restart terminal reconciliation rejects authority and executable drift', async () => {
  const { policy, command } = await fixture(); let child; let executableDigest = policy.codexBinaryDigest;
  const supervisorOptions = {
    spawnProcess: () => { child = new Child(); return child; },
    attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: executableDigest, version: policy.codexVersion }),
  };
  const driver = new CodexExecDriver({ policy, supervisor: supervisorOptions });
  await driver.dispatch(command, command.launchToken);
  child.emit('close', 0, null);
  const terminal = await driver.waitTerminal(command.launchToken);
  assert.equal(terminal?.status, 'BLOCKED');

  const restarted = new CodexExecDriver({ policy, supervisor: supervisorOptions });
  await writeFile(join(policy.skillRoot, 'worker', 'ENGINEERING.md'), '# changed after launch\n');
  assert.equal(await restarted.terminal(command.launchToken), undefined);

  // Restore the authority bytes and prove the executable attestation is also
  // required, rather than relying only on the persisted policy literals.
  await writeFile(join(policy.skillRoot, 'worker', 'ENGINEERING.md'), '# test engineering\n');
  executableDigest = 'f'.repeat(64);
  assert.equal(await restarted.terminal(command.launchToken), undefined);
});

test('restart terminal reconciliation binds exact result and report bytes', async () => {
  const { policy, command } = await fixture(); let child;
  const supervisorOptions = {
    spawnProcess: (_executable, args) => {
      child = new Child();
      void (async () => {
        const report = expectedReportPath(policy, command); await mkdir(join(policy.runRoot, 'phases', 'phase-a', 'reports'), { recursive: true });
        const reportBytes = Buffer.from('## Control\nStatus: PASS\n', 'utf8'); await writeFile(report, reportBytes);
        const outputBytes = Buffer.from(JSON.stringify({ status: 'PASS', reportPath: report, reportDigest: createHash('sha256').update(reportBytes).digest('hex') }), 'utf8');
        const output = args[args.indexOf('--output-last-message') + 1]; await writeFile(output, outputBytes); child.emit('close', 0, null);
      })();
      return child;
    },
    attestExecutable: async () => ({ requestedPath: policy.codexPath, physicalPath: policy.codexPath, requestedPathIsSymlink: false, uid: 1, gid: 1, mode: '755', digest: policy.codexBinaryDigest, version: policy.codexVersion }),
  };
  const driver = new CodexExecDriver({ policy, supervisor: supervisorOptions });
  await driver.dispatch(command, command.launchToken);
  assert.equal((await driver.waitTerminal(command.launchToken))?.status, 'PASS');
  const paths = effectPaths(policy, command.launchToken);
  const reportPath = expectedReportPath(policy, command);
  await writeFile(reportPath, Buffer.from([0xc3, 0x28]));
  assert.equal(await driver.terminal(command.launchToken), undefined);
  await writeFile(paths.output, Buffer.from([0xc3, 0x28]));
  assert.equal(await driver.terminal(command.launchToken), undefined);
});
