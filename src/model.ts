export type RunId = string & { readonly __runId: unique symbol };
export type PhaseId = string & { readonly __phaseId: unique symbol };
export type StepId = string & { readonly __stepId: unique symbol };
export type EventId = string & { readonly __eventId: unique symbol };
export type Sha256 = string & { readonly __sha256: unique symbol };
export type LaunchToken = string & { readonly __launchToken: unique symbol };

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
};

export type MachineStep = PlanStep & { status: StepStatus; attempt: number; lastEvent?: string };
export type MachineState = {
  schema: 1;
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
};
