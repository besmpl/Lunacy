import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { ContextCompiler } from '../dist/compiler.js';
import { composeKernel } from '../dist/composition.js';
import { Conflict, InvalidEvent, InvalidPlan, KernelError, makeRunKernel } from '../dist/index.js';
import { appendJournal, createInitialState } from '../dist/reducer.js';
import { FileArtifactStore } from '../dist/store.js';
import { FixedCellReuse, makeCellHandle, makeSnapshotHandle } from '../dist/reuse.js';

const plan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
const ref = (id, value) => ({ id, scope: 'test', digest: digest(value), bytes: canonicalString(value) });
const input = (runId, eventId, event, snapshot, launchToken) => ({
  runId,
  ...(snapshot?.revision === undefined ? {} : { expectedRevision: snapshot.revision }),
  identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0, authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0, eventId, payloadDigest: digest(event), ...(launchToken ? { launchToken } : {}) },
  event,
});
const start = (runId = 'r', p = plan) => input(runId, 'start', { kind: 'START', intentRef: { id: 'plan', digest: digest(p) } });
const receipt = (command, launchToken) => ({ launchToken, commandDigest: command.commandDigest, ref: ref('driver', { accepted: true }) });

test('canonical identity does not collide on prototype keys or sparse/non-JSON values', async () => {
  const polluted = JSON.parse('{"__proto__":{"pwned":true}}');
  assert.notEqual(digest(polluted), digest({}));
  assert.equal(canonicalString(polluted), '{"__proto__":{"pwned":true}}');
  assert.throws(() => digest([,]), /sparse arrays/);
  assert.throws(() => digest(1n), /bigint/);
});

test('API rejects unknown/malformed events, mismatched START refs, and unsafe plan keys before mutation', async () => {
  const kernel = makeRunKernel({ plan });
  await assert.rejects(() => kernel.advance({ runId: 'r', identity: { runId: 'r', phaseId: 'p', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'bad', payloadDigest: digest({ kind: 'EVIL' }) }, event: { kind: 'EVIL' } }), InvalidEvent);
  await assert.rejects(() => kernel.advance({ ...start(), identity: { ...start().identity, unexpected: true } }), InvalidEvent);
  const malformed = { kind: 'START', intentRef: { id: 'plan', digest: digest({ unrelated: true }) } };
  await assert.rejects(() => kernel.advance(input('r', 'bad-start', malformed)), InvalidEvent);
  await assert.rejects(() => kernel.advance({ ...start('bad-phase'), identity: { ...start('bad-phase').identity, phaseId: 'attacker' } }), InvalidEvent);
  await assert.rejects(() => makeRunKernel({ plan: { phaseId: 'p', steps: [{ stepId: 'a', goal: 1n }] } }).advance(start('noncanonical')), InvalidPlan);
  assert.throws(() => makeRunKernel({ plan, admission: true }), InvalidPlan);
  assert.throws(() => composeKernel({ plan, driver: { dispatch: true } }), InvalidPlan);
  await assert.rejects(() => makeRunKernel({ plan: { phaseId: 'p', steps: [{ stepId: '__proto__' }] } }).advance(start('reserved', { phaseId: 'p', steps: [{ stepId: '__proto__' }] })), InvalidPlan);
});

test('receipt proof is mandatory and forged recovery cannot reset UNKNOWN', async () => {
  const kernel = makeRunKernel({ plan });
  let waiting = await kernel.advance(start());
  waiting = await kernel.advance(input('r', 'resume', { kind: 'RESUME' }, waiting.snapshot));
  assert.equal(waiting.code, 'HumanReceiptRequired');
  const bare = { kind: 'DISPATCH_RECEIPT', ref: { id: 'bare', digest: digest({ ok: true }) } };
  await assert.rejects(() => kernel.advance(input('r', 'bare', bare, waiting.snapshot, waiting.launchToken)), InvalidEvent);

  let attempts = 0; let commandDigest;
  const failing = { dispatch(command) { attempts += 1; commandDigest = command.commandDigest; throw new Error('lost'); } };
  const composed = composeKernel({ plan, driver: failing });
  let unknown = await composed.advance(start('u'));
  unknown = await composed.advance(input('u', 'resume', { kind: 'RESUME' }, unknown.snapshot));
  assert.equal(unknown.code, 'UnknownDispatch'); assert.equal(attempts, 1);
  const forged = { kind: 'OBSERVATION', category: 'RECOVERY', ref: ref('never', { launchToken: unknown.launchToken, status: 'NEVER_LAUNCHED' }) };
  await assert.rejects(() => composed.advance(input('u', 'forged', forged, unknown.snapshot, unknown.launchToken)), InvalidEvent);
  const still = await composed.advance(input('u', 'resume-again', { kind: 'RESUME' }, unknown.snapshot));
  assert.equal(still.code, 'UnknownDispatch'); assert.equal(still.snapshot.unknownDispatchCount, 1);
  void commandDigest;
});

test('invalid parent decisions do not consume the gate token and COMPLETE is sticky', async () => {
  const driver = { dispatch: (command, launchToken) => receipt(command, launchToken) };
  const kernel = composeKernel({ plan, driver });
  let y = await kernel.advance(start());
  y = await kernel.advance(input('r', 'resume', { kind: 'RESUME' }, y.snapshot));
  const token = `launch-${digest({ runId: 'r', phaseId: 'p', stepId: 'a', attemptEpoch: 0 }).slice(0, 32)}`;
  y = await kernel.advance(input('r', 'worker', { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) }, y.snapshot, token));
  assert.equal(y.kind, 'FINAL');
  const gateToken = JSON.parse(y.artifacts[0].bytes).token;
  await assert.rejects(() => kernel.advance(input('r', 'bad-choice', { kind: 'PARENT_DECISION', token: gateToken, value: 'MAYBE' }, y.snapshot)), Conflict);
  y = await kernel.advance(input('r', 'pass', { kind: 'PARENT_DECISION', token: gateToken, value: 'PASS' }, y.snapshot));
  assert.equal(y.status, 'complete');
  await assert.rejects(() => kernel.advance(input('r', 'late', { kind: 'OBSERVATION', category: 'HOST', ref: ref('late', { ok: true }) }, y.snapshot)), Conflict);
});

test('plan mutation with live work fences before any driver effect and resumes only after restoration', async () => {
  const mutablePlan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  let calls = 0;
  const driver = { dispatch(command, launchToken) { calls += 1; return receipt(command, launchToken); } };
  const kernel = composeKernel({ plan: mutablePlan, driver });
  const started = await kernel.advance(start('drift', mutablePlan));
  mutablePlan.steps[0].goal = 'attacker mutation';
  const fenced = await kernel.advance(input('drift', 'drift', { kind: 'RESUME' }, started.snapshot));
  assert.equal(fenced.kind, 'DECISION_REQUIRED'); assert.equal(fenced.snapshot.pendingDispatchCount, 1); assert.equal(calls, 0);
  delete mutablePlan.steps[0].goal;
  const resumed = await kernel.advance(input('drift', 'resume', { kind: 'RESUME' }, fenced.snapshot));
  assert.equal(resumed.kind, 'WAITING'); assert.equal(calls, 1);
});

test('malformed live plan cannot strand a committed outbox recovery', async () => {
  const malformedPlan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  let calls = 0;
  const driver = { dispatch(command, launchToken) { calls += 1; return receipt(command, launchToken); } };
  const kernel = composeKernel({ plan: malformedPlan, driver });
  const started = await kernel.advance(start('malformed-live', malformedPlan));
  malformedPlan.steps.push({ stepId: 'b', dependencies: ['missing'] });
  const resumed = await kernel.advance(input('malformed-live', 'resume', { kind: 'RESUME' }, started.snapshot));
  assert.equal(resumed.kind, 'WAITING'); assert.equal(calls, 1);
});

test('malformed live recovery reconciles the old command without admitting a successor', async () => {
  const malformedPlan = { phaseId: 'p', steps: [{ stepId: 'a' }, { stepId: 'b' }] };
  const driver = { dispatch(command, launchToken) { return receipt(command, launchToken); } };
  const kernel = composeKernel({ plan: malformedPlan, driver, maxInFlight: 1 });
  let y = await kernel.advance(start('malformed-capacity', malformedPlan));
  y = await kernel.advance(input('malformed-capacity', 'resume', { kind: 'RESUME' }, y.snapshot));
  assert.equal(y.kind, 'WAITING');
  const token = `launch-${digest({ runId: 'malformed-capacity', phaseId: 'p', stepId: 'a', attemptEpoch: 0 }).slice(0, 32)}`;
  malformedPlan.steps.push({ stepId: 'bad', dependencies: ['missing'] });
  y = await kernel.advance(input('malformed-capacity', 'worker', { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) }, y.snapshot, token));
  assert.equal(y.snapshot.activeCount, 0);
  assert.equal(y.snapshot.readyCount, 1);
  assert.equal(y.snapshot.pendingDispatchCount, 0);
});

test('malformed declarations cannot block a previously due parent gate', async () => {
  const mutablePlan = { phaseId: 'p', steps: [{ stepId: 'a' }] };
  const kernel = composeKernel({ plan: mutablePlan, driver: { dispatch(command, launchToken) { return receipt(command, launchToken); } } });
  let y = await kernel.advance(start('malformed-gate', mutablePlan));
  y = await kernel.advance(input('malformed-gate', 'resume', { kind: 'RESUME' }, y.snapshot));
  const token = `launch-${digest({ runId: 'malformed-gate', phaseId: 'p', stepId: 'a', attemptEpoch: 0 }).slice(0, 32)}`;
  y = await kernel.advance(input('malformed-gate', 'worker', { kind: 'WORKER_ENVELOPE', ref: ref('worker', { status: 'DONE' }) }, y.snapshot, token));
  const gateToken = JSON.parse(y.artifacts[0].bytes).token;
  mutablePlan.steps.push({ stepId: 'b', dependencies: ['missing'] });
  y = await kernel.advance(input('malformed-gate', 'pass', { kind: 'PARENT_DECISION', token: gateToken, value: 'PASS' }, y.snapshot));
  assert.equal(y.status, 'complete');
});

test('filesystem rejects root/current/generation/lock symlink escapes and reclaims a dead lock', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'lunacy-s5-outside-'));
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s5-root-'));
  await symlink(outside, join(root, '.kernel'));
  await assert.rejects(() => makeRunKernel({ plan, rootDir: root }).advance(start()), (error) => error instanceof KernelError && error.code === 'ManifestMismatch');

  const currentRoot = await mkdtemp(join(tmpdir(), 'lunacy-s5-current-'));
  await makeRunKernel({ plan, rootDir: currentRoot }).advance(start('current'));
  const currentPath = join(currentRoot, '.kernel', 'CURRENT');
  const currentCopy = await readFile(currentPath, 'utf8');
  await unlink(currentPath); await writeFile(join(outside, 'CURRENT-copy'), currentCopy); await symlink(join(outside, 'CURRENT-copy'), currentPath);
  await assert.rejects(() => makeRunKernel({ plan, rootDir: currentRoot }).advance(start('current', { phaseId: 'p', steps: [{ stepId: 'a' }] })), (error) => error instanceof KernelError && error.code === 'ManifestMismatch');

  const missingCurrentRoot = await mkdtemp(join(tmpdir(), 'lunacy-s5-missing-current-'));
  await makeRunKernel({ plan, rootDir: missingCurrentRoot }).advance(start('missing-current'));
  await unlink(join(missingCurrentRoot, '.kernel', 'CURRENT'));
  await assert.rejects(() => makeRunKernel({ plan, rootDir: missingCurrentRoot }).advance(start('missing-current')), (error) => error instanceof KernelError && error.code === 'ManifestMismatch');

  const lockRoot = await mkdtemp(join(tmpdir(), 'lunacy-s5-lock-'));
  await makeRunKernel({ plan, rootDir: lockRoot }).advance(start('lock'));
  const lockPath = join(lockRoot, '.kernel', '.writer.lock');
  await unlink(lockPath).catch(() => undefined); await symlink(join(outside, 'lock-target'), lockPath);
  await assert.rejects(() => makeRunKernel({ plan, rootDir: lockRoot }).advance(input('lock', 'late', { kind: 'RESUME' }, { revision: 1, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 })), (error) => error instanceof KernelError && error.code === 'ManifestMismatch');

  await unlink(lockPath); await writeFile(lockPath, canonicalString({ pid: process.pid + 99_999_999, started: 0, nonce: 'dead' }));
  const resumed = await makeRunKernel({ plan, rootDir: lockRoot }).advance(input('lock', 'resume', { kind: 'RESUME' }, { revision: 1, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 }));
  assert.ok(resumed);

  const generationRoot = await mkdtemp(join(tmpdir(), 'lunacy-s5-generation-'));
  await makeRunKernel({ plan, rootDir: generationRoot }).advance(start('generation'));
  const generationCurrent = JSON.parse(await readFile(join(generationRoot, '.kernel', 'CURRENT'), 'utf8'));
  const outsideGeneration = await mkdtemp(join(tmpdir(), 'lunacy-s5-generation-outside-'));
  await rm(join(generationRoot, '.kernel', 'generations', `g${generationCurrent.generation}`), { recursive: true, force: true });
  await symlink(outsideGeneration, join(generationRoot, '.kernel', 'generations', `g${generationCurrent.generation}`));
  await assert.rejects(() => makeRunKernel({ plan, rootDir: generationRoot }).advance(input('generation', 'late', { kind: 'RESUME' }, { revision: 1, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 })), (error) => error instanceof KernelError && error.code === 'ManifestMismatch');

  const reuseRoot = await mkdtemp(join(tmpdir(), 'lunacy-s5-reuse-dir-'));
  await makeRunKernel({ plan, rootDir: reuseRoot }).advance(start('reuse-dir'));
  const outsideReuse = await mkdtemp(join(tmpdir(), 'lunacy-s5-reuse-outside-'));
  await mkdir(join(reuseRoot, '.kernel', 'reuse', 'pins'), { recursive: true });
  await rm(join(reuseRoot, '.kernel', 'reuse', 'pins'), { recursive: true, force: true });
  await symlink(outsideReuse, join(reuseRoot, '.kernel', 'reuse', 'pins'));
  await assert.rejects(() => makeRunKernel({ plan, rootDir: reuseRoot }).advance(input('reuse-dir', 'late', { kind: 'RESUME' }, { revision: 1, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0 })), (error) => error instanceof KernelError && error.code === 'ManifestMismatch');

  const pinRoot = await mkdtemp(join(tmpdir(), 'lunacy-s5-reuse-pin-'));
  const pinKernel = makeRunKernel({ plan, rootDir: pinRoot });
  const pinStart = await pinKernel.advance(start('reuse-pin'));
  const outsidePin = join(outsideReuse, 'pin-target'); await writeFile(outsidePin, 'must-survive');
  const pinName = `${'a'.repeat(64)}-${'b'.repeat(64)}.pin`;
  await mkdir(join(pinRoot, '.kernel', 'reuse', 'pins'), { recursive: true });
  await mkdir(join(pinRoot, '.kernel', 'reuse', 'blobs'));
  await mkdir(join(pinRoot, '.kernel', 'reuse', 'quarantine'));
  await symlink(outsidePin, join(pinRoot, '.kernel', 'reuse', 'pins', pinName));
  await pinKernel.advance(input('reuse-pin', 'resume', { kind: 'RESUME' }, pinStart.snapshot));
  assert.equal(await readFile(outsidePin, 'utf8'), 'must-survive');
  assert.ok((await readdir(join(pinRoot, '.kernel', 'reuse', 'quarantine'))).some((name) => name.startsWith(pinName)));
});

test('appendJournal refuses a byte-ceiling crossing without mutating the candidate', () => {
  const state = createInitialState('r', plan, digest(plan), 'none');
  const event = { kind: 'PARENT_DECISION', token: 'x', value: 'x'.repeat(1_100_000) };
  const identity = { runId: 'r', phaseId: 'p', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'huge', payloadDigest: digest(event) };
  assert.throws(() => appendJournal(state, identity, event), /JournalCeiling/);
  assert.equal(state.revision, 0); assert.equal(state.journal.length, 0);
});

test('file store refuses a malformed candidate journal before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s5-candidate-journal-'));
  const store = new FileArtifactStore(root);
  const candidate = createInitialState('candidate', plan, digest(plan), 'none');
  candidate.journal = [{ bad: true }];
  await assert.rejects(() => store.commit(0, candidate), /ManifestMismatch/);
  assert.equal((await store.load()).state, undefined);
});

test('forged fixed-cell handles fail closed without a cache hit', async () => {
  const snapshot = makeSnapshotHandle({ generation: 1, treeDigest: digest('t'), symlinkDigest: digest('s'), mountDigest: digest('m'), readSetDigest: digest('r'), sourceDigests: [] });
  const valid = makeCellHandle({ tenant: 't', principal: 'p', workspace: 'w', sensitivity: 'RUN_PRIVATE', accessEpoch: 0, policyEpoch: 0 });
  const forged = { ...valid, identity: digest('not-the-tuple') };
  const metrics = (await import('../dist/metrics.js')).AccelerationMetrics;
  const counters = new metrics();
  const kernel = makeRunKernel({ plan, acceleration: { context: 'ON', reuse: 'ON', cell: forged, snapshot, metrics: counters } });
  const y = await kernel.advance(start('forged'));
  assert.equal(y.kind, 'WAITING'); assert.equal(counters.snapshot().reuseHit, 0); assert.ok(counters.snapshot().contextCorrupt >= 1);
});

test('self-consistent but forged BASE bytes are a cold miss, not a cache hit', async () => {
  const cell = makeCellHandle({ tenant: 't', principal: 'p', workspace: 'w', sensitivity: 'RUN_PRIVATE', accessEpoch: 0, policyEpoch: 0 });
  const snapshot = makeSnapshotHandle({ generation: 1, treeDigest: digest('tree'), symlinkDigest: digest('symlink'), mountDigest: digest('mount'), readSetDigest: digest('read'), sourceDigests: [] });
  const request = { runId: 'r', generation: 1, writerFence: 'wf', cell, snapshot, authorityDigest: digest(plan), authorityEpoch: 0, derivation: { id: 's5', version: '1', schema: 'v1' }, sources: [], build: () => '{"stable":"expected"}' };
  const cold = new FixedCellReuse('OFF').prepare(request);
  const forged = { key: cold.lookupKey, contentAddress: digest('{"stable":"forged"}'), bytes: '{"stable":"forged"}', runId: 'r', generation: 1, authorityDigest: digest(plan), authorityEpoch: 0, cellDigest: cell.identity, snapshotDigest: digest(snapshot), reuseEpoch: cell.reuseEpoch, writerFence: 'wf', schema: 'safe-fixed-base/v1' };
  let quarantined = false;
  const result = await new FixedCellReuse('ON').prepareWithStore(request, {
    reuseLookup: async () => forged,
    reuseStage: async () => undefined,
    reuseQuarantine: async () => { quarantined = true; },
  });
  assert.equal(result.hit, false); assert.equal(result.bytes, cold.bytes); assert.equal(quarantined, true);
});

test('BASE and VIEW stable prefixes never alias in the fixed-cell key', async () => {
  const cell = makeCellHandle({ tenant: 't', principal: 'p', workspace: 'w', sensitivity: 'RUN_PRIVATE', accessEpoch: 0, policyEpoch: 0 });
  const snapshot = makeSnapshotHandle({ generation: 1, treeDigest: digest('tree'), symlinkDigest: digest('symlink'), mountDigest: digest('mount'), readSetDigest: digest('read'), sourceDigests: [] });
  const compiler = new ContextCompiler({ mode: 'ON', reuseMode: 'ON' });
  const common = { proof: { runId: 'r', authorityDigest: digest(plan), authorityEpoch: 0, generation: 1, revision: 0 }, scope: { tenant: 't', principal: 'p', workspace: 'w', sensitivity: 'RUN_PRIVATE' }, sources: [], derivation: { id: 'same', version: '1', schema: 'v1' }, snapshot, cell, dynamicTail: { bytes: 'tail', eventId: 'e', snapshotDigest: digest(snapshot) } };
  const base = await compiler.prepare({ ...common, kind: 'BASE' });
  const view = await compiler.prepare({ ...common, kind: 'VIEW', dynamicTail: { ...common.dynamicTail, eventId: 'view' } });
  assert.notEqual(base.lookupKey, view.lookupKey); assert.notEqual(base.stableDigest, view.stableDigest); assert.equal(view.hit, false);
});
