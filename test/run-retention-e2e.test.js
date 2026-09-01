import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectRetentionRun, prepareManualAcceptance, sealRetentionRun, validateRunReceipt } from '../dist/run-retention.js';
import { retentionFixture, syntheticPlatform } from './fixtures/session-lifecycle/retention-helper.mjs';

test('accepted run publishes one receipt before exact Body cleanup and preserves Seed, Custody, and unknown siblings', async () => {
  const fixture = await retentionFixture(); await prepareManualAcceptance(fixture.runRoot, fixture.acceptanceSource);
  const before = await Promise.all(['.kernel/CURRENT', '.codex-effects/token', 'unknown.txt', 'PLAN.md', 'STATE.md', 'OUTCOME.md'].map((name) => readFile(join(fixture.runRoot, name), 'utf8')));
  const dry = await sealRetentionRun(fixture.runRoot, { mode: 'dry-run', platform: syntheticPlatform }); assert.equal(dry.status, 'READY'); assert.equal(dry.body.files, 2);
  const result = await sealRetentionRun(fixture.runRoot, { mode: 'accept', platform: syntheticPlatform }); assert.equal(result.status, 'SEALED');
  const names = await readdir(fixture.runRoot); assert.ok(names.includes('RUN-RECEIPT.json')); assert.ok(!names.includes('.work')); assert.ok(!names.some((name) => name.startsWith('.work.prune-'))); assert.ok(!names.includes('.lunacy-run-finalization.json')); assert.ok(!names.includes('.lunacy-parent-acceptance.json'));
  const receipt = JSON.parse(await readFile(join(fixture.runRoot, 'RUN-RECEIPT.json'), 'utf8')); assert.deepEqual(validateRunReceipt(receipt), receipt);
  assert.deepEqual(await Promise.all(['.kernel/CURRENT', '.codex-effects/token', 'unknown.txt', 'PLAN.md', 'STATE.md', 'OUTCOME.md'].map((name) => readFile(join(fixture.runRoot, name), 'utf8'))), before);
  assert.equal((await inspectRetentionRun(fixture.runRoot)).code, 'SEALED_CLEAN'); assert.equal((await sealRetentionRun(fixture.runRoot, { mode: 'accept', platform: syntheticPlatform })).status, 'ALREADY_SEALED');
});
