import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileArtifactStore } from '../dist/store.js';
import { makeRunKernel } from '../dist/index.js';
import { digest } from '../dist/canonical.js';
const repo = fileURLToPath(new URL('..', import.meta.url)); const deployTool = fileURLToPath(new URL('../tools/deploy-skill.mjs', import.meta.url));
const obsolete = ['compiler.js','compiler.js.map','compiler.d.ts','compiler.d.ts.map','reuse.js','reuse.js.map','reuse.d.ts','reuse.d.ts.map']; const absent = (path) => access(path).then(() => false, () => true);
test('L1 inactive context and reuse authoring', async () => { const present = []; for (const path of ['src/compiler.ts', 'src/reuse.ts']) if (!(await absent(join(repo, path)))) present.push(path); assert.deepEqual(present, []); });
test('L1 deployment inventory', async (t) => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-l1-deploy-')); t.after(() => rm(target, { recursive: true, force: true }));
  const deployed = spawnSync(process.execPath, [deployTool, '--target', target], { cwd: repo, encoding: 'utf8' }); assert.equal(deployed.status, 0, deployed.stderr);
  const manifest = JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8'));
  for (const name of obsolete) { assert.equal(await absent(join(repo, 'dist', name)), true, `clean dist retained ${name}`); assert.equal(await absent(join(target, 'runtime', 'dist', name)), true, `deployment retained ${name}`); assert.equal(manifest.files.includes(`runtime/dist/${name}`), false, `manifest retained ${name}`); }
});
test('L1 rollback reader smoke', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-l1-reader-')); t.after(() => rm(root, { recursive: true, force: true })); const plan = { phaseId: 'l1-reader', steps: [{ stepId: 'a' }] }; const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
  await makeRunKernel({ plan, rootDir: root }).advance({ runId: 'l1-reader', identity: { runId: 'l1-reader', phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: 'start', payloadDigest: digest(event) }, event });
  const decoration = join(root, '.kernel', 'reuse', 'legacy.json'); await mkdir(join(root, '.kernel', 'reuse'), { recursive: true }); await writeFile(decoration, 'cold legacy bytes'); const loaded = await new FileArtifactStore(root).load(); assert.equal(loaded.state.runId, 'l1-reader'); assert.equal(await readFile(decoration, 'utf8'), 'cold legacy bytes');
});
