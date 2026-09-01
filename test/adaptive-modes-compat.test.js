import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { canonicalString, digest } from '../dist/canonical.js';
import { deriveTopology, reconcileWave, validateReport, validateWave } from '../dist/deliberation.js';
import { makeRunKernel } from '../dist/index.js';
import { FileArtifactStore } from '../dist/store.js';

const root = resolve('.');
const corpusRoot = join(root, 'test/fixtures/adaptive-modes');
const manifest = JSON.parse(await readFile(join(corpusRoot, 'manifest.json'), 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ref = (id, value) => ({ id, scope: 'compat', digest: digest(value), bytes: canonicalString(value) });
const plan = { phaseId: 'compat', gateRequired: true, steps: [{ stepId: 'deliver' }] };

function input(runId, eventId, event, snapshot, launchToken) {
  return {
    runId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}), event,
    identity: {
      runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0,
      authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0,
      eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}),
    },
  };
}

async function treeBytes(directory, prefix = '') {
  const output = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name); const info = await stat(path); const relative = prefix ? `${prefix}/${name}` : name;
    if (info.isDirectory()) output.push(...await treeBytes(path, relative));
    else output.push([relative, sha(await readFile(path))]);
  }
  return output;
}

test('adaptive compatibility corpus is canonical, closed, and hash-bound', async () => {
  assert.equal(manifest.schema, 'lunacy-adaptive-compat-manifest/v1');
  assert.deepEqual(manifest.fixtures.map((row) => row.id), [
    'direct-journey', 'focus-current', 'focus-legacy', 'explore-chain', 'historical-widen-d4',
    'restart-proposal-settlement', 'corrupt-mixed-era', 'nonzero-mode-epoch',
    'stale-foreign-variants', 'focus-collision', 'rollout-boundary',
  ]);
  for (const row of manifest.fixtures) {
    assert.equal(row.file.includes('/') || row.file.includes('..'), false);
    const bytes = await readFile(join(corpusRoot, row.file), 'utf8');
    assert.equal(canonicalString(JSON.parse(bytes)), bytes, `${row.id} canonical bytes`);
    assert.equal(sha(bytes), row.sha256, `${row.id} manifest digest`);
    const fixture = JSON.parse(bytes);
    assert.deepEqual(fixture.projection, row.projection, `${row.id} closed projection`);
  }
});

test('Direct oracle freezes event, Yield, state, outbox, journal, and restart bytes with no managed artifacts', async () => {
  const fixture = JSON.parse(await readFile(join(corpusRoot, 'direct-journey.json'), 'utf8'));
  const runRoot = await mkdtemp(join(tmpdir(), 'adaptive-direct-'));
  try {
    const kernel = makeRunKernel({ plan, rootDir: runRoot }); const yields = []; const events = [];
    const start = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
    events.push(start); let value = await kernel.advance(input('compat-run', 'start', start)); yields.push(value);
    const resume = { kind: 'RESUME' }; events.push(resume); value = await kernel.advance(input('compat-run', 'resume', resume, value.snapshot)); yields.push(value);
    const request = JSON.parse(value.receipt.bytes);
    const receipt = { kind: 'DISPATCH_RECEIPT', ref: ref('receipt', { launchToken: request.launchToken, commandDigest: request.commandDigest }) };
    events.push(receipt); value = await kernel.advance(input('compat-run', 'receipt', receipt, value.snapshot, request.launchToken)); yields.push(value);
    const worker = { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) };
    events.push(worker); value = await kernel.advance(input('compat-run', 'worker', worker, value.snapshot, request.launchToken)); yields.push(value);
    const token = JSON.parse(value.artifacts[0].bytes).token; const gateSnapshot = value.snapshot;
    const pass = { kind: 'PARENT_DECISION', token, value: 'PASS' };
    events.push(pass); value = await kernel.advance(input('compat-run', 'pass', pass, value.snapshot)); yields.push(value);
    assert.deepEqual(yields.map((item) => sha(canonicalString(item))), fixture.baseline.yieldDigests);
    assert.deepEqual(events.map((item) => sha(canonicalString(item))), fixture.baseline.eventDigests);
    const currentBytes = await readFile(join(runRoot, '.kernel/CURRENT')); const current = JSON.parse(currentBytes);
    assert.equal(sha(currentBytes), fixture.baseline.stateCurrentDigest);
    const stateBytes = await readFile(join(runRoot, '.kernel/generations', `g${current.generation}`, 'state.json'));
    assert.equal(sha(stateBytes), fixture.baseline.stateDigest);
    const state = JSON.parse(stateBytes); assert.equal(state.schema, 1); assert.equal(state.managed, undefined);
    assert.equal(Object.values(state.outbox).some((command) => command.roleView), false);
    const before = await treeBytes(runRoot);
    const replay = await makeRunKernel({ plan, rootDir: runRoot }).advance(input('compat-run', 'pass', pass, gateSnapshot));
    assert.equal(sha(canonicalString(replay)), fixture.baseline.replayDigest);
    assert.deepEqual(await treeBytes(runRoot), before);
  } finally { await rm(runRoot, { recursive: true, force: true }); }
});

test('managed reader oracle preserves current, legacy, Explore, and collision raw bindings', async () => {
  for (const name of ['focus-current', 'focus-legacy', 'explore-chain', 'focus-collision']) {
    const fixture = JSON.parse(await readFile(join(corpusRoot, `${name}.json`), 'utf8'));
    assert.equal(sha(fixture.waveRef.bytes), fixture.waveRef.digest, `${name} raw Wave binding`);
    const admitted = validateWave(fixture.waveRef, {
      runId: fixture.wave.authorship.runId, phaseId: fixture.wave.authorship.phaseId,
      policy: fixture.policy, committedEvidence: new Set(), reachableConstraints: new Set(),
    });
    assert.equal(admitted.ok, true, `${name} Wave accepted`);
    const topology = deriveTopology(fixture.waveRef, fixture.wave);
    assert.equal(topology.slots.length, fixture.projection.slots);
    const accepted = [];
    for (const slot of topology.slots) {
      const report = fixture.reports[slot.slotOrdinal];
      const predecessors = slot.dependencies.map((ordinal) => fixture.reports[ordinal]);
      const checked = validateReport(report, { waveRef: fixture.waveRef, wave: fixture.wave, slot, predecessors, policy: fixture.policy });
      assert.equal(checked.ok, true, `${name} report ${slot.slotOrdinal}`);
      const reportRef = { id: `report:${digest(report).slice(0, 16)}`, digest: digest(report), scope: 'deliberation/report' };
      accepted.push({ ref: reportRef, report, receipt: { commandDigest: digest({ name, slot: slot.slotOrdinal }), resultDigest: reportRef.digest, attemptEpoch: 0 } });
    }
    const reconciled = reconcileWave(fixture.waveRef, fixture.wave, accepted.reverse());
    assert.equal(reconciled.architecture, 'COMPLETE', `${name} replay`);
    assert.deepEqual(reconciled.reports.map((report) => report.slotOrdinal), topology.slots.map((slot) => slot.slotOrdinal));
    assert.deepEqual(reconciled.refs.map((bound) => bound.digest), fixture.reports.map((report) => digest(report)));
  }
});

test('corrupt and nonzero-mode fixtures refuse while FileArtifactStore bytes remain unchanged', async () => {
  const corrupt = JSON.parse(await readFile(join(corpusRoot, 'corrupt-mixed-era.json'), 'utf8'));
  const current = JSON.parse(await readFile(join(corpusRoot, 'focus-current.json'), 'utf8'));
  assert.equal(validateWave(corrupt.variants[0].waveRef, { runId: current.wave.authorship.runId, phaseId: current.wave.authorship.phaseId, policy: current.policy, committedEvidence: new Set(), reachableConstraints: new Set() }).ok, false);
  assert.notEqual(corrupt.variants[1].report.wave.digest, current.waveRef.digest);
  assert.notDeepEqual(corrupt.variants[2].token.origin, corrupt.variants[2].proposalOrigin);
  assert.notEqual(sha(corrupt.variants[3].anchor.bytes), corrupt.variants[3].anchor.digest);

  const runRoot = await mkdtemp(join(tmpdir(), 'adaptive-corrupt-store-'));
  try {
    await makeRunKernel({ plan, rootDir: runRoot }).advance(input('corrupt-store', 'start', { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }));
    const currentPath = join(runRoot, '.kernel/CURRENT'); const pointer = JSON.parse(await readFile(currentPath, 'utf8'));
    const statePath = join(runRoot, '.kernel/generations', `g${pointer.generation}`, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')); state.modeEpoch = 1;
    await writeFile(statePath, canonicalString(state));
    const before = await treeBytes(runRoot);
    await assert.rejects(() => new FileArtifactStore(runRoot).load(), /modeEpoch|ManifestMismatch|unsupported/i);
    assert.deepEqual(await treeBytes(runRoot), before);
  } finally { await rm(runRoot, { recursive: true, force: true }); }
});
