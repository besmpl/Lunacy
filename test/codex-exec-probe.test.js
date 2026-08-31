import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEX_MODEL,
  DEFAULT_EFFORT,
  MAX_EFFORT,
  buildInvocation,
  classifyJsonl,
  inspectHelp,
  validateWorkerResult,
} from '../tools/probe-codex-exec.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = [
  'normal-completion', 'turn-failure', 'sandbox-denial', 'approval-required',
  'cancellation', 'malformed-final-output', 'absent-final-output',
];

for (const name of fixtures) {
  test(`Codex JSONL fixture: ${name}`, async () => {
    const fixture = JSON.parse(await readFile(join(root, 'test', 'fixtures', 'codex-exec', `${name}.json`), 'utf8'));
    assert.equal(classifyJsonl(fixture.input).outcome, fixture.expected);
  });
}

test('worker result schema is closed and exact', () => {
  const good = { status: 'PASS', reportPath: 'report.md', reportDigest: '0'.repeat(64) };
  assert.equal(validateWorkerResult(good), true);
  assert.equal(validateWorkerResult({ ...good, extra: true }), false);
  assert.equal(validateWorkerResult({ ...good, reportDigest: 'A'.repeat(64) }), false);
  assert.equal(validateWorkerResult({ status: 'PASS', reportPath: 'report.md' }), false);
});

test('invocation pins Sol, effort, schema, output, sandbox, and no fallback', () => {
  assert.equal(CODEX_MODEL, 'gpt-5.6-sol');
  assert.equal(DEFAULT_EFFORT, 'high');
  const args = buildInvocation({ schemaPath: '/tmp/schema.json', outputPath: '/tmp/result.json', workspace: '/tmp/repo', effort: DEFAULT_EFFORT });
  assert.deepEqual(args.slice(0, 7), ['exec', '-', '--model', CODEX_MODEL, '--sandbox', 'workspace-write', '--json']);
  assert.ok(args.includes('--output-schema'));
  assert.ok(args.includes('--output-last-message'));
  assert.ok(args.includes('--ephemeral'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--strict-config'));
  assert.ok(args.includes('--cd'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes(`model_reasoning_effort="${DEFAULT_EFFORT}"`));
  assert.equal(args.some((arg) => arg.includes('dangerously') || arg === '--ignore-rules'), false);
  assert.throws(() => buildInvocation({ schemaPath: 'schema.json', outputPath: '/tmp/result.json', workspace: '/tmp/repo' }));
  assert.throws(() => buildInvocation({ schemaPath: '/tmp/schema.json', outputPath: '/tmp/result.json', workspace: '/tmp/repo', effort: 'xhigh' }), /unsupported/);
  assert.throws(() => buildInvocation({ schemaPath: '/tmp/schema.json', outputPath: '/tmp/result.json', workspace: '/tmp/repo', effort: 'low' }), /unsupported/);
  assert.equal(buildInvocation({ schemaPath: '/tmp/schema.json', outputPath: '/tmp/result.json', workspace: '/tmp/repo', effort: MAX_EFFORT }).at(-1), 'model_reasoning_effort="max"');
});

test('help probe recognizes the installed required flags and explicit safe sandboxes', () => {
  const help = `--model X --sandbox <SANDBOX_MODE> [read-only, workspace-write, danger-full-access]\n--json --output-schema --output-last-message --ephemeral --ignore-user-config --strict-config --cd --config`;
  const result = inspectHelp(help);
  assert.deepEqual(result.missingFlags, []);
  assert.equal(result.supportsExplicitSandbox, true);
  assert.equal(result.supportsJsonl, true);
});

test('direct docs and private deliberation use Luna/max while writable managed action remains pinned to Sol/high', async () => {
  const directDocs = [
    'README.md', 'SKILL.md', 'WORKSPACE.md', 'orchestrator/PLANNING.md',
  ];
  const directTexts = await Promise.all(directDocs.map((path) => readFile(join(root, path), 'utf8')));
  for (const [index, text] of directTexts.entries()) {
    assert.match(text, /gpt-5\.6-luna/, directDocs[index]);
    assert.match(text, /gpt-5\.6-sol/, directDocs[index]);
    assert.match(text, /\bmax\b/, directDocs[index]);
    assert.match(text, /\bhigh\b/, directDocs[index]);
  }
  assert.match(directTexts[0], /model: gpt-5\.6-luna[\s\S]*reasoning_effort: max[\s\S]*model: gpt-5\.6-sol[\s\S]*reasoning_effort: high/);
  assert.match(directTexts[1], /omitted route means Luna at `max`[\s\S]*explicit `sol-high` means exactly GPT-5\.6 Sol at `high`/);

  const managed = [
    'src/codex-host-policy.ts',
    'tools/probe-codex-exec.mjs', 'tools/deploy-skill.mjs',
    'tools/verify-release-quiescence.mjs',
  ];
  const managedTexts = await Promise.all(managed.map((path) => readFile(join(root, path), 'utf8')));
  for (const [index, text] of managedTexts.slice(1).entries()) {
    assert.doesNotMatch(text, /gpt-5\.6-luna|\bLuna\b|\bxhigh\b|CODEX_LUNA_COMPAT/, managed[index + 1]);
  }
  assert.match(managedTexts[0], /CODEX_MODEL = 'gpt-5\.6-sol'[\s\S]*DEFAULT_REASONING_EFFORT = 'high'/);
  assert.match(managedTexts[0], /DELIBERATION_CODEX_MODEL = 'gpt-5\.6-luna'[\s\S]*DELIBERATION_REASONING_EFFORT = 'max'/);
  assert.match(managedTexts[0], /effectDenied: true[\s\S]*targetWrite: false[\s\S]*network: false[\s\S]*fallback: false/);
  assert.match(managedTexts[1], /CODEX_MODEL = 'gpt-5\.6-sol'[\s\S]*DEFAULT_EFFORT = 'high'/);
  assert.match(managedTexts[2], /probe-codex-exec\.mjs'[\s\S]*runtime\/tools\/probe-codex-exec\.mjs[\s\S]*verify-release-quiescence\.mjs'[\s\S]*runtime\/tools\/verify-release-quiescence\.mjs/);

  const [bridge, codexExec] = await Promise.all([
    readFile(join(root, 'docs/BRIDGE.md'), 'utf8'),
    readFile(join(root, 'docs/CODEX_EXEC.md'), 'utf8'),
  ]);
  assert.match(bridge, /Sol `codex exec` policy is private to managed runtime drive/);
  assert.match(codexExec, /--model gpt-5\.6-sol[\s\S]*`high` invocation/);
});
