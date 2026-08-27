import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/canonical.js';
import {
  CODEX_MODEL, DEFAULT_REASONING_EFFORT, MAX_REASONING_EFFORT, buildCodexArguments, buildWorkerHandoff,
  createCodexHostPolicy, expectedReportPath, reasoningEffortFor, validateCodexHostPolicy,
} from '../dist/codex-host-policy.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-codex-policy-'));
  const workspace = join(root, 'workspace'); const skillRoot = join(root, 'skill');
  await mkdir(join(workspace, '.git'), { recursive: true }); await mkdir(join(skillRoot, 'worker'), { recursive: true });
  const policy = createCodexHostPolicy({
    runId: 'run-policy', planDigest: '1'.repeat(64), runRoot: root, workspace, skillRoot,
    codexPath: '/opt/homebrew/bin/codex', codexBinaryDigest: '2'.repeat(64),
    workerSchemaPath: join(root, 'schema.json'), workerSchemaDigest: '3'.repeat(64), maxSupported: true,
    maxOverrides: [{ phaseId: 'phase-a', stepId: 'step-max', attemptEpoch: 2, planDigest: '1'.repeat(64), reasonCode: 'REPLAY_FINALITY_HIGH_RISK', decisionRef: 'decision:d-004' }],
  });
  return { root, workspace, policy };
}

function command(policy, stepId = 'step-a', attemptEpoch = 0) {
  const frame = { commandId: `command-${stepId}`, runId: policy.runId, phaseId: 'phase-a', stepId, attemptEpoch, authorityEpoch: 0, barrierEpoch: 0, modeEpoch: 0, launchToken: `launch-${stepId}`, commandDigest: '' };
  frame.commandDigest = digest({ commandId: frame.commandId, runId: frame.runId, phaseId: frame.phaseId, stepId: frame.stepId, attemptEpoch, launchToken: frame.launchToken });
  return { ...frame, planDigest: policy.planDigest };
}

test('closed policy defaults to exact Sol high and rejects stale routing identities', async () => {
  const { policy } = await fixture();
  assert.equal(CODEX_MODEL, 'gpt-5.6-sol');
  assert.equal(DEFAULT_REASONING_EFFORT, 'high');
  assert.equal(policy.schema, 'lunacy-codex-exec-policy/v1');
  assert.equal(policy.model, CODEX_MODEL); assert.equal(policy.defaultEffort, DEFAULT_REASONING_EFFORT); assert.equal(policy.sandbox, 'workspace-write');
  assert.equal(reasoningEffortFor(policy, command(policy)), DEFAULT_REASONING_EFFORT);
  assert.equal(validateCodexHostPolicy(policy).planDigest, policy.planDigest);
  assert.throws(() => validateCodexHostPolicy({ ...policy, nextAction: 'launch' }), /closed/);
  assert.throws(() => createCodexHostPolicy({ ...policy, model: 'gpt-5.6-luna' }), /gpt-5\.6-sol/);
  assert.throws(() => createCodexHostPolicy({ ...policy, defaultEffort: 'xhigh' }), /must be high/);
  assert.throws(() => createCodexHostPolicy({ ...policy, defaultEffort: 'low' }), /must be high/);
  assert.throws(() => createCodexHostPolicy({ ...policy, defaultEffort: 'max' }), /must be high/);
});

test('max is exact override only and unsupported max never downgrades', async () => {
  const { policy } = await fixture();
  const max = command(policy, 'step-max', 2);
  assert.equal(reasoningEffortFor(policy, max), MAX_REASONING_EFFORT);
  assert.equal(reasoningEffortFor(policy, command(policy, 'step-max', 1)), DEFAULT_REASONING_EFFORT);
  const unsupported = createCodexHostPolicy({ ...policy, maxSupported: false });
  assert.throws(() => reasoningEffortFor(unsupported, max), /max is unsupported/);
});

test('handoff and argv are deterministic path-only closed values', async () => {
  const { policy } = await fixture(); const frame = command(policy);
  const handoff = buildWorkerHandoff(policy, frame);
  assert.equal(handoff.reportPath, expectedReportPath(policy, frame));
  assert.match(handoff.text, new RegExp(`^Own ${frame.stepId} end-to-end\\.`));
  assert.match(handoff.text, new RegExp(`${policy.runRoot}/phases/${frame.phaseId}/STEPS\\.md`));
  assert.match(handoff.text, /Mailbox only BLOCKED \/ DECISION_REQUIRED \/ FINAL\./);
  const args = buildCodexArguments(policy, frame, DEFAULT_REASONING_EFFORT, join(policy.effectsRoot, 'result.json'));
  assert.deepEqual(args.slice(0, 7), ['exec', '-', '--model', CODEX_MODEL, '--sandbox', 'workspace-write', '--json']);
  assert.equal(args.at(-1), 'model_reasoning_effort="high"');
  assert.equal(args.filter((arg) => arg === '--model').length, 1);
  assert.equal(args.some((arg) => arg === 'gpt-5.6-luna' || arg.includes('xhigh')), false);
  assert.ok(args.includes('--add-dir')); assert.ok(args.includes('--ephemeral')); assert.ok(args.includes('--strict-config'));
  assert.equal(args.some((arg) => arg.includes('dangerously') || arg === '--ignore-rules' || arg === 'danger-full-access'), false);
  assert.throws(() => buildCodexArguments(policy, frame, 'low', join(policy.effectsRoot, 'result.json')), /unsupported/);
  assert.throws(() => buildCodexArguments(policy, frame, 'xhigh', join(policy.effectsRoot, 'result.json')), /unsupported/);
});

test('policy rejects unsafe paths, environment names, and max reason references', async () => {
  const { policy } = await fixture();
  assert.throws(() => createCodexHostPolicy({ ...policy, workspace: '/tmp/../tmp' }), /canonical/);
  assert.throws(() => createCodexHostPolicy({ ...policy, environmentNames: ['SECRET_FILE'] }), /allowlisted/);
  assert.throws(() => createCodexHostPolicy({ ...policy, environmentNames: ['PATH'] }), /allowlisted/);
  assert.throws(() => createCodexHostPolicy({ ...policy, maxOverrides: [{ ...policy.maxOverrides[0], planDigest: 'f'.repeat(64) }] }), /planDigest/);
});
