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
  { route: 'luna', model: 'gpt-5.6-luna', reasoningEffort: 'max' },
  { route: 'sol-high', model: 'gpt-5.6-sol', reasoningEffort: 'high' },
];

test('canonical default role policy keeps routine work on Luna and bounds Sol judgment', async () => {
  const skill = await source('SKILL.md');

  // Assert the policy concepts independently so harmless prose edits do not break the contract.
  for (const invariant of [
    /parent judgment\/gate/,
    /Luna\/max is the default for [^.\n]*repository-heavy implementation/,
    /repository-heavy implementation/,
    /tests/,
    /ordinary repairs/,
    /documentation/,
    /read-only scouts/,
    /ordinary adversarial reviews/,
    /optional Sol\/high bounded judgment/,
    /Sol\/high is opt-in only for bounded consequential judgment/,
    /architecture\/contract choice/,
    /conflicting-evidence adjudication/,
    /narrow named acceptance question/,
    /Sol\/high is not an automatic independent verifier/,
    /independent verification is conditional on a named risk/,
    /implementation returns to Luna unless [^.\n]*explicitly assigns Sol/,
    /Luna implementation of decisions/,
    /parent acceptance/,
    /parent (?:remains )?the acceptance owner/,
    /GPT-5\.6 Sol at `high` is the preferred parent\/orchestrator when the host lets the user select it/,
    /current allowed non-Sol parent remains valid/,
    /never spawn a shadow\/duplicate parent/,
    /host-level preference is separate from the explicit worker `sol-high` route and its attempt binding/,
    /does not create a Sol attempt binding/,
  ]) {
    assert.match(skill, invariant);
  }

  // Secondary guidance may be rephrased, but must not reverse the canonical boundaries.
  const secondary = await Promise.all([
    source('orchestrator/PLANNING.md'), source('README.md'),
  ]);
  for (const markdown of secondary) {
    assert.doesNotMatch(markdown, /Sol\/high is the default/i);
    assert.doesNotMatch(markdown, /Sol\/high is (?:an? )?(?:automatic|generic)/i);
    assert.doesNotMatch(markdown, /implementation returns to Sol/i);
    assert.doesNotMatch(markdown, /parent (?:is not|does not remain) the acceptance owner/i);
    assert.doesNotMatch(markdown, /Luna[^\n]*`xhigh`/i);
  }
});

test('planning doctrine keeps the current Plan bounded to the accepted outcome', async () => {
  const [planning, skill, readme] = await Promise.all([
    source('orchestrator/PLANNING.md'), source('SKILL.md'), source('README.md'),
  ]);

  for (const invariant of [
    /only work required to reach the authority-owned accepted outcome in the current Plan/,
    /Optional polish is not an executable node/,
    /after the parent gate accepts the outcome[^.]*separately authorized follow-up/,
    /one largest-coherent end-to-end worker owner for the accepted outcome/,
    /Split only at a real authority, ownership, safety, or external-dependency boundary[^.]*as a fifth exception/,
    /evidence shows that one worker would exceed a measured context, time, or tool-capacity boundary/,
    /fewest acceptance-required vertical slices/,
    /never create planning, reporting, proof, test-count, or milestone slices/,
    /Before the first implementation dispatch[^.]*existing user\/project requirements, accepted observable\/result, and chosen architecture spine[^.]*existing Plan\/run authority/,
    /material authority change requires new Plan\/run authority/,
    /never drip-feed a live implementation Plan/,
    /Required documentation, accessibility, quality\/polish[^.]*remain required when authority includes them/,
    /exclude only genuinely optional work/,
    /Acceptance occurs only at the parent gate/,
    /never at dispatch `ACK` or worker `PASS`/,
    /Already-claimed or `UNKNOWN` effects retain custody until they are reconciled/,
  ]) {
    assert.match(planning, invariant);
  }

  assert.doesNotMatch(planning, /polish-only node[^.]*depend/i);

  for (const productSurface of [skill, readme]) {
    assert.match(productSurface, /largest coherent end-to-end/);
    assert.match(productSurface, /measured worker context, time, or tool-capacity/);
    assert.match(productSurface, /fewest acceptance-required vertical slices/);
    assert.match(productSurface, /new Plan\/run authority/);
    assert.match(productSurface, /drip-feed(?:ing)? a live implementation Plan/);
    assert.match(productSurface, /documentation, accessibility, quality\/polish/);
    assert.match(productSurface, /only genuinely optional work/);
  }
});

test('direct worker route table is closed and omission preserves Luna/max', async () => {
  const skill = await source('SKILL.md');
  assert.deepEqual(routeRows(skill), expectedRoutes);
  assert.match(skill, /omitted route means Luna at `max`/);
  assert.match(skill, /No other model\/effort pair is valid[\s\S]{0,500}exact case-sensitive values/);
  assert.match(skill, /no aliases, whitespace normalization, partial declarations, extra route fields, cross-pairs, or ambient inference/);
  assert.match(skill, /Luna is fixed at `max`; it is not an escalation tier/);

  const accepted = new Set(expectedRoutes.map(({ model, reasoningEffort }) => `${model}\0${reasoningEffort}`));
  for (const [model, effort] of [
    ['gpt-5.6-luna', 'high'],
    ['gpt-5.6-luna', 'xhigh'],
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
  assert.match(skill, /agents\.spawn_agent\(\{ model: "gpt-5\.6-luna", reasoning_effort: "max", fork_turns: "none", \.\.\. \}\)/);
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
  assert.match(skill, /Sol never becomes Luna; Luna never becomes Sol; an unavailable pair never becomes another pair/);
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
  assert.match(compatibility, /reasoning_effort: max/);
  assert.doesNotMatch(compatibility, /reasoning_effort: xhigh/);
  assert.match(compatibility, /Do not silently fall back to Sol, Terra, or lower reasoning effort/);
});

test('direct routing remains separate from closed managed Sol/high and Luna/max policies', async () => {
  const [bridge, codexExec, readme] = await Promise.all([
    source('docs/BRIDGE.md'), source('docs/CODEX_EXEC.md'), source('README.md'),
  ]);
  assert.match(bridge, /Sol `codex exec` policy is private to managed runtime drive/);
  assert.match(bridge, /does not enter this policy, change its schema or digest, or[\s\S]*provide a fallback/);
  assert.match(codexExec, /applies only to the managed runtime's fixed Sol `codex exec`\s+boundary/);
  assert.match(readme, /Writable managed action remains[^.]*Sol\/high[\s\S]*adaptive Focus\/Explore deliberation uses[^.]*Luna\/max/);
  assert.match(readme, /direct route choice alone does not change runtime schemas, policy digests, or driver behavior/);
});
