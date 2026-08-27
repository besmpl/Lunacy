import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BeadsPlanSource, BeadsUnavailable, validateBeadsAcknowledgement } from '../dist/beads.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { BridgeError, transition } from '../dist/bridge.js';

async function fixture(exportLines) {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-beads-test-'));
  const workspace = join(root, 'workspace'); const home = join(root, 'home'); const config = join(root, 'config');
  await mkdir(join(workspace, '.beads'), { recursive: true }); await mkdir(home, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
  const executablePath = join(root, 'bd');
  const body = exportLines.map((line) => `printf '%s' '${Buffer.from(line).toString('base64')}' | /usr/bin/base64 -d; printf '\\n'`).join('\n');
  await writeFile(executablePath, `#!/bin/sh\nif [ "$1" = version ]; then printf '%s' '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}'; exit 0; fi\n${body}\n`, 'utf8');
  await chmod(executablePath, 0o755);
  const bytes = await readFile(executablePath);
  // The adapter hashes executable bytes, not a string representation.
  const { createHash } = await import('node:crypto');
  const expectedBinaryDigest = createHash('sha256').update(bytes).digest('hex');
  return { root, workspace, home, config, executablePath, expectedBinaryDigest, source: new BeadsPlanSource({ executablePath, workspace, homeDir: home, xdgConfigHome: config, expectedBinaryDigest }) };
}

test('Beads source captures one bounded canonical plan and omits closed prerequisites', async () => {
  const fixtureData = await fixture([
    '{"_type":"issue","id":"closed","title":"Done","status":"closed","priority":0,"issue_type":"task"}',
    '{"_type":"issue","id":"open","title":"Do work","description":"opaque\\ntext","status":"open","priority":2,"issue_type":"task","dependencies":[{"issue_id":"open","depends_on_id":"closed","type":"blocks","metadata":"{}"}]}',
  ]);
  const captured = await fixtureData.source.capture();
  assert.equal(captured.snapshot.schema, 'lunacy-beads-snapshot-v1');
  assert.equal(captured.snapshot.issues.length, 2); assert.deepEqual(captured.snapshot.edges, [{ from: 'open', to: 'closed', type: 'blocks' }]);
  assert.deepEqual(captured.plan.steps, [{ schema: undefined, stepId: 'open', goal: 'Do work\n\nopaque\ntext', dependencies: [], claims: [] }].map(({ schema, ...step }) => step));
  const { capturedAt: _capturedAt, contentDigest: _contentDigest, ...snapshotContent } = captured.snapshot;
  assert.equal(captured.snapshot.contentDigest, digest(snapshotContent));
});

test('Beads parser rejects duplicate/unknown fields and unsupported statuses', async () => {
  const duplicate = await fixture(['{"_type":"issue","id":"x","id":"y","title":"X","status":"open","priority":0,"issue_type":"task"}']);
  await assert.rejects(() => duplicate.source.capture(), BeadsUnavailable);
  const unknown = await fixture(['{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task","gate":"x"}']);
  await assert.rejects(() => unknown.source.capture(), BeadsUnavailable);
  const status = await fixture(['{"_type":"issue","id":"x","title":"X","status":"blocked","priority":0,"issue_type":"task"}']);
  await assert.rejects(() => status.source.capture(), BeadsUnavailable);
});

test('shadow mode never mutates a runtime root; active mode requires exact acknowledgement', async () => {
  const fixtureData = await fixture(['{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}']);
  const native = { phaseId: 'beads', steps: [{ stepId: 'x', goal: 'X' }] };
  const root = await mkdtemp(join(tmpdir(), 'lunacy-beads-bridge-'));
  const shadow = await transition({ runDir: root, runId: 'r', mode: 'runtime', plan: native, beads: { mode: 'shadow', source: fixtureData.source } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(native) } }, eventId: 'shadow' });
  assert.equal(shadow.projected, false); assert.equal(shadow.beads?.status, 'shadow-match');
  await assert.rejects(() => readFile(join(root, '.kernel', 'CURRENT')), { code: 'ENOENT' });
  const captured = await fixtureData.source.capture();
  const acknowledgement = { snapshotDigest: captured.snapshot.contentDigest, targetPlanDigest: digest(captured.plan), workspaceIdentity: captured.snapshot.workspaceIdentity, bdCommit: captured.snapshot.bdCommit, binaryDigest: captured.snapshot.binaryDigest };
  const active = await transition({ runDir: root, runId: 'r', mode: 'runtime', beads: { mode: 'active', source: fixtureData.source, acknowledgement } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(captured.plan) } }, eventId: 'active' });
  assert.equal(active.projected, true); assert.equal(active.beads?.status, 'captured');
  assert.doesNotThrow(() => validateBeadsAcknowledgement(acknowledgement, captured));
});

test('active fresh START rejects missing or wrong acknowledgement before any durable mutation', async () => {
  const fixtureData = await fixture(['{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}']);
  const captured = await fixtureData.source.capture();
  const good = { snapshotDigest: captured.snapshot.contentDigest, targetPlanDigest: digest(captured.plan), workspaceIdentity: captured.snapshot.workspaceIdentity, bdCommit: captured.snapshot.bdCommit, binaryDigest: captured.snapshot.binaryDigest };
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(captured.plan) } };
  const untouched = async (root) => {
    for (const path of ['.kernel/BRIDGE.json', '.kernel/CURRENT', 'STATE.md', 'phases/beads/STEPS.md']) await assert.rejects(() => readFile(join(root, path)));
  };

  const missingRoot = await mkdtemp(join(tmpdir(), 'lunacy-beads-missing-ack-'));
  await assert.rejects(() => transition({ runDir: missingRoot, runId: 'missing', mode: 'runtime', beads: { mode: 'active', source: fixtureData.source } }, { event, eventId: 'missing' }), (error) => error instanceof BridgeError && error.code === 'Unavailable');
  await untouched(missingRoot);

  const wrongRoot = await mkdtemp(join(tmpdir(), 'lunacy-beads-wrong-ack-'));
  const wrong = { ...good, targetPlanDigest: '0'.repeat(64) };
  await assert.rejects(() => transition({ runDir: wrongRoot, runId: 'wrong', mode: 'runtime', beads: { mode: 'active', source: fixtureData.source, acknowledgement: wrong } }, { event, eventId: 'wrong' }), (error) => error instanceof BridgeError && error.code === 'Unavailable');
  await untouched(wrongRoot);
});

test('active Beads adoption requires acknowledgement and leaves CURRENT/projection unchanged on missing or wrong ack', async () => {
  const initial = await fixture(['{"_type":"issue","id":"old","title":"Old","status":"open","priority":0,"issue_type":"task"}']);
  const initialCapture = await initial.source.capture();
  const initialAck = { snapshotDigest: initialCapture.snapshot.contentDigest, targetPlanDigest: digest(initialCapture.plan), workspaceIdentity: initialCapture.snapshot.workspaceIdentity, bdCommit: initialCapture.snapshot.bdCommit, binaryDigest: initialCapture.snapshot.binaryDigest };
  const root = await mkdtemp(join(tmpdir(), 'lunacy-beads-adoption-ack-'));
  await transition({ runDir: root, runId: 'adopt', mode: 'runtime', beads: { mode: 'active', source: initial.source, acknowledgement: initialAck } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(initialCapture.plan) } }, eventId: 'start' });

  const changed = await fixture(['{"_type":"issue","id":"new","title":"New","status":"open","priority":0,"issue_type":"task"}']);
  // Source observation is explicit; ordinary RESUME/recovery must use the
  // acknowledged private input artifact without requiring bd availability.
  const drift = await transition({ runDir: root, runId: 'adopt', mode: 'runtime', beads: { mode: 'active', source: changed.source } }, { event: { kind: 'OBSERVATION', category: 'USER_CHANGE', ref: { id: 'changed', scope: 'test', digest: digest({ changed: true }), bytes: '{"changed":true}' } }, eventId: 'drift' });
  assert.equal(drift.yield?.kind, 'DECISION_REQUIRED');
  const token = drift.yield?.token;
  assert.equal(typeof token, 'string');
  const changedCapture = await changed.source.capture();
  const changedAck = { snapshotDigest: changedCapture.snapshot.contentDigest, targetPlanDigest: digest(changedCapture.plan), workspaceIdentity: changedCapture.snapshot.workspaceIdentity, bdCommit: changedCapture.snapshot.bdCommit, binaryDigest: changedCapture.snapshot.binaryDigest };
  const value = { kind: 'ADOPT', digest: digest(changedCapture.plan) };
  const before = await Promise.all(['.kernel/BRIDGE.json', '.kernel/CURRENT', 'STATE.md', 'phases/beads/STEPS.md'].map((path) => readFile(join(root, path))));
  const adoption = (acknowledgement, eventId) => transition({ runDir: root, runId: 'adopt', mode: 'runtime', beads: { mode: 'active', source: changed.source, ...(acknowledgement === undefined ? {} : { acknowledgement }) } }, { event: { kind: 'PARENT_DECISION', token, value }, eventId });

  await assert.rejects(() => adoption(undefined, 'adopt-missing'), (error) => error instanceof BridgeError && error.code === 'Unavailable');
  assert.deepEqual(await Promise.all(['.kernel/BRIDGE.json', '.kernel/CURRENT', 'STATE.md', 'phases/beads/STEPS.md'].map((path) => readFile(join(root, path)))), before);

  await assert.rejects(() => adoption({ ...changedAck, snapshotDigest: '0'.repeat(64) }, 'adopt-wrong'), (error) => error instanceof BridgeError && error.code === 'Unavailable');
  assert.deepEqual(await Promise.all(['.kernel/BRIDGE.json', '.kernel/CURRENT', 'STATE.md', 'phases/beads/STEPS.md'].map((path) => readFile(join(root, path)))), before);
});

test('Beads mode snapshot closes the shadow and active acknowledgement race', async () => {
  const fixtureData = await fixture(['{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}']);
  const captured = await fixtureData.source.capture();
  const ack = { snapshotDigest: captured.snapshot.contentDigest, targetPlanDigest: digest(captured.plan), workspaceIdentity: captured.snapshot.workspaceIdentity, bdCommit: captured.snapshot.bdCommit, binaryDigest: captured.snapshot.binaryDigest };
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const originalCapture = fixtureData.source.capture.bind(fixtureData.source);
  fixtureData.source.capture = async (...args) => { await barrier; return originalCapture(...args); };
  const native = { phaseId: 'beads', steps: [{ stepId: 'x', goal: 'X' }] };
  const shadowOptions = { mode: 'shadow', source: fixtureData.source };
  const shadowRoot = await mkdtemp(join(tmpdir(), 'lunacy-beads-shadow-race-'));
  const shadowPromise = transition({ runDir: shadowRoot, runId: 'shadow-race', mode: 'runtime', plan: native, beads: shadowOptions }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(native) } }, eventId: 'shadow' });
  shadowOptions.mode = 'off';
  native.steps[0].goal = 'mutated while capture was suspended';
  release();
  const shadow = await shadowPromise;
  assert.equal(shadow.projected, false);
  assert.equal(shadow.beads?.status, 'shadow-match');

  let releaseActive;
  const activeBarrier = new Promise((resolve) => { releaseActive = resolve; });
  fixtureData.source.capture = async (...args) => { await activeBarrier; return originalCapture(...args); };
  const activeOptions = { mode: 'active', source: fixtureData.source };
  const activeRoot = await mkdtemp(join(tmpdir(), 'lunacy-beads-active-race-'));
  const activePromise = transition({ runDir: activeRoot, runId: 'active-race', mode: 'runtime', beads: activeOptions }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(captured.plan) } }, eventId: 'active' });
  activeOptions.mode = 'off';
  releaseActive();
  await assert.rejects(() => activePromise, (error) => error instanceof BridgeError && error.code === 'Unavailable');
  await assert.rejects(() => readFile(join(activeRoot, '.kernel', 'CURRENT')));
});

test('ordinary active recovery uses acknowledged input without bd and explicit observation recaptures', async () => {
  const fixtureData = await fixture(['{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}']);
  const captured = await fixtureData.source.capture();
  const acknowledgement = { snapshotDigest: captured.snapshot.contentDigest, targetPlanDigest: digest(captured.plan), workspaceIdentity: captured.snapshot.workspaceIdentity, bdCommit: captured.snapshot.bdCommit, binaryDigest: captured.snapshot.binaryDigest };
  const root = await mkdtemp(join(tmpdir(), 'lunacy-beads-recovery-'));
  await transition({ runDir: root, runId: 'recovery', mode: 'runtime', beads: { mode: 'active', source: fixtureData.source, acknowledgement } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(captured.plan) } }, eventId: 'start' });
  let calls = 0;
  fixtureData.source.capture = async () => { calls += 1; throw new BeadsUnavailable('bd removed'); };
  const recovery = await transition({ runDir: root, runId: 'recovery', mode: 'runtime', beads: { mode: 'active', source: fixtureData.source } }, { event: { kind: 'RESUME' }, eventId: 'resume' });
  assert.equal(calls, 0);
  assert.equal(recovery.projected, true);
  assert.ok(['WAITING', 'BLOCKED', 'DECISION_REQUIRED', 'FINAL'].includes(recovery.yield?.kind));
  const observation = await transition({ runDir: root, runId: 'recovery', mode: 'runtime', beads: { mode: 'active', source: fixtureData.source } }, { event: { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'host', scope: 'test', digest: digest({ unavailable: true }), bytes: canonicalString({ unavailable: true }) } }, eventId: 'observation' });
  assert.equal(calls, 1);
  assert.equal(observation.projected, false);
  assert.equal(observation.beads?.status, 'unavailable');
});

test('pinned build and locale-independent identity are enforced', async () => {
  const fixtureData = await fixture(['{"_type":"issue","id":"é","title":"E","status":"open","priority":0,"issue_type":"task"}']);
  const originalCapture = fixtureData.source.capture.bind(fixtureData.source);
  const versionPath = fixtureData.executablePath;
  const prior = await readFile(versionPath, 'utf8');
  await writeFile(versionPath, prior.replace('"build":"6c124203e"', '"build":"wrong"'));
  await assert.rejects(() => fixtureData.source.capture(), BeadsUnavailable);
  await writeFile(versionPath, prior);
  const first = await originalCapture();
  const second = await originalCapture();
  assert.equal(first.snapshot.contentDigest, second.snapshot.contentDigest);
  assert.equal(first.snapshot.bdBuild, '6c124203e');
});

test('Beads snapshot and Plan identity remain stable across process locales', async () => {
  const localeFixture = await fixture([
    '{"_type":"issue","id":"é","title":"E","status":"open","priority":0,"issue_type":"task"}',
    '{"_type":"issue","id":"İ","title":"I","status":"open","priority":1,"issue_type":"task"}',
  ]);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'dist', 'beads.js')).href;
  const script = `import { BeadsPlanSource } from ${JSON.stringify(moduleUrl)}; const [executablePath, workspace, homeDir, xdgConfigHome, expectedBinaryDigest] = process.argv.slice(1); const source = new BeadsPlanSource({ executablePath, workspace, homeDir, xdgConfigHome, expectedBinaryDigest }); console.log((await source.capture()).snapshot.contentDigest);`;
  const args = [localeFixture.executablePath, localeFixture.workspace, localeFixture.home, localeFixture.config, localeFixture.expectedBinaryDigest];
  const run = (locale) => spawnSync(process.execPath, ['--input-type=module', '-e', script, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, LC_ALL: locale, LANG: locale } });
  const first = run('C'); const second = run('tr_TR.UTF-8');
  assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout.trim(), second.stdout.trim());
});

test('verified private bd copy survives swap-and-restore of the original executable', async () => {
  const fixtureData = await fixture(['{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}']);
  const original = await readFile(fixtureData.executablePath);
  const maliciousPath = join(fixtureData.root, 'malicious-bd');
  await writeFile(maliciousPath, '#!/bin/sh\nprintf \'malicious\'\n', 'utf8'); await chmod(maliciousPath, 0o755);
  const exportLine = '{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}';
  await writeFile(fixtureData.executablePath, `#!/bin/sh\nif [ "$1" = version ]; then printf '%s' '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}'; cp '${maliciousPath}' '${fixtureData.executablePath}'; exit 0; fi\nprintf '%s\\n' '${exportLine}'\n`, 'utf8');
  await chmod(fixtureData.executablePath, 0o755);
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(await readFile(fixtureData.executablePath)).digest('hex');
  const source = new BeadsPlanSource({ executablePath: fixtureData.executablePath, workspace: fixtureData.workspace, homeDir: fixtureData.home, xdgConfigHome: fixtureData.config, expectedBinaryDigest: expected });
  const captured = await source.capture();
  assert.equal(captured.snapshot.binaryDigest, expected);
  assert.notDeepEqual(await readFile(fixtureData.executablePath), original);
});

test('workspace and Beads directory inode replacement during capture fails identity fencing', async () => {
  const fixtureData = await fixture(['{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}']);
  const exportLine = '{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}';
  const executablePath = join(fixtureData.root, 'swap-workspace-bd');
  await writeFile(executablePath, `#!/bin/sh\nif [ "$1" = version ]; then mv "$BEADS_DIR" "$BEADS_DIR.swap"; mkdir "$BEADS_DIR"; printf '%s' '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}'; exit 0; fi\nprintf '%s\\n' '${exportLine}'\n`, 'utf8');
  await chmod(executablePath, 0o755);
  const { createHash } = await import('node:crypto');
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  const source = new BeadsPlanSource({ executablePath, workspace: fixtureData.workspace, homeDir: fixtureData.home, xdgConfigHome: fixtureData.config, expectedBinaryDigest });
  await assert.rejects(() => source.capture(), BeadsUnavailable);
});

test('HOME/XDG overlap with the Beads workspace is rejected before capture', async () => {
  const fixtureData = await fixture(['{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}']);
  const overlap = join(fixtureData.workspace, '.beads', 'isolated');
  const overlapConfig = join(fixtureData.workspace, '.beads', 'config');
  await mkdir(overlap); await mkdir(overlapConfig);
  const source = new BeadsPlanSource({ executablePath: fixtureData.executablePath, workspace: fixtureData.workspace, homeDir: overlap, xdgConfigHome: overlapConfig, expectedBinaryDigest: fixtureData.expectedBinaryDigest });
  await assert.rejects(() => source.capture(), BeadsUnavailable);
  assert.equal((await stat(overlap)).isDirectory(), true);
});

test('custom HOME/XDG overlap with a protected runtime root is rejected', async () => {
  const fixtureData = await fixture(['{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}']);
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'lunacy-beads-runtime-root-'));
  const home = join(runtimeRoot, 'home'); const config = join(runtimeRoot, 'config');
  await mkdir(home, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
  const source = new BeadsPlanSource({ executablePath: fixtureData.executablePath, workspace: fixtureData.workspace, homeDir: home, xdgConfigHome: config, expectedBinaryDigest: fixtureData.expectedBinaryDigest });
  await assert.rejects(() => source.capture(undefined, [runtimeRoot, join(runtimeRoot, '.kernel')]), BeadsUnavailable);
});

test('Beads executable and workspace parent symlinks fail closed', async () => {
  const fixtureData = await fixture(['{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}']);
  const outside = await mkdtemp(join(tmpdir(), 'lunacy-beads-outside-'));
  const declared = await mkdtemp(join(tmpdir(), 'lunacy-beads-declared-'));
  const outsideWorkspace = join(outside, 'workspace');
  await mkdir(join(outsideWorkspace, '.beads'), { recursive: true });
  const alias = join(declared, 'alias');
  await symlink(outside, alias);
  const aliasedWorkspace = join(alias, 'workspace');
  const source = new BeadsPlanSource({ executablePath: join(alias, 'bd'), workspace: aliasedWorkspace, expectedBinaryDigest: fixtureData.expectedBinaryDigest });
  await assert.rejects(() => source.capture(), BeadsUnavailable);
  const executableAlias = join(alias, 'bd');
  await symlink(fixtureData.executablePath, executableAlias);
  const safeSource = new BeadsPlanSource({ executablePath: executableAlias, workspace: fixtureData.workspace, expectedBinaryDigest: fixtureData.expectedBinaryDigest });
  await assert.rejects(() => safeSource.capture(), BeadsUnavailable);
});
