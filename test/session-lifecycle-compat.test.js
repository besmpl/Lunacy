import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeRunKernel } from '../dist/index.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { transition } from '../dist/bridge.js';
import { createCodexHostPolicy, expectedReportPath } from '../dist/codex-host-policy.js';

const root = resolve('.');
const baseline = JSON.parse(await readFile(join(root, 'test/fixtures/session-lifecycle/baseline.json'), 'utf8'));
const plan = { phaseId: 'compat', gateRequired: true, steps: [{ stepId: 'deliver' }] };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ref = (id, value) => ({ id, scope: 'compat', digest: digest(value), bytes: canonicalString(value) });
function input(runId, eventId, event, snapshot, launchToken) { return { runId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}), identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0, authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) }, event }; }
async function treeBytes(directory, prefix = '') { const out = []; for (const name of (await readdir(directory)).sort()) { const path = join(directory, name); const info = await stat(path); const relative = prefix ? `${prefix}/${name}` : name; if (info.isDirectory()) out.push(...await treeBytes(path, relative)); else out.push([relative, sha(await readFile(path))]); } return out; }

test('frozen public journey, committed restart, exports, bridge paths, and report path stay exact', async () => {
  const runRoot = await mkdtemp(join(tmpdir(), 'lunacy-session-compat-'));
  const kernel = makeRunKernel({ plan, rootDir: runRoot }); const yields = []; const events = [];
  const start = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
  events.push(start); let value = await kernel.advance(input('compat-run', 'start', start)); yields.push(value);
  const resume = { kind: 'RESUME' }; events.push(resume); value = await kernel.advance(input('compat-run', 'resume', resume, value.snapshot)); yields.push(value);
  const request = JSON.parse(value.receipt.bytes);
  const receiptEvent = { kind: 'DISPATCH_RECEIPT', ref: ref('receipt', { launchToken: request.launchToken, commandDigest: request.commandDigest }) }; events.push(receiptEvent); value = await kernel.advance(input('compat-run', 'receipt', receiptEvent, value.snapshot, request.launchToken)); yields.push(value);
  const workerEvent = { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) }; events.push(workerEvent); value = await kernel.advance(input('compat-run', 'worker', workerEvent, value.snapshot, request.launchToken)); yields.push(value);
  const token = JSON.parse(value.artifacts[0].bytes).token; const gateSnapshot = value.snapshot;
  const passEvent = { kind: 'PARENT_DECISION', token, value: 'PASS' }; events.push(passEvent); value = await kernel.advance(input('compat-run', 'pass', passEvent, value.snapshot)); yields.push(value);
  assert.deepEqual(yields.map((item) => sha(canonicalString(item))), baseline.yieldDigests);
  assert.deepEqual(events.map((item) => sha(canonicalString(item))), baseline.eventDigests); const currentBytes = await readFile(join(runRoot, '.kernel/CURRENT')); assert.equal(sha(currentBytes), baseline.stateCurrentDigest); const current = JSON.parse(currentBytes); assert.equal(sha(await readFile(join(runRoot, '.kernel/generations', `g${current.generation}`, 'state.json'))), baseline.stateDigest);
  const beforeReplay = await treeBytes(runRoot); const replay = await makeRunKernel({ plan, rootDir: runRoot }).advance(input('compat-run', 'pass', { kind: 'PARENT_DECISION', token, value: 'PASS' }, gateSnapshot)); assert.equal(sha(canonicalString(replay)), baseline.replayDigest); assert.deepEqual(await treeBytes(runRoot), beforeReplay); assert.equal((await readdir(runRoot)).includes('.work'), false);
  const bridgeRoot = await mkdtemp(join(tmpdir(), 'lunacy-session-bridge-')); const projected = await transition({ runDir: bridgeRoot, runId: 'bridge-run', mode: 'runtime', plan }, { event: start, eventId: 'start' }); assert.deepEqual({ statePath: projected.projection.statePath.slice(bridgeRoot.length), stepsPath: projected.projection.stepsPath.slice(bridgeRoot.length) }, baseline.bridge);
  const api = await import('../dist/index.js'); assert.deepEqual(Object.keys(api).sort(), baseline.exports); const packageJson = JSON.parse(await readFile(join(root, 'package.json'))); assert.deepEqual(Object.keys(packageJson.exports).sort(), baseline.packageExports);
  const policy = createCodexHostPolicy({ runId: 'compat-run', planDigest: digest(plan), runRoot, workspace: root, skillRoot: root, codexPath: process.execPath, codexBinaryDigest: 'a'.repeat(64), workerSchemaPath: join(root, 'schemas/codex-worker-result.schema.json'), workerSchemaDigest: 'b'.repeat(64) });
  assert.equal(expectedReportPath(policy, { phaseId: 'compat', stepId: 'deliver', attemptEpoch: 3 }), join(runRoot, 'phases/compat/reports/deliver-worker-3.md'));
});
