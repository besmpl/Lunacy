import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryRetentionBody } from '../dist/run-retention-platform.js';
import { syntheticPlatform } from './fixtures/session-lifecycle/retention-helper.mjs';

async function body() { const root = await mkdtemp(join(tmpdir(), 'lunacy-inventory-')); const path = join(root, '.work'); await mkdir(join(path, 'nested'), { recursive: true }); await writeFile(join(path, 'a'), 'a'); await writeFile(join(path, 'nested/b'), 'bb'); return { root, path }; }

test('Body inventory is pure, deterministic, bounded, and records exact cleanup identities', async () => {
  const fixture = await body(); const first = await inventoryRetentionBody(fixture.path, syntheticPlatform); const second = await inventoryRetentionBody(fixture.path, syntheticPlatform); assert.deepEqual(second, first); assert.equal(first.files, 2); assert.equal(first.bytes, 3); assert.deepEqual(first.cleanupEntries.map((entry) => entry.relativePath), ['.', 'a', 'nested', 'nested/b']);
});

test('Body tree digest uses NUL between every field and tuple for newline paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-inventory-digest-'));
  const path = join(root, '.work');
  await mkdir(path);
  const newlineName = 'line\nbreak';
  await writeFile(join(path, newlineName), 'one');
  await writeFile(join(path, 'plain'), 'twice');
  await chmod(join(path, newlineName), 0o640);
  await chmod(join(path, 'plain'), 0o604);

  const newlineDigest = createHash('sha256').update('one').digest('hex');
  const plainDigest = createHash('sha256').update('twice').digest('hex');
  const nul = Buffer.from([0]);
  const specifiedBytes = Buffer.concat([
    Buffer.from(newlineName), nul, Buffer.from('640'), nul, Buffer.from('3'), nul, Buffer.from(newlineDigest), nul,
    Buffer.from('plain'), nul, Buffer.from('604'), nul, Buffer.from('5'), nul, Buffer.from(plainDigest),
  ]);
  const expectedDigest = createHash('sha256').update(specifiedBytes).digest('hex');

  const inventory = await inventoryRetentionBody(path, syntheticPlatform);
  assert.equal(inventory.treeDigest, expectedDigest);
  assert.deepEqual(inventory.cleanupEntries.map((entry) => entry.relativePath), ['.', newlineName, 'plain']);
});

test('Body inventory refuses symlinks, hardlinks, and nested mount identities', async (context) => {
  const symlinked = await body(); try { await symlink('/tmp', join(symlinked.path, 'escape')); } catch (error) { context.skip(`symlink unavailable: ${error.message}`); return; } await assert.rejects(() => inventoryRetentionBody(symlinked.path, syntheticPlatform), /unsafe file kind/);
  const hardlinked = await body(); await link(join(hardlinked.path, 'a'), join(hardlinked.path, 'alias')); await assert.rejects(() => inventoryRetentionBody(hardlinked.path, syntheticPlatform), /hardlink/);
  const mounted = await body(); const platform = { ...syntheticPlatform, async captureMountIdentity() { return { schema: 'lunacy-retention-mounts/v1', platform: process.platform === 'linux' ? 'linux' : 'darwin', digest: 'c'.repeat(64), mountPoints: ['/', join(mounted.path, 'nested')] }; } }; await assert.rejects(() => inventoryRetentionBody(mounted.path, platform), /mount boundary/);
});
