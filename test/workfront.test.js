import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, lstat, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { transition } from '../dist/bridge.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { deriveWorkfront, inspectWorkfront } from '../dist/workfront.js';
import { validatePlan } from '../dist/validator.js';
import { READ_ONLY_STATE_BYTE_CEILING } from '../dist/limits.js';

async function treeSnapshot(root) {
  const result = {};
  async function visit(path, relative = '') {
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = join(path, entry.name);
      const key = join(relative, entry.name);
      const info = await lstat(child);
      result[key] = { mode: info.mode, kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', bytes: info.isFile() ? (await readFile(child)).toString('hex') : undefined };
      if (info.isDirectory()) await visit(child, key);
    }
  }
  await visit(root);
  return result;
}

function stateFixture() {
  return {
    schema: 1, runId: 'fixture', phaseId: 'p', revision: 7, authorityEpoch: 0, attemptEpoch: 3, barrierEpoch: 0, modeEpoch: 0,
    writerFence: 'fence', status: 'ACTIVE', gate: 'NOT-DUE', barrier: 'OPEN', nextAction: 'advance-ready-steps', planDigest: 'a'.repeat(64),
    steps: {
      z: { stepId: 'z', status: 'READY', attempt: 0, dependencies: [] },
      a: { stepId: 'a', status: 'ACTIVE', attempt: 3, dependencies: [] },
      b: { stepId: 'b', status: 'READY', attempt: 0, dependencies: ['a'] },
      c: { stepId: 'c', status: 'DONE', attempt: 0, dependencies: [] },
    },
    outbox: { cmd: { commandId: 'cmd', runId: 'fixture', phaseId: 'p', stepId: 'a', attemptEpoch: 3, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0, launchToken: 't', commandDigest: 'b'.repeat(64), state: 'UNKNOWN' } },
    processed: {}, decisionTokens: {}, journal: [],
  };
}

test('pure Workfront derivation is bounded, deterministic, and private', () => {
  const capsule = deriveWorkfront(stateFixture(), { focusStepId: 'b', limit: 1 });
  assert.equal(capsule.schema, 'lunacy-workfront/v1');
  assert.deepEqual(capsule.active, [{ stepId: 'a', attempt: 3, dispatch: 'UNKNOWN' }]);
  assert.deepEqual(capsule.eligible, [{ stepId: 'z' }]);
  assert.deepEqual(capsule.blocked, [{ stepId: 'b', reason: 'WAITING_DEPENDENCY', waitsFor: ['a'] }]);
  assert.deepEqual(capsule.attention, [{ code: 'UNKNOWN_DISPATCH', stepId: 'a' }]);
  assert.equal(capsule.truncation.limit, 1);
  assert.equal(JSON.stringify(capsule).includes('goal'), false);
  assert.equal(JSON.stringify(capsule).includes('resource'), false);
  assert.throws(() => deriveWorkfront(stateFixture(), { focusStepId: 'missing' }), /unknown/);
  assert.deepEqual(deriveWorkfront(stateFixture(), { limit: 0 }).active, []);
  assert.throws(() => deriveWorkfront(stateFixture(), { limit: 65 }), /between 0 and 64/);
});

test('dependency terminal semantics and every outbox observation are explicit', () => {
  for (const dispatch of ['PENDING', 'CLAIMED', 'ACKED', 'UNKNOWN']) {
    const state = stateFixture(); state.outbox.cmd.state = dispatch;
    assert.equal(deriveWorkfront(state).active[0].dispatch, dispatch);
  }
  const superseded = stateFixture(); superseded.steps.a.status = 'SUPERSEDED';
  assert.deepEqual(deriveWorkfront(superseded).blocked, [{ stepId: 'b', reason: 'WAITING_DEPENDENCY', waitsFor: ['a'] }]);
  const ambiguous = stateFixture(); ambiguous.outbox.cmd2 = { ...ambiguous.outbox.cmd, commandId: 'cmd2', launchToken: 't2' };
  assert.throws(() => deriveWorkfront(ambiguous), /ambiguous current dispatch/);
  const historical = stateFixture(); historical.attemptEpoch += 1;
  assert.equal(deriveWorkfront(historical).attention.some((item) => item.code === 'UNKNOWN_DISPATCH'), false);
  historical.outbox.forged = { ...historical.outbox.cmd, commandId: 'forged', attemptEpoch: historical.attemptEpoch, launchToken: 'forged-token' };
  assert.equal(deriveWorkfront(historical).active[0].dispatch, 'NONE');
  assert.equal(deriveWorkfront(historical).attention.some((item) => item.code === 'UNKNOWN_DISPATCH'), false);
});

test('reverse-declared deep topology is validated without recursive stack failure', () => {
  const count = 12_000;
  const steps = Array.from({ length: count }, (_, offset) => {
    const index = count - offset - 1;
    return { stepId: `s${index}`, dependencies: index === 0 ? [] : [`s${index - 1}`] };
  });
  const validated = validatePlan({ phaseId: 'deep', steps });
  assert.equal(validated.order.length, count);
  assert.equal(validated.order[0], 's0');
  assert.equal(validated.order.at(-1), `s${count - 1}`);
  assert.equal(validated.depths[`s${count - 1}`], count - 1);
});

test('managed Workfront route reads one generation and performs no writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-'));
  const plan = { phaseId: 'p', steps: [{ stepId: 'a', goal: 'private goal' }, { stepId: 'b', goal: 'B', dependencies: ['a'] }, { stepId: 'c', goal: 'C' }] };
  await transition({ runDir: root, runId: 'wf', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const before = await treeSnapshot(root);
  const capsule = await inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf' });
  const after = await treeSnapshot(root);
  assert.deepEqual(after, before);
  assert.equal(capsule.run.runId, 'wf');
  assert.deepEqual(capsule.blocked, [{ stepId: 'b', reason: 'WAITING_DEPENDENCY', waitsFor: ['a'] }]);
  assert.deepEqual(capsule.eligible, [{ stepId: 'c' }]);
});

test('managed CLI routes Workfront before transition/Beads imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-cli-'));
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  await transition({ runDir: root, runId: 'wf-cli', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const result = spawnSync(process.execPath, ['dist/bridge-cli.js', 'workfront', '--run-root', root, '--run-id', 'wf-cli'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schema, 'lunacy-workfront/v1');
  assert.equal(result.stderr, '');
});

test('disabled/deleted/corrupt Workfront reads fail closed without mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-fail-'));
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  await transition({ runDir: root, runId: 'wf-fail', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const manifestPath = join(root, '.kernel', 'BRIDGE.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, canonicalString({ ...manifest, status: 'disabled' }));
  let before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-fail' }), /enabled/);
  assert.deepEqual(await treeSnapshot(root), before);
  await writeFile(manifestPath, canonicalString(manifest));
  await writeFile(join(root, '.kernel', 'BRIDGE.DELETED'), canonicalString({ ...manifest, status: 'deleted' }));
  before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-fail' }), /deleted/);
  assert.deepEqual(await treeSnapshot(root), before);
  await unlink(join(root, '.kernel', 'BRIDGE.DELETED'));
  const current = JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8'));
  await writeFile(join(root, '.kernel', 'BRIDGE.json'), canonicalString(manifest));
  await writeFile(join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json'), '{"corrupt":true}');
  before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-fail' }), /ManifestMismatch/);
  assert.deepEqual(await treeSnapshot(root), before);
});

test('rolled-back CURRENT is rejected without quarantine or repair writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-stale-'));
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  const options = { runDir: root, runId: 'wf-stale', mode: 'runtime', plan };
  await transition(options, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const currentPath = join(root, '.kernel', 'CURRENT');
  const first = await readFile(currentPath, 'utf8');
  await transition(options, { event: { kind: 'RESUME' }, eventId: 'resume' });
  await writeFile(currentPath, first);
  const before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-stale' }), /before committed generation/);
  assert.deepEqual(await treeSnapshot(root), before);
});

test('unexpected generation debris is rejected without mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-debris-'));
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  await transition({ runDir: root, runId: 'wf-debris', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  await writeFile(join(root, '.kernel', 'generations', 'unexpected'), 'debris');
  const before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-debris' }), /unexpected generations entry/);
  assert.deepEqual(await treeSnapshot(root), before);
});

test('non-canonical generation aliases fail closed without mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-generation-alias-'));
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  await transition({ runDir: root, runId: 'wf-generation-alias', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  await mkdir(join(root, '.kernel', 'generations', 'g01'));
  const before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-generation-alias' }), /generation candidate g01 is invalid/);
  assert.deepEqual(await treeSnapshot(root), before);
});

test('final namespace recheck catches publication that starts after the first scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-publication-race-'));
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  await transition({ runDir: root, runId: 'wf-publication-race', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const kernelDir = join(root, '.kernel');
  const current = JSON.parse(await readFile(join(kernelDir, 'CURRENT'), 'utf8'));
  const future = join(kernelDir, 'generations', `g${current.generation + 1}`);
  const originalOpendir = fsPromises.opendir;
  let kernelScans = 0;
  fsPromises.opendir = async function patchedOpendir(path, ...args) {
    if (String(path) === kernelDir && ++kernelScans === 2) await mkdir(future);
    return originalOpendir.call(this, path, ...args);
  };
  try {
    await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-publication-race' }), /(?:namespace changed during read|before committed generation)/);
  } finally { fsPromises.opendir = originalOpendir; }
  assert.equal((await lstat(future)).isDirectory(), true);
  assert.equal((await readdir(join(kernelDir, 'quarantine'))).length, 0);
});

test('common committed-state validation rejects drift and CLI errors do not echo private values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-private-error-'));
  const plan = { phaseId: 'p', steps: [{ stepId: 'private-step' }] };
  await transition({ runDir: root, runId: 'wf-private-error', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const currentPath = join(root, '.kernel', 'CURRENT');
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  const statePath = join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const privateValue = 'SECRET-user-payload';
  state.nextAction = privateValue;
  await writeFile(statePath, canonicalString(state));
  await writeFile(currentPath, canonicalString({ ...current, stateDigest: digest(state) }));
  const before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-private-error' }), /nextAction is invalid/);
  assert.deepEqual(await treeSnapshot(root), before);
  const result = spawnSync(process.execPath, ['dist/bridge-cli.js', 'workfront', '--run-root', root, '--run-id', 'wf-private-error'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stderr);
  assert.deepEqual(output, { error: { name: 'WorkfrontError', message: 'ManifestMismatch' } });
  assert.equal(result.stderr.includes(privateValue), false);
  assert.equal(result.stderr.includes('private-step'), false);
  assert.deepEqual(await treeSnapshot(root), before);
});

test('common committed-state validation owns topology and outbox epoch invariants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-common-validation-'));
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }, { stepId: 'b', dependencies: ['a'] }] };
  await transition({ runDir: root, runId: 'wf-common-validation', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const currentPath = join(root, '.kernel', 'CURRENT');
  const originalCurrent = JSON.parse(await readFile(currentPath, 'utf8'));
  const statePath = join(root, '.kernel', 'generations', `g${originalCurrent.generation}`, 'state.json');
  const originalState = JSON.parse(await readFile(statePath, 'utf8'));

  const cyclic = structuredClone(originalState);
  cyclic.steps.a.dependencies = ['b'];
  await writeFile(statePath, canonicalString(cyclic));
  await writeFile(currentPath, canonicalString({ ...originalCurrent, stateDigest: digest(cyclic) }));
  let before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-common-validation' }), /cyclic dependency/);
  assert.deepEqual(await treeSnapshot(root), before);

  const future = structuredClone(originalState);
  const command = Object.values(future.outbox)[0];
  command.attemptEpoch = future.attemptEpoch + 1;
  await writeFile(statePath, canonicalString(future));
  await writeFile(currentPath, canonicalString({ ...originalCurrent, stateDigest: digest(future) }));
  before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-common-validation' }), /future epoch/);
  assert.deepEqual(await treeSnapshot(root), before);

  const missingCurrentCommand = structuredClone(originalState);
  missingCurrentCommand.outbox = {};
  await writeFile(statePath, canonicalString(missingCurrentCommand));
  await writeFile(currentPath, canonicalString({ ...originalCurrent, stateDigest: digest(missingCurrentCommand) }));
  before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-common-validation' }), /exactly one current command/);
  assert.deepEqual(await treeSnapshot(root), before);

  const historicalActive = structuredClone(originalState);
  historicalActive.attemptEpoch += 1;
  historicalActive.barrierEpoch += 1;
  await writeFile(statePath, canonicalString(historicalActive));
  const historicalCurrent = { ...originalCurrent, attemptEpoch: historicalActive.attemptEpoch, barrierEpoch: historicalActive.barrierEpoch, stateDigest: digest(historicalActive) };
  await writeFile(currentPath, canonicalString(historicalCurrent));
  const historicalView = await inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-common-validation' });
  assert.equal(historicalView.active[0].dispatch, 'NONE');

  for (const commandState of ['PENDING', 'UNKNOWN']) {
    const forgedCurrent = structuredClone(historicalActive);
    const forgedCommandId = digest({ runId: forgedCurrent.runId, phaseId: forgedCurrent.phaseId, stepId: 'a', attemptEpoch: forgedCurrent.attemptEpoch }).slice(0, 32);
    const forgedLaunchToken = `launch-${forgedCommandId}`;
    forgedCurrent.outbox[forgedCommandId] = {
      commandId: forgedCommandId, runId: forgedCurrent.runId, phaseId: forgedCurrent.phaseId, stepId: 'a',
      attemptEpoch: forgedCurrent.attemptEpoch, authorityEpoch: forgedCurrent.authorityEpoch, barrierEpoch: forgedCurrent.barrierEpoch, modeEpoch: forgedCurrent.modeEpoch,
      launchToken: forgedLaunchToken,
      commandDigest: digest({ commandId: forgedCommandId, runId: forgedCurrent.runId, phaseId: forgedCurrent.phaseId, stepId: 'a', attemptEpoch: forgedCurrent.attemptEpoch, launchToken: forgedLaunchToken }),
      state: commandState,
    };
    await writeFile(statePath, canonicalString(forgedCurrent));
    await writeFile(currentPath, canonicalString({ ...historicalCurrent, stateDigest: digest(forgedCurrent) }));
    before = await treeSnapshot(root);
    await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-common-validation' }), /does not belong to its step attempt/);
    assert.deepEqual(await treeSnapshot(root), before);
  }

  const missingHistoricalCommand = structuredClone(historicalActive);
  missingHistoricalCommand.outbox = {};
  await writeFile(statePath, canonicalString(missingHistoricalCommand));
  await writeFile(currentPath, canonicalString({ ...historicalCurrent, stateDigest: digest(missingHistoricalCommand) }));
  before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-common-validation' }), /exactly one historical command/);
  assert.deepEqual(await treeSnapshot(root), before);

  const ghostCurrentUnknown = structuredClone(originalState);
  const ghostCommandId = digest({ runId: ghostCurrentUnknown.runId, phaseId: ghostCurrentUnknown.phaseId, stepId: 'ghost', attemptEpoch: ghostCurrentUnknown.attemptEpoch }).slice(0, 32);
  const ghostLaunchToken = `launch-${ghostCommandId}`;
  ghostCurrentUnknown.outbox[ghostCommandId] = {
    commandId: ghostCommandId, runId: ghostCurrentUnknown.runId, phaseId: ghostCurrentUnknown.phaseId, stepId: 'ghost',
    attemptEpoch: ghostCurrentUnknown.attemptEpoch, authorityEpoch: ghostCurrentUnknown.authorityEpoch, barrierEpoch: ghostCurrentUnknown.barrierEpoch, modeEpoch: ghostCurrentUnknown.modeEpoch,
    launchToken: ghostLaunchToken,
    commandDigest: digest({ commandId: ghostCommandId, runId: ghostCurrentUnknown.runId, phaseId: ghostCurrentUnknown.phaseId, stepId: 'ghost', attemptEpoch: ghostCurrentUnknown.attemptEpoch, launchToken: ghostLaunchToken }),
    state: 'UNKNOWN',
  };
  await writeFile(statePath, canonicalString(ghostCurrentUnknown));
  await writeFile(currentPath, canonicalString({ ...originalCurrent, stateDigest: digest(ghostCurrentUnknown) }));
  before = await treeSnapshot(root);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-common-validation' }), /does not belong to its step attempt/);
  assert.deepEqual(await treeSnapshot(root), before);
});

test('read-only inspection rejects oversized sparse state before allocation and without mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-workfront-state-ceiling-'));
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  await transition({ runDir: root, runId: 'wf-state-ceiling', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const currentPath = join(root, '.kernel', 'CURRENT');
  const currentBytes = await readFile(currentPath);
  const current = JSON.parse(currentBytes.toString('utf8'));
  const statePath = join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json');
  await truncate(statePath, READ_ONLY_STATE_BYTE_CEILING + 1);
  const before = await lstat(statePath);
  await assert.rejects(() => inspectWorkfront({ kernelRoot: root, expectedRunId: 'wf-state-ceiling' }), /state exceeds its byte ceiling/);
  const cli = spawnSync(process.execPath, ['dist/bridge-cli.js', 'workfront', '--run-root', root, '--run-id', 'wf-state-ceiling'], { cwd: process.cwd(), encoding: 'utf8', timeout: 5_000 });
  assert.equal(cli.status, 1, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stderr), { error: { name: 'WorkfrontError', message: 'ManifestMismatch' } });
  const after = await lstat(statePath);
  assert.equal(after.size, before.size);
  assert.equal(String(after.ino), String(before.ino));
  assert.deepEqual(await readFile(currentPath), currentBytes);
});
