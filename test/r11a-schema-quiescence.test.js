import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { launchRecordRef, validateTerminalRecord } from '../dist/codex-effect-records.js';
import { drive } from '../dist/orchestration.js';
import { verifyReleaseQuiescence } from '../dist/release-quiescence.js';
import { FileArtifactStore } from '../dist/store.js';

const repo = resolve('.');
const roots = [];
let target;
const terminalOutcomes = [
  'normal-completion', 'turn-failure', 'sandbox-denial', 'approval-required', 'cancellation',
  'host-evidence-failure', 'unresolved-termination', 'malformed-final-output', 'absent-final-output', 'process-failure',
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const ref = (id, value, scope = 'test') => ({ id, scope, digest: digest(value), bytes: canonicalString(value) });

before(async () => {
  target = await mkdtemp(join(tmpdir(), 'lunacy-r11a-target-'));
  const deployed = spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target], { cwd: repo, encoding: 'utf8' });
  assert.equal(deployed.status, 0, deployed.stderr);
});
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  if (target) await rm(target, { recursive: true, force: true });
});

function validateSchema(schema, value, label = '$') {
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${label} const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${label} enum`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    assert.ok(types.includes(actual) || (actual === 'integer' && types.includes('number')), `${label} type ${actual}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${label} minLength`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${label} pattern`);
    if (schema.format === 'date-time') assert.equal(Number.isNaN(Date.parse(value)), false, `${label} date-time`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${label} minimum`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (schema.required) for (const key of schema.required) assert.ok(Object.hasOwn(value, key), `${label}.${key} required`);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${label}.${key} additional`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) validateSchema(child, value[key], `${label}.${key}`);
  }
}

function terminalFor(outcome, token = 'launch-proof', commandDigest = 'a'.repeat(64)) {
  const status = outcome === 'normal-completion' ? 'PASS' : outcome === 'approval-required' ? 'NEEDS-DECISION' : outcome === 'unresolved-termination' ? 'UNKNOWN' : 'BLOCKED';
  return {
    schema: 'lunacy-codex-terminal/v1', launchToken: token, commandDigest, status, outcome,
    exitCode: outcome === 'normal-completion' ? 0 : null, signal: null,
    resultDigest: outcome === 'normal-completion' ? 'b'.repeat(64) : null,
    reportPath: outcome === 'normal-completion' ? '/tmp/report.md' : null,
    reportDigest: outcome === 'normal-completion' ? 'c'.repeat(64) : null,
    eventsDigest: 'd'.repeat(64), finishedAt: '2026-08-27T12:00:01.000Z',
  };
}

test('every runtime-emittable terminal outcome validates under source and actually deployed managed schema', async () => {
  const source = JSON.parse(await readFile(join(repo, 'schemas/codex-terminal-record.schema.json'), 'utf8'));
  const deployed = JSON.parse(await readFile(join(target, 'runtime/schemas/codex-terminal-record.schema.json'), 'utf8'));
  assert.deepEqual(deployed, source);
  assert.deepEqual(source.properties.outcome.enum, terminalOutcomes);
  for (const outcome of terminalOutcomes) {
    const record = terminalFor(outcome);
    assert.deepEqual(validateTerminalRecord(record), record);
    validateSchema(source, record, `source:${outcome}`);
    validateSchema(deployed, record, `deployed:${outcome}`);
  }
});

async function buildQuiescentRun(name) {
  const root = await mkdtemp(join(tmpdir(), `lunacy-r11a-${name}-`)); roots.push(root);
  const plan = { phaseId: `phase-${name}`, steps: [{ stepId: 'only' }] };
  const reportPath = join(root, 'phases', plan.phaseId, 'reports', 'only-worker-0.md');
  const reportText = '## Control\nStatus: PASS\n';
  let launch; let terminal; let resultText;
  const driver = {
    dispatch(command) {
      launch = {
        schema: 'lunacy-codex-launch/v1', launchToken: command.launchToken, commandDigest: command.commandDigest,
        commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId,
        attempt: command.attemptEpoch, attemptEpoch: command.attemptEpoch, authorityEpoch: command.authorityEpoch,
        barrierEpoch: command.barrierEpoch, policyDigest: '1'.repeat(64), authorityDigest: '2'.repeat(64),
        handoffDigest: '3'.repeat(64), argvDigest: '4'.repeat(64), codexPath: '/opt/homebrew/bin/codex',
        codexVersion: '0.145.0', codexBinaryDigest: hash('copied-codex'), workspace: join(root, 'workspace'),
        supervisor: { pid: 70001 }, child: { pid: 70002 }, startedAt: '2026-08-27T12:00:00.000Z',
      };
      const result = { reportDigest: hash(reportText), reportPath, status: 'PASS' };
      resultText = JSON.stringify(result);
      terminal = {
        ...terminalFor('normal-completion', command.launchToken, command.commandDigest),
        resultDigest: hash(resultText), reportPath, reportDigest: result.reportDigest,
      };
      return { launchToken: command.launchToken, commandDigest: command.commandDigest, ref: launchRecordRef(launch) };
    },
    terminal() { return terminal; },
  };
  const result = await drive({ runDir: root, runId: `run-${name}`, plan, driver });
  assert.equal(result.yield.kind, 'FINAL');
  const state = (await new FileArtifactStore(root).loadReadOnly()).state;
  const command = Object.values(state.outbox)[0];
  const directory = join(root, '.codex-effects', hash(command.launchToken));
  await mkdir(join(directory, 'authority'), { recursive: true });
  const { schema: _schema, child: _child, ...body } = launch;
  const intent = { ...body, schema: 'lunacy-codex-launch-intent/v1' };
  await writeFile(join(directory, 'launch-intent.json'), canonicalString(intent));
  await writeFile(join(directory, 'launch.json'), canonicalString(launch));
  await writeFile(join(directory, 'terminal.json'), canonicalString(terminal));
  await writeFile(join(directory, 'result.json'), resultText);
  await mkdir(join(root, 'phases', plan.phaseId, 'reports'), { recursive: true });
  await writeFile(reportPath, reportText);
  await writeFile(join(directory, 'authority/codex-executable'), 'copied-codex');
  await chmod(join(directory, 'authority/codex-executable'), 0o500);
  return { root, command, launch, terminal, copiedExecutable: join(directory, 'authority/codex-executable') };
}

async function buildActiveRun(name, commandState) {
  const root = await mkdtemp(join(tmpdir(), `lunacy-r11a-${name}-`)); roots.push(root);
  await drive({
    runDir: root, runId: `run-${name}`, plan: { phaseId: `phase-${name}`, steps: [{ stepId: 'only' }] },
    driver: { dispatch() { throw new Error('dispatch must not run'); }, terminal() { return undefined; } },
    maxTransitions: 1,
  });
  const state = (await new FileArtifactStore(root).loadReadOnly()).state;
  const command = Object.values(state.outbox)[0];
  assert.equal(command.state, 'PENDING');
  if (commandState !== 'PENDING') await rewriteCurrentState(root, (value) => { value.outbox[command.commandId].state = commandState; });
  await mkdir(join(root, '.codex-effects', hash(command.launchToken)), { recursive: true });
  return { root, command };
}

const emptySnapshot = () => ({ schema: 'lunacy-process-snapshot/v1', capturedAt: '2026-08-27T12:01:00.000Z', processes: [] });
const processRecord = (overrides = {}) => ({
  pid: 90001, ppid: 1, pgid: 90001, startedAt: '2026-08-27T12:00:00.000Z',
  executable: '/usr/bin/true', argv: ['/usr/bin/true'], ...overrides,
});
const verify = (runRoots, processSnapshot = emptySnapshot(), extra = {}) => verifyReleaseQuiescence({ installedTarget: target, runRoots, processSnapshot, ...extra });
async function currentPaths(root) {
  const currentPath = join(root, '.kernel/CURRENT');
  const current = JSON.parse(await readFile(currentPath, 'utf8'));
  const generation = join(root, '.kernel/generations', `g${current.generation}`);
  return { currentPath, current, statePath: join(generation, 'state.json'), journalPath: join(generation, 'journal.ndjson') };
}

async function rewriteCurrentState(root, mutate) {
  const { currentPath, current, statePath } = await currentPaths(root);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  mutate(state);
  await writeFile(statePath, canonicalString(state));
  await writeFile(currentPath, canonicalString({ ...current, stateDigest: digest(state) }));
}

for (const mutation of [
  ['empty object state', async ({ statePath }) => writeFile(statePath, '{}')],
  ['malformed state', async ({ statePath }) => writeFile(statePath, '{')],
  ['noncanonical state bytes', async ({ statePath }) => writeFile(statePath, `${await readFile(statePath, 'utf8')}\n`)],
  ['CURRENT generation mismatch', async ({ currentPath, current }) => writeFile(currentPath, canonicalString({ ...current, generation: current.generation + 1 }))],
  ['CURRENT/state revision mismatch', async ({ currentPath, current }) => writeFile(currentPath, canonicalString({ ...current, revision: current.revision + 1 }))],
]) {
  test(`fails closed on ${mutation[0]}`, async () => {
    const fixture = await buildQuiescentRun(`state-${roots.length}`); const paths = await currentPaths(fixture.root);
    await mutation[1](paths);
    await assert.rejects(() => verify([fixture.root]), /invalid|canonical|CURRENT|incomplete|mismatch/i);
  });
}

test('fails closed on journal/outbox/state disagreement', async () => {
  const fixture = await buildQuiescentRun('journal-disagreement'); const { journalPath } = await currentPaths(fixture.root);
  await writeFile(journalPath, `${await readFile(journalPath, 'utf8')}{}\n`);
  await assert.rejects(() => verify([fixture.root]), /journal|invalid/i);
});

test('rejects every active or unresolved outbox state', async () => {
  for (const commandState of ['PENDING', 'CLAIMED', 'UNKNOWN']) {
    const fixture = await buildActiveRun(`active-${commandState.toLowerCase()}`, commandState);
    await assert.rejects(() => verify([fixture.root]), new RegExp(`outbox .* is ${commandState}`));
  }
});

test('rejects nested, duplicate, aliased, and out-of-set roots', async () => {
  const fixture = await buildQuiescentRun('root-set');
  await assert.rejects(() => verify([fixture.root, fixture.root]), /duplicates/);
  await assert.rejects(() => verify([fixture.root, join(fixture.root, 'nested')]), /nested/);
  const alias = `${fixture.root}-alias`; await (await import('node:fs/promises')).symlink(fixture.root, alias); roots.push(alias);
  await assert.rejects(() => verify([fixture.root, alias]), /aliases|symlink/i);
  const unlistedExecutable = join(tmpdir(), 'unlisted-run', '.codex-effects', 'e'.repeat(64), 'authority/codex-executable');
  await assert.rejects(() => verify([fixture.root], { ...emptySnapshot(), processes: [processRecord({ executable: unlistedExecutable, argv: [unlistedExecutable] })] }), /unlisted run root/);
});

test('rejects PID reuse and process-group ownership ambiguity', async () => {
  const fixture = await buildQuiescentRun('pid-reuse');
  await assert.rejects(() => verify([fixture.root], { ...emptySnapshot(), processes: [processRecord({ pid: fixture.launch.child.pid, pgid: 12345 })] }), /ownership is ambiguous/);
  await assert.rejects(() => verify([fixture.root], { ...emptySnapshot(), processes: [processRecord({ pid: 91000, pgid: fixture.launch.child.pid })] }), /process group/);
});

test('rejects a copied-image child even when no bridge process exists', async () => {
  const fixture = await buildQuiescentRun('copied-child');
  const child = processRecord({ pid: fixture.launch.child.pid, pgid: fixture.launch.child.pid, executable: fixture.copiedExecutable, argv: [fixture.copiedExecutable, 'exec', '-'] });
  await assert.rejects(() => verify([fixture.root], { ...emptySnapshot(), processes: [child] }), /live copied Codex child/);
});

test('rejects live bridge, pump, and supervisor ownership', async (t) => {
  const fixture = await buildQuiescentRun('live-host');
  const bridge = join(target, 'runtime/bridge.mjs');
  await t.test('bridge/pump', async () => assert.rejects(() => verify([fixture.root], { ...emptySnapshot(), processes: [processRecord({ argv: [process.execPath, bridge, 'drive', '--root', fixture.root] })] }), /bridge\/pump/));
  await t.test('supervisor', async () => assert.rejects(() => verify([fixture.root], { ...emptySnapshot(), processes: [processRecord({ pid: fixture.launch.supervisor.pid })] }), /supervisor/));
});

test('does not substring-match the verifier itself', async () => {
  const fixture = await buildQuiescentRun('self-match');
  const self = processRecord({ pid: process.pid, argv: [process.execPath, 'verify-release-quiescence', `diagnostic=${fixture.copiedExecutable}`, 'codex-exec-supervisor', 'BridgeDrivePump'] });
  const result = await verify([fixture.root], { ...emptySnapshot(), processes: [self] }, { selfPid: process.pid });
  assert.equal(result.status, 'QUIESCENT');
});

test('rejects target lock and transaction residue without removing it', async () => {
  const fixture = await buildQuiescentRun('target-residue');
  for (const name of ['.lunacy-runtime-deploy.lock', '.lunacy-runtime-deploy.json', '.lunacy-runtime-stage-1-deadbeef']) {
    const path = join(target, name); await writeFile(path, '{}');
    await assert.rejects(() => verify([fixture.root]), /deployment residue/);
    assert.equal(await readFile(path, 'utf8'), '{}');
    await unlink(path);
  }
});

test('rejects unresolved or unbound effect chains', async () => {
  const missing = await buildQuiescentRun('missing-terminal');
  await unlink(join(missing.root, '.codex-effects', hash(missing.command.launchToken), 'terminal.json'));
  await assert.rejects(() => verify([missing.root]), /terminal.*(?:absent|does not exist|unreadable)/);
  const unresolved = await buildQuiescentRun('unknown-terminal');
  const path = join(unresolved.root, '.codex-effects', hash(unresolved.command.launchToken), 'terminal.json');
  await writeFile(path, canonicalString(terminalFor('unresolved-termination', unresolved.command.launchToken, unresolved.command.commandDigest)));
  await assert.rejects(() => verify([unresolved.root]), /unresolved/);
});

test('accepts a truly quiescent exact closed set and the deployed CLI reports only', async () => {
  const left = await buildQuiescentRun('green-left'); const right = await buildQuiescentRun('green-right');
  const snapshotPath = join(left.root, 'process-snapshot.json'); await writeFile(snapshotPath, canonicalString(emptySnapshot()));
  const beforeLeft = hash(await readFile((await currentPaths(left.root)).statePath));
  const report = await verify([left.root, right.root]);
  assert.deepEqual({ status: report.status, runCount: report.runCount, effectCount: report.effectCount }, { status: 'QUIESCENT', runCount: 2, effectCount: 2 });
  const cli = spawnSync(process.execPath, [join(target, 'runtime/tools/verify-release-quiescence.mjs'), '--target', target, '--process-snapshot', snapshotPath, '--run-root', left.root, '--run-root', right.root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'QUIESCENT');
  assert.equal(hash(await readFile((await currentPaths(left.root)).statePath)), beforeLeft);
});
