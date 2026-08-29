import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { transition } from '../dist/bridge.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { inspectRecovery, validateRecoveryCapsule } from '../dist/recovery-forensics.js';
import { FileArtifactStore } from '../dist/store.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const repoRoot = process.cwd();

async function fixture(name = 'r4') {
  const root = await mkdtemp(join(tmpdir(), `lunacy-${name}-`));
  const plan = { phaseId: 'phase-r4', steps: [{ stepId: 'step-r4' }] };
  await transition({ runDir: root, runId: name, mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  return { root, plan };
}

async function tree(root) {
  const out = {};
  async function visit(path, prefix = '') {
    let entries = [];
    try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name); const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child, key); else out[key] = await readFile(child).then((bytes) => bytes.toString('hex'));
    }
  }
  await visit(root); return out;
}

test('R4 absent-token capsule is canonical, redacted, bounded, and deterministic', async () => {
  const { root } = await fixture('r4-absent');
  const before = await tree(root);
  const first = await inspectRecovery({ runRoot: root, runId: 'r4-absent', launchToken: 'missing-token' });
  const second = await inspectRecovery({ runRoot: root, runId: 'r4-absent', launchToken: 'missing-token' });
  assert.deepEqual(first, second);
  assert.equal(canonicalString(first), canonicalString(second));
  assert.equal(first.schema, 'lunacy-recovery/v1');
  assert.equal(first.outbox.binding, 'ABSENT');
  assert.equal(first.effects.launch.status, 'ABSENT');
  assert.equal(first.fence.namespace, 'UNCHANGED');
  validateRecoveryCapsule(first);
  assert.equal(JSON.stringify(first).includes(root), false);
  assert.equal(JSON.stringify(first).includes('missing-token'), false);
  assert.deepEqual(await tree(root), before);
});

test('R4 wrong command digest is a closed mismatch and CLI stays private', async () => {
  const { root } = await fixture('r4-mismatch');
  const capsule = await inspectRecovery({ runRoot: root, runId: 'r4-mismatch', launchToken: 'not-in-outbox', commandDigest: 'a'.repeat(64) });
  assert.equal(capsule.request.commandDigest, 'a'.repeat(64));
  const result = spawnSync(process.execPath, ['dist/bridge-cli.js', 'inspect-recovery', '--run-root', root, '--run-id', 'r4-mismatch', '--launch-token', 'not-in-outbox'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).schema, 'lunacy-recovery/v1');
  assert.equal(result.stderr, '');
});

test('segmented/v2 recovery capsule reports bounded journal budget', async () => {
  const { root } = await fixture('r4-v2-budget');
  try {
    await new FileArtifactStore(root).migrateToSegmentedV2();
    const capsule = await inspectRecovery({ runRoot: root, runId: 'r4-v2-budget', launchToken: 'missing-token' });
    assert.equal(capsule.journal.format, 'segmented');
    assert.equal(capsule.journal.events.ceiling, null);
    assert.equal(capsule.journal.bytes.ceiling, null);
    assert.equal(capsule.journal.activeSuffix.ceiling, 1000);
    assert.equal(capsule.journal.activeSuffix.used, 1);
    validateRecoveryCapsule(capsule);
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test('managed transition defaults do not select the segmented/v2 writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r4-default-format-'));
  const plan = { phaseId: 'phase-default-format', steps: [{ stepId: 'step-default-format' }] };
  try {
    await transition({ runDir: root, runId: 'r4-default-format', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
    const current = JSON.parse(await readFile(join(root, '.kernel', 'CURRENT'), 'utf8'));
    assert.equal(Object.hasOwn(current, 'format'), false);
    assert.notEqual(current.format, 'segmented/v2');
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});

test('R4 malformed effect evidence fails closed without cleanup', async () => {
  const { root } = await fixture('r4-malformed');
  const effects = join(root, '.codex-effects', createHash('sha256').update('bad-token').digest('hex'));
  await import('node:fs/promises').then(({ mkdir }) => mkdir(effects, { recursive: true }));
  await writeFile(join(effects, 'terminal.json'), Buffer.from([0xff, 0xfe]));
  const before = await tree(root);
  const capsule = await inspectRecovery({ runRoot: root, runId: 'r4-malformed', launchToken: 'bad-token' });
  assert.equal(capsule.effects.terminal.status, 'INVALID_UTF8');
  assert.equal(capsule.effects.terminal.verified, false);
  assert.deepEqual(await tree(root), before);
});

test('R4 frozen golden corpus is canonical and digest-manifest bound', async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'test/fixtures/recovery/golden-manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 'lunacy-recovery-goldens/v1');
  for (const [name, expectedDigest] of Object.entries(manifest.files)) {
    const path = name === 'schema' ? join(repoRoot, 'schemas/recovery-forensics.schema.json') : join(repoRoot, 'test/fixtures/recovery/goldens', name);
    const bytes = await readFile(path);
    assert.equal(sha256(bytes), expectedDigest, `${name} digest drift`);
    if (name === 'schema') continue;
    const text = bytes.toString('utf8');
    const capsule = JSON.parse(text);
    assert.equal(canonicalString(capsule), text.trimEnd(), `${name} is not canonical`);
    assert.deepEqual(Object.keys(capsule).sort(), ['effects', 'fence', 'journal', 'nextProof', 'outbox', 'request', 'run', 'schema', 'unknown'].sort());
  }
});

test('R4 targeted oversized and symlink records stay bounded and fail closed', async () => {
  const { root } = await fixture('r4-targeted-bound');
  const token = 'targeted-token';
  const effects = join(root, '.codex-effects', createHash('sha256').update(token).digest('hex'));
  await import('node:fs/promises').then(({ mkdir }) => mkdir(effects, { recursive: true }));
  await writeFile(join(effects, 'terminal.json'), Buffer.alloc(256 * 1024 + 1, 0x61));
  let capsule = await inspectRecovery({ runRoot: root, runId: 'r4-targeted-bound', launchToken: token });
  assert.equal(capsule.effects.terminal.status, 'OVERSIZED');
  await import('node:fs/promises').then(({ unlink }) => unlink(join(effects, 'terminal.json')));
  const outside = join(root, 'outside-terminal.json');
  await writeFile(outside, '{}');
  await symlink(outside, join(effects, 'terminal.json'));
  capsule = await inspectRecovery({ runRoot: root, runId: 'r4-targeted-bound', launchToken: token });
  assert.equal(capsule.effects.terminal.verified, false);
  assert.equal(capsule.effects.terminal.binding, 'UNVERIFIABLE');
});

test('R4 selector aliases reject conflicting API values', async () => {
  const { root } = await fixture('r4-alias-conflict');
  await assert.rejects(() => inspectRecovery({ runRoot: root, kernelRoot: `${root}-other`, runId: 'r4-alias-conflict', launchToken: 'token' }), /selectors conflict/);
  await assert.rejects(() => inspectRecovery({ runRoot: root, runId: 'r4-alias-conflict', expectedRunId: 'other', launchToken: 'token' }), /selectors conflict/);
  await assert.rejects(() => inspectRecovery({ runRoot: root, runId: 'r4-alias-conflict', launchToken: 'token', token: 'other' }), /selectors conflict/);
});

test('P4-SCHEMA-BOUNDS rejects overlong request and committed identities', async () => {
  const longRunId = 'r'.repeat(257);
  const runRoot = await mkdtemp(join(tmpdir(), 'lunacy-r6-long-run-'));
  const plan = { phaseId: 'phase-safe', steps: [{ stepId: 'step-safe' }] };
  await transition({ runDir: runRoot, runId: longRunId, mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  await assert.rejects(() => inspectRecovery({ runRoot, runId: longRunId, launchToken: 'missing' }), /runId exceeds capsule identity limit/);

  // A filesystem phase directory cannot represent a 257-byte component on
  // common filesystems. Exercise the same frozen schema bound directly on a
  // returned capsule so the validator remains covered independently of that
  // host limitation.
  const bounded = await inspectRecovery({ runRoot: (await fixture('r6-schema-bound')).root, runId: 'r6-schema-bound', launchToken: 'missing' });
  assert.throws(() => validateRecoveryCapsule({ ...bounded, run: { ...bounded.run, phaseId: 'p'.repeat(257) } }), /capsule schema validation failed: run.phaseId is invalid/);

});

test('P4-SCHEMA-BOUNDS redacts path/control-bearing step IDs and validates output schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-r6-step-redaction-'));
  const stepId = '/tmp/secret\u0007step';
  const plan = { phaseId: 'phase-safe', steps: [{ stepId }] };
  await transition({ runDir: root, runId: 'r6-step-redaction', mode: 'runtime', plan }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }, eventId: 'start' });
  const state = (await new FileArtifactStore(root).loadReadOnly('r6-step-redaction')).state;
  assert.ok(state);
  const command = Object.values(state.outbox)[0];
  assert.ok(command);
  const capsule = await inspectRecovery({ runRoot: root, runId: 'r6-step-redaction', launchToken: command.launchToken });
  validateRecoveryCapsule(capsule);
  assert.equal(capsule.outbox.stepId, `sha256:${sha256(stepId)}`);
  assert.equal(JSON.stringify(capsule).includes(stepId), false);
  assert.equal(capsule.outbox.stepId.length, 71);
});
