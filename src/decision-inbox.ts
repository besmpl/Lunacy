import { canonicalString, digest, identityKey, parseCanonical } from './canonical.js';
import { canonicalizeDeclaration } from './bridge.js';
import { initRun, resumeRun, type LifecycleResult, type TerminalEffectDriver } from './orchestration.js';
import { FileArtifactStore, isCanonicalRootPath } from './store.js';
import { validateCodexHostPolicy, codexHostPolicyDigest, type CodexHostPolicy } from './codex-host-policy.js';
import type { DecisionToken, EventIdentity, MachineState, Plan, Yield } from './model.js';

/** Private, projection-only decision inbox.  It is deliberately not exported
 * from the package root: tokens remain owned and consumed by RunKernel. */
export const DECISION_INBOX_SCHEMA = 'lunacy-decision-inbox/v1' as const;
export const DECISION_INBOX_VERSION = 1 as const;
export const PHASE_HANDOFF_SCHEMA = 'lunacy-phase-handoff/v1' as const;
export const PHASE_HANDOFF_VERSION = 1 as const;
const MAX_ENTRIES = 64;
const MAX_ID = 256;
const MAX_OUTPUT_BYTES = 16 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const FRESH_DECISION_WINNER = Symbol('fresh-decision-winner');

export type DecisionInboxSelection = Readonly<{
  runRoot: string;
  runId: string;
  /** Exact token selected by the caller.  Omit only to project the first
   * unconsumed token from this run; no token is created by this operation. */
  token?: string;
  planDigest?: string;
  policyDigest?: string;
}>;

export type DecisionInboxEntry = Readonly<{
  schema: typeof DECISION_INBOX_SCHEMA;
  version: typeof DECISION_INBOX_VERSION;
  run: { runRoot: string; runId: string; phaseId: string; generation: number; revision: number; planDigest: string; policyDigest: string | null };
  token: { value: string | null; kind: string | null; identityDigest: string | null; consumed: boolean | null; expectedDigest: string | null; observedDigest: string | null; targetDigest: string | null };
  cursor: { revision: number; authorityEpoch: number; attemptEpoch: number; barrierEpoch: number };
  status: 'READY' | 'CONSUMED' | 'ABSENT' | 'ATTENTION';
  attention: { code: 'NONE' | 'GATE_DUE' | 'GATE_FINDINGS' | 'UNKNOWN_DISPATCH' | 'RUN_BLOCKED' | 'BARRIER_CLOSED' | 'STALE_BINDING' | 'MALFORMED'; nextProof: string | null };
  /** Stable proof identities only; payloads and receipts are never exposed. */
  briefDigest: string | null;
  evidenceDigest: string | null;
  nextProof: string | null;
  redaction: { brief: null; evidence: null; receipts: null; paths: null };
}>;

export type DecisionInboxListInput = Readonly<{ entries: readonly DecisionInboxSelection[]; limit?: number }>;
export type DecisionInboxList = Readonly<{ schema: typeof DECISION_INBOX_SCHEMA; version: typeof DECISION_INBOX_VERSION; entries: readonly DecisionInboxEntry[]; truncation: boolean }>;
export type DecisionInboxDeriveInput = Readonly<{ state: MachineState; runRoot: string; generation?: number; token?: string; planDigest?: string; policyDigest?: string }>;

export type SubmitDecisionInput = Readonly<{
  selection: DecisionInboxSelection;
  /** Entry returned by listDecisionInbox.  It is required to prevent an
   * unbound token string from becoming a new authority. */
  inbox: DecisionInboxEntry;
  value: unknown;
  eventId?: string;
  plan: Plan;
  policy?: CodexHostPolicy;
  driver?: TerminalEffectDriver;
}>;

export type SubmitDecisionResult = Readonly<{
  schema: typeof DECISION_INBOX_SCHEMA;
  version: typeof DECISION_INBOX_VERSION;
  status: 'committed' | 'replayed' | 'attention';
  code?: 'BindingMismatch' | 'Consumed' | 'KernelConflict' | 'Malformed';
  consumed: boolean;
  yield?: Yield;
  revision: number;
  eventId: string;
}>;
export type ParentDecisionSubmission = Readonly<{ event: Readonly<{ kind: 'PARENT_DECISION'; token: string; value: unknown }>; eventId: string; identity: EventIdentity; eventDigest: string; eventIdentityDigest: string }>;

export type PhaseHandoffAuthorization = Readonly<{
  kind: 'PROMOTE_PHASE';
  predecessorRunId: string;
  predecessorPhaseId: string;
  successorRunId: string;
  successorPhaseId: string;
  successorPlanDigest: string;
  eventId: string;
}>;

export type PhaseHandoff = Readonly<{
  schema: typeof PHASE_HANDOFF_SCHEMA;
  version: typeof PHASE_HANDOFF_VERSION;
  predecessor: { runRoot: string; runId: string; phaseId: string; generation: number; revision: number; planDigest: string; proofDigest: string };
  successor: { runRoot: string; runId: string; phaseId: string; plan: Plan; planDigest: string };
  authorization: PhaseHandoffAuthorization;
  authorizationDigest: string;
}>;

export type PromotePhaseResult = Readonly<{
  schema: typeof PHASE_HANDOFF_SCHEMA;
  version: typeof PHASE_HANDOFF_VERSION;
  status: 'initialized' | 'replayed' | 'attention';
  code?: 'BindingMismatch' | 'PredecessorNotFinal' | 'LiveOldWork' | 'SuccessorConflict' | 'Malformed';
  predecessor: { runId: string; phaseId: string; proofDigest: string };
  successor: { runId: string; phaseId: string; planDigest: string };
  lifecycle?: LifecycleResult;
}>;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function fail(message: string): never { throw new Error(`DecisionInbox: ${message}`); }
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID || value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid`);
  return value;
}
function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} is invalid`);
  return value as number;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} is invalid`);
  return value;
}
function exactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} fields are invalid`);
}
function stableCompare(a: string, b: string): number { return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
function root(value: unknown, label: string): string {
  if (!isCanonicalRootPath(value)) fail(`${label} must be an absolute canonical path`);
  return value;
}
function token(value: unknown, label = 'token'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID || value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid`);
  return value;
}
function boundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > MAX_ID || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid`);
  return value;
}
/** Snapshot an untrusted structured boundary before the first filesystem or
 * dynamic-import await. Callers may mutate their object after the operation
 * starts; re-reading it later would let one request carry two bindings. */
function canonicalSnapshot<T>(value: unknown, label: string): T {
  try { return parseCanonical<T>(canonicalString(value)); }
  catch { fail(`${label} is malformed`); }
}
function validateSelection(input: DecisionInboxSelection): DecisionInboxSelection {
  if (!plainObject(input)) fail('selection is malformed');
  const result: DecisionInboxSelection = { runRoot: root(input.runRoot, 'runRoot'), runId: id(input.runId, 'runId'), ...(input.token === undefined ? {} : { token: token(input.token) }), ...(input.planDigest === undefined ? {} : { planDigest: sha(input.planDigest, 'planDigest') }), ...(input.policyDigest === undefined ? {} : { policyDigest: sha(input.policyDigest, 'policyDigest') }) };
  return result;
}
function policyDigestFor(policy: CodexHostPolicy | undefined, selection: DecisionInboxSelection): string | undefined {
  if (!policy) {
    if (selection.policyDigest !== undefined) fail('policyDigest requires a policy witness');
    return undefined;
  }
  try { validateCodexHostPolicy(policy); } catch (error) { fail(`policy is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  if (policy.runRoot !== selection.runRoot || policy.runId !== selection.runId) fail('policy does not match run identity');
  const digestValue = codexHostPolicyDigest(policy);
  if (selection.policyDigest !== undefined && selection.policyDigest !== digestValue) fail('policyDigest does not match policy');
  return digestValue;
}

function tokenRecord(value: DecisionToken | undefined): DecisionInboxEntry['token'] {
  if (!value) return { value: null, kind: null, identityDigest: null, consumed: null, expectedDigest: null, observedDigest: null, targetDigest: null };
  return { value: null, kind: value.kind, identityDigest: SHA256.test(value.identity) ? value.identity : null, consumed: value.consumed, expectedDigest: value.expectedDigest && SHA256.test(value.expectedDigest) ? value.expectedDigest : null, observedDigest: value.observedDigest && SHA256.test(value.observedDigest) ? value.observedDigest : null, targetDigest: value.targetDigest && SHA256.test(value.targetDigest) ? value.targetDigest : null };
}
function adoptionDigest(value: unknown, record: DecisionToken): string | undefined {
  if (!plainObject(value) || record.kind !== 'AUTHORITY_ADOPTION') return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.some((key) => key === 'kind' || key === 'decision') || !keys.some((key) => key === 'digest' || key === 'planDigest' || key === 'authorityDigest')) return undefined;
  const verb = value.kind ?? value.decision;
  const requested = value.digest ?? value.planDigest ?? value.authorityDigest;
  return (verb === 'ADOPT' || verb === 'ADOPT_AUTHORITY' || verb === 'AUTHORITY_ADOPT') && typeof requested === 'string' ? requested : undefined;
}
function attentionFor(state: MachineState, record: DecisionToken | undefined): DecisionInboxEntry['attention'] {
  if (state.gate === 'DUE') return { code: 'GATE_DUE', nextProof: 'submit the explicit parent gate decision' };
  if (state.gate === 'FINDINGS') return { code: 'GATE_FINDINGS', nextProof: 'submit the explicit parent repair decision' };
  if (state.barrier === 'CLOSED') return { code: 'BARRIER_CLOSED', nextProof: 'rebind the current parent cursor' };
  if (Object.values(state.outbox).some((command) => command.state === 'UNKNOWN')) return { code: 'UNKNOWN_DISPATCH', nextProof: 'reconcile the exact launch token before deciding' };
  if (state.status === 'BLOCKED') return { code: 'RUN_BLOCKED', nextProof: 'obtain the explicit parent proof named by the run' };
  if (record?.kind === 'AUTHORITY_ADOPTION') return { code: 'STALE_BINDING', nextProof: 'acknowledge the exact authority digest' };
  return { code: 'NONE', nextProof: null };
}
function latestBriefDigest(state: MachineState, tokenValue?: string): string | null {
  let bestRevision = -1;
  let bestDigest: string | null = null;
  for (const record of Object.values(state.processed)) {
    if (!record || typeof record.yieldBytes !== 'string') continue;
    try {
      const value = parseCanonical<Record<string, unknown>>(record.yieldBytes);
      const brief = value.kind === 'DECISION_REQUIRED' && plainObject(value.brief) && (tokenValue === undefined || value.token === tokenValue) ? value.brief : undefined;
      const revision = plainObject(value.cursor) && Number.isSafeInteger(value.cursor.revision) ? value.cursor.revision as number : -1;
      if (brief && typeof brief.digest === 'string' && SHA256.test(brief.digest) && revision >= bestRevision) {
        bestRevision = revision;
        bestDigest = brief.digest;
      }
    } catch { /* verified store records are canonical; malformed bytes are ignored */ }
  }
  return bestDigest;
}
type LoadedInboxState = Readonly<{ state?: MachineState; generation: number }>;
function entryFromState(selection: DecisionInboxSelection, loaded: LoadedInboxState): DecisionInboxEntry {
  const state = loaded.state;
  if (!state) fail('committed state is absent');
  const requested = selection.token;
  const tokenValue = requested ?? Object.keys(state.decisionTokens).sort(stableCompare).find((name) => !state.decisionTokens[name]?.consumed);
  const record = tokenValue === undefined ? undefined : state.decisionTokens[tokenValue];
  const briefDigest = latestBriefDigest(state, tokenValue);
  const suppliedPlanDigest = selection.planDigest;
  if (suppliedPlanDigest !== undefined && suppliedPlanDigest !== state.planDigest) {
    return Object.freeze({ schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, run: { runRoot: selection.runRoot, runId: state.runId, phaseId: state.phaseId, generation: loaded.generation, revision: state.revision, planDigest: state.planDigest, policyDigest: selection.policyDigest ?? null }, token: { ...tokenRecord(record), value: tokenValue ?? null }, cursor: { revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch }, status: 'ATTENTION', attention: { code: 'STALE_BINDING' as const, nextProof: 're-read the selected run and plan digest' }, briefDigest, evidenceDigest: null, nextProof: 're-read the selected run and plan digest', redaction: { brief: null, evidence: null, receipts: null, paths: null } });
  }
  const attention: DecisionInboxEntry['attention'] = record === undefined && tokenValue !== undefined
    ? { code: 'STALE_BINDING', nextProof: 're-read the selected run and token identity' }
    : attentionFor(state, record);
  const status: DecisionInboxEntry['status'] = tokenValue === undefined ? (attention.code === 'NONE' ? 'ABSENT' : 'ATTENTION') : record === undefined ? 'ATTENTION' : record.consumed ? 'CONSUMED' : 'READY';
  return Object.freeze({ schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, run: { runRoot: selection.runRoot, runId: state.runId, phaseId: state.phaseId, generation: loaded.generation, revision: state.revision, planDigest: state.planDigest, policyDigest: selection.policyDigest ?? null }, token: { ...tokenRecord(record), value: tokenValue ?? null }, cursor: { revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch }, status, attention, briefDigest, evidenceDigest: record?.observedDigest && SHA256.test(record.observedDigest) ? record.observedDigest : null, nextProof: attention.nextProof, redaction: { brief: null, evidence: null, receipts: null, paths: null } });
}

/** Pure projection helper for callers that already hold a verified state. */
export function deriveDecisionInbox(input: DecisionInboxDeriveInput): DecisionInboxEntry {
  if (!plainObject(input) || !plainObject(input.state)) fail('derive input is malformed');
  const selection = validateSelection({ runRoot: input.runRoot, runId: input.state.runId, ...(input.token === undefined ? {} : { token: input.token }), ...(input.planDigest === undefined ? {} : { planDigest: input.planDigest }), ...(input.policyDigest === undefined ? {} : { policyDigest: input.policyDigest }) });
  return entryFromState(selection, { state: input.state, generation: input.generation ?? 0 });
}

/** Read only explicitly selected runs.  No directory or queue enumeration is
 * performed and the store's read-only trust boundary performs no writes. */
export async function listDecisionInbox(input: DecisionInboxListInput): Promise<DecisionInboxList> {
  if (!plainObject(input) || !Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > MAX_ENTRIES) fail('entries must be a bounded non-empty array');
  const limit = input.limit === undefined ? MAX_ENTRIES : nonNegative(input.limit, 'limit');
  if (limit > MAX_ENTRIES) fail('limit exceeds inbox ceiling');
  const selections = input.entries.map(validateSelection);
  const rows: DecisionInboxEntry[] = [];
  for (const selection of selections) {
    const loaded = await new FileArtifactStore(selection.runRoot).loadReadOnly(selection.runId);
    rows.push(entryFromState(selection, loaded));
  }
  rows.sort((a, b) => a.cursor.revision - b.cursor.revision || stableCompare(a.run.runId, b.run.runId) || stableCompare(a.token.value ?? '', b.token.value ?? ''));
  const result: DecisionInboxList = Object.freeze({ schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, entries: Object.freeze(rows.slice(0, limit)), truncation: rows.length > limit });
  if (Buffer.byteLength(canonicalString(result), 'utf8') > MAX_OUTPUT_BYTES) fail('inbox output exceeds byte ceiling');
  return result;
}

function validateInbox(value: unknown): asserts value is DecisionInboxEntry {
  if (!plainObject(value) || value.schema !== DECISION_INBOX_SCHEMA || value.version !== DECISION_INBOX_VERSION || !plainObject(value.run) || !plainObject(value.token) || !plainObject(value.cursor) || !plainObject(value.attention) || !plainObject(value.redaction)) fail('inbox envelope is malformed');
  exactKeys(value, ['schema', 'version', 'run', 'token', 'cursor', 'status', 'attention', 'briefDigest', 'evidenceDigest', 'nextProof', 'redaction'], 'inbox');
  exactKeys(value.run, ['runRoot', 'runId', 'phaseId', 'generation', 'revision', 'planDigest', 'policyDigest'], 'inbox.run');
  exactKeys(value.token, ['value', 'kind', 'identityDigest', 'consumed', 'expectedDigest', 'observedDigest', 'targetDigest'], 'inbox.token');
  exactKeys(value.cursor, ['revision', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch'], 'inbox.cursor');
  exactKeys(value.attention, ['code', 'nextProof'], 'inbox.attention'); exactKeys(value.redaction, ['brief', 'evidence', 'receipts', 'paths'], 'inbox.redaction');
  root(value.run.runRoot, 'inbox.run.runRoot'); id(value.run.runId, 'inbox.run.runId'); id(value.run.phaseId, 'inbox.run.phaseId'); nonNegative(value.run.generation, 'inbox.run.generation'); nonNegative(value.run.revision, 'inbox.run.revision'); sha(value.run.planDigest, 'inbox.run.planDigest'); if (value.run.policyDigest !== null) sha(value.run.policyDigest, 'inbox.run.policyDigest');
  if (!['READY', 'CONSUMED', 'ABSENT', 'ATTENTION'].includes(String(value.status))) fail('inbox status is invalid');
  if (value.token.value !== null) token(value.token.value, 'inbox token'); if (value.token.identityDigest !== null) sha(value.token.identityDigest, 'inbox token identity');
  if (value.token.kind !== null && typeof value.token.kind !== 'string') fail('inbox token kind is invalid');
  if (typeof value.token.consumed !== 'boolean' && value.token.consumed !== null) fail('inbox token consumed is invalid');
  for (const field of ['expectedDigest', 'observedDigest', 'targetDigest'] as const) if (value.token[field] !== null) sha(value.token[field], `inbox token ${field}`);
  for (const field of ['revision', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch'] as const) nonNegative(value.cursor[field], `inbox cursor ${field}`);
  if (!['NONE', 'GATE_DUE', 'GATE_FINDINGS', 'UNKNOWN_DISPATCH', 'RUN_BLOCKED', 'BARRIER_CLOSED', 'STALE_BINDING', 'MALFORMED'].includes(String(value.attention.code))) fail('inbox attention is invalid');
  if (value.attention.nextProof !== null) boundedText(value.attention.nextProof, 'inbox attention nextProof');
  if (value.briefDigest !== null) sha(value.briefDigest, 'inbox briefDigest'); if (value.evidenceDigest !== null) sha(value.evidenceDigest, 'inbox evidenceDigest'); if (value.nextProof !== null) boundedText(value.nextProof, 'inbox nextProof');
  for (const field of ['brief', 'evidence', 'receipts', 'paths']) if (value.redaction[field] !== null) fail('inbox redaction is invalid');
}

/** One immutable constructor shared by normal submission and the private
 * retention parent-gate wrapper. It never submits or writes. */
export function constructParentDecisionSubmission(input: Readonly<{ selection: DecisionInboxSelection; inbox: DecisionInboxEntry; state: MachineState; value: unknown; eventId?: string }>): ParentDecisionSubmission {
  const selection = validateSelection(input.selection); const inbox = canonicalSnapshot<DecisionInboxEntry>(input.inbox, 'inbox'); validateInbox(inbox); const state = canonicalSnapshot<MachineState>(input.state, 'state');
  const selectedToken = token(selection.token, 'selection.token'); const event = Object.freeze({ kind: 'PARENT_DECISION' as const, token: selectedToken, value: input.value });
  const eventId = input.eventId === undefined ? `inbox-${digest({ runId: selection.runId, phaseId: state.phaseId, token: selectedToken, value: input.value }).slice(0, 32)}` : id(input.eventId, 'eventId');
  const currentIdentity: EventIdentity = { runId: selection.runId, phaseId: state.phaseId, stepId: 'run', attemptEpoch: state.attemptEpoch, authorityEpoch: state.authorityEpoch, barrierEpoch: state.barrierEpoch, eventId, payloadDigest: digest(event) };
  const priorIdentity: EventIdentity = { ...currentIdentity, attemptEpoch: inbox.cursor.attemptEpoch, authorityEpoch: inbox.cursor.authorityEpoch, barrierEpoch: inbox.cursor.barrierEpoch };
  const identity = Object.prototype.hasOwnProperty.call(state.processed, identityKey(priorIdentity)) ? priorIdentity : currentIdentity;
  return Object.freeze({ event, eventId, identity: Object.freeze(identity), eventDigest: digest(event), eventIdentityDigest: digest(identity) });
}

/** Submit exactly one parent decision through RunKernel.advance. */
export async function submitParentDecision(input: SubmitDecisionInput): Promise<SubmitDecisionResult> {
  if (!plainObject(input)) fail('submit input is malformed');
  if (input.eventId !== undefined) id(input.eventId, 'eventId');
  const driver = input.driver;
  const policy = input.policy;
  const selection = validateSelection(input.selection);
  const inbox = canonicalSnapshot<DecisionInboxEntry>(input.inbox, 'inbox');
  validateInbox(inbox);
  if (inbox.run.runRoot !== selection.runRoot || inbox.run.runId !== selection.runId || inbox.token.value !== selection.token) return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'BindingMismatch', consumed: false, revision: inbox.run.revision, eventId: input.eventId ?? '' };
  if (selection.planDigest !== undefined && selection.planDigest !== inbox.run.planDigest) return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'BindingMismatch', consumed: false, revision: inbox.run.revision, eventId: input.eventId ?? '' };
  // Snapshot caller-owned structured values before the first filesystem await.
  // Primitive gate choices are immutable; malformed structured values remain
  // malformed and are rejected below without reaching the kernel.
  let value = input.value;
  if (value !== null && typeof value === 'object') {
    try { value = canonicalSnapshot<unknown>(value, 'decision value'); }
    catch { value = undefined; }
  }
  let planSnapshot: Plan;
  try { planSnapshot = canonicalSnapshot<Plan>(input.plan, 'plan'); }
  catch { return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'Malformed', consumed: false, revision: inbox.run.revision, eventId: input.eventId ?? '' }; }
  const selectedToken = token(selection.token, 'selection.token');
  const policyDigest = policyDigestFor(policy, selection);
  const loaded = await new FileArtifactStore(selection.runRoot).loadReadOnly(selection.runId);
  const state = loaded.state; if (!state) fail('committed state is absent');
  const current = state.decisionTokens[selectedToken];
  if (!current || ((current.kind !== 'GATE' || (value !== 'PASS' && value !== 'FINDINGS')) && adoptionDigest(value, current) === undefined)) return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'Malformed', consumed: false, revision: inbox.run.revision, eventId: input.eventId ?? '' };
  // Structured adoption values survive the dynamic import/advance await.
  // Snapshot once so payloadDigest and the kernel see identical bytes even if
  // the caller mutates the original object after this function yields.
  const decisionValue = value;
  const submission = constructParentDecisionSubmission({ selection, inbox, state, value: decisionValue, ...(input.eventId === undefined ? {} : { eventId: input.eventId }) });
  const { event, eventId, identity } = submission;
  const replayed = Object.prototype.hasOwnProperty.call(state.processed, identityKey(identity));
  if (inbox.status === 'ABSENT' || inbox.status === 'ATTENTION' || (inbox.status === 'CONSUMED' && !current.consumed)) {
    return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'BindingMismatch', consumed: Boolean(current.consumed), revision: state.revision, eventId };
  }
  const currentBrief = latestBriefDigest(state, selectedToken);
  const currentEvidence = current.observedDigest && SHA256.test(current.observedDigest) ? current.observedDigest : null;
  const sameDigests = inbox.briefDigest === currentBrief && inbox.evidenceDigest === currentEvidence;
  const sameCursor = inbox.run.generation === loaded.generation && inbox.run.revision === state.revision && inbox.run.phaseId === state.phaseId && inbox.run.planDigest === state.planDigest && inbox.cursor.revision === state.revision && inbox.cursor.authorityEpoch === state.authorityEpoch && inbox.cursor.attemptEpoch === state.attemptEpoch && inbox.cursor.barrierEpoch === state.barrierEpoch && (inbox.run.policyDigest ?? null) === (policyDigest ?? null) && sameDigests;
  const replayPlanBound = inbox.run.planDigest === state.planDigest || (replayed && current.kind === 'AUTHORITY_ADOPTION' && inbox.run.planDigest === current.expectedDigest);
  const replayCursor = replayPlanBound && inbox.run.phaseId === state.phaseId && inbox.cursor.authorityEpoch === identity.authorityEpoch && inbox.cursor.attemptEpoch === identity.attemptEpoch && inbox.cursor.barrierEpoch === identity.barrierEpoch && sameDigests && replayed;
  const tokenMatches = Boolean(current && inbox.token.kind === current.kind && inbox.token.identityDigest === current.identity && (inbox.token.consumed === current.consumed || replayed) && (inbox.token.expectedDigest ?? undefined) === current.expectedDigest && (inbox.token.observedDigest ?? undefined) === current.observedDigest && (inbox.token.targetDigest ?? undefined) === current.targetDigest);
  if (!tokenMatches || (!sameCursor && !replayCursor)) {
    return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'BindingMismatch', consumed: false, revision: state.revision, eventId };
  }
  let submittedPlan: Plan;
  let rawPlan: Plan;
  try {
    // Keep both the normalized declaration (for the binding fence) and one
    // immutable raw snapshot (for the kernel's raw-vs-normalized adoption
    // digest alias). Never pass a caller-mutable object across the await.
    rawPlan = planSnapshot;
    submittedPlan = canonicalizeDeclaration(rawPlan);
  }
  catch { return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'Malformed', consumed: false, revision: state.revision, eventId }; }
  const rawPlanDigest = current.kind === 'AUTHORITY_ADOPTION' ? (() => { try { return digest(rawPlan); } catch { return undefined; } })() : undefined;
  const requestedAdoptionDigest = current.kind === 'AUTHORITY_ADOPTION' ? adoptionDigest(decisionValue, current) : undefined;
  if (current.kind === 'AUTHORITY_ADOPTION' && requestedAdoptionDigest !== current.targetDigest && requestedAdoptionDigest !== rawPlanDigest) return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'BindingMismatch', consumed: false, revision: state.revision, eventId };
  const acceptedPlanDigest = current.kind === 'AUTHORITY_ADOPTION' ? current.targetDigest : state.planDigest;
  if (acceptedPlanDigest === undefined || digest(submittedPlan) !== acceptedPlanDigest) return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'BindingMismatch', consumed: false, revision: state.revision, eventId };
  if (current.consumed && !replayed) return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'Consumed', consumed: true, revision: state.revision, eventId };
  let yielded: Yield;
  let winnerWitness: typeof FRESH_DECISION_WINNER | undefined;
  const kernelPlan = current.kind === 'AUTHORITY_ADOPTION' ? rawPlan : submittedPlan;
  try {
    yielded = await (await import('./public.js')).makeRunKernel({ plan: kernelPlan, rootDir: selection.runRoot }).advance({ runId: selection.runId, expectedRevision: state.revision, identity, event });
    if (!replayed && driver !== undefined) winnerWitness = FRESH_DECISION_WINNER;
  }
  catch (error) {
    // Two identical submitters may both pass the read-only fence before one
    // commits. Rebind to the committed generation and read the kernel's exact
    // processed replay; never synthesize a second event or call the kernel a
    // second time from this boundary.
    try {
      const latest = await new FileArtifactStore(selection.runRoot).loadReadOnly(selection.runId);
      const latestState = latest.state;
      const replay = latestState?.processed[identityKey(identity)];
      if (replay && typeof replay.yieldBytes === 'string') {
        const parsed = parseCanonical<Yield>(replay.yieldBytes);
        return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'replayed', consumed: false, revision: parsed.snapshot.revision, eventId, yield: parsed };
      }
    } catch { /* retain the closed conflict below */ }
    return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'KernelConflict', consumed: false, revision: state.revision, eventId };
  }
  // A kernel decision can intentionally return the current DECISION_REQUIRED
  // snapshot (for example, authority adoption while old work is still live)
  // without consuming the token. Only a revision-advancing yield is a commit.
  if (!replayed && yielded.snapshot.revision === state.revision) return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: 'attention', code: 'KernelConflict', consumed: false, revision: yielded.snapshot.revision, eventId, yield: yielded };
  if (winnerWitness === FRESH_DECISION_WINNER) {
    // The symbol is process-local and never enters the durable/public result.
    // Clear it before the tail-call so an error cannot make this submission
    // consume the witness a second time.
    winnerWitness = undefined;
    await resumeRun({ command: 'resume', runDir: selection.runRoot, runId: selection.runId, plan: kernelPlan, driver, ...(policy === undefined ? {} : { policy }) });
  }
  return { schema: DECISION_INBOX_SCHEMA, version: DECISION_INBOX_VERSION, status: replayed ? 'replayed' : 'committed', consumed: !replayed, revision: yielded.snapshot.revision, eventId, yield: yielded };
}

function proofDigest(state: MachineState): string {
  return digest({ runId: state.runId, phaseId: state.phaseId, planDigest: state.planDigest, revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, gate: state.gate, status: state.status });
}
function validateAuthorization(value: unknown): asserts value is PhaseHandoffAuthorization {
  if (!plainObject(value) || value.kind !== 'PROMOTE_PHASE' || typeof value.eventId !== 'string' || value.eventId.length === 0) fail('authorization is malformed');
  exactKeys(value, ['kind', 'predecessorRunId', 'predecessorPhaseId', 'successorRunId', 'successorPhaseId', 'successorPlanDigest', 'eventId'], 'authorization');
  id(value.predecessorRunId, 'authorization.predecessorRunId'); id(value.predecessorPhaseId, 'authorization.predecessorPhaseId'); id(value.successorRunId, 'authorization.successorRunId'); id(value.successorPhaseId, 'authorization.successorPhaseId'); sha(value.successorPlanDigest, 'authorization.successorPlanDigest'); id(value.eventId, 'authorization.eventId');
}
function validateHandoff(value: PhaseHandoff): void {
  if (!plainObject(value) || value.schema !== PHASE_HANDOFF_SCHEMA || value.version !== PHASE_HANDOFF_VERSION || !plainObject(value.predecessor) || !plainObject(value.successor)) fail('handoff is malformed');
  exactKeys(value, ['schema', 'version', 'predecessor', 'successor', 'authorization', 'authorizationDigest'], 'handoff');
  exactKeys(value.predecessor, ['runRoot', 'runId', 'phaseId', 'generation', 'revision', 'planDigest', 'proofDigest'], 'predecessor');
  exactKeys(value.successor, ['runRoot', 'runId', 'phaseId', 'plan', 'planDigest'], 'successor');
  root(value.predecessor.runRoot, 'predecessor.runRoot'); id(value.predecessor.runId, 'predecessor.runId'); id(value.predecessor.phaseId, 'predecessor.phaseId'); nonNegative(value.predecessor.generation, 'predecessor.generation'); nonNegative(value.predecessor.revision, 'predecessor.revision'); sha(value.predecessor.planDigest, 'predecessor.planDigest'); sha(value.predecessor.proofDigest, 'predecessor.proofDigest');
  root(value.successor.runRoot, 'successor.runRoot'); id(value.successor.runId, 'successor.runId'); id(value.successor.phaseId, 'successor.phaseId'); sha(value.successor.planDigest, 'successor.planDigest'); validateAuthorization(value.authorization); sha(value.authorizationDigest, 'authorizationDigest');
  if (digest(value.authorization) !== value.authorizationDigest) fail('authorization digest mismatch');
  const plan = canonicalizeDeclaration(value.successor.plan); if (digest(plan) !== value.successor.planDigest || plan.phaseId !== value.successor.phaseId) fail('successor plan digest mismatch');
  if (value.authorization.predecessorRunId !== value.predecessor.runId || value.authorization.predecessorPhaseId !== value.predecessor.phaseId || value.authorization.successorRunId !== value.successor.runId || value.authorization.successorPhaseId !== value.successor.phaseId || value.authorization.successorPlanDigest !== value.successor.planDigest) fail('authorization identity mismatch');
}

/** Promote one exact predecessor to one explicitly named successor. */
export async function promotePhase(input: Readonly<{ handoff: PhaseHandoff; driver?: TerminalEffectDriver; policy?: CodexHostPolicy }>): Promise<PromotePhaseResult> {
  if (!plainObject(input)) fail('promotion input is malformed');
  const handoff = canonicalSnapshot<PhaseHandoff>(input.handoff, 'handoff');
  validateHandoff(handoff);
  const predecessorLoaded = await new FileArtifactStore(handoff.predecessor.runRoot).loadReadOnly(handoff.predecessor.runId);
  const predecessor = predecessorLoaded.state; if (!predecessor) fail('predecessor state is absent');
  const base = { schema: PHASE_HANDOFF_SCHEMA, version: PHASE_HANDOFF_VERSION, predecessor: { runId: predecessor.runId, phaseId: predecessor.phaseId, proofDigest: proofDigest(predecessor) }, successor: { runId: handoff.successor.runId, phaseId: handoff.successor.phaseId, planDigest: handoff.successor.planDigest } };
  if (predecessor.runId !== handoff.predecessor.runId || predecessor.phaseId !== handoff.predecessor.phaseId || predecessor.planDigest !== handoff.predecessor.planDigest || predecessorLoaded.generation !== handoff.predecessor.generation || predecessor.revision !== handoff.predecessor.revision || proofDigest(predecessor) !== handoff.predecessor.proofDigest) return { ...base, status: 'attention', code: 'BindingMismatch' };
  if (predecessor.status !== 'COMPLETE' || predecessor.gate !== 'PASS' || Object.values(predecessor.steps).some((step) => step.status === 'ACTIVE') || Object.values(predecessor.outbox).some((command) => command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN')) return { ...base, status: 'attention', code: predecessor.status === 'COMPLETE' && predecessor.gate === 'PASS' ? 'LiveOldWork' : 'PredecessorNotFinal' };
  const successorPlan = canonicalizeDeclaration(handoff.successor.plan);
  const startEventId = `promotion-${handoff.authorizationDigest.slice(0, 32)}`;
  let successorExisted = false;
  try {
    const prior = await new FileArtifactStore(handoff.successor.runRoot).loadReadOnly(handoff.successor.runId);
    successorExisted = Boolean(prior.state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const uninitialized = /root directory (?:is absent|does not exist)|\.kernel directory (?:is absent|does not exist)|generations directory (?:is absent|does not exist)|committed state is absent/.test(message);
    if (!uninitialized) return { ...base, status: 'attention', code: 'SuccessorConflict' };
  }
  let lifecycle: LifecycleResult;
  try {
    lifecycle = await initRun({ command: 'init', runDir: handoff.successor.runRoot, runId: handoff.successor.runId, plan: successorPlan, ...(input.driver === undefined ? {} : { driver: input.driver }), ...(input.policy === undefined ? {} : { policy: input.policy }), startEventId });
  } catch {
    // A crash after START commit (or a concurrent identical promoter) may
    // report a conflict even though the exact successor identity is durable.
    // Rebind once and let initRun return its canonical replay; a different
    // plan/event remains a closed conflict.
    try {
      const prior = await new FileArtifactStore(handoff.successor.runRoot).loadReadOnly(handoff.successor.runId);
      const state = prior.state;
      const started = state?.planDigest === handoff.successor.planDigest && state.phaseId === handoff.successor.phaseId && state.journal.some((entry) => entry.event.kind === 'START' && entry.identity.eventId === startEventId);
      if (!started) return { ...base, status: 'attention', code: 'SuccessorConflict' };
      lifecycle = await initRun({ command: 'init', runDir: handoff.successor.runRoot, runId: handoff.successor.runId, plan: successorPlan, ...(input.driver === undefined ? {} : { driver: input.driver }), ...(input.policy === undefined ? {} : { policy: input.policy }), startEventId });
      return { ...base, status: 'replayed', lifecycle };
    } catch { return { ...base, status: 'attention', code: 'SuccessorConflict' }; }
  }
  const status = successorExisted ? 'replayed' : 'initialized';
  return { ...base, status, lifecycle };
}

export const inspectDecisionInbox = listDecisionInbox;
export const readDecisionInbox = listDecisionInbox;
export const deriveInbox = deriveDecisionInbox;
export const submitDecision = submitParentDecision;
export const submitInboxDecision = submitParentDecision;
export const promote = promotePhase;
export const promotePhaseRun = promotePhase;
