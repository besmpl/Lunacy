import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { transition } from '../dist/bridge.js';
import { composeKernel } from '../dist/composition.js';
import { createInitialState, reduce } from '../dist/reducer.js';
import { FileArtifactStore } from '../dist/store.js';
import { validatePlan, readySteps } from '../dist/validator.js';
import { deriveWorkfront } from '../dist/workfront.js';
import { createManagedCapability } from '../dist/managed-capability.js';

const declaration = { phaseId: 'a1', steps: [{ stepId: 'repair' }] };
const plan = validatePlan(declaration).plan;

function eventInput(runId, eventId, event, snapshot, launchToken) {
  return {
    runId,
    event,
    expectedRevision: snapshot.revision,
    identity: {
      runId,
      phaseId: plan.phaseId,
      stepId: 'run',
      attemptEpoch: snapshot.attemptEpoch,
      authorityEpoch: snapshot.authorityEpoch,
      barrierEpoch: snapshot.barrierEpoch,
      eventId,
      payloadDigest: digest(event),
      ...(launchToken === undefined ? {} : { launchToken }),
    },
  };
}

function startInput(runId) {
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(declaration) } };
  return {
    runId,
    event,
    identity: {
      runId,
      phaseId: plan.phaseId,
      stepId: 'run',
      attemptEpoch: 0,
      authorityEpoch: 0,
      barrierEpoch: 0,
      eventId: 'start',
      payloadDigest: digest(event),
    },
  };
}

function repairState(runId = 'repair-unit') {
  const state = createInitialState(runId, plan, digest(plan), 'repair-fixture');
  state.steps.repair.status = 'REPAIR';
  return state;
}

async function persistRepair(rootDir, runId, { gate = 'NOT-DUE' } = {}) {
  const started = await composeKernel({ plan: declaration, rootDir, maxInFlight: 0 }).advance(startInput(runId));
  const store = new FileArtifactStore(rootDir);
  const loaded = await store.load();
  assert.ok(loaded.state);
  loaded.state.steps.repair.status = 'REPAIR';
  loaded.state.steps.repair.attempt = loaded.state.attemptEpoch;
  loaded.state.gate = gate;
  loaded.state.nextAction = 'advance-ready-steps';
  loaded.state.outbox = {};
  await store.commit(loaded.generation, loaded.state);
  assert.equal((await store.load()).state?.steps.repair.status, 'REPAIR');
  return started.snapshot;
}

test('validator exposes REPAIR as executable readiness without mutating state', () => {
  const state = repairState();
  assert.deepEqual(readySteps(plan, { repair: 'REPAIR' }).map((step) => step.stepId), ['repair']);
  assert.equal(state.steps.repair.status, 'REPAIR');
});

test('direct reducer admission promotes REPAIR to one current-frame command', () => {
  const state = repairState();
  const event = { kind: 'RESUME' };
  const result = reduce(state, plan, eventInput(state.runId, 'resume', event, {
    revision: state.revision,
    attemptEpoch: state.attemptEpoch,
    authorityEpoch: state.authorityEpoch,
    barrierEpoch: state.barrierEpoch,
  }).identity, event, 1, true);
  const commands = Object.values(result.state.outbox);
  assert.equal(result.state.steps.repair.status, 'ACTIVE');
  assert.equal(commands.length, 1);
  assert.deepEqual(
    commands.map(({ stepId, attemptEpoch, authorityEpoch, barrierEpoch, modeEpoch, state: commandState }) => ({ stepId, attemptEpoch, authorityEpoch, barrierEpoch, modeEpoch, commandState })),
    [{ stepId: 'repair', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0, commandState: 'PENDING' }],
  );
});

test('persisted REPAIR admission and dispatch are identical in graph OFF, SHADOW, and ON', async () => {
  const traces = [];
  for (const mode of ['OFF', 'SHADOW', 'ON']) {
    const rootDir = await mkdtemp(join(tmpdir(), `lunacy-a1-${mode.toLowerCase()}-`));
    const runId = 'repair-restart';
    const persisted = await persistRepair(rootDir, runId);
    const launches = [];
    const kernel = composeKernel({
      plan: declaration,
      rootDir,
      maxInFlight: 1,
      acceleration: { graph: mode },
      driver: {
        dispatch(command, launchToken) {
          launches.push({ stepId: command.stepId, launchToken, commandDigest: command.commandDigest });
          return { launchToken, commandDigest: command.commandDigest, ref: { id: 'receipt', digest: digest({ ok: true }) } };
        },
      },
    });

    const admitted = await kernel.advance(eventInput(runId, 'admit-repair', { kind: 'RESUME' }, persisted));
    assert.equal(launches.length, 0);
    let loaded = await new FileArtifactStore(rootDir).load();
    assert.ok(loaded.state);
    let commands = Object.values(loaded.state.outbox);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].state, 'PENDING');
    assert.equal(commands[0].attemptEpoch, loaded.state.attemptEpoch);
    assert.equal(commands[0].authorityEpoch, loaded.state.authorityEpoch);
    assert.equal(commands[0].modeEpoch, loaded.state.modeEpoch);

    const dispatched = await kernel.advance(eventInput(runId, 'dispatch-repair', { kind: 'RESUME' }, admitted.snapshot));
    assert.equal(launches.length, 1);
    const replay = await kernel.advance(eventInput(runId, 'dispatch-repair', { kind: 'RESUME' }, admitted.snapshot));
    assert.deepEqual(replay, dispatched);
    assert.equal(launches.length, 1);
    loaded = await new FileArtifactStore(rootDir).load();
    assert.ok(loaded.state);
    commands = Object.values(loaded.state.outbox);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].stepId, 'repair');
    traces.push({ admitted, dispatched, command: commands[0], launches });
  }
  assert.deepEqual(traces[1], traces[0]);
  assert.deepEqual(traces[2], traces[0]);
});

test('Workfront and public/bridge projections count dependency-clear REPAIR readiness', async () => {
  const state = repairState('repair-view');
  const workfront = deriveWorkfront(state);
  assert.deepEqual(workfront.eligible, [{ stepId: 'repair' }]);
  assert.deepEqual(workfront.attention, [{ code: 'REPAIR_REQUIRED', stepId: 'repair' }]);

  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-a1-projection-'));
  const runId = 'repair-projection';
  const bridgeOptions = { runDir: rootDir, runId, mode: 'runtime', plan: declaration };
  const started = await transition(bridgeOptions, { event: startInput(runId).event, eventId: 'start' });
  const store = new FileArtifactStore(rootDir);
  const loaded = await store.load();
  assert.ok(loaded.state);
  loaded.state.steps.repair.status = 'REPAIR';
  loaded.state.steps.repair.attempt = loaded.state.attemptEpoch;
  loaded.state.gate = 'FINDINGS';
  loaded.state.nextAction = 'advance-ready-steps';
  loaded.state.outbox = {};
  await store.commit(loaded.generation, loaded.state);

  const resumed = await transition(bridgeOptions, {
    event: { kind: 'RESUME' },
    eventId: 'resume-repair-view',
    expectedRevision: started.yield.snapshot.revision,
  });
  assert.equal(resumed.yield.snapshot.readyCount, 1);
  assert.match(await readFile(resumed.projection.statePath, 'utf8'), /"readyCount":1/);
  assert.match(await readFile(resumed.projection.stepsPath, 'utf8'), /"readyCount":1/);
});

test('managed migration does not reserve ACKED history before targeted REPAIR admission', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-a1-managed-repair-'));
  const runId = 'managed-repair-migration';
  const receipt = { ok: true };
  const driver = {
    dispatch(command, launchToken) {
      return { launchToken, commandDigest: command.commandDigest, ref: { id: 'receipt', scope: 'test', digest: digest(receipt), bytes: canonicalString(receipt) } };
    },
  };
  try {
    const legacy = composeKernel({ plan: declaration, rootDir, driver });
    let yielded = await legacy.advance(startInput(runId));
    yielded = await legacy.advance(eventInput(runId, 'dispatch', { kind: 'RESUME' }, yielded.snapshot));
    const beforeDone = await new FileArtifactStore(rootDir).load();
    const command = Object.values(beforeDone.state.outbox)[0];
    const worker = { status: 'DONE' };
    yielded = await legacy.advance(eventInput(runId, 'done', {
      kind: 'WORKER_ENVELOPE',
      ref: { id: 'worker', scope: 'test', digest: digest(worker), bytes: canonicalString(worker) },
    }, yielded.snapshot, command.launchToken));
    assert.equal(yielded.kind, 'FINAL');
    const gateToken = JSON.parse(yielded.artifacts[0].bytes).token;

    const managed = composeKernel({
      plan: declaration,
      rootDir,
      driver,
      acceleration: { graph: 'ON' },
      managedCapability: createManagedCapability(),
    });
    const findings = { decision: 'FINDINGS', ownerStepId: 'repair' };
    yielded = await managed.advance(eventInput(runId, 'findings', { kind: 'PARENT_DECISION', token: gateToken, value: findings }, yielded.snapshot));
    assert.equal(yielded.kind, 'WAITING');
    let loaded = await new FileArtifactStore(rootDir).load();
    assert.equal(loaded.state.schema, 2);
    assert.equal(loaded.state.steps.repair.status, 'REPAIR');
    assert.deepEqual(loaded.state.managed.reservations, {});
    assert.deepEqual(loaded.state.managed.attempts, {});
    assert.equal(loaded.state.managed.waveCounters.waves, 0);
    assert.equal(loaded.state.managed.waveCounters.calls, 0);
    assert.equal(Object.values(loaded.state.outbox).filter((item) => item.state === 'ACKED').length, 1);

    yielded = await managed.advance(eventInput(runId, 'admit-repair', { kind: 'RESUME' }, yielded.snapshot));
    loaded = await new FileArtifactStore(rootDir).load();
    const current = Object.values(loaded.state.outbox).find((item) => item.attemptEpoch === loaded.state.attemptEpoch);
    assert.equal(current.state, 'PENDING');
    assert.equal(loaded.state.managed.reservations[current.commandId], undefined);
    assert.equal(loaded.state.managed.attempts[current.commandId], undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
