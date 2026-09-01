import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeRetentionPlatform } from '../dist/run-retention-platform.js';

test('native platform mount census is closed, bounded, and deterministic for a trusted Body root', async () => {
  if (!['darwin', 'linux'].includes(process.platform)) return;
  const root = await mkdtemp(join(tmpdir(), 'lunacy-platform-')); const body = join(root, '.work'); await mkdir(body); const stat = await import('node:fs/promises').then(({ stat }) => stat(body)); const identity = { path: body, identity: { dev: String(stat.dev), ino: String(stat.ino) } };
  const first = await nativeRetentionPlatform.captureMountIdentity(identity); const second = await nativeRetentionPlatform.captureMountIdentity(identity); assert.equal(first.schema, 'lunacy-retention-mounts/v1'); assert.deepEqual(second, first); assert.ok(first.mountPoints.length > 0);
});

test('native publication gate refuses a live descriptor into Body', async () => {
  if (!['darwin', 'linux'].includes(process.platform)) return;
  const root = await mkdtemp(join(tmpdir(), 'lunacy-platform-handle-')); const body = join(root, '.work'); await mkdir(body); const file = join(body, 'open'); await writeFile(file, 'held'); const handle = await open(file, 'r');
  const identity = async (path) => { const value = await stat(path); return { path, identity: { dev: String(value.dev), ino: String(value.ino) } }; };
  const runtimeIdentity = await identity(process.cwd()); const runIdentity = await identity(root); const bodyIdentity = await identity(body);
  try { await assert.rejects(() => nativeRetentionPlatform.captureRunSealQuiescence(runtimeIdentity, runIdentity, bodyIdentity), /WRITER_ACTIVE/); } finally { await handle.close(); }
});

test('native publication gate refuses a live owned process group without a Body descriptor', async () => {
  if (!['darwin', 'linux'].includes(process.platform)) return;
  const root = await mkdtemp(join(tmpdir(), 'lunacy-platform-process-')); const body = join(root, '.work'); await mkdir(body);
  const identity = async (path) => { const value = await stat(path); return { path, identity: { dev: String(value.dev), ino: String(value.ino) } }; };
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', root], { cwd: tmpdir(), detached: true, stdio: 'ignore' }); await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    const runtimeIdentity = await identity(process.cwd()); const runIdentity = await identity(root); const bodyIdentity = await identity(body); await assert.rejects(() => nativeRetentionPlatform.captureRunSealQuiescence(runtimeIdentity, runIdentity, bodyIdentity), /WRITER_ACTIVE/);
    const changed = await identity(body); changed.identity.ino = String(BigInt(changed.identity.ino) + 1n); await assert.rejects(() => nativeRetentionPlatform.captureMountIdentity(changed), /identity changed/);
  } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
});
