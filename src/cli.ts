#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalString, digest, parseCanonical } from './canonical.js';
import { makeRunKernel, type KernelOptions } from './public.js';
import type { AdvanceInput, Event, Plan } from './model.js';

type Flags = {
  plan?: string; event?: string; runId: string; eventId: string; phaseId?: string; stepId: string;
  rootDir?: string; expectedRevision?: number; attemptEpoch: number; authorityEpoch: number;
  barrierEpoch: number; launchToken?: string; help: boolean;
};

function usage(): string {
  return `Usage: lunacy-runtime --plan PLAN.json --event EVENT.json [options]

Read one canonical plan and one canonical event, invoke RunKernel.advance, and
write canonical Yield JSON to stdout. No provider, token, or host capability is
claimed; an uncomposed dispatch remains a truthful HumanReceiptRequired block.

Options:
  --plan PATH              Canonical plan JSON (required)
  --event PATH             Canonical event JSON (required)
  --run-id ID              Run identity (default: cli-run)
  --event-id ID            Event identity (default: cli-event)
  --phase-id ID            Identity phase (default: plan.phaseId)
  --step-id ID             Identity step (default: run)
  --root-dir PATH          Durable root containing .kernel/
  --expected-revision N    Optimistic revision fence
  --attempt-epoch N        Identity attempt epoch (default: 0)
  --authority-epoch N      Identity authority epoch (default: 0)
  --barrier-epoch N        Identity barrier epoch (default: 0)
  --launch-token TOKEN     Dispatch/receipt identity token
  --help                   Show this help

Use '-' as PATH to read that JSON document from stdin (only once).`;
}

function numberFlag(name: string, value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the safe integer range`);
  return parsed;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { runId: 'cli-run', eventId: 'cli-event', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unknown argument ${arg}`);
    const name = arg.slice(2); const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    switch (name) {
      case 'plan': flags.plan = value; break; case 'event': flags.event = value; break;
      case 'run-id': flags.runId = value; break; case 'event-id': flags.eventId = value; break;
      case 'phase-id': flags.phaseId = value; break; case 'step-id': flags.stepId = value; break;
      case 'root-dir': flags.rootDir = value; break;
      case 'expected-revision': flags.expectedRevision = numberFlag('--expected-revision', value); break;
      case 'attempt-epoch': flags.attemptEpoch = numberFlag('--attempt-epoch', value); break;
      case 'authority-epoch': flags.authorityEpoch = numberFlag('--authority-epoch', value); break;
      case 'barrier-epoch': flags.barrierEpoch = numberFlag('--barrier-epoch', value); break;
      case 'launch-token': flags.launchToken = value; break;
      default: throw new Error(`unknown option --${name}`);
    }
  }
  return flags;
}

async function readCanonical(path: string, stdin: { used: boolean }): Promise<unknown> {
  if (path === '-') {
    if (stdin.used) throw new Error('stdin may be used for only one document');
    stdin.used = true;
  }
  const text = path === '-' ? await readFile('/dev/stdin', 'utf8') : await readFile(path, 'utf8');
  try { return parseCanonical(text); }
  catch (error) { throw new Error(`${path} must contain canonical JSON: ${(error as Error).message}`); }
}

function eventFrom(value: unknown): Event {
  if (!value || typeof value !== 'object' || typeof (value as { kind?: unknown }).kind !== 'string') throw new Error('event must be a canonical Event object');
  return value as Event;
}

function planFrom(value: unknown): Plan {
  if (!value || typeof value !== 'object' || typeof (value as { phaseId?: unknown }).phaseId !== 'string' || !Array.isArray((value as { steps?: unknown }).steps)) throw new Error('plan must contain phaseId and steps');
  return value as Plan;
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const flags = parseArgs(argv);
  if (flags.help) { process.stdout.write(`${usage()}\n`); return 0; }
  if (!flags.plan || !flags.event) throw new Error('--plan and --event are required');
  const stdin = { used: false };
  const plan = planFrom(await readCanonical(flags.plan, stdin));
  const event = eventFrom(await readCanonical(flags.event, stdin));
  const identity: AdvanceInput['identity'] = {
    runId: flags.runId, phaseId: flags.phaseId ?? plan.phaseId, stepId: flags.stepId,
    attemptEpoch: flags.attemptEpoch, authorityEpoch: flags.authorityEpoch, barrierEpoch: flags.barrierEpoch,
    eventId: flags.eventId, payloadDigest: digest(event), ...(flags.launchToken ? { launchToken: flags.launchToken } : {}),
  };
  const options: KernelOptions = { plan, ...(flags.rootDir ? { rootDir: flags.rootDir } : {}) };
  const yieldValue = await makeRunKernel(options).advance({ runId: flags.runId, ...(flags.expectedRevision === undefined ? {} : { expectedRevision: flags.expectedRevision }), identity, event });
  process.stdout.write(`${canonicalString(yieldValue)}\n`);
  return 0;
}

let isMain = false;
if (process.argv[1]) {
  try { isMain = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { isMain = false; }
}
if (isMain) {
  runCli().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    const value = { error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } };
    process.stderr.write(`${canonicalString(value)}\n`); process.exitCode = 1;
  });
}
