import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path) => readFile(join(root, path), 'utf8');

test('adaptive operator contract limits installed D3 to one pre-Plan Focus wave', async () => {
  const guide = await source('orchestrator/DELIBERATION.md');
  const compact = guide.replace(/\s+/g, ' ');
  for (const invariant of [
    /package\/runtime rollout is disabled by default/i,
    /Direct[^\n]*true bypass/i,
    /Focus[^\n]*two or three isolated/i,
    /Explore[^\n]*five isolated generators producing six ideas each/i,
    /exactly 3–6 mechanism clusters/,
    /35N \+ 40V \+ 25F/,
    /exactly three deepeners/i,
    /parent alone selects or synthesizes a settlement/,
    /gpt-5\.6-luna`\/`max/,
    /gpt-5\.6-sol`\/`high/,
    /no route falls back, substitutes,\s*or downgrades/,
    /existing RunKernel, store, journal, outbox/,
    /Wave v2 and\s*Report v2 are the only deliberation artifacts/,
    /Shadow output is diagnostic only/,
    /managedKillSwitch: true/,
    /strictly newer[^\n]*mode is `disabled`/,
    /automatic Focus at most once for a new eligible managed run/i,
    /before the acceptance pointer\/Plan is sealed, before the first implementation\s*spawn/i,
    /mode:\s*'automatic-focus'/,
    /D3 admits automatic Focus and\s*explicitly requested unsettled Explore only; it never admits implicit Explore/i,
    /Gates, repair, worker completion, resume,\s*rollout transitions, and an existing rollout-bearing run are all ineligible\s*entry points/i,
    /return exactly one parent decision boundary/i,
    /user may still explicitly ask\s*for ADHD\/Explore/i,
    /package\/runtime supplies no ambient D3\s*policy and no fallback route/i,
    /Recovery never re-enters that attempt epoch/,
    /Unsupported platforms[^.]*refuse before provider entry/,
  ]) assert.match(compact, invariant);

  for (const mode of ['disabled', 'shadow', 'focus-canary', 'explicit-explore-canary', 'automatic-focus', 'automatic-explore']) {
    assert.match(guide, new RegExp('`' + mode + '`'));
  }
  assert.match(guide, /quick_validate\.py/);
  assert.match(guide, /tools\/deploy-skill\.mjs --target "\$TARGET" --check/);
  assert.match(guide, /not a runtime default, global\s*flag, deployment-manifest field, or second control plane/i);
  assert.doesNotMatch(guide, /generation:\s*previous\.generation \+ 1,\s*\n\s*mode:\s*'automatic-focus'/);
});

test('product docs link one packaged private guide without widening the public API', async () => {
  const [readme, skill, api, install, recovery, packageBytes] = await Promise.all([
    source('README.md'), source('SKILL.md'), source('docs/API.md'), source('docs/INSTALL.md'),
    source('docs/RECOVERY.md'), source('package.json'),
  ]);
  assert.match(readme, /adaptive operator contract\]\(orchestrator\/DELIBERATION\.md\)/);
  assert.match(skill, /orchestrator\/DELIBERATION\.md/);
  for (const markdown of [api, install, recovery]) {
    assert.match(markdown, /adaptive operator\s+contract\]\(\.\.\/orchestrator\/DELIBERATION\.md\)/);
  }
  const apiCompact = api.replace(/\s+/g, ' ');
  assert.match(apiCompact, /does not add a public lifecycle, event, store, or authority API/);
  assert.match(apiCompact, /Do not persist, edit, or build an operator API around private `managed` MachineState fields/);
  for (const markdown of [readme, skill, api, install]) {
    const compact = markdown.replace(/\s+/g, ' ');
    assert.match(compact, /automatic-focus/);
    assert.match(compact, /one generation-1/i);
    assert.match(compact, /before the acceptance pointer\/Plan is sealed/i);
    assert.match(compact, /before the first implementation spawn/i);
    assert.match(compact, /(?:never automatically|Automatic Focus never) WIDENs or re-enters/i);
    assert.match(compact, /existing rollout-bearing run/i);
    assert.match(compact, /exactly one parent decision boundary/i);
    assert.match(compact, /Direct[^.]*bypass|Direct[^.]*zero-fan-out/i);
    assert.match(compact, /user-explicit ADHD\/Explore[^.]*explicit-only|user-explicit ADHD\/Explore/i);
    assert.match(compact, /no ambient rollout|no ambient D3 policy|package\/runtime remains rollout-disabled/i);
    assert.doesNotMatch(compact, /strictly (?:the accepted )?current generation \+ 1 for an existing|strictly accepted-current \+ 1 for an existing/i);
  }
  assert.match(install.replace(/\s+/g, ' '), /omission remains fail-safe disabled/);
  const recoveryCompact = recovery.replace(/\s+/g, ' ');
  assert.match(recoveryCompact, /automatic D3 Focus does not retry or replace that Wave/);
  assert.match(recoveryCompact, /single parent decision boundary/);
  assert.match(recoveryCompact, /user-explicit ADHD\/Explore Wave remains available/);
  assert.match(recoveryCompact, /capsule remains diagnostic and cannot repair or promote managed state/);
  const packageValue = JSON.parse(packageBytes);
  assert.equal(packageValue.files.includes('orchestrator/DELIBERATION.md'), true);
});
