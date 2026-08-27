import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunKernel } from '../dist/index.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { BeadsPlanSource, BeadsUnavailable } from '../dist/beads.js';

const plan = { phaseId: 's21', steps: [{ stepId: 'step' }] };

function input(runId, eventId, event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }) {
  return { runId, identity: { runId, phaseId: 's21', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId, payloadDigest: digest(event) }, event };
}

test('S21 public makeRunKernel rejects an unsafe existing root before forged authority is read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s21-forged-'));
  try {
    // First create a valid authority, then make its state internally
    // self-consistent while removing the filesystem trust boundary.
    await makeRunKernel({ plan, rootDir: root }).advance(input('forged', 'start'));
    const currentPath = join(root, '.kernel', 'CURRENT');
    const current = JSON.parse(await readFile(currentPath, 'utf8'));
    const statePath = join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.nextAction = 'attacker-selected';
    current.stateDigest = digest(state);
    await writeFile(statePath, `${canonicalString(state)}\n`);
    await writeFile(currentPath, `${canonicalString(current)}\n`);
    await chmod(root, 0o777);
    const before = await readdir(root, { recursive: true });
    await assert.rejects(() => makeRunKernel({ plan, rootDir: root }).advance(input('forged', 'resume', { kind: 'RESUME' })), /ManifestMismatch|group\/world-writable/);
    assert.deepEqual(await readdir(root, { recursive: true }), before);
  } finally { await chmod(root, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('S21 rejects a missing root below a non-sticky writable ancestor without creating it', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'lunacy-s21-ancestor-'));
  const root = join(parent, 'missing', 'run');
  try {
    await chmod(parent, 0o777);
    await assert.rejects(() => makeRunKernel({ plan, rootDir: root }).advance(input('ancestor', 'start')), /ManifestMismatch|group\/world-writable/);
    assert.deepEqual(await readdir(parent), []);
  } finally { await chmod(parent, 0o700).catch(() => undefined); await rm(parent, { recursive: true, force: true }); }
});

test('S21 preserves root device/inode identity across pathname replacement', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'lunacy-s21-identity-'));
  const root = join(parent, 'run');
  const moved = join(parent, 'run-old');
  try {
    await mkdir(root, { mode: 0o700 });
    const kernel = makeRunKernel({ plan, rootDir: root });
    await kernel.advance(input('identity', 'start'));
    await rename(root, moved);
    await mkdir(root, { mode: 0o700 });
    await assert.rejects(() => kernel.advance(input('identity', 'resume', { kind: 'RESUME' })), /ManifestMismatch|identity changed/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('S21 rejects an unsafe staged CURRENT before quarantining it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s21-current-'));
  try {
    await makeRunKernel({ plan, rootDir: root }).advance(input('staged', 'start'));
    const staged = join(root, '.kernel', '.CURRENT.tmp-untrusted');
    await writeFile(staged, '{}');
    await chmod(staged, 0o666);
    await assert.rejects(() => makeRunKernel({ plan, rootDir: root }).advance(input('staged', 'resume', { kind: 'RESUME' })), /ManifestMismatch|group\/world-writable/);
    assert.deepEqual(await readdir(join(root, '.kernel')), ['.CURRENT.tmp-untrusted', 'CURRENT', 'generations', 'quarantine']);
  } finally { await chmod(root, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});

test('S21 bridge/deployment/Beads paths reject an existing unsafe ancestor', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'lunacy-s21-shared-'));
  const target = join(parent, 'skill');
  const workspace = join(parent, 'workspace');
  const executable = join(parent, 'bd');
  try {
    await mkdir(target, { mode: 0o700 });
    await mkdir(join(workspace, '.beads'), { recursive: true, mode: 0o700 });
    await writeFile(executable, '#!/bin/sh\nprintf \'{"build":"x"}\'\n');
    await chmod(executable, 0o755);
    await chmod(parent, 0o777);
    const deployed = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: process.cwd(), encoding: 'utf8' });
    assert.notEqual(deployed.status, 0);
    await assert.rejects(() => new BeadsPlanSource({ executablePath: executable, workspace, expectedBinaryDigest: digest('not-binary') }).capture(), BeadsUnavailable);
  } finally { await chmod(parent, 0o700).catch(() => undefined); await rm(parent, { recursive: true, force: true }); }
});
