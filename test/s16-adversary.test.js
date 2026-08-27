import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeadsPlanSource, BeadsUnavailable } from '../dist/beads.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { BridgeError, deleteBridge, disable, transition } from '../dist/bridge.js';
import { FileArtifactStore } from '../dist/store.js';

const VERSION = '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}';

async function fixture(id = 'x') {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s16-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.beads'), { recursive: true });
  const executablePath = join(root, 'bd');
  const record = JSON.stringify({ _type: 'issue', id, title: id, status: 'open', priority: 0, issue_type: 'task' });
  const encoded = Buffer.from(record).toString('base64');
  await writeFile(executablePath, `#!/bin/sh
if [ "$1" = version ]; then printf '%s' '${VERSION}'; exit 0; fi
printf '%s' '${encoded}' | /usr/bin/base64 -d; printf '\\n'
`);
  await chmod(executablePath, 0o755);
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  return { root, workspace, executablePath, source: new BeadsPlanSource({ executablePath, workspace, expectedBinaryDigest }) };
}

function ack(capture) {
  return { snapshotDigest: capture.snapshot.contentDigest, targetPlanDigest: digest(capture.plan), workspaceIdentity: capture.snapshot.workspaceIdentity, bdCommit: capture.snapshot.bdCommit, binaryDigest: capture.snapshot.binaryDigest };
}

test('S16 rejects an active raw START alias before creating any run-store bytes', async () => {
  const data = await fixture();
  const capture = await data.source.capture();
  const native = { phaseId: capture.plan.phaseId, steps: capture.plan.steps.map(({ stepId, goal }) => ({ stepId, goal })) };
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s16-zero-'));
  const before = await readdir(runDir);
  await assert.rejects(
    () => transition({ runDir, runId: 's16-zero', mode: 'runtime', plan: native, beads: { mode: 'active', source: data.source, acknowledgement: ack(capture) } }, { event: { kind: 'START', intentRef: { id: 'native', digest: digest(native) } }, eventId: 'start' }),
    (error) => error instanceof BridgeError && error.code === 'InvalidDeclaration',
  );
  assert.deepEqual(await readdir(runDir), before);
});

test('S16 replay binding preserves an exact drift yield after bd disappears', async () => {
  const oldData = await fixture('old');
  const oldCapture = await oldData.source.capture();
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s16-replay-'));
  const start = { kind: 'START', intentRef: { id: 'old', digest: digest(oldCapture.plan) } };
  await transition({ runDir, runId: 's16-replay', mode: 'runtime', beads: { mode: 'active', source: oldData.source, acknowledgement: ack(oldCapture) } }, { event: start, eventId: 'start' });
  const changed = await fixture('changed');
  const driftEvent = { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'drift', scope: 'test', digest: digest({ drift: true }), bytes: canonicalString({ drift: true }) } };
  const drift = await transition({ runDir, runId: 's16-replay', mode: 'runtime', beads: { mode: 'active', source: changed.source } }, { event: driftEvent, eventId: 'drift' });
  assert.equal(drift.yield?.kind, 'DECISION_REQUIRED');
  changed.source.capture = async () => { throw new BeadsUnavailable('bd removed'); };
  const replay = await transition({ runDir, runId: 's16-replay', mode: 'runtime', beads: { mode: 'active', source: changed.source } }, { event: driftEvent, eventId: 'drift' });
  assert.equal(canonicalString(replay.yield), canonicalString(drift.yield));
  assert.ok((await readdir(join(runDir, '.kernel'))).some((name) => name.startsWith('BEADS.REPLAY.')));
});

test('S16 Linux child descriptor slots remain fixed when runnable', { skip: process.platform !== 'linux' }, async () => {
  // The platform-specific execution regression lives in S15; keep an
  // independent guard here so a future edit cannot silently remove it.
  const source = await readFile(new URL('../src/beads.ts', import.meta.url), 'utf8');
  assert.match(source, /CHILD_WORKSPACE_FD\s*=\s*4/);
  assert.match(source, /CHILD_BEADS_FD\s*=\s*5/);
});

test('S16 rejects unsafe missing ancestors before deployment or bridge creation', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'lunacy-s16-unsafe-'));
  const target = join(parent, 'new-target');
  await chmod(parent, 0o777);
  const deployed = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { encoding: 'utf8' });
  assert.notEqual(deployed.status, 0);
  assert.deepEqual(await readdir(parent), []);
  const runParent = await mkdtemp(join(tmpdir(), 'lunacy-s16-unsafe-run-'));
  await chmod(runParent, 0o777);
  const runDir = join(runParent, 'run');
  const plan = { phaseId: 's16', steps: [{ stepId: 'x', goal: 'x' }] };
  await assert.rejects(() => transition({ runDir, runId: 's16-unsafe', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
  assert.deepEqual(await readdir(runParent), []);
});

test('S16 event mutation after entry cannot alter the committed identity', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s16-event-'));
  const plan = { phaseId: 's16-event', steps: [{ stepId: 'x', goal: 'x' }] };
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
  const pending = transition({ runDir, runId: 's16-event', mode: 'runtime', plan }, { event, eventId: 'start' });
  event.intentRef.digest = '0'.repeat(64);
  const result = await pending;
  assert.equal(result.yield?.snapshot.revision, 1);
});

test('S16 lifecycle repair uses the exact adoption predecessor and tombstone retry is idempotent', async () => {
  const initial = await fixture('old');
  const captureA = await initial.source.capture();
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s16-life-'));
  await transition({ runDir, runId: 's16-life', mode: 'runtime', beads: { mode: 'active', source: initial.source, acknowledgement: ack(captureA) } }, { event: { kind: 'START', intentRef: { id: 'a', digest: digest(captureA.plan) } }, eventId: 'start' });
  const store = new FileArtifactStore(runDir);
  const loaded = await store.load();
  const quiescent = structuredClone(loaded.state);
  for (const step of Object.values(quiescent.steps)) step.status = 'DONE';
  quiescent.outbox = {};
  quiescent.status = 'ACTIVE';
  await store.commit(loaded.generation, quiescent);
  const changed = await fixture('new');
  const captureB = await changed.source.capture();
  const drift = await transition({ runDir, runId: 's16-life', mode: 'runtime', beads: { mode: 'active', source: changed.source } }, { event: { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'drift', scope: 'test', digest: digest({ changed: true }), bytes: canonicalString({ changed: true }) } }, eventId: 'drift' });
  assert.equal(drift.yield?.kind, 'DECISION_REQUIRED');
  await transition({ runDir, runId: 's16-life', mode: 'runtime', beads: { mode: 'active', source: changed.source, acknowledgement: ack(captureB) } }, { event: { kind: 'PARENT_DECISION', token: drift.yield.token, value: { kind: 'ADOPT', digest: digest(captureB.plan) } }, eventId: 'adopt', expectedRevision: drift.yield.snapshot.revision });
  const manifestPath = join(runDir, '.kernel', 'BRIDGE.json');
  const manifestB = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, canonicalString({ ...manifestB, planDigest: digest(captureA.plan), phaseId: captureA.plan.phaseId }));
  const disabled = await disable({ runDir, runId: 's16-life', mode: 'runtime' });
  assert.equal(disabled.manifest.planDigest, digest(captureB.plan));
  await writeFile(manifestPath, canonicalString({ ...disabled.manifest, planDigest: digest(captureA.plan), phaseId: captureA.plan.phaseId }));
  const deleted = await deleteBridge({ runDir, runId: 's16-life', mode: 'runtime' });
  assert.equal(deleted.deleted, true);
  assert.equal(JSON.parse(await readFile(join(runDir, '.kernel', 'BRIDGE.DELETED'), 'utf8')).planDigest, digest(captureB.plan));
  await assert.rejects(() => readFile(manifestPath));
  const retried = await deleteBridge({ runDir, runId: 's16-life', mode: 'runtime' });
  assert.equal(retried.deleted, true);
});

test('S16 sparse Beads files fail before allocation on pathname-snapshot hosts', { skip: process.platform === 'linux' }, async () => {
  const data = await fixture();
  const sparse = join(data.workspace, '.beads', 'sparse.db');
  await writeFile(sparse, '');
  await truncate(sparse, 64 * 1024 * 1024 + 1);
  await assert.rejects(() => data.source.capture(), BeadsUnavailable);
});

test('S16 oversized managed payloads fail before module use', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-s16-launcher-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { stdio: 'pipe' });
  const payload = join(target, 'runtime', 'dist', 'bridge-cli.js');
  await truncate(payload, 4 * 1024 * 1024 + 1);
  const result = spawnSync(process.execPath, [join(target, 'runtime', 'bridge.mjs'), '--help'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /byte limit/);
});
