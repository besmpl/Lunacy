import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeKernel } from '../dist/composition.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { makeRunKernel } from '../dist/index.js';
import { validatePlan } from '../dist/validator.js';

const plan = {
  phaseId: 'p3-admission',
  steps: [{ stepId: 'a', claims: [{ resource: 'declared/a', mode: 'WRITE', aliases: ['z', 'a'] }] }],
};

function input(runId, eventId, event, cursor, extra = {}) {
  return {
    runId,
    ...(cursor?.revision === undefined ? {} : { expectedRevision: cursor.revision }),
    identity: {
      runId,
      phaseId: extra.phaseId ?? 'run',
      stepId: extra.stepId ?? 'run',
      attemptEpoch: cursor?.attemptEpoch ?? 0,
      authorityEpoch: cursor?.authorityEpoch ?? 0,
      barrierEpoch: cursor?.barrierEpoch ?? 0,
      eventId,
      payloadDigest: digest(event),
      ...(extra.launchToken === undefined ? {} : { launchToken: extra.launchToken }),
    },
    event,
  };
}

function startInput(runId, eventId = 'start', value = plan) {
  return input(runId, eventId, { kind: 'START', intentRef: { id: 'plan', digest: digest(value) } }, { revision: undefined });
}

function ref(id, value, scope = 'test') {
  return { id, scope, digest: digest(value), bytes: canonicalString(value) };
}

async function fileState(root) {
  const current = JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8'));
  return JSON.parse(await readFile(join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json'), 'utf8'));
}

function mutatingAdmission(seen, { asyncBeforeResolve = false } = {}) {
  const mutate = (claims) => {
    seen.push(claims);
    claims[0].resource = 'laundered/resource';
    claims[0].mode = 'EXCLUSIVE';
    claims[0].aliases.push('laundered-alias');
  };
  if (asyncBeforeResolve) return async ({ claims }) => {
    mutate(claims);
    await Promise.resolve();
    return true;
  };
  return ({ claims }) => { mutate(claims); return true; };
}

test('detaches admission claims for Memory and File START, including async mutation before resolution', async () => {
  for (const store of ['memory', 'file']) for (const variant of ['sync', 'async']) {
    const rootDir = store === 'file' ? await mkdtemp(join(tmpdir(), `lunacy-p3-admission-${variant}-`)) : undefined;
    const runId = `ownership-${store}-${variant}`;
    const seen = [];
    const options = { plan, admission: mutatingAdmission(seen, { asyncBeforeResolve: variant === 'async' }), ...(rootDir ? { rootDir } : {}) };
    const kernel = makeRunKernel(options);
    const y = await kernel.advance(startInput(runId));
    assert.equal(y.kind, 'WAITING');
    assert.deepEqual(seen[0], [{ resource: 'laundered/resource', mode: 'EXCLUSIVE', aliases: ['a', 'z', 'laundered-alias'] }]);
    assert.deepEqual(plan.steps[0].claims, [{ resource: 'declared/a', mode: 'WRITE', aliases: ['z', 'a'] }]);
    if (rootDir) {
      const state = await fileState(rootDir);
      assert.deepEqual(state.steps.a.claims, [{ resource: 'declared/a', mode: 'WRITE', aliases: ['a', 'z'] }]);
      assert.equal(state.planDigest, digest(validatePlan(plan).plan));
      assert.equal(state.journal[0].event.intentRef.digest, digest(plan));
      const restartedSeen = [];
      const restarted = makeRunKernel({ ...options, admission: mutatingAdmission(restartedSeen), rootDir });
      const replay = await restarted.advance(startInput(runId));
      assert.deepEqual(replay, y);
      assert.equal(restartedSeen.length, 0);
      const resumed = await restarted.advance(input(runId, 'resume', { kind: 'RESUME' }, y.snapshot));
      assert.equal(resumed.kind, 'BLOCKED');
      assert.equal(resumed.code, 'HumanReceiptRequired');
      assert.deepEqual((await fileState(rootDir)).steps.a.claims, [{ resource: 'declared/a', mode: 'WRITE', aliases: ['a', 'z'] }]);
    }
  }
});

test('successor admission and graph OFF/SHADOW/ON remain equivalent under claim laundering', async () => {
  const basePlan = {
    phaseId: 'p3-successor',
    steps: [
      { stepId: 'a', claims: [{ resource: 'resource/a', mode: 'WRITE' }] },
      { stepId: 'b', claims: [{ resource: 'resource/b', mode: 'WRITE' }] },
    ],
  };
  const traces = [];
  for (const mode of ['OFF', 'SHADOW', 'ON']) {
    const rootDir = await mkdtemp(join(tmpdir(), `lunacy-p3-admission-${mode.toLowerCase()}-`));
    const admission = ({ claims }) => {
      for (const claim of claims) {
        claim.resource = 'resource/a';
        claim.mode = 'WRITE';
        claim.aliases.push('laundered');
      }
      return true;
    };
    const launched = [];
    const kernel = composeKernel({
      plan: basePlan,
      rootDir,
      maxInFlight: 1,
      admission,
      acceleration: { graph: mode },
      driver: {
        dispatch(command, launchToken) {
          launched.push({ command, launchToken });
          return { launchToken, commandDigest: command.commandDigest, ref: ref('receipt', { ok: true }) };
        },
      },
    });
    const started = await kernel.advance(startInput(`successor-${mode}`, 'start', basePlan));
    const resumed = await kernel.advance(input(`successor-${mode}`, 'resume', { kind: 'RESUME' }, started.snapshot));
    const observed = await kernel.advance(input(`successor-${mode}`, 'worker', { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) }, resumed.snapshot, { launchToken: launched[0].launchToken }));
    const state = await fileState(rootDir);
    traces.push({ mode, started, observed, state: { steps: state.steps, planDigest: state.planDigest } });
  }
  assert.deepEqual({ started: traces[1].started, observed: traces[1].observed, state: traces[1].state }, { started: traces[0].started, observed: traces[0].observed, state: traces[0].state });
  assert.deepEqual({ started: traces[2].started, observed: traces[2].observed, state: traces[2].state }, { started: traces[0].started, observed: traces[0].observed, state: traces[0].state });
  assert.equal(traces[0].state.steps.a.claims[0].resource, 'resource/a');
  assert.equal(traces[0].state.steps.b.claims[0].resource, 'resource/b');
  assert.equal(traces[0].state.steps.b.status, 'ACTIVE');
});

test('false, true, and thrown admission preserve existing semantics and never launch blocked work', async () => {
  const blockedPlan = { phaseId: 'p3-blocked', steps: [{ stepId: 'a', claims: [{ resource: 'r', mode: 'WRITE' }] }] };
  let dispatches = 0;
  const blocked = composeKernel({
    plan: blockedPlan,
    admission: () => false,
    driver: { dispatch() { dispatches += 1; throw new Error('must not launch'); } },
  });
  const denied = await blocked.advance(startInput('blocked', 'start', blockedPlan));
  assert.equal(denied.kind, 'BLOCKED');
  assert.equal(denied.code, 'CrossRunUnproven');
  assert.equal(dispatches, 0);

  const admitted = makeRunKernel({ plan: blockedPlan, admission: () => true });
  assert.equal((await admitted.advance(startInput('true', 'start', blockedPlan))).kind, 'WAITING');

  const thrown = makeRunKernel({ plan: blockedPlan, admission: () => { throw new Error('admission-audit-throw'); } });
  await assert.rejects(() => thrown.advance(startInput('throw', 'start', blockedPlan)), /admission-audit-throw/);
});

test('receipt, worker, parent, and exact replay paths use detached claims without extra replay admission', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-p3-admission-events-'));
  const eventPlan = { phaseId: 'p3-events', gateRequired: true, steps: [{ stepId: 'a', claims: [{ resource: 'event/a', mode: 'WRITE' }] }] };
  const seen = [];
  const kernel = makeRunKernel({ plan: eventPlan, rootDir, admission: mutatingAdmission(seen) });
  const started = await kernel.advance(startInput('events', 'start', eventPlan));
  assert.equal(seen.length, 1);
  const duplicate = await kernel.advance(startInput('events', 'start', eventPlan));
  assert.deepEqual(duplicate, started);
  assert.equal(seen.length, 1);
  const blocked = await kernel.advance(input('events', 'resume', { kind: 'RESUME' }, started.snapshot));
  assert.equal(blocked.kind, 'BLOCKED');
  const request = JSON.parse(blocked.receipt.bytes);
  const receipt = await kernel.advance(input('events', 'receipt', { kind: 'DISPATCH_RECEIPT', ref: ref('receipt', { launchToken: request.launchToken, commandDigest: request.commandDigest }) }, blocked.snapshot, { launchToken: request.launchToken }));
  assert.equal(receipt.kind, 'WAITING');
  const worker = await kernel.advance(input('events', 'worker', { kind: 'WORKER_ENVELOPE', ref: ref('worker-result', { status: 'DONE' }) }, receipt.snapshot, { launchToken: request.launchToken }));
  assert.equal(worker.kind, 'FINAL');
  const token = JSON.parse(worker.artifacts[0].bytes).token;
  const complete = await kernel.advance(input('events', 'parent', { kind: 'PARENT_DECISION', token, value: 'PASS' }, worker.snapshot));
  assert.equal(complete.kind, 'FINAL');
  assert.equal(complete.status, 'complete');
  assert.ok(seen.length >= 3);
  const state = await fileState(rootDir);
  assert.deepEqual(state.steps.a.claims, [{ resource: 'event/a', mode: 'WRITE', aliases: [] }]);
});
