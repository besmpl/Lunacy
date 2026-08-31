import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
const plan = { phaseId: 'l1-wide', steps: [{ stepId: 'a' }, { stepId: 'b', dependencies: ['a'] }] };
function input(eventId, event, previous, launchToken) { return { runId: 'l1-run', ...(previous ? { expectedRevision: previous.snapshot.revision } : {}), identity: { runId: 'l1-run', phaseId: 'run', stepId: 'run', attemptEpoch: previous?.snapshot.attemptEpoch ?? 0, authorityEpoch: previous?.snapshot.authorityEpoch ?? 0, barrierEpoch: previous?.snapshot.barrierEpoch ?? 0, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) }, event }; }
const tokenFor = (stepId) => `launch-${digest({ runId: 'l1-run', phaseId: 'l1-wide', stepId, attemptEpoch: 0 }).slice(0, 32)}`;
async function journey(rootDir) {
  const driver = { dispatch(command, launchToken) { return { launchToken, commandDigest: command.commandDigest, ref: { id: 'driver', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } }; } };
  const kernel = composeKernel({ plan, rootDir, maxInFlight: 1, driver }); const outputs = [];
  let y = await kernel.advance(input('start', { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } })); outputs.push(canonicalString(y));
  y = await kernel.advance(input('resume-a', { kind: 'RESUME' }, y)); outputs.push(canonicalString(y));
  y = await kernel.advance(input('worker-a', { kind: 'WORKER_ENVELOPE', ref: { id: 'worker-a', digest: digest({ status: 'DONE' }), bytes: canonicalString({ status: 'DONE' }) } }, y, tokenFor('a'))); outputs.push(canonicalString(y));
  y = await kernel.advance(input('resume-b', { kind: 'RESUME' }, y)); outputs.push(canonicalString(y));
  y = await kernel.advance(input('worker-b', { kind: 'WORKER_ENVELOPE', ref: { id: 'worker-b', digest: digest({ status: 'DONE' }), bytes: canonicalString({ status: 'DONE' }) } }, y, tokenFor('b'))); outputs.push(canonicalString(y));
  const current = JSON.parse(await readFile(join(rootDir, '.kernel', 'CURRENT'), 'utf8'));
  return { outputs, state: await readFile(join(rootDir, '.kernel', 'generations', `g${current.generation}`, 'state.json'), 'utf8') };
}
test('L1 behavior order and replay parity across two independent roots', async (t) => {
  const first = await mkdtemp(join(tmpdir(), 'lunacy-l1-wide-a-')); const second = await mkdtemp(join(tmpdir(), 'lunacy-l1-wide-b-'));
  t.after(() => Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })])); assert.deepEqual(await journey(first), await journey(second));
});
test('L1 cold legacy tolerance has no side effects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-l1-cold-')); t.after(() => rm(root, { recursive: true, force: true }));
  const kernel = composeKernel({ plan, rootDir: root, maxInFlight: 0 }); const first = await kernel.advance(input('cold-start', { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }));
  const dir = join(root, '.kernel', 'reuse'); await mkdir(join(dir, 'nested'), { recursive: true }); await writeFile(join(dir, 'legacy.json'), '{malformed legacy decoration}'); await writeFile(join(dir, 'nested', 'blob'), 'legacy blob bytes');
  const before = { names: (await readdir(dir)).sort(), row: await readFile(join(dir, 'legacy.json')), blob: await readFile(join(dir, 'nested', 'blob')) };
  await kernel.advance(input('cold-resume', { kind: 'RESUME' }, first));
  assert.deepEqual({ names: (await readdir(dir)).sort(), row: await readFile(join(dir, 'legacy.json')), blob: await readFile(join(dir, 'nested', 'blob')) }, before);
});
