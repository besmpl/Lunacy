import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunKernel } from '../dist/index.js';
import { digest } from '../dist/canonical.js';
const plan = { phaseId: 's24', steps: [{ stepId: 'step' }] };
function input(runId, eventId, event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, revision) { return { runId, ...(revision === undefined ? {} : { expectedRevision: revision }), identity: { runId, phaseId: 's24', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId, payloadDigest: digest(event) }, event }; }
test('S24 generation-state trust failure leaves inert legacy decoration unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s24-generation-fence-')); let statePath; const decorationPath = join(root, '.kernel', 'reuse', 'legacy.json');
  try {
    const first = await makeRunKernel({ plan, rootDir: root }).advance(input('s24-run', 'start'));
    const current = JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8')); statePath = join(root, '.kernel', 'generations', `g${current.generation}`, 'state.json');
    await mkdir(join(root, '.kernel', 'reuse'), { recursive: true }); await writeFile(decorationPath, 'legacy bytes'); await chmod(statePath, 0o666);
    await assert.rejects(() => makeRunKernel({ plan, rootDir: root }).advance(input('s24-run', 'resume', { kind: 'RESUME' }, first.snapshot.revision)), /ManifestMismatch/);
    assert.equal(await readFile(decorationPath, 'utf8'), 'legacy bytes'); assert.equal((await stat(decorationPath)).isFile(), true);
  } finally { if (statePath) await chmod(statePath, 0o600).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
