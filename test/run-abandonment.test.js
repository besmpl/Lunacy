
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalString, digest, digestBytes } from '../dist/canonical.js';
import { inspectRetentionRun, prepareRunAbandonment, sealRetentionRun, validateAbandonReceipt, validateParentAbandonment } from '../dist/run-retention.js';
import { initRun } from '../dist/orchestration.js';
import { FileArtifactStore } from '../dist/store.js';
import { syntheticPlatform } from './fixtures/session-lifecycle/retention-helper.mjs';

const repo = resolve('.');
const custody = Object.freeze({ schema: 'lunacy-run-custody-summary/v1', pending: 0, claimed: 0, unknown: 1, malformed: 1 });
const emptyCustody = Object.freeze({ schema: 'lunacy-run-custody-summary/v1', pending: 0, claimed: 0, unknown: 0, malformed: 0 });

async function abandonmentFixture(status = 'BLOCKED') {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-abandonment-')); const runRoot = join(root, 'run'); await mkdir(join(runRoot, '.work/nested'), { recursive: true });
  const plan = '# Plan\n'; const state = `# State\nstatus: ${status}\n`; await writeFile(join(runRoot, 'PLAN.md'), plan); await writeFile(join(runRoot, 'STATE.md'), state); await writeFile(join(runRoot, '.work/output.log'), 'raw output'); await writeFile(join(runRoot, '.work/nested/proof.txt'), 'proof');
  await mkdir(join(runRoot, '.kernel')); await writeFile(join(runRoot, '.kernel/CURRENT'), 'unknown-custody'); await mkdir(join(runRoot, '.codex-effects')); await writeFile(join(runRoot, '.codex-effects/malformed'), '{not-json');
  const authority = { schema: 'lunacy-run-abandonment/v1', runId: 'fixture-run', disposition: 'ABANDONED', status, reasonCode: 'PARENT_STOPPED', activeWorkers: 'NONE', authorityDigest: digest([{ path: 'PLAN.md', digest: digestBytes(Buffer.from(plan)) }]), terminalStateDigest: digestBytes(Buffer.from(state)), custody };
  const authorityPath = join(root, 'authority.json'); await writeFile(authorityPath, canonicalString(authority));
  return { root, runRoot, authorityPath, authority };
}
async function snapshotCustody(runRoot) { return Promise.all(['.kernel/CURRENT', '.codex-effects/malformed'].map(async (name) => { const path = join(runRoot, name); const info = await stat(path); return { name, dev: String(info.dev), ino: String(info.ino), mode: info.mode, bytes: await readFile(path, 'utf8') }; })); }
async function prepared(status = 'BLOCKED') { const fixture = await abandonmentFixture(status); await prepareRunAbandonment(fixture.runRoot, fixture.authorityPath); return fixture; }

async function durableFixture(kind, authorityCustody = emptyCustody) {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-abandonment-current-')); const runRoot = join(root, 'run'); const runId = 'fixture-run'; const planObject = { phaseId: 'abandon', steps: [{ stepId: 'one' }] };
  await initRun({ runDir: runRoot, runId, plan: planObject }); const store = new FileArtifactStore(runRoot); const loaded = await store.load(); const state = structuredClone(loaded.state); const command = Object.values(state.outbox)[0];
  if (kind === 'ACTIVE') command.state = 'ACKED';
  else if (kind === 'CLAIMED') command.state = 'CLAIMED';
  else if (kind === 'UNKNOWN' || kind === 'IDLE') { state.attemptEpoch += 1; state.steps.one.status = 'DONE'; state.status = 'BLOCKED'; state.nextAction = 'blocked'; command.state = kind === 'UNKNOWN' ? 'UNKNOWN' : 'ACKED'; }
  if (kind !== 'PENDING') await store.commit(loaded.generation, state);
  const plan = '# Plan\n'; const stateMarkdown = '# State\nstatus: BLOCKED\n'; await mkdir(join(runRoot, '.work'), { recursive: true }); await writeFile(join(runRoot, 'PLAN.md'), plan); await writeFile(join(runRoot, 'STATE.md'), stateMarkdown); await writeFile(join(runRoot, '.work/output.log'), 'raw output');
  const phaseSteps = await readFile(join(runRoot, 'phases/abandon/STEPS.md')); const authority = { schema: 'lunacy-run-abandonment/v1', runId, disposition: 'ABANDONED', status: 'BLOCKED', reasonCode: 'PARENT_STOPPED', activeWorkers: 'NONE', authorityDigest: digest([{ path: 'PLAN.md', digest: digestBytes(Buffer.from(plan)) }, { path: 'phases/abandon/STEPS.md', digest: digestBytes(phaseSteps) }]), terminalStateDigest: digestBytes(Buffer.from(stateMarkdown)), custody: authorityCustody };
  const authorityPath = join(root, 'authority.json'); await writeFile(authorityPath, canonicalString(authority)); return { root, runRoot, authorityPath, authority };
}

async function snapshotDurableCurrent(runRoot) {
  const currentPath = join(runRoot, '.kernel/CURRENT'); const current = JSON.parse(await readFile(currentPath, 'utf8')); const generationDir = join(runRoot, '.kernel/generations', `g${current.generation}`); const names = ['CURRENT', ...(await readdir(generationDir)).map((name) => `generations/g${current.generation}/${name}`)];
  return Promise.all(names.sort().map(async (name) => { const path = join(runRoot, '.kernel', name); const info = await stat(path); return { name, dev: String(info.dev), ino: String(info.ino), mode: info.mode, bytes: await readFile(path, 'utf8') }; }));
}

async function makePreparedFixtureActionable(fixture, commandState) {
  const store = new FileArtifactStore(fixture.runRoot); const loaded = await store.load(); const state = structuredClone(loaded.state); const command = Object.values(state.outbox)[0]; state.steps.one.status = 'ACTIVE'; state.status = 'ACTIVE'; state.nextAction = commandState === 'PENDING' ? 'await-dispatch-receipt' : 'await-worker-envelope'; command.state = commandState; await store.commit(loaded.generation, state);
}

test('abandonment authority and receipt validators are closed, bounded, and never carry result identity', async () => {
  const fixture = await prepared(); assert.deepEqual(validateParentAbandonment(fixture.authority), fixture.authority);
  for (const invalid of [
    { ...fixture.authority, extra: true },
    { ...fixture.authority, status: 'ACTIVE' },
    { ...fixture.authority, activeWorkers: 'worker-1' },
    { ...fixture.authority, reasonCode: 'x'.repeat(65) },
    { ...fixture.authority, custody: { ...custody, pending: 1 } },
    { ...fixture.authority, custody: { ...custody, claimed: 1 } },
  ]) assert.throws(() => validateParentAbandonment(invalid));
  await sealRetentionRun(fixture.runRoot, { mode: 'abandon', platform: syntheticPlatform }); const receipt = JSON.parse(await readFile(join(fixture.runRoot, 'ABANDON-RECEIPT.json'), 'utf8')); assert.deepEqual(validateAbandonReceipt(receipt), receipt); assert.equal(receipt.schema, 'lunacy-run-abandon-receipt/v1'); assert.equal(receipt.status, 'BLOCKED'); assert.deepEqual(receipt.retainedCustody, custody); assert.ok(!('resultIdentity' in receipt)); assert.throws(() => validateAbandonReceipt({ ...receipt, resultIdentity: {} }));
  await prepareRunAbandonment(fixture.runRoot, fixture.authorityPath); assert.equal((await sealRetentionRun(fixture.runRoot, { mode: 'abandon', platform: syntheticPlatform })).status, 'ALREADY_SEALED'); assert.ok(!(await readdir(fixture.runRoot)).includes('.lunacy-parent-abandonment.json'));
});

test('only explicit BLOCKED/STOPPED authority is admitted and exact authority/state digests are revalidated', async () => {
  for (const status of ['BLOCKED', 'STOPPED']) { const fixture = await prepared(status); assert.equal((await sealRetentionRun(fixture.runRoot, { mode: 'abandon', platform: syntheticPlatform })).status, 'SEALED'); }
  const missing = await abandonmentFixture(); await assert.rejects(() => sealRetentionRun(missing.runRoot, { mode: 'abandon', platform: syntheticPlatform }), /parent abandonment.*(?:absent|unsafe|does not exist)/);
  const active = await abandonmentFixture('ACTIVE'); await assert.rejects(() => prepareRunAbandonment(active.runRoot, active.authorityPath), /parent abandonment/);
  const digestDrift = await abandonmentFixture(); await writeFile(digestDrift.runRoot + '/PLAN.md', '# changed\n'); await assert.rejects(() => prepareRunAbandonment(digestDrift.runRoot, digestDrift.authorityPath), /authority changed/);
  const stateDrift = await abandonmentFixture(); await writeFile(stateDrift.runRoot + '/STATE.md', '# changed\n'); await assert.rejects(() => prepareRunAbandonment(stateDrift.runRoot, stateDrift.authorityPath), /STATE changed/);
  const ambiguous = await prepared(); await writeFile(join(ambiguous.runRoot, '.lunacy-parent-acceptance.json'), canonicalString({ schema: 'foreign' })); await assert.rejects(() => sealRetentionRun(ambiguous.runRoot, { mode: 'abandon', platform: syntheticPlatform }), /accepted and abandoned authority collide/);
});

test('UNKNOWN and malformed Custody are retained byte-for-byte while active workers and open handles refuse', async () => {
  const fixture = await prepared(); const before = await snapshotCustody(fixture.runRoot); await sealRetentionRun(fixture.runRoot, { mode: 'abandon', platform: syntheticPlatform }); assert.deepEqual(await snapshotCustody(fixture.runRoot), before); assert.ok(!(await readdir(fixture.runRoot)).includes('.work'));
  const active = await abandonmentFixture(); const activeAuthority = { ...active.authority, activeWorkers: 'worker-1' }; await writeFile(active.authorityPath, canonicalString(activeAuthority)); await assert.rejects(() => prepareRunAbandonment(active.runRoot, active.authorityPath), /parent abandonment/);
  for (const message of ['WRITER_ACTIVE: stale worker witness remains', 'open handles remain']) {
    const held = await prepared(); const platform = { ...syntheticPlatform, async captureRunSealQuiescence() { throw new Error(message); } };
    await assert.rejects(() => sealRetentionRun(held.runRoot, { mode: 'abandon', platform }), message.startsWith('WRITER') ? /WRITER_ACTIVE/ : /QUIESCENCE_UNAVAILABLE/); assert.ok((await readdir(held.runRoot)).includes('.work'));
  }
});

test('durable CURRENT refuses false-zero ACTIVE, PENDING, and CLAIMED custody during preparation', async () => {
  for (const kind of ['ACTIVE', 'PENDING', 'CLAIMED']) {
    const fixture = await durableFixture(kind); const before = await snapshotDurableCurrent(fixture.runRoot);
    await assert.rejects(() => prepareRunAbandonment(fixture.runRoot, fixture.authorityPath), new RegExp(`${kind}=1`)); assert.deepEqual(await snapshotDurableCurrent(fixture.runRoot), before); await assert.rejects(() => readFile(join(fixture.runRoot, '.lunacy-parent-abandonment.json')), /ENOENT/);
  }
});

test('finalization and marker recovery revalidate durable CURRENT instead of trusting prepared zeroes', async () => {
  const finalization = await durableFixture('IDLE'); await prepareRunAbandonment(finalization.runRoot, finalization.authorityPath); await makePreparedFixtureActionable(finalization, 'PENDING'); await assert.rejects(() => sealRetentionRun(finalization.runRoot, { mode: 'abandon', platform: syntheticPlatform }), /PENDING=1/); assert.ok((await readdir(finalization.runRoot)).includes('.work'));
  const recovery = await durableFixture('IDLE'); await prepareRunAbandonment(recovery.runRoot, recovery.authorityPath); await assert.rejects(() => sealRetentionRun(recovery.runRoot, { mode: 'abandon', platform: syntheticPlatform, fault(point) { if (point === 'MARKER_FSYNC') throw new Error('cut:marker'); } }), /cut:marker/); await makePreparedFixtureActionable(recovery, 'CLAIMED'); await assert.rejects(() => sealRetentionRun(recovery.runRoot, { mode: 'resume', platform: syntheticPlatform }), /CLAIMED=1/); assert.ok((await readdir(recovery.runRoot)).includes('.work'));
});

test('durable UNKNOWN and malformed Custody are reflected and preserved rather than reinterpreted', async () => {
  const unknown = await durableFixture('UNKNOWN', { ...emptyCustody, unknown: 1 }); await prepareRunAbandonment(unknown.runRoot, unknown.authorityPath); const before = await snapshotDurableCurrent(unknown.runRoot); await sealRetentionRun(unknown.runRoot, { mode: 'abandon', platform: syntheticPlatform }); assert.deepEqual(await snapshotDurableCurrent(unknown.runRoot), before); assert.deepEqual(JSON.parse(await readFile(join(unknown.runRoot, 'ABANDON-RECEIPT.json'), 'utf8')).retainedCustody, { ...emptyCustody, unknown: 1 });
  const hiddenUnknown = await durableFixture('UNKNOWN'); await assert.rejects(() => prepareRunAbandonment(hiddenUnknown.runRoot, hiddenUnknown.authorityPath), /classification disagrees/);
  const hiddenMalformed = await abandonmentFixture(); const malformedBefore = await snapshotCustody(hiddenMalformed.runRoot); hiddenMalformed.authority.custody = { ...custody, malformed: 0 }; await writeFile(hiddenMalformed.authorityPath, canonicalString(hiddenMalformed.authority)); await assert.rejects(() => prepareRunAbandonment(hiddenMalformed.runRoot, hiddenMalformed.authorityPath), /malformed durable Custody is not reflected/); assert.deepEqual(await snapshotCustody(hiddenMalformed.runRoot), malformedBefore);
});

const cuts = ['STAGED_RECEIPT_FSYNC', 'MARKER_FSYNC', 'BODY_RENAME', 'BODY_RENAME_FSYNC', 'FROZEN_REVALIDATED', 'BEFORE_RECEIPT_RENAME', 'RECEIPT_RENAME', 'RECEIPT_RENAME_FSYNC', 'CLEANUP_ENTRY', 'TOMBSTONE_REMOVED', 'ACCEPTANCE_REMOVED', 'MARKER_REMOVED'];
for (const cut of cuts) test(`abandonment finalization recovers after ${cut}`, async () => {
  const fixture = await prepared(); let fired = false;
  await assert.rejects(() => sealRetentionRun(fixture.runRoot, { mode: 'abandon', platform: syntheticPlatform, fault(point) { if (!fired && point === cut) { fired = true; throw new Error(`cut:${cut}`); } } }), new RegExp(`cut:${cut}`));
  if (cut === 'MARKER_FSYNC') { const marker = JSON.parse(await readFile(join(fixture.runRoot, '.lunacy-run-finalization.json'), 'utf8')); assert.equal(marker.disposition, 'ABANDONED'); assert.equal(marker.acceptanceDigest, digest(fixture.authority)); assert.equal(marker.authorityDigest, fixture.authority.authorityDigest); assert.equal(marker.resultIdentityDigest, '0'.repeat(64)); }
  const recovered = await sealRetentionRun(fixture.runRoot, { mode: cut === 'STAGED_RECEIPT_FSYNC' ? 'abandon' : 'resume', platform: syntheticPlatform }); assert.ok(['SEALED', 'RESUMED', 'ALREADY_SEALED'].includes(recovered.status));
  const names = await readdir(fixture.runRoot); assert.ok(names.includes('ABANDON-RECEIPT.json')); assert.ok(!names.includes('RUN-RECEIPT.json')); assert.ok(!names.includes('.work')); assert.ok(!names.some((name) => name.startsWith('.work.prune-'))); assert.equal((await inspectRetentionRun(fixture.runRoot)).code, 'ABANDONED_CLEAN');
});

test('accepted and abandoned terminal states remain distinct in API, doctor, and deployment compatibility', async () => {
  const fixture = await prepared(); await sealRetentionRun(fixture.runRoot, { mode: 'abandon', platform: syntheticPlatform }); await assert.rejects(() => sealRetentionRun(fixture.runRoot, { mode: 'dry-run', platform: syntheticPlatform }), /abandoned run cannot be accepted/);
  const target = await mkdtemp(join(tmpdir(), 'lunacy-abandon-deploy-'));
  try {
    let result = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, '--retention-admission', 'OFF', '--retention-abandonment', 'OFF', '--retention-run-parent', dirname(fixture.runRoot)], { cwd: repo, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); assert.ok(JSON.parse(result.stdout).retentionStateSchemas.includes('ABANDON-RECEIPT.json/lunacy-run-abandon-receipt/v1'));
    const launcher = join(target, 'runtime/retention-launcher.mjs'); result = spawnSync(process.execPath, [launcher, 'seal-run', '--abandon', '--run-root', fixture.runRoot, '--authority', fixture.authorityPath], { cwd: repo, encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /abandonment is OFF/);
    result = spawnSync(process.execPath, [join(target, 'runtime/tools/seal-run.mjs'), '--abandon', '--run-root', fixture.runRoot, '--authority', fixture.authorityPath], { cwd: repo, encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /direct installed retention tool invocation is forbidden/);
    result = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, '--check', '--retention-admission', 'OFF', '--retention-abandonment', 'OFF', '--retention-run-parent', dirname(fixture.runRoot)], { cwd: repo, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    result = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, '--retention-admission', 'OFF', '--retention-abandonment', 'ON', '--retention-run-parent', dirname(fixture.runRoot)], { cwd: repo, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    result = spawnSync(process.execPath, [launcher, 'seal-run', '--abandon', '--run-root', fixture.runRoot, '--authority', join(fixture.root, 'missing-authority.json')], { cwd: repo, encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.doesNotMatch(result.stderr, /abandonment is OFF/); assert.match(result.stderr, /does not exist/);
    result = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, '--check', '--retention-admission', 'OFF', '--retention-abandonment', 'ON', '--retention-run-parent', dirname(fixture.runRoot)], { cwd: repo, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  } finally { await rm(target, { recursive: true, force: true }); }
});
