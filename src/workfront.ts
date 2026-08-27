import { canonicalString } from './canonical.js';
import { compareStable, dependencyTerminal } from './dependency.js';
import { FileArtifactStore, isCanonicalRootPath } from './store.js';
import type { MachineState, OutboxCommand, OutboxState } from './model.js';

const DEFAULT_LIMIT = 16;
const MAX_LIMIT = 64;
const OUTPUT_BYTE_CEILING = 16 * 1024;

export type WorkfrontCapsule = {
  schema: 'lunacy-workfront/v1';
  run: { runId: string; phaseId: string; revision: number; planDigest: string };
  summary: { status: MachineState['status']; gate: MachineState['gate']; barrier: MachineState['barrier']; nextAction: string };
  active: Array<{ stepId: string; attempt: number; dispatch: 'NONE' | OutboxState }>;
  eligible: Array<{ stepId: string }>;
  blocked: Array<{ stepId: string; reason: 'WAITING_DEPENDENCY'; waitsFor: string[] }>;
  attention: Array<{ code: 'RUN_BLOCKED' | 'GATE_DUE' | 'GATE_FINDINGS' | 'BARRIER_CLOSED' | 'NEEDS_DECISION' | 'REPAIR_REQUIRED' | 'UNKNOWN_DISPATCH'; stepId?: string }>;
  truncation: { limit: number; active: boolean; eligible: boolean; blocked: boolean; attention: boolean };
};

export type WorkfrontOptions = { limit?: number; focusStepId?: string };
export type WorkfrontInput = { kernelRoot: string; expectedRunId: string; limit?: number; focusStepId?: string };

function fail(message: string): never { throw new Error(`Workfront: ${message}`); }

function boundedLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_LIMIT) fail(`limit must be an integer between 0 and ${MAX_LIMIT}`);
  return value as number;
}

function stableSort<T>(items: T[], key: (item: T) => string): T[] {
  return items.sort((a, b) => compareStable(key(a), key(b)));
}

function isCurrentFrame(state: MachineState, command: OutboxCommand): boolean {
  return command.attemptEpoch === state.attemptEpoch && command.authorityEpoch === state.authorityEpoch && command.barrierEpoch === state.barrierEpoch && command.modeEpoch === state.modeEpoch;
}

function commandForStep(state: MachineState, commandsByStep: ReadonlyMap<string, OutboxCommand[]>, stepId: string): OutboxState | 'NONE' {
  // Old attempts remain durable for late receipt/UNKNOWN reconciliation. Only
  // the exact current execution frame can explain an ACTIVE step. Never invent
  // reconciliation by choosing a merely "newest" historical command.
  const step = state.steps[stepId];
  if (!step || step.status !== 'ACTIVE' || step.attempt !== state.attemptEpoch) return 'NONE';
  const commands = (commandsByStep.get(stepId) ?? []).filter((command) => isCurrentFrame(state, command) && command.attemptEpoch === step.attempt);
  if (commands.length === 0) return 'NONE';
  if (commands.length !== 1) fail('verified active step has ambiguous current dispatch');
  return commands[0].state;
}

function waitingFor(state: MachineState, stepId: string): string[] {
  const step = state.steps[stepId];
  if (!step) fail(`step ${stepId} is absent`);
  return stableSort((step.dependencies ?? []).filter((dependency) => !dependencyTerminal(state.steps[dependency]?.status)), (id) => id);
}

function allAttention(state: MachineState): Array<{ code: WorkfrontCapsule['attention'][number]['code']; stepId?: string }> {
  const attention: Array<{ code: WorkfrontCapsule['attention'][number]['code']; stepId?: string }> = [];
  if (state.status === 'BLOCKED') attention.push({ code: 'RUN_BLOCKED' });
  if (state.gate === 'DUE') attention.push({ code: 'GATE_DUE' });
  if (state.gate === 'FINDINGS') attention.push({ code: 'GATE_FINDINGS' });
  if (state.barrier === 'CLOSED') attention.push({ code: 'BARRIER_CLOSED' });
  for (const step of Object.values(state.steps)) {
    if (step.status === 'NEEDS-DECISION') attention.push({ code: 'NEEDS_DECISION', stepId: step.stepId });
    if (step.status === 'REPAIR') attention.push({ code: 'REPAIR_REQUIRED', stepId: step.stepId });
  }
  for (const command of Object.values(state.outbox)) {
    if (command.state === 'UNKNOWN' && isCurrentFrame(state, command) && Object.prototype.hasOwnProperty.call(state.steps, command.stepId) && state.steps[command.stepId].status === 'ACTIVE' && state.steps[command.stepId].attempt === command.attemptEpoch) attention.push({ code: 'UNKNOWN_DISPATCH', stepId: command.stepId });
  }
  return attention.sort((a, b) => compareStable(a.code, b.code) || compareStable(a.stepId ?? '', b.stepId ?? ''));
}

function deriveLists(state: MachineState, focusStepId?: string): {
  active: WorkfrontCapsule['active'];
  eligible: WorkfrontCapsule['eligible'];
  blocked: WorkfrontCapsule['blocked'];
  attention: WorkfrontCapsule['attention'];
} {
  const commandsByStep = new Map<string, OutboxCommand[]>();
  for (const command of Object.values(state.outbox)) {
    const commands = commandsByStep.get(command.stepId) ?? [];
    commands.push(command);
    commandsByStep.set(command.stepId, commands);
  }
  let neighborhood: Set<string> | undefined;
  if (focusStepId !== undefined) {
    // State projections are ordinary objects when recovered from JSON.  Do
    // not let inherited Object.prototype names such as `__proto__` or
    // `constructor` masquerade as a committed step.  A focused query for any
    // non-own key is an unknown identifier and must fail closed.
    if (!Object.prototype.hasOwnProperty.call(state.steps, focusStepId)) fail('focus step is unknown');
    const focus = state.steps[focusStepId];
    neighborhood = new Set([focusStepId, ...(focus.dependencies ?? [])]);
    for (const step of Object.values(state.steps)) if ((step.dependencies ?? []).includes(focusStepId)) neighborhood.add(step.stepId);
  }
  const active: WorkfrontCapsule['active'] = [];
  const eligible: WorkfrontCapsule['eligible'] = [];
  const blocked: WorkfrontCapsule['blocked'] = [];
  // One state pass owns the projection categories. In particular, dependency
  // waits are computed once per relevant step rather than once while filtering
  // and again while rendering the same blocked row.
  for (const step of Object.values(state.steps)) {
    if (step.status === 'ACTIVE') active.push({ stepId: step.stepId, attempt: step.attempt, dispatch: commandForStep(state, commandsByStep, step.stepId) });
    if (!['READY', 'BLOCKED', 'NEEDS-DECISION'].includes(step.status)) continue;
    const waitsFor = waitingFor(state, step.stepId);
    if (step.status === 'READY' && waitsFor.length === 0) eligible.push({ stepId: step.stepId });
    else if (waitsFor.length > 0 && (!neighborhood || neighborhood.has(step.stepId))) blocked.push({ stepId: step.stepId, reason: 'WAITING_DEPENDENCY', waitsFor });
  }
  stableSort(active, (item) => item.stepId);
  stableSort(eligible, (item) => item.stepId);
  stableSort(blocked, (item) => item.stepId);
  return { active, eligible, blocked, attention: allAttention(state) };
}

/** Pure bounded derivation from one already verified immutable state. */
export function deriveWorkfront(state: MachineState, options: WorkfrontOptions = {}): WorkfrontCapsule {
  // Production callers receive state only from FileArtifactStore.loadReadOnly,
  // the single common committed-state validator. This pure helper deliberately
  // does not create a second state-admission model.
  const limit = boundedLimit(options.limit);
  if (options.focusStepId !== undefined && (typeof options.focusStepId !== 'string' || options.focusStepId.length === 0)) fail('focusStepId must be a non-empty string');
  const lists = deriveLists(state, options.focusStepId);
  const capsule: WorkfrontCapsule = {
    schema: 'lunacy-workfront/v1',
    run: { runId: state.runId, phaseId: state.phaseId, revision: state.revision, planDigest: state.planDigest },
    summary: { status: state.status, gate: state.gate, barrier: state.barrier, nextAction: state.nextAction },
    active: lists.active.slice(0, limit),
    eligible: lists.eligible.slice(0, limit),
    blocked: lists.blocked.slice(0, limit),
    attention: lists.attention.slice(0, limit),
    truncation: { limit, active: lists.active.length > limit, eligible: lists.eligible.length > limit, blocked: lists.blocked.length > limit, attention: lists.attention.length > limit },
  };
  const bytes = Buffer.byteLength(canonicalString(capsule), 'utf8');
  if (bytes > OUTPUT_BYTE_CEILING) fail(`capsule exceeds ${OUTPUT_BYTE_CEILING}-byte output ceiling`);
  return capsule;
}

/**
 * Read one exact managed generation and derive the private Workfront capsule.
 * The store's read-only boundary performs all filesystem trust/fencing and
 * leaves the tree byte-for-byte untouched on success and failure.
 */
export async function inspectWorkfront(input: WorkfrontInput): Promise<WorkfrontCapsule> {
  if (!input || typeof input !== 'object' || !isCanonicalRootPath(input.kernelRoot)) fail('kernelRoot must be an absolute canonical path');
  if (typeof input.expectedRunId !== 'string' || input.expectedRunId.length === 0) fail('expectedRunId is required');
  const store = new FileArtifactStore(input.kernelRoot);
  const loaded = await store.loadReadOnly(input.expectedRunId);
  if (!loaded.state) fail('committed state is absent');
  return deriveWorkfront(loaded.state, { ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.focusStepId === undefined ? {} : { focusStepId: input.focusStepId }) });
}
