import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitRunBody, withBodyWriterAdmission, withRunFinalizationExclusion } from '../dist/release-admission.js';

async function fixture(policy = 'ON') { const root = await mkdtemp(join(tmpdir(), 'lunacy-retention-admission-')); const installed = join(root, 'skill/runtime'); const run = join(root, 'run'); await mkdir(installed, { recursive: true }); await mkdir(run); await writeFile(join(installed, 'retention-policy.json'), `${JSON.stringify({ abandonment: 'OFF', newBodyAdmission: policy, schema: 'lunacy-retention-policy/v1' })}\n`); return { root, installed, run }; }

test('admission is canonical-ON only, idempotent, and cannot recreate a terminal Body', async () => {
  const off = await fixture('OFF'); await assert.rejects(() => admitRunBody(off.installed, off.run), /admission is OFF/); assert.ok(!(await readdir(off.run)).includes('.work'));
  const on = await fixture(); assert.equal(await admitRunBody(on.installed, on.run), 'ADMITTED'); assert.equal(await admitRunBody(on.installed, on.run), 'ALREADY_ADMITTED');
  await writeFile(join(on.installed, 'retention-policy.json'), `${JSON.stringify({ abandonment: 'OFF', newBodyAdmission: 'OFF', schema: 'lunacy-retention-policy/v1' })}\n`); await withBodyWriterAdmission(on.run, undefined, () => writeFile(join(on.run, '.work/after-disable'), 'recoverable')); assert.equal(await readFile(join(on.run, '.work/after-disable'), 'utf8'), 'recoverable');
  await writeFile(join(on.run, 'RUN-RECEIPT.json'), '{}'); await assert.rejects(() => withBodyWriterAdmission(on.run, undefined, async () => undefined), /terminal or finalizing/);
});

test('writer-before-finalizer completes atomically; finalizer-before-writer refuses at the release fence', async () => {
  const value = await fixture(); await admitRunBody(value.installed, value.run);
  let releaseWriter; const held = new Promise((resolvePromise) => { releaseWriter = resolvePromise; }); let writerEntered = false;
  const writer = withBodyWriterAdmission(value.run, undefined, async () => { writerEntered = true; await held; await writeFile(join(value.run, '.work/complete'), 'complete'); });
  while (!writerEntered) await new Promise((resolvePromise) => setTimeout(resolvePromise, 2)); let finalizerEntered = false; const finalizer = withRunFinalizationExclusion(value.run, undefined, async () => { finalizerEntered = true; });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20)); assert.equal(finalizerEntered, false); releaseWriter(); await writer; await finalizer; assert.equal(await readFile(join(value.run, '.work/complete'), 'utf8'), 'complete');
  await withRunFinalizationExclusion(value.run, undefined, async () => { await assert.rejects(() => withBodyWriterAdmission(value.run, undefined, async () => undefined), /release exclusion is held/); });
});
