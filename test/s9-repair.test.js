import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeadsPlanSource, BeadsUnavailable } from '../dist/beads.js';
import { BridgeError, transition } from '../dist/bridge.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';
import { makeRunKernel } from '../dist/public.js';

async function beadsFixture(id = 'x') {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s9-beads-'));
  const workspace = join(root, 'workspace'); const home = join(root, 'home'); const config = join(root, 'config');
  await mkdir(join(workspace, '.beads'), { recursive: true }); await mkdir(home, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
  const executablePath = join(root, 'bd');
  const line = `{"_type":"issue","id":"${id}","title":"${id}","status":"open","priority":0,"issue_type":"task"}`;
  await writeFile(executablePath, `#!/bin/sh\nif [ "$1" = version ]; then printf '%s' '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}'; exit 0; fi\nprintf '%s\\n' '${line}'\n`);
  await chmod(executablePath, 0o755);
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  const source = new BeadsPlanSource({ executablePath, workspace, homeDir: home, xdgConfigHome: config, expectedBinaryDigest });
  return { root, workspace, home, config, executablePath, source };
}

function acknowledgement(capture) {
  return { snapshotDigest: capture.snapshot.contentDigest, targetPlanDigest: digest(capture.plan), workspaceIdentity: capture.snapshot.workspaceIdentity, bdCommit: capture.snapshot.bdCommit, binaryDigest: capture.snapshot.binaryDigest };
}

function syntheticCapture(id) {
  const content = { schema: 'lunacy-beads-snapshot-v1', source: 'beads', workspaceIdentity: '1'.repeat(64), bdVersion: '1.2.2', bdBuild: '6c124203e', bdCommit: '6c124203e771433a3550c348771a5b5e27fd3c21', bdSchemaVersion: 1, binaryDigest: '2'.repeat(64), issues: [], edges: [] };
  const snapshot = { ...content, contentDigest: digest(content), capturedAt: '2026-01-01T00:00:00Z' };
  const plan = { schema: 'lunacy-plan-v1', phaseId: 'beads', steps: [{ stepId: id, goal: id, dependencies: [], claims: [] }], authorityDigest: snapshot.contentDigest };
  return { snapshot, plan, sourceIds: { [id]: id } };
}

test('raw active acknowledgements reject extra fields before durable mutation', async () => {
  const fixture = await beadsFixture(); const captured = await fixture.source.capture(); const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s9-ack-'));
  await assert.rejects(() => transition({ runDir, runId: 's9-ack', mode: 'runtime', beads: { mode: 'active', source: fixture.source, acknowledgement: { ...acknowledgement(captured), extra: true } } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(captured.plan) } }, eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'Unavailable');
  await assert.rejects(() => readFile(join(runDir, '.kernel', 'CURRENT')));
});

test('private CLI requires an explicit mode and remains inert when omitted', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s9-cli-')); const plan = { phaseId: 's9', steps: [{ stepId: 'a', goal: 'A' }] }; const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
  const planPath = join(runDir, 'plan.json'); const eventPath = join(runDir, 'event.json'); await writeFile(planPath, `${canonicalString(plan)}\n`); await writeFile(eventPath, `${canonicalString(event)}\n`);
  const result = spawnSync(process.execPath, ['dist/bridge-cli.js', '--run-dir', runDir, '--run-id', 's9-cli', '--plan', planPath, '--event', eventPath, '--event-id', 'start'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /--mode is required/); await assert.rejects(() => readFile(join(runDir, '.kernel', 'CURRENT')));
});

test('shadow and markdown reject an unsafe existing run root before capture', async () => {
  const fixture = await beadsFixture(); const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s9-surface-')); await chmod(runDir, 0o777);
  await assert.rejects(() => transition({ runDir, runId: 's9-shadow', mode: 'runtime', plan: { phaseId: 's9', steps: [{ stepId: 'x', goal: 'x' }] }, beads: { mode: 'shadow', source: fixture.source } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest({ phaseId: 's9', steps: [{ stepId: 'x', goal: 'x' }] }) } }, eventId: 'shadow' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
  await assert.rejects(() => transition({ runDir, runId: 's9-markdown', mode: 'markdown' }, { event: { kind: 'RESUME' }, eventId: 'markdown' }), (error) => error instanceof BridgeError && error.code === 'PathMismatch');
});

test('active transition binds the capture method before an await and freezes source options', async () => {
  const fixture = await beadsFixture(); const captured = await fixture.source.capture(); const ack = acknowledgement(captured); assert.throws(() => { fixture.source.options = {}; }, TypeError); assert.throws(() => { fixture.source.options.homeDir = '/tmp/changed'; }, TypeError);
  const original = fixture.source.capture.bind(fixture.source); let release; const gate = new Promise((resolve) => { release = resolve; });
  fixture.source.capture = async (...args) => { await gate; return original(...args); }; const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s9-bind-'));
  const pending = transition({ runDir, runId: 's9-bind', mode: 'runtime', beads: { mode: 'active', source: fixture.source, acknowledgement: ack } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(captured.plan) } }, eventId: 'start' });
  fixture.source.capture = async () => { throw new BeadsUnavailable('replaced'); }; release(); const result = await pending; assert.equal(result.beads?.status, 'captured');
});

test('version/export probes stay on the same verified private executable image', async () => {
  const fixture = await beadsFixture('trusted'); const exportLine = '{"_type":"issue","id":"trusted","title":"trusted","status":"open","priority":0,"issue_type":"task"}';
  const attack = `#!/bin/sh
if [ "$1" = version ]; then
  for candidate in /tmp/lunacy-bd-capture-*/bd /var/folders/*/*/*/lunacy-bd-capture-*/bd; do
    if [ -f "$candidate" ]; then
      replacement="$candidate.new"
      printf '%s\\n' '#!/bin/sh' 'printf \'{"_type":"issue","id":"evil","title":"evil","status":"open","priority":0,"issue_type":"task"}\\n\'' > "$replacement"
      chmod 700 "$replacement"; mv "$replacement" "$candidate" 2>/dev/null || true; break
    fi
  done
  printf '%s' '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}'; exit 0
fi
printf '%s\\n' '${exportLine}'
`;
  await writeFile(fixture.executablePath, attack); await chmod(fixture.executablePath, 0o755); fixture.source = new BeadsPlanSource({ executablePath: fixture.executablePath, workspace: fixture.workspace, homeDir: fixture.home, xdgConfigHome: fixture.config, expectedBinaryDigest: createHash('sha256').update(await readFile(fixture.executablePath)).digest('hex') });
  const capture = await fixture.source.capture(); assert.equal(capture.snapshot.issues[0].sourceId, 'trusted');
});

test('empty or partial bridge and store locks are reclaimed safely', async () => {
  for (const ownerBytes of ['', '{"pid":']) {
    const fixture = await beadsFixture(`lock-${ownerBytes.length}`); const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s9-lock-'));
    const kernelDir = join(runDir, '.kernel'); await mkdir(kernelDir); await writeFile(join(kernelDir, '.bridge.lock'), ownerBytes);
    const capture = await fixture.source.capture();
    const started = await transition({ runDir, runId: `s9-lock-${ownerBytes.length}`, mode: 'runtime', beads: { mode: 'active', source: fixture.source, acknowledgement: acknowledgement(capture) } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(capture.plan) } }, eventId: 'start' });
    assert.equal(started.beads?.status, 'captured');

    const storeRoot = await mkdtemp(join(tmpdir(), 'lunacy-s9-store-lock-')); const storeKernel = join(storeRoot, '.kernel');
    const plan = { phaseId: 's9-store-lock', steps: [{ stepId: 'a', goal: 'A' }] }; const kernel = makeRunKernel({ plan, rootDir: storeRoot });
    await kernel.advance({ runId: `store-${ownerBytes.length}`, identity: { runId: `store-${ownerBytes.length}`, phaseId: plan.phaseId, stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'start', payloadDigest: digest({ kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }) }, event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } } });
    const store = new FileArtifactStore(storeRoot); const loaded = await store.load(); await writeFile(join(storeKernel, '.writer.lock'), ownerBytes); await store.commit(loaded.generation, loaded.state);
  }
});

test('digest-addressed candidate input preserves CURRENT authority while adoption is blocked', async () => {
  const initial = await beadsFixture('old'); const oldCapture = await initial.source.capture(); const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s9-input-'));
  await transition({ runDir, runId: 's9-input', mode: 'runtime', beads: { mode: 'active', source: initial.source, acknowledgement: acknowledgement(oldCapture) } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(oldCapture.plan) } }, eventId: 'start' });
  const changed = await beadsFixture('new'); const drift = await transition({ runDir, runId: 's9-input', mode: 'runtime', beads: { mode: 'active', source: changed.source } }, { event: { kind: 'OBSERVATION', category: 'USER_CHANGE', ref: { id: 'changed', scope: 'test', digest: digest({ changed: true }), bytes: canonicalString({ changed: true }) } }, eventId: 'drift' });
  const changedCapture = await changed.source.capture(); const adoption = await transition({ runDir, runId: 's9-input', mode: 'runtime', beads: { mode: 'active', source: changed.source, acknowledgement: acknowledgement(changedCapture) } }, { event: { kind: 'PARENT_DECISION', token: drift.yield.token, value: { kind: 'ADOPT', digest: digest(changedCapture.plan) } }, eventId: 'adopt' });
  assert.equal(adoption.yield.kind, 'DECISION_REQUIRED');
  const alias = JSON.parse(await readFile(join(runDir, '.kernel', 'BEADS.INPUT.json'), 'utf8')); assert.equal(digest(alias.plan), digest(oldCapture.plan));
  const candidateNames = (await import('node:fs/promises')).readdir(join(runDir, '.kernel')).then((names) => names.filter((name) => name.startsWith('BEADS.INPUT.') && name.endsWith('.json') && name !== 'BEADS.INPUT.json')); assert.equal((await candidateNames).length, 2);
  changed.source.capture = async () => { throw new BeadsUnavailable('bd removed'); };
  const recovery = await transition({ runDir, runId: 's9-input', mode: 'runtime', beads: { mode: 'active', source: changed.source } }, { event: { kind: 'RESUME' }, eventId: 'recover', expectedRevision: adoption.yield.snapshot.revision });
  assert.equal(recovery.beads?.status, 'captured');
  assert.equal(recovery.beads?.targetPlanDigest, digest(oldCapture.plan));
});

test('RECOVERY and exact active replay use persisted input without invoking bd', async () => {
  const fixture = await beadsFixture(); const capture = await fixture.source.capture(); const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s9-replay-')); const ack = acknowledgement(capture);
  const startEvent = { kind: 'START', intentRef: { id: 'plan', digest: digest(capture.plan) } };
  const started = await transition({ runDir, runId: 's9-replay', mode: 'runtime', beads: { mode: 'active', source: fixture.source, acknowledgement: ack } }, { event: startEvent, eventId: 'start' });
  let calls = 0; fixture.source.capture = async () => { calls += 1; throw new BeadsUnavailable('bd removed'); };
  const duplicate = await transition({ runDir, runId: 's9-replay', mode: 'runtime', beads: { mode: 'active', source: fixture.source } }, { event: startEvent, eventId: 'start' });
  assert.equal(calls, 0); assert.equal(canonicalString(duplicate.yield), canonicalString(started.yield));
  const store = new FileArtifactStore(runDir); const loaded = await store.load(); const state = structuredClone(loaded.state); const command = Object.values(state.outbox)[0]; command.state = 'UNKNOWN'; await store.commit(loaded.generation, state);
  const proof = { commandDigest: command.commandDigest, launchToken: command.launchToken, status: 'NEVER_LAUNCHED' }; const recoveryEvent = { kind: 'OBSERVATION', category: 'RECOVERY', ref: { id: 'recovery', scope: 'test', digest: digest(proof), bytes: canonicalString(proof) } };
  const recovered = await transition({ runDir, runId: 's9-replay', mode: 'runtime', beads: { mode: 'active', source: fixture.source } }, { event: recoveryEvent, eventId: 'recovery', launchToken: command.launchToken, expectedRevision: state.revision });
  assert.equal(calls, 0); assert.notEqual(recovered.beads?.status, 'unavailable');
});

test('a later explicit drift supersedes an unconsumed B adoption token with C', async () => {
  const plan = { phaseId: 's9', steps: [{ stepId: 'a' }] }; const kernel = makeRunKernel({ plan, rootDir: await mkdtemp(join(tmpdir(), 'lunacy-s9-token-')) });
  const identity = (eventId, event, snapshot) => ({ runId: 's9-token', phaseId: 's9', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0, authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0, eventId, payloadDigest: digest(event) });
  const start = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }; let result = await kernel.advance({ runId: 's9-token', identity: identity('start', start), event: start });
  plan.steps.push({ stepId: 'b', dependencies: ['a'] }); const observation = (id) => ({ kind: 'OBSERVATION', category: 'USER_CHANGE', ref: { id, scope: 'test', digest: digest({ id }), bytes: canonicalString({ id }) } });
  let event = observation('b'); const b = await kernel.advance({ runId: 's9-token', identity: identity('b', event, result.snapshot), event, expectedRevision: result.snapshot.revision }); plan.steps.push({ stepId: 'c', dependencies: ['b'] }); event = observation('c'); const c = await kernel.advance({ runId: 's9-token', identity: identity('c', event, b.snapshot), event, expectedRevision: b.snapshot.revision });
  assert.equal(b.kind, 'DECISION_REQUIRED'); assert.equal(c.kind, 'DECISION_REQUIRED'); assert.notEqual(c.token, b.token);
});

test('manifest recovery accepts only the exact adoption predecessor digest', async () => {
  const fixture = await beadsFixture(); const captureA = syntheticCapture('a'); const captureB = syntheticCapture('b'); fixture.source.capture = async () => captureA;
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s9-manifest-')); const ackA = acknowledgement(captureA); const start = { kind: 'START', intentRef: { id: 'plan', digest: digest(captureA.plan) } };
  await transition({ runDir, runId: 's9-manifest', mode: 'runtime', beads: { mode: 'active', source: fixture.source, acknowledgement: ackA } }, { event: start, eventId: 'start' });
  const store = new FileArtifactStore(runDir); const loaded = await store.load(); const quiescent = structuredClone(loaded.state); for (const step of Object.values(quiescent.steps)) step.status = 'DONE'; quiescent.outbox = {}; quiescent.status = 'ACTIVE'; await store.commit(loaded.generation, quiescent);
  fixture.source.capture = async () => captureB; const drift = await transition({ runDir, runId: 's9-manifest', mode: 'runtime', beads: { mode: 'active', source: fixture.source } }, { event: { kind: 'OBSERVATION', category: 'USER_CHANGE', ref: { id: 'b', scope: 'test', digest: digest({ b: true }), bytes: canonicalString({ b: true }) } }, eventId: 'drift' });
  const adopted = await transition({ runDir, runId: 's9-manifest', mode: 'runtime', beads: { mode: 'active', source: fixture.source, acknowledgement: acknowledgement(captureB) } }, { event: { kind: 'PARENT_DECISION', token: drift.yield.token, value: { kind: 'ADOPT', digest: digest(captureB.plan) } }, eventId: 'adopt', expectedRevision: drift.yield.snapshot.revision }); assert.equal(adopted.yield.kind, 'WAITING');
  const manifestPath = join(runDir, '.kernel', 'BRIDGE.json'); const manifestB = JSON.parse(await readFile(manifestPath, 'utf8')); const manifestA = { ...manifestB, planDigest: digest(captureA.plan) }; await writeFile(manifestPath, canonicalString({ ...manifestB, planDigest: '3'.repeat(64) }));
  await assert.rejects(() => transition({ runDir, runId: 's9-manifest', mode: 'runtime', beads: { mode: 'active', source: fixture.source } }, { event: { kind: 'RESUME' }, eventId: 'bad-manifest' }), (error) => error instanceof BridgeError && error.code === 'ManifestMismatch');
  await writeFile(manifestPath, canonicalString(manifestA)); await transition({ runDir, runId: 's9-manifest', mode: 'runtime', beads: { mode: 'active', source: fixture.source } }, { event: { kind: 'RESUME' }, eventId: 'repair-manifest' });
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).planDigest, digest(captureB.plan));
});

test('managed launcher rejects a deployment with only runtimeVersion changed', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-s9-deploy-')); execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: process.cwd(), stdio: 'pipe' });
  const manifestPath = join(target, 'runtime', 'DEPLOYMENT.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.runtimeVersion = 'forged'; await writeFile(manifestPath, `${canonicalString(manifest)}\n`);
  const result = spawnSync(process.execPath, [join(target, 'runtime', 'bridge.mjs'), '--help'], { encoding: 'utf8' }); assert.notEqual(result.status, 0); assert.match(result.stderr, /malformed|runtime version/);
});
