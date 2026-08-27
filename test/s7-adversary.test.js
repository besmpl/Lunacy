import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeadsPlanSource, BeadsUnavailable } from '../dist/beads.js';
import { BridgeError, disable, transition } from '../dist/bridge.js';
import { canonicalString, digest } from '../dist/canonical.js';

const root = process.cwd();

async function beadsFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'lunacy-s7-adversary-'));
  const workspace = join(fixtureRoot, 'workspace');
  const home = join(fixtureRoot, 'home');
  const config = join(fixtureRoot, 'config');
  await mkdir(join(workspace, '.beads'), { recursive: true });
  await mkdir(home, { mode: 0o700 });
  await mkdir(config, { mode: 0o700 });
  const executablePath = join(fixtureRoot, 'bd');
  const line = '{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}';
  await writeFile(executablePath, `#!/bin/sh\nif [ "$1" = version ]; then printf '%s' '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}'; exit 0; fi\nprintf '%s\\n' '${line}'\n`, 'utf8');
  await chmod(executablePath, 0o755);
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  const source = new BeadsPlanSource({ executablePath, workspace, homeDir: home, xdgConfigHome: config, expectedBinaryDigest });
  return { fixtureRoot, workspace, home, config, executablePath, expectedBinaryDigest, source };
}

test('active recovery cannot replace a missing acknowledged input with a caller Plan', async () => {
  const fixture = await beadsFixture();
  const captured = await fixture.source.capture();
  const acknowledgement = {
    snapshotDigest: captured.snapshot.contentDigest,
    targetPlanDigest: digest(captured.plan),
    workspaceIdentity: captured.snapshot.workspaceIdentity,
    bdCommit: captured.snapshot.bdCommit,
    binaryDigest: captured.snapshot.binaryDigest,
  };
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s7-active-recovery-'));
  const options = { runDir, runId: 's7-recovery', mode: 'runtime', beads: { mode: 'active', source: fixture.source, acknowledgement } };
  await transition(options, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(captured.plan) } }, eventId: 'start' });
  const currentBefore = await readFile(join(runDir, '.kernel', 'CURRENT'));
  await rm(join(runDir, '.kernel', 'BEADS.INPUT.json'));
  let captureCalls = 0;
  fixture.source.capture = async () => { captureCalls += 1; throw new BeadsUnavailable('bd removed'); };
  await assert.rejects(
    () => transition({ ...options, plan: { phaseId: 'beads', steps: [{ stepId: 'x', goal: 'attacker replacement' }] } }, { event: { kind: 'RESUME' }, eventId: 'resume' }),
    (error) => error instanceof BridgeError && error.code === 'Unavailable',
  );
  assert.equal(captureCalls, 0);
  assert.deepEqual(await readFile(join(runDir, '.kernel', 'CURRENT')), currentBefore);
});

test('Beads workspace and database cannot overlap a protected runtime root', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'lunacy-s7-workspace-overlap-'));
  const workspace = join(fixtureRoot, 'workspace');
  await mkdir(join(workspace, '.beads'), { recursive: true });
  const executablePath = join(fixtureRoot, 'bd');
  await writeFile(executablePath, '#!/bin/sh\nprintf \'%s\\n\' \'{}\'\n', 'utf8');
  await chmod(executablePath, 0o755);
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  const source = new BeadsPlanSource({ executablePath, workspace, expectedBinaryDigest });
  await assert.rejects(() => source.capture(undefined, [workspace, join(workspace, '.kernel')]), BeadsUnavailable);
});

test('deployment rejects a target beneath a symlinked ancestor before outside writes', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'lunacy-s7-deploy-outside-'));
  const declared = await mkdtemp(join(tmpdir(), 'lunacy-s7-deploy-declared-'));
  await symlink(outside, join(declared, 'alias'));
  const target = join(declared, 'alias', 'skill');
  assert.throws(() => execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: root, stdio: 'pipe' }));
  assert.deepEqual(await readdir(outside), []);
});

test('a durable delete tombstone prevents disable rollback when the old manifest remains', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s7-tombstone-'));
  const plan = { phaseId: 's7', steps: [{ stepId: 'a', goal: 'A' }] };
  await transition({ runDir, runId: 's7-tombstone', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const manifestPath = join(runDir, '.kernel', 'BRIDGE.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(join(runDir, '.kernel', 'BRIDGE.DELETED'), `${canonicalString({ ...manifest, status: 'deleted' })}\n`, 'utf8');
  await assert.rejects(() => disable({ runDir, runId: 's7-tombstone', mode: 'runtime' }), (error) => error instanceof BridgeError && error.code === 'ManifestMismatch');
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).status, 'enabled');
});
