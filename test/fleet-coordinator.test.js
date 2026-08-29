import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFleet, validateFleetManifest } from '../dist/fleet-coordinator.js';
import { canonicalString, digest } from '../dist/canonical.js';

const ref = (id, value) => ({ id, scope: 'fleet-test', digest: digest(value), bytes: canonicalString(value) });
function driver() {
  const commands = new Map();
  return {
    commands,
    dispatch(command, token) { commands.set(token, command); return { launchToken: token, commandDigest: command.commandDigest, ref: ref(`launch:${token}`, { launched: true }) }; },
    terminal(token) { const command = commands.get(token); return { schema: 'lunacy-codex-terminal/v1', launchToken: token, commandDigest: command.commandDigest, status: 'PASS', outcome: 'normal-completion', exitCode: 0, signal: null, resultDigest: null, reportPath: null, reportDigest: null, eventsDigest: digest('events'), finishedAt: '2025-01-01T00:00:00Z' }; },
  };
}

test('fleet manifest is explicit, canonical, and digest-bound', () => {
  const manifest = validateFleetManifest({ schema: 'lunacy-fleet/v1', version: 1, entries: [{ runRoot: '/tmp/fleet-root', runId: 'one', plan: { phaseId: 'p', steps: [{ stepId: 'a' }] } }] });
  assert.equal(manifest.entries[0].planDigest, digest(manifest.entries[0].plan));
  assert.throws(() => validateFleetManifest({ schema: 'lunacy-fleet/v1', version: 1, entries: [{ runRoot: 'relative', runId: 'one', plan: { phaseId: 'p', steps: [] } }] }));
});

test('fleet delegates one lifecycle turn and persists round-robin observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-fleet-test-'));
  const statePath = join(root, 'fleet-state.json');
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  const result = await runFleet({ manifest: { schema: 'lunacy-fleet/v1', version: 1, entries: [{ runRoot: root, runId: 'one', plan, driver: driver() }] }, statePath, maxTransitions: 1 });
  assert.equal(result.entryId, 'one');
  assert.equal(result.lifecycle?.command, 'resume');
  assert.ok(result.lifecycle?.yield);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.schema, 'lunacy-fleet-state/v1');
  assert.equal(state.leases.one, undefined);
  assert.equal(state.observations.one.rootIdentity.dev.length > 0, true);
});

test('missing explicit root returns stale-root attention without creating a run', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'lunacy-fleet-stale-'));
  const statePath = join(parent, 'state.json');
  const result = await runFleet({ manifest: { schema: 'lunacy-fleet/v1', version: 1, entries: [{ runRoot: join(parent, 'missing'), runId: 'missing', plan: { phaseId: 'p', steps: [{ stepId: 'a' }] } }] }, statePath });
  assert.equal(result.status, 'attention');
  assert.equal(result.attention?.code, 'StaleRoot');
});

test('expired lease is fail-closed before lifecycle delegation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-fleet-expired-'));
  const statePath = join(root, 'state.json');
  const calls = [];
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  const result = await runFleet({
    manifest: { schema: 'lunacy-fleet/v1', version: 1, entries: [{ runRoot: root, runId: 'one', plan, driver: { dispatch() { calls.push('dispatch'); throw new Error('must not dispatch'); } } }] },
    statePath,
    leaseTtlMs: 1,
    lockWaitMs: 1000,
  });
  assert.equal(result.status, 'attention');
  assert.equal(result.attention?.code, 'LeaseLost');
  assert.deepEqual(calls, []);
});

test('competing coordinators converge on one kernel launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-fleet-competing-'));
  const statePath = join(root, 'state.json');
  const commands = new Map();
  const launches = [];
  const fleetDriver = {
    dispatch(command, token) {
      launches.push(token);
      commands.set(token, command);
      return { launchToken: token, commandDigest: command.commandDigest, ref: ref(`launch:${token}`, { launched: true }) };
    },
    terminal(token) {
      const command = commands.get(token);
      return { schema: 'lunacy-codex-terminal/v1', launchToken: token, commandDigest: command.commandDigest, status: 'PASS', outcome: 'normal-completion', exitCode: 0, signal: null, resultDigest: null, reportPath: null, reportDigest: null, eventsDigest: digest('events'), finishedAt: '2025-01-01T00:00:00Z' };
    },
  };
  const manifest = { schema: 'lunacy-fleet/v1', version: 1, entries: [{ runRoot: root, runId: 'one', plan: { phaseId: 'p', steps: [{ stepId: 'a' }] }, driver: fleetDriver }] };
  const [first, second] = await Promise.all([
    runFleet({ manifest, statePath, maxTransitions: 3 }),
    runFleet({ manifest, statePath, maxTransitions: 3 }),
  ]);
  assert.equal(launches.length, 1);
  assert.equal(first.status === 'advanced' || second.status === 'advanced', true);
  assert.equal(first.status === 'idle' || second.status === 'idle', true);
});

test('fleet state parsing rejects oversized or symlinked metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-fleet-state-'));
  const statePath = join(root, 'state.json');
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  await writeFile(statePath, 'x'.repeat(1_048_577));
  let result = await runFleet({ manifest: { schema: 'lunacy-fleet/v1', version: 1, entries: [{ runRoot: root, runId: 'one', plan }] }, statePath });
  assert.equal(result.attention?.code, 'StateMalformed');

  const target = join(root, 'state-target.json');
  await writeFile(target, '{}');
  await unlink(statePath);
  await symlink(target, statePath);
  result = await runFleet({ manifest: { schema: 'lunacy-fleet/v1', version: 1, entries: [{ runRoot: root, runId: 'one', plan }] }, statePath });
  assert.equal(result.attention?.code, 'StateMalformed');
});

test('manifest rejects a driver and policy on one entry', () => {
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  assert.throws(() => validateFleetManifest({
    schema: 'lunacy-fleet/v1',
    version: 1,
    entries: [{ runRoot: '/tmp/fleet-root', runId: 'one', plan, driver: { dispatch() {} }, policy: {} }],
  }), /both driver and policy/);
});

test('attention details redact arbitrary lifecycle error text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-fleet-redact-'));
  const statePath = join(root, 'state.json');
  const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  const result = await runFleet({
    manifest: { schema: 'lunacy-fleet/v1', version: 1, entries: [{ runRoot: root, runId: 'one', plan, driver: { dispatch() { throw new Error('/secret/provider/path'); } } }] },
    statePath,
    maxTransitions: 2,
  });
  assert.equal(result.attention?.code, 'LifecycleError');
  assert.equal(result.attention?.detail, undefined);
});
