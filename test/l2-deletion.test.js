import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalString, digest } from '../dist/canonical.js';
import { makeRunKernel } from '../dist/index.js';
import { AccelerationMetrics } from '../dist/metrics.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const deployTool = fileURLToPath(new URL('../tools/deploy-skill.mjs', import.meta.url));
const obsolete = ['graph.js', 'graph.js.map', 'graph.d.ts', 'graph.d.ts.map'];
const absent = (path) => access(path).then(() => false, () => true);
const plan = { phaseId: 'l2-parity', steps: [{ stepId: 'a' }] };

function input(eventId, event, previous) {
  return {
    runId: 'l2-parity-run',
    ...(previous ? { expectedRevision: previous.snapshot.revision } : {}),
    identity: {
      runId: 'l2-parity-run', phaseId: 'run', stepId: 'run', attemptEpoch: 0,
      authorityEpoch: 0, barrierEpoch: 0, eventId, payloadDigest: digest(event),
    },
    event,
  };
}

async function trace(acceleration) {
  const kernel = makeRunKernel({ plan, maxInFlight: 0, acceleration });
  const start = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
  const observation = { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'host', digest: digest({ ok: true }), bytes: canonicalString({ ok: true }) } };
  const first = await kernel.advance(input('start', start));
  const second = await kernel.advance(input('host', observation, first));
  return [canonicalString(first), canonicalString(second)];
}

test('L2 graph acceleration parity', async () => {
  const metrics = new AccelerationMetrics();
  const baseline = await trace(undefined);
  const decorated = await trace({ graph: 'ON', metrics });
  assert.deepEqual(decorated, baseline);
  assert.deepEqual(Object.keys(metrics.snapshot()).filter((name) => name.startsWith('graph')), []);
});

test('L2 deployment inventory', async (t) => {
  const target = await mkdtemp(join(tmpdir(), 'lunacy-l2-deploy-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const deployed = spawnSync(process.execPath, [deployTool, '--target', target], { cwd: repo, encoding: 'utf8' });
  assert.equal(deployed.status, 0, deployed.stderr);
  const manifest = JSON.parse(await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8'));
  for (const name of obsolete) {
    assert.equal(await absent(join(repo, 'dist', name)), true, `clean dist retained ${name}`);
    assert.equal(await absent(join(target, 'runtime', 'dist', name)), true, `deployment retained ${name}`);
    assert.equal(manifest.files.includes(`runtime/dist/${name}`), false, `manifest retained ${name}`);
  }
});

test('L2 rollback reader smoke', async () => {
  const baseline = await trace(undefined);
  const legacy = await trace({ graph: { mode: 'ON', stale: true }, graphCache: { hostile: true } });
  assert.deepEqual(legacy, baseline);
});
