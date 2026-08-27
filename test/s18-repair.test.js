import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeadsPlanSource, BeadsUnavailable } from '../dist/beads.js';
import { transition } from '../dist/bridge.js';
import { digest, canonicalString } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';

const VERSION = '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}';

async function fixture(id = 'x') {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s18-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.beads'), { recursive: true });
  const executablePath = join(root, 'bd');
  const record = JSON.stringify({ _type: 'issue', id, title: id, status: 'open', priority: 0, issue_type: 'task' });
  await writeFile(executablePath, `#!/bin/sh
if [ "$1" = version ]; then printf '%s' '${VERSION}'; exit 0; fi
printf '%s\\n' '${record}'
`);
  await chmod(executablePath, 0o755);
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  return { root, workspace, executablePath, expectedBinaryDigest, source: new BeadsPlanSource({ executablePath, workspace, expectedBinaryDigest }) };
}

function ack(capture) {
  return {
    snapshotDigest: capture.snapshot.contentDigest,
    targetPlanDigest: digest(capture.plan),
    workspaceIdentity: capture.snapshot.workspaceIdentity,
    bdCommit: capture.snapshot.bdCommit,
    binaryDigest: capture.snapshot.binaryDigest,
  };
}

async function makeQuiescent(runDir) {
  const store = new FileArtifactStore(runDir);
  const loaded = await store.load();
  const state = structuredClone(loaded.state);
  for (const step of Object.values(state.steps)) step.status = 'DONE';
  state.outbox = {};
  state.status = 'ACTIVE';
  await store.commit(loaded.generation, state);
}

test('S18 eagerly repairs an accepted manifest predecessor before a later transition', async () => {
  const a = await fixture('a');
  const captureA = await a.source.capture();
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s18-chain-'));
  await transition({ runDir, runId: 's18-chain', mode: 'runtime', beads: { mode: 'active', source: a.source, acknowledgement: ack(captureA) } }, { event: { kind: 'START', intentRef: { id: 'a', digest: digest(captureA.plan) } }, eventId: 'start' });
  await makeQuiescent(runDir);

  const b = await fixture('b');
  const captureB = await b.source.capture();
  const driftB = await transition({ runDir, runId: 's18-chain', mode: 'runtime', beads: { mode: 'active', source: b.source } }, { event: { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'drift-b', scope: 'test', digest: digest({ b: true }), bytes: canonicalString({ b: true }) } }, eventId: 'drift-b' });
  await transition({ runDir, runId: 's18-chain', mode: 'runtime', beads: { mode: 'active', source: b.source, acknowledgement: ack(captureB) } }, { event: { kind: 'PARENT_DECISION', token: driftB.yield.token, value: { kind: 'ADOPT', digest: digest(captureB.plan) } }, eventId: 'adopt-b', expectedRevision: driftB.yield.snapshot.revision });

  const manifestPath = join(runDir, '.kernel', 'BRIDGE.json');
  const manifestA = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, canonicalString({ ...manifestA, planDigest: digest(captureA.plan), phaseId: captureA.plan.phaseId }));

  const c = await fixture('c');
  const captureC = await c.source.capture();
  const driftC = await transition({ runDir, runId: 's18-chain', mode: 'runtime', beads: { mode: 'active', source: c.source } }, { event: { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'drift-c', scope: 'test', digest: digest({ c: true }), bytes: canonicalString({ c: true }) } }, eventId: 'drift-c' });
  assert.equal(driftC.yield?.kind, 'DECISION_REQUIRED');
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).planDigest, digest(captureB.plan));

  await transition({ runDir, runId: 's18-chain', mode: 'runtime', beads: { mode: 'active', source: c.source, acknowledgement: ack(captureC) } }, { event: { kind: 'PARENT_DECISION', token: driftC.yield.token, value: { kind: 'ADOPT', digest: digest(captureC.plan) } }, eventId: 'adopt-c', expectedRevision: driftC.yield.snapshot.revision });
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).planDigest, digest(captureC.plan));
});

test('S18 physicalizes missing protected roots before Darwin overlap checks', { skip: process.platform !== 'darwin' }, async () => {
  const data = await fixture();
  const missingRunRoot = join(data.workspace, '.beads', 'missing-run-root', '.kernel');
  await assert.rejects(() => data.source.capture(undefined, [missingRunRoot]), BeadsUnavailable);
  await assert.rejects(() => stat(missingRunRoot));
});

test('S18 aborts pathname snapshots before tree construction', { skip: process.platform === 'linux' }, async () => {
  const data = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => data.source.capture(controller.signal), BeadsUnavailable);
});

test('S18 bounds empty private snapshot cardinality', { skip: process.platform === 'linux' }, async () => {
  const data = await fixture();
  const beadsDir = join(data.workspace, '.beads');
  for (let index = 0; index <= 12_288; index += 1) {
    const suffix = index.toString(36).padStart(4, '0');
    await writeFile(join(beadsDir, `f${suffix}`), '');
  }
  await assert.rejects(() => data.source.capture(), (error) => error instanceof BeadsUnavailable && /file count|construction deadline|path bytes/.test(error.message));
});

test('S18 bounds private snapshot depth without recursive descent', { skip: process.platform === 'linux' }, async () => {
  const data = await fixture();
  let current = join(data.workspace, '.beads');
  for (let depth = 0; depth <= 128; depth += 1) {
    current = join(current, `d${depth}`);
    await mkdir(current);
  }
  await assert.rejects(() => data.source.capture(), (error) => error instanceof BeadsUnavailable && /depth/.test(error.message));
});

test('S18 executable digest is tied to complete target and execution-image verification', async () => {
  const source = await readFile(new URL('../src/beads.ts', import.meta.url), 'utf8');
  assert.match(source, /async function writeAll/);
  assert.match(source, /bytesWritten <= 0/);
  assert.match(source, /hashExecutableDescriptor/);
  assert.match(source, /targetDigest !== copiedDigest/);
  const data = await fixture();
  const captured = await data.source.capture();
  assert.equal(captured.snapshot.binaryDigest, data.expectedBinaryDigest);
});

test('S18 deployment --check bounds mutable manifest and payload reads', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-s18-deploy-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: process.cwd(), stdio: 'pipe' });
  const manifestPath = join(target, 'runtime', 'DEPLOYMENT.json');
  await truncate(manifestPath, 1024 * 1024 + 1);
  let result = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, '--check'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /byte limit/);

  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: process.cwd(), stdio: 'pipe' });
  const payloadPath = join(target, 'runtime', 'dist', 'bridge-cli.js');
  await truncate(payloadPath, 4 * 1024 * 1024 + 1);
  result = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, '--check'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /byte limit/);
});
