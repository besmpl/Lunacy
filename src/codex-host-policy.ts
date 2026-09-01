import { createHash } from 'node:crypto';
import { lstatSync, promises as fs, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { OutboxCommand, Sha256 } from './model.js';
import { canonicalString, digest } from './canonical.js';

/** The host policy is capability-only data.  It never contains a command
 * status, dependency state, retry instruction, or scheduler cursor. */
export const CODEX_HOST_POLICY_SCHEMA = 'lunacy-codex-exec-policy/v1' as const;
export const CODEX_MODEL = 'gpt-5.6-sol' as const;
export const DELIBERATION_CODEX_MODEL = 'gpt-5.6-luna' as const;
export const CODEX_VERSION = '0.145.0' as const;
export const DEFAULT_REASONING_EFFORT = 'high' as const;
export const MAX_REASONING_EFFORT = 'max' as const;
export const DELIBERATION_REASONING_EFFORT = 'max' as const;
export const WORKER_RESULT_SCHEMA = 'lunacy-codex-worker-result-v1' as const;

export const MAX_REASON_CODES = Object.freeze([
  'REPLAY_FINALITY_HIGH_RISK',
  'ARCHITECTURE_AMBIGUITY',
  'FAILED_XHIGH_REPAIR',
  'EXPLICIT_PROJECT_AUTHORITY',
  'LIVE_MAX_OVERRIDE_PROOF',
] as const);
export type MaxReasonCode = (typeof MAX_REASON_CODES)[number];
export type ReasoningEffort = typeof DEFAULT_REASONING_EFFORT | typeof MAX_REASONING_EFFORT;
export type CodexWorkerResult = Readonly<{
  status: 'PASS' | 'NEEDS-DECISION' | 'BLOCKED';
  reportPath: string;
  reportDigest: string;
}>;

const WORKER_STATUSES = new Set(['PASS', 'NEEDS-DECISION', 'BLOCKED']);

/** Parse the provider's closed worker-result object without accepting
 * duplicate-key ambiguity. Property order is intentionally independent at
 * this boundary; all fields are validated exactly before use. */
export function parseWorkerResultText(text: string): CodexWorkerResult | undefined {
  let index = 0;
  const skipWhitespace = (): void => { while (/\s/.test(text[index] ?? '')) index += 1; };
  const scanString = (): number => {
    if (text[index] !== '"') return -1;
    index += 1;
    while (index < text.length) {
      const char = text[index]!;
      if (char === '\\') { index += 2; continue; }
      if (char === '"') return index + 1;
      index += 1;
    }
    return -1;
  };
  skipWhitespace();
  if (text[index] !== '{') return undefined;
  index += 1;
  const keys = new Set<string>();
  while (index < text.length) {
    skipWhitespace();
    if (text[index] === '}') break;
    const keyStart = index;
    const keyEnd = scanString();
    if (keyEnd < 0) return undefined;
    index = keyEnd;
    let key: unknown;
    try { key = JSON.parse(text.slice(keyStart, keyEnd)); } catch { return undefined; }
    if (typeof key !== 'string' || keys.has(key)) return undefined;
    keys.add(key);
    skipWhitespace();
    if (text[index] !== ':') return undefined;
    index += 1;
    let depth = 0;
    let inString = false;
    while (index < text.length) {
      const char = text[index]!;
      if (inString) {
        if (char === '\\') index += 2;
        else { if (char === '"') inString = false; index += 1; }
        continue;
      }
      if (char === '"') { inString = true; index += 1; continue; }
      if (char === '{' || char === '[') { depth += 1; index += 1; continue; }
      if (char === '}' || char === ']') {
        if (char === '}' && depth === 0) break;
        if (depth > 0) depth -= 1;
        index += 1;
        continue;
      }
      if (char === ',' && depth === 0) break;
      index += 1;
    }
    skipWhitespace();
    if (text[index] === ',') { index += 1; continue; }
    if (text[index] === '}') break;
    return undefined;
  }
  skipWhitespace();
  if (text[index] !== '}') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  if (sortedKeys.join(',') !== 'reportDigest,reportPath,status' || !WORKER_STATUSES.has(String(record.status)) || typeof record.reportPath !== 'string' || record.reportPath.length === 0 || typeof record.reportDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.reportDigest)) return undefined;
  return { status: record.status as CodexWorkerResult['status'], reportPath: record.reportPath, reportDigest: record.reportDigest };
}

export type MaxOverride = Readonly<{
  phaseId: string;
  stepId: string;
  attemptEpoch: number;
  planDigest: string;
  reasonCode: MaxReasonCode;
  decisionRef: string;
}>;

export type CodexHostPolicy = Readonly<{
  schema: typeof CODEX_HOST_POLICY_SCHEMA;
  runId: string;
  planDigest: string;
  runRoot: string;
  workspace: string;
  skillRoot: string;
  instructionPaths: readonly string[];
  codexPath: string;
  codexVersion: typeof CODEX_VERSION;
  codexBinaryDigest: string;
  model: typeof CODEX_MODEL;
  defaultEffort: typeof DEFAULT_REASONING_EFFORT;
  sandbox: 'workspace-write';
  writableRoots: readonly string[];
  environmentNames: readonly string[];
  effectsRoot: string;
  workerSchemaPath: string;
  workerSchemaDigest: string;
  timeoutMs: number;
  cancellationGraceMs: number;
  maxOutputBytes: number;
  maxErrorBytes: number;
  maxReportBytes: number;
  maxSupported: boolean;
  maxOverrides: readonly MaxOverride[];
}>;

export type CodexHostPolicyInput = Readonly<Partial<Omit<CodexHostPolicy, 'schema'>> & {
  schema?: typeof CODEX_HOST_POLICY_SCHEMA;
  runId: string;
  planDigest: string;
  runRoot: string;
  workspace: string;
  skillRoot: string;
  codexPath: string;
  codexBinaryDigest: string;
  workerSchemaPath: string;
  workerSchemaDigest: string;
  instructionPaths?: readonly string[];
  effectsRoot?: string;
  maxOverrides?: readonly MaxOverride[];
}>;

/** Authority-free sibling branch owned by this host-policy module. It is not
 * a fallback from the writable action policy: callers must select it
 * explicitly and provide an isolated scratch root. */
export type CodexDeliberationHostPolicy = Readonly<{
  schema: 'lunacy-codex-deliberation-policy/v1';
  profile: 'deliberation';
  targetWorkspace: string;
  scratchRoot: string;
  evidenceRoot: string;
  readIsolation: 'darwin-seatbelt/v1';
  sandboxExecPath: '/usr/bin/sandbox-exec';
  codexPath: string;
  codexVersion: typeof CODEX_VERSION;
  codexBinaryDigest: string;
  authFilePath: string;
  authFileDigest: string;
  runtimeReadFiles: readonly string[];
  runtimeReadSubpaths: readonly string[];
  workerSchemaPath: string;
  workerSchemaDigest: string;
  model: typeof DELIBERATION_CODEX_MODEL;
  effort: typeof DELIBERATION_REASONING_EFFORT;
  effectDenied: true;
  targetWrite: false;
  network: false;
  fallback: false;
  timeoutMs: number;
  maxOutputBytes: number;
}>;

export type CodexDeliberationHostPolicyInput = Readonly<Partial<Omit<CodexDeliberationHostPolicy, 'schema' | 'profile' | 'model' | 'effort' | 'effectDenied' | 'targetWrite' | 'network' | 'fallback' | 'codexVersion'>> & {
  targetWorkspace: string;
  scratchRoot: string;
  evidenceRoot: string;
  codexPath: string;
  codexBinaryDigest: string;
  authFilePath: string;
  authFileDigest: string;
  runtimeReadFiles?: readonly string[];
  runtimeReadSubpaths?: readonly string[];
  workerSchemaPath: string;
  workerSchemaDigest: string;
}>;

export type CodexCommandFrame = Readonly<Pick<OutboxCommand, 'commandId' | 'runId' | 'phaseId' | 'stepId' | 'attemptEpoch' | 'authorityEpoch' | 'barrierEpoch' | 'modeEpoch' | 'launchToken' | 'commandDigest'> & {
  /** The plan digest is supplied by the composition root, never inferred from Markdown. */
  planDigest: string;
}>;

const SAFE_ENVIRONMENT_NAMES = new Set([
  'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP',
  'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'OPENAI_API_KEY', 'CODEX_AUTH_TOKEN', 'CHATGPT_API_KEY',
]);
const FORBIDDEN_ARGUMENTS = new Set([
  '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--ignore-rules',
]);

function fail(message: string): never { throw new Error(`CodexHostPolicy: ${message}`); }
function asDigest(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}
function asPath(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value) || resolve(value) !== value) fail(`${label} must be an absolute canonical path`);
  return value;
}
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function asId(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value) || value === '.' || value === '..' || value === '__proto__' || value === 'prototype' || value === 'constructor') fail(`${label} is invalid`);
  return value;
}
function asNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
  return value;
}
function asPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`);
  return value;
}

export function createCodexDeliberationHostPolicy(input: CodexDeliberationHostPolicyInput): CodexDeliberationHostPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('deliberation policy input is required');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) fail('deliberation policy input must be a plain object');
  const allowed = new Set(['schema', 'profile', 'targetWorkspace', 'scratchRoot', 'evidenceRoot', 'readIsolation', 'sandboxExecPath', 'codexPath', 'codexVersion', 'codexBinaryDigest', 'authFilePath', 'authFileDigest', 'runtimeReadFiles', 'runtimeReadSubpaths', 'workerSchemaPath', 'workerSchemaDigest', 'model', 'effort', 'effectDenied', 'targetWrite', 'network', 'fallback', 'timeoutMs', 'maxOutputBytes']);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail('deliberation policy fields are not closed');
  const supplied = input as unknown as Partial<CodexDeliberationHostPolicy>;
  if (supplied.schema !== undefined && supplied.schema !== 'lunacy-codex-deliberation-policy/v1' || supplied.profile !== undefined && supplied.profile !== 'deliberation' || supplied.codexVersion !== undefined && supplied.codexVersion !== CODEX_VERSION || supplied.model !== undefined && supplied.model !== DELIBERATION_CODEX_MODEL || supplied.effort !== undefined && supplied.effort !== DELIBERATION_REASONING_EFFORT || supplied.effectDenied !== undefined && supplied.effectDenied !== true || supplied.targetWrite !== undefined && supplied.targetWrite !== false || supplied.network !== undefined && supplied.network !== false || supplied.fallback !== undefined && supplied.fallback !== false || supplied.readIsolation !== undefined && supplied.readIsolation !== 'darwin-seatbelt/v1' || supplied.sandboxExecPath !== undefined && supplied.sandboxExecPath !== '/usr/bin/sandbox-exec') fail('deliberation policy profile is invalid');
  const targetWorkspace = asPath(input.targetWorkspace, 'targetWorkspace');
  const scratchRoot = asPath(input.scratchRoot, 'scratchRoot');
  const evidenceRoot = asPath(input.evidenceRoot, 'evidenceRoot');
  if (within(targetWorkspace, scratchRoot) || within(scratchRoot, targetWorkspace) || within(targetWorkspace, evidenceRoot) || within(evidenceRoot, targetWorkspace) || within(scratchRoot, evidenceRoot) || within(evidenceRoot, scratchRoot)) fail('deliberation scratch/evidence roots must be mutually isolated from targetWorkspace');
  const codexPath = asPath(input.codexPath, 'codexPath'); const workerSchemaPath = asPath(input.workerSchemaPath, 'workerSchemaPath');
  const authFilePath = asPath(input.authFilePath, 'authFilePath');
  if (dirname(authFilePath) === authFilePath || authFilePath.slice(authFilePath.lastIndexOf(sep) + 1) !== 'auth.json') fail('deliberation auth file must be a dedicated auth.json');
  const runtimeReadFiles = Object.freeze([...(input.runtimeReadFiles ?? [])].map((path, index) => asPath(path, `runtimeReadFiles[${index}]`)));
  const runtimeReadSubpaths = Object.freeze([...(input.runtimeReadSubpaths ?? [])].map((path, index) => asPath(path, `runtimeReadSubpaths[${index}]`)));
  if (new Set(runtimeReadFiles).size !== runtimeReadFiles.length) fail('runtimeReadFiles must be unique');
  if (new Set(runtimeReadSubpaths).size !== runtimeReadSubpaths.length) fail('runtimeReadSubpaths must be unique');
  if ([...runtimeReadFiles, ...runtimeReadSubpaths].some((path) => !within('/opt/homebrew', path) && !within('/usr/local', path))) fail('runtime read inputs must be inside a sealed native runtime prefix');
  if (runtimeReadSubpaths.some((path) => {
    const base = within('/opt/homebrew', path) ? '/opt/homebrew' : '/usr/local';
    return relative(base, path).split(sep).filter(Boolean).length < 3;
  })) fail('runtimeReadSubpaths must name a narrow versioned runtime subtree');
  if ([targetWorkspace, scratchRoot, evidenceRoot].some((root) => [codexPath, workerSchemaPath, authFilePath, ...runtimeReadFiles, ...runtimeReadSubpaths].some((path) => within(root, path) || within(path, root)))) fail('deliberation runtime/auth inputs must be outside protected roots');
  return Object.freeze({
    schema: 'lunacy-codex-deliberation-policy/v1', profile: 'deliberation',
    targetWorkspace, scratchRoot, evidenceRoot, readIsolation: 'darwin-seatbelt/v1', sandboxExecPath: '/usr/bin/sandbox-exec',
    codexPath, codexVersion: CODEX_VERSION,
    codexBinaryDigest: asDigest(input.codexBinaryDigest, 'codexBinaryDigest'),
    authFilePath,
    authFileDigest: asDigest(input.authFileDigest, 'authFileDigest'),
    runtimeReadFiles,
    runtimeReadSubpaths,
    workerSchemaPath,
    workerSchemaDigest: asDigest(input.workerSchemaDigest, 'workerSchemaDigest'),
    model: DELIBERATION_CODEX_MODEL, effort: DELIBERATION_REASONING_EFFORT,
    effectDenied: true, targetWrite: false, network: false, fallback: false,
    timeoutMs: asPositiveInteger(input.timeoutMs ?? 60_000, 'timeoutMs'),
    maxOutputBytes: asPositiveInteger(input.maxOutputBytes ?? 512 * 1024, 'maxOutputBytes'),
  });
}

export function validateCodexDeliberationHostPolicy(policy: CodexDeliberationHostPolicy): CodexDeliberationHostPolicy {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('deliberation policy is malformed');
  const expected = ['authFileDigest', 'authFilePath', 'codexBinaryDigest', 'codexPath', 'codexVersion', 'effectDenied', 'effort', 'evidenceRoot', 'fallback', 'maxOutputBytes', 'model', 'network', 'profile', 'readIsolation', 'runtimeReadFiles', 'runtimeReadSubpaths', 'sandboxExecPath', 'schema', 'scratchRoot', 'targetWorkspace', 'targetWrite', 'timeoutMs', 'workerSchemaDigest', 'workerSchemaPath'].sort();
  const keys = Object.keys(policy).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail('deliberation policy fields are not closed');
  if (policy.schema !== 'lunacy-codex-deliberation-policy/v1' || policy.profile !== 'deliberation' || policy.codexVersion !== CODEX_VERSION || policy.model !== DELIBERATION_CODEX_MODEL || policy.effort !== DELIBERATION_REASONING_EFFORT || policy.effectDenied !== true || policy.targetWrite !== false || policy.network !== false || policy.fallback !== false || policy.readIsolation !== 'darwin-seatbelt/v1' || policy.sandboxExecPath !== '/usr/bin/sandbox-exec') fail('deliberation policy profile is invalid');
  return createCodexDeliberationHostPolicy(policy);
}

/** Build the sole managed-deliberation provider argv. The target workspace is
 * intentionally absent: the provider receives only a sealed role view on
 * stdin, writes only its isolated output file, and has network disabled. */
export function buildCodexDeliberationArguments(policy: CodexDeliberationHostPolicy, outputPath: string): string[] {
  const checked = validateCodexDeliberationHostPolicy(policy);
  const output = asPath(outputPath, 'deliberation outputPath');
  if (!within(checked.scratchRoot, output) || output === checked.scratchRoot) fail('deliberation outputPath must be under scratchRoot');
  const attemptRoot = dirname(output);
  if (attemptRoot === checked.scratchRoot) fail('deliberation outputPath must be under a private attempt root');
  const args = [
    'exec', '-', '--model', DELIBERATION_CODEX_MODEL, '--sandbox', 'workspace-write', '--json',
    '--output-schema', checked.workerSchemaPath, '--output-last-message', output,
    '--ephemeral', '--ignore-user-config', '--strict-config', '--cd', attemptRoot,
    '--skip-git-repo-check',
    '--config', 'approval_policy="never"', '--config', `model_reasoning_effort="${DELIBERATION_REASONING_EFFORT}"`,
    '--config', 'sandbox_workspace_write.network_access=false',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'code_mode_host',
    '--disable', 'apps', '--disable', 'browser_use', '--disable', 'browser_use_external',
    '--disable', 'browser_use_full_cdp_access', '--disable', 'computer_use', '--disable', 'in_app_browser',
    '--disable', 'image_generation', '--disable', 'plugins', '--disable', 'remote_plugin',
    '--disable', 'skill_search', '--disable', 'workspace_dependencies', '--disable', 'tool_suggest',
    '--disable', 'goals', '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
    '--disable', 'hooks', '--disable', 'standalone_web_search',
  ];
  if (args.includes('--add-dir') || args.includes(checked.targetWorkspace) || args.some((arg) => FORBIDDEN_ARGUMENTS.has(arg) || arg === 'danger-full-access')) fail('deliberation invocation escaped its effect-denied profile');
  return Object.freeze(args) as unknown as string[];
}

function seatbeltLiteral(path: string): string { return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }

function seatbeltAncestors(paths: readonly string[]): string[] {
  const ancestors = new Set<string>();
  for (const path of paths) {
    let current = dirname(path);
    while (current !== dirname(current)) { ancestors.add(current); current = dirname(current); }
  }
  return [...ancestors].sort();
}

function runtimeSymlinkInputs(paths: readonly string[]): string[] {
  const links = new Set<string>();
  for (const path of paths) {
    const parts = path.split(sep).filter(Boolean); let current: string = sep;
    for (const part of parts) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) links.add(current); }
      catch { /* policy validation/attestation reports missing runtime inputs */ }
    }
  }
  return [...links].sort();
}

/** Deny-default native capability for the attested Codex image. Model
 * transport is limited to one exact host-owned loopback adapter; generated subprocesses,
 * tools, non-transport IPC, ambient credentials, and every non-enumerated
 * filesystem input remain denied. The credential capsule is not part of the
 * model-visible attempt. */
export function buildCodexDeliberationIsolationProfile(policy: CodexDeliberationHostPolicy, attemptRoot: string, transportPort = 1): string {
  const checked = validateCodexDeliberationHostPolicy(policy);
  const attempt = asPath(attemptRoot, 'deliberation attemptRoot');
  if (!within(checked.scratchRoot, attempt) || attempt === checked.scratchRoot) fail('deliberation attemptRoot must be private scratch');
  if (!Number.isSafeInteger(transportPort) || transportPort < 1 || transportPort > 65_535) fail('deliberation transport port is invalid');
  const authHome = `${attempt}.codex-home`;
  const timezone = realpathSync('/private/etc/localtime');
  const runtimePhysicalFiles = checked.runtimeReadFiles.map((path) => realpathSync(path));
  const runtimeLinks = runtimeSymlinkInputs(checked.runtimeReadFiles);
  const exactReads = [...new Set(['/usr/bin/true', '/etc/ssl/cert.pem', '/private/etc/ssl/cert.pem', '/private/etc/localtime', timezone, checked.codexPath, checked.workerSchemaPath, ...checked.runtimeReadFiles, ...runtimePhysicalFiles, ...runtimeLinks])];
  const metadata = [...new Set([...seatbeltAncestors([...exactReads, attempt, authHome]), '/tmp', '/var'])].sort();
  const exactFilters = exactReads.map((path) => `(literal ${seatbeltLiteral(path)})`).join(' ');
  const metadataFilters = metadata.map((path) => `(literal ${seatbeltLiteral(path)})`).join(' ');
  const executableFilters = [...new Set([checked.codexPath, '/usr/bin/true', ...checked.runtimeReadFiles, ...runtimePhysicalFiles])].map((path) => `(literal ${seatbeltLiteral(path)})`).join(' ');
  const runtimeSubpathFilters = checked.runtimeReadSubpaths.map((path) => `(subpath ${seatbeltLiteral(path)}) (subpath ${seatbeltLiteral(realpathSync(path))})`).join(' ');
  return `(version 1)\n(deny default)\n(allow sysctl-read)\n(import "dyld-support.sb")\n(allow process-exec)\n(allow network-outbound (remote tcp "localhost:${transportPort}"))\n(allow file-map-executable ${executableFilters} ${runtimeSubpathFilters})\n(allow file-read* ${exactFilters} ${runtimeSubpathFilters} (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))\n(allow file-read* file-write* (subpath ${seatbeltLiteral(attempt)}) (subpath ${seatbeltLiteral(authHome)}))\n(allow file-read-metadata ${metadataFilters})`;
}

/** Construct and validate a closed policy.  The returned object is frozen so
 * argv/effect evidence cannot drift after the driver has been composed. */
export function createCodexHostPolicy(input: CodexHostPolicyInput): CodexHostPolicy {
  if (!input || typeof input !== 'object') fail('policy input is required');
  const inputPrototype = Object.getPrototypeOf(input);
  if (inputPrototype !== Object.prototype && inputPrototype !== null) fail('policy input must be a plain object');
  const allowedInputKeys = new Set(['schema', 'runId', 'planDigest', 'runRoot', 'workspace', 'skillRoot', 'instructionPaths', 'codexPath', 'codexVersion', 'codexBinaryDigest', 'model', 'defaultEffort', 'sandbox', 'writableRoots', 'environmentNames', 'effectsRoot', 'workerSchemaPath', 'workerSchemaDigest', 'timeoutMs', 'cancellationGraceMs', 'maxOutputBytes', 'maxErrorBytes', 'maxReportBytes', 'maxSupported', 'maxOverrides']);
  if (Object.keys(input).some((key) => !allowedInputKeys.has(key))) fail('policy input fields are not closed');
  if (input.schema !== undefined && input.schema !== CODEX_HOST_POLICY_SCHEMA) fail('policy schema is invalid');
  if (input.codexVersion !== undefined && input.codexVersion !== CODEX_VERSION) fail('codexVersion is not attested');
  if (input.model !== undefined && input.model !== CODEX_MODEL) fail('model must be gpt-5.6-sol');
  if (input.defaultEffort !== undefined && input.defaultEffort !== DEFAULT_REASONING_EFFORT) fail('defaultEffort must be high');
  if (input.sandbox !== undefined && input.sandbox !== 'workspace-write') fail('sandbox must be workspace-write');
  if (input.maxSupported !== undefined && typeof input.maxSupported !== 'boolean') fail('maxSupported must be boolean');
  const runId = asId(input.runId, 'runId');
  const planDigest = asDigest(input.planDigest, 'planDigest');
  const runRoot = asPath(input.runRoot, 'runRoot');
  const workspace = asPath(input.workspace, 'workspace');
  const skillRoot = asPath(input.skillRoot, 'skillRoot');
  const codexPath = asPath(input.codexPath, 'codexPath');
  const codexBinaryDigest = asDigest(input.codexBinaryDigest, 'codexBinaryDigest');
  const workerSchemaPath = asPath(input.workerSchemaPath, 'workerSchemaPath');
  const workerSchemaDigest = asDigest(input.workerSchemaDigest, 'workerSchemaDigest');
  const effectsRoot = asPath(input.effectsRoot ?? join(runRoot, '.codex-effects'), 'effectsRoot');
  if (!within(runRoot, effectsRoot)) fail('effectsRoot must be under runRoot');
  // Ordinary workers receive only parent-sealed authority documents.  Raw
  // managed research stays in durable recovery/provenance storage and cannot
  // be promoted into worker authority merely by adding its pathname here.
  // PLAN.md is added again by commandAuthorityPaths; DECISIONS.md remains the
  // sole optional companion for compact accepted proof/risks and constraints.
  const rawInstructionPaths = input.instructionPaths ?? [join(runRoot, 'PLAN.md'), join(runRoot, 'DECISIONS.md')];
  if (!Array.isArray(rawInstructionPaths)) fail('instructionPaths must be an array');
  const sealedInstructionPaths = new Set([join(runRoot, 'PLAN.md'), join(runRoot, 'DECISIONS.md')]);
  const instructionPaths = Object.freeze([...new Set(rawInstructionPaths)]
    .map((path, index) => asPath(path, `instructionPaths[${index}]`))
    .filter((path) => sealedInstructionPaths.has(path)));
  const rawWritableRoots = input.writableRoots ?? [workspace, runRoot];
  if (!Array.isArray(rawWritableRoots)) fail('writableRoots must be an array');
  const writableRoots = Object.freeze([...new Set(rawWritableRoots)].map((path, index) => {
    const normalized = asPath(path, `writableRoots[${index}]`);
    if (!within(workspace, normalized) && !within(runRoot, normalized)) fail(`writableRoots[${index}] must be under workspace or runRoot`);
    return normalized;
  }));
  const rawEnvironmentNames = input.environmentNames ?? ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'];
  if (!Array.isArray(rawEnvironmentNames)) fail('environmentNames must be an array');
  const environmentNames = Object.freeze([...new Set(rawEnvironmentNames)].map((name, index) => {
    if (!SAFE_ENVIRONMENT_NAMES.has(name)) fail(`environmentNames[${index}] is not allowlisted`);
    return name;
  }).sort());
  const rawMaxOverrides = input.maxOverrides ?? [];
  if (!Array.isArray(rawMaxOverrides)) fail('maxOverrides must be an array');
  const maxOverrides = Object.freeze([...rawMaxOverrides].map((raw, index) => {
    if (!raw || typeof raw !== 'object') fail(`maxOverrides[${index}] is malformed`);
    const maxKeys = Object.keys(raw).sort();
    if (maxKeys.join(',') !== 'attemptEpoch,decisionRef,phaseId,planDigest,reasonCode,stepId') fail(`maxOverrides[${index}] fields are not closed`);
    const value = {
      phaseId: asId(raw.phaseId, `maxOverrides[${index}].phaseId`),
      stepId: asId(raw.stepId, `maxOverrides[${index}].stepId`),
      attemptEpoch: asNonNegativeInteger(raw.attemptEpoch, `maxOverrides[${index}].attemptEpoch`),
      planDigest: asDigest(raw.planDigest, `maxOverrides[${index}].planDigest`),
      reasonCode: raw.reasonCode,
      decisionRef: raw.decisionRef,
    } satisfies MaxOverride;
    if (!MAX_REASON_CODES.includes(value.reasonCode)) fail(`maxOverrides[${index}].reasonCode is not accepted`);
    if (value.planDigest !== planDigest) fail(`maxOverrides[${index}] planDigest does not match policy`);
    if (typeof value.decisionRef !== 'string' || value.decisionRef.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value.decisionRef)) fail(`maxOverrides[${index}].decisionRef is invalid`);
    return Object.freeze(value);
  }).sort((left, right) => (left.phaseId < right.phaseId ? -1 : left.phaseId > right.phaseId ? 1 : left.stepId < right.stepId ? -1 : left.stepId > right.stepId ? 1 : left.attemptEpoch - right.attemptEpoch)));
  const overrideKeys = new Set<string>();
  for (const override of maxOverrides) {
    const key = `${override.phaseId}\0${override.stepId}\0${override.attemptEpoch}`;
    if (overrideKeys.has(key)) fail(`maxOverrides contains a duplicate command frame for ${override.phaseId}/${override.stepId}/${override.attemptEpoch}`);
    overrideKeys.add(key);
  }
  const policy: CodexHostPolicy = Object.freeze({
    schema: CODEX_HOST_POLICY_SCHEMA,
    runId, planDigest, runRoot, workspace, skillRoot, instructionPaths,
    codexPath, codexVersion: CODEX_VERSION, codexBinaryDigest,
    model: CODEX_MODEL, defaultEffort: DEFAULT_REASONING_EFFORT, sandbox: 'workspace-write',
    writableRoots, environmentNames, effectsRoot, workerSchemaPath, workerSchemaDigest,
    timeoutMs: asPositiveInteger(input.timeoutMs ?? 60_000, 'timeoutMs'),
    cancellationGraceMs: asNonNegativeInteger(input.cancellationGraceMs ?? 750, 'cancellationGraceMs'),
    maxOutputBytes: asPositiveInteger(input.maxOutputBytes ?? 512 * 1024, 'maxOutputBytes'),
    maxErrorBytes: asPositiveInteger(input.maxErrorBytes ?? 256 * 1024, 'maxErrorBytes'),
    maxReportBytes: asPositiveInteger(input.maxReportBytes ?? 512 * 1024, 'maxReportBytes'),
    maxSupported: input.maxSupported === true,
    maxOverrides,
  });
  return policy;
}

export function validateCodexHostPolicy(policy: CodexHostPolicy): CodexHostPolicy {
  // Reconstructing through the closed constructor rejects extra/malformed
  // fields while preserving the exact canonical values used for its digest.
  if (!policy || typeof policy !== 'object') fail('policy is malformed');
  const policyPrototype = Object.getPrototypeOf(policy);
  if (policyPrototype !== Object.prototype && policyPrototype !== null) fail('policy must be a plain object');
  const keys = Object.keys(policy).sort();
  const expected = ['codexBinaryDigest', 'codexPath', 'codexVersion', 'cancellationGraceMs', 'defaultEffort', 'effectsRoot', 'environmentNames', 'instructionPaths', 'maxErrorBytes', 'maxOutputBytes', 'maxOverrides', 'maxReportBytes', 'maxSupported', 'model', 'planDigest', 'runId', 'runRoot', 'sandbox', 'schema', 'skillRoot', 'timeoutMs', 'workerSchemaDigest', 'workerSchemaPath', 'workspace', 'writableRoots'].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail('policy fields are not closed');
  return createCodexHostPolicy(policy);
}

export function codexHostPolicyDigest(policy: CodexHostPolicy): Sha256 {
  return digest(validateCodexHostPolicy(policy)) as Sha256;
}

export function commandFrameDigest(command: Pick<OutboxCommand, 'commandId' | 'runId' | 'phaseId' | 'stepId' | 'attemptEpoch' | 'launchToken'>): string {
  return digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken });
}

function matchingOverride(policy: CodexHostPolicy, command: CodexCommandFrame): MaxOverride | undefined {
  return policy.maxOverrides.find((override) => override.phaseId === command.phaseId && override.stepId === command.stepId && override.attemptEpoch === command.attemptEpoch && override.planDigest === policy.planDigest);
}

function assertCommandAuthority(policy: CodexHostPolicy, command: Pick<CodexCommandFrame, 'runId' | 'planDigest'>): void {
  if (command.runId !== policy.runId || command.planDigest !== policy.planDigest) fail('command frame is outside policy authority');
}

/** Resolve effort without fallback.  An exact override is required for max;
 * a rejected max capability is surfaced as an error rather than downgraded. */
export function reasoningEffortFor(policy: CodexHostPolicy, command: CodexCommandFrame): ReasoningEffort {
  validateCodexHostPolicy(policy);
  assertCommandAuthority(policy, command);
  if (typeof command.launchToken !== 'string' || command.launchToken.length === 0) fail('launchToken is invalid');
  const override = matchingOverride(policy, command);
  if (!override) return DEFAULT_REASONING_EFFORT;
  if (!policy.maxSupported) fail(`max is unsupported for ${override.phaseId}/${override.stepId}/${override.attemptEpoch}`);
  return MAX_REASONING_EFFORT;
}

export function expectedReportPath(policy: CodexHostPolicy, command: Pick<CodexCommandFrame, 'phaseId' | 'stepId' | 'attemptEpoch'>): string {
  const phaseId = asId(command.phaseId, 'phaseId');
  const stepId = asId(command.stepId, 'stepId');
  const attempt = asNonNegativeInteger(command.attemptEpoch, 'attemptEpoch');
  return join(policy.runRoot, 'phases', phaseId, 'reports', `${stepId}-worker-${attempt}.md`);
}

/** Resolve the phase-owned instruction selected by a command.  This path is
 * intentionally derived from the command frame rather than from a caller
 * supplied policy list: the worker must read and the host must attest the
 * exact STEPS.md for the phase it is executing. */
export function expectedStepsPath(policy: CodexHostPolicy, command: Pick<CodexCommandFrame, 'runId' | 'planDigest' | 'phaseId'>): string {
  validateCodexHostPolicy(policy);
  assertCommandAuthority(policy, command);
  return join(policy.runRoot, 'phases', asId(command.phaseId, 'phaseId'), 'STEPS.md');
}

/**
 * Return the deterministic private namespace used for one launch's immutable
 * authority snapshot.  The token is hashed before it reaches a pathname, just
 * as effect records do, so an opaque launch token cannot escape its slot.
 * Keeping this derivation in the host-policy module lets the live and restart
 * binding paths reconstruct the exact same handoff/argv witnesses without
 * persisting another mutable path list in the launch record.
 */
export function launchAuthoritySnapshotRoot(policy: CodexHostPolicy, command: Pick<CodexCommandFrame, 'runId' | 'planDigest' | 'launchToken'>): string {
  validateCodexHostPolicy(policy);
  assertCommandAuthority(policy, command);
  if (typeof command.launchToken !== 'string' || command.launchToken.length === 0 || command.launchToken.includes('\0')) fail('launchToken is invalid');
  const tokenNamespace = createHash('sha256').update(command.launchToken).digest('hex');
  return join(policy.effectsRoot, tokenNamespace, 'authority');
}

/** Map one original authority path to its deterministic snapshot spelling. */
export function launchAuthoritySnapshotPath(policy: CodexHostPolicy, command: CodexCommandFrame, originalPath: string): string {
  const root = launchAuthoritySnapshotRoot(policy, command);
  const path = asPath(originalPath, 'authority path');
  if (within(policy.runRoot, path)) return join(root, 'run', relative(policy.runRoot, path));
  if (within(policy.skillRoot, path)) return join(root, 'skill', relative(policy.skillRoot, path));
  // Instruction/schema paths outside the run and skill trees remain distinct
  // without interpolating arbitrary path bytes into the snapshot name.
  return join(root, 'external', createHash('sha256').update(path).digest('hex'));
}

/**
 * Build the complete deterministic original→snapshot map used by a launch.
 * `descriptorRoot` is only needed by Linux child-entry code, where the
 * snapshot lives under a run-root directory descriptor (`/proc/self/fd/N`).
 * Restart binding omits it and therefore uses the durable pathname spelling.
 */
export function launchAuthoritySnapshotPaths(policy: CodexHostPolicy, command: CodexCommandFrame, descriptorRoot?: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const snapshotRoot = launchAuthoritySnapshotRoot(policy, command);
  for (const original of commandAuthorityPaths(policy, command)) {
    let snapshot = launchAuthoritySnapshotPath(policy, command, original);
    if (descriptorRoot !== undefined) {
      const relativeSnapshot = relative(policy.runRoot, snapshotRoot);
      if (within(policy.runRoot, snapshotRoot)) snapshot = join(descriptorRoot, relativeSnapshot, snapshot.slice(snapshotRoot.length + 1));
    }
    map.set(original, snapshot);
  }
  return map;
}

/**
 * Bind each command-selected authority file to a fixed child descriptor slot.
 * The supervisor opens the corresponding sealed snapshot before spawn and
 * passes it at these slots; unlike a snapshot pathname, `/proc/self/fd/N`
 * cannot be redirected by a concurrent rename or same-user rewrite.
 */
export function launchAuthorityDescriptorPaths(policy: CodexHostPolicy, command: CodexCommandFrame, firstDescriptor = 6): ReadonlyMap<string, string> {
  if (!Number.isSafeInteger(firstDescriptor) || firstDescriptor < 3) fail('authority descriptor slot is invalid');
  const map = new Map<string, string>();
  commandAuthorityPaths(policy, command).forEach((path, index) => map.set(path, `/proc/self/fd/${firstDescriptor + index}`));
  return map;
}

/**
 * Bind a policy-owned directory path to the descriptor spelling used by the
 * child.  Linux launches inherit trusted workspace/run-root descriptors, so
 * `--cd` and every `--add-dir` must resolve through those descriptors rather
 * than performing a second pathname lookup in the child.  Other platforms
 * leave the canonical path unchanged; the supervisor freezes those roots for
 * the synchronous spawn boundary instead.
 */
export function launchDirectoryPath(policy: CodexHostPolicy, originalPath: string, workspaceDescriptor?: string, runRootDescriptor?: string): string {
  const path = asPath(originalPath, 'launch directory path');
  const inWorkspace = workspaceDescriptor !== undefined && within(policy.workspace, path);
  const inRunRoot = runRootDescriptor !== undefined && within(policy.runRoot, path);
  // When policy roots overlap, bind through the deepest matching root.  This
  // keeps a run-root descendant from becoming a second pathname lookup under
  // a broader workspace descriptor (and vice versa).
  if (inWorkspace && (!inRunRoot || policy.workspace.length >= policy.runRoot.length)) return join(workspaceDescriptor!, relative(policy.workspace, path));
  if (inRunRoot) return join(runRootDescriptor!, relative(policy.runRoot, path));
  return path;
}

/** Return writable roots with the same descriptor binding as `--cd`. */
export function launchWritableRoots(policy: CodexHostPolicy, workspaceDescriptor?: string, runRootDescriptor?: string): readonly string[] {
  return Object.freeze(policy.writableRoots.map((path) => launchDirectoryPath(policy, path, workspaceDescriptor, runRootDescriptor)));
}

export type CodexLaunchPathOverrides = Readonly<{
  authorityPaths?: ReadonlyMap<string, string>;
  outputPath?: string;
  workerSchemaPath?: string;
  workspacePath?: string;
  writableRoots?: readonly string[];
}>;

/** Return the complete command-specific authority file set.  The dynamic
 * phase STEPS path is always present, even when a policy's static instruction
 * list omits it or contains a different phase's STEPS file. */
export function commandAuthorityPaths(policy: CodexHostPolicy, command: CodexCommandFrame): readonly string[] {
  validateCodexHostPolicy(policy);
  assertCommandAuthority(policy, command);
  const dynamicSteps = expectedStepsPath(policy, command);
  return Object.freeze([
    ...new Set([
      join(policy.runRoot, 'PLAN.md'),
      ...policy.instructionPaths,
      dynamicSteps,
      join(policy.skillRoot, 'worker', 'ENGINEERING.md'),
      policy.workerSchemaPath,
    ]),
  ]);
}

export function buildWorkerHandoff(policy: CodexHostPolicy, command: CodexCommandFrame, overrides: CodexLaunchPathOverrides = {}): { text: string; reportPath: string; digest: Sha256 } {
  validateCodexHostPolicy(policy);
  assertCommandAuthority(policy, command);
  const reportPath = expectedReportPath(policy, command);
  const authorityPath = (path: string): string => overrides.authorityPaths?.get(path) ?? path;
  const dynamicSteps = authorityPath(expectedStepsPath(policy, command));
  const authority = [authorityPath(join(policy.runRoot, 'PLAN.md')), ...policy.instructionPaths.map(authorityPath), dynamicSteps].filter((path, index, all) => all.indexOf(path) === index);
  const engineering = authorityPath(join(policy.skillRoot, 'worker', 'ENGINEERING.md'));
  const text = [
    `Own ${asId(command.stepId, 'stepId')} end-to-end.`,
    `Authority: ${authority.join(' + ')}.`,
    `Engineering: ${engineering}.`,
    `Step: ${dynamicSteps} (${asId(command.stepId, 'stepId')} row).`,
    `Report: ${reportPath}.`,
    'Inspect/reuse first; implement → verify → self-review → fix → terminal reverify.',
    'If active ownership or material durable scope would be exceeded, stop before the edit.',
    'Mailbox only BLOCKED / DECISION_REQUIRED / FINAL.',
    'Final structured result: emit exactly one canonical JSON object with keys in sorted order reportDigest, reportPath, status; include no prose.',
  ].join('\n');
  return { text: `${text}\n`, reportPath, digest: digest(`${text}\n`) as Sha256 };
}

export function buildCodexArguments(policy: CodexHostPolicy, command: CodexCommandFrame, effort: ReasoningEffort, outputPath: string, overrides: CodexLaunchPathOverrides = {}): string[] {
  validateCodexHostPolicy(policy);
  assertCommandAuthority(policy, command);
  if (!isAbsolute(outputPath) || resolve(outputPath) !== outputPath) fail('outputPath must be absolute canonical');
  if (!within(policy.effectsRoot, outputPath) || outputPath === policy.effectsRoot) fail('outputPath must be under effectsRoot');
  const launchOutputPath = overrides.outputPath ?? outputPath;
  if (!isAbsolute(launchOutputPath) || resolve(launchOutputPath) !== launchOutputPath) fail('launch outputPath must be absolute canonical');
  if (effort !== DEFAULT_REASONING_EFFORT && effort !== MAX_REASONING_EFFORT) fail('reasoning effort is unsupported');
  if (effort === MAX_REASONING_EFFORT && reasoningEffortFor(policy, command) !== MAX_REASONING_EFFORT) fail('max requires an exact durable override');
  const args = [
    'exec', '-', '--model', CODEX_MODEL, '--sandbox', 'workspace-write', '--json',
    '--output-schema', overrides.workerSchemaPath ?? policy.workerSchemaPath, '--output-last-message', launchOutputPath,
    '--ephemeral', '--ignore-user-config', '--strict-config', '--cd', overrides.workspacePath ?? policy.workspace,
    ...(overrides.writableRoots ?? policy.writableRoots).flatMap((root) => ['--add-dir', root]),
    '--config', 'approval_policy="never"', '--config', `model_reasoning_effort="${effort}"`,
  ];
  if (args.some((arg) => FORBIDDEN_ARGUMENTS.has(arg) || arg === 'danger-full-access')) fail('invocation contains a forbidden capability');
  return args;
}

export function childEnvironment(policy: CodexHostPolicy, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  validateCodexHostPolicy(policy);
  const env: NodeJS.ProcessEnv = {};
  for (const name of policy.environmentNames) if (Object.prototype.hasOwnProperty.call(source, name)) env[name] = source[name];
  env.NO_COLOR = '1';
  return env;
}

export type CodexBinaryAttestation = Readonly<{
  requestedPath: string;
  physicalPath: string;
  requestedPathIsSymlink: boolean;
  uid: number;
  gid: number;
  mode: string;
  digest: string;
  version: string;
}>;

export type CodexDeliberationHostAttestation = Readonly<{
  policyDigest: string;
  executable: CodexBinaryAttestation;
  authFile: Readonly<{ path: string; dev: number; ino: number; uid: number; gid: number; mode: number; digest: string }>;
  runtimeReadFiles: ReadonlyArray<Readonly<{ requestedPath: string; physicalPath: string; requestedPathIsSymlink: boolean; requestedDev: number; requestedIno: number; requestedMode: number; dev: number; ino: number; uid: number; gid: number; mode: number; digest: string }>>;
  runtimeReadSubpaths: ReadonlyArray<Readonly<{ requestedPath: string; physicalPath: string; requestedPathIsSymlink: boolean; requestedDev: number; requestedIno: number; requestedMode: number; dev: number; ino: number; uid: number; gid: number; mode: number }>>;
  runtimeReadLinks: ReadonlyArray<Readonly<{ path: string; dev: number; ino: number; uid: number; gid: number; mode: number; target: string; digest: string }>>;
  workerSchema: Readonly<{ path: string; dev: number; ino: number; uid: number; gid: number; mode: number; digest: string }>;
  targetWorkspace: Readonly<{ path: string; dev: number; ino: number; uid: number; gid: number; mode: number }>;
  scratchRoot: Readonly<{ path: string; dev: number; ino: number; uid: number; gid: number; mode: number }>;
  evidenceRoot: Readonly<{ path: string; dev: number; ino: number; uid: number; gid: number; mode: number }>;
  readIsolation: Readonly<{
    schema: 'darwin-seatbelt/v1';
    executable: Readonly<{ path: string; dev: number; ino: number; uid: number; gid: number; mode: number; digest: string }>;
    probeExecutable: Readonly<{ path: '/usr/bin/true'; dev: number; ino: number; uid: number; gid: number; mode: number; digest: string }>;
    runtimeSupport: Readonly<{ path: string; dev: number; ino: number; uid: number; gid: number; mode: number; digest: string }>;
    tlsRoots: Readonly<{ path: string; dev: number; ino: number; uid: number; gid: number; mode: number; digest: string }>;
    timezone: Readonly<{ requestedPath: '/private/etc/localtime'; physicalPath: string; dev: number; ino: number; uid: number; gid: number; mode: number; digest: string }>;
    profileTemplateDigest: string;
    probe: 'PASS';
  }>;
  modelTransport: Readonly<{
    schema: 'lunacy-codex-model-transport-policy/v1';
    destinations: readonly ['chatgpt.com:443'];
    maxConnections: 32;
    maxBytes: number;
    connectTimeoutMs: 10_000;
    digest: string;
  }>;
}>;

function boundedVersion(executable: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { NO_COLOR: '1' } });
    let stdout = ''; let stderr = ''; let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error); else resolvePromise(stdout.trim());
    };
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk).slice(0, 4096); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk).slice(0, 4096); });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => code === 0 ? finish() : finish(new Error(`Codex version probe failed (${code ?? 'signal'}): ${stderr.slice(0, 256)}`)));
    timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* best effort */ } finish(new Error('Codex version probe timed out')); }, timeoutMs);
    if (settled) { clearTimeout(timer); timer = undefined; }
  });
}

/** Attest the exact executable image immediately before launch. */
export async function attestCodexExecutable(policy: CodexHostPolicy): Promise<CodexBinaryAttestation> {
  validateCodexHostPolicy(policy);
  const physicalPath = await fs.realpath(policy.codexPath);
  const requested = await fs.lstat(policy.codexPath);
  const binary = await fs.stat(physicalPath);
  if (!binary.isFile() || (binary.mode & 0o111) === 0) fail('codex executable is not an executable regular file');
  if ((binary.mode & 0o022) !== 0) fail('codex executable is group/world writable');
  if (typeof process.getuid === 'function' && binary.uid !== process.getuid()) fail('codex executable is not owned by the current user');
  const bytes = await fs.readFile(physicalPath);
  const actualDigest = createHash('sha256').update(bytes).digest('hex');
  if (actualDigest !== policy.codexBinaryDigest) fail('codex executable digest changed');
  const version = await boundedVersion(physicalPath, policy.timeoutMs);
  if (version !== `codex-cli ${policy.codexVersion}`) fail('codex executable version changed');
  const requestedAfter = await fs.lstat(policy.codexPath);
  const binaryAfter = await fs.stat(physicalPath);
  if (requestedAfter.dev !== requested.dev || requestedAfter.ino !== requested.ino || binaryAfter.dev !== binary.dev || binaryAfter.ino !== binary.ino || binaryAfter.uid !== binary.uid || binaryAfter.gid !== binary.gid || binaryAfter.mode !== binary.mode) fail('codex executable identity changed during attestation');
  const bytesAfter = await fs.readFile(physicalPath);
  if (createHash('sha256').update(bytesAfter).digest('hex') !== actualDigest) fail('codex executable digest changed during attestation');
  return Object.freeze({ requestedPath: policy.codexPath, physicalPath, requestedPathIsSymlink: requested.isSymbolicLink(), uid: binary.uid, gid: binary.gid, mode: (binary.mode & 0o7777).toString(8), digest: actualDigest, version: policy.codexVersion });
}

async function attestDeliberationDirectory(path: string, label: string): Promise<CodexDeliberationHostAttestation['targetWorkspace']> {
  const physical = await fs.realpath(path);
  if (physical !== path) fail(`${label} must not be a symlink or path alias`);
  const stat = await fs.stat(path);
  if (!stat.isDirectory()) fail(`${label} is not a directory`);
  if ((stat.mode & 0o022) !== 0) fail(`${label} is group/world writable`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail(`${label} is not owned by the current user`);
  return Object.freeze({ path, dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode });
}

async function attestDeliberationRuntimeFile(path: string): Promise<CodexDeliberationHostAttestation['runtimeReadFiles'][number]> {
  const physical = await fs.realpath(path);
  const requested = await fs.lstat(path);
  const stat = await fs.stat(path);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0 || ![0, typeof process.getuid === 'function' ? process.getuid() : stat.uid].includes(stat.uid)) fail('deliberation runtime file is not protected');
  const fileDigest = createHash('sha256').update(await fs.readFile(physical)).digest('hex');
  const requestedAfter = await fs.lstat(path); const after = await fs.stat(physical);
  if (requestedAfter.dev !== requested.dev || requestedAfter.ino !== requested.ino || requestedAfter.mode !== requested.mode
    || after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode || createHash('sha256').update(await fs.readFile(physical)).digest('hex') !== fileDigest) fail('deliberation runtime file changed during attestation');
  return Object.freeze({ requestedPath: path, physicalPath: physical, requestedPathIsSymlink: requested.isSymbolicLink(), requestedDev: requested.dev, requestedIno: requested.ino, requestedMode: requested.mode, dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode, digest: fileDigest });
}

async function attestDeliberationRuntimeLink(path: string): Promise<CodexDeliberationHostAttestation['runtimeReadLinks'][number]> {
  const before = await fs.lstat(path); const target = await fs.readlink(path);
  if (!before.isSymbolicLink() || (before.mode & 0o022) !== 0 || ![0, typeof process.getuid === 'function' ? process.getuid() : before.uid].includes(before.uid)) fail('deliberation runtime link is not protected');
  const after = await fs.lstat(path); const targetAfter = await fs.readlink(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || targetAfter !== target) fail('deliberation runtime link changed during attestation');
  return Object.freeze({ path, dev: before.dev, ino: before.ino, uid: before.uid, gid: before.gid, mode: before.mode, target, digest: createHash('sha256').update(target).digest('hex') });
}

function boundedIsolationProbe(executable: string, profile: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ['-p', profile, '/usr/bin/true'], { shell: false, stdio: 'ignore', env: { NO_COLOR: '1' } });
    let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => { if (settled) return; settled = true; if (timer) clearTimeout(timer); if (error) reject(error); else resolvePromise(); };
    child.once('error', finish);
    child.once('close', (code, signal) => code === 0 && signal === null ? finish() : finish(new Error(`native read-isolation probe failed (${code ?? signal ?? 'unknown'})`)));
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* best effort */ } finish(new Error('native read-isolation probe timed out')); }, timeoutMs);
  });
}

async function attestReadIsolation(policy: CodexDeliberationHostPolicy): Promise<CodexDeliberationHostAttestation['readIsolation']> {
  if (process.platform !== 'darwin' || policy.readIsolation !== 'darwin-seatbelt/v1') fail('sealed native read isolation is unavailable');
  const physical = await fs.realpath(policy.sandboxExecPath);
  if (physical !== policy.sandboxExecPath) fail('native read-isolation executable must not be a symlink or path alias');
  const stat = await fs.stat(physical);
  if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0 || ![0, typeof process.getuid === 'function' ? process.getuid() : stat.uid].includes(stat.uid)) fail('native read-isolation executable is not protected');
  const bytes = await fs.readFile(physical); const executableDigest = createHash('sha256').update(bytes).digest('hex');
  const probePath = '/usr/bin/true' as const; const probeStat = await fs.stat(probePath); const probeDigest = createHash('sha256').update(await fs.readFile(probePath)).digest('hex');
  const runtimeSupportPath = '/System/Library/Sandbox/Profiles/dyld-support.sb';
  const runtimeSupportStat = await fs.stat(runtimeSupportPath);
  const runtimeSupportDigest = createHash('sha256').update(await fs.readFile(runtimeSupportPath)).digest('hex');
  const tlsRootsPath = await fs.realpath('/etc/ssl/cert.pem');
  const tlsRootsStat = await fs.stat(tlsRootsPath);
  const tlsRootsDigest = createHash('sha256').update(await fs.readFile(tlsRootsPath)).digest('hex');
  const timezoneRequestedPath = '/private/etc/localtime' as const;
  const timezonePath = await fs.realpath(timezoneRequestedPath);
  const timezoneStat = await fs.stat(timezonePath);
  const timezoneDigest = createHash('sha256').update(await fs.readFile(timezonePath)).digest('hex');
  if (!probeStat.isFile() || probeStat.uid !== 0 || (probeStat.mode & 0o022) !== 0
    || !runtimeSupportStat.isFile() || runtimeSupportStat.uid !== 0 || (runtimeSupportStat.mode & 0o022) !== 0
    || !tlsRootsStat.isFile() || tlsRootsStat.uid !== 0 || (tlsRootsStat.mode & 0o022) !== 0
    || !timezoneStat.isFile() || timezoneStat.uid !== 0 || (timezoneStat.mode & 0o022) !== 0) fail('native runtime/TLS/timezone support is not protected');
  const template = buildCodexDeliberationIsolationProfile(policy, join(policy.scratchRoot, '.attestation-attempt'));
  await boundedIsolationProbe(physical, template, policy.timeoutMs);
  const after = await fs.stat(physical);
  const probeAfter = await fs.stat(probePath); const runtimeSupportAfter = await fs.stat(runtimeSupportPath); const tlsRootsAfter = await fs.stat(tlsRootsPath); const timezoneAfter = await fs.stat(timezonePath);
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.uid !== stat.uid || after.gid !== stat.gid || after.mode !== stat.mode || createHash('sha256').update(await fs.readFile(physical)).digest('hex') !== executableDigest
    || probeAfter.dev !== probeStat.dev || probeAfter.ino !== probeStat.ino || probeAfter.mode !== probeStat.mode || createHash('sha256').update(await fs.readFile(probePath)).digest('hex') !== probeDigest
    || runtimeSupportAfter.dev !== runtimeSupportStat.dev || runtimeSupportAfter.ino !== runtimeSupportStat.ino || runtimeSupportAfter.mode !== runtimeSupportStat.mode || createHash('sha256').update(await fs.readFile(runtimeSupportPath)).digest('hex') !== runtimeSupportDigest
    || tlsRootsAfter.dev !== tlsRootsStat.dev || tlsRootsAfter.ino !== tlsRootsStat.ino || tlsRootsAfter.mode !== tlsRootsStat.mode || createHash('sha256').update(await fs.readFile(tlsRootsPath)).digest('hex') !== tlsRootsDigest
    || timezoneAfter.dev !== timezoneStat.dev || timezoneAfter.ino !== timezoneStat.ino || timezoneAfter.mode !== timezoneStat.mode || createHash('sha256').update(await fs.readFile(timezonePath)).digest('hex') !== timezoneDigest) fail('native read-isolation identity changed during attestation');
  return Object.freeze({
    schema: 'darwin-seatbelt/v1',
    executable: Object.freeze({ path: physical, dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode, digest: executableDigest }),
    probeExecutable: Object.freeze({ path: probePath, dev: probeStat.dev, ino: probeStat.ino, uid: probeStat.uid, gid: probeStat.gid, mode: probeStat.mode, digest: probeDigest }),
    runtimeSupport: Object.freeze({ path: runtimeSupportPath, dev: runtimeSupportStat.dev, ino: runtimeSupportStat.ino, uid: runtimeSupportStat.uid, gid: runtimeSupportStat.gid, mode: runtimeSupportStat.mode, digest: runtimeSupportDigest }),
    tlsRoots: Object.freeze({ path: tlsRootsPath, dev: tlsRootsStat.dev, ino: tlsRootsStat.ino, uid: tlsRootsStat.uid, gid: tlsRootsStat.gid, mode: tlsRootsStat.mode, digest: tlsRootsDigest }),
    timezone: Object.freeze({ requestedPath: timezoneRequestedPath, physicalPath: timezonePath, dev: timezoneStat.dev, ino: timezoneStat.ino, uid: timezoneStat.uid, gid: timezoneStat.gid, mode: timezoneStat.mode, digest: timezoneDigest }),
    profileTemplateDigest: digest(template), probe: 'PASS',
  });
}

/** Independently attest every identity used by managed deliberation entry.
 * Unlike policy construction, this proves real filesystem bytes and the real
 * Codex version before a provider process can be spawned. */
export async function attestCodexDeliberationHost(policy: CodexDeliberationHostPolicy): Promise<CodexDeliberationHostAttestation> {
  const checked = validateCodexDeliberationHostPolicy(policy);
  const physicalPath = await fs.realpath(checked.codexPath);
  const requested = await fs.lstat(checked.codexPath);
  const binary = await fs.stat(physicalPath);
  if (!binary.isFile() || (binary.mode & 0o111) === 0) fail('codex executable is not an executable regular file');
  if ((binary.mode & 0o022) !== 0) fail('codex executable is group/world writable');
  if (typeof process.getuid === 'function' && binary.uid !== process.getuid()) fail('codex executable is not owned by the current user');
  const binaryBytes = await fs.readFile(physicalPath);
  const binaryDigest = createHash('sha256').update(binaryBytes).digest('hex');
  if (binaryDigest !== checked.codexBinaryDigest) fail('codex executable digest changed');
  const version = await boundedVersion(physicalPath, checked.timeoutMs);
  if (version !== `codex-cli ${checked.codexVersion}`) fail('codex executable version changed');

  const schemaPhysical = await fs.realpath(checked.workerSchemaPath);
  if (schemaPhysical !== checked.workerSchemaPath) fail('deliberation worker schema must not be a symlink or path alias');
  const schema = await fs.stat(schemaPhysical);
  if (!schema.isFile() || (schema.mode & 0o022) !== 0) fail('deliberation worker schema is not a protected regular file');
  if (typeof process.getuid === 'function' && schema.uid !== process.getuid()) fail('deliberation worker schema is not owned by the current user');
  const schemaBytes = await fs.readFile(schemaPhysical);
  const schemaDigest = createHash('sha256').update(schemaBytes).digest('hex');
  if (schemaDigest !== checked.workerSchemaDigest) fail('deliberation worker schema digest changed');

  const authPhysical = await fs.realpath(checked.authFilePath);
  if (authPhysical !== checked.authFilePath) fail('deliberation auth file must not be a symlink or path alias');
  const auth = await fs.stat(authPhysical);
  if (!auth.isFile() || (auth.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && auth.uid !== process.getuid())) fail('deliberation auth file is not a protected regular file');
  const authDigest = createHash('sha256').update(await fs.readFile(authPhysical)).digest('hex');
  if (authDigest !== checked.authFileDigest) fail('deliberation auth file digest changed');
  const runtimeReadFiles = await Promise.all(checked.runtimeReadFiles.map(attestDeliberationRuntimeFile));
  const runtimeReadSubpaths = await Promise.all(checked.runtimeReadSubpaths.map(async (path) => {
    const requested = await fs.lstat(path); const physicalPath = await fs.realpath(path); const stat = await fs.stat(physicalPath);
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || ![0, typeof process.getuid === 'function' ? process.getuid() : stat.uid].includes(stat.uid)) fail('deliberation runtime subpath is not protected');
    return Object.freeze({ requestedPath: path, physicalPath, requestedPathIsSymlink: requested.isSymbolicLink(), requestedDev: requested.dev, requestedIno: requested.ino, requestedMode: requested.mode, dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode });
  }));
  const runtimeReadLinks = await Promise.all(runtimeSymlinkInputs(checked.runtimeReadFiles).map(attestDeliberationRuntimeLink));

  const targetWorkspace = await attestDeliberationDirectory(checked.targetWorkspace, 'deliberation target workspace');
  const scratchRoot = await attestDeliberationDirectory(checked.scratchRoot, 'deliberation scratch root');
  const evidenceRoot = await attestDeliberationDirectory(checked.evidenceRoot, 'deliberation evidence root');
  const readIsolation = await attestReadIsolation(checked);
  const requestedAfter = await fs.lstat(checked.codexPath);
  const binaryAfter = await fs.stat(physicalPath);
  const schemaAfter = await fs.stat(schemaPhysical);
  const authAfter = await fs.stat(authPhysical);
  if (requestedAfter.dev !== requested.dev || requestedAfter.ino !== requested.ino || binaryAfter.dev !== binary.dev || binaryAfter.ino !== binary.ino || binaryAfter.mode !== binary.mode || schemaAfter.dev !== schema.dev || schemaAfter.ino !== schema.ino || schemaAfter.mode !== schema.mode || authAfter.dev !== auth.dev || authAfter.ino !== auth.ino || authAfter.mode !== auth.mode) fail('deliberation host identity changed during attestation');
  if (createHash('sha256').update(await fs.readFile(physicalPath)).digest('hex') !== binaryDigest || createHash('sha256').update(await fs.readFile(schemaPhysical)).digest('hex') !== schemaDigest || createHash('sha256').update(await fs.readFile(authPhysical)).digest('hex') !== authDigest) fail('deliberation host bytes changed during attestation');
  return Object.freeze({
    policyDigest: digest(checked),
    executable: Object.freeze({ requestedPath: checked.codexPath, physicalPath, requestedPathIsSymlink: requested.isSymbolicLink(), uid: binary.uid, gid: binary.gid, mode: (binary.mode & 0o7777).toString(8), digest: binaryDigest, version: checked.codexVersion }),
    authFile: Object.freeze({ path: authPhysical, dev: auth.dev, ino: auth.ino, uid: auth.uid, gid: auth.gid, mode: auth.mode, digest: authDigest }),
    runtimeReadFiles: Object.freeze(runtimeReadFiles),
    runtimeReadSubpaths: Object.freeze(runtimeReadSubpaths),
    runtimeReadLinks: Object.freeze(runtimeReadLinks),
    workerSchema: Object.freeze({ path: schemaPhysical, dev: schema.dev, ino: schema.ino, uid: schema.uid, gid: schema.gid, mode: schema.mode, digest: schemaDigest }),
    targetWorkspace,
    scratchRoot,
    evidenceRoot,
    readIsolation,
    modelTransport: (() => {
      const value = { schema: 'lunacy-codex-model-transport-policy/v1' as const, destinations: ['chatgpt.com:443'] as const, maxConnections: 32 as const, maxBytes: 64 * 1024 * 1024, connectTimeoutMs: 10_000 as const };
      return Object.freeze({ ...value, digest: digest(value) });
    })(),
  });
}

export function canonicalPolicyBytes(policy: CodexHostPolicy): string { return canonicalString(validateCodexHostPolicy(policy)); }
