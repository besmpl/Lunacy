#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalString, parseCanonical } from './canonical.js';
import type { BeadsBridgeMode, BridgeMode, BridgeOptions, BridgeTransition } from './bridge.js';
import type { BeadsAcknowledgement } from './beads.js';
import type { Event, Plan } from './model.js';
import { drive, type TerminalEffectDriver } from './orchestration.js';
import { lifecycle, type LifecycleCommand, type LifecycleResult } from './orchestration.js';

type Flags = {
  runDir?: string; runId?: string; mode?: BridgeMode; modeProvided: boolean; plan?: string; event?: string; eventId?: string; phaseId?: string; stepId?: string;
  state?: string; steps?: string; expectedRevision?: number; attemptEpoch?: number; authorityEpoch?: number; barrierEpoch?: number; launchToken?: string;
  action?: 'disable' | 'delete'; help: boolean;
  beadsMode?: BeadsBridgeMode; bdPath?: string; beadsWorkspace?: string; beadsDigest?: string; beadsHome?: string; beadsConfig?: string; beadsAck?: string; beadsPhase?: string;
};

function usage(): string {
  return `Usage: lunacy-bridge --run-dir RUN --run-id ID --mode runtime --plan PLAN.json --event EVENT.json [options]
       lunacy-bridge drive --run-dir RUN --run-id ID --mode runtime --plan PLAN.json --policy POLICY.json [options]
       lunacy-bridge init|run|resume --run-dir RUN --run-id ID --mode runtime --plan PLAN.json [--policy POLICY.json]
       lunacy-bridge lifecycle --command init|run|resume --run-dir RUN --run-id ID --mode runtime --plan PLAN.json [options]

Read-only dependency explanation:
  lunacy-bridge workfront --run-root RUN --run-id ID [--limit 16] [--focus STEP]
       lunacy-bridge inspect-recovery --run-root RUN --run-id ID --launch-token TOKEN [--command-digest HEX] [--policy POLICY.json]

Invoke one private runtime-to-skill transition. The bridge calls only
RunKernel.advance and projects machine-owned sections into STATE.md/STEPS.md;
it never schedules workers/providers or installs packages.

Options:
  --run-dir PATH          Absolute run root containing .kernel/ (required)
  --run-id ID             Run identity (required for runtime transitions)
  --mode runtime|markdown Explicit per-run mode (required)
  --plan PATH             Canonical parent-owned Plan JSON (runtime transition)
  --event PATH            Canonical Event JSON (one event per invocation)
  --event-id ID           Event identity (required for runtime transition)
  --phase-id ID           Identity phase (default: plan.phaseId)
  --step-id ID            Identity step (default: run)
  --state PATH            Projection STATE.md path under run root
  --steps PATH            Projection STEPS.md path under run root
  --expected-revision N   Optimistic revision fence
  --attempt-epoch N       Identity epoch
  --authority-epoch N     Identity epoch
  --barrier-epoch N       Identity epoch
  --launch-token TOKEN    Dispatch/receipt identity token
  --beads-mode off|shadow|active  Explicit read-only Beads planning mode
  --bd-path PATH          Absolute operator-provisioned bd v1.2.2 executable
  --beads-workspace PATH  Absolute Beads workspace
  --beads-sha256 HEX      Expected SHA-256 of the bd executable
  --beads-home PATH       Isolated HOME for bd
  --beads-config PATH     Isolated XDG_CONFIG_HOME for bd
  --beads-phase ID        Phase identity for the generated Beads plan
  --beads-ack PATH        Canonical acknowledgement JSON (active mode)
  --disable               Quiescently disable bridge metadata
  --delete                Quiescently delete bridge metadata only
  --help                  Show this help

All JSON files must be canonical. Use '-' for one JSON document from stdin.`;
}

type LifecycleFlags = { command: LifecycleCommand; runDir?: string; runId?: string; mode?: BridgeMode; modeProvided: boolean; plan?: string; policy?: string; state?: string; steps?: string; maxTransitions?: number; help: boolean };

function parseLifecycleArgs(argv: string[], positionalCommand?: LifecycleCommand): LifecycleFlags {
  const flags: LifecycleFlags = { command: positionalCommand ?? 'run', modeProvided: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unknown lifecycle argument ${arg}`);
    const name = arg.slice(2); const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    if (name === 'command') { if (value !== 'init' && value !== 'run' && value !== 'resume') throw new Error('--command must be init, run, or resume'); flags.command = value; }
    else if (name === 'run-dir') flags.runDir = value;
    else if (name === 'run-id') flags.runId = value;
    else if (name === 'mode') { if (value !== 'runtime') throw new Error('lifecycle requires --mode runtime'); flags.mode = value; flags.modeProvided = true; }
    else if (name === 'plan') flags.plan = value;
    else if (name === 'policy') flags.policy = value;
    else if (name === 'state') flags.state = value;
    else if (name === 'steps') flags.steps = value;
    else if (name === 'max-transitions') flags.maxTransitions = numberFlag(name, value);
    else throw new Error(`unknown lifecycle option --${name}`);
  }
  return flags;
}

type DriveFlags = { runDir?: string; runId?: string; mode?: BridgeMode; modeProvided: boolean; plan?: string; policy?: string; maxTransitions?: number; help: boolean };

function parseDriveArgs(argv: string[]): DriveFlags {
  const flags: DriveFlags = { modeProvided: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unknown drive argument ${arg}`);
    const name = arg.slice(2); const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    if (name === 'run-dir') flags.runDir = value;
    else if (name === 'run-id') flags.runId = value;
    else if (name === 'mode') { if (value !== 'runtime') throw new Error('drive requires --mode runtime'); flags.mode = value; flags.modeProvided = true; }
    else if (name === 'plan') flags.plan = value;
    else if (name === 'policy') flags.policy = value;
    else if (name === 'max-transitions') flags.maxTransitions = numberFlag(name, value);
    else throw new Error(`unknown drive option --${name}`);
  }
  return flags;
}

function writeOutput(text: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { process.stdout.off('error', onError); };
    process.stdout.once('error', onError);
    process.stdout.write(text, (error) => {
      cleanup();
      if (error) reject(error); else resolvePromise();
    });
  });
}

function numberFlag(name: string, value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const n = Number(value); if (!Number.isSafeInteger(n)) throw new Error(`${name} is outside safe integer range`); return n;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { modeProvided: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unknown argument ${arg}`);
    const name = arg.slice(2);
    if (name === 'disable' || name === 'delete') { if (flags.action) throw new Error('--disable and --delete are mutually exclusive'); flags.action = name; continue; }
    const value = argv[++i]; if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    switch (name) {
      case 'run-dir': flags.runDir = value; break; case 'run-id': flags.runId = value; break; case 'mode': if (value !== 'runtime' && value !== 'markdown') throw new Error('--mode must be runtime or markdown'); flags.mode = value; flags.modeProvided = true; break;
      case 'plan': flags.plan = value; break; case 'event': flags.event = value; break; case 'event-id': flags.eventId = value; break; case 'phase-id': flags.phaseId = value; break; case 'step-id': flags.stepId = value; break;
      case 'state': flags.state = value; break; case 'steps': flags.steps = value; break; case 'expected-revision': flags.expectedRevision = numberFlag(name, value); break;
      case 'attempt-epoch': flags.attemptEpoch = numberFlag(name, value); break; case 'authority-epoch': flags.authorityEpoch = numberFlag(name, value); break; case 'barrier-epoch': flags.barrierEpoch = numberFlag(name, value); break; case 'launch-token': flags.launchToken = value; break;
      case 'beads-mode': if (value !== 'off' && value !== 'shadow' && value !== 'active') throw new Error('--beads-mode must be off, shadow, or active'); flags.beadsMode = value; break;
      case 'bd-path': flags.bdPath = value; break; case 'beads-workspace': flags.beadsWorkspace = value; break; case 'beads-sha256': flags.beadsDigest = value; break; case 'beads-home': flags.beadsHome = value; break; case 'beads-config': flags.beadsConfig = value; break; case 'beads-phase': flags.beadsPhase = value; break; case 'beads-ack': flags.beadsAck = value; break;
      default: throw new Error(`unknown option --${name}`);
    }
  }
  return flags;
}

async function readCanonical(path: string): Promise<unknown> {
  const text = path === '-' ? await readFile('/dev/stdin', 'utf8') : await readFile(path, 'utf8');
  try { return parseCanonical(text); } catch (error) { throw new Error(`${path} must contain canonical JSON: ${(error as Error).message}`); }
}

async function beadsOptions(flags: Flags): Promise<BridgeOptions['beads'] | undefined> {
  if (!flags.beadsMode || flags.beadsMode === 'off') return undefined;
  if (!flags.bdPath || !flags.beadsWorkspace || !flags.beadsDigest) throw new Error('--bd-path, --beads-workspace, and --beads-sha256 are required for Beads mode');
  const { BeadsPlanSource } = await import('./beads.js');
  const source = new BeadsPlanSource({ executablePath: flags.bdPath, workspace: flags.beadsWorkspace, expectedBinaryDigest: flags.beadsDigest, ...(flags.beadsHome === undefined ? {} : { homeDir: flags.beadsHome }), ...(flags.beadsConfig === undefined ? {} : { xdgConfigHome: flags.beadsConfig }), ...(flags.beadsPhase === undefined ? {} : { phaseId: flags.beadsPhase }) });
  const acknowledgement = flags.beadsAck === undefined ? undefined : await readCanonical(flags.beadsAck) as BeadsAcknowledgement;
  return { mode: flags.beadsMode, source, ...(acknowledgement === undefined ? {} : { acknowledgement }) };
}

function planFrom(value: unknown): Plan {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { phaseId?: unknown }).phaseId !== 'string' || !Array.isArray((value as { steps?: unknown }).steps)) throw new Error('plan must contain phaseId and steps');
  return value as Plan;
}

function eventFrom(value: unknown): Event {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { kind?: unknown }).kind !== 'string') throw new Error('event must be a canonical Event object');
  return value as Event;
}

/** Execute the additive per-run lifecycle controller. This private route is
 * deliberately separate from the legacy one-event and drive commands. */
async function runLifecycleCli(argv: string[], injectedDriver?: TerminalEffectDriver, externalSignal?: AbortSignal, positionalCommand?: LifecycleCommand): Promise<number> {
  const flags = parseLifecycleArgs(argv, positionalCommand);
  if (flags.help) { await writeOutput('Usage: lunacy-bridge init|run|resume --run-dir RUN --run-id ID --mode runtime --plan PLAN.json [--policy POLICY.json] [--max-transitions N]\n'); return 0; }
  if (!flags.modeProvided || flags.mode !== 'runtime') throw new Error('--mode runtime is required for lifecycle');
  if (!flags.runDir || !flags.runId || !flags.plan) throw new Error('--run-dir, --run-id, and --plan are required for lifecycle');
  const plan = planFrom(await readCanonical(flags.plan));
  let policy: unknown;
  if (flags.policy) policy = await readCanonical(flags.policy);
  if (flags.command !== 'init' && !injectedDriver && !flags.policy) throw new Error('--policy is required for run/resume when no driver is injected');
  const controller = new AbortController();
  const abort = (): void => { if (!controller.signal.aborted) controller.abort(); };
  const onSigint = (): void => abort();
  const onSigterm = (): void => abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm);
  if (externalSignal?.aborted) abort();
  try {
    const result: LifecycleResult = await lifecycle({ command: flags.command, runDir: flags.runDir, runId: flags.runId, plan, ...(flags.state === undefined ? {} : { statePath: flags.state }), ...(flags.steps === undefined ? {} : { stepsPath: flags.steps }), ...(injectedDriver === undefined ? {} : { driver: injectedDriver }), ...(policy === undefined ? {} : { policy: policy as any }), signal: controller.signal, ...(flags.maxTransitions === undefined ? {} : { maxTransitions: flags.maxTransitions }) });
    await writeOutput(`${canonicalString(result)}\n`); return 0;
  } finally {
    externalSignal?.removeEventListener('abort', abort); process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm);
  }
}


type RecoveryFlags = { runRoot?: string; kernelRoot?: string; runId?: string; expectedRunId?: string; launchToken?: string; token?: string; commandDigest?: string; policy?: string; effectsRoot?: string; authorityDigest?: string; policyDigest?: string; help: boolean };

function parseRecoveryArgs(argv: string[]): RecoveryFlags {
  const flags: RecoveryFlags = { help: false };
  const set = <K extends keyof RecoveryFlags>(key: K, value: RecoveryFlags[K], label: string): void => {
    const previous = flags[key];
    if (previous !== undefined && previous !== value) throw new Error(`${label} selectors conflict`);
    flags[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unknown inspect-recovery argument ${arg}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (arg === '--run-root') set('runRoot', value, 'runRoot');
    else if (arg === '--kernel-root') set('kernelRoot', value, 'kernelRoot');
    else if (arg === '--run-id') set('runId', value, 'runId');
    else if (arg === '--expected-run-id') set('expectedRunId', value, 'expectedRunId');
    else if (arg === '--launch-token') set('launchToken', value, 'launchToken');
    else if (arg === '--token') set('token', value, 'token');
    else if (arg === '--command-digest') set('commandDigest', value, 'commandDigest');
    else if (arg === '--policy') set('policy', value, 'policy');
    else if (arg === '--effects-root') set('effectsRoot', value, 'effectsRoot');
    else if (arg === '--authority-digest') set('authorityDigest', value, 'authorityDigest');
    else if (arg === '--policy-digest') set('policyDigest', value, 'policyDigest');
    else throw new Error(`unknown inspect-recovery option ${arg}`);
  }
  return flags;
}

function safeRecoveryError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  let code = 'RecoveryInspectionFailed';
  if (message.includes('output ceiling') || message.includes('inspection ceiling')) code = 'CapsuleLimit';
  else if (message.includes('ManifestMismatch') || message.includes('FilesystemTrust') || message.includes('changed during read')) code = 'ManifestMismatch';
  else if (message.startsWith('Recovery:') || message.includes('selectors conflict') || message.includes('requires a value') || message.includes('unknown inspect-recovery') || message.includes('--run-root') || message.includes('--kernel-root') || message.includes('--run-id') || message.includes('--expected-run-id') || message.includes('--launch-token') || message.includes('--token')) code = 'InvalidRecoveryInput';
  const result = new Error(code); result.name = 'RecoveryError'; return result;
}

async function runRecoveryCli(argv: string[]): Promise<number> {
  const flags = parseRecoveryArgs(argv);
  if (flags.help) { await writeOutput('Usage: lunacy-bridge inspect-recovery --run-root RUN --run-id ID --launch-token TOKEN [--command-digest HEX] [--policy POLICY.json]\n'); return 0; }
  if ((!flags.runRoot && !flags.kernelRoot) || (!flags.runId && !flags.expectedRunId) || (!flags.launchToken && !flags.token)) throw new Error('--run-root, --run-id, and --launch-token are required');
  let policy: unknown;
  if (flags.policy) policy = await readCanonical(flags.policy);
  const { inspectRecovery } = await import('./recovery-forensics.js');
  const capsule = await inspectRecovery({ ...(flags.runRoot === undefined ? {} : { runRoot: flags.runRoot }), ...(flags.kernelRoot === undefined ? {} : { kernelRoot: flags.kernelRoot }), ...(flags.runId === undefined ? {} : { runId: flags.runId }), ...(flags.expectedRunId === undefined ? {} : { expectedRunId: flags.expectedRunId }), ...(flags.launchToken === undefined ? {} : { launchToken: flags.launchToken }), ...(flags.token === undefined ? {} : { token: flags.token }), ...(flags.commandDigest === undefined ? {} : { commandDigest: flags.commandDigest }), ...(policy === undefined ? {} : { policy: policy as any }), ...(flags.effectsRoot === undefined ? {} : { effectsRoot: flags.effectsRoot }), ...(flags.authorityDigest === undefined ? {} : { authorityDigest: flags.authorityDigest }), ...(flags.policyDigest === undefined ? {} : { policyDigest: flags.policyDigest }) });
  await writeOutput(`${canonicalString(capsule)}\n`); return 0;
}

export async function runBridgeCli(argv = process.argv.slice(2), injectedDriver?: TerminalEffectDriver, externalSignal?: AbortSignal): Promise<number> {
  if (argv[0] === 'drive') return runDriveCli(argv.slice(1), injectedDriver, externalSignal);
  if (argv[0] === 'lifecycle') return runLifecycleCli(argv.slice(1), injectedDriver, externalSignal);
  if (argv[0] === 'init' || argv[0] === 'run' || argv[0] === 'resume') return runLifecycleCli(argv.slice(1), injectedDriver, externalSignal, argv[0]);
  if (argv[0] === 'inspect-recovery' || argv[0] === 'recovery') {
    try { return await runRecoveryCli(argv.slice(1)); }
    catch (error) { throw safeRecoveryError(error); }
  }
  if (argv[0] === 'workfront') {
    try { return await runWorkfrontCli(argv.slice(1)); }
    catch (error) { throw safeWorkfrontError(error); }
  }
  const flags = parseArgs(argv);
  if (flags.help) { await writeOutput(`${usage()}\n`); return 0; }
  if (!flags.modeProvided || flags.mode === undefined) throw new Error('--mode is required; choose runtime or markdown explicitly');
  if (!flags.runDir) throw new Error('--run-dir is required');
  if (flags.action) {
    if (flags.mode !== 'runtime') throw new Error('--disable/--delete require --mode runtime');
    if (!flags.runId) throw new Error('--run-id is required');
    const options: BridgeOptions = { runDir: flags.runDir, runId: flags.runId, mode: 'runtime' };
    const { deleteBridge, disable } = await import('./bridge.js');
    const result = flags.action === 'disable' ? await disable(options) : await deleteBridge(options);
    await writeOutput(`${canonicalString(result)}\n`); return 0;
  }
  if (flags.mode === 'markdown') {
    const { transition } = await import('./bridge.js');
    const result = await transition({ runDir: flags.runDir, runId: flags.runId ?? 'markdown-run', mode: 'markdown' }, { event: { kind: 'RESUME' }, eventId: flags.eventId ?? 'markdown' });
    await writeOutput(`${canonicalString(result)}\n`); return 0;
  }
  if (!flags.runId || !flags.event || !flags.eventId || (!flags.plan && flags.beadsMode !== 'active')) throw new Error('--run-id, --event, and --event-id are required; --plan is required unless active Beads mode is selected');
  const plan = flags.plan === undefined ? undefined : planFrom(await readCanonical(flags.plan));
  const event = eventFrom(await readCanonical(flags.event));
  const beads = await beadsOptions(flags);
  const options: BridgeOptions = { runDir: flags.runDir, runId: flags.runId, mode: 'runtime', ...(plan === undefined ? {} : { plan }), ...(flags.state ? { statePath: flags.state } : {}), ...(flags.steps ? { stepsPath: flags.steps } : {}), ...(beads === undefined ? {} : { beads }) };
  const transitionInput: BridgeTransition = { event, eventId: flags.eventId, ...(flags.phaseId ? { phaseId: flags.phaseId } : {}), ...(flags.stepId ? { stepId: flags.stepId } : {}), ...(flags.expectedRevision === undefined ? {} : { expectedRevision: flags.expectedRevision }), ...(flags.attemptEpoch === undefined ? {} : { attemptEpoch: flags.attemptEpoch }), ...(flags.authorityEpoch === undefined ? {} : { authorityEpoch: flags.authorityEpoch }), ...(flags.barrierEpoch === undefined ? {} : { barrierEpoch: flags.barrierEpoch }), ...(flags.launchToken ? { launchToken: flags.launchToken } : {}) };
  const { transition } = await import('./bridge.js');
  const result = await transition(options, transitionInput);
  await writeOutput(`${canonicalString(result)}\n`); return 0;
}

/** Execute the private event-driven pump. A managed caller may inject a
 * driver (used by deterministic tests); the installed CLI binds one from a
 * canonical closed host policy document. */
async function runDriveCli(argv: string[], injectedDriver?: TerminalEffectDriver, externalSignal?: AbortSignal): Promise<number> {
  const flags = parseDriveArgs(argv);
  if (flags.help) { await writeOutput('Usage: lunacy-bridge drive --run-dir RUN --run-id ID --mode runtime --plan PLAN.json --policy POLICY.json [--max-transitions N]\n'); return 0; }
  if (!flags.modeProvided || flags.mode !== 'runtime') throw new Error('--mode runtime is required for drive');
  if (!flags.runDir || !flags.runId || !flags.plan) throw new Error('--run-dir, --run-id, and --plan are required for drive');
  const plan = planFrom(await readCanonical(flags.plan));
  let driver = injectedDriver;
  if (!driver) {
    if (!flags.policy) throw new Error('--policy is required when no managed driver is injected');
    const policy = await readCanonical(flags.policy);
    const { makeCodexExecDriver } = await import('./codex-exec-driver.js');
    driver = makeCodexExecDriver({ policy: policy as import('./codex-host-policy.js').CodexHostPolicy });
  }
  // The managed entry owns exactly one shutdown bridge for its drive lifetime.
  // Signals and an embedding caller's AbortSignal converge on the same owned
  // controller; all listeners are removed deterministically after settlement.
  const controller = new AbortController();
  const abort = (): void => { if (!controller.signal.aborted) controller.abort(); };
  const onSigint = (): void => abort();
  const onSigterm = (): void => abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  if (externalSignal?.aborted) abort();
  try {
    const result = await drive({ runDir: flags.runDir, runId: flags.runId, plan, driver, signal: controller.signal, ...(flags.maxTransitions === undefined ? {} : { maxTransitions: flags.maxTransitions }) });
    await writeOutput(`${canonicalString(result)}\n`); return 0;
  } finally {
    externalSignal?.removeEventListener('abort', abort);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

type WorkfrontFlags = { runRoot?: string; runId?: string; limit?: number; focus?: string; help: boolean };

/** Map private filesystem/state details to a small stable managed-CLI surface. */
function safeWorkfrontError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  let code = 'WorkfrontInspectionFailed';
  if (message.includes('ManifestMismatch') || message.includes('FilesystemTrust')) code = 'ManifestMismatch';
  else if (message.includes('output ceiling')) code = 'CapsuleLimit';
  else if (message.startsWith('Workfront:') || message.includes('workfront argument') || message.includes('workfront option') || message.includes('--run-root') || message.includes('--run-id') || message.includes('--limit') || message.includes('--focus')) code = 'InvalidCapsuleInput';
  const result = new Error(code);
  result.name = 'WorkfrontError';
  return result;
}

function parseWorkfrontArgs(argv: string[]): WorkfrontFlags {
  const flags: WorkfrontFlags = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unknown workfront argument ${arg}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (arg === '--run-root') flags.runRoot = value;
    else if (arg === '--run-id') flags.runId = value;
    else if (arg === '--limit') flags.limit = numberFlag('limit', value);
    else if (arg === '--focus') flags.focus = value;
    else throw new Error(`unknown workfront option ${arg}`);
  }
  return flags;
}

async function runWorkfrontCli(argv: string[]): Promise<number> {
  const flags = parseWorkfrontArgs(argv);
  if (flags.help) {
    await writeOutput('Usage: lunacy-bridge workfront --run-root RUN --run-id ID [--limit 16] [--focus STEP]\n');
    return 0;
  }
  if (!flags.runRoot || !flags.runId) throw new Error('--run-root and --run-id are required');
  const { inspectWorkfront } = await import('./workfront.js');
  const capsule = await inspectWorkfront({ kernelRoot: flags.runRoot, expectedRunId: flags.runId, ...(flags.limit === undefined ? {} : { limit: flags.limit }), ...(flags.focus === undefined ? {} : { focusStepId: flags.focus }) });
  await writeOutput(`${canonicalString(capsule)}\n`);
  return 0;
}

let isMain = false;
if (process.argv[1]) { try { isMain = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { isMain = false; } }
if (isMain) runBridgeCli().then((code) => { process.exitCode = code; }).catch((error: unknown) => { process.stderr.write(`${canonicalString({ error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } })}\n`); process.exitCode = 1; });
