import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalString, digest, parseCanonical } from '../dist/canonical.js';
import { runCli } from '../dist/cli.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const plan = { phaseId: 'cli-test', steps: [{ stepId: 'a' }] };
const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };

function capture(argv) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(root, 'dist', 'cli.js'), ...argv], { cwd: root });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test('CLI reads canonical plan/event and prints a Yield through advance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunacy-cli-'));
  const planPath = join(dir, 'plan.json'); const eventPath = join(dir, 'event.json');
  await writeFile(planPath, canonicalString(plan), 'utf8');
  await writeFile(eventPath, canonicalString(event), 'utf8');
  const result = await capture(['--plan', planPath, '--event', eventPath, '--run-id', 'cli', '--event-id', 'start']);
  assert.equal(result.code, 0, result.stderr);
  const value = parseCanonical(result.stdout.trim());
  assert.equal(value.kind, 'WAITING');
  assert.equal(value.snapshot.revision, 1);
});

test('canonical fixture is one required accepted-outcome node with a bound event digest', () => {
  const fixturePlan = parseCanonical(readFileSync(join(root, 'examples/canonical-plan.json'), 'utf8'));
  const fixtureEvent = parseCanonical(readFileSync(join(root, 'examples/canonical-event.json'), 'utf8'));
  const fixtureDocs = readFileSync(join(root, 'examples/README.md'), 'utf8');

  assert.deepEqual(fixturePlan, {
    phaseId: 'example',
    steps: [{ goal: 'Deliver the authority-owned accepted outcome end to end', stepId: 'accepted-outcome' }],
  });
  assert.deepEqual(fixtureEvent, {
    intentRef: { digest: digest(fixturePlan), id: 'plan' },
    kind: 'START',
  });
  assert.match(fixtureDocs, /Optional polish is absent/);
  assert.match(fixtureDocs, /separately authorized follow-up only after the parent gate accepts/);
});

test('CLI help is available and malformed canonical input is rejected', async () => {
  const help = await capture(['--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /RunKernel\.advance/);
  const dir = await mkdtemp(join(tmpdir(), 'lunacy-cli-invalid-'));
  await writeFile(join(dir, 'plan.json'), `${JSON.stringify(plan)}\n`, 'utf8');
  await writeFile(join(dir, 'event.json'), JSON.stringify(event), 'utf8');
  const result = await capture(['--plan', join(dir, 'plan.json'), '--event', join(dir, 'event.json')]);
  assert.equal(result.code, 1); assert.match(result.stderr, /canonical JSON/);
});

test('public entry point does not expose a graph/cache lifecycle', async () => {
  const api = await import('../dist/index.js');
  assert.deepEqual(Object.keys(api).sort(), ['Conflict', 'InvalidEvent', 'InvalidPlan', 'KernelError', 'makeRunKernel']);
});

test('bridge lifecycle stays private while composition remains the only package subpath', async () => {
  const composition = await import('lunacy-runtime/dist/composition.js');
  assert.equal(typeof composition.composeKernel, 'function');
  await assert.rejects(() => import('lunacy-runtime/dist/bridge.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('adaptive resolver doctrine names only the verified private installed route', () => {
  for (const path of ['README.md', 'SKILL.md', 'orchestrator/DELIBERATION.md', 'docs/API.md', 'docs/RECOVERY.md', 'docs/INSTALL.md']) {
    const bytes = readFileSync(join(root, path), 'utf8');
    assert.match(bytes, /resolve-plan/);
  }
  const api = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).exports;
  assert.deepEqual(Object.keys(api).sort(), ['.', './dist/composition.js']);
  assert.match(readFileSync(join(root, 'orchestrator/DELIBERATION.md'), 'utf8'), /process-local\s+authorization/);
});

test('published package excludes private bridge/Beads/Workfront executable surfaces', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['lunacy-bridge'], undefined);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }))[0];
  const privateFiles = packed.files.map((item) => item.path).filter((path) => /^dist\/(?:bridge|beads|evidence-copy|workfront)/.test(path) || /^bench\/(?:bridge|workfront)-/.test(path));
  assert.deepEqual(privateFiles, []);
});
