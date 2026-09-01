import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { prepareManualAcceptance, sealRetentionRun } from '../dist/run-retention.js';
import { retentionFixture, syntheticPlatform } from './fixtures/session-lifecycle/retention-helper.mjs';

for (const cut of ['STAGED_RECEIPT_FSYNC', 'MARKER_FSYNC', 'BODY_RENAME', 'BODY_RENAME_FSYNC', 'FROZEN_REVALIDATED', 'BEFORE_RECEIPT_RENAME']) test(`pre-publication cut ${cut} retains a complete reversible Body`, async () => {
  const fixture = await retentionFixture(); await prepareManualAcceptance(fixture.runRoot, fixture.acceptanceSource);
  await assert.rejects(() => sealRetentionRun(fixture.runRoot, { mode: 'accept', platform: syntheticPlatform, fault(point) { if (point === cut) throw new Error(`cut:${cut}`); } }), new RegExp(`cut:${cut}`));
  const names = await readdir(fixture.runRoot); assert.ok(!names.includes('RUN-RECEIPT.json')); assert.ok(names.includes('.work') || names.some((name) => name.startsWith('.work.prune-')));
  const result = await sealRetentionRun(fixture.runRoot, { mode: cut === 'STAGED_RECEIPT_FSYNC' ? 'accept' : 'resume', platform: syntheticPlatform }); assert.ok(['SEALED', 'RESUMED'].includes(result.status));
});
