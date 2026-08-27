#!/usr/bin/env node

/**
 * Capability contract for the private Codex exec adapter.
 *
 * This module intentionally records only normalized, non-secret facts. Child
 * stdout/stderr is bounded and held in memory long enough to classify events;
 * it is never written to a report or fixture.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CODEX_VERSION = '0.145.0';
export const CODEX_MODEL = 'gpt-5.6-sol';
export const DEFAULT_EFFORT = 'high';
export const MAX_EFFORT = 'max';
export const WORKER_SCHEMA_ID = 'lunacy-codex-worker-result-v1';
export const MAX_OUTPUT_BYTES = 512 * 1024;
export const MAX_ERROR_BYTES = 256 * 1024;

const REQUIRED_FLAGS = Object.freeze([
  '--model', '--sandbox', '--json', '--output-schema', '--output-last-message',
  '--ephemeral', '--ignore-user-config', '--strict-config', '--cd', '--config',
]);
const FORBIDDEN_FLAGS = Object.freeze([
  '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
  '--ignore-rules',
]);
const AUTH_ENVIRONMENT_NAMES = Object.freeze(['OPENAI_API_KEY', 'CODEX_AUTH_TOKEN', 'CHATGPT_API_KEY']);
const SAFE_ENVIRONMENT_NAMES = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP',
  'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'HTTP_PROXY', 'HTTPS_PROXY',
  'ALL_PROXY', 'NO_PROXY',
]);

/** Pass only required runtime/auth names; never enumerate or log credential values. */
function childEnvironment() {
  const env = {};
  for (const name of [...SAFE_ENVIRONMENT_NAMES, ...AUTH_ENVIRONMENT_NAMES]) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) env[name] = process.env[name];
  }
  env.NO_COLOR = '1';
  return env;
}

const SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    status: { enum: ['PASS', 'NEEDS-DECISION', 'BLOCKED'] },
    reportPath: { type: 'string' },
    reportDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
  required: ['status', 'reportPath', 'reportDigest'],
  additionalProperties: false,
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedPush(state, chunk, limit) {
  if (state.bytes >= limit) {
    state.overflow = true;
    return;
  }
  const bytes = Buffer.byteLength(chunk);
  const remaining = limit - state.bytes;
  state.text += chunk.slice(0, remaining);
  state.bytes += Math.min(bytes, remaining);
  if (bytes > remaining) state.overflow = true;
}

/** Run an absolute executable without a shell and with bounded output. */
export function runProcess(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const stdoutState = { text: '', bytes: 0, overflow: false };
  const stderrState = { text: '', bytes: 0, overflow: false };
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let timer;
    let killTimer;
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({ ...result, stdout: stdoutState.text, stderr: stderrState.text, stdoutOverflow: stdoutState.overflow, stderrOverflow: stderrState.overflow, timedOut });
    };
    child.on('error', (error) => finish({ error: safeError(error), exitCode: null, signal: null }));
    child.stdout.on('data', (chunk) => boundedPush(stdoutState, String(chunk), MAX_OUTPUT_BYTES));
    child.stderr.on('data', (chunk) => boundedPush(stderrState, String(chunk), MAX_ERROR_BYTES));
    child.on('close', (exitCode, signal) => finish({ error: null, exitCode, signal }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 750);
    }, timeoutMs);
  });
}

async function isReadable(path) {
  try { await access(path, fsConstants.R_OK); return true; } catch { return false; }
}

/** Resolve and attest the physical executable, preserving both path identities. */
export async function attestExecutable(requestedPath) {
  if (!requestedPath || !isAbsolute(requestedPath)) throw new Error('Codex executable path must be absolute');
  const resolvedPath = await realpath(requestedPath);
  const linkStat = await lstat(requestedPath);
  const physicalStat = await stat(resolvedPath);
  if (!physicalStat.isFile()) throw new Error('Codex executable is not a regular file');
  if ((physicalStat.mode & 0o111) === 0) throw new Error('Codex executable is not executable');
  const bytes = await readFile(resolvedPath);
  const versionResult = await runProcess(resolvedPath, ['--version'], { timeoutMs: 5_000, env: childEnvironment() });
  const versionText = versionResult.stdout.trim();
  const expectedVersionText = `codex-cli ${CODEX_VERSION}`;
  if (versionResult.exitCode !== 0 || versionText !== expectedVersionText) {
    throw new Error(`Codex version is not exactly ${CODEX_VERSION}`);
  }
  return {
    requestedPath: resolve(requestedPath),
    physicalPath: resolvedPath,
    requestedPathIsSymlink: linkStat.isSymbolicLink(),
    uid: physicalStat.uid,
    gid: physicalStat.gid,
    mode: (physicalStat.mode & 0o7777).toString(8),
    digest: sha256(bytes),
    version: CODEX_VERSION,
  };
}

export async function attestNode() {
  const nodePath = await realpath(process.execPath);
  const nodeStat = await stat(nodePath);
  if (!nodeStat.isFile() || (nodeStat.mode & 0o111) === 0) throw new Error('Node executable is not a regular executable file');
  const version = process.versions.node;
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isInteger(major) || major < 22 || (major === 22 && minor < 15)) throw new Error('Node runtime is below the supported 22.15 floor');
  return { path: nodePath, version, major, minor, patch: Number(version.split('.')[2] ?? 0) };
}

export function inspectHelp(helpText) {
  const missing = REQUIRED_FLAGS.filter((flag) => !helpText.includes(flag));
  const sandboxMatch = helpText.match(/--sandbox[\s\S]{0,300}/i)?.[0] ?? '';
  const explicitSandbox = ['read-only', 'workspace-write'].every((value) => sandboxMatch.includes(value));
  return {
    requiredFlags: [...REQUIRED_FLAGS],
    missingFlags: missing,
    supportsJsonl: helpText.includes('--json'),
    supportsOutputSchema: helpText.includes('--output-schema'),
    supportsFinalOutputFile: helpText.includes('--output-last-message'),
    supportsEphemeral: helpText.includes('--ephemeral'),
    supportsExplicitSandbox: explicitSandbox,
    supportsIgnoreUserConfig: helpText.includes('--ignore-user-config'),
    supportsStrictConfig: helpText.includes('--strict-config'),
  };
}

export function buildInvocation({ schemaPath, outputPath, workspace, effort = DEFAULT_EFFORT }) {
  if (effort !== DEFAULT_EFFORT && effort !== MAX_EFFORT) throw new Error(`unsupported probe effort ${effort}`);
  for (const path of [schemaPath, outputPath, workspace]) if (!isAbsolute(path)) throw new Error('probe paths must be absolute');
  const args = [
    'exec', '-', '--model', CODEX_MODEL, '--sandbox', 'workspace-write', '--json',
    '--output-schema', schemaPath, '--output-last-message', outputPath, '--ephemeral',
    '--ignore-user-config', '--strict-config', '--cd', workspace,
    '--config', 'approval_policy="never"', '--config', `model_reasoning_effort="${effort}"`,
  ];
  if (args.some((value) => FORBIDDEN_FLAGS.includes(value))) throw new Error('probe invocation contains a forbidden capability flag');
  return args;
}

function parseJsonl(text) {
  const events = [];
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value);
      else invalidLines += 1;
    } catch { invalidLines += 1; }
  }
  return { events, invalidLines };
}

function isCancellation(events, signal) {
  if (signal) return true;
  return events.some((event) => /^(turn\.)?(aborted|cancelled|canceled)$/.test(String(event.type ?? '').toLowerCase()) || ['cancelled', 'canceled', 'aborted'].includes(String(event.status ?? event.control ?? event.item?.status ?? '').toLowerCase().replace(/[ _]/g, '-')));
}

function isApprovalOrSandbox(events, stderr) {
  const approval = events.some((event) => {
    const type = String(event.type ?? '').toLowerCase(); const itemType = String(event.item?.type ?? '').toLowerCase();
    const status = String(event.item?.status ?? event.status ?? event.control ?? '').toLowerCase().replace(/[ _]/g, '-');
    return ['approval.required', 'approval_required', 'turn.approval_required'].includes(type) || ['approval_request', 'approval.required'].includes(itemType) || ['approval-required', 'approval-needed', 'needs-approval'].includes(status);
  }) || /host.*approval (required|needed)/i.test(stderr);
  const sandbox = /sandbox.*(denied|deny|blocked)|permission denied|operation not permitted|outside the sandbox|command.*(denied|blocked)/i.test(stderr)
    || events.some((event) => {
      const item = event.item && typeof event.item === 'object' ? event.item : {};
      const type = String(item.type ?? '').toLowerCase(); const status = String(item.status ?? '').toLowerCase();
      if (!type.includes('command_execution')) return false;
      if (status === 'denied') return true;
      if (status !== 'failed' && status !== 'error') return false;
      return /sandbox.*(denied|deny|blocked)|permission denied|operation not permitted|outside the sandbox|command.*(denied|blocked)/i.test([item.message, item.output, item.aggregated_output, item.error].filter((value) => typeof value === 'string').join('\n'));
    });
  return approval ? 'approval' : sandbox ? 'sandbox' : null;
}

function isTurnFailure(events, stderr) {
  if (events.some((event) => /^(turn\.)?failed$/.test(String(event.type ?? '').toLowerCase()))) return true;
  return /^(?:codex|host):.*(?:turn failed|model error|provider error|context window exceeded)/im.test(stderr);
}

export function validateWorkerResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'reportDigest,reportPath,status') return false;
  return SCHEMA.properties.status.enum.includes(value.status)
    && typeof value.reportPath === 'string' && value.reportPath.length > 0
    && typeof value.reportDigest === 'string' && /^[0-9a-f]{64}$/.test(value.reportDigest);
}

/** Classify the stable semantic terminal outcomes used by the supervisor. */
export function classifyJsonl({ exitCode = null, signal = null, stdout = '', stderr = '', finalOutputText = null, finalOutputPresent = finalOutputText !== null } = {}) {
  const parsed = parseJsonl(stdout);
  const events = parsed.events;
  const validFinal = finalOutputPresent && typeof finalOutputText === 'string' && (() => {
    try { return validateWorkerResult(JSON.parse(finalOutputText)); } catch { return false; }
  })();
  let outcome;
  const hostControl = isApprovalOrSandbox(events, stderr);
  if (parsed.invalidLines > 0) outcome = 'host-evidence-failure';
  else if (isCancellation(events, signal)) outcome = 'cancellation';
  else if (hostControl) outcome = hostControl === 'approval' ? 'approval-required' : 'sandbox-denial';
  else if (isTurnFailure(events, stderr)) outcome = 'turn-failure';
  else if (!finalOutputPresent) outcome = 'absent-final-output';
  else if (!validFinal) outcome = 'malformed-final-output';
  else if (exitCode === 0) outcome = 'normal-completion';
  else outcome = 'process-failure';
  return {
    outcome,
    exitCode,
    signal,
    jsonlEventCount: events.length,
    malformedJsonlLines: parsed.invalidLines,
    finalOutputPresent: Boolean(finalOutputPresent),
    finalOutputValid: Boolean(validFinal),
    terminal: outcome === 'normal-completion' ? 'PASS' : (outcome === 'approval-required' ? 'NEEDS-DECISION' : 'BLOCKED'),
  };
}

async function initDisposableGit(root) {
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  const git = await runProcess('/usr/bin/env', ['git', 'init', '--quiet', repo], { timeoutMs: 5_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  if (git.exitCode !== 0) throw new Error('unable to create disposable Git repository');
  return repo;
}

async function outputState(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { present: true, text };
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, text: null };
    throw error;
  }
}

const PROBE_PROMPT = 'Do not run shell commands or modify files. Return exactly a structured result with status PASS, reportPath "probe-report.md", and a 64-character lowercase hexadecimal reportDigest. Do not include any other properties.';

async function runCodexCase(codexPath, repo, schemaPath, effort, timeoutMs) {
  const outputPath = join(repo, `.probe-result-${effort}.json`);
  const args = buildInvocation({ schemaPath, outputPath, workspace: repo, effort });
  const result = await runProcess(codexPath, args, {
    cwd: repo,
    timeoutMs,
    input: `${PROBE_PROMPT}\n`,
    env: childEnvironment(),
  });
  const final = await outputState(outputPath);
  const classified = classifyJsonl({ exitCode: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr, finalOutputText: final.text, finalOutputPresent: final.present });
  return {
    effort,
    invocation: { model: CODEX_MODEL, sandbox: 'workspace-write', jsonl: true, outputSchema: true, finalOutputFile: true, ephemeral: true, approvalPolicy: 'never', fallback: false },
    result: classified,
    process: { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) },
  };
}

function fixtureCases() {
  return [
    { name: 'normal-completion', expected: 'normal-completion', input: { exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: '', finalOutputPresent: true, finalOutputText: `{"status":"PASS","reportPath":"report.md","reportDigest":"${'0'.repeat(64)}"}` } },
    { name: 'turn-failure', expected: 'turn-failure', input: { exitCode: 1, stdout: '{"type":"turn.failed","error":{"message":"provider error"}}\n', stderr: '', finalOutputPresent: false } },
    { name: 'sandbox-denial', expected: 'sandbox-denial', input: { exitCode: 0, stdout: '{"type":"item.completed","item":{"type":"command_execution_output","status":"denied","message":"sandbox denied"}}\n', stderr: '', finalOutputPresent: false } },
    { name: 'approval-required', expected: 'approval-required', input: { exitCode: 0, stdout: '{"type":"item.completed","item":{"type":"command_execution_output","message":"approval required"}}\n', stderr: '', finalOutputPresent: false } },
    { name: 'cancellation', expected: 'cancellation', input: { exitCode: null, signal: 'SIGTERM', stdout: '{"type":"turn.started"}\n', stderr: '', finalOutputPresent: false } },
    { name: 'malformed-final-output', expected: 'malformed-final-output', input: { exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: '', finalOutputPresent: true, finalOutputText: '{"status":"PASS"}' } },
    { name: 'absent-final-output', expected: 'absent-final-output', input: { exitCode: 0, stdout: '{"type":"turn.completed"}\n', stderr: '', finalOutputPresent: false } },
  ];
}

export function verifyFixtures() {
  return fixtureCases().map((fixture) => {
    const observed = classifyJsonl(fixture.input).outcome;
    return { name: fixture.name, expected: fixture.expected, observed, pass: observed === fixture.expected };
  });
}

function maxClassification(caseResult) {
  if (caseResult.result.outcome === 'normal-completion') return { status: 'supported', reason: 'structured final output accepted' };
  // A rejected/failed max invocation is deliberately not retried at high.
  return { status: 'unsupported', reason: caseResult.process.timedOut ? 'timeout' : caseResult.result.outcome };
}

export async function runProbe({ codexPath = '/opt/homebrew/bin/codex', timeoutMs = 60_000 } = {}) {
  let codex;
  let node;
  const errors = [];
  try { codex = await attestExecutable(codexPath); } catch (error) { errors.push(`codex-attestation:${safeError(error)}`); }
  try { node = await attestNode(); } catch (error) { errors.push(`node-attestation:${safeError(error)}`); }
  if (!codex || !node) {
    return { schema: 'lunacy-codex-capability/v1', status: 'BLOCKED_CODEX_EXEC_CAPABILITY', errors, codex: codex ?? null, node: node ?? null, fixtures: verifyFixtures() };
  }
  const helpResult = await runProcess(codex.physicalPath, ['exec', '--help'], { timeoutMs: 5_000, env: childEnvironment() });
  const flags = inspectHelp(helpResult.stdout);
  if (helpResult.exitCode !== 0 || flags.missingFlags.length > 0 || !flags.supportsExplicitSandbox) errors.push('required Codex exec flags are not exposed by the attested binary');
  const tempRoot = await mkdtemp(join(tmpdir(), 'lunacy-codex-capability-'));
  try {
    const repo = await initDisposableGit(tempRoot);
    const schemaPath = join(tempRoot, 'codex-worker-result.schema.json');
    await writeFile(schemaPath, JSON.stringify({ ...SCHEMA, $schema: 'https://json-schema.org/draft/2020-12/schema', $id: WORKER_SCHEMA_ID }) + '\n', 'utf8');
    const normal = await runCodexCase(codex.physicalPath, repo, schemaPath, DEFAULT_EFFORT, timeoutMs);
    const max = await runCodexCase(codex.physicalPath, repo, schemaPath, MAX_EFFORT, timeoutMs);
    const maxResult = maxClassification(max);
    if (normal.result.outcome !== 'normal-completion') errors.push(`high probe did not complete normally:${normal.result.outcome}`);
    const fixtures = verifyFixtures();
    if (fixtures.some((fixture) => !fixture.pass)) errors.push('semantic fixture classification failed');
    const authEnvironmentNames = AUTH_ENVIRONMENT_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(process.env, name));
    return {
      schema: 'lunacy-codex-capability/v1',
      status: errors.length === 0 ? 'PASS' : 'BLOCKED_CODEX_EXEC_CAPABILITY',
      errors,
      attestation: { codex, node, authEnvironmentNames, credentialsInspected: false, credentialsPersisted: false },
      flags,
      contract: { model: CODEX_MODEL, defaultEffort: DEFAULT_EFFORT, sandbox: 'workspace-write', jsonl: true, outputSchema: true, finalOutputFile: true, ephemeral: true, noFallback: true, approvalPolicy: 'never' },
      probes: { normal, max: { ...max, capability: maxResult } },
      representations: fixtures,
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function usage() {
  return `Usage: node tools/probe-codex-exec.mjs [options]\n\nOptions:\n  --codex PATH       Absolute Codex executable (default /opt/homebrew/bin/codex)\n  --timeout-ms N     Per invocation timeout (default 60000)\n  --fixtures         Run normalized semantic fixtures only (no child process)\n  --output PATH      Write normalized JSON report to PATH\n  --help             Show this help\n\nThe live probe never reads or persists credential values. Failed max is recorded\nas unsupported; it is never retried or downgraded to high.`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--fixtures') { options.fixtures = true; continue; }
    if (arg === '--codex' || arg === '--timeout-ms' || arg === '--output') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--codex') options.codexPath = value;
      else if (arg === '--output') options.output = value;
      else { options.timeoutMs = Number(value); if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('--timeout-ms must be a positive safe integer'); }
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
  const report = options.fixtures ? { schema: 'lunacy-codex-capability-fixtures/v1', status: 'PASS', representations: verifyFixtures() } : await runProbe(options);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    if (!isAbsolute(options.output)) throw new Error('--output must be absolute');
    await writeFile(options.output, text, 'utf8');
  } else process.stdout.write(text);
  return report.status === 'PASS' ? 0 : 1;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${JSON.stringify({ error: safeError(error) })}\n`); process.exitCode = 1; });
}
