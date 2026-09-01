import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { inspectRetentionRun, prepareManualAcceptance, sealRetentionRun } from '../dist/run-retention.js';
import { retentionFixture, syntheticPlatform } from './fixtures/session-lifecycle/retention-helper.mjs';

for (const cut of ['RECEIPT_RENAME', 'RECEIPT_RENAME_FSYNC', 'CLEANUP_ENTRY', 'TOMBSTONE_REMOVED', 'ACCEPTANCE_REMOVED']) test(`receipt-published cleanup resumes after ${cut}`, async () => {
  const fixture = await retentionFixture(); await prepareManualAcceptance(fixture.runRoot, fixture.acceptanceSource); let fired = false;
  await assert.rejects(() => sealRetentionRun(fixture.runRoot, { mode: 'accept', platform: syntheticPlatform, fault(point) { if (!fired && point === cut) { fired = true; throw new Error(`cut:${cut}`); } } }), new RegExp(`cut:${cut}`));
  assert.equal((await inspectRetentionRun(fixture.runRoot)).nextAction, 'RESUME_EXACT'); const resumed = await sealRetentionRun(fixture.runRoot, { mode: 'resume', platform: syntheticPlatform }); assert.equal(resumed.status, 'RESUMED');
  const names = await readdir(fixture.runRoot); assert.ok(names.includes('RUN-RECEIPT.json')); assert.ok(!names.includes('.work')); assert.ok(!names.some((name) => name.startsWith('.work.prune-')));
});

for (const target of [1, 2, 3]) test(`every cleanup cursor boundary is restartable (${target})`, async () => {
  const fixture = await retentionFixture(); await prepareManualAcceptance(fixture.runRoot, fixture.acceptanceSource); let count = 0;
  await assert.rejects(() => sealRetentionRun(fixture.runRoot, { mode: 'accept', platform: syntheticPlatform, fault(point) { if (point === 'CLEANUP_ENTRY' && ++count === target) throw new Error(`cleanup-cut:${target}`); } }), new RegExp(`cleanup-cut:${target}`));
  assert.equal((await sealRetentionRun(fixture.runRoot, { mode: 'resume', platform: syntheticPlatform })).status, 'RESUMED');
});

test('crash after marker removal is already a clean sealed state', async () => {
  const fixture = await retentionFixture(); await prepareManualAcceptance(fixture.runRoot, fixture.acceptanceSource);
  await assert.rejects(() => sealRetentionRun(fixture.runRoot, { mode: 'accept', platform: syntheticPlatform, fault(point) { if (point === 'MARKER_REMOVED') throw new Error('marker-cut'); } }), /marker-cut/);
  assert.equal((await inspectRetentionRun(fixture.runRoot)).code, 'SEALED_CLEAN'); assert.equal((await sealRetentionRun(fixture.runRoot, { mode: 'resume', platform: syntheticPlatform })).status, 'ALREADY_SEALED');
});
