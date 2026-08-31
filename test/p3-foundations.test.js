import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunKernel } from '../dist/index.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { createManagedCapability, verifyManagedCapability, reserveManaged } from '../dist/managed-capability.js';
import { FileArtifactStore, MemoryArtifactStore } from '../dist/store.js';
import { createInitialState, migrateMachineState } from '../dist/reducer.js';

const plan = { phaseId: 'p3-foundations', steps: [{ stepId: 'a' }] };
const start = (runId, eventId = 'start') => {
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan), bytes: canonicalString(plan) } };
  return { runId, identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId, payloadDigest: digest(event) }, event };
};

test('managed capability checksum and all-dimension reservation are fail closed', () => {
  const capability = createManagedCapability({ ceilings: { waves: 1, calls: 1, inTok: 2, outTok: 2, reportBytes: 10, refs: 2, persistedBytes: 10, deadline: 100 } });
  assert.equal(verifyManagedCapability(capability), true);
  assert.equal(capability.route, 'gpt-5.6-luna/max');
  assert.equal(verifyManagedCapability({ ...capability, route: 'gpt-5.6-sol/high' }), false);
  const oldBase = { ...capability, route: 'gpt-5.6-luna/xhigh' };
  delete oldBase.checksum;
  const oldCapability = { ...oldBase, checksum: digest(oldBase) };
  assert.equal(verifyManagedCapability(oldCapability), false);
  assert.throws(() => createManagedCapability(oldCapability), /gpt-5\.6-luna\/max/);
  assert.throws(() => createManagedCapability({ route: 'gpt-5.6-luna/high' }), /gpt-5\.6-luna\/max/);
  assert.throws(() => createManagedCapability({ artifactSchemas: ['Wave/v2', 'Future/v9'] }), /artifactSchemas/);
  const zero = { waves: 0, calls: 0, inTok: 0, outTok: 0, reportBytes: 0, refs: 0, persistedBytes: 0, deadline: Number.MAX_SAFE_INTEGER };
  const request = { waves: 1, calls: 1, inTok: 2, outTok: 2, reportBytes: 10, refs: 2, persistedBytes: 10, deadline: 100 };
  assert.ok(reserveManaged(zero, request, capability.ceilings));
  assert.equal(reserveManaged({ ...zero, calls: 1 }, request, capability.ceilings), undefined);
});

test('schema-1 migration materializes schema-2 managed envelope deterministically', () => {
  const legacy = createInitialState('r', plan, digest(plan), 'none');
  const migrated = migrateMachineState(legacy, createManagedCapability());
  assert.equal(legacy.schema, 1);
  assert.equal(migrated.schema, 2);
  assert.equal(migrated.managed?.proposal, undefined);
  assert.deepEqual(migrated.managed?.waveCounters, { waves: 0, calls: 0, inTok: 0, outTok: 0, reportBytes: 0, refs: 0, persistedBytes: 0, deadline: Number.MAX_SAFE_INTEGER });
});

test('schema migration write fault cuts recover an old-or-new readable generation', async () => {
  const cuts = ['state-fsync', 'journal-fsync', 'generation-rename', 'generation-published', 'CURRENT-fsync', 'CURRENT-rename', 'CURRENT-published'];
  for (const cut of cuts) {
    const root = await mkdtemp(join(tmpdir(), 'p3-managed-migration-cut-'));
    try {
      const legacy = createInitialState(`cut-${cut}`, plan, digest(plan), 'none');
      const oldStore = new FileArtifactStore(root);
      await oldStore.commit(0, legacy);
      const migrated = migrateMachineState(legacy, createManagedCapability());
      let armed = true;
      const faultStore = new FileArtifactStore(root, { faultInjector: (point) => { if (armed && point === cut) { armed = false; throw new Error(`fault:${point}`); } } });
      await assert.rejects(() => faultStore.commit(1, migrated), /fault|ManifestMismatch|conflict/);
      const recovered = await new FileArtifactStore(root).load();
      assert.ok(recovered.state);
      assert.ok(recovered.state.schema === 1 || recovered.state.schema === 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('publication lease lifecycle is shared by memory and file stores', async () => {
  for (const store of [new MemoryArtifactStore(), new FileArtifactStore(await mkdtemp(join(tmpdir(), 'p3-foundations-')))]) {
    const ref = { id: 'r', digest: digest('r'), bytes: canonicalString('r') };
    const lease = await store.acquirePublicationLease('lease-test', [ref]);
    assert.equal(lease.status, 'ACTIVE');
    await assert.rejects(() => store.acquirePublicationLease('lease-ttl', [ref], 0), /ttl/);
    assert.equal((await store.promotePublicationLease('lease-test')).status, 'PROMOTED');
    await store.acquirePublicationLease('lease-expired', [ref], 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await store.collectPublicationLeases(Date.now() + 1000)).removed, 1);
    await assert.rejects(() => store.acquirePublicationLease('lease-test', [ref]), /promoted/);
    await store.releasePublicationLease('lease-test');
  }
});

test('managed START binds proposal, lease, and reservation without changing public Yield', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-managed-start-'));
  try {
    const kernel = makeRunKernel({ plan, rootDir: root, maxInFlight: 1, managedCapability: createManagedCapability() });
    const yielded = await kernel.advance(start('managed'));
    assert.equal(yielded.kind, 'WAITING');
    const current = JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8'));
    const state = JSON.parse(await readFile(join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json'), 'utf8'));
    assert.equal(state.schema, 2);
    assert.equal(typeof state.managed.proposal.key, 'string');
    assert.equal(Object.keys(state.managed.reservations).length, 1);
    assert.equal(state.managed.leaseSets[state.managed.proposal.leaseSetId].status, 'PROMOTED');
    const store = new FileArtifactStore(root);
    await assert.rejects(() => store.promotePublicationLease(state.managed.proposal.leaseSetId), /unavailable|absent/);
    assert.equal(yielded.snapshot.pendingDispatchCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed START requires a closed artifact existence proof before leasing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-managed-missing-bytes-'));
  try {
    const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
    const input = { ...start('missing-bytes'), event, identity: { ...start('missing-bytes').identity, payloadDigest: digest(event) } };
    const yielded = await makeRunKernel({ plan, rootDir: root, managedCapability: createManagedCapability() }).advance(input);
    assert.equal(yielded.kind, 'BLOCKED');
    await assert.rejects(() => readFile(join(root, '.kernel', 'publication-leases', `${digest('lease-missing').toString()}.json`)), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('managed START rejects foreign graph id and scope before leasing', async () => {
  for (const [label, intentRef] of [
    ['foreign-id', { id: 'foreign-plan', digest: digest(plan), bytes: canonicalString(plan) }],
    ['foreign-scope', { id: 'plan', scope: 'foreign-run', digest: digest(plan), bytes: canonicalString(plan) }],
  ]) {
    const root = await mkdtemp(join(tmpdir(), `p3-managed-${label}-`));
    try {
      const base = start(label);
      const event = { kind: 'START', intentRef };
      const yielded = await makeRunKernel({ plan, rootDir: root, managedCapability: createManagedCapability() }).advance({ ...base, event, identity: { ...base.identity, payloadDigest: digest(event) } });
      assert.equal(yielded.kind, 'BLOCKED');
      await assert.rejects(() => readFile(join(root, '.kernel', 'publication-leases', 'any.json')), /ENOENT/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('schema-2 graph closure rejects foreign, orphan, and missing-byte roots on commit/load/resume', async () => {
  const waveRef = { id: 'plan', digest: digest(plan), bytes: canonicalString(plan) };
  const invalidCases = [
    ['foreign-id', (state) => { state.managed.proposal.waveRef = { ...waveRef, id: 'foreign-plan' }; }],
    ['foreign-scope', (state) => { state.managed.proposal.waveRef = { ...waveRef, scope: 'foreign-run' }; }],
    ['orphan-root', (state) => { state.managed.proposal.leaseSetId = 'missing-root'; }],
    ['missing-bytes', (state) => { state.managed.proposal.waveRef = { id: 'plan', digest: waveRef.digest }; }],
  ];
  for (const [label, mutate] of invalidCases) {
    const valid = migrateMachineState(createInitialState(`graph-${label}`, plan, digest(plan), 'none'), createManagedCapability());
    valid.managed.proposal = { key: digest(`proposal-${label}`), waveRef, planDigest: valid.planDigest, leaseSetId: 'lease-root' };
    valid.managed.leaseSets['lease-root'] = { leaseId: 'lease-root', closedRefGraph: [waveRef], expiresAt: Number.MAX_SAFE_INTEGER, status: 'PROMOTED' };
    const candidate = JSON.parse(JSON.stringify(valid));
    mutate(candidate);
    await assert.rejects(() => new MemoryArtifactStore().commit(0, candidate), /ManifestMismatch/);

    const root = await mkdtemp(join(tmpdir(), `p3-managed-graph-${label}-`));
    try {
      const store = new FileArtifactStore(root);
      await store.commit(0, valid);
      const currentPath = join(root, '.kernel', 'CURRENT');
      const current = JSON.parse(await readFile(currentPath, 'utf8'));
      const statePath = join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json');
      mutate(valid);
      await writeFile(statePath, canonicalString(valid));
      await writeFile(currentPath, canonicalString({ ...current, stateDigest: digest(valid) }));
      await assert.rejects(() => new FileArtifactStore(root).load(), /ManifestMismatch/);
      const event = { kind: 'RESUME' };
      await assert.rejects(() => makeRunKernel({ plan, rootDir: root, managedCapability: createManagedCapability() }).advance({
        runId: valid.runId,
        expectedRevision: valid.revision,
        identity: { runId: valid.runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'resume', payloadDigest: digest(event) },
        event,
      }), /ManifestMismatch/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('managed kill switch blocks before admission callback', async () => {
  let calls = 0;
  const yielded = await makeRunKernel({
    plan,
    managedCapability: createManagedCapability(),
    managedKillSwitch: true,
    admission: async () => { calls += 1; return true; },
  }).advance(start('kill-switch'));
  assert.equal(yielded.kind, 'BLOCKED');
  assert.equal(calls, 0);
});

test('managed reservations conservatively admit two independent commands', async () => {
  const twoStepPlan = { phaseId: 'p3-capacity', steps: [{ stepId: 'a' }, { stepId: 'b' }] };
  const runId = 'two-commands';
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(twoStepPlan), bytes: canonicalString(twoStepPlan) } };
  const input = { runId, event, identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'start', payloadDigest: digest(event) } };
  const capability = createManagedCapability({ ceilings: { waves: 1, calls: 2, inTok: 2, outTok: 2, reportBytes: 2, refs: 2, persistedBytes: 2 } });
  const root = await mkdtemp(join(tmpdir(), 'p3-managed-capacity-'));
  try {
    const yielded = await makeRunKernel({ plan: twoStepPlan, rootDir: root, maxInFlight: 2, managedCapability: capability }).advance(input);
    assert.equal(yielded.kind, 'WAITING');
    const current = JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8'));
    const state = JSON.parse(await readFile(join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json'), 'utf8'));
    assert.equal(Object.keys(state.outbox).length, 2);
    assert.equal(Object.keys(state.managed.reservations).length, 2);
    assert.equal(state.managed.waveCounters.calls, 2);
    assert.equal(state.managed.waveCounters.inTok, 2);
    assert.equal(state.managed.waveCounters.outTok, 2);
    assert.equal(state.managed.waveCounters.reportBytes, 2);
    assert.equal(state.managed.waveCounters.refs, 2);
    assert.equal(state.managed.waveCounters.persistedBytes, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file lease GC rechecks authoritative CURRENT lease roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-managed-gc-root-'));
  try {
    const store = new FileArtifactStore(root);
    const artifact = { id: 'plan', digest: digest('artifact'), bytes: canonicalString('artifact') };
    const lease = await store.acquirePublicationLease('rooted-lease', [artifact], 1);
    const state = migrateMachineState(createInitialState('gc-run', plan, digest(plan), 'none'), createManagedCapability());
    state.managed.proposal = { key: digest('gc-proposal'), waveRef: artifact, planDigest: state.planDigest, leaseSetId: lease.leaseId };
    state.managed.leaseSets[lease.leaseId] = { leaseId: lease.leaseId, closedRefGraph: [artifact], expiresAt: lease.expiresAt, status: 'ACTIVE' };
    await store.commit(0, state);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await store.collectPublicationLeases(Date.now() + 1000)).removed, 0);
    await readFile(join(root, '.kernel', 'publication-leases', `${digest(lease.leaseId)}.json`), 'utf8');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('memory lease GC applies the same authoritative-root rule', async () => {
  const store = new MemoryArtifactStore();
  const artifact = { id: 'plan', digest: digest('artifact'), bytes: canonicalString('artifact') };
  const lease = await store.acquirePublicationLease('rooted-memory-lease', [artifact], 1);
  const state = migrateMachineState(createInitialState('gc-memory-run', plan, digest(plan), 'none'), createManagedCapability());
  state.managed.proposal = { key: digest('gc-memory-proposal'), waveRef: artifact, planDigest: state.planDigest, leaseSetId: lease.leaseId };
  state.managed.leaseSets[lease.leaseId] = { leaseId: lease.leaseId, closedRefGraph: [artifact], expiresAt: lease.expiresAt, status: 'ACTIVE' };
  await store.commit(0, state);
  assert.equal((await store.collectPublicationLeases(Date.now() + 1000)).removed, 0);
});

test('managed schema-2 state never falls back when descriptor is absent or mismatched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p3-managed-restart-'));
  try {
    const capability = createManagedCapability();
    await makeRunKernel({ plan, rootDir: root, managedCapability: capability }).advance(start('managed-restart'));
    const currentPath = join(root, '.kernel', 'CURRENT');
    const current = JSON.parse(await readFile(currentPath, 'utf8'));
    const resume = { runId: 'managed-restart', identity: { runId: 'managed-restart', phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'resume', payloadDigest: digest({ kind: 'RESUME' }) }, event: { kind: 'RESUME' }, expectedRevision: 1 };
    const absent = await makeRunKernel({ plan, rootDir: root }).advance(resume);
    assert.equal(absent.kind, 'BLOCKED');
    const mismatched = await makeRunKernel({ plan, rootDir: root, managedCapability: createManagedCapability({ ceilings: { calls: 2 } }) }).advance({ ...resume, identity: { ...resume.identity, eventId: 'resume-mismatch' } });
    assert.equal(mismatched.kind, 'BLOCKED');
    assert.equal(JSON.parse(await readFile(currentPath, 'utf8')).generation, current.generation);
  } finally { await rm(root, { recursive: true, force: true }); }
});
