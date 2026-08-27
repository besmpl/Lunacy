import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeadsPlanSource, BeadsUnavailable } from '../dist/beads.js';
import { BridgeError, transition } from '../dist/bridge.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';

async function beadsFixture(id = 'trusted', body = undefined) {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s12-'));
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.beads'), { recursive: true });
  const executablePath = join(root, 'bd');
  const exportLine = `{"_type":"issue","id":"${id}","title":"${id}","status":"open","priority":0,"issue_type":"task"}`;
  await writeFile(executablePath, body ?? `#!/bin/sh\nif [ "$1" = version ]; then printf '%s' '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}'; else printf '%s\\n' '${exportLine}'; fi\n`);
  await chmod(executablePath, 0o755);
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  return { root, workspace, executablePath, expectedBinaryDigest, source: new BeadsPlanSource({ executablePath, workspace, expectedBinaryDigest }) };
}

function acknowledgement(capture) {
  return { snapshotDigest: capture.snapshot.contentDigest, targetPlanDigest: digest(capture.plan), workspaceIdentity: capture.snapshot.workspaceIdentity, bdCommit: capture.snapshot.bdCommit, binaryDigest: capture.snapshot.binaryDigest };
}

function hashBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function normalizeLauncher(source) {
  let normalized = source;
  for (const [name, marker] of [['MANIFEST', '__LUNACY_MANIFEST_DIGEST__'], ['LAUNCHER', '__LUNACY_LAUNCHER_DIGEST__']]) {
    const pattern = new RegExp(`(^const EXPECTED_${name}_DIGEST = \")([0-9a-f]{64})(\";)$`, 'm');
    const next = normalized.replace(pattern, `$1${marker}$3`);
    assert.notEqual(next, normalized, `launcher ${name.toLowerCase()} digest literal is present`);
    normalized = next;
  }
  return Buffer.from(normalized);
}

test('verified executable survives pre-open replacement and in-place mutation attempts', async () => {
  const fixture = await beadsFixture('trusted', `#!/bin/sh
if [ "$1" = version ]; then
  for candidate in /tmp/lunacy-bd-capture-*/bd /var/folders/*/*/*/lunacy-bd-capture-*/bd; do
    if [ -f "$candidate" ]; then chmod 700 "$candidate" 2>/dev/null || true; printf '%s' '#!/bin/sh' > "$candidate.new" 2>/dev/null || true; mv "$candidate.new" "$candidate" 2>/dev/null || true; break; fi
  done
  printf '%s' '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}'; exit 0
fi
printf '%s\\n' '{"_type":"issue","id":"trusted","title":"trusted","status":"open","priority":0,"issue_type":"task"}'
`);
  const capture = await fixture.source.capture();
  assert.equal(capture.snapshot.issues[0].sourceId, 'trusted');
});

test('workspace swap-and-restore during a bd probe cannot change captured identity', async () => {
  const fixture = await beadsFixture('original', `#!/bin/sh
if [ "$1" = version ]; then
  (sleep 0.02; mv "$BEADS_DIR" "$BEADS_DIR.swap" 2>/dev/null && mkdir "$BEADS_DIR" && sleep 0.02 && rmdir "$BEADS_DIR" 2>/dev/null && mv "$BEADS_DIR.swap" "$BEADS_DIR" 2>/dev/null) &
  printf '%s' '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}'; sleep 0.08; exit 0
fi
printf '%s\\n' '{"_type":"issue","id":"original","title":"original","status":"open","priority":0,"issue_type":"task"}'
`);
  const capture = await fixture.source.capture();
  assert.equal(capture.snapshot.issues[0].sourceId, 'original');
});

test('epoch-changing active replay reuses the durable yield and ignores a retry plan', async () => {
  const fixture = await beadsFixture();
  const capture = await fixture.source.capture();
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s12-replay-'));
  const start = { kind: 'START', intentRef: { id: 'plan', digest: digest(capture.plan) } };
  const first = await transition({ runDir, runId: 's12-replay', mode: 'runtime', beads: { mode: 'active', source: fixture.source, acknowledgement: acknowledgement(capture) } }, { event: start, eventId: 'start' });
  const store = new FileArtifactStore(runDir);
  const loaded = await store.load();
  const changed = structuredClone(loaded.state);
  changed.attemptEpoch += 1;
  changed.barrierEpoch += 1;
  await store.commit(loaded.generation, changed);
  fixture.source.capture = async () => { throw new BeadsUnavailable('bd removed'); };
  const retryPlan = { phaseId: capture.plan.phaseId, steps: [{ stepId: 'caller-plan', goal: 'ignored on replay' }] };
  const replay = await transition({ runDir, runId: 's12-replay', mode: 'runtime', plan: retryPlan, beads: { mode: 'active', source: fixture.source } }, { event: start, eventId: 'start' });
  assert.equal(canonicalString(replay.yield), canonicalString(first.yield));
});

test('first active capture rejects a nonmatching native plan before mutation', async () => {
  const fixture = await beadsFixture();
  const capture = await fixture.source.capture();
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-s12-native-'));
  const native = { phaseId: capture.plan.phaseId, steps: [{ stepId: 'different', goal: 'not Beads' }] };
  await assert.rejects(() => transition({ runDir, runId: 's12-native', mode: 'runtime', plan: native, beads: { mode: 'active', source: fixture.source, acknowledgement: acknowledgement(capture) } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(capture.plan) } }, eventId: 'start' }), (error) => error instanceof BridgeError && error.code === 'Unavailable');
  await assert.rejects(() => readFile(join(runDir, '.kernel', 'CURRENT')));
});

test('forged prior deployment manifest cannot delete a runtime sentinel', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-s12-deploy-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: process.cwd(), stdio: 'pipe' });
  const sentinel = join(target, 'runtime', 'sentinel');
  await writeFile(sentinel, 'keep me');
  const manifestPath = join(target, 'runtime', 'DEPLOYMENT.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files.push('runtime/sentinel');
  await writeFile(manifestPath, `${canonicalString(manifest)}\n`);
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: process.cwd(), stdio: 'pipe' });
  assert.equal(await readFile(sentinel, 'utf8'), 'keep me');
});

test('managed loader keeps entry and transitive modules in the verified byte graph', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-s12-loader-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: process.cwd(), stdio: 'pipe' });
  const wrapper = await readFile(join(target, 'runtime', 'bridge.mjs'), 'utf8');
  assert.match(wrapper, /registerVerifiedGraph/);
  assert.doesNotMatch(wrapper, /freshPrivateRoot|writeVerified|pathToFileURL/);
});

test('verified loader bytes survive deterministic entry and transitive mutation after verification', async () => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-s12-loader-race-'));
  execFileSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: process.cwd(), stdio: 'pipe' });
  const wrapperPath = join(target, 'runtime', 'bridge.mjs');
  const ready = join(target, 'verified.ready');
  const release = join(target, 'verified.release');
  const originalWrapper = await readFile(wrapperPath, 'utf8');
  const verifyCall = 'verifyDeployment().then(({ bytesByPath }) => registerVerifiedGraph(bytesByPath))';
  assert.ok(originalWrapper.includes(verifyCall));
  let pausedWrapper = originalWrapper.replace(verifyCall, `verifyDeployment().then(async ({ bytesByPath }) => { await fs.writeFile(${JSON.stringify(ready)}, 'ready'); while (true) { try { await fs.access(${JSON.stringify(release)}); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); } } return registerVerifiedGraph(bytesByPath); })`);
  const launcherDigest = hashBytes(normalizeLauncher(pausedWrapper));
  const manifestPath = join(target, 'runtime', 'DEPLOYMENT.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.launcherDigest = launcherDigest;
  const manifestBytes = Buffer.from(`${canonicalString(manifest)}\n`);
  const manifestDigest = hashBytes(manifestBytes);
  pausedWrapper = pausedWrapper.replace(/(^const EXPECTED_MANIFEST_DIGEST = ")([0-9a-f]{64})(";)$/m, `$1${manifestDigest}$3`);
  pausedWrapper = pausedWrapper.replace(/(^const EXPECTED_LAUNCHER_DIGEST = ")([0-9a-f]{64})(";)$/m, `$1${launcherDigest}$3`);
  await writeFile(manifestPath, manifestBytes);
  await writeFile(wrapperPath, pausedWrapper);
  const child = spawn(process.execPath, [wrapperPath, '--help'], { cwd: target, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // Register the close observer before releasing the paused loader. The
  // verified child can complete synchronously after release; observing close
  // first keeps the test deterministic instead of losing an early event.
  const statusPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  // Full-suite workers can contend heavily while several deployment probes
  // start at once. Keep the synchronization deterministic, but give the child
  // a bounded ten-second launch window rather than a flaky one-second window.
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    try { await access(ready); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
    if (attempt === 1999) { child.kill('SIGKILL'); throw new Error(`launcher verification pause was not reached: ${stderr}`); }
  }
  await writeFile(join(target, 'runtime', 'dist', 'bridge-cli.js'), 'throw new Error("entry mutation executed");\n');
  await writeFile(join(target, 'runtime', 'dist', 'canonical.js'), 'throw new Error("transitive mutation executed");\n');
  await writeFile(release, 'release');
  const status = await statusPromise;
  assert.equal(status, 0, `${stderr}\n${stdout}`);
  assert.match(stdout, /Usage: lunacy-bridge/);
});
