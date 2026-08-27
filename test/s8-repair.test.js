import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError, transition } from '../dist/bridge.js';
import { BeadsPlanSource, BeadsUnavailable } from '../dist/beads.js';
import { digest } from '../dist/canonical.js';

const root = process.cwd();
const plan = { phaseId: 's8', steps: [{ stepId: 'one', goal: 'one' }] };
const start = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
const options = (runDir) => ({ runDir, runId: 's8-permissions', mode: 'runtime', plan });

test('runtime bridge rejects a group/world-writable run root before any durable mutation', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s8-run-root-'));
  await chmod(runDir, 0o777);
  await assert.rejects(() => transition(options(runDir), { event: start, eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
  await assert.rejects(() => readFile(join(runDir, '.kernel', 'CURRENT')));
});

test('runtime bridge rejects an unsafe .kernel or projection parent', async () => {
  const kernelRoot = await mkdtemp(join(tmpdir(), 'lunacy-s8-kernel-'));
  await mkdir(join(kernelRoot, '.kernel'));
  await chmod(join(kernelRoot, '.kernel'), 0o777);
  await assert.rejects(() => transition(options(kernelRoot), { event: start, eventId: 'kernel' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');

  const projectionRoot = await mkdtemp(join(tmpdir(), 'lunacy-s8-projection-parent-'));
  await mkdir(join(projectionRoot, 'phases', 's8'), { recursive: true });
  await chmod(join(projectionRoot, 'phases', 's8'), 0o777);
  await assert.rejects(() => transition(options(projectionRoot), { event: start, eventId: 'projection' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
  await assert.rejects(() => readFile(join(projectionRoot, '.kernel', 'BRIDGE.json')));
});

test('managed deployment and launcher reject writable runtime surfaces', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-s8-deploy-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: root, stdio: 'pipe' });
  await chmod(join(target, 'runtime'), 0o777);
  assert.throws(() => execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, '--check'], { cwd: root, stdio: 'pipe' }));

  // Restore the runtime directory and attack the trusted entrypoint itself.
  await chmod(join(target, 'runtime'), 0o755);
  await chmod(join(target, 'runtime', 'bridge.mjs'), 0o666);
  const result = spawnSync(process.execPath, [join(target, 'runtime', 'bridge.mjs'), '--help'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trusted launcher|writable|current user/);
});

test('operator-provisioned bd executable must be owned and non-writable by group/world', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'lunacy-s8-bd-'));
  const workspace = join(fixtureRoot, 'workspace');
  await mkdir(join(workspace, '.beads'), { recursive: true });
  const executablePath = join(fixtureRoot, 'bd');
  await writeFile(executablePath, '#!/bin/sh\nprintf \'%s\\n\' \'{}\'\n', 'utf8');
  await chmod(executablePath, 0o777);
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  const source = new BeadsPlanSource({ executablePath, workspace, expectedBinaryDigest });
  await assert.rejects(() => source.capture(), BeadsUnavailable);
});
