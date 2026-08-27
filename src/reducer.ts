import { canonicalString, digest } from './canonical.js';
import type { Event, EventIdentity, MachineState, OutboxCommand, Plan, Ref, Sha256 } from './model.js';
import { readySteps, validatePlan } from './validator.js';
import { acknowledge } from './outbox.js';
import { JOURNAL_BYTE_CEILING, JOURNAL_EVENT_CEILING } from './limits.js';
import { dependencyTerminal } from './dependency.js';

export type ReduceResult = { state: MachineState; outcome: 'WAITING' | 'PHASE_READY' | 'COMPLETE' | 'DECISION_REQUIRED' | 'BLOCKED'; reason?: string; token?: string; brief?: Ref; receipt?: Ref };

/**
 * A graph frame is deliberately a proposal.  The reducer accepts it only when
 * its post-event state/freshness proof still names the state being reduced;
 * otherwise it falls back to the mandatory direct evaluator.
 */
export type PreparedAdmission = Readonly<{
  candidateIds: readonly string[];
  planDigest: Sha256;
  graphDigest: Sha256;
  generation: number;
  baseStateDigest: Sha256 | null;
  baseRevision: number;
  baseJournalEnd: number;
  baseJournalDigest: Sha256;
  postStateDigest: Sha256;
  postRevision: number;
  postJournalEnd: number;
  postJournalDigest: Sha256;
  frontierIds: readonly string[];
  authorityEpoch: number;
  attemptEpoch: number;
  barrierEpoch: number;
  modeEpoch: number;
  writerFence: string;
  completeFrontierDigest: Sha256;
}>;

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
/** Per-event writer fence.  Keeping this distinct for each target generation
 * prevents a delayed writer with the same base state from publishing against
 * another writer's successful CAS. */
export function nextWriterFence(previous: string, targetGeneration: number, identity: EventIdentity): string {
  return digest({ previous, targetGeneration, runId: identity.runId, eventId: identity.eventId, payloadDigest: identity.payloadDigest }).slice(0, 24);
}
function activeClaims(state: MachineState) { return Object.values(state.steps).filter((s) => s.status === 'ACTIVE').flatMap((s) => s.claims ?? []); }
function allDone(state: MachineState): boolean { return Object.values(state.steps).every((s) => s.status === 'DONE'); }
function commandInCurrentFrame(state: MachineState, command: OutboxCommand): boolean {
  return command.attemptEpoch === state.attemptEpoch && command.authorityEpoch === state.authorityEpoch && command.barrierEpoch === state.barrierEpoch && command.modeEpoch === state.modeEpoch;
}
function inFlight(state: MachineState): OutboxCommand[] {
  return Object.values(state.outbox).filter((x) => x.state === 'PENDING' || x.state === 'CLAIMED' || x.state === 'UNKNOWN' || (x.state === 'ACKED' && commandInCurrentFrame(state, x) && state.steps[x.stepId]?.status === 'ACTIVE'));
}
function candidateSteps(plan: Plan, ids: readonly string[]): import('./model.js').PlanStep[] {
  const byId = new Map(plan.steps.map((step) => [step.stepId, step]));
  const seen = new Set<string>();
  const result: import('./model.js').PlanStep[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const step = byId.get(id);
    if (step) result.push(step);
  }
  return result;
}

function updateAdmission(state: MachineState, plan: Plan, maxInFlight: number, proposedIds?: readonly string[]): void {
  if (state.status !== 'ACTIVE' || state.barrier !== 'OPEN' || state.gate === 'DUE' || state.gate === 'FINDINGS') return;
  const slots = Math.max(0, maxInFlight - inFlight(state).length);
  if (!slots) return;
  const status = Object.fromEntries(Object.entries(state.steps).map(([k, v]) => [k, v.status]));
  // ON graph mode supplies an indexed, post-event frontier.  The reducer does
  // not rescan every dependency in that mode; it still checks the complete
  // candidate predicate below before creating any command.  An absent frame
  // is the ordinary mandatory direct path.
  const directClaims = proposedIds === undefined ? activeClaims(state) : undefined;
  const selected = proposedIds
    ? candidateSteps(plan, proposedIds).filter((step) => status[step.stepId] === 'READY' && (step.dependencies ?? []).every((dependency) => dependencyTerminal(status[dependency])))
    : readySteps(plan, status, directClaims!, slots);
  const accepted: typeof selected = [];
  for (const step of selected) {
    if (accepted.length >= slots) break;
    const claims = step.claims ?? [];
    const heldClaims = proposedIds === undefined ? directClaims! : activeClaims(state);
    if ([...heldClaims, ...accepted.flatMap((item) => item.claims ?? [])].some((held) => claims.some((claim) => {
      const names = new Set([claim.resource, ...(claim.aliases ?? [])]);
      const heldNames = new Set([held.resource, ...(held.aliases ?? [])]);
      const overlap = [...names].some((name) => [...heldNames].some((other) => name === other || name.startsWith(`${other}/`) || other.startsWith(`${name}/`)));
      return overlap && !(claim.mode === 'READ' && held.mode === 'READ');
    }))) continue;
    accepted.push(step);
  }
  for (const step of accepted) {
    const machine = state.steps[step.stepId];
    machine.status = 'ACTIVE'; machine.attempt = state.attemptEpoch; machine.lastEvent = 'admitted';
    const commandId = digest({ runId: state.runId, phaseId: state.phaseId, stepId: step.stepId, attemptEpoch: state.attemptEpoch }).slice(0, 32);
    const launchToken = `launch-${commandId}`;
    const commandDigest = digest({ commandId, runId: state.runId, phaseId: state.phaseId, stepId: step.stepId, attemptEpoch: state.attemptEpoch, launchToken });
    state.outbox[commandId] = { commandId, runId: state.runId, phaseId: state.phaseId, stepId: step.stepId, attemptEpoch: state.attemptEpoch, authorityEpoch: state.authorityEpoch, barrierEpoch: state.barrierEpoch, modeEpoch: state.modeEpoch, launchToken, commandDigest, state: 'PENDING' };
  }
}

function snapshotReason(state: MachineState): void {
  const pending = Object.values(state.outbox).some((x) => x.state === 'PENDING' || x.state === 'CLAIMED');
  const unknown = Object.values(state.outbox).some((x) => x.state === 'UNKNOWN');
  const acknowledged = Object.values(state.outbox).some((x) => x.state === 'ACKED' && commandInCurrentFrame(state, x) && state.steps[x.stepId]?.status === 'ACTIVE');
  state.nextAction = pending ? 'await-dispatch-receipt' : unknown ? 'await-dispatch-reconciliation' : acknowledged ? 'await-worker-envelope' : allDone(state) ? (state.gate === 'DUE' ? 'await-parent-gate-decision' : 'complete') : 'advance-ready-steps';
}

/** Append one authoritative event to the in-memory candidate state. */
export function appendJournal(state: MachineState, identity: EventIdentity, event: Event): void {
  if (!Number.isSafeInteger(state.revision + 1)) throw new Error('JournalCeiling');
  const entry = { identity: copy(identity), event: copy(event), digest: digest(event), revision: state.revision + 1 };
  const entryBytes = canonicalString(entry);
  const journalBytes = state.journal.length ? `${state.journal.map((item) => canonicalString(item)).join('\n')}\n` : '';
  if (state.journal.length >= JOURNAL_EVENT_CEILING || Buffer.byteLength(journalBytes) + Buffer.byteLength(entryBytes) + 1 > JOURNAL_BYTE_CEILING) throw new Error('JournalCeiling');
  state.journal.push(entry);
  state.revision += 1;
}

/** Recompute the bounded ready set after an internal dispatcher transition. */
export function refreshAdmission(state: MachineState, plan: Plan, maxInFlight: number): void {
  updateAdmission(state, plan, maxInFlight);
  snapshotReason(state);
}

/** Apply only the pure event delta.  No ready scan, command, or finality is
 * performed, making the resulting state suitable for post-event graph build. */
export function previewReduce(current: MachineState | undefined, plan: Plan, identity: EventIdentity, event: Event, admissionOk: boolean): ReduceResult {
  if (event.kind === 'START') {
    if (current) return { state: current, outcome: 'BLOCKED', reason: 'run already started' };
    if (!admissionOk) return { state: current as never, outcome: 'BLOCKED', reason: 'CrossRunUnproven' };
    const validated = validatePlan(plan);
    // The durable commit layer assigns the target-generation writer fence;
    // preview state stays an ordinary pre-CAS candidate.
    const state = createInitialState(String(identity.runId), validated.plan, digest(validated.plan), 'none');
    appendJournal(state, identity, event);
    return { state, outcome: 'WAITING' };
  }
  if (!current) return { state: current as never, outcome: 'BLOCKED', reason: 'run has not started' };
  const state = copy(current);
  if (!admissionOk && (event.kind === 'RESUME' || event.kind === 'OBSERVATION')) return { state: current, outcome: 'BLOCKED', reason: 'CrossRunUnproven' };
  if (event.kind === 'DISPATCH_RECEIPT') {
    try { applyDispatchReceipt(state, identity, event); }
    catch (error) { return { state: current, outcome: 'BLOCKED', reason: (error as Error).message.includes('already acknowledged') ? 'ReceiptAlreadyAcknowledged' : 'UnknownDispatch' }; }
  } else if (event.kind === 'WORKER_ENVELOPE') {
    const command = commandForToken(state, identity.launchToken);
    if (!command || command.state !== 'ACKED') {
      if (command) command.noEffectEvidence = [...(command.noEffectEvidence ?? []), event.ref];
      appendJournal(state, identity, event);
      return { state, outcome: 'DECISION_REQUIRED', reason: 'early or unmatched worker envelope', brief: event.ref, token: `evidence-${identity.eventId}` };
    }
    const step = state.steps[command.stepId];
    // A safely adopted authority may remove the old display node while its
    // immutable command identity remains in the outbox for late receipt
    // reconciliation.  Never remap that envelope to a new node; retain it as
    // no-effect evidence and ask the parent to reconcile the old identity.
    if (!step || !commandInCurrentFrame(state, command) || step.attempt !== command.attemptEpoch || step.status !== 'ACTIVE') {
      command.noEffectEvidence = [...(command.noEffectEvidence ?? []), event.ref];
      appendJournal(state, identity, event);
      return { state, outcome: 'DECISION_REQUIRED', reason: 'old worker envelope has no current execution frame', brief: event.ref, token: `evidence-${identity.eventId}` };
    }
    let payload: { status?: unknown };
    try { payload = JSON.parse(event.ref.bytes ?? '') as { status?: unknown }; }
    catch { return { state: current, outcome: 'BLOCKED', reason: 'malformed worker envelope' }; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.status !== 'string') return { state: current, outcome: 'BLOCKED', reason: 'malformed worker envelope' };
    if (payload.status !== 'DONE') { step.status = 'BLOCKED'; state.status = 'BLOCKED'; }
    else step.status = 'DONE';
  } else if (event.kind === 'OBSERVATION') {
    if (event.category === 'USER_CHANGE') return { state: current, outcome: 'DECISION_REQUIRED', brief: event.ref, token: `authority-${identity.eventId}` };
    if (event.category === 'RECOVERY' && event.ref.bytes) {
      let recovery: { launchToken?: unknown; status?: unknown; commandDigest?: unknown };
      try { recovery = JSON.parse(event.ref.bytes) as typeof recovery; }
      catch { return { state: current, outcome: 'BLOCKED', reason: 'malformed recovery evidence' }; }
      if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) || typeof recovery.launchToken !== 'string' || typeof recovery.status !== 'string' || typeof recovery.commandDigest !== 'string') return { state: current, outcome: 'BLOCKED', reason: 'malformed recovery evidence' };
      const command = Object.values(state.outbox).find((x) => x.launchToken === recovery.launchToken);
      if (command?.state === 'UNKNOWN' && recovery.status === 'NEVER_LAUNCHED' && recovery.commandDigest === command.commandDigest && identity.launchToken === command.launchToken) command.state = 'PENDING';
    }
  }
  appendJournal(state, identity, event);
  return { state, outcome: 'WAITING' };
}

export function commandForToken(state: MachineState, launchToken: string | undefined): OutboxCommand | undefined {
  if (!launchToken) return undefined;
  return Object.values(state.outbox).find((command) => command.launchToken === launchToken);
}

/**
 * Apply a private dispatcher receipt to an already claimed command.  The
 * caller has already checked the receipt envelope at the boundary; this
 * helper still rechecks the persisted command digest before mutating state.
 */
export function applyDispatchReceipt(state: MachineState, identity: EventIdentity, event: Extract<Event, { kind: 'DISPATCH_RECEIPT' }>): void {
  const command = commandForToken(state, identity.launchToken);
  if (!command) throw new Error('UnknownDispatch');
  let payload: { launchToken?: unknown; commandDigest?: unknown; receipt?: unknown };
  try { payload = JSON.parse(event.ref.bytes ?? '') as typeof payload; } catch { throw new Error('malformed dispatch receipt'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.launchToken !== 'string' || typeof payload.commandDigest !== 'string' || Object.keys(payload).some((key) => !['launchToken', 'commandDigest', 'receipt'].includes(key))) throw new Error('malformed dispatch receipt');
  const launchToken = payload.launchToken;
  const commandDigest = payload.commandDigest;
  if (launchToken !== command.launchToken || commandDigest !== command.commandDigest) throw new Error('receipt does not match launch token or command digest');
  if (command.state === 'ACKED') throw new Error('dispatch receipt already acknowledged');
  acknowledge(command, { launchToken, commandDigest, ref: event.ref });
}

export function createInitialState(runId: string, plan: Plan, planDigest: ReturnType<typeof digest>, writerFence: string): MachineState {
  const steps: MachineState['steps'] = Object.create(null) as MachineState['steps'];
  for (const s of plan.steps) steps[s.stepId] = { ...copy(s), dependencies: [...(s.dependencies ?? [])], claims: copy(s.claims ?? []), status: 'READY', attempt: 0 };
  return { schema: 1, runId, phaseId: plan.phaseId, revision: 0, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0, modeEpoch: 0, writerFence, status: 'ACTIVE', gate: 'NOT-DUE', barrier: 'OPEN', steps, outbox: {}, processed: {}, decisionTokens: {}, planDigest, nextAction: 'start', journal: [] };
}

export function reduce(current: MachineState | undefined, plan: Plan, identity: EventIdentity, event: Event, maxInFlight: number, admissionOk: boolean, prepared?: PreparedAdmission): ReduceResult {
  const preview = previewReduce(current, plan, identity, event, admissionOk);
  if (preview.outcome === 'BLOCKED' || preview.outcome === 'DECISION_REQUIRED') return preview;
  const state = preview.state;
  let proposedIds: readonly string[] | undefined;
  const baseFresh = current
    ? prepared?.baseStateDigest === digest(current) && prepared.baseRevision === current.revision && prepared.baseJournalEnd === current.journal.length && prepared.baseJournalDigest === digest(current.journal)
    : prepared?.baseStateDigest === null && prepared?.baseRevision === 0 && prepared?.baseJournalEnd === 0;
  if (prepared && baseFresh && prepared.planDigest === digest(plan) && state.status === 'ACTIVE' && state.barrier === 'OPEN' && prepared.graphDigest && digest([...prepared.frontierIds].sort()) === prepared.completeFrontierDigest && prepared.postStateDigest === digest(state) && prepared.postRevision === state.revision && prepared.postJournalEnd === state.journal.length && prepared.postJournalDigest === digest(state.journal) && prepared.authorityEpoch === state.authorityEpoch && prepared.attemptEpoch === state.attemptEpoch && prepared.barrierEpoch === state.barrierEpoch && prepared.modeEpoch === state.modeEpoch && prepared.writerFence === state.writerFence) {
    const candidateSet = new Set(prepared.candidateIds);
    const canonical = candidateSteps(plan, prepared.candidateIds);
    const frontierSet = new Set(prepared.frontierIds);
    const valid = candidateSet.size === prepared.candidateIds.length && canonical.length === prepared.candidateIds.length && prepared.frontierIds.every((id) => frontierSet.size === prepared.frontierIds.length && state.steps[id]?.status === 'READY' && (plan.steps.find((step) => step.stepId === id)?.dependencies ?? []).every((dependency) => dependencyTerminal(state.steps[dependency]?.status))) && prepared.candidateIds.every((id) => frontierSet.has(id)) && canonical.every((step) => state.steps[step.stepId]?.status === 'READY' && (step.dependencies ?? []).every((dependency) => dependencyTerminal(state.steps[dependency]?.status)));
    // The graph is only an optional index.  Even a self-consistent but
    // incomplete candidate list must not silently change admission semantics
    // (for example by under-admitting a ready sibling).  Compare its ordered
    // maximal selection with the mandatory direct evaluator and discard the
    // frame on any discrepancy.
    const slots = Math.max(0, maxInFlight - inFlight(state).length);
    const directIds = readySteps(plan, Object.fromEntries(Object.entries(state.steps).map(([key, value]) => [key, value.status])), activeClaims(state), slots).map((step) => step.stepId);
    const maximal = directIds.length === prepared.candidateIds.length && directIds.every((id, index) => id === prepared.candidateIds[index]);
    if (valid && maximal) proposedIds = prepared.candidateIds;
  }
  updateAdmission(state, plan, maxInFlight, proposedIds); snapshotReason(state);
  if (allDone(state) && inFlight(state).length === 0 && state.status === 'ACTIVE') {
    state.gate = 'DUE'; state.barrier = 'CLOSED'; state.barrierEpoch += 1; state.writerFence = digest({ writerFence: state.writerFence, barrierEpoch: state.barrierEpoch }).slice(0, 24); snapshotReason(state);
    const token = `gate-${state.revision}-${state.barrierEpoch}`;
    state.decisionTokens[token] = { kind: 'GATE', consumed: false, identity: digest(identity) };
    return { state, outcome: 'PHASE_READY', token };
  }
  return { state, outcome: 'WAITING' };
}

export function applyParentDecision(current: MachineState, identity: EventIdentity, token: string, value: unknown): ReduceResult {
  // Use an own-property check: a caller-supplied token such as "__proto__"
  // must not resolve to Object.prototype and mutate the decision map.
  if (!Object.prototype.hasOwnProperty.call(current.decisionTokens, token)) return { state: current, outcome: 'BLOCKED', reason: 'decision token already consumed or unknown' };
  const state = copy(current); const record = state.decisionTokens[token];
  if (!record || record.consumed) return { state: current, outcome: 'BLOCKED', reason: 'decision token already consumed or unknown' };
  // Invalid choices do not consume a one-shot token.  Consuming first would
  // let an untrusted value permanently strand a gate before the parent can
  // submit the only supported PASS/FINDINGS decision.
  if (record.kind !== 'GATE' || (value !== 'PASS' && value !== 'FINDINGS')) return { state: current, outcome: 'BLOCKED', reason: 'unsupported decision' };
  record.consumed = true;
  appendJournal(state, identity, { kind: 'PARENT_DECISION', token, value });
  if (value === 'PASS') { state.gate = 'PASS'; state.status = 'COMPLETE'; state.nextAction = 'complete'; return { state, outcome: 'COMPLETE' }; }
  // FINDINGS is a new mutable repair attempt, not a terminal blocked state.
  // Keep the old generation/report immutable by fencing the new attempt with
  // fresh attempt/barrier epochs and rebuilding only the step projection.
  state.gate = 'NOT-DUE'; state.status = 'ACTIVE'; state.barrier = 'OPEN';
  state.attemptEpoch += 1; state.barrierEpoch += 1;
  for (const step of Object.values(state.steps)) {
    step.status = 'READY'; step.attempt = state.attemptEpoch; delete step.lastEvent;
  }
  state.nextAction = 'advance-ready-steps';
  return { state, outcome: 'WAITING', reason: 'gate findings repair attempt opened' };
}

/**
 * Apply a parent-authorized authority adoption.  The caller has already
 * validated the live plan and checked that no old work is live.  This helper
 * deliberately keeps old outbox identities (including commands whose step was
 * removed) and rebuilds only the current attempt's step projection.
 */
export function applyAuthorityAdoption(current: MachineState, identity: EventIdentity, token: string, value: unknown, targetPlan: Plan, targetDigest: Sha256): ReduceResult {
  if (targetPlan.phaseId !== current.phaseId) return { state: current, outcome: 'BLOCKED', reason: 'phase fence mismatch' };
  if (!Object.prototype.hasOwnProperty.call(current.decisionTokens, token)) return { state: current, outcome: 'BLOCKED', reason: 'authority token unknown' };
  const state = copy(current);
  const record = state.decisionTokens[token];
  if (!record || record.kind !== 'AUTHORITY_ADOPTION' || record.consumed) return { state: current, outcome: 'BLOCKED', reason: 'authority token already consumed or unknown' };
  if (record.targetDigest !== targetDigest || record.observedDigest !== targetDigest) return { state: current, outcome: 'BLOCKED', reason: 'authority digest does not match acknowledged token' };
  const requested = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const requestedKind = typeof requested.kind === 'string' ? requested.kind : typeof requested.decision === 'string' ? requested.decision : undefined;
  const requestedDigest = typeof requested.digest === 'string' ? requested.digest : typeof requested.planDigest === 'string' ? requested.planDigest : typeof requested.authorityDigest === 'string' ? requested.authorityDigest : undefined;
  // The public boundary verifies raw-vs-normalized digest aliases against the
  // durable token.  The pure reducer only checks the decision verb here so
  // the original canonical parent event can be journaled byte-for-byte.
  if (!requestedKind || !['ADOPT', 'ADOPT_AUTHORITY', 'AUTHORITY_ADOPT'].includes(requestedKind)) return { state: current, outcome: 'BLOCKED', reason: 'unsupported authority adoption decision' };
  record.consumed = true;
  appendJournal(state, identity, { kind: 'PARENT_DECISION', token, value });
  state.authorityEpoch += 1;
  state.attemptEpoch += 1;
  state.barrierEpoch += 1;
  state.planDigest = targetDigest;
  state.status = 'ACTIVE'; state.gate = 'NOT-DUE'; state.barrier = 'OPEN';
  const steps: MachineState['steps'] = Object.create(null) as MachineState['steps'];
  for (const step of targetPlan.steps) {
    steps[step.stepId] = { ...copy(step), dependencies: [...(step.dependencies ?? [])], claims: copy(step.claims ?? []), status: 'READY', attempt: state.attemptEpoch };
  }
  state.steps = steps;
  // Old one-shot records remain immutable history but cannot be reused in the
  // new authority epoch.  Mark any unconsumed prior token as consumed rather
  // than deleting evidence from the durable state projection.
  for (const [priorToken, prior] of Object.entries(state.decisionTokens)) if (priorToken !== token && !prior.consumed) prior.consumed = true;
  state.nextAction = 'advance-ready-steps';
  return { state, outcome: 'WAITING', reason: 'authority adopted' };
}
