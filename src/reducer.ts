import { canonicalString, digest, parseCanonical } from './canonical.js';
import type { Event, EventIdentity, MachineState, OutboxCommand, Plan, Ref, Sha256, ManagedState, ManagedReservation, ManagedAttempt, ManagedAcceptedReport } from './model.js';
import type { ManagedCapability, ManagedRolloutPolicy, ManagedRolloutProjection } from './managed-capability.js';
import { createManagedCapability, projectManagedRolloutPolicy, reserveManaged, verifyManagedCapability, verifyManagedRolloutProjection } from './managed-capability.js';
import { readySteps, validatePlan } from './validator.js';
import { acknowledge, commandInCurrentFrame } from './outbox.js';
import { JOURNAL_BYTE_CEILING, JOURNAL_EVENT_CEILING } from './limits.js';
import { deriveTopology, isManagedDissent, reconcileWave, resolveWaveSemanticClosure, retainedDeliberationPolicy, settlementPrefixDigest, validateCurrentReportAdmission, validateReport, validateWave, type AcceptedReport, type DeliberationPolicy, type DeliberationReport, type DeliberationWave, type ReconcileResult } from './deliberation.js';
import { commandExecutionOwner } from './execution-plane.js';
import { isOneShotManagedCommand, isOneShotManagedDecision, ONE_SHOT_ROLLOUT_GENERATION_FLOOR, requestsManagedSuccessor } from './one-shot.js';

export type ReduceResult = { state: MachineState; outcome: 'WAITING' | 'PHASE_READY' | 'COMPLETE' | 'DECISION_REQUIRED' | 'BLOCKED'; reason?: string; token?: string; brief?: Ref; receipt?: Ref; launchToken?: string; deferAdmission?: boolean };
export type PreparedDecisionPublication = Readonly<{
  disposition: 'SELECTION' | 'SYNTHESIS' | 'WIDEN';
  settlementRef: Ref | null;
  lease: { leaseId: string; refs: Ref[]; expiresAt: number; status: 'ACTIVE' | 'PROMOTED' | 'EXPIRED' };
}>;

const ZERO_MANAGED_COUNTERS = (): ManagedState['waveCounters'] => ({ waves: 0, calls: 0, inTok: 0, outTok: 0, reportBytes: 0, refs: 0, persistedBytes: 0, deadline: Number.MAX_SAFE_INTEGER });

/** Deterministically lift a legacy state into the schema-2 private envelope.
 * The operation is pure; callers publish it through the existing store CAS. */
export function migrateMachineState(state: MachineState, capability?: ManagedCapability): MachineState {
  if (state.schema === 2) return copy(state);
  const cap = capability ?? createManagedCapability();
  return { ...copy(state), schema: 2, managed: { capability: cap, killSwitch: false, waveCounters: ZERO_MANAGED_COUNTERS(), reservations: {}, leaseSets: {}, attempts: {}, acceptedReports: {}, settlements: {}, settlementOrigins: {} } };
}

/** Apply a rollout generation in the existing schema-2 state CAS. Exact
 * replay is inert; rollback is represented only by a strictly newer policy. */
export function applyManagedRolloutPolicy(state: MachineState, capability: ManagedCapability, policy: ManagedRolloutPolicy): MachineState {
  const next = migrateMachineState(state, capability);
  const incoming = projectManagedRolloutPolicy(policy);
  const current = next.managed!.rollout;
  if (current) {
    if (!verifyManagedRolloutProjection(current)) throw new Error('managed rollout policy is invalid');
    if (incoming.generation < current.generation) throw new Error('managed rollout generation regressed');
    if (incoming.generation === current.generation) {
      if (incoming.digest !== current.digest || incoming.mode !== current.mode) throw new Error('managed rollout generation conflicts');
      return next;
    }
  }
  next.managed!.rollout = { ...incoming };
  if (!next.managed!.rolloutOrigin && incoming.mode !== 'disabled') next.managed!.rolloutOrigin = { ...incoming };
  return next;
}

function managedOrigin(managed: ManagedState): ManagedRolloutProjection | undefined {
  return managed.rolloutOrigin ? { ...managed.rolloutOrigin } : undefined;
}

/** Bind the managed envelope and reserve a complete maximum for each newly
 * admitted command.  A failed all-dimension reservation removes that command
 * before any outbox/provider call, leaving the step READY and inert. */
export function applyManagedReservations(state: MachineState, capability: ManagedCapability): boolean {
  const lifted = state.schema === 2 && state.managed ? state : migrateMachineState(state, capability);
  state.schema = 2; state.managed = lifted.managed;
  const managed = state.managed!;
  managed.attempts ??= {};
  managed.acceptedReports ??= {};
  if (state.schema === 2 && managed.capability !== capability) {
    if (!verifyManagedCapability(managed.capability) || managed.capability.checksum !== capability.checksum) throw new Error('managed capability conflicts');
  }
  managed.capability = capability;
  let ok = true;
  const ceilings = capability.ceilings;
  const isReservable = (command: OutboxCommand): boolean => {
    const step = state.steps[command.stepId];
    return command.attemptEpoch === state.attemptEpoch
      && command.authorityEpoch === state.authorityEpoch
      && command.barrierEpoch === state.barrierEpoch
      && command.modeEpoch === state.modeEpoch
      && Boolean(step && step.status === 'ACTIVE')
      && command.state !== 'ACKED'
      && commandExecutionOwner(state, command) === 'DELIBERATION';
  };
  // A zero-wave capability is a valid closed descriptor but cannot admit any
  // command. Remove unreserved candidates before publication rather than
  // persisting a counter that would exceed its ceiling.
  if (ceilings.waves === 0) {
    for (const command of Object.values(state.outbox)) {
      if (managed.reservations[command.commandId] || !isReservable(command)) continue;
      const step = state.steps[command.stepId]; if (step) { step.status = 'READY'; step.lastEvent = 'reservation-rejected'; }
      delete state.outbox[command.commandId];
      ok = false;
    }
    return ok;
  }
  for (const command of Object.values(state.outbox)) {
    if (managed.reservations[command.commandId]) continue;
    const step = state.steps[command.stepId];
    // Schema-1 migration deliberately preserves the complete historical
    // outbox.  Only live work in the exact current frame can become a managed
    // reservation; retroactively charging an ACKED predecessor would create a
    // LIVE managed attempt bound to an inert command and make the next CAS
    // malformed (notably when targeted FINDINGS opens a repair epoch).
    if (!step || !isReservable(command)) continue;
    // Reserve a conservative per-command slice rather than charging the
    // entire wave ceiling to every command.  Calls remain one per command;
    // each bounded dimension is ceil-divided by the advertised call budget,
    // so at most the configured number of commands can fit and rounding can
    // only leave capacity unused (never over-admit it).
    const slots = Math.max(1, ceilings.calls);
    // Allocate each additive ceiling with a stable quotient/remainder split.
    // Reservation insertion order is the durable command ordinal, so replay
    // assigns the same shares and the first N admitted commands sum exactly to
    // the advertised ceiling (ceil-dividing every command could strand the
    // final slot on non-divisible budgets).
    const ordinal = Object.keys(managed.reservations).length;
    const perCommand = (value: number): number => {
      if (value === 0) return 0;
      const quotient = Math.floor(value / slots);
      const remainder = value % slots;
      return quotient + (ordinal < remainder ? 1 : 0);
    };
    const request = {
      waves: 0,
      calls: 1,
      inTok: perCommand(ceilings.inTok),
      outTok: perCommand(ceilings.outTok),
      reportBytes: perCommand(ceilings.reportBytes),
      refs: perCommand(ceilings.refs),
      persistedBytes: perCommand(ceilings.persistedBytes),
      deadline: ceilings.deadline,
    };
    const current = managed.waveCounters;
    const next = reserveManaged(current, request);
    if (!next || next.waves > ceilings.waves || next.calls > ceilings.calls || next.inTok > ceilings.inTok || next.outTok > ceilings.outTok || next.reportBytes > ceilings.reportBytes || next.refs > ceilings.refs || next.persistedBytes > ceilings.persistedBytes) {
      ok = false;
      step.status = 'READY'; step.lastEvent = 'reservation-rejected';
      delete state.outbox[command.commandId];
      continue;
    }
    managed.waveCounters = next;
    const reservation: ManagedReservation = { reservationId: command.commandId, commandId: command.commandId, epoch: command.attemptEpoch, charged: true, ...request };
    managed.reservations[command.commandId] = reservation;
    const priorAttempt = managed.attempts[command.commandId];
    if (!priorAttempt) {
      managed.attempts[command.commandId] = {
        commandId: command.commandId,
        epoch: command.attemptEpoch,
        reservationId: reservation.reservationId,
        status: command.state === 'UNKNOWN' ? 'UNKNOWN' : 'LIVE',
        ...(managedOrigin(managed) ? { rolloutOrigin: managedOrigin(managed) } : {}),
      };
    } else if (priorAttempt.epoch !== command.attemptEpoch || priorAttempt.reservationId !== reservation.reservationId) {
      throw new Error('managed attempt conflicts');
    }
  }
  if (managed.waveCounters.waves === 0 && Object.keys(managed.reservations).length > 0) managed.waveCounters = { ...managed.waveCounters, waves: 1 };
  if (!ok && Object.values(state.outbox).every((command) => command.state === 'ACKED')) state.nextAction = 'advance-ready-steps';
  return ok;
}

export function bindManagedProposal(state: MachineState, capability: ManagedCapability, proposal: { key: Sha256; waveRef: Ref; roleWaveRef?: Ref; planDigest: Sha256; leaseSetId: string }): MachineState {
  const next = migrateMachineState(state, capability);
  if (next.managed!.proposal) {
    const prior = next.managed!.proposal;
    if (prior.key !== proposal.key || prior.planDigest !== proposal.planDigest || prior.leaseSetId !== proposal.leaseSetId || canonicalString(prior.waveRef) !== canonicalString(proposal.waveRef)
      || canonicalString(prior.roleWaveRef ?? null) !== canonicalString(proposal.roleWaveRef ?? null)) throw new Error('managed proposal conflicts');
  } else next.managed!.proposal = { ...proposal, waveRef: { ...proposal.waveRef }, ...(proposal.roleWaveRef ? { roleWaveRef: { ...proposal.roleWaveRef } } : {}), ...(managedOrigin(next.managed!) ? { rolloutOrigin: managedOrigin(next.managed!) } : {}) };
  applyManagedReservations(next, capability);
  return next;
}

/** @deprecated Kept as a no-op for old private fixtures. Format authority is
 * now carried explicitly through reducer/store options; this marker never
 * influences admission or publication. */
export function markUnboundedJournal(_state: MachineState): void { /* compatibility no-op */ }
/** @deprecated See markUnboundedJournal. */
export function isUnboundedJournal(_state: MachineState): boolean { return false; }
/** @deprecated See markUnboundedJournal. */
export function clearUnboundedJournal(_state: MachineState): void { /* compatibility no-op */ }

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
/** Per-event writer fence.  Keeping this distinct for each target generation
 * prevents a delayed writer with the same base state from publishing against
 * another writer's successful CAS. */
export function nextWriterFence(previous: string, targetGeneration: number, identity: EventIdentity): string {
  return digest({ previous, targetGeneration, runId: identity.runId, eventId: identity.eventId, payloadDigest: identity.payloadDigest }).slice(0, 24);
}
function activeClaims(state: MachineState) { return Object.values(state.steps).filter((s) => s.status === 'ACTIVE').flatMap((s) => s.claims ?? []); }
function allDone(state: MachineState): boolean { return Object.values(state.steps).every((s) => s.status === 'DONE'); }

type ManagedReportPrefix = { waveRef: Ref; result: ReconcileResult };

/** Keep the private policy derivation deliberately narrow.  Report/v2 carries
 * the bound policy Ref, while all role validation that matters to the prefix
 * is performed by deliberation.ts. Explore's frame tags are only needed when
 * validating a Wave; the authored five-frame shape is deterministic (four
 * code/design frames followed by one wild frame). */
function parseManagedWave(ref: Ref, state: MachineState): { ref: Ref; wave: DeliberationWave; policy: DeliberationPolicy } | undefined {
  try {
    if (typeof ref.bytes !== 'string' || ref.scope !== 'deliberation/wave') return undefined;
    const wave = parseCanonical<DeliberationWave>(ref.bytes);
    const policy = retainedDeliberationPolicy(wave);
    const closure = resolveWaveSemanticClosure(wave); if (!closure.ok) return undefined;
    const valid = validateWave(wave, {
      runId: state.runId,
      phaseId: state.phaseId,
      policy,
      committedEvidence: closure.value.committedEvidence,
      reachableConstraints: closure.value.reachableConstraints,
    });
    if (!valid.ok || digest(wave) !== ref.digest) return undefined;
    return { ref: { ...ref }, wave: valid.value, policy };
  } catch { return undefined; }
}

function managedReportRefEqual(a: Ref, b: Ref): boolean {
  return canonicalString(a) === canonicalString(b);
}

function managedAcceptedRows(state: MachineState): ManagedAcceptedReport[] {
  const rows = Object.values(state.managed?.acceptedReports ?? {});
  return rows.filter((row) => {
    const command = state.outbox[row.commandId];
    return command?.state === 'ACKED'
      && command.attemptEpoch === state.attemptEpoch
      && command.authorityEpoch === state.authorityEpoch
      && command.barrierEpoch === state.barrierEpoch
      && command.modeEpoch === state.modeEpoch
      && row.attemptEpoch === state.attemptEpoch
      && row.authorityEpoch === state.authorityEpoch
      && row.barrierEpoch === state.barrierEpoch
      && row.modeEpoch === state.modeEpoch;
  });
}

function managedReportPrefix(state: MachineState, candidate?: ManagedAcceptedReport): ManagedReportPrefix | undefined {
  const rows = managedAcceptedRows(state);
  if (candidate) rows.push(candidate);
  if (!rows.length) return undefined;
  if (rows.some((row) => !managedAcceptedAuthorityIsValid(state, row))) return undefined;
  const firstWave = rows[0].report.wave;
  const context = parseManagedWave(firstWave, state);
  if (!context) return undefined;
  if (rows.some((row) => !managedReportRefEqual(row.report.wave, context.ref))) return undefined;
  const accepted: AcceptedReport[] = rows.map((row) => ({ ref: { ...row.ref }, report: row.report, receipt: { ...row.receipt } }));
  const result = reconcileWave(context.ref, context.wave, accepted);
  return { waveRef: context.ref, result };
}

function managedReceiptAuthorityAnchor(value: unknown, commandDigest: string, reportDigest: string): Ref | undefined {
  try {
    validateManagedRef(value);
    const anchor = value as Ref;
    if (anchor.scope !== 'outbox/managed-receipt-authority' || anchor.id !== `managed-receipt-authority:${commandDigest}:${anchor.digest}`) return undefined;
    const payload = parseCanonical<Record<string, unknown>>(anchor.bytes!);
    if (Object.keys(payload).sort().join(',') !== 'commandDigest,receiptDigest,reportDigest,schema,teardown,transport'
      || payload.schema !== 'lunacy-managed-receipt-authority/v1' || payload.commandDigest !== commandDigest || payload.reportDigest !== reportDigest
      || typeof payload.receiptDigest !== 'string' || !/^[0-9a-f]{64}$/.test(payload.receiptDigest)) return undefined;
    validateManagedRef(payload.transport); validateManagedRef(payload.teardown);
    if ((payload.transport as Ref).scope !== 'outbox/model-transport' || (payload.teardown as Ref).scope !== 'outbox/teardown') return undefined;
    return anchor;
  } catch { return undefined; }
}

function dispatchResultProof(command: OutboxCommand): { receipt: Ref; authorityAnchor?: Ref } | undefined {
  if (!command.receipt?.bytes) return undefined;
  try {
    const proof = parseCanonical<{ launchToken: string; commandDigest: string; receipt?: Ref; authorityAnchor?: Ref }>(command.receipt.bytes);
    if (proof.launchToken !== command.launchToken || proof.commandDigest !== command.commandDigest || !proof.receipt) return undefined;
    validateManagedRef(proof.receipt);
    if (command.roleView && proof.receipt.id !== `managed-report:${command.roleView.digest}:${proof.receipt.digest}`) return undefined;
    const authorityAnchor = proof.authorityAnchor === undefined ? undefined : managedReceiptAuthorityAnchor(proof.authorityAnchor, command.commandDigest, proof.receipt.digest);
    if (command.roleView && !authorityAnchor || !command.roleView && proof.authorityAnchor !== undefined) return undefined;
    return { receipt: proof.receipt, ...(authorityAnchor ? { authorityAnchor } : {}) };
  } catch { return undefined; }
}

function dispatchResultRef(command: OutboxCommand): Ref | undefined { return dispatchResultProof(command)?.receipt; }

function managedAcceptedAuthorityIsValid(state: MachineState, row: ManagedAcceptedReport): boolean {
  const command = state.outbox[row.commandId];
  if (!command?.roleView) return row.authorityAnchor === undefined && row.receipt.authorityAnchorDigest === undefined;
  const proof = dispatchResultProof(command);
  const attemptAnchor = state.managed?.attempts?.[row.commandId]?.authorityAnchor;
  return Boolean(proof?.authorityAnchor && attemptAnchor && row.authorityAnchor
    && row.receipt.authorityAnchorDigest === row.authorityAnchor.digest
    && canonicalString(proof.authorityAnchor) === canonicalString(attemptAnchor)
    && canonicalString(attemptAnchor) === canonicalString(row.authorityAnchor));
}

/** Validate and project one worker Report/v2 only after receipt success and
 * current-frame checks.  The projection is the sole source consumed by
 * reconcileWave; raw WORKER_ENVELOPE journal bytes never form a prefix. */
function acceptManagedReport(state: MachineState, command: OutboxCommand, identity: EventIdentity, event: Extract<Event, { kind: 'WORKER_ENVELOPE' }>): ManagedAcceptedReport | undefined {
  if (command.state !== 'ACKED' || !commandInCurrentFrame(state, command)
    || identity.attemptEpoch !== command.attemptEpoch
    || identity.authorityEpoch !== command.authorityEpoch
    || identity.barrierEpoch !== command.barrierEpoch
    || identity.launchToken !== command.launchToken) return undefined;
  const proof = dispatchResultProof(command);
  const receiptRef = proof?.receipt;
  if (!receiptRef || receiptRef.digest !== event.ref.digest || receiptRef.scope !== 'deliberation/report') return undefined;
  try {
    validateManagedRef(event.ref);
    if (event.ref.scope !== 'deliberation/report') return undefined;
    const report = parseCanonical<DeliberationReport>(event.ref.bytes ?? '');
    if (!report || report.schema !== 'lunacy-deliberation-report/v2' || !report.wave || !Number.isSafeInteger(report.slotOrdinal)) return undefined;
    const waveContext = parseManagedWave(report.wave, state);
    if (!waveContext) return undefined;
    const topology = deriveTopology(waveContext.ref, waveContext.wave);
    const slot = topology.slots.find((candidate) => candidate.slotOrdinal === report.slotOrdinal);
    if (!slot || slot.stepId !== command.stepId) return undefined;
    const predecessorReportDigests: Sha256[] = []; const predecessorReports: DeliberationReport[] = [];
    for (const dependencyOrdinal of slot.dependencies) {
      const matching = Object.values(state.managed?.acceptedReports ?? {}).filter((row) => row.report.slotOrdinal === dependencyOrdinal
        && managedReportRefEqual(row.report.wave, waveContext.ref)
        && row.attemptEpoch === command.attemptEpoch && row.authorityEpoch === command.authorityEpoch
        && row.barrierEpoch === command.barrierEpoch && row.modeEpoch === command.modeEpoch);
      if (matching.length !== 1) return undefined;
      predecessorReportDigests.push(matching[0].ref.digest);
      predecessorReports.push(matching[0].report);
    }
    if (command.roleView && (typeof command.roleView.bytes !== 'string' || command.roleView.scope !== 'deliberation/role-view'
      || !Array.isArray(command.predecessorReportDigests) || canonicalString(predecessorReportDigests) !== canonicalString(command.predecessorReportDigests))) return undefined;
    const attemptAnchor = state.managed?.attempts?.[command.commandId]?.authorityAnchor;
    if (command.roleView && (!proof?.authorityAnchor || !attemptAnchor || canonicalString(proof.authorityAnchor) !== canonicalString(attemptAnchor))) return undefined;
    const origin = state.managed?.proposal?.rolloutOrigin;
    if (origin && origin.generation >= ONE_SHOT_ROLLOUT_GENERATION_FLOOR) {
      const managedOrigin = state.managed?.rolloutOrigin; const attemptOrigin = state.managed?.attempts?.[command.commandId]?.rolloutOrigin;
      if (!managedOrigin || !attemptOrigin || canonicalString(origin) !== canonicalString(managedOrigin) || canonicalString(origin) !== canonicalString(attemptOrigin)) return undefined;
    }
    const contextual = validateCurrentReportAdmission(report, {
      waveRef: waveContext.ref, wave: waveContext.wave, slot, predecessors: predecessorReports, policy: waveContext.policy,
      roleView: command.roleView, rolloutGeneration: origin?.generation, rolloutFloor: ONE_SHOT_ROLLOUT_GENERATION_FLOOR,
    });
    if (!contextual.ok) return undefined;
    const row: ManagedAcceptedReport = {
      ref: { ...event.ref },
      report: contextual.value,
      commandId: command.commandId,
      ...(command.roleView ? { roleDigest: command.roleView.digest, predecessorReportDigests, authorityAnchor: { ...proof!.authorityAnchor! } } : {}),
      receipt: { commandDigest: command.commandDigest, resultDigest: event.ref.digest, attemptEpoch: command.attemptEpoch, ...(proof?.authorityAnchor ? { authorityAnchorDigest: proof.authorityAnchor.digest } : {}) },
      attemptEpoch: command.attemptEpoch,
      authorityEpoch: command.authorityEpoch,
      barrierEpoch: command.barrierEpoch,
      modeEpoch: command.modeEpoch,
      ...(state.managed?.proposal?.rolloutOrigin ? { rolloutOrigin: { ...state.managed.proposal.rolloutOrigin } } : {}),
    };
    const prefix = managedReportPrefix(state, row);
    if (!prefix || (prefix.result.architecture !== 'MISSING' && prefix.result.architecture !== 'COMPLETE')
      || !prefix.result.refs.some((ref) => managedReportRefEqual(ref, event.ref))) return undefined;
    const validated = prefix.result.reports.find((item) => digest(item) === event.ref.digest);
    if (!validated) return undefined;
    row.report = validated;
    return row;
  } catch { return undefined; }
}

function managedAcceptedReportRefs(state: MachineState): ManagedReportPrefix | undefined {
  const prefix = managedReportPrefix(state);
  return prefix?.result.architecture === 'COMPLETE' ? prefix : undefined;
}

/** Recheck the exact immutable accepted rows captured by a token.  The rows
 * may be historical after the barrier/attempt increments, so this check is
 * intentionally independent of the current execution frame. */
function managedTokenPrefix(state: MachineState, record: import('./model.js').DecisionToken): ManagedReportPrefix | undefined {
  if (!record.waveRef || !record.orderedReportRefs) return undefined;
  const context = parseManagedWave(record.waveRef, state);
  if (!context) return undefined;
  const rowsByDigest = state.managed?.acceptedReports ?? {};
  const rows: ManagedAcceptedReport[] = [];
  for (const ref of record.orderedReportRefs) {
    const row = rowsByDigest[ref.digest];
    if (!row || !managedReportRefEqual(row.ref, ref)) return undefined;
    const command = state.outbox[row.commandId];
    if (!command || command.state !== 'ACKED' || command.commandDigest !== row.receipt.commandDigest || row.receipt.resultDigest !== row.ref.digest) return undefined;
    const proof = dispatchResultProof(command);
    const receiptRef = proof?.receipt;
    if (!receiptRef || !managedReportRefEqual(receiptRef, row.ref)) return undefined;
    if (!managedAcceptedAuthorityIsValid(state, row)) return undefined;
    rows.push(row);
  }
  const result = reconcileWave(context.ref, context.wave, rows.map((row) => ({ ref: { ...row.ref }, report: row.report, receipt: { ...row.receipt } })));
  if (result.architecture !== 'COMPLETE' || result.refs.length !== record.orderedReportRefs.length || result.refs.some((ref, index) => !managedReportRefEqual(ref, record.orderedReportRefs![index]))) return undefined;
  return { waveRef: context.ref, result };
}

function validateManagedRef(value: unknown): asserts value is Ref {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ref malformed');
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !['id', 'digest', 'scope', 'bytes'].includes(key)) || typeof candidate.id !== 'string' || candidate.id.length === 0 || typeof candidate.digest !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.digest) || typeof candidate.bytes !== 'string') throw new Error('ref malformed');
  const parsed = JSON.parse(candidate.bytes);
  if (canonicalString(parsed) !== candidate.bytes || digest(parsed) !== candidate.digest) throw new Error('ref malformed');
}
function inFlight(state: MachineState): OutboxCommand[] {
  return Object.values(state.outbox).filter((x) => (x.state === 'PENDING' || x.state === 'CLAIMED' || (x.state === 'UNKNOWN' && commandInCurrentFrame(state, x))) || (x.state === 'ACKED' && commandInCurrentFrame(state, x) && state.steps[x.stepId]?.status === 'ACTIVE'));
}
function updateAdmission(state: MachineState, plan: Plan, maxInFlight: number): void {
  if (state.status !== 'ACTIVE' || state.barrier !== 'OPEN' || state.gate === 'DUE' || state.gate === 'FINDINGS') return;
  const slots = Math.max(0, maxInFlight - inFlight(state).length);
  if (!slots) return;
  const status = Object.fromEntries(Object.entries(state.steps).map(([k, v]) => [k, v.status]));
  const directClaims = activeClaims(state);
  const selected = readySteps(plan, status, directClaims, slots);
  const accepted: typeof selected = [];
  for (const step of selected) {
    if (accepted.length >= slots) break;
    const claims = step.claims ?? [];
    const heldClaims = directClaims;
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
export function appendJournal(state: MachineState, identity: EventIdentity, event: Event, allowUnbounded = false): void {
  if (!Number.isSafeInteger(state.revision + 1)) throw new Error('JournalCeiling');
  const entry = { identity: copy(identity), event: copy(event), digest: digest(event), revision: state.revision + 1 };
  const entryBytes = canonicalString(entry);
  const unbounded = allowUnbounded;
  const journalBytes = unbounded ? '' : (state.journal.length ? `${state.journal.map((item) => canonicalString(item)).join('\n')}\n` : '');
  if (!unbounded && (state.journal.length >= JOURNAL_EVENT_CEILING || Buffer.byteLength(journalBytes) + Buffer.byteLength(entryBytes) + 1 > JOURNAL_BYTE_CEILING)) throw new Error('JournalCeiling');
  state.journal.push(entry);
  state.revision += 1;
}

/** Recompute the bounded ready set after an internal dispatcher transition. */
export function refreshAdmission(state: MachineState, plan: Plan, maxInFlight: number): void {
  updateAdmission(state, plan, maxInFlight);
  snapshotReason(state);
}

/** Apply only the pure event delta. Admission and finality follow from this
 * exact journal-ordered state in the exported reducer. */
function reduceEvent(current: MachineState | undefined, plan: Plan, identity: EventIdentity, event: Event, admissionOk: boolean, allowUnbounded = false): ReduceResult {
  if (event.kind === 'START') {
    if (current) return { state: current, outcome: 'BLOCKED', reason: 'run already started' };
    if (!admissionOk) return { state: current as never, outcome: 'BLOCKED', reason: 'CrossRunUnproven' };
    const validated = validatePlan(plan);
    // The durable commit layer assigns the target-generation writer fence;
    // preview state stays an ordinary pre-CAS candidate.
    const state = createInitialState(String(identity.runId), validated.plan, digest(validated.plan), 'none');
    appendJournal(state, identity, event, allowUnbounded);
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
      appendJournal(state, identity, event, allowUnbounded);
      return { state, outcome: 'DECISION_REQUIRED', reason: 'early or unmatched worker envelope', brief: event.ref, token: `evidence-${identity.eventId}` };
    }
    const step = state.steps[command.stepId];
    // A safely adopted authority may remove the old display node while its
    // immutable command identity remains in the outbox for late receipt
    // reconciliation.  Never remap that envelope to a new node; retain it as
    // no-effect evidence and ask the parent to reconcile the old identity.
    if (!step || !commandInCurrentFrame(state, command) || step.attempt !== command.attemptEpoch || step.status !== 'ACTIVE') {
      command.noEffectEvidence = [...(command.noEffectEvidence ?? []), event.ref];
      appendJournal(state, identity, event, allowUnbounded);
      return { state, outcome: 'DECISION_REQUIRED', reason: 'old worker envelope has no current execution frame', brief: event.ref, token: `evidence-${identity.eventId}` };
    }
    let payload: { status?: unknown; schema?: unknown };
    try { payload = parseCanonical(event.ref.bytes ?? '') as { status?: unknown; schema?: unknown }; }
    catch { return { state: current, outcome: 'BLOCKED', reason: 'malformed worker envelope' }; }
    // Ordinary schema-1/direct execution keeps its compact status envelope.
    // Managed schema-2 execution must project a receipt-bound Report/v2 row;
    // a status placeholder is deliberately inert and cannot close a prefix.
    if (command.roleView) {
      if (!state.managed) return { state: current, outcome: 'BLOCKED', reason: 'managed Report command has no managed state' };
      const accepted = acceptManagedReport(state, command, identity, event);
      if (!accepted) return { state: current, outcome: 'BLOCKED', reason: 'accepted Report/v2 is invalid or receipt-bound prefix is incomplete' };
      state.managed.acceptedReports ??= {};
      const prior = state.managed.acceptedReports[accepted.ref.digest];
      if (prior && canonicalString(prior) !== canonicalString(accepted)) return { state: current, outcome: 'BLOCKED', reason: 'accepted Report/v2 conflicts with prior immutable row' };
      if (prior && prior.commandId !== accepted.commandId) return { state: current, outcome: 'BLOCKED', reason: 'accepted Report/v2 is duplicated across commands' };
      state.managed.acceptedReports[accepted.ref.digest] = accepted;
      step.status = 'DONE';
    } else {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.status !== 'string') return { state: current, outcome: 'BLOCKED', reason: 'malformed worker envelope' };
      if (payload.status !== 'DONE') { step.status = 'BLOCKED'; state.status = 'BLOCKED'; }
      else step.status = 'DONE';
    }
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
  appendJournal(state, identity, event, allowUnbounded);
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
  let payload: { launchToken?: unknown; commandDigest?: unknown; receipt?: unknown; authorityAnchor?: unknown };
  try { payload = JSON.parse(event.ref.bytes ?? '') as typeof payload; } catch { throw new Error('malformed dispatch receipt'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.launchToken !== 'string' || typeof payload.commandDigest !== 'string' || Object.keys(payload).some((key) => !['launchToken', 'commandDigest', 'receipt', 'authorityAnchor'].includes(key))) throw new Error('malformed dispatch receipt');
  const launchToken = payload.launchToken;
  const commandDigest = payload.commandDigest;
  if (launchToken !== command.launchToken || commandDigest !== command.commandDigest) throw new Error('receipt does not match launch token or command digest');
  if (command.state === 'ACKED') throw new Error('dispatch receipt already acknowledged');
  const managedAttempt = state.managed?.attempts?.[command.commandId];
  if (managedAttempt && ['TIMED_OUT', 'CANCELLED', 'FAILED'].includes(managedAttempt.status)) throw new Error('RetiredAttempt');
  const resultRef = payload.receipt as Ref | undefined;
  const authorityAnchor = command.roleView && resultRef ? managedReceiptAuthorityAnchor(payload.authorityAnchor, command.commandDigest, resultRef.digest) : undefined;
  if (command.roleView && (!authorityAnchor || !managedAttempt || !state.managed?.proposal)) throw new Error('managed receipt authority anchor is missing');
  if (!command.roleView && payload.authorityAnchor !== undefined) throw new Error('managed receipt authority anchor is unexpected');
  if (authorityAnchor) {
    if (managedAttempt!.authorityAnchor && canonicalString(managedAttempt!.authorityAnchor) !== canonicalString(authorityAnchor)) throw new Error('managed receipt authority anchor conflicts');
    const proposalLease = state.managed!.leaseSets[state.managed!.proposal!.leaseSetId];
    if (!proposalLease) throw new Error('managed receipt authority lease is missing');
    const anchors = proposalLease.closedRefGraph.filter((ref) => ref.scope === 'outbox/managed-receipt-authority');
    if (anchors.some((ref) => ref.id === authorityAnchor.id && canonicalString(ref) !== canonicalString(authorityAnchor))) throw new Error('managed receipt authority graph conflicts');
    if (!anchors.some((ref) => canonicalString(ref) === canonicalString(authorityAnchor))) proposalLease.closedRefGraph.push({ ...authorityAnchor });
    managedAttempt!.authorityAnchor = { ...authorityAnchor };
  }
  acknowledge(command, { launchToken, commandDigest, ref: event.ref });
  if (managedAttempt) {
    if (managedAttempt.status === 'SUCCESS') {
      if (managedAttempt.resultDigest !== event.ref.digest) throw new Error('attempt receipt digest conflicts');
    } else if (managedAttempt.status === 'UNKNOWN' || managedAttempt.status === 'LIVE') {
      managedAttempt.status = 'SUCCESS';
      managedAttempt.receipt = { ...event.ref };
      managedAttempt.resultDigest = event.ref.digest as Sha256;
    } else {
      throw new Error('attempt is retired');
    }
  }
}

/** Retire an ambiguous managed attempt and open a distinct fresh epoch.  The
 * old outbox/attempt remains immutable historical evidence; only the step
 * projection is reset and admission may create a new command after the
 * caller's all-dimension reservation gate. */
export function retireManagedAttempt(current: MachineState, identity: EventIdentity, token: string, plan: Plan, maxInFlight: number, status: 'TIMED_OUT' | 'CANCELLED' | 'FAILED' = 'TIMED_OUT', allowUnbounded = false, providerIntent?: import('./driver.js').ProviderIntentFenceObservation): ReduceResult {
  if (current.schema !== 2 || !current.managed) return { state: current, outcome: 'BLOCKED', reason: 'managed attempt unavailable' };
  const state = copy(current);
  const managed = state.managed!;
  const command = commandForToken(state, token);
  if (!command || command.state !== 'UNKNOWN') return { state: current, outcome: 'BLOCKED', reason: 'attempt is not UNKNOWN' };
  if (commandExecutionOwner(state, command) !== 'DELIBERATION') return { state: current, outcome: 'BLOCKED', reason: 'command is not managed deliberation work' };
  const attempt = managed.attempts?.[command.commandId];
  if (attempt && !['LIVE', 'UNKNOWN'].includes(attempt.status)) return { state: current, outcome: 'BLOCKED', reason: 'attempt already retired' };
  if (isOneShotManagedCommand(state, command) && providerIntent?.kind !== 'ABSENT_PROVED') {
    if (!attempt) return { state: current, outcome: 'BLOCKED', reason: 'managed attempt unavailable' };
    attempt.status = status;
    state.status = 'BLOCKED';
    state.nextAction = 'blocked';
    const recoveryRef = { id: `retired:${command.launchToken}`, scope: 'outbox/recovery', digest: digest({ launchToken: command.launchToken, commandDigest: command.commandDigest, status }), bytes: canonicalString({ launchToken: command.launchToken, commandDigest: command.commandDigest, status }) } as Ref;
    const recovery: Event = { kind: 'OBSERVATION', category: 'RECOVERY', ref: recoveryRef };
    appendJournal(state, { ...identity, eventId: `${identity.eventId}:retire`, payloadDigest: digest(recovery) }, recovery, allowUnbounded);
    appendJournal(state, identity, { kind: 'RESUME' }, allowUnbounded);
    return { state, outcome: 'BLOCKED', reason: 'UnknownDispatch', launchToken: command.launchToken };
  }
  if (attempt) attempt.status = status;
  if (!Number.isSafeInteger(state.attemptEpoch + 1)) return { state: current, outcome: 'BLOCKED', reason: 'attempt epoch exhausted' };
  state.attemptEpoch += 1;
  const step = state.steps[command.stepId];
  if (step) { step.status = 'READY'; step.attempt = state.attemptEpoch; delete step.lastEvent; }
  const recoveryRef = { id: `retired:${command.launchToken}`, scope: 'outbox/recovery', digest: digest({ launchToken: command.launchToken, commandDigest: command.commandDigest, status }), bytes: canonicalString({ launchToken: command.launchToken, commandDigest: command.commandDigest, status }) } as Ref;
  const recovery: Event = { kind: 'OBSERVATION', category: 'RECOVERY', ref: recoveryRef };
  appendJournal(state, { ...identity, eventId: `${identity.eventId}:retire`, payloadDigest: digest(recovery) }, recovery, allowUnbounded);
  appendJournal(state, identity, { kind: 'RESUME' }, allowUnbounded);
  refreshAdmission(state, plan, maxInFlight);
  return { state, outcome: 'WAITING', reason: 'managed attempt retired; fresh epoch reserved' };
}

export function createInitialState(runId: string, plan: Plan, planDigest: ReturnType<typeof digest>, writerFence: string): MachineState {
  const steps: MachineState['steps'] = Object.create(null) as MachineState['steps'];
  for (const s of plan.steps) steps[s.stepId] = { ...copy(s), dependencies: [...(s.dependencies ?? [])], claims: copy(s.claims ?? []), status: 'READY', attempt: 0 };
  return { schema: 1, runId, phaseId: plan.phaseId, revision: 0, authorityEpoch: 0, attemptEpoch: 0, barrierEpoch: 0, modeEpoch: 0, writerFence, status: 'ACTIVE', gate: 'NOT-DUE', barrier: 'OPEN', steps, outbox: {}, processed: {}, decisionTokens: {}, planDigest, nextAction: 'start', journal: [] };
}

export function reduce(current: MachineState | undefined, plan: Plan, identity: EventIdentity, event: Event, maxInFlight: number, admissionOk: boolean, allowUnbounded = false): ReduceResult {
  const preview = reduceEvent(current, plan, identity, event, admissionOk, allowUnbounded);
  if (preview.outcome === 'BLOCKED' || preview.outcome === 'DECISION_REQUIRED') return preview;
  const state = preview.state;
  updateAdmission(state, plan, maxInFlight); snapshotReason(state);
  if (allDone(state) && inFlight(state).length === 0 && state.status === 'ACTIVE') {
    const acceptedPrefix = state.schema === 2 && state.managed?.proposal ? managedAcceptedReportRefs(state) : undefined;
    const orderedReportRefs = acceptedPrefix?.result.refs ?? [];
    state.gate = 'DUE'; state.barrier = 'CLOSED'; state.barrierEpoch += 1; state.writerFence = digest({ writerFence: state.writerFence, barrierEpoch: state.barrierEpoch }).slice(0, 24); snapshotReason(state);
    const managedWave = state.schema === 2 && state.managed?.proposal && acceptedPrefix?.result.architecture === 'COMPLETE';
    const token = managedWave ? `deliberation-${state.revision}-${state.barrierEpoch}` : `gate-${state.revision}-${state.barrierEpoch}`;
    if (managedWave) {
      const proposal = state.managed!.proposal!;
      const tokenFields = {
        kind: 'DELIBERATION_SELECTION' as const,
        consumed: false,
        identity: digest(identity),
        authorshipInputDigest: proposal.key,
        decisionKey: 'START',
        // The accepted Report/v2 prefix is authoritative for the current
        // deliberation Wave. The START intent/plan Ref remains the proposal
        // root, but cannot impersonate a Wave.
        waveRef: { ...acceptedPrefix!.waveRef },
        orderedReportRefs: orderedReportRefs.map((item) => ({ ...item })),
        predecessorGeneration: state.revision,
        disposition: 'LIVE',
        nullableSettlement: null,
        ...(proposal.rolloutOrigin ? { rolloutOrigin: { ...proposal.rolloutOrigin } } : {}),
      };
      state.decisionTokens[token] = {
        ...tokenFields,
        bindingDigest: digest({
          kind: tokenFields.kind,
          authorshipInputDigest: tokenFields.authorshipInputDigest,
          decisionKey: tokenFields.decisionKey,
          waveRef: tokenFields.waveRef,
          orderedReportRefs: tokenFields.orderedReportRefs,
          predecessorGeneration: tokenFields.predecessorGeneration,
          disposition: tokenFields.disposition,
          nullableSettlement: tokenFields.nullableSettlement,
          resultKind: null,
          resultDigest: null,
          publicationLeaseSetId: null,
          successorWaveRef: null,
          ...(tokenFields.rolloutOrigin ? { rolloutOrigin: tokenFields.rolloutOrigin } : {}),
        }),
      };
      const briefValue = { waveRef: acceptedPrefix!.waveRef, reports: orderedReportRefs, decisionKey: 'START' };
      const brief: Ref = { id: `brief:${token}`, scope: 'deliberation/brief', digest: digest(briefValue) as Sha256, bytes: canonicalString(briefValue) };
      state.nextAction = 'await-parent-gate-decision';
      return { state, outcome: 'DECISION_REQUIRED', token, brief };
    }
    state.decisionTokens[token] = { kind: 'GATE', consumed: false, identity: digest(identity) };
    return { state, outcome: 'PHASE_READY', token };
  }
  return { state, outcome: 'WAITING' };
}

function refEqual(a: unknown, b: unknown): boolean {
  try { return canonicalString(a) === canonicalString(b); } catch { return false; }
}

function managedSettlementRef(value: unknown): value is Ref {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !['id', 'digest', 'scope', 'bytes'].includes(key))) return false;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0 || typeof candidate.digest !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.digest)) return false;
  if (candidate.scope !== undefined && (typeof candidate.scope !== 'string' || candidate.scope.length === 0)) return false;
  if (typeof candidate.bytes !== 'string' || candidate.bytes.length === 0) return false;
  try {
    const parsed = JSON.parse(candidate.bytes);
    if (canonicalString(parsed) !== candidate.bytes || digest(parsed) !== candidate.digest) return false;
  } catch { return false; }
  if (typeof candidate.scope !== 'string' || !candidate.scope.startsWith('deliberation/settlement')) return false;
  return true;
}

function managedArtifactRef(value: unknown): value is Ref {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !['id', 'digest', 'scope', 'bytes'].includes(key)) || typeof candidate.id !== 'string' || candidate.id.length === 0 || typeof candidate.digest !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.digest) || typeof candidate.bytes !== 'string' || candidate.bytes.length === 0) return false;
  try { const parsed = JSON.parse(candidate.bytes); return canonicalString(parsed) === candidate.bytes && digest(parsed) === candidate.digest; } catch { return false; }
}

function managedDecisionValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { disposition: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

type ManagedDecisionBinding = {
  disposition: 'SELECTION' | 'SYNTHESIS' | 'WIDEN';
  settlementRef: Ref | null;
  successorWaveRef?: Ref;
  result?: Record<string, unknown>;
};

function managedCanonicalRef(value: unknown): value is Ref {
  try { validateManagedRef(value); return true; } catch { return false; }
}

/** Managed settlements carry a closed typed dissent/disposition.  Keeping the
 * spelling closed (rather than accepting arbitrary non-null caller prose)
 * makes reducer and durable-store validation agree on one canonical value. */
/** Return the live owner-derived settlement prefix for a token's authorship.
 * Prefix rows are ordered by the durable predecessor generation, and every
 * row must still be present in the managed settlement graph. */
function managedSettlementPrefix(state: MachineState, record: import('./model.js').DecisionToken): Ref[] | undefined {
  if (typeof record.predecessorGeneration !== 'number' || !Number.isSafeInteger(record.predecessorGeneration)) return undefined;
  const generation = record.predecessorGeneration;
  const rows: Array<{ generation: number; ref: Ref }> = [];
  for (const token of Object.values(state.decisionTokens)) {
    if (token.kind !== 'DELIBERATION_SELECTION' && token.kind !== 'DELIBERATION') continue;
    if (!token.consumed || typeof token.predecessorGeneration !== 'number' || !Number.isSafeInteger(token.predecessorGeneration) || token.predecessorGeneration >= generation || (token.disposition !== 'SELECTION' && token.disposition !== 'SYNTHESIS')) continue;
    const settlementDigest = token.nullableSettlement;
    if (typeof settlementDigest !== 'string') continue;
    const ref = state.managed?.settlements?.[settlementDigest];
    const leaseId = token.publicationLeaseSetId;
    const lease = leaseId ? state.managed?.leaseSets?.[leaseId] : undefined;
    if (!managedSettlementRef(ref) || !lease || lease.status === 'EXPIRED' || !Array.isArray(lease.closedRefGraph) || !lease.closedRefGraph.some((candidate) => refEqual(candidate, ref))) return undefined;
    // A settlement is not an owner merely because its digest appears in the
    // map. Revalidate the complete owner token/prefix recursively so a forged
    // canonical Ref cannot become provenance for a later decision.
    try {
      const parsed = parseCanonical<Record<string, unknown>>(ref.bytes ?? '');
      if (!parsed.result || typeof parsed.result !== 'object' || Array.isArray(parsed.result)
        || !managedSettlementBinding(state, token, ref, token.disposition as 'SELECTION' | 'SYNTHESIS', parsed.result as Record<string, unknown>)) return undefined;
    } catch { return undefined; }
    rows.push({ generation: token.predecessorGeneration, ref });
  }
  rows.sort((a, b) => a.generation - b.generation);
  for (let index = 1; index < rows.length; index += 1) if (rows[index - 1].generation === rows[index].generation) return undefined;
  for (let index = 1; index < rows.length; index += 1) if (refEqual(rows[index - 1].ref, rows[index].ref)) return undefined;
  const refs = rows.map((row) => row.ref);
  const context = record.waveRef ? parseManagedWave(record.waveRef, state) : undefined;
  if (!context || context.wave.authorship.settlementPrefixDigest !== settlementPrefixDigest(refs)) return undefined;
  return refs;
}

/** Deterministic evidence-snapshot Ref naming the exact consumed Focus Wave
 * and accepted Report/v2 prefix.  The Ref remains an ordinary canonical
 * snapshot; this private projection adds no public artifact shape. */
function managedAcceptedReportPrefixSnapshot(record: import('./model.js').DecisionToken): Ref {
  const value = { schema: 'lunacy-managed-accepted-report-prefix/v1', waveRef: record.waveRef, orderedReportRefs: record.orderedReportRefs };
  const bytes = canonicalString(value);
  const reportDigest = digest(value);
  return { id: `accepted-report-prefix:${reportDigest.slice(0, 16)}`, scope: 'deliberation/report-prefix', digest: reportDigest, bytes };
}

/** Bind an Explore successor to the exact Focus decision context that
 * authored it.  Every field listed here is derived from the consumed token;
 * a disconnected or replayed successor therefore fails both preflight and
 * the final reducer CAS. */
function managedSuccessorWaveIsBound(state: MachineState, record: import('./model.js').DecisionToken, successor: Ref): boolean {
  const prefix = managedSettlementPrefix(state, record);
  const focus = record.waveRef ? parseManagedWave(record.waveRef, state) : undefined;
  const next = parseManagedWave(successor, state);
  if (!prefix || !focus || !next || focus.wave.gear !== 'FOCUS' || next.wave.gear !== 'EXPLORE') return false;
  const expectedSnapshot = managedAcceptedReportPrefixSnapshot(record);
  const a = next.wave.authorship;
  const f = focus.wave.authorship;
  const prefixDigest = settlementPrefixDigest(prefix);
  return f.settlementPrefixDigest === prefixDigest
    && refEqual(a.intent, record.waveRef)
    && refEqual(a.evidenceSnapshot, expectedSnapshot)
    && a.authorityDigest === f.authorityDigest
    && refEqual(a.policyVersion, f.policyVersion)
    && a.settlementPrefixDigest === prefixDigest
    && a.decisionKey === record.decisionKey
    && a.prospectiveEffectFrontierOrdinal === f.prospectiveEffectFrontierOrdinal;
}

/** Validate the authority-free PlanAuthorshipResult that accompanies a
 * managed decision.  The result is deliberately checked before lease
 * acquisition and again in the consuming CAS; neither an optional `plan` nor
 * a digest-only alias is sufficient. */
function managedAuthorshipResult(state: MachineState, record: import('./model.js').DecisionToken, value: unknown, disposition: ManagedDecisionBinding['disposition']): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !['kind', 'plan', 'wave', 'reason'].includes(key)) || typeof result.kind !== 'string') return undefined;
  if (result.kind === 'COMPLETE_PLAN') {
    if (disposition === 'WIDEN' || !Object.prototype.hasOwnProperty.call(result, 'plan') || Object.prototype.hasOwnProperty.call(result, 'wave') || Object.prototype.hasOwnProperty.call(result, 'reason')) return undefined;
    try {
      const normalized = validatePlan(result.plan as Plan).plan;
      if (normalized.phaseId !== state.phaseId) return undefined;
      return { kind: result.kind, plan: normalized };
    } catch { return undefined; }
  }
  if (result.kind === 'DELIBERATION_REQUIRED') {
    if (!managedCanonicalRef(result.wave) || result.wave.scope !== 'deliberation/wave') return undefined;
    const context = parseManagedWave(result.wave, state);
    if (!context || (disposition === 'WIDEN' && context.wave.gear !== 'EXPLORE')) return undefined;
    if (Object.prototype.hasOwnProperty.call(result, 'plan') || Object.prototype.hasOwnProperty.call(result, 'reason')) return undefined;
    return { kind: result.kind, wave: { ...context.ref } };
  }
  if (result.kind === 'NO_SETTLEMENT') {
    // NO_SETTLEMENT is the pure refusal disposition; it must never be wrapped
    // in a consuming SELECTION/SYNTHESIS/WIDEN publication.
    return undefined;
  }
  return undefined;
}

function managedLocator(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const locator = value as Record<string, unknown>;
  if (Object.keys(locator).some((key) => !['generatorReport', 'oneBasedOrdinal'].includes(key)) || !managedCanonicalRef(locator.generatorReport)) return false;
  return locator.generatorReport.scope === 'deliberation/report' && Number.isSafeInteger(locator.oneBasedOrdinal) && (locator.oneBasedOrdinal as number) >= 1;
}

/** A settlement basis must name an admitted generator row from this exact
 * token prefix.  Structural locator checks alone would let a parent cite a
 * foreign Report/v2 (or an out-of-range idea ordinal) while still producing a
 * canonical-looking settlement record. */
function managedBoundLocator(state: MachineState, record: import('./model.js').DecisionToken, value: unknown): boolean {
  if (!managedLocator(value) || !record.waveRef || !record.orderedReportRefs) return false;
  const locator = value as { generatorReport: Ref; oneBasedOrdinal: number };
  const admitted = record.orderedReportRefs.find((candidate) => refEqual(candidate, locator.generatorReport));
  if (!admitted) return false;
  const context = parseManagedWave(record.waveRef, state);
  if (!context) return false;
  try {
    const report = parseCanonical<DeliberationReport>(locator.generatorReport.bytes ?? '');
    if (digest(report) !== locator.generatorReport.digest || !refEqual(report.wave, record.waveRef)) return false;
    const slot = deriveTopology(record.waveRef, context.wave).slots.find((candidate) => candidate.slotOrdinal === report.slotOrdinal);
    if (!slot || slot.role !== 'GENERATOR') return false;
    const checked = validateReport(report, { waveRef: record.waveRef, wave: context.wave, slot, predecessors: [], policy: context.policy });
    return checked.ok && 'ideas' in checked.value && locator.oneBasedOrdinal <= checked.value.ideas.length;
  } catch { return false; }
}

/** Validate the canonical parent-decision settlement record and bind every
 * authority-bearing field to the live token/prefix.  Basis, dissent, and
 * predecessor settlement Refs are retained as typed canonical data rather
 * than opaque caller prose. */
function managedSettlementBinding(state: MachineState, record: import('./model.js').DecisionToken, settlementRef: Ref, disposition: 'SELECTION' | 'SYNTHESIS', result: Record<string, unknown>): boolean {
  if (!managedSettlementRef(settlementRef) || typeof settlementRef.bytes !== 'string') return false;
  // Settlement provenance is meaningful only for the immutable accepted
  // Report/v2 prefix captured by this token.  Recheck that prefix here (not
  // only in the caller) so every recursive owner validation uses the same
  // receipt/command/slot proof.
  if (!managedTokenPrefix(state, record)) return false;
  let parsed: Record<string, unknown>;
  try { parsed = parseCanonical<Record<string, unknown>>(settlementRef.bytes); } catch { return false; }
  const required = ['schema', 'authorshipInputDigest', 'decisionKey', 'frontierOrdinal', 'waveRef', 'orderedReportRefs', 'basis', 'dissent', 'predecessors', 'result'];
  if (Object.keys(parsed).some((key) => ![...required, 'selection', 'synthesis', 'disposition', 'resultDigest'].includes(key)) || required.some((key) => !Object.prototype.hasOwnProperty.call(parsed, key))) return false;
  if (parsed.schema !== 'lunacy-deliberation-settlement/v1' && parsed.schema !== 'lunacy-parent-decision/v1') return false;
  const tokenWave = record.waveRef ? parseManagedWave(record.waveRef, state) : undefined;
  if (!tokenWave || parsed.authorshipInputDigest !== record.authorshipInputDigest || parsed.decisionKey !== record.decisionKey || parsed.frontierOrdinal !== tokenWave.wave.authorship.prospectiveEffectFrontierOrdinal) return false;
  if (!refEqual(parsed.waveRef, record.waveRef) || !Array.isArray(parsed.orderedReportRefs) || canonicalString(parsed.orderedReportRefs) !== canonicalString(record.orderedReportRefs)) return false;
  if (parsed.disposition !== undefined && parsed.disposition !== disposition) return false;
  if (parsed.resultDigest !== undefined && parsed.resultDigest !== digest(result)) return false;
  if (!Array.isArray(parsed.predecessors) || parsed.predecessors.some((item) => !managedCanonicalRef(item) || (item as Ref).scope?.startsWith('deliberation/settlement') !== true)) return false;
  const predecessorKeys = parsed.predecessors.map((item) => canonicalString(item));
  if (new Set(predecessorKeys).size !== predecessorKeys.length || predecessorKeys.some((key) => key === canonicalString(settlementRef))) return false;
  if (parsed.basis === null || parsed.basis === undefined) return false;
  if (!canonicalString(parsed.basis) || !isManagedDissent(parsed.dissent)) return false;
  const prefix = managedSettlementPrefix(state, record);
  if (!prefix) return false;
  const prefixKeys = prefix.map((item) => canonicalString(item));
  const predecessorIndexes = parsed.predecessors.map((item) => prefixKeys.indexOf(canonicalString(item)));
  if (predecessorIndexes.some((index) => index < 0) || predecessorIndexes.some((index, i) => i > 0 && index <= predecessorIndexes[i - 1])) return false;
  if (disposition === 'SELECTION') {
    // Selection basis is itself the typed locator.  If the explicit
    // selection alias is present, it must be the same canonical value rather
    // than allowing an attacker to validate one field while binding another.
    if (!managedBoundLocator(state, record, parsed.basis)) return false;
    if (parsed.selection !== undefined && (!managedBoundLocator(state, record, parsed.selection) || canonicalString(parsed.selection) !== canonicalString(parsed.basis))) return false;
    if (parsed.synthesis !== undefined) return false;
  } else {
    if (parsed.selection !== undefined) return false;
    if (typeof parsed.synthesis !== 'string' || parsed.synthesis.length === 0 || !Array.isArray(parsed.basis) || parsed.basis.length === 0 || parsed.basis.some((item) => !managedBoundLocator(state, record, item))) return false;
  }
  if (!result || canonicalString(parsed.result) !== canonicalString(result)) return false;
  return true;
}

/** Shared preflight for public lease preparation and the final reducer CAS. */
export function validateManagedDecisionBinding(state: MachineState, token: string, value: unknown): ManagedDecisionBinding | undefined {
  const record = state.decisionTokens[token];
  if (!record || (record.kind !== 'DELIBERATION_SELECTION' && record.kind !== 'DELIBERATION') || record.consumed) return undefined;
  const requested = managedDecisionValue(value);
  const disposition = typeof requested.disposition === 'string' ? requested.disposition : typeof requested.kind === 'string' ? requested.kind : typeof requested.decision === 'string' ? requested.decision : undefined;
  if (!disposition || !['SELECTION', 'SYNTHESIS', 'WIDEN'].includes(disposition)) return undefined;
  if (isOneShotManagedDecision(state, token) && requestsManagedSuccessor(value)) return undefined;
  if (!managedTokenPrefix(state, record)) return undefined;
  const authorshipInputDigest = requested.authorshipInputDigest ?? requested.authorshipDigest;
  if (authorshipInputDigest !== undefined && authorshipInputDigest !== record.authorshipInputDigest) return undefined;
  if (requested.decisionKey !== undefined && requested.decisionKey !== record.decisionKey) return undefined;
  if (requested.predecessorGeneration !== undefined && requested.predecessorGeneration !== record.predecessorGeneration) return undefined;
  if (requested.bindingDigest !== undefined && requested.bindingDigest !== record.bindingDigest) return undefined;
  if (requested.waveRef !== undefined && !refEqual(requested.waveRef, record.waveRef)) return undefined;
  if (requested.orderedReportRefs !== undefined && (!Array.isArray(requested.orderedReportRefs) || canonicalString(requested.orderedReportRefs) !== canonicalString(record.orderedReportRefs))) return undefined;
  const requestedSettlement = Object.prototype.hasOwnProperty.call(requested, 'nullableSettlement')
    ? requested.nullableSettlement
    : Object.prototype.hasOwnProperty.call(requested, 'settlementRef')
      ? requested.settlementRef
      : Object.prototype.hasOwnProperty.call(requested, 'settlement')
        ? requested.settlement
        : requested.settlementDigest;
  const result = requested.result && typeof requested.result === 'object' && !Array.isArray(requested.result) ? requested.result as Record<string, unknown> : undefined;
  const normalizedResult = managedAuthorshipResult(state, record, result, disposition as ManagedDecisionBinding['disposition']);
  if (!normalizedResult || canonicalString(normalizedResult) !== canonicalString(result)) return undefined;
  if (disposition === 'WIDEN') {
    // WIDEN has one canonical settlement spelling: the nullable field must
    // be present and explicitly null.  Accepting an omitted/aliased value
    // would let a caller silently choose a different parent-decision shape.
    if (!Object.prototype.hasOwnProperty.call(requested, 'nullableSettlement') || requestedSettlement !== null) return undefined;
    const explicit = requested.successorWaveRef ?? requested.nextWaveRef;
    if (!managedCanonicalRef(explicit) || explicit.scope !== 'deliberation/wave') return undefined;
    const successor = managedAuthorshipResult(state, record, normalizedResult, disposition)?.wave as Ref;
    if (!successor || !refEqual(explicit, successor)) return undefined;
    if (!managedSuccessorWaveIsBound(state, record, successor)) return undefined;
    return { disposition, settlementRef: null, successorWaveRef: { ...successor }, result: normalizedResult };
  }
  if (!managedSettlementRef(requestedSettlement) || !managedSettlementBinding(state, record, requestedSettlement, disposition as 'SELECTION' | 'SYNTHESIS', normalizedResult)) return undefined;
  const successor = normalizedResult.kind === 'DELIBERATION_REQUIRED' ? normalizedResult.wave as Ref : undefined;
  return { disposition: disposition as 'SELECTION' | 'SYNTHESIS', settlementRef: { ...(requestedSettlement as Ref) }, ...(successor ? { successorWaveRef: { ...successor } } : {}), result: normalizedResult };
}

/** Apply the managed deliberation token branch.  The caller is responsible for
 * validating capability/kill-switch state immediately before its CAS. */
function applyManagedDecision(state: MachineState, identity: EventIdentity, token: string, value: unknown, allowUnbounded: boolean, prepared?: PreparedDecisionPublication): ReduceResult {
  const record = state.decisionTokens[token];
  if (!record || (record.kind !== 'DELIBERATION_SELECTION' && record.kind !== 'DELIBERATION') || record.consumed) return { state, outcome: 'BLOCKED', reason: 'decision token already consumed or unknown' };
  if (record.rolloutOrigin?.mode === 'shadow' || state.managed?.rolloutOrigin?.mode === 'shadow') return { state, outcome: 'BLOCKED', reason: 'managed shadow denies parent decision' };
  const requested = managedDecisionValue(value);
  const disposition = typeof requested.disposition === 'string' ? requested.disposition : typeof requested.kind === 'string' ? requested.kind : typeof requested.decision === 'string' ? requested.decision : undefined;
  if (!disposition || !['SELECTION', 'SYNTHESIS', 'WIDEN', 'NO_SETTLEMENT'].includes(disposition)) return { state, outcome: 'BLOCKED', reason: 'unsupported deliberation decision' };
  if (disposition === 'NO_SETTLEMENT') return { state, outcome: 'BLOCKED', reason: 'NO_SETTLEMENT' };
  const binding = validateManagedDecisionBinding(state, token, value);
  if (!binding) return { state, outcome: 'BLOCKED', reason: 'full canonical deliberation result or settlement binding is invalid' };
  if (!managedTokenPrefix(state, record)) return { state, outcome: 'BLOCKED', reason: 'accepted Report/v2 prefix is no longer valid' };
  const authorshipInputDigest = requested.authorshipInputDigest ?? requested.authorshipDigest;
  if (typeof authorshipInputDigest === 'string' && authorshipInputDigest !== record.authorshipInputDigest) return { state, outcome: 'BLOCKED', reason: 'deliberation authorship input mismatch' };
  if (typeof requested.decisionKey === 'string' && requested.decisionKey !== record.decisionKey) return { state, outcome: 'BLOCKED', reason: 'deliberation decision key mismatch' };
  if (requested.predecessorGeneration !== undefined && requested.predecessorGeneration !== record.predecessorGeneration) return { state, outcome: 'BLOCKED', reason: 'deliberation predecessor generation mismatch' };
  if (requested.bindingDigest !== undefined && requested.bindingDigest !== record.bindingDigest) return { state, outcome: 'BLOCKED', reason: 'deliberation binding digest mismatch' };
  if (requested.waveRef !== undefined && !refEqual(requested.waveRef, record.waveRef)) return { state, outcome: 'BLOCKED', reason: 'deliberation Wave Ref mismatch' };
  if (requested.orderedReportRefs !== undefined && (!Array.isArray(requested.orderedReportRefs) || canonicalString(requested.orderedReportRefs) !== canonicalString(record.orderedReportRefs))) return { state, outcome: 'BLOCKED', reason: 'deliberation Report order mismatch' };
  const requestedSettlement = Object.prototype.hasOwnProperty.call(requested, 'nullableSettlement')
    ? requested.nullableSettlement
    : Object.prototype.hasOwnProperty.call(requested, 'settlementRef')
      ? requested.settlementRef
      : Object.prototype.hasOwnProperty.call(requested, 'settlement')
        ? requested.settlement
        : requested.settlementDigest;
  if (!prepared || prepared.disposition !== disposition || typeof prepared.lease?.leaseId !== 'string') return { state, outcome: 'BLOCKED', reason: 'publication lease is unavailable' };
  if (disposition === 'WIDEN') {
    if (!Object.prototype.hasOwnProperty.call(requested, 'nullableSettlement') || requestedSettlement !== null) return { state, outcome: 'BLOCKED', reason: 'WIDEN requires explicit null settlement' };
    if (prepared.settlementRef !== null) return { state, outcome: 'BLOCKED', reason: 'WIDEN settlement binding is invalid' };
    if (!binding.successorWaveRef) return { state, outcome: 'BLOCKED', reason: 'WIDEN requires an exact Explore successor' };
    for (const candidate of [requested.nextWaveRef, requested.successorWaveRef]) {
      if (candidate !== undefined && !refEqual(candidate, binding.successorWaveRef)) return { state, outcome: 'BLOCKED', reason: 'successor Wave Ref does not match PlanAuthorshipResult' };
    }
  } else {
    if (requestedSettlement === undefined || requestedSettlement === null || !managedSettlementRef(requestedSettlement)) return { state, outcome: 'BLOCKED', reason: 'selection/synthesis requires a full settlement ref' };
    if (!prepared.settlementRef || canonicalString(prepared.settlementRef) !== canonicalString(requestedSettlement)) return { state, outcome: 'BLOCKED', reason: 'settlement publication binding is invalid' };
  }
  const settlementRef = disposition === 'WIDEN' ? null : binding.settlementRef;
  if (!settlementRef && disposition !== 'WIDEN') return { state, outcome: 'BLOCKED', reason: 'settlement publication binding is invalid' };
  const resultObjectForClosure = requested.result && typeof requested.result === 'object' && !Array.isArray(requested.result) ? requested.result as Record<string, unknown> : undefined;
  const successorForClosure = binding.successorWaveRef ?? requested.nextWaveRef ?? requested.successorWaveRef ?? resultObjectForClosure?.wave;
  if (successorForClosure !== undefined && !managedArtifactRef(successorForClosure)) return { state, outcome: 'BLOCKED', reason: 'successor Wave Ref is malformed' };
  const authorityAnchors: Ref[] = [];
  for (const reportRef of record.orderedReportRefs ?? []) {
    const row = state.managed?.acceptedReports?.[reportRef.digest];
    if (row?.roleDigest) {
      if (!row.authorityAnchor || !managedAcceptedAuthorityIsValid(state, row)) return { state, outcome: 'BLOCKED', reason: 'accepted Report authority anchor is invalid' };
      authorityAnchors.push(row.authorityAnchor);
    }
  }
  const expectedClosure = [record.waveRef, ...(record.orderedReportRefs ?? []), ...authorityAnchors, ...(settlementRef ? [settlementRef] : []), ...(successorForClosure ? [successorForClosure as Ref] : [])];
  const leaseRefs = prepared.lease.refs;
  if (new Set(leaseRefs.map((item) => canonicalString(item))).size !== leaseRefs.length
    || leaseRefs.length !== expectedClosure.length
    || expectedClosure.some((item) => !leaseRefs.some((candidate) => canonicalString(candidate) === canonicalString(item)))) return { state, outcome: 'BLOCKED', reason: 'publication lease closure is invalid' };
  // The public preflight is only an optimization.  Repeat the one-shot
  // successor fence against the exact CAS input immediately before mutation.
  if (isOneShotManagedDecision(state, token) && requestsManagedSuccessor(value)) return { state, outcome: 'BLOCKED', reason: 'one-shot managed Wave cannot publish a successor' };
  const next = copy(state);
  const nextRecord = next.decisionTokens[token]!;
  nextRecord.consumed = true;
  nextRecord.disposition = disposition;
  nextRecord.nullableSettlement = settlementRef ? settlementRef.digest : null;
  nextRecord.publicationLeaseSetId = prepared.lease.leaseId;
  nextRecord.resultKind = binding.result?.kind as 'COMPLETE_PLAN' | 'DELIBERATION_REQUIRED' | 'NO_SETTLEMENT';
  nextRecord.resultDigest = digest(binding.result) as Sha256;
  if (successorForClosure) nextRecord.successorWaveRef = { ...(successorForClosure as Ref) };
  nextRecord.bindingDigest = digest({
    kind: nextRecord.kind,
    authorshipInputDigest: nextRecord.authorshipInputDigest,
    decisionKey: nextRecord.decisionKey,
    waveRef: nextRecord.waveRef,
    orderedReportRefs: nextRecord.orderedReportRefs,
    predecessorGeneration: nextRecord.predecessorGeneration,
    disposition,
    nullableSettlement: nextRecord.nullableSettlement,
    resultKind: nextRecord.resultKind,
    resultDigest: nextRecord.resultDigest,
    publicationLeaseSetId: nextRecord.publicationLeaseSetId,
    successorWaveRef: nextRecord.successorWaveRef ?? null,
    ...(nextRecord.rolloutOrigin ? { rolloutOrigin: nextRecord.rolloutOrigin } : {}),
  }) as Sha256;
  next.managed!.leaseSets[prepared.lease.leaseId] = {
    leaseId: prepared.lease.leaseId,
    closedRefGraph: prepared.lease.refs.map((item) => ({ ...item })),
    expiresAt: prepared.lease.expiresAt,
    status: prepared.lease.status,
  };
  appendJournal(next, identity, { kind: 'PARENT_DECISION', token, value }, allowUnbounded);
  next.gate = 'NOT-DUE'; next.barrier = 'OPEN'; next.status = 'ACTIVE';
  next.attemptEpoch += 1; next.barrierEpoch += 1;
  const completePlan = (binding.result?.kind === 'COMPLETE_PLAN' ? binding.result.plan : undefined) as Plan | undefined;
  if (completePlan && typeof completePlan === 'object' && !Array.isArray(completePlan)) {
    try {
      const normalized = validatePlan(completePlan).plan;
      if (normalized.phaseId !== next.phaseId) return { state, outcome: 'BLOCKED', reason: 'deliberation result phase mismatch' };
      next.authorityEpoch += 1;
      next.planDigest = digest(normalized) as Sha256;
      // The managed proposal is part of the closed authoritative graph.  A
      // completed deliberation plan therefore has to update its bound digest
      // atomically with the new step projection; otherwise the graph validator
      // quite correctly rejects the CAS as an orphaned proposal.
      if (next.managed?.proposal) next.managed.proposal.planDigest = next.planDigest;
      const steps: MachineState['steps'] = Object.create(null) as MachineState['steps'];
      for (const step of normalized.steps) steps[step.stepId] = { ...copy(step), dependencies: [...(step.dependencies ?? [])], claims: copy(step.claims ?? []), status: 'READY', attempt: next.attemptEpoch };
      next.steps = steps;
    } catch { return { state, outcome: 'BLOCKED', reason: 'deliberation result plan is invalid' }; }
  }
  if (settlementRef) {
    next.managed!.settlements ??= {};
    next.managed!.settlements[settlementRef.digest] = { ...settlementRef };
    next.managed!.settlementOrigins ??= {};
    if (nextRecord.rolloutOrigin) next.managed!.settlementOrigins[settlementRef.digest] = { ...nextRecord.rolloutOrigin };
  }
  // WIDEN/selection may provide a successor Wave identity.  Preserve the
  // existing proposal when none is supplied; if one is supplied, bind it to
  // the same lease root so the managed graph remains closed at store CAS.
  const successor = binding.successorWaveRef ?? requested.nextWaveRef ?? requested.successorWaveRef ?? (requested.result && typeof requested.result === 'object' ? (requested.result as Record<string, unknown>).wave : undefined);
  if (successor && next.managed?.proposal && typeof successor === 'object') {
    next.managed.proposal.waveRef = { ...(successor as Ref) };
    const proposalLeaseId = next.managed.proposal.leaseSetId;
    if (next.managed.leaseSets[proposalLeaseId]) {
      const anchors = Object.values(next.managed.attempts ?? {}).flatMap((attempt) => attempt.authorityAnchor ? [{ ...attempt.authorityAnchor }] : []);
      next.managed.leaseSets[proposalLeaseId].closedRefGraph = [{ ...(successor as Ref) }, ...anchors];
    }
  }
  for (const step of Object.values(next.steps)) { step.status = 'READY'; step.attempt = next.attemptEpoch; delete step.lastEvent; }
  next.nextAction = 'advance-ready-steps';
  return { state: next, outcome: 'WAITING', reason: disposition === 'WIDEN' ? 'deliberation widened' : 'deliberation settlement committed' };
}

type TargetedFindings = Readonly<{ decision: 'FINDINGS'; ownerStepId: string }>;

function targetedFindings(value: unknown): TargetedFindings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.length !== 2 || keys[0] !== 'decision' || keys[1] !== 'ownerStepId') return undefined;
  if (candidate.decision !== 'FINDINGS' || typeof candidate.ownerStepId !== 'string' || candidate.ownerStepId.length === 0) return undefined;
  return candidate as TargetedFindings;
}

/** Return the owner plus every transitive dependent only when the supplied
 * topology is exactly the authority committed by CURRENT. Ambiguity falls
 * back to the conservative legacy reset. */
function targetedRepairClosure(current: MachineState, plan: Plan, ownerStepId: string): Set<string> | undefined {
  try {
    if (current.planDigest !== digest(plan) && current.planDigest !== digest(validatePlan(plan).plan)) return undefined;
  } catch { return undefined; }
  const planById = new Map(plan.steps.map((step) => [step.stepId, step]));
  const planIds = [...planById.keys()].sort();
  const stateIds = Object.keys(current.steps).sort();
  if (planIds.length !== stateIds.length || planIds.some((id, index) => id !== stateIds[index])) return undefined;
  const dependents = new Map<string, string[]>(planIds.map((id) => [id, []]));
  for (const id of planIds) {
    const planDependencies = [...(planById.get(id)?.dependencies ?? [])].sort();
    const stateDependencies = [...(current.steps[id]?.dependencies ?? [])].sort();
    if (planDependencies.length !== stateDependencies.length || planDependencies.some((dependency, index) => dependency !== stateDependencies[index])) return undefined;
    for (const dependency of planDependencies) dependents.get(dependency)?.push(id);
  }
  const closure = new Set([ownerStepId]);
  const queue = [ownerStepId];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependent of dependents.get(queue[index]) ?? []) {
      if (closure.has(dependent)) continue;
      closure.add(dependent);
      queue.push(dependent);
    }
  }
  return closure;
}

function resetAllSteps(state: MachineState): void {
  for (const step of Object.values(state.steps)) {
    step.status = 'READY'; step.attempt = state.attemptEpoch; delete step.lastEvent;
  }
}

export function applyParentDecision(current: MachineState, identity: EventIdentity, token: string, value: unknown, allowUnboundedOrPlan: boolean | Plan = false, prepared?: PreparedDecisionPublication, plan?: Plan): ReduceResult {
  const allowUnbounded = typeof allowUnboundedOrPlan === 'boolean' ? allowUnboundedOrPlan : false;
  const decisionPlan = typeof allowUnboundedOrPlan === 'boolean' ? plan : allowUnboundedOrPlan;
  // Use an own-property check: a caller-supplied token such as "__proto__"
  // must not resolve to Object.prototype and mutate the decision map.
  if (!Object.prototype.hasOwnProperty.call(current.decisionTokens, token)) return { state: current, outcome: 'BLOCKED', reason: 'decision token already consumed or unknown' };
  const currentRecord = current.decisionTokens[token];
  if (!currentRecord || currentRecord.consumed) return { state: current, outcome: 'BLOCKED', reason: 'decision token already consumed or unknown' };
  if (currentRecord.kind === 'DELIBERATION_SELECTION' || currentRecord.kind === 'DELIBERATION') {
    if (currentRecord.rolloutOrigin?.mode === 'shadow' || current.managed?.rolloutOrigin?.mode === 'shadow') return { state: current, outcome: 'BLOCKED', reason: 'managed shadow denies parent decision' };
    return applyManagedDecision(current, identity, token, value, allowUnbounded, prepared);
  }
  // Invalid choices do not consume a one-shot token.  Consuming first would
  // let an untrusted value permanently strand a gate before the parent can
  // submit the only supported PASS/FINDINGS decision.
  const targeted = targetedFindings(value);
  if (currentRecord.kind !== 'GATE' || (value !== 'PASS' && value !== 'FINDINGS' && !targeted)) return { state: current, outcome: 'BLOCKED', reason: 'unsupported decision' };
  if (targeted && (!decisionPlan || !decisionPlan.steps.some((step) => step.stepId === targeted.ownerStepId))) return { state: current, outcome: 'BLOCKED', reason: 'unknown findings owner' };
  const closure = targeted && decisionPlan ? targetedRepairClosure(current, decisionPlan, targeted.ownerStepId) : undefined;
  const state = copy(current); const record = state.decisionTokens[token]!;
  record.consumed = true;
  appendJournal(state, identity, { kind: 'PARENT_DECISION', token, value }, allowUnbounded);
  if (value === 'PASS') { state.gate = 'PASS'; state.status = 'COMPLETE'; state.nextAction = 'complete'; return { state, outcome: 'COMPLETE' }; }
  // FINDINGS is a new mutable repair attempt, not a terminal blocked state.
  // Keep the old generation/report immutable by fencing the new attempt with
  // fresh attempt/barrier epochs and rebuilding only the step projection.
  state.gate = 'NOT-DUE'; state.status = 'ACTIVE'; state.barrier = 'OPEN';
  state.attemptEpoch += 1; state.barrierEpoch += 1;
  if (!targeted || !closure) resetAllSteps(state);
  else {
    for (const stepId of closure) {
      const step = state.steps[stepId];
      step.status = stepId === targeted.ownerStepId ? 'REPAIR' : 'READY';
      step.attempt = state.attemptEpoch;
      delete step.lastEvent;
    }
  }
  state.nextAction = 'advance-ready-steps';
  return { state, outcome: 'WAITING', reason: 'gate findings repair attempt opened', ...(targeted && closure ? { deferAdmission: true } : {}) };
}

/**
 * Apply a parent-authorized authority adoption.  The caller has already
 * validated the live plan and checked that no old work is live.  This helper
 * deliberately keeps old outbox identities (including commands whose step was
 * removed) and rebuilds only the current attempt's step projection.
 */
export function applyAuthorityAdoption(current: MachineState, identity: EventIdentity, token: string, value: unknown, targetPlan: Plan, targetDigest: Sha256, allowUnbounded = false): ReduceResult {
  if (current.managed?.rolloutOrigin?.mode === 'shadow') return { state: current, outcome: 'BLOCKED', reason: 'managed shadow denies authority adoption' };
  if (targetPlan.phaseId !== current.phaseId) return { state: current, outcome: 'BLOCKED', reason: 'phase fence mismatch' };
  if (!Object.prototype.hasOwnProperty.call(current.decisionTokens, token)) return { state: current, outcome: 'BLOCKED', reason: 'authority token unknown' };
  const state = copy(current);
  const record = state.decisionTokens[token];
  if (!record || record.kind !== 'AUTHORITY_ADOPTION' || record.consumed) return { state: current, outcome: 'BLOCKED', reason: 'authority token already consumed or unknown' };
  if (record.rolloutOrigin?.mode === 'shadow') return { state: current, outcome: 'BLOCKED', reason: 'managed shadow denies authority adoption' };
  if (record.targetDigest !== targetDigest || record.observedDigest !== targetDigest) return { state: current, outcome: 'BLOCKED', reason: 'authority digest does not match acknowledged token' };
  const requested = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const requestedKind = typeof requested.kind === 'string' ? requested.kind : typeof requested.decision === 'string' ? requested.decision : undefined;
  const requestedDigest = typeof requested.digest === 'string' ? requested.digest : typeof requested.planDigest === 'string' ? requested.planDigest : typeof requested.authorityDigest === 'string' ? requested.authorityDigest : undefined;
  // The public boundary verifies raw-vs-normalized digest aliases against the
  // durable token.  The pure reducer only checks the decision verb here so
  // the original canonical parent event can be journaled byte-for-byte.
  if (!requestedKind || !['ADOPT', 'ADOPT_AUTHORITY', 'AUTHORITY_ADOPT'].includes(requestedKind)) return { state: current, outcome: 'BLOCKED', reason: 'unsupported authority adoption decision' };
  record.consumed = true;
  appendJournal(state, identity, { kind: 'PARENT_DECISION', token, value }, allowUnbounded);
  state.authorityEpoch += 1;
  state.attemptEpoch += 1;
  state.barrierEpoch += 1;
  state.planDigest = targetDigest;
  // The managed proposal is part of the same authority graph. Keep its
  // binding synchronized inside this CAS, otherwise store validation rejects
  // the otherwise valid adoption as a free-floating proposal.
  if (state.managed?.proposal) state.managed.proposal.planDigest = state.planDigest;
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
