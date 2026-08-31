import type { ManagedCapability, ManagedRolloutProjection } from './managed-capability.js';
import type { DeliberationReport } from './deliberation.js';

export type RunId = string & { readonly __runId: unique symbol };
export type PhaseId = string & { readonly __phaseId: unique symbol };
export type StepId = string & { readonly __stepId: unique symbol };
export type EventId = string & { readonly __eventId: unique symbol };
export type Sha256 = string & { readonly __sha256: unique symbol };
export type LaunchToken = string & { readonly __launchToken: unique symbol };

/** Private durable managed-deliberation records.  They are nested under the
 * schema-2 `managed` field and never alter public Event/Yield shapes. */
export type ManagedProposal = {
  key: Sha256;
  waveRef: Ref;
  /** Exact role-materialization Wave persisted by rollout composition. The
   * legacy graph-root waveRef remains the closed START artifact identity. */
  roleWaveRef?: Ref;
  planDigest: Sha256;
  leaseSetId: string;
  rolloutOrigin?: ManagedRolloutProjection;
};
export type ManagedWaveCounters = {
  waves: number;
  calls: number;
  inTok: number;
  outTok: number;
  reportBytes: number;
  refs: number;
  persistedBytes: number;
  deadline: number;
};
export type ManagedReservation = ManagedWaveCounters & {
  reservationId: string;
  epoch: number;
  commandId: string;
  charged: boolean;
};
/** Private managed provider-attempt record.  The native outbox remains the
 * lifecycle source of truth; this compact projection binds the attempt epoch,
 * reservation and terminal result for managed recovery without widening the
 * public Event/Yield contract. */
export type ManagedAttemptStatus = 'LIVE' | 'UNKNOWN' | 'SUCCESS' | 'TIMED_OUT' | 'CANCELLED' | 'FAILED';
export type ManagedAttempt = {
  commandId: string;
  epoch: number;
  reservationId: string;
  leaseId?: string;
  status: ManagedAttemptStatus;
  receipt?: Ref;
  resultDigest?: Sha256;
  /** Exact managed-host receipt/transport history first admitted by the
   * authoritative receipt CAS. */
  authorityAnchor?: Ref;
  rolloutOrigin?: ManagedRolloutProjection;
};
/** Private accepted Report/v2 projection.  A row is admitted only after the
 * reducer has checked the immutable command/receipt identity, execution
 * frame, current Wave slot and predecessor closure.  The table is the sole
 * managed prefix source; journal envelopes are merely public lifecycle
 * evidence. */
export type ManagedAcceptedReport = {
  ref: Ref;
  report: DeliberationReport;
  commandId: string;
  roleDigest?: Sha256;
  predecessorReportDigests?: Sha256[];
  receipt: { commandDigest: Sha256; resultDigest: Sha256; attemptEpoch: number; authorityAnchorDigest?: Sha256 };
  authorityAnchor?: Ref;
  attemptEpoch: number;
  authorityEpoch: number;
  barrierEpoch: number;
  modeEpoch: number;
  rolloutOrigin?: ManagedRolloutProjection;
};
export type ManagedState = {
  capability: ManagedCapability;
  killSwitch: boolean;
  /** Optional for schema-2 backward reads; absence is rollout-disabled. */
  rollout?: ManagedRolloutProjection;
  /** Immutable origin of this run's admitted managed Wave. */
  rolloutOrigin?: ManagedRolloutProjection;
  proposal?: ManagedProposal;
  waveCounters: ManagedWaveCounters;
  reservations: Record<string, ManagedReservation>;
  leaseSets: Record<string, { leaseId: string; closedRefGraph: Ref[]; expiresAt: number; status: 'ACTIVE' | 'PROMOTED' | 'EXPIRED' }>;
  attempts?: Record<string, ManagedAttempt>;
  acceptedReports?: Record<string, ManagedAcceptedReport>;
  /** Content-addressed non-null settlement records admitted by C7. */
  settlements?: Record<string, Ref>;
  settlementOrigins?: Record<string, ManagedRolloutProjection>;
};

export type Ref = { id: string; digest: Sha256; scope?: string; bytes?: string };

export type StepStatus = 'READY' | 'ACTIVE' | 'NEEDS-DECISION' | 'REPAIR' | 'DONE' | 'BLOCKED' | 'SUPERSEDED';
export type RunStatus = 'ACTIVE' | 'BLOCKED' | 'COMPLETE';
export type GateStatus = 'NOT-DUE' | 'DUE' | 'PASS' | 'FINDINGS';
export type BarrierStatus = 'OPEN' | 'CLOSED';
export type OutboxState = 'PENDING' | 'CLAIMED' | 'ACKED' | 'UNKNOWN';

export type ClaimMode = 'READ' | 'WRITE' | 'EXCLUSIVE';
export type Claim = { resource: string; mode: ClaimMode; aliases?: string[] };
export type PlanStep = {
  stepId: string;
  goal?: string;
  dependencies?: string[];
  claims?: Claim[];
  executable?: boolean;
  status?: StepStatus;
};
export type Plan = {
  schema?: 'lunacy-plan-v1';
  phaseId: string;
  steps: PlanStep[];
  gateRequired?: boolean;
  authorityDigest?: Sha256;
};

export type Event =
  | { kind: 'START'; intentRef: Ref }
  | { kind: 'RESUME' }
  | { kind: 'PARENT_DECISION'; token: string; value: unknown }
  | { kind: 'DISPATCH_RECEIPT'; ref: Ref }
  | { kind: 'WORKER_ENVELOPE'; ref: Ref }
  | { kind: 'OBSERVATION'; ref: Ref; category: 'USER_CHANGE' | 'HOST' | 'RECOVERY' };

export type EventIdentity = {
  runId: RunId | string;
  phaseId: PhaseId | string;
  stepId: StepId | string;
  attemptEpoch: number;
  authorityEpoch: number;
  barrierEpoch: number;
  eventId: EventId | string;
  payloadDigest: Sha256 | string;
  launchToken?: LaunchToken | string;
};

export type AdvanceInput = {
  runId: RunId | string;
  identity: EventIdentity;
  expectedRevision?: number;
  event: Event;
};

export type Cursor = {
  revision: number;
  authorityEpoch: number;
  attemptEpoch: number;
  barrierEpoch: number;
};

export type CompactSnapshot = {
  revision: number;
  authorityEpoch: number;
  attemptEpoch: number;
  barrierEpoch: number;
  runStatus: RunStatus;
  phase: string;
  gate: GateStatus;
  barrier: BarrierStatus;
  readyCount: number;
  activeCount: number;
  pendingDispatchCount: number;
  unknownDispatchCount: number;
  nextAction: string;
};

export type Yield =
  | { kind: 'WAITING'; cursor: Cursor; snapshot: CompactSnapshot }
  | { kind: 'DECISION_REQUIRED'; brief: Ref; token: string; cursor: Cursor; snapshot: CompactSnapshot }
  | { kind: 'BLOCKED'; code: string; reason: string; receipt?: Ref; launchToken?: string; retryable: boolean; snapshot: CompactSnapshot }
  | { kind: 'FINAL'; status: 'phase-ready' | 'complete'; artifacts: Ref[]; snapshot: CompactSnapshot };

export type OutboxCommand = {
  commandId: string;
  runId: string;
  phaseId: string;
  stepId: string;
  attemptEpoch: number;
  authorityEpoch: number;
  barrierEpoch: number;
  modeEpoch: number;
  launchToken: string;
  commandDigest: Sha256;
  state: OutboxState;
  /** Private managed-dispatch input. It is materialized and committed in the
   * claim CAS before provider entry; ordinary commands omit both fields. */
  roleView?: Ref;
  predecessorReportDigests?: Sha256[];
  receipt?: Ref;
  leaseId?: string;
  noEffectEvidence?: Ref[];
};

/**
 * Decision records are private durable state.  Gate records retain the
 * original compact shape; authority-adoption records additionally bind the
 * observed and target plan digests so a parent cannot acknowledge a different
 * declaration than the one that produced DECISION_REQUIRED.
 */
export type DecisionToken = {
  kind: string;
  consumed: boolean;
  identity: string;
  expectedDigest?: string;
  observedDigest?: string;
  targetDigest?: string;
  /** Managed deliberation selection binding.  All fields are private and
   * validated as a closed tuple by the store before any CAS. */
  authorshipInputDigest?: Sha256;
  decisionKey?: string;
  waveRef?: Ref;
  orderedReportRefs?: Ref[];
  predecessorGeneration?: number;
  disposition?: string;
  nullableSettlement?: Sha256 | null;
  /** Exact full PlanAuthorshipResult binding captured by the consuming CAS. */
  resultKind?: 'COMPLETE_PLAN' | 'DELIBERATION_REQUIRED' | 'NO_SETTLEMENT';
  resultDigest?: Sha256;
  /** Private publication lease binding for a consumed deliberation token. */
  publicationLeaseSetId?: string;
  successorWaveRef?: Ref;
  bindingDigest?: Sha256;
  rolloutOrigin?: ManagedRolloutProjection;
};

export type MachineStep = PlanStep & { status: StepStatus; attempt: number; lastEvent?: string };
export type MachineState = {
  schema: 1 | 2;
  runId: string;
  phaseId: string;
  revision: number;
  authorityEpoch: number;
  attemptEpoch: number;
  barrierEpoch: number;
  modeEpoch: number;
  writerFence: string;
  status: RunStatus;
  gate: GateStatus;
  barrier: BarrierStatus;
  steps: Record<string, MachineStep>;
  outbox: Record<string, OutboxCommand>;
  processed: Record<string, { digest: string; yieldBytes: string; revision: number; identity: EventIdentity }>;
  decisionTokens: Record<string, DecisionToken>;
  planDigest: Sha256;
  nextAction: string;
  journal: Array<{ identity: EventIdentity; event: Event; digest: Sha256; revision: number }>;
  /** Present only on schema 2 managed states. */
  managed?: ManagedState;
};
