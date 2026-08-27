import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function source(path) {
  return readFile(join(root, path), 'utf8');
}

function routeRows(markdown) {
  return [...markdown.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm)]
    .map((match) => ({ route: match[1], model: match[2], reasoningEffort: match[3] }));
}

const expectedRoutes = [
  { route: 'luna', model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' },
  { route: 'luna', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
  { route: 'sol-high', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
];

test('direct worker route table is closed and omission preserves Luna/xhigh', async () => {
  const skill = await source('SKILL.md');
  assert.deepEqual(routeRows(skill), expectedRoutes);
  assert.match(skill, /omitted route means Luna at `xhigh`/);
  assert.match(skill, /No other model\/effort pair is valid[\s\S]{0,500}exact case-sensitive values/);
  assert.match(skill, /no aliases, whitespace normalization, partial declarations, extra route fields, cross-pairs, or ambient inference/);

  const accepted = new Set(expectedRoutes.map(({ model, reasoningEffort }) => `${model}\0${reasoningEffort}`));
  for (const [model, effort] of [
    ['gpt-5.6-luna', 'high'],
    ['gpt-5.6-sol', 'xhigh'],
    ['gpt-5.6-sol', 'max'],
    ['GPT-5.6-SOL', 'high'],
    ['gpt-5.6-sol ', 'high'],
    ['gpt-5.6-terra', 'high'],
    ['gpt-5.6-luna', 'low'],
    ['gpt-5.6-luna', 'ultra'],
  ]) {
    assert.equal(accepted.has(`${model}\0${effort}`), false, `${model}/${effort}`);
  }
});

test('canonical host payloads always carry exact model, effort, and fresh context', async () => {
  const [skill, workspace, readme] = await Promise.all([
    source('SKILL.md'), source('WORKSPACE.md'), source('README.md'),
  ]);
  assert.match(skill, /agents\.spawn_agent\(\{ model: "gpt-5\.6-luna", reasoning_effort: "xhigh", fork_turns: "none", \.\.\. \}\)/);
  assert.match(skill, /agents\.spawn_agent\(\{ model: "gpt-5\.6-sol", reasoning_effort: "high", fork_turns: "none", \.\.\. \}\)/);
  assert.doesNotMatch(skill, /reasoningEffort:/);
  assert.match(workspace, /Always pass `model` and `reasoning_effort` explicitly to `agents\.spawn_agent`/);
  assert.match(readme, /passes both `model` and `reasoning_effort` explicitly to `agents\.spawn_agent`/);
});

test('selected route cannot silently fallback, downgrade, or drift on resume', async () => {
  const [skill, workspace, planning, readme] = await Promise.all([
    source('SKILL.md'), source('WORKSPACE.md'), source('orchestrator/PLANNING.md'), source('README.md'),
  ]);
  assert.match(skill, /make \*\*zero alternate spawn calls\*\*/);
  assert.match(skill, /Sol never becomes Luna; Luna never becomes Sol; Luna `max` never becomes `xhigh`/);
  assert.match(skill, /workerRoute: sol-high; phaseId: <id>; stepId: <id>; attemptEpoch: <n>/);
  assert.match(skill, /Resume that exact route binding or block/);
  assert.match(workspace, /Resume the exact binding or block/);
  assert.match(planning, /resume must preserve it or block/);
  assert.match(readme, /invalid or unavailable selection blocks with no alternate call, fallback, or downgrade/);
});

test('fresh-context exception preserves the explicit selected pair or blocks', async () => {
  const [skill, workspace, readme] = await Promise.all([
    source('SKILL.md'), source('WORKSPACE.md'), source('README.md'),
  ]);
  assert.match(skill, /reasoned inheritance exception[\s\S]{0,220}same explicit `model` and `reasoning_effort`[\s\S]{0,120}otherwise block/);
  assert.match(workspace, /change only `fork_turns`; the selected model and reasoning effort remain explicit and unchanged/);
  assert.match(readme, /inheritance exception must retain the same explicit model\/effort or block/);
});

test('Luna compatibility is route-scoped and never substitutes Sol', async () => {
  const compatibility = await source('references/CODEX_LUNA_COMPAT.md');
  assert.match(compatibility, /belongs only to Lunacy's selected direct `luna` route/);
  assert.match(compatibility, /does not apply to `sol-high`/);
  assert.match(compatibility, /A failed `sol-high` selection blocks/);
  assert.match(compatibility, /retry only the unchanged selected Luna model\/effort/i);
  assert.match(compatibility, /Do not silently fall back to Sol, Terra, or lower reasoning effort/);
});

test('direct routing remains separate from managed runtime Sol policy', async () => {
  const [bridge, codexExec, readme] = await Promise.all([
    source('docs/BRIDGE.md'), source('docs/CODEX_EXEC.md'), source('README.md'),
  ]);
  assert.match(bridge, /Sol `codex exec` policy is private to managed runtime drive/);
  assert.match(bridge, /does not enter this policy, change its schema or digest, or[\s\S]*provide a fallback/);
  assert.match(codexExec, /applies only to the managed runtime's fixed Sol `codex exec`\s+boundary/);
  assert.match(readme, /does not change runtime schemas, policy digests, or driver behavior/);
});
