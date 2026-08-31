import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';

const plan = {
  phaseId: 'a2-dogfood',
  steps: [
    { stepId: 'foundation' },
    { stepId: 'canonical-journey', dependencies: ['foundation'] },
    { stepId: 'retained-proof', dependencies: ['foundation'] },
    { stepId: 'polish-copy', dependencies: ['canonical-journey'] },
    { stepId: 'polish-format', dependencies: ['canonical-journey'] },
  ],
};
const closure = ['canonical-journey', 'polish-copy', 'polish-format'];
const correctedOutputDigest = digest({ artifact: 'corrected-output', version: 2 });

function ref(id, value) { return { id, scope: 'a2-dogfood', digest: digest(value), bytes: canonicalString(value) }; }
function input(runId, eventId, event, snapshot, launchToken) {
  return {
    runId,
    ...(snapshot ? { expectedRevision: snapshot.revision } : {}),
    identity: {
      runId, phaseId: 'run', stepId: 'run',
      attemptEpoch: snapshot?.attemptEpoch ?? 0,
      authorityEpoch: snapshot?.authorityEpoch ?? 0,
      barrierEpoch: snapshot?.barrierEpoch ?? 0,
      eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}),
    },
    event,
  };
}

async function completeAttempt(kernel, root, runId, initialYield, prefix) {
  let y = initialYield;
  let event = 0;
  while (y.kind !== 'FINAL') {
    const state = (await new FileArtifactStore(root).load()).state;
    const current = (command) => command.attemptEpoch === state.attemptEpoch && command.authorityEpoch === state.authorityEpoch && command.barrierEpoch === state.barrierEpoch && command.modeEpoch === state.modeEpoch;
    const pending = Object.values(state.outbox).find((command) => current(command) && command.state === 'PENDING');
    if (pending) {
      y = await kernel.advance(input(runId, `${prefix}-resume-${event++}`, { kind: 'RESUME' }, y.snapshot));
      continue;
    }
    const acknowledged = Object.values(state.outbox).find((command) => current(command) && command.state === 'ACKED' && state.steps[command.stepId]?.status === 'ACTIVE');
    if (acknowledged) {
      y = await kernel.advance(input(runId, `${prefix}-worker-${event++}`, { kind: 'WORKER_ENVELOPE', ref: ref(`${prefix}-${acknowledged.stepId}`, { status: 'DONE' }) }, y.snapshot, acknowledged.launchToken));
      continue;
    }
    y = await kernel.advance(input(runId, `${prefix}-admit-${event++}`, { kind: 'RESUME' }, y.snapshot));
  }
  assert.equal(y.status, 'phase-ready');
  return y;
}

async function runRepair(decision, runId) {
  const root = await mkdtemp(join(tmpdir(), `lunacy-a2-dogfood-${runId}-`));
  const dispatches = [];
  const driver = {
    dispatch(command, launchToken) {
      dispatches.push(command.stepId);
      const outputDigest = command.stepId === 'canonical-journey' ? correctedOutputDigest : digest({ stepId: command.stepId, accepted: true });
      return { launchToken, commandDigest: command.commandDigest, ref: ref(`driver-${command.stepId}`, { outputDigest }) };
    },
  };
  try {
    const kernel = composeKernel({ plan, rootDir: root, maxInFlight: 2, driver });
    const startEvent = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
    let y = await kernel.advance(input(runId, 'start', startEvent));
    y = await completeAttempt(kernel, root, runId, y, 'initial');
    dispatches.length = 0;
    const gateToken = JSON.parse(y.artifacts[0].bytes).token;
    const decisionEvent = { kind: 'PARENT_DECISION', token: gateToken, value: decision };
    const decisionInput = input(runId, 'findings', decisionEvent, y.snapshot);
    const reopened = await kernel.advance(decisionInput);
    let exactLegacyReplay = false;
    if (decision === 'FINDINGS') {
      const duplicate = await kernel.advance(decisionInput);
      exactLegacyReplay = canonicalString(duplicate) === canonicalString(reopened) && dispatches.length === 0;
    }
    y = await completeAttempt(kernel, root, runId, reopened, 'repair');
    const state = (await new FileArtifactStore(root).load()).state;
    const outsideClosure = dispatches.filter((stepId) => !closure.includes(stepId));
    const journeyIndex = dispatches.indexOf('canonical-journey');
    const preJourneyPolishDispatches = dispatches.slice(0, Math.max(0, journeyIndex)).filter((stepId) => stepId.startsWith('polish-')).length;
    const journeyCommand = Object.values(state.outbox).find((command) => command.stepId === 'canonical-journey' && command.attemptEpoch === 1);
    const output = JSON.parse(JSON.parse(journeyCommand.receipt.bytes).receipt.bytes).outputDigest;
    return {
      decision,
      dispatches,
      replayAmplification: Number((dispatches.length / closure.length).toFixed(6)),
      staleProofReplayOutsideClosurePercent: Number(((outsideClosure.length / dispatches.length) * 100).toFixed(6)),
      preJourneyPolishDispatches,
      correctedOutputDigest: output,
      legacyReplayCompatibility: decision === 'FINDINGS' ? exactLegacyReplay && state.journal.find((entry) => entry.identity.eventId === 'findings')?.event.value === 'FINDINGS' : true,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('frozen before/after dogfood meets targeted repair outcome thresholds', async () => {
  const before = await runRepair('FINDINGS', 'before');
  const after = await runRepair({ decision: 'FINDINGS', ownerStepId: 'canonical-journey' }, 'after');
  const actual = {
    schema: 'lunacy-targeted-repair-dogfood/v1',
    fixture: { closure, plan },
    before,
    after,
    outcomes: {
      replayAmplificationAtMostOne: after.replayAmplification <= 1,
      staleProofReplayOutsideClosureZero: after.staleProofReplayOutsideClosurePercent === 0,
      preJourneyPolishDispatchesZero: after.preJourneyPolishDispatches === 0,
      correctedOutputIdentical: after.correctedOutputDigest === before.correctedOutputDigest,
      legacyReplayCompatibility: before.legacyReplayCompatibility,
    },
  };
  const evidencePath = new URL('./fixtures/a2-targeted-dogfood.json', import.meta.url);
  const frozen = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.deepEqual(actual, frozen);
  assert.deepEqual(actual.outcomes, {
    replayAmplificationAtMostOne: true,
    staleProofReplayOutsideClosureZero: true,
    preJourneyPolishDispatchesZero: true,
    correctedOutputIdentical: true,
    legacyReplayCompatibility: true,
  });
});
