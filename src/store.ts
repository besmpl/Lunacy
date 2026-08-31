import { promises as fs, constants as fsConstants, type Dirent } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isPromise, isProxy } from 'node:util/types';
import type { Event, EventIdentity, MachineState, OutboxCommand, Ref, ManagedState } from './model.js';
import { assertManagedGraph, verifyManagedCapability, verifyManagedRolloutProjection, type ManagedGraphRef, type ManagedGraphAttemptOwner, type ManagedGraphDecisionOwner } from './managed-capability.js';
import type { DriverReceipt } from './outbox.js';
import { canonicalString, digest, identityKey, parseCanonical } from './canonical.js';
import { validateDependencyTopology } from './dependency.js';
import { deriveTopology, isManagedDissent, reconcileWave, settlementPrefixDigest, validateReport, validateWave, type AcceptedReport, type DeliberationPolicy, type DeliberationReport, type DeliberationWave } from './deliberation.js';
import { validatePlan } from './validator.js';
import { CURRENT_BYTE_CEILING, JOURNAL_BYTE_CEILING, JOURNAL_EVENT_CEILING, MANAGED_METADATA_BYTE_CEILING, READ_ONLY_STATE_BYTE_CEILING } from './limits.js';
import { assertStableIdentity, ensurePrivateDirectory, filesystemIdentity, inspectTrustedPath, sameFilesystemIdentity, trustedIdentity, type FilesystemIdentity } from './filesystem.js';
import {
  assertReleaseAdmissionOpen,
  inspectWriterReclaimMarker,
  managedLaunchOwnerLiveness,
  removeStaleWriterReclaimMarker,
  tryAcquireWriterReclaimMarker,
  type WriterReclaimMarkerClaim,
  type WriterReclaimMarkerObservation,
} from './release-admission.js';

export type StoreSnapshot = { state: MachineState | undefined; generation: number };
export type PublicationLease = { leaseId: string; refs: Ref[]; expiresAt: number; status: 'ACTIVE' | 'PROMOTED' | 'EXPIRED' };
/** Artifact format selector. `segmented` is the shipped v1 format; v2 is an
 * explicit opt-in marker and is intentionally not selected implicitly. */
export type ArtifactFormat = 'legacy' | 'segmented' | 'segmented/v2' | 'segmented-v2';
export type ArtifactStoreOptions = { format?: ArtifactFormat; segmentEventCeiling?: number; faultInjector?: (point: string) => void };

/** Private pre-publication generation CAS conflict. */
const storeGenerationConflicts = new WeakSet<object>();
const fileArtifactStoreAborts = new WeakSet<object>();

function mintStoreGenerationConflict(): Error {
  const error = new Error('manifest revision conflict');
  error.name = 'StoreGenerationConflict';
  if (Error.captureStackTrace) Error.captureStackTrace(error, mintStoreGenerationConflict);
  storeGenerationConflicts.add(error);
  return error;
}

/** Internal authenticity predicate for pre-publication CAS conflicts. */
export function isStoreGenerationConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && storeGenerationConflicts.has(error);
}

function mintFileArtifactStoreAbort(): Error {
  const error = new Error('file artifact store operation cancelled');
  error.name = 'AbortError';
  if (Error.captureStackTrace) Error.captureStackTrace(error, mintFileArtifactStoreAbort);
  fileArtifactStoreAborts.add(error);
  return error;
}

/** Authenticate cancellation minted only by FileArtifactStore's own signal. */
export function isFileArtifactStoreAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && fileArtifactStoreAborts.has(error);
}

/** Managed runtime identity read by the private Workfront inspection seam. */
export type ManagedRuntimeMetadata = {
  schema: 1;
  bridgeVersion: string;
  runtimeVersion: string;
  mode: 'runtime';
  status: 'enabled';
  runId: string;
  phaseId: string;
  rootPath: string;
  planDigest: string;
  sourceDigest: string;
};

export type ReadOnlyStoreSnapshot = StoreSnapshot & { metadata: ManagedRuntimeMetadata };

/** Canonical absolute root spelling required by private managed inspectors. */
export function isCanonicalRootPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.startsWith('/') && !value.includes('\0') && resolve(value) === value;
}

export interface ArtifactStore {
  load(): Promise<StoreSnapshot>;
  commit(previousGeneration: number, state: MachineState): Promise<number>;
  /** Private format hint used by the kernel to lift the legacy journal ceiling
   * only after an explicit segmented selection or a verified segmented head. */
  readonly journalFormat?: ArtifactFormat;
  /** Private managed publication lease family.  Leases are bounded roots;
   * callers must promote only after the authoritative journal CAS succeeds. */
  acquirePublicationLease?(leaseId: string, refs: readonly Ref[], ttlMs?: number): Promise<PublicationLease>;
  promotePublicationLease?(leaseId: string): Promise<PublicationLease>;
  releasePublicationLease?(leaseId: string): Promise<void>;
  collectPublicationLeases?(now?: number): Promise<{ removed: number }>;
}

function cloneState(state: MachineState): MachineState { return JSON.parse(JSON.stringify(state)) as MachineState; }
function cloneCommand(command: OutboxCommand): OutboxCommand { return JSON.parse(JSON.stringify(command)) as OutboxCommand; }
const SHA256 = /^[0-9a-f]{64}$/i;
const BRIDGE_SOURCE_ID = 'lunacy-runtime-skill-bridge/v1';
const RESERVED_PROJECTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const NEXT_ACTIONS = new Set(['start', 'blocked', 'advance-ready-steps', 'await-dispatch-receipt', 'await-dispatch-reconciliation', 'await-worker-envelope', 'await-parent-gate-decision', 'complete']);
function normalizeArtifactFormat(format: ArtifactFormat): ArtifactFormat {
  if (format === 'segmented-v2') return 'segmented/v2';
  return format;
}
function isSegmentedFormat(format: ArtifactFormat | CurrentManifest['format'] | undefined): boolean {
  return format === 'segmented' || format === 'segmented/v1' || format === 'segmented/v2';
}

/** Serialize calls from one process. The filesystem fence below extends the
 * same CAS to independent kernel processes sharing a root directory. */
const locks = new Map<string, Promise<void>>();
function throwIfFileStoreAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw mintFileArtifactStoreAbort();
}

async function awaitProcessTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) { await previous; return; }
  throwIfFileStoreAborted(signal);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = (): void => finish(() => rejectPromise(mintFileArtifactStoreAbort()));
    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(() => finish(resolvePromise));
    if (signal.aborted) onAbort();
  });
  throwIfFileStoreAborted(signal);
}

async function withProcessLock<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  try {
    await awaitProcessTurn(previous, signal);
    return await fn();
  } finally {
    release();
    if (locks.get(key) === queued) void queued.then(() => { if (locks.get(key) === queued) locks.delete(key); });
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ManifestMismatch: ${message}`);
}

function isMalformedReuseIndex(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('ManifestMismatch: reuse index is malformed:');
}

function exactKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  invariant(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} fields are invalid`);
}

function nonNegativeInteger(value: unknown, label: string): void {
  invariant(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, `${label} is invalid`);
}

function identityIsValid(identity: unknown): identity is EventIdentity {
  if (!identity || typeof identity !== 'object') return false;
  const value = identity as Record<string, unknown>;
  if (typeof value.runId !== 'string' || value.runId.length === 0 || typeof value.phaseId !== 'string' || value.phaseId.length === 0 || typeof value.stepId !== 'string' || value.stepId.length === 0 || typeof value.eventId !== 'string' || value.eventId.length === 0) return false;
  if (typeof value.payloadDigest !== 'string' || !SHA256.test(value.payloadDigest)) return false;
  for (const field of ['attemptEpoch', 'authorityEpoch', 'barrierEpoch']) if (typeof value[field] !== 'number' || !Number.isSafeInteger(value[field]) || (value[field] as number) < 0) return false;
  return value.launchToken === undefined || (typeof value.launchToken === 'string' && value.launchToken.length > 0);
}

function refIsValid(ref: unknown): ref is Ref {
  if (!ref || typeof ref !== 'object') return false;
  const value = ref as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['id', 'digest', 'scope', 'bytes'].includes(key))) return false;
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)) return false;
  if (value.scope !== undefined && (typeof value.scope !== 'string' || value.scope.length === 0)) return false;
  if (value.bytes !== undefined) {
    if (typeof value.bytes !== 'string') return false;
    try { const parsed = JSON.parse(value.bytes); if (canonicalString(parsed) !== value.bytes || digest(parsed) !== value.digest) return false; }
    catch { return false; }
  }
  return true;
}

function managedReceiptAuthorityAnchorIsValid(ref: unknown, commandDigest: string, reportDigest: string): ref is Ref {
  if (!refIsValid(ref) || ref.scope !== 'outbox/managed-receipt-authority' || ref.id !== `managed-receipt-authority:${commandDigest}:${ref.digest}` || typeof ref.bytes !== 'string') return false;
  try {
    const payload = parseCanonical<Record<string, unknown>>(ref.bytes);
    return Object.keys(payload).sort().join(',') === 'commandDigest,receiptDigest,reportDigest,schema,teardown,transport'
      && payload.schema === 'lunacy-managed-receipt-authority/v1' && payload.commandDigest === commandDigest && payload.reportDigest === reportDigest
      && typeof payload.receiptDigest === 'string' && SHA256.test(payload.receiptDigest)
      && refIsValid(payload.transport) && (payload.transport as Ref).scope === 'outbox/model-transport'
      && refIsValid(payload.teardown) && (payload.teardown as Ref).scope === 'outbox/teardown';
  } catch { return false; }
}

function dispatchProofIsValid(ref: Ref): boolean {
  try {
    const proof = parseCanonical<Record<string, unknown>>(ref.bytes ?? '');
    return Boolean(proof && typeof proof === 'object' && !Array.isArray(proof) && typeof proof.launchToken === 'string' && typeof proof.commandDigest === 'string'
      && Object.keys(proof).every((key) => ['launchToken', 'commandDigest', 'receipt', 'authorityAnchor'].includes(key))
      && (proof.receipt === undefined || refIsValid(proof.receipt))
      && (proof.authorityAnchor === undefined || (refIsValid(proof.receipt) && managedReceiptAuthorityAnchorIsValid(proof.authorityAnchor, proof.commandDigest, proof.receipt.digest))));
  } catch { return false; }
}

function workerEnvelopeIsValid(ref: Ref): boolean {
  try {
    const result = parseCanonical<Record<string, unknown>>(ref.bytes ?? '');
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    if (typeof result.status === 'string' && Object.keys(result).length === 1) return true;
    // Managed deliberation envelopes carry an exact Report/v2 object. The
    // reducer/store perform the deeper Wave/topology/receipt validation.
    return result.schema === 'lunacy-deliberation-report/v2'
      && Object.prototype.hasOwnProperty.call(result, 'wave')
      && Number.isSafeInteger(result.slotOrdinal);
  } catch { return false; }
}

/** Rebuild the narrow policy binding needed to validate a durable Wave.  The
 * provider policy is not persisted in the public state; Report/v2 still binds
 * its Wave to the exact authored policy version and the deterministic frame
 * catalog shape used by the managed reducer. */
function managedPolicyForWave(wave: DeliberationWave): DeliberationPolicy {
  const frameCatalog = wave.gear === 'EXPLORE'
    ? wave.generatorLenses.map((frame, index) => ({ frameId: frame.frameId, tag: index === 4 ? 'wild' as const : 'code' as const, text: frame.frameId }))
    : [];
  return {
    version: wave.authorship.policyVersion,
    frameCatalog,
    maxMaterialDecisions: 0,
    maxSettlementBytes: wave.limits.maxTotalReportBytes,
    maxResolvedRoleInputBytes: wave.limits.maxResolvedRoleInputBytes,
    convergeCount: 3,
    nonObviousNovelty: 0,
    viableFloor: 0,
  };
}

/** Validate accepted rows as a prefix projection rather than trusting the
 * canonical bytes alone.  Partial rows are valid (the next predecessor may
 * not have arrived); every admitted row must nevertheless be a real current
 * topology slot, and no row may be silently dropped by reconcileWave. */
function validateAcceptedReportProjection(rows: readonly Record<string, unknown>[], state: MachineState): void {
  if (!rows.length) return;
  invariant(state.managed?.proposal !== undefined, 'managed accepted reports require a proposal');
  const groups = new Map<string, { ref: Ref; wave: DeliberationWave; reports: AcceptedReport[] }>();
  for (const row of rows) {
    const reportRef = row.ref as Ref;
    const report = row.report as DeliberationReport;
    let parsed: DeliberationReport;
    try { parsed = parseCanonical<DeliberationReport>(reportRef.bytes!); }
    catch { throw new Error('ManifestMismatch: managed accepted report bytes are invalid'); }
    const waveRef = parsed.wave;
    invariant(waveRef && typeof waveRef === 'object' && waveRef.scope === 'deliberation/wave' && typeof waveRef.bytes === 'string', 'managed accepted report Wave Ref is invalid');
    let wave: DeliberationWave;
    try { wave = parseCanonical<DeliberationWave>(waveRef.bytes); }
    catch { throw new Error('ManifestMismatch: managed accepted report Wave bytes are invalid'); }
    const policy = managedPolicyForWave(wave);
    const waveValidation = validateWave(wave, { runId: state.runId, phaseId: state.phaseId, policy, committedEvidence: new Set(), reachableConstraints: new Set() });
    invariant(waveValidation.ok && digest(wave) === waveRef.digest, 'managed accepted report Wave binding is invalid');
    const topology = deriveTopology(waveRef, waveValidation.value);
    invariant(topology.slots.some((slot) => slot.slotOrdinal === parsed.slotOrdinal), 'managed accepted report slot is outside the topology');
    const key = canonicalString(waveRef);
    const group = groups.get(key) ?? { ref: { ...waveRef }, wave: waveValidation.value, reports: [] };
    group.reports.push({ ref: { ...reportRef }, report, receipt: row.receipt as AcceptedReport['receipt'] });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const result = reconcileWave(group.ref, group.wave, group.reports);
    invariant(result.architecture !== 'CONFLICT' && result.architecture !== 'STALE', 'managed accepted report prefix is not reconciliable');
    invariant(result.refs.length === group.reports.length && group.reports.every((item) => result.refs.some((ref) => canonicalString(ref) === canonicalString(item.ref))), 'managed accepted report row is outside the validated prefix');
  }
}

function managedSettlementPrefixStore(state: MachineState, token: Record<string, unknown>): Ref[] | undefined {
  const generation = token.predecessorGeneration;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation)) return undefined;
  const generationNumber = generation;
  const rows: Array<{ generation: number; ref: Ref }> = [];
  for (const candidate of Object.values(state.decisionTokens)) {
    if (candidate.kind !== 'DELIBERATION_SELECTION' && candidate.kind !== 'DELIBERATION') continue;
    if (!candidate.consumed || typeof candidate.predecessorGeneration !== 'number' || !Number.isSafeInteger(candidate.predecessorGeneration) || candidate.predecessorGeneration >= generationNumber || (candidate.disposition !== 'SELECTION' && candidate.disposition !== 'SYNTHESIS')) continue;
    if (typeof candidate.nullableSettlement !== 'string') continue;
    const ref = state.managed?.settlements?.[candidate.nullableSettlement];
    const leaseId = candidate.publicationLeaseSetId;
    const lease = leaseId ? state.managed?.leaseSets?.[leaseId] : undefined;
    if (!ref || !refIsValid(ref) || ref.scope?.startsWith('deliberation/settlement') !== true || typeof ref.bytes !== 'string'
      || !lease || lease.status === 'EXPIRED' || !Array.isArray(lease.closedRefGraph) || !lease.closedRefGraph.some((candidateRef) => canonicalString(candidateRef) === canonicalString(ref))) return undefined;
    // Only a fully validated consumed owner may contribute a Ref to a later
    // authorship prefix. This recursively proves the owner's own predecessor
    // closure and keeps a map-inserted canonical Ref from becoming a root.
    if (!managedSettlementRecordIsValid(ref, candidate, state)) return undefined;
    rows.push({ generation: candidate.predecessorGeneration, ref });
  }
  rows.sort((a, b) => a.generation - b.generation);
  for (let index = 1; index < rows.length; index += 1) if (rows[index - 1].generation === rows[index].generation) return undefined;
  for (let index = 1; index < rows.length; index += 1) if (canonicalString(rows[index - 1].ref) === canonicalString(rows[index].ref)) return undefined;
  const refs = rows.map((row) => row.ref);
  if (!refIsValid(token.waveRef) || typeof (token.waveRef as Ref).bytes !== 'string') return undefined;
  try {
    const wave = parseCanonical<DeliberationWave>((token.waveRef as Ref).bytes!);
    const policy = managedPolicyForWave(wave);
    const admitted = validateWave(wave, { runId: state.runId, phaseId: state.phaseId, policy, committedEvidence: new Set(), reachableConstraints: new Set() });
    if (!admitted.ok || admitted.value.authorship.settlementPrefixDigest !== settlementPrefixDigest(refs)) return undefined;
  } catch { return undefined; }
  return refs;
}

function managedAcceptedReportPrefixSnapshotStore(token: Record<string, unknown>): Ref {
  const value = { schema: 'lunacy-managed-accepted-report-prefix/v1', waveRef: token.waveRef, orderedReportRefs: token.orderedReportRefs };
  const bytes = canonicalString(value);
  const reportDigest = digest(value);
  return { id: `accepted-report-prefix:${reportDigest.slice(0, 16)}`, scope: 'deliberation/report-prefix', digest: reportDigest, bytes };
}

function managedSuccessorWaveIsBoundStore(state: MachineState, token: Record<string, unknown>, successor: Ref): boolean {
  if (!refIsValid(token.waveRef) || typeof (token.waveRef as Ref).bytes !== 'string' || typeof successor.bytes !== 'string') return false;
  const prefix = managedSettlementPrefixStore(state, token);
  if (!prefix) return false;
  try {
    const focus = parseCanonical<DeliberationWave>((token.waveRef as Ref).bytes!);
    const next = parseCanonical<DeliberationWave>(successor.bytes!);
    const focusPolicy = managedPolicyForWave(focus);
    const nextPolicy = managedPolicyForWave(next);
    const focusValid = validateWave(focus, { runId: state.runId, phaseId: state.phaseId, policy: focusPolicy, committedEvidence: new Set(), reachableConstraints: new Set() });
    const nextValid = validateWave(next, { runId: state.runId, phaseId: state.phaseId, policy: nextPolicy, committedEvidence: new Set(), reachableConstraints: new Set() });
    if (!focusValid.ok || !nextValid.ok || focusValid.value.gear !== 'FOCUS' || nextValid.value.gear !== 'EXPLORE') return false;
    const a = nextValid.value.authorship;
    const f = focusValid.value.authorship;
    const prefixDigest = settlementPrefixDigest(prefix);
    if (f.settlementPrefixDigest !== prefixDigest) return false;
    return canonicalString(a.intent) === canonicalString(token.waveRef)
      && canonicalString(a.evidenceSnapshot) === canonicalString(managedAcceptedReportPrefixSnapshotStore(token))
      && a.authorityDigest === f.authorityDigest
      && canonicalString(a.policyVersion) === canonicalString(f.policyVersion)
      && a.settlementPrefixDigest === prefixDigest
      && a.decisionKey === token.decisionKey
      && a.prospectiveEffectFrontierOrdinal === f.prospectiveEffectFrontierOrdinal;
  } catch { return false; }
}

function managedSettlementRecordIsValid(settlement: Ref, token: Record<string, unknown>, state: MachineState): boolean {
  if (typeof settlement.bytes !== 'string' || settlement.scope?.startsWith('deliberation/settlement') !== true) return false;
  let record: Record<string, unknown>;
  try { record = parseCanonical<Record<string, unknown>>(settlement.bytes); } catch { return false; }
  const required = ['schema', 'authorshipInputDigest', 'decisionKey', 'frontierOrdinal', 'waveRef', 'orderedReportRefs', 'basis', 'dissent', 'predecessors', 'result'];
  if (Object.keys(record).some((key) => ![...required, 'selection', 'synthesis', 'disposition', 'resultDigest'].includes(key)) || required.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) return false;
  if (record.schema !== 'lunacy-deliberation-settlement/v1' && record.schema !== 'lunacy-parent-decision/v1') return false;
  if (record.authorshipInputDigest !== token.authorshipInputDigest || record.decisionKey !== token.decisionKey || !Number.isSafeInteger(record.frontierOrdinal) || !refIsValid(token.waveRef)) return false;
  try {
    const waveRef = token.waveRef as Ref;
    const wave = parseCanonical<DeliberationWave>(waveRef.bytes ?? '');
    const policy = managedPolicyForWave(wave);
    const admitted = validateWave(wave, { runId: state.runId, phaseId: state.phaseId, policy, committedEvidence: new Set(), reachableConstraints: new Set() });
    if (!admitted.ok || record.frontierOrdinal !== admitted.value.authorship.prospectiveEffectFrontierOrdinal) return false;
  } catch { return false; }
  if (!refIsValid(record.waveRef) || canonicalString(record.waveRef) !== canonicalString(token.waveRef) || !Array.isArray(record.orderedReportRefs) || canonicalString(record.orderedReportRefs) !== canonicalString(token.orderedReportRefs)) return false;
  if (record.disposition !== undefined && record.disposition !== token.disposition) return false;
  if (!Array.isArray(record.predecessors) || record.predecessors.some((item) => !refIsValid(item) || (item as Ref).scope?.startsWith('deliberation/settlement') !== true)) return false;
  if (new Set((record.predecessors as Ref[]).map((item) => canonicalString(item))).size !== (record.predecessors as Ref[]).length || (record.predecessors as Ref[]).some((item) => canonicalString(item) === canonicalString(settlement))) return false;
  if (record.basis === null || record.basis === undefined || !isManagedDissent(record.dissent)) return false;
  const prefix = managedSettlementPrefixStore(state, token);
  if (!prefix) return false;
  const prefixKeys = prefix.map((item) => canonicalString(item));
  const predecessorIndexes = (record.predecessors as Ref[]).map((item) => prefixKeys.indexOf(canonicalString(item)));
  if (predecessorIndexes.some((index) => index < 0) || predecessorIndexes.some((index, i) => i > 0 && index <= predecessorIndexes[i - 1])) return false;
  const result = record.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || canonicalString(result) === '') return false;
  if (digest(result) !== token.resultDigest || (result as Record<string, unknown>).kind !== token.resultKind) return false;
  const resultObject = result as Record<string, unknown>;
  if (resultObject.kind === 'COMPLETE_PLAN') {
    if (Object.keys(resultObject).some((key) => !['kind', 'plan'].includes(key)) || !Object.prototype.hasOwnProperty.call(resultObject, 'plan')) return false;
    try { if (validatePlan(resultObject.plan as import('./model.js').Plan).plan.phaseId !== state.phaseId) return false; } catch { return false; }
  } else if (resultObject.kind === 'DELIBERATION_REQUIRED') {
    if (Object.keys(resultObject).some((key) => !['kind', 'wave'].includes(key)) || !refIsValid(resultObject.wave) || (resultObject.wave as Ref).scope !== 'deliberation/wave' || typeof (resultObject.wave as Ref).bytes !== 'string') return false;
    try { if (JSON.parse((resultObject.wave as Ref).bytes!).schema !== 'lunacy-deliberation-wave/v2') return false; } catch { return false; }
  } else if (resultObject.kind === 'NO_SETTLEMENT') {
    if (Object.keys(resultObject).some((key) => !['kind', 'reason'].includes(key)) || !refIsValid(resultObject.reason) || !(resultObject.reason as Ref).scope?.startsWith('deliberation')) return false;
  } else return false;
  if (record.resultDigest !== undefined && record.resultDigest !== token.resultDigest) return false;
  const boundLocator = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const locator = value as Record<string, unknown>;
    if (Object.keys(locator).some((key) => !['generatorReport', 'oneBasedOrdinal'].includes(key)) || !Number.isSafeInteger(locator.oneBasedOrdinal) || (locator.oneBasedOrdinal as number) < 1 || !refIsValid(locator.generatorReport)) return false;
    const generatorRef = locator.generatorReport as Ref;
    if (generatorRef.scope !== 'deliberation/report' || !(token.orderedReportRefs as Ref[]).some((candidate) => canonicalString(candidate) === canonicalString(generatorRef)) || typeof (token.waveRef as Ref)?.bytes !== 'string') return false;
    try {
      const waveRef = token.waveRef as Ref;
      const wave = parseCanonical<DeliberationWave>(waveRef.bytes!);
      const policy = managedPolicyForWave(wave);
      const validWave = validateWave(wave, { runId: state.runId, phaseId: state.phaseId, policy, committedEvidence: new Set(), reachableConstraints: new Set() });
      if (!validWave.ok) return false;
      const report = parseCanonical<DeliberationReport>(generatorRef.bytes!);
      const slot = deriveTopology(waveRef, validWave.value).slots.find((candidate) => candidate.slotOrdinal === report.slotOrdinal);
      if (!slot || slot.role !== 'GENERATOR') return false;
      const checked = validateReport(report, { waveRef, wave: validWave.value, slot, predecessors: [], policy });
      return checked.ok && 'ideas' in checked.value && (locator.oneBasedOrdinal as number) <= checked.value.ideas.length;
    } catch { return false; }
  };
  if (token.disposition === 'SELECTION') {
    if (!boundLocator(record.basis)) return false;
    if (record.selection !== undefined && (!boundLocator(record.selection) || canonicalString(record.selection) !== canonicalString(record.basis))) return false;
    if (record.synthesis !== undefined) return false;
  } else {
    if (record.selection !== undefined) return false;
    if (typeof record.synthesis !== 'string' || record.synthesis.length === 0 || !Array.isArray(record.basis) || record.basis.length === 0) return false;
    if (record.basis.some((item) => !boundLocator(item))) return false;
  }
  return true;
}

function recoveryProofIsValid(ref: Ref): boolean {
  try {
    const recovery = parseCanonical<Record<string, unknown>>(ref.bytes ?? '');
    if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery) || typeof recovery.launchToken !== 'string' || typeof recovery.status !== 'string') return false;
    const keys = Object.keys(recovery).sort().join(',');
    return (keys === 'launchToken,status') || (keys === 'commandDigest,launchToken,status' && typeof recovery.commandDigest === 'string');
  } catch { return false; }
}

function eventIsValid(event: unknown): event is Event {
  if (!event || typeof event !== 'object' || typeof (event as { kind?: unknown }).kind !== 'string') return false;
  const value = event as Record<string, unknown>;
  switch (value.kind) {
    case 'START': return Object.keys(value).sort().join(',') === 'intentRef,kind' && refIsValid(value.intentRef);
    case 'RESUME': return Object.keys(value).length === 1;
    case 'PARENT_DECISION': return Object.keys(value).sort().join(',') === 'kind,token,value' && typeof value.token === 'string' && value.token.length > 0;
    case 'DISPATCH_RECEIPT': return Object.keys(value).sort().join(',') === 'kind,ref' && refIsValid(value.ref) && typeof (value.ref as Ref).bytes === 'string' && dispatchProofIsValid(value.ref as Ref);
    case 'WORKER_ENVELOPE': return Object.keys(value).sort().join(',') === 'kind,ref' && refIsValid(value.ref) && typeof (value.ref as Ref).bytes === 'string' && workerEnvelopeIsValid(value.ref as Ref);
    case 'OBSERVATION': return Object.keys(value).sort().join(',') === 'category,kind,ref' && ['USER_CHANGE', 'HOST', 'RECOVERY'].includes(String(value.category)) && refIsValid(value.ref) && (value.category !== 'RECOVERY' || (typeof (value.ref as Ref).bytes === 'string' && recoveryProofIsValid(value.ref as Ref)));
    default: return false;
  }
}

function snapshotIsValid(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'activeCount,attemptEpoch,authorityEpoch,barrier,barrierEpoch,gate,nextAction,pendingDispatchCount,phase,readyCount,revision,runStatus,unknownDispatchCount') return false;
  return Number.isSafeInteger(item.revision) && Number.isSafeInteger(item.authorityEpoch) && Number.isSafeInteger(item.attemptEpoch) && Number.isSafeInteger(item.barrierEpoch) && [item.revision, item.authorityEpoch, item.attemptEpoch, item.barrierEpoch].every((n) => (n as number) >= 0) && ['ACTIVE', 'BLOCKED', 'COMPLETE'].includes(String(item.runStatus)) && typeof item.phase === 'string' && ['NOT-DUE', 'DUE', 'PASS', 'FINDINGS'].includes(String(item.gate)) && ['OPEN', 'CLOSED'].includes(String(item.barrier)) && ['readyCount', 'activeCount', 'pendingDispatchCount', 'unknownDispatchCount'].every((key) => Number.isSafeInteger(item[key]) && (item[key] as number) >= 0) && typeof item.nextAction === 'string';
}

type LaunchAuthority = {
  generation: number;
  writerFence: string;
  runId: string;
  phaseId: string;
  authorityEpoch: number;
  attemptEpoch: number;
  barrierEpoch: number;
  modeEpoch: number;
  command: OutboxCommand;
};

/** Private store/public seam. It is exported only from this internal module;
 * the unexported symbol keeps ArtifactStore and the package surface unchanged. */
export type StoreLinearizedDispatchRequest = {
  authority: LaunchAuthority;
  receiver: object;
  dispatch: (command: OutboxCommand, launchToken: string, signal: AbortSignal) => unknown;
  signal: AbortSignal;
  deadline: number;
};

export type StoreLinearizedDispatchResult =
  | { kind: 'STALE' }
  | { kind: 'CANCELLED' }
  | { kind: 'RECEIPT'; receipt: DriverReceipt }
  | { kind: 'PROMISE'; receipt: Promise<DriverReceipt> }
  | { kind: 'UNCERTAIN' }
  | { kind: 'FENCE_FAILURE'; entered: boolean };

type PromiseSettlement = { status: 'fulfilled'; value: unknown } | { status: 'rejected' };
type InternalDispatchResult = Exclude<StoreLinearizedDispatchResult, { kind: 'PROMISE' } | { kind: 'FENCE_FAILURE' }>
  | { kind: 'PROMISE_RAW'; settlement: Promise<PromiseSettlement> };
type NormalizedDriverResult =
  | { kind: 'ABSENT' }
  | { kind: 'INVALID' }
  | { kind: 'RECEIPT'; receipt: DriverReceipt }
  | { kind: 'PROMISE'; receipt: Promise<DriverReceipt | undefined> };
type CapturedDriverResult =
  | Exclude<NormalizedDriverResult, { kind: 'PROMISE' }>
  | { kind: 'PROMISE_RAW'; settlement: Promise<PromiseSettlement> };
type EntryMarker = { entered: boolean };
type StoreLaunchCapability = (request: StoreLinearizedDispatchRequest, marker: EntryMarker) => Promise<InternalDispatchResult>;
const STORE_LINEARIZED_DISPATCH = Symbol('lunacy.store-linearized-dispatch');
const NativePromise = Promise;
const intrinsicPromiseThen = Promise.prototype.then;

function enumerableData(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || isProxy(value)) throw new Error(`${label} is not a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} is not a plain object`);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} contains symbol fields`);
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable) continue;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error(`${label}.${key} is an accessor`);
    result[key] = descriptor.value;
  }
  return result;
}

function cloneDriverReceipt(value: unknown): DriverReceipt {
  const receipt = enumerableData(value, 'driver receipt');
  exactKeys(receipt, ['launchToken', 'commandDigest', 'ref', ...(Object.prototype.hasOwnProperty.call(receipt, 'authorityAnchor') ? ['authorityAnchor'] : [])], 'driver receipt');
  invariant(typeof receipt.launchToken === 'string' && receipt.launchToken.length > 0, 'driver receipt launchToken is invalid');
  invariant(typeof receipt.commandDigest === 'string' && SHA256.test(receipt.commandDigest), 'driver receipt commandDigest is invalid');
  const refValue = enumerableData(receipt.ref, 'driver receipt ref');
  invariant(Object.keys(refValue).every((key) => ['id', 'digest', 'scope', 'bytes'].includes(key)), 'driver receipt ref fields are invalid');
  const clonedRef = { ...refValue } as Ref;
  invariant(refIsValid(clonedRef), 'driver receipt ref is invalid');
  let authorityAnchor: Ref | undefined;
  if (receipt.authorityAnchor !== undefined) {
    const anchorValue = enumerableData(receipt.authorityAnchor, 'driver receipt authority anchor');
    invariant(Object.keys(anchorValue).every((key) => ['id', 'digest', 'scope', 'bytes'].includes(key)), 'driver receipt authority anchor fields are invalid');
    authorityAnchor = { ...anchorValue } as Ref;
    invariant(managedReceiptAuthorityAnchorIsValid(authorityAnchor, receipt.commandDigest as string, clonedRef.digest), 'driver receipt authority anchor is invalid');
  }
  return { launchToken: receipt.launchToken as string, commandDigest: receipt.commandDigest as string, ref: clonedRef, ...(authorityAnchor ? { authorityAnchor } : {}) };
}

function exactClaimIsCurrent(snapshot: StoreSnapshot, authority: LaunchAuthority): boolean {
  const state = snapshot.state;
  if (!state || snapshot.generation !== authority.generation || state.writerFence !== authority.writerFence) return false;
  if (state.runId !== authority.runId || state.phaseId !== authority.phaseId || state.authorityEpoch !== authority.authorityEpoch || state.attemptEpoch !== authority.attemptEpoch || state.barrierEpoch !== authority.barrierEpoch || state.modeEpoch !== authority.modeEpoch) return false;
  const expected = authority.command;
  const current = state.outbox[expected.commandId];
  if (!current || expected.state !== 'CLAIMED' || current.state !== 'CLAIMED' || typeof expected.leaseId !== 'string' || current.leaseId !== expected.leaseId) return false;
  try { return canonicalString(current) === canonicalString(expected); }
  catch { return false; }
}

function observeRealPromise(value: Promise<unknown>): Promise<PromiseSettlement> {
  return new NativePromise<PromiseSettlement>((resolvePromise) => {
    try {
      Reflect.apply(intrinsicPromiseThen, value, [
        (settled: unknown) => resolvePromise({ status: 'fulfilled', value: settled }),
        () => resolvePromise({ status: 'rejected' }),
      ]);
    } catch { resolvePromise({ status: 'rejected' }); }
  });
}

function captureRealPromise(value: unknown): Promise<PromiseSettlement> | undefined {
  return isPromise(value) ? observeRealPromise(value) : undefined;
}

function normalizeSynchronousDriverResult(value: unknown, allowUndefined: boolean): Exclude<CapturedDriverResult, { kind: 'PROMISE_RAW' }> {
  try {
    if (allowUndefined && value === undefined) return { kind: 'ABSENT' };
    return { kind: 'RECEIPT', receipt: cloneDriverReceipt(value) };
  } catch { return { kind: 'INVALID' }; }
}

function captureDriverResult(value: unknown, allowUndefined: boolean): CapturedDriverResult {
  try {
    const settlement = captureRealPromise(value);
    return settlement ? { kind: 'PROMISE_RAW', settlement } : normalizeSynchronousDriverResult(value, allowUndefined);
  } catch { return { kind: 'INVALID' }; }
}

function normalizePromiseSettlement(settlement: Promise<PromiseSettlement>, allowUndefined: false): Promise<DriverReceipt>;
function normalizePromiseSettlement(settlement: Promise<PromiseSettlement>, allowUndefined: true): Promise<DriverReceipt | undefined>;
function normalizePromiseSettlement(settlement: Promise<PromiseSettlement>, allowUndefined: boolean): Promise<DriverReceipt | undefined>;
function normalizePromiseSettlement(settlement: Promise<PromiseSettlement>, allowUndefined: boolean): Promise<DriverReceipt | undefined> {
  return new NativePromise<DriverReceipt | undefined>((resolvePromise, rejectPromise) => {
    try {
      Reflect.apply(intrinsicPromiseThen, settlement, [
        (result: PromiseSettlement) => {
          if (result.status === 'rejected') { rejectPromise(new Error('driver Promise rejected')); return; }
          if (allowUndefined && result.value === undefined) { resolvePromise(undefined); return; }
          try { resolvePromise(cloneDriverReceipt(result.value)); }
          catch (error) { rejectPromise(error); }
        },
        rejectPromise,
      ]);
    } catch (error) { rejectPromise(error); }
  });
}

/** Safely classify a driver result without reading a caller-controlled `then`
 * property or receipt fields. This is the shared post-call policy for fenced
 * dispatch and UNKNOWN observation; arbitrary thenables and proxies fail
 * closed instead of being assimilated. */
export function normalizeDriverResult(value: unknown, allowUndefined = false): NormalizedDriverResult {
  const captured = captureDriverResult(value, allowUndefined);
  if (captured.kind !== 'PROMISE_RAW') return captured;
  return { kind: 'PROMISE', receipt: normalizePromiseSettlement(captured.settlement, allowUndefined) };
}

function invokeIfCurrent(snapshot: StoreSnapshot, request: StoreLinearizedDispatchRequest, marker: EntryMarker): InternalDispatchResult {
  if (!exactClaimIsCurrent(snapshot, request.authority)) return { kind: 'STALE' };
  // Prepare the durable clone before the final signal/deadline read. Nothing
  // that can call host code occurs between that read and Reflect.apply.
  const command = cloneCommand(request.authority.command);
  if (request.signal.aborted || Date.now() >= request.deadline) return { kind: 'CANCELLED' };
  marker.entered = true;
  let raw: unknown;
  try { raw = Reflect.apply(request.dispatch, request.receiver, [command, command.launchToken, request.signal]); }
  catch { return { kind: 'UNCERTAIN' }; }
  // A real Promise is observed before unlock; the task owner can record
  // cancellation while retaining its late receipt channel. For a synchronous
  // value, cancellation/deadline changes caused during the call are uncertain.
  let settlement: Promise<PromiseSettlement> | undefined;
  try { settlement = captureRealPromise(raw); }
  catch { return { kind: 'UNCERTAIN' }; }
  if (settlement) return { kind: 'PROMISE_RAW', settlement };
  if (request.signal.aborted || Date.now() >= request.deadline) return { kind: 'UNCERTAIN' };
  const captured = normalizeSynchronousDriverResult(raw, false);
  return captured.kind === 'RECEIPT' ? captured : { kind: 'UNCERTAIN' };
}

/** Enter a snapshotted driver method only while the built-in store's mutation
 * fence still proves the exact durable claim. Missing capabilities fail closed. */
export async function storeLinearizedDispatch(store: ArtifactStore, request: StoreLinearizedDispatchRequest): Promise<StoreLinearizedDispatchResult> {
  const capability = (store as ArtifactStore & { [STORE_LINEARIZED_DISPATCH]?: StoreLaunchCapability })[STORE_LINEARIZED_DISPATCH];
  if (typeof capability !== 'function') return { kind: 'FENCE_FAILURE', entered: false };
  const marker = { entered: false };
  try {
    const result = await Reflect.apply(capability, store, [request, marker]);
    if (result.kind !== 'PROMISE_RAW') return result;
    // This continuation is created only after the fence has been released.
    // The raw driver's Promise was observed under the fence without touching
    // a user-controlled `then` property; settlement is normalized here.
    const receipt = normalizePromiseSettlement(result.settlement, false);
    return { kind: 'PROMISE', receipt };
  } catch { return { kind: 'FENCE_FAILURE', entered: marker.entered }; }
}

function yieldBytesAreValid(bytes: string): boolean {
  try {
    const value = parseCanonical<Record<string, unknown>>(bytes);
    if (!value || typeof value !== 'object' || typeof value.kind !== 'string' || !snapshotIsValid(value.snapshot)) return false;
    const cursor = value.cursor;
    const cursorValid = cursor === undefined || (cursor && typeof cursor === 'object' && Object.keys(cursor as object).sort().join(',') === 'attemptEpoch,authorityEpoch,barrierEpoch,revision' && ['revision', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch'].every((key) => Number.isSafeInteger((cursor as Record<string, unknown>)[key]) && ((cursor as Record<string, unknown>)[key] as number) >= 0));
    if (!cursorValid) return false;
    if (value.kind === 'WAITING') return Object.keys(value).sort().join(',') === 'cursor,kind,snapshot';
    if (value.kind === 'DECISION_REQUIRED') return Object.keys(value).sort().join(',') === 'brief,cursor,kind,snapshot,token' && refIsValid(value.brief) && typeof value.token === 'string' && value.token.length > 0;
    if (value.kind === 'BLOCKED') return Object.keys(value).every((key) => ['kind', 'code', 'reason', 'retryable', 'snapshot', 'receipt', 'launchToken'].includes(key)) && ['kind', 'code', 'reason', 'retryable', 'snapshot'].every((key) => Object.prototype.hasOwnProperty.call(value, key)) && ['CrossRunUnproven', 'UnknownDispatch', 'HumanReceiptRequired', 'ManifestMismatch', 'JournalCeiling', 'STALE', 'NO_SETTLEMENT', 'InvalidEvent'].includes(String(value.code)) && typeof value.reason === 'string' && typeof value.retryable === 'boolean' && (value.receipt === undefined || refIsValid(value.receipt)) && (value.launchToken === undefined || typeof value.launchToken === 'string');
    if (value.kind === 'FINAL') return Object.keys(value).sort().join(',') === 'artifacts,kind,snapshot,status' && ['phase-ready', 'complete'].includes(String(value.status)) && Array.isArray(value.artifacts) && value.artifacts.every(refIsValid);
    return false;
  } catch { return false; }
}

function validateJournal(state: MachineState, journalText: string, options: { segmented?: boolean } = {}): Array<Record<string, unknown>> {
  const lines = journalText.length === 0 ? [] : journalText.split('\n');
  if (lines.length && lines.at(-1) === '') lines.pop();
  invariant(lines.every((line) => line.length > 0), 'journal contains blank records');
  const entries: Array<Record<string, unknown>> = [];
  if (!options.segmented) {
    if (lines.length > JOURNAL_EVENT_CEILING || Buffer.byteLength(journalText) > JOURNAL_BYTE_CEILING) {
      const error = new Error('JournalCeiling'); error.name = 'JournalCeiling'; throw error;
    }
  }
  let previousRevision = 0;
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: Record<string, unknown>;
    try { parsed = parseCanonical<Record<string, unknown>>(lines[index]); }
    catch { throw new Error(`ManifestMismatch: journal record ${index + 1} is not canonical JSON`); }
    exactKeys(parsed, ['identity', 'event', 'digest', 'revision'], `journal record ${index + 1}`);
    invariant(identityIsValid(parsed.identity), `journal record ${index + 1} identity is invalid`);
    invariant(typeof parsed.digest === 'string' && SHA256.test(parsed.digest), `journal record ${index + 1} digest is invalid`);
    invariant(typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision) && parsed.revision === index + 1 && parsed.revision > previousRevision, `journal record ${index + 1} revision is invalid`);
    previousRevision = parsed.revision;
    invariant(eventIsValid(parsed.event), `journal record ${index + 1} event is invalid`);
    invariant(parsed.digest === digest(parsed.event), `journal record ${index + 1} event digest mismatch`);
    invariant((parsed.identity as EventIdentity).runId === state.runId, `journal record ${index + 1} runId disagrees with state`);
    invariant((parsed.identity as EventIdentity).payloadDigest === parsed.digest, `journal record ${index + 1} identity digest mismatch`);
    invariant((parsed.identity as EventIdentity).phaseId === state.phaseId || (parsed.identity as EventIdentity).phaseId === 'run', `journal record ${index + 1} phase disagrees with state`);
    entries.push(parsed);
  }
  const expectedBytes = entries.length ? `${entries.map((entry) => canonicalString(entry)).join('\n')}\n` : '';
  invariant(expectedBytes === journalText, 'journal bytes are not the committed canonical prefix');
  invariant(Array.isArray(state.journal), 'state journal is invalid');
  invariant(canonicalString(state.journal) === canonicalString(entries), 'state/journal records disagree');
  invariant(state.revision === entries.length, 'state revision does not match journal length');
  return entries;
}

function validateManagedState(managed: unknown, state: MachineState): asserts managed is ManagedState {
  invariant(managed && typeof managed === 'object' && !Array.isArray(managed), 'managed state is invalid');
  const value = managed as Record<string, unknown>;
  exactKeys(value, ['capability', 'killSwitch', 'waveCounters', 'reservations', 'leaseSets', ...(Object.prototype.hasOwnProperty.call(value, 'rollout') ? ['rollout'] : []), ...(Object.prototype.hasOwnProperty.call(value, 'rolloutOrigin') ? ['rolloutOrigin'] : []), ...(Object.prototype.hasOwnProperty.call(value, 'proposal') ? ['proposal'] : []), ...(Object.prototype.hasOwnProperty.call(value, 'attempts') ? ['attempts'] : []), ...(Object.prototype.hasOwnProperty.call(value, 'acceptedReports') ? ['acceptedReports'] : []), ...(Object.prototype.hasOwnProperty.call(value, 'settlements') ? ['settlements'] : []), ...(Object.prototype.hasOwnProperty.call(value, 'settlementOrigins') ? ['settlementOrigins'] : [])], 'managed state');
  invariant(typeof value.killSwitch === 'boolean', 'managed kill switch is invalid');
  invariant(verifyManagedCapability(value.capability), 'managed capability is invalid');
  if (value.rollout !== undefined) invariant(verifyManagedRolloutProjection(value.rollout), 'managed rollout policy is invalid');
  if (value.rolloutOrigin !== undefined) invariant(verifyManagedRolloutProjection(value.rolloutOrigin), 'managed rollout origin is invalid');
  if (value.proposal !== undefined && value.rollout !== undefined) invariant(value.rolloutOrigin !== undefined, 'managed rollout origin is missing');
  const capability = value.capability;
  const counters = value.waveCounters;
  invariant(counters && typeof counters === 'object' && !Array.isArray(counters), 'managed wave counters are invalid');
  exactKeys(counters as object, ['waves', 'calls', 'inTok', 'outTok', 'reportBytes', 'refs', 'persistedBytes', 'deadline'], 'managed wave counters');
  for (const [key, item] of Object.entries(counters as Record<string, unknown>)) {
    nonNegativeInteger(item, `managed wave counter ${key}`);
    const ceiling = capability.ceilings[key as keyof typeof capability.ceilings];
    invariant(typeof ceiling === 'number' && (item as number) <= ceiling, `managed wave counter ${key} exceeds capability ceiling`);
  }
  const reservations = value.reservations;
  invariant(reservations && typeof reservations === 'object' && !Array.isArray(reservations), 'managed reservations are invalid');
  for (const [key, raw] of Object.entries(reservations as Record<string, unknown>)) {
    invariant(raw && typeof raw === 'object' && !Array.isArray(raw), `managed reservation ${key} is invalid`);
    const reservation = raw as Record<string, unknown>;
    exactKeys(reservation, ['calls', 'charged', 'commandId', 'deadline', 'epoch', 'inTok', 'outTok', 'persistedBytes', 'refs', 'reportBytes', 'reservationId', 'waves'], `managed reservation ${key}`);
    invariant(typeof reservation.reservationId === 'string' && reservation.reservationId === key, `managed reservation ${key} identity is invalid`);
    invariant(typeof reservation.commandId === 'string' && reservation.commandId.length > 0 && reservation.charged === true, `managed reservation ${key} binding is invalid`);
    for (const field of ['waves', 'calls', 'inTok', 'outTok', 'reportBytes', 'refs', 'persistedBytes', 'deadline', 'epoch'] as const) {
      nonNegativeInteger(reservation[field], `managed reservation ${key}.${field}`);
      if (field !== 'epoch') invariant((reservation[field] as number) <= capability.ceilings[field], `managed reservation ${key}.${field} exceeds capability ceiling`);
    }
  }
  const leaseSets = value.leaseSets;
  invariant(leaseSets && typeof leaseSets === 'object' && !Array.isArray(leaseSets), 'managed lease sets are invalid');
  for (const [key, raw] of Object.entries(leaseSets as Record<string, unknown>)) {
    invariant(raw && typeof raw === 'object' && !Array.isArray(raw), `managed lease set ${key} is invalid`);
    const lease = raw as Record<string, unknown>;
    exactKeys(lease, ['closedRefGraph', 'expiresAt', 'leaseId', 'status'], `managed lease set ${key}`);
    invariant(typeof lease.leaseId === 'string' && lease.leaseId === key && typeof lease.expiresAt === 'number' && Number.isSafeInteger(lease.expiresAt) && lease.expiresAt >= 0 && ['ACTIVE', 'PROMOTED', 'EXPIRED'].includes(String(lease.status)), `managed lease set ${key} fields are invalid`);
    invariant(Array.isArray(lease.closedRefGraph) && lease.closedRefGraph.every(refIsValid), `managed lease set ${key} refs are invalid`);
  }
  if (value.attempts !== undefined) {
    const attempts = value.attempts;
    invariant(attempts && typeof attempts === 'object' && !Array.isArray(attempts), 'managed attempts are invalid');
    for (const [key, raw] of Object.entries(attempts as Record<string, unknown>)) {
      invariant(raw && typeof raw === 'object' && !Array.isArray(raw), `managed attempt ${key} is invalid`);
      const attempt = raw as Record<string, unknown>;
      exactKeys(attempt, ['commandId', 'epoch', 'reservationId', 'status', 'leaseId', 'receipt', 'resultDigest', 'authorityAnchor', 'rolloutOrigin'].filter((field) => Object.prototype.hasOwnProperty.call(attempt, field)), `managed attempt ${key}`);
      invariant(typeof attempt.commandId === 'string' && attempt.commandId === key && /^[0-9a-f]{32}$/.test(attempt.commandId), `managed attempt ${key} identity is invalid`);
      invariant(typeof attempt.epoch === 'number' && Number.isSafeInteger(attempt.epoch) && attempt.epoch >= 0, `managed attempt ${key} epoch is invalid`);
      invariant(typeof attempt.reservationId === 'string' && attempt.reservationId === key, `managed attempt ${key} reservation binding is invalid`);
      invariant(['LIVE', 'UNKNOWN', 'SUCCESS', 'TIMED_OUT', 'CANCELLED', 'FAILED'].includes(String(attempt.status)), `managed attempt ${key} status is invalid`);
      invariant(attempt.leaseId === undefined || typeof attempt.leaseId === 'string', `managed attempt ${key} lease is invalid`);
      invariant(attempt.receipt === undefined || refIsValid(attempt.receipt), `managed attempt ${key} receipt is invalid`);
      invariant(attempt.resultDigest === undefined || (typeof attempt.resultDigest === 'string' && SHA256.test(attempt.resultDigest)), `managed attempt ${key} result digest is invalid`);
      invariant(value.rolloutOrigin === undefined ? attempt.rolloutOrigin === undefined : (verifyManagedRolloutProjection(attempt.rolloutOrigin) && canonicalString(attempt.rolloutOrigin) === canonicalString(value.rolloutOrigin)), `managed attempt ${key} rollout origin is invalid`);
      const reservation = (reservations as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
      invariant(reservation !== undefined && reservation.epoch === attempt.epoch, `managed attempt ${key} reservation is missing or mismatched`);
      const command = (state.outbox as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
      invariant(command !== undefined && command.commandId === key && command.attemptEpoch === attempt.epoch, `managed attempt ${key} command is missing or mismatched`);
      if (attempt.status === 'SUCCESS') invariant(command.state === 'ACKED' && attempt.receipt !== undefined && attempt.resultDigest === (attempt.receipt as Ref).digest, `managed attempt ${key} success binding is invalid`);
      if (attempt.authorityAnchor !== undefined) {
        invariant(attempt.status === 'SUCCESS' && command.roleView !== undefined && command.receipt && refIsValid(command.receipt), `managed attempt ${key} authority anchor owner is invalid`);
        let proof: Record<string, unknown>;
        try { proof = parseCanonical<Record<string, unknown>>((command.receipt as Ref).bytes ?? ''); }
        catch { throw new Error(`ManifestMismatch: managed attempt ${key} dispatch proof is invalid`); }
        invariant(refIsValid(proof.receipt) && managedReceiptAuthorityAnchorIsValid(attempt.authorityAnchor, command.commandDigest as string, (proof.receipt as Ref).digest)
          && canonicalString(proof.authorityAnchor) === canonicalString(attempt.authorityAnchor), `managed attempt ${key} authority anchor binding is invalid`);
      }
      if (attempt.status === 'SUCCESS' && command.roleView !== undefined) invariant(attempt.authorityAnchor !== undefined, `managed attempt ${key} authority anchor is missing`);
      if (attempt.status === 'LIVE') invariant(command.state === 'PENDING' || command.state === 'CLAIMED', `managed attempt ${key} live binding is invalid`);
      if (attempt.status === 'UNKNOWN') invariant(command.state === 'UNKNOWN', `managed attempt ${key} unknown binding is invalid`);
    }
  }
  if (value.settlements !== undefined) {
    const settlements = value.settlements;
    invariant(settlements && typeof settlements === 'object' && !Array.isArray(settlements), 'managed settlements are invalid');
    for (const [key, raw] of Object.entries(settlements as Record<string, unknown>)) {
      invariant(SHA256.test(key) && refIsValid(raw), `managed settlement ${key} is invalid`);
      invariant((raw as Ref).digest === key, `managed settlement ${key} digest binding is invalid`);
      if (value.rolloutOrigin !== undefined) invariant(Object.prototype.hasOwnProperty.call((value.settlementOrigins as object | undefined) ?? {}, key), `managed settlement ${key} rollout origin is missing`);
    }
  }
  if (value.settlementOrigins !== undefined) {
    const origins = value.settlementOrigins;
    invariant(origins && typeof origins === 'object' && !Array.isArray(origins), 'managed settlement origins are invalid');
    for (const [key, raw] of Object.entries(origins as Record<string, unknown>)) {
      invariant(SHA256.test(key) && Object.prototype.hasOwnProperty.call((value.settlements as object | undefined) ?? {}, key), `managed settlement origin ${key} is orphaned`);
      invariant(verifyManagedRolloutProjection(raw) && canonicalString(raw) === canonicalString(value.rolloutOrigin), `managed settlement origin ${key} is invalid`);
    }
  }
  if (value.acceptedReports !== undefined) {
    const reports = value.acceptedReports;
    invariant(reports && typeof reports === 'object' && !Array.isArray(reports), 'managed accepted reports are invalid');
    for (const [key, raw] of Object.entries(reports as Record<string, unknown>)) {
      invariant(SHA256.test(key) && raw && typeof raw === 'object' && !Array.isArray(raw), `managed accepted report ${key} is invalid`);
      const row = raw as Record<string, unknown>;
      const hasRoleBinding = Object.prototype.hasOwnProperty.call(row, 'roleDigest') || Object.prototype.hasOwnProperty.call(row, 'predecessorReportDigests');
      exactKeys(row, ['ref', 'report', 'commandId', ...(hasRoleBinding ? ['roleDigest', 'predecessorReportDigests', 'authorityAnchor'] : []), 'receipt', 'attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'modeEpoch', ...(Object.prototype.hasOwnProperty.call(row, 'rolloutOrigin') ? ['rolloutOrigin'] : [])], `managed accepted report ${key}`);
      invariant(value.rolloutOrigin === undefined ? row.rolloutOrigin === undefined : (verifyManagedRolloutProjection(row.rolloutOrigin) && canonicalString(row.rolloutOrigin) === canonicalString(value.rolloutOrigin)), `managed accepted report ${key} rollout origin is invalid`);
      invariant(refIsValid(row.ref) && typeof (row.ref as Ref).bytes === 'string' && (row.ref as Ref).scope === 'deliberation/report', `managed accepted report ${key} ref is invalid`);
      invariant((row.ref as Ref).digest === key, `managed accepted report ${key} digest key disagrees`);
      let report: Record<string, unknown>;
      try { report = parseCanonical<Record<string, unknown>>((row.ref as Ref).bytes!); }
      catch { throw new Error(`ManifestMismatch: managed accepted report ${key} bytes are invalid`); }
      invariant(report.schema === 'lunacy-deliberation-report/v2' && canonicalString(report) === (row.ref as Ref).bytes && digest(report) === key, `managed accepted report ${key} Report/v2 binding is invalid`);
      invariant(row.report && typeof row.report === 'object' && !Array.isArray(row.report) && canonicalString(row.report) === (row.ref as Ref).bytes, `managed accepted report ${key} report projection is invalid`);
      invariant(typeof row.commandId === 'string' && /^[0-9a-f]{32}$/.test(row.commandId), `managed accepted report ${key} command binding is invalid`);
      const command = (state.outbox as Record<string, unknown>)[row.commandId] as Record<string, unknown> | undefined;
      invariant(command && command.state === 'ACKED' && command.commandDigest === (row.receipt as Record<string, unknown>)?.commandDigest, `managed accepted report ${key} command is not receipt-ACKED`);
      const commandRecord = command as Record<string, unknown>;
      if (hasRoleBinding) {
        invariant(typeof row.roleDigest === 'string' && SHA256.test(row.roleDigest) && refIsValid(commandRecord.roleView)
          && (commandRecord.roleView as Ref).scope === 'deliberation/role-view' && (commandRecord.roleView as Ref).digest === row.roleDigest,
        `managed accepted report ${key} role binding is invalid`);
        invariant(Array.isArray(row.predecessorReportDigests) && row.predecessorReportDigests.every((item) => typeof item === 'string' && SHA256.test(item))
          && canonicalString(row.predecessorReportDigests) === canonicalString(commandRecord.predecessorReportDigests),
        `managed accepted report ${key} predecessor binding is invalid`);
        invariant((row.ref as Ref).id === `managed-report:${row.roleDigest}:${key}`, `managed accepted report ${key} role-bound id is invalid`);
        const attempt = (value.attempts as Record<string, Record<string, unknown>> | undefined)?.[row.commandId as string];
        invariant(attempt?.authorityAnchor !== undefined && managedReceiptAuthorityAnchorIsValid(row.authorityAnchor, command.commandDigest as string, key)
          && canonicalString(row.authorityAnchor) === canonicalString(attempt.authorityAnchor), `managed accepted report ${key} authority anchor is invalid`);
      } else invariant(commandRecord.roleView === undefined, `managed accepted report ${key} omits its command role binding`);
      const receipt = row.receipt as Record<string, unknown>;
      exactKeys(receipt, ['commandDigest', 'resultDigest', 'attemptEpoch', ...(hasRoleBinding ? ['authorityAnchorDigest'] : [])], `managed accepted report ${key} receipt`);
      invariant(typeof receipt.commandDigest === 'string' && SHA256.test(receipt.commandDigest) && receipt.commandDigest === command.commandDigest && typeof receipt.resultDigest === 'string' && SHA256.test(receipt.resultDigest) && receipt.resultDigest === key && typeof receipt.attemptEpoch === 'number' && Number.isSafeInteger(receipt.attemptEpoch) && receipt.attemptEpoch === command.attemptEpoch, `managed accepted report ${key} receipt binding is invalid`);
      if (hasRoleBinding) invariant(receipt.authorityAnchorDigest === (row.authorityAnchor as Ref).digest, `managed accepted report ${key} receipt authority anchor is invalid`);
      for (const field of ['attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'modeEpoch'] as const) invariant(typeof row[field] === 'number' && Number.isSafeInteger(row[field]) && (row[field] as number) >= 0 && (row[field] as number) === commandRecord[field], `managed accepted report ${key} ${field} binding is invalid`);
      invariant(command.receipt && refIsValid(command.receipt), `managed accepted report ${key} dispatch receipt is missing`);
      let proof: Record<string, unknown>;
      try { proof = parseCanonical<Record<string, unknown>>((command.receipt as Ref).bytes ?? ''); }
      catch { throw new Error(`ManifestMismatch: managed accepted report ${key} dispatch proof is invalid`); }
      invariant(proof.launchToken === command.launchToken && proof.commandDigest === command.commandDigest && proof.receipt && refIsValid(proof.receipt) && canonicalString(proof.receipt) === canonicalString(row.ref)
        && (!hasRoleBinding || canonicalString(proof.authorityAnchor) === canonicalString(row.authorityAnchor)), `managed accepted report ${key} dispatch result is not the same immutable Ref`);
    }
    validateAcceptedReportProjection(Object.values(reports as Record<string, unknown>) as Record<string, unknown>[], state);
  }
  if (value.proposal !== undefined) {
    const proposal = value.proposal;
    invariant(proposal && typeof proposal === 'object' && !Array.isArray(proposal), 'managed proposal is invalid');
    exactKeys(proposal as object, ['key', 'leaseSetId', 'planDigest', 'waveRef', ...(Object.prototype.hasOwnProperty.call(proposal, 'roleWaveRef') ? ['roleWaveRef'] : []), ...(Object.prototype.hasOwnProperty.call(proposal, 'rolloutOrigin') ? ['rolloutOrigin'] : [])], 'managed proposal');
    const item = proposal as Record<string, unknown>;
    invariant(typeof item.key === 'string' && SHA256.test(item.key) && typeof item.planDigest === 'string' && SHA256.test(item.planDigest) && typeof item.leaseSetId === 'string' && item.leaseSetId.length > 0 && refIsValid(item.waveRef), 'managed proposal fields are invalid');
    invariant(item.roleWaveRef === undefined || (refIsValid(item.roleWaveRef) && (item.roleWaveRef as Ref).scope === 'deliberation/wave' && typeof (item.roleWaveRef as Ref).bytes === 'string'), 'managed proposal role Wave is invalid');
    invariant(value.rollout === undefined || (verifyManagedRolloutProjection(item.rolloutOrigin) && canonicalString(item.rolloutOrigin) === canonicalString(value.rolloutOrigin)), 'managed proposal rollout origin is invalid');
  }
  try {
    // The durable lease rows carry lifecycle metadata (expiry/status), while
    // the C1–C5 graph proof intentionally sees only the closed identity edge.
    // Project each row into that exact graph shape before invoking the shared
    // validator; lifecycle fields remain validated above.
    const graphLeaseSets: Record<string, { leaseId: string; closedRefGraph: Ref[] }> = {};
    for (const [leaseId, raw] of Object.entries(leaseSets as Record<string, unknown>)) {
      const lease = raw as Record<string, unknown>;
      graphLeaseSets[leaseId] = { leaseId: lease.leaseId as string, closedRefGraph: (lease.closedRefGraph as Ref[]).map((ref) => ({ ...ref })) };
    }
    const attemptOwners: ManagedGraphAttemptOwner[] = Object.values((value.attempts as Record<string, Record<string, unknown>> | undefined) ?? {})
      .filter((attempt) => attempt.authorityAnchor !== undefined)
      .map((attempt) => ({ commandId: attempt.commandId as string, authorityAnchor: attempt.authorityAnchor as Ref }));
    const decisionOwners: ManagedGraphDecisionOwner[] = [];
    for (const [token, raw] of Object.entries(state.decisionTokens)) {
      const record = raw as Record<string, unknown>;
      if ((record.kind === 'DELIBERATION_SELECTION' || record.kind === 'DELIBERATION') && record.consumed) {
        const settlement = record.nullableSettlement === null ? null : (value.settlements as Record<string, Ref> | undefined)?.[record.nullableSettlement as string];
        const authorityAnchors = (record.orderedReportRefs as Ref[]).flatMap((reportRef) => {
          const row = (value.acceptedReports as Record<string, Record<string, unknown>> | undefined)?.[reportRef.digest];
          return row?.authorityAnchor ? [row.authorityAnchor as Ref] : [];
        });
        decisionOwners.push({ token, leaseSetId: record.publicationLeaseSetId as string, disposition: record.disposition as string, waveRef: record.waveRef as Ref, orderedReportRefs: record.orderedReportRefs as Ref[], ...(authorityAnchors.length ? { authorityAnchors } : {}), settlement, ...(record.successorWaveRef === undefined ? {} : { successorWaveRef: record.successorWaveRef as Ref }) });
      }
    }
    assertManagedGraph({
      proposal: value.proposal === undefined ? undefined : {
        leaseSetId: (value.proposal as Record<string, unknown>).leaseSetId as string,
        waveRef: (value.proposal as Record<string, unknown>).waveRef as ManagedGraphRef,
      },
      leaseSets: graphLeaseSets,
      ...(attemptOwners.length ? { attemptOwners } : {}),
      ...(decisionOwners.length ? { decisionOwners } : {}),
    });
  } catch (error) {
    throw new Error(`ManifestMismatch: ${(error as Error).message}`);
  }
  // Keep the parent state identity bound to the managed proposal when one is
  // present; a free-floating proposal would be an authority escape.
  if (value.proposal !== undefined) invariant((value.proposal as Record<string, unknown>).planDigest === state.planDigest, 'managed proposal plan digest disagrees with state');
}

function validateStateShape(state: MachineState): void {
  invariant(state && typeof state === 'object', 'state is not an object');
  const stateKeys = ['schema', 'runId', 'phaseId', 'revision', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch', 'modeEpoch', 'writerFence', 'status', 'gate', 'barrier', 'steps', 'outbox', 'processed', 'decisionTokens', 'planDigest', 'nextAction', 'journal'];
  if (state.schema === 2) stateKeys.push('managed');
  exactKeys(state as unknown as object, stateKeys, 'state');
  invariant(state.schema === 1 || state.schema === 2, 'state schema is invalid');
  if (state.schema === 2) validateManagedState(state.managed, state);
  for (const [field, value] of Object.entries({ revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, modeEpoch: state.modeEpoch })) nonNegativeInteger(value, field);
  invariant(state.modeEpoch === 0, 'state modeEpoch is unsupported');
  invariant(typeof state.runId === 'string' && state.runId.length > 0, 'state runId is invalid');
  invariant(typeof state.phaseId === 'string' && state.phaseId.length > 0, 'state phaseId is invalid');
  invariant(typeof state.writerFence === 'string' && state.writerFence.length > 0, 'state writerFence is invalid');
  invariant(['ACTIVE', 'BLOCKED', 'COMPLETE'].includes(state.status), 'state status is invalid');
  invariant(['NOT-DUE', 'DUE', 'PASS', 'FINDINGS'].includes(state.gate), 'state gate is invalid');
  invariant(['OPEN', 'CLOSED'].includes(state.barrier), 'state barrier is invalid');
  invariant(typeof state.nextAction === 'string' && NEXT_ACTIONS.has(state.nextAction), 'state nextAction is invalid');
  invariant(state.steps && typeof state.steps === 'object' && !Array.isArray(state.steps) && state.outbox && typeof state.outbox === 'object' && !Array.isArray(state.outbox) && state.decisionTokens && typeof state.decisionTokens === 'object' && !Array.isArray(state.decisionTokens), 'state projections are invalid');
  invariant(typeof state.planDigest === 'string' && SHA256.test(state.planDigest), 'state planDigest is invalid');
  invariant(Array.isArray(state.journal), 'state journal is invalid');
  invariant(state.processed && typeof state.processed === 'object' && !Array.isArray(state.processed), 'state processed map is invalid');
  const stepStatuses = new Set(['READY', 'ACTIVE', 'NEEDS-DECISION', 'REPAIR', 'DONE', 'BLOCKED', 'SUPERSEDED']);
  for (const [key, value] of Object.entries(state.steps)) {
    invariant(!RESERVED_PROJECTION_KEYS.has(key), `step ${key} uses a reserved projection key`);
    invariant(value && typeof value === 'object', `step ${key} is invalid`);
    const step = value as Record<string, unknown>;
    invariant(typeof step.stepId === 'string' && step.stepId === key, `step ${key} identity is invalid`);
    invariant(stepStatuses.has(String(step.status)), `step ${key} status is invalid`);
    invariant(typeof step.attempt === 'number' && Number.isSafeInteger(step.attempt) && step.attempt >= 0, `step ${key} attempt is invalid`);
    invariant(step.dependencies === undefined || (Array.isArray(step.dependencies) && step.dependencies.every((item) => typeof item === 'string' && Object.prototype.hasOwnProperty.call(state.steps, item))), `step ${key} dependencies are invalid`);
    invariant(step.claims === undefined || (Array.isArray(step.claims) && step.claims.every((claim) => {
      if (!claim || typeof claim !== 'object') return false;
      const item = claim as Record<string, unknown>;
      return Object.keys(item).every((field) => ['resource', 'mode', 'aliases'].includes(field)) && typeof item.resource === 'string' && item.resource.length > 0 && ['READ', 'WRITE', 'EXCLUSIVE'].includes(String(item.mode)) && (item.aliases === undefined || (Array.isArray(item.aliases) && item.aliases.every((alias) => typeof alias === 'string' && alias.length > 0)));
    })), `step ${key} claims are invalid`);
  }
  try { validateDependencyTopology(state.steps); }
  catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message}`); }
  const outboxStates = new Set(['PENDING', 'CLAIMED', 'ACKED', 'UNKNOWN']);
  const launchTokens = new Set<string>();
  const currentCommandsByStep = new Map<string, OutboxCommand[]>();
  const commandsByStepAttempt = new Map<string, OutboxCommand[]>();
  for (const [key, value] of Object.entries(state.outbox)) {
    invariant(!RESERVED_PROJECTION_KEYS.has(key), `outbox ${key} uses a reserved projection key`);
    invariant(value && typeof value === 'object', `outbox ${key} is invalid`);
    const command = value as Partial<OutboxCommand>;
    invariant(Object.keys(command as object).every((field) => ['commandId', 'runId', 'phaseId', 'stepId', 'attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'modeEpoch', 'launchToken', 'commandDigest', 'state', 'roleView', 'predecessorReportDigests', 'receipt', 'leaseId', 'noEffectEvidence'].includes(field)), `outbox ${key} fields are invalid`);
    // A safely adopted authority may remove a display node while preserving
    // the old command identity for late receipt/UNKNOWN reconciliation.  The
    // command remains bound to this run/phase; membership in the *current*
    // step projection is intentionally not required.
    invariant(command.commandId === key && typeof command.commandId === 'string' && /^[0-9a-f]{32}$/.test(command.commandId) && typeof command.runId === 'string' && command.runId === state.runId && typeof command.phaseId === 'string' && command.phaseId === state.phaseId && typeof command.stepId === 'string' && command.stepId.length > 0, `outbox ${key} identity is invalid`);
    for (const field of ['attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'modeEpoch'] as const) { const epoch = command[field]; invariant(typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 0, `outbox ${key} ${field} is invalid`); }
    invariant(command.modeEpoch === 0, `outbox ${key} modeEpoch is unsupported`);
    invariant(command.attemptEpoch! <= state.attemptEpoch && command.authorityEpoch! <= state.authorityEpoch && command.barrierEpoch! <= state.barrierEpoch && command.modeEpoch! <= state.modeEpoch, `outbox ${key} is from a future epoch`);
    invariant(typeof command.launchToken === 'string' && command.launchToken.length > 0 && !launchTokens.has(command.launchToken), `outbox ${key} launch token is invalid`); launchTokens.add(command.launchToken);
    invariant(typeof command.commandDigest === 'string' && SHA256.test(command.commandDigest) && command.commandDigest === digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken }), `outbox ${key} digest is invalid`);
    invariant(typeof command.state === 'string' && outboxStates.has(command.state), `outbox ${key} state is invalid`);
    invariant((command.roleView === undefined) === (command.predecessorReportDigests === undefined), `outbox ${key} role binding is incomplete`);
    if (command.roleView !== undefined) {
      invariant(refIsValid(command.roleView) && command.roleView.scope === 'deliberation/role-view' && typeof command.roleView.bytes === 'string'
        && command.roleView.id === `role-view:${command.roleView.digest}`, `outbox ${key} role view is invalid`);
      invariant(Array.isArray(command.predecessorReportDigests) && command.predecessorReportDigests.every((item) => typeof item === 'string' && SHA256.test(item))
        && new Set(command.predecessorReportDigests).size === command.predecessorReportDigests.length, `outbox ${key} predecessor digests are invalid`);
      invariant(command.launchToken === `launch-${digest({ commandId: command.commandId, attemptEpoch: command.attemptEpoch, roleDigest: command.roleView.digest, predecessorReportDigests: command.predecessorReportDigests }).slice(0, 32)}`,
        `outbox ${key} launch token is not role-bound`);
    }
    invariant(command.leaseId === undefined || typeof command.leaseId === 'string', `outbox ${key} lease is invalid`);
    invariant(command.receipt === undefined || refIsValid(command.receipt), `outbox ${key} receipt is invalid`);
    invariant(command.noEffectEvidence === undefined || (Array.isArray(command.noEffectEvidence) && command.noEffectEvidence.every(refIsValid)), `outbox ${key} evidence is invalid`);
    if (command.roleView !== undefined && command.state === 'UNKNOWN') {
      const teardown = command.noEffectEvidence?.find((candidate) => candidate.scope === 'outbox/teardown' && typeof candidate.bytes === 'string');
      let value: any;
      try { value = teardown ? parseCanonical(teardown.bytes!) : undefined; } catch { value = undefined; }
      invariant(teardown !== undefined && value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === 'command,predecessorReportDigests,processTreeExited,providerExited,roleDigest,schema,scratchRemoved'
        && value.schema === 'lunacy-codex-deliberation-teardown/v1' && value.providerExited === true && value.processTreeExited === true && value.scratchRemoved === true
        && value.command && typeof value.command === 'object' && Object.keys(value.command).sort().join(',') === 'attemptEpoch,authorityEpoch,barrierEpoch,commandDigest,commandId,launchToken,modeEpoch,phaseId,runId,stepId'
        && value.command.commandId === command.commandId && value.command.launchToken === command.launchToken && value.command.commandDigest === command.commandDigest
        && value.roleDigest === command.roleView.digest && canonicalString(value.predecessorReportDigests) === canonicalString(command.predecessorReportDigests)
        && teardown!.digest === digest(value), `outbox ${key} UNKNOWN lacks bound teardown evidence`);
    }
    const stepAttempt = `${command.stepId}\u0000${command.attemptEpoch}`;
    const attemptCommands = commandsByStepAttempt.get(stepAttempt) ?? [];
    attemptCommands.push(command as OutboxCommand);
    commandsByStepAttempt.set(stepAttempt, attemptCommands);
    if (command.attemptEpoch === state.attemptEpoch && command.authorityEpoch === state.authorityEpoch && command.barrierEpoch === state.barrierEpoch && command.modeEpoch === state.modeEpoch) {
      const owner = Object.prototype.hasOwnProperty.call(state.steps, command.stepId!) ? state.steps[command.stepId!] : undefined;
      // Every command in the current execution frame must name a step from
      // that same admitted attempt. Historical retained nodes/commands are
      // valid recovery evidence, but they cannot be rebound by adding a
      // deterministic-looking command in the newer frame.
      invariant(owner !== undefined && owner.attempt === command.attemptEpoch, `current outbox ${key} does not belong to its step attempt`);
      if (command.state === 'PENDING' || command.state === 'CLAIMED' || command.state === 'UNKNOWN') {
        invariant(owner.status === 'ACTIVE', `current outbox ${key} does not belong to an active step`);
      }
      const commands = currentCommandsByStep.get(command.stepId!) ?? [];
      commands.push(command as OutboxCommand);
      currentCommandsByStep.set(command.stepId!, commands);
    }
  }
  for (const [key, value] of Object.entries(state.steps)) {
    if (value.status !== 'ACTIVE') continue;
    invariant(value.attempt <= state.attemptEpoch, `active step ${key} is from a future attempt`);
    // An epoch change may already be durable while work admitted by the
    // preceding attempt is retained for replay/reconciliation.  Preserve that
    // historical binding instead of pretending it belongs to the new frame.
    // Current-attempt work remains stricter: its command must also be in the
    // exact current authority/barrier/mode frame.
    const commands = value.attempt === state.attemptEpoch
      ? (currentCommandsByStep.get(key) ?? [])
      : (commandsByStepAttempt.get(`${key}\u0000${value.attempt}`) ?? []);
    invariant(commands.length === 1, `active step ${key} does not have exactly one ${value.attempt === state.attemptEpoch ? 'current' : 'historical'} command`);
    const expectedCommandId = digest({ runId: state.runId, phaseId: state.phaseId, stepId: key, attemptEpoch: value.attempt }).slice(0, 32);
    const expectedLaunchToken = commands[0].roleView
      ? `launch-${digest({ commandId: commands[0].commandId, attemptEpoch: commands[0].attemptEpoch, roleDigest: commands[0].roleView!.digest, predecessorReportDigests: commands[0].predecessorReportDigests }).slice(0, 32)}`
      : `launch-${expectedCommandId}`;
    invariant(commands[0].commandId === expectedCommandId && commands[0].launchToken === expectedLaunchToken, `active step ${key} command identity is invalid`);
  }
  const managedLeaseSets = state.managed?.leaseSets ?? {};
  const managedSettlements = state.managed?.settlements ?? {};
  const managedAcceptedReports = (state.managed?.acceptedReports as Record<string, unknown> | undefined) ?? {};
  const settlementOwners = new Set<string>();
  for (const [token, value] of Object.entries(state.decisionTokens)) {
    invariant(!RESERVED_PROJECTION_KEYS.has(token) && value && typeof value === 'object', `decision token ${token} is invalid`);
    const record = value as Record<string, unknown>;
    invariant(typeof record.kind === 'string' && typeof record.consumed === 'boolean' && typeof record.identity === 'string' && SHA256.test(record.identity), `decision token ${token} fields are invalid`);
    if (record.kind === 'AUTHORITY_ADOPTION') {
      exactKeys(record, ['kind', 'consumed', 'identity', 'expectedDigest', 'observedDigest', 'targetDigest', ...(Object.prototype.hasOwnProperty.call(record, 'rolloutOrigin') ? ['rolloutOrigin'] : [])], `decision token ${token}`);
      invariant(typeof record.expectedDigest === 'string' && SHA256.test(record.expectedDigest) && typeof record.observedDigest === 'string' && SHA256.test(record.observedDigest) && typeof record.targetDigest === 'string' && SHA256.test(record.targetDigest), `decision token ${token} authority digests are invalid`);
      invariant(state.managed?.rolloutOrigin === undefined ? record.rolloutOrigin === undefined : (verifyManagedRolloutProjection(record.rolloutOrigin) && canonicalString(record.rolloutOrigin) === canonicalString(state.managed.rolloutOrigin)), `decision token ${token} rollout origin is invalid`);
    } else if (record.kind === 'DELIBERATION_SELECTION' || record.kind === 'DELIBERATION') {
      exactKeys(record, ['kind', 'consumed', 'identity', 'authorshipInputDigest', 'decisionKey', 'waveRef', 'orderedReportRefs', 'predecessorGeneration', 'disposition', 'nullableSettlement', 'bindingDigest', ...(Object.prototype.hasOwnProperty.call(record, 'resultKind') ? ['resultKind'] : []), ...(Object.prototype.hasOwnProperty.call(record, 'resultDigest') ? ['resultDigest'] : []), ...(Object.prototype.hasOwnProperty.call(record, 'publicationLeaseSetId') ? ['publicationLeaseSetId'] : []), ...(Object.prototype.hasOwnProperty.call(record, 'successorWaveRef') ? ['successorWaveRef'] : []), ...(Object.prototype.hasOwnProperty.call(record, 'rolloutOrigin') ? ['rolloutOrigin'] : [])], `decision token ${token}`);
      invariant(state.managed?.rolloutOrigin === undefined ? record.rolloutOrigin === undefined : (verifyManagedRolloutProjection(record.rolloutOrigin) && canonicalString(record.rolloutOrigin) === canonicalString(state.managed.rolloutOrigin)), `decision token ${token} rollout origin is invalid`);
      invariant(typeof record.authorshipInputDigest === 'string' && SHA256.test(record.authorshipInputDigest), `decision token ${token} authorship digest is invalid`);
      invariant(typeof record.decisionKey === 'string' && record.decisionKey.length > 0, `decision token ${token} decision key is invalid`);
      invariant(refIsValid(record.waveRef), `decision token ${token} wave ref is invalid`);
      invariant(Array.isArray(record.orderedReportRefs) && record.orderedReportRefs.every(refIsValid), `decision token ${token} report refs are invalid`);
      if (record.consumed || record.orderedReportRefs.length > 0) {
        for (const reportRef of record.orderedReportRefs as Ref[]) invariant(Object.prototype.hasOwnProperty.call(managedAcceptedReports, reportRef.digest) && canonicalString((managedAcceptedReports[reportRef.digest] as Record<string, unknown>)?.ref) === canonicalString(reportRef), `decision token ${token} accepted report row is missing or foreign`);
      }
      nonNegativeInteger(record.predecessorGeneration, `decision token ${token} predecessor generation`);
      invariant(typeof record.disposition === 'string' && record.disposition.length > 0, `decision token ${token} disposition is invalid`);
      invariant(record.nullableSettlement === null || (typeof record.nullableSettlement === 'string' && SHA256.test(record.nullableSettlement)), `decision token ${token} settlement digest is invalid`);
      invariant(typeof record.bindingDigest === 'string' && SHA256.test(record.bindingDigest), `decision token ${token} binding digest is invalid`);
        invariant(record.publicationLeaseSetId === undefined || (typeof record.publicationLeaseSetId === 'string' && record.publicationLeaseSetId.length > 0), `decision token ${token} publication lease binding is invalid`);
      invariant(record.successorWaveRef === undefined || refIsValid(record.successorWaveRef), `decision token ${token} successor Wave Ref is invalid`);
      const expectedBinding = digest({
        kind: record.kind,
        authorshipInputDigest: record.authorshipInputDigest,
        decisionKey: record.decisionKey,
        waveRef: record.waveRef,
        orderedReportRefs: record.orderedReportRefs,
        predecessorGeneration: record.predecessorGeneration,
        disposition: record.disposition,
        nullableSettlement: record.nullableSettlement,
        resultKind: record.resultKind ?? null,
        resultDigest: record.resultDigest ?? null,
        publicationLeaseSetId: record.publicationLeaseSetId ?? null,
        successorWaveRef: record.successorWaveRef ?? null,
        ...(record.rolloutOrigin ? { rolloutOrigin: record.rolloutOrigin } : {}),
      });
      invariant(record.bindingDigest === expectedBinding, `decision token ${token} binding digest mismatch`);
      if (record.consumed) {
        invariant(['SELECTION', 'SYNTHESIS', 'WIDEN'].includes(String(record.disposition)), `decision token ${token} consumed disposition is invalid`);
        invariant(['COMPLETE_PLAN', 'DELIBERATION_REQUIRED'].includes(String(record.resultKind)) && typeof record.resultDigest === 'string' && SHA256.test(record.resultDigest), `decision token ${token} full result binding is invalid`);
        invariant(typeof record.publicationLeaseSetId === 'string' && Object.prototype.hasOwnProperty.call(managedLeaseSets, record.publicationLeaseSetId) && (managedLeaseSets[record.publicationLeaseSetId] as { status?: string }).status !== 'EXPIRED', `decision token ${token} publication lease is missing or expired`);
        if (record.disposition === 'WIDEN') {
          invariant(record.nullableSettlement === null, `decision token ${token} WIDEN settlement is invalid`);
          invariant(record.resultKind === 'DELIBERATION_REQUIRED' && record.successorWaveRef !== undefined && refIsValid(record.successorWaveRef) && (record.successorWaveRef as Ref).scope === 'deliberation/wave' && typeof (record.successorWaveRef as Ref).bytes === 'string', `decision token ${token} WIDEN successor binding is missing`);
          const successor = record.successorWaveRef as Ref;
          try { const parsed = parseCanonical<Record<string, unknown>>(successor.bytes!); invariant(parsed.schema === 'lunacy-deliberation-wave/v2', `decision token ${token} WIDEN successor schema is invalid`); } catch { throw new Error(`ManifestMismatch: decision token ${token} WIDEN successor bytes are invalid`); }
          invariant(managedSuccessorWaveIsBoundStore(state, record, successor), `decision token ${token} WIDEN successor authorship is disconnected`);
        }
        else {
          invariant(typeof record.nullableSettlement === 'string' && Object.prototype.hasOwnProperty.call(managedSettlements, record.nullableSettlement), `decision token ${token} settlement binding is missing`);
          settlementOwners.add(record.nullableSettlement as string);
          invariant(managedSettlementRecordIsValid(managedSettlements[record.nullableSettlement] as Ref, record, state), `decision token ${token} settlement record binding is invalid`);
          if (record.successorWaveRef && record.resultKind === 'DELIBERATION_REQUIRED') {
            let settlementResult: Record<string, unknown> | undefined;
            try {
              const settlementBytes = (managedSettlements[record.nullableSettlement] as Ref).bytes!;
              settlementResult = (parseCanonical<Record<string, unknown>>(settlementBytes).result as Record<string, unknown>);
            } catch { settlementResult = undefined; }
            invariant(settlementResult && canonicalString(settlementResult.wave) === canonicalString(record.successorWaveRef), `decision token ${token} settlement result/successor mismatch`);
          }
        }
      } else invariant(record.disposition === 'LIVE' && record.nullableSettlement === null && record.publicationLeaseSetId === undefined, `decision token ${token} live disposition is invalid`);
    } else {
      exactKeys(record, ['kind', 'consumed', 'identity'], `decision token ${token}`);
    }
  }
  // A settlement is an owned publication artifact, never an independent
  // managed root.  Reject rows that are not named by exactly one consumed
  // selection/synthesis token; this closes the map-level orphan gap that a
  // lease-graph check alone cannot see.
  for (const key of Object.keys(managedSettlements)) invariant(settlementOwners.has(key), `managed settlement ${key} is orphaned`);
  for (const key of Object.keys(state.managed?.settlementOrigins ?? {})) invariant(Object.prototype.hasOwnProperty.call(managedSettlements, key), `managed settlement origin ${key} is orphaned`);
  for (const [key, value] of Object.entries(state.processed)) {
    invariant(value && typeof value === 'object', `processed ${key} is invalid`);
    const record = value as { identity?: EventIdentity; digest?: string; yieldBytes?: string; revision?: number };
    exactKeys(value as unknown as object, ['digest', 'yieldBytes', 'revision', 'identity'], `processed ${key}`);
    invariant(identityIsValid(record.identity), `processed ${key} identity is invalid`);
    invariant(key === identityKey(record.identity!), `processed ${key} identity key mismatch`);
    invariant(record.identity!.runId === state.runId && (record.identity!.phaseId === state.phaseId || record.identity!.phaseId === 'run'), `processed ${key} identity scope is invalid`);
    invariant(typeof record.digest === 'string' && SHA256.test(record.digest), `processed ${key} digest is invalid`);
    invariant(record.digest === record.identity!.payloadDigest, `processed ${key} digest mismatch`);
    invariant(typeof record.yieldBytes === 'string' && yieldBytesAreValid(record.yieldBytes), `processed ${key} yield is invalid`);
    nonNegativeInteger(record.revision, `processed ${key} revision`);
  }
}

type CurrentManifest = {
  schema: 1;
  generation: number;
  revision: number;
  authorityEpoch: number;
  attemptEpoch: number;
  barrierEpoch: number;
  modeEpoch: number;
  writerFence: string;
  stateDigest: string;
  journalEnd: number;
  journalDigest: string;
  format?: 'segmented/v1' | 'segmented/v2';
  headDigest?: string;
  checkpointRevision?: number;
  segmentCount?: number;
  activeCeiling?: number;
};

type VerifiedReadOnlySnapshot = StoreSnapshot & {
  current: CurrentManifest;
  proof: {
    current: FilesystemIdentity;
    generations: FilesystemIdentity;
    generation: FilesystemIdentity;
    state: FilesystemIdentity;
    journal: FilesystemIdentity;
  };
};

/**
 * A private, process-local proof that the generation already verified by
 * `load()` is still the exact CAS predecessor.  It deliberately contains no
 * MachineState: it can only authorize skipping a duplicate verifier after
 * every small manifest/path identity is rebound under the writer fence.
 */
type VerifiedGenerationMemo = Readonly<{
  generation: number;
  current: string;
  authorityAnchors: ManagedAuthorityAnchors;
  proof: Readonly<{
    current: FilesystemIdentity;
    generations: FilesystemIdentity;
    generation: FilesystemIdentity;
    state: FilesystemIdentity;
    journal: FilesystemIdentity;
  }>;
  /** Stat fingerprints catch in-place truncation/overwrite while the probe
   * still avoids reading authoritative predecessor payloads. */
  stat: Readonly<{
    current: Readonly<{ size: number; mtimeMs: number; ctimeMs: number }>;
    generations: Readonly<{ size: number; mtimeMs: number; ctimeMs: number }>;
    generation: Readonly<{ size: number; mtimeMs: number; ctimeMs: number }>;
    state: Readonly<{ size: number; mtimeMs: number; ctimeMs: number }>;
    journal: Readonly<{ size: number; mtimeMs: number; ctimeMs: number }>;
  }>;
}>;

type ManagedAuthorityAnchors = Readonly<{
  attempts: Readonly<Record<string, string>>;
  reports: Readonly<Record<string, string>>;
}>;

function managedAuthorityAnchors(state: MachineState | undefined): ManagedAuthorityAnchors {
  const attempts: Record<string, string> = {};
  const reports: Record<string, string> = {};
  if (state?.schema === 2 && state.managed) {
    for (const [commandId, attempt] of Object.entries(state.managed.attempts ?? {})) {
      if (attempt.authorityAnchor) attempts[commandId] = canonicalString(attempt.authorityAnchor);
    }
    for (const [rowId, row] of Object.entries(state.managed.acceptedReports ?? {})) {
      if (row.authorityAnchor) reports[rowId] = canonicalString(row.authorityAnchor);
    }
  }
  return Object.freeze({ attempts: Object.freeze(attempts), reports: Object.freeze(reports) });
}

/** Authority anchors are append-only state history.  A later generation may
 * add an anchor, but cannot omit or rewrite one already accepted by CAS. */
function validateManagedAuthorityTransition(prior: ManagedAuthorityAnchors, next: MachineState): void {
  const candidate = managedAuthorityAnchors(next);
  for (const [commandId, anchor] of Object.entries(prior.attempts)) {
    invariant(candidate.attempts[commandId] === anchor, `managed attempt ${commandId} authority anchor changed`);
  }
  for (const [rowId, anchor] of Object.entries(prior.reports)) {
    invariant(candidate.reports[rowId] === anchor, `managed report ${rowId} authority anchor changed`);
  }
}

type VerifiedCurrentResult = StoreSnapshot & { current?: CurrentManifest };

const CURRENT_KEYS = ['schema', 'generation', 'revision', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch', 'modeEpoch', 'writerFence', 'stateDigest', 'journalEnd', 'journalDigest'] as const;
const SEGMENTED_CURRENT_KEYS = [...CURRENT_KEYS, 'activeCeiling', 'checkpointRevision', 'format', 'headDigest', 'segmentCount'] as const;

function validateCurrent(value: unknown): CurrentManifest {
  invariant(value && typeof value === 'object', 'CURRENT is not an object');
  const current = value as Record<string, unknown>;
  const keys = Object.keys(current);
  const segmented = keys.includes('format');
  exactKeys(current, segmented ? SEGMENTED_CURRENT_KEYS : CURRENT_KEYS, 'CURRENT');
  invariant(current.schema === 1, 'CURRENT schema is invalid');
  nonNegativeInteger(current.generation, 'CURRENT generation'); invariant((current.generation as number) > 0, 'CURRENT generation must be positive');
  for (const field of ['revision', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch', 'modeEpoch', 'journalEnd']) nonNegativeInteger(current[field], `CURRENT ${field}`);
  invariant(current.modeEpoch === 0, 'CURRENT modeEpoch is unsupported');
  invariant(typeof current.writerFence === 'string' && current.writerFence.length > 0, 'CURRENT writerFence is invalid');
  invariant(typeof current.stateDigest === 'string' && SHA256.test(current.stateDigest), 'CURRENT stateDigest is invalid');
  invariant(typeof current.journalDigest === 'string' && SHA256.test(current.journalDigest), 'CURRENT journalDigest is invalid');
  if (segmented) {
    invariant(current.format === 'segmented/v1' || current.format === 'segmented/v2', 'CURRENT format is invalid');
    nonNegativeInteger(current.checkpointRevision, 'CURRENT checkpointRevision');
    nonNegativeInteger(current.segmentCount, 'CURRENT segmentCount');
    invariant(Number.isSafeInteger(current.activeCeiling) && (current.activeCeiling as number) > 0 && (current.activeCeiling as number) <= 10_000, 'CURRENT activeCeiling is invalid');
    invariant(typeof current.headDigest === 'string' && SHA256.test(current.headDigest), 'CURRENT headDigest is invalid');
    invariant((current.checkpointRevision as number) <= (current.journalEnd as number), 'CURRENT checkpointRevision exceeds journalEnd');
  }
  return current as CurrentManifest;
}

type SegmentDescriptor = { name: string; startRevision: number; endRevision: number; bytes: number; digest: string; previousDigest: string };
type SegmentedHead = {
  schema: 1;
  format: 'segmented/v1';
  generation: number;
  runId: string;
  phaseId: string;
  writerFence: string;
  revision: number;
  journalEnd: number;
  checkpointRevision: number;
  checkpointDigest: string;
  segments: SegmentDescriptor[];
  active: SegmentDescriptor;
  activeCeiling: number;
};
type SegmentedHeadV2 = Omit<SegmentedHead, 'schema' | 'format'> & { schema: 2; format: 'segmented/v2' };
const SEGMENTED_HEAD_KEYS = ['active', 'activeCeiling', 'checkpointDigest', 'checkpointRevision', 'format', 'generation', 'journalEnd', 'phaseId', 'revision', 'runId', 'schema', 'segments', 'writerFence'] as const;
const SEGMENT_KEYS = ['bytes', 'digest', 'endRevision', 'name', 'previousDigest', 'startRevision'] as const;

function validateSegmentDescriptor(value: unknown, label: string): SegmentDescriptor {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} is invalid`);
  const item = value as Record<string, unknown>;
  exactKeys(item, SEGMENT_KEYS, label);
  invariant(typeof item.name === 'string' && /^segment-\d+-\d+\.ndjson$/.test(item.name), `${label} name is invalid`);
  for (const field of ['startRevision', 'endRevision', 'bytes'] as const) nonNegativeInteger(item[field], `${label} ${field}`);
  const empty = item.startRevision === 1 && item.endRevision === 0;
  invariant(empty || ((item.startRevision as number) > 0 && (item.endRevision as number) >= (item.startRevision as number)), `${label} range is invalid`);
  invariant(typeof item.digest === 'string' && SHA256.test(item.digest), `${label} digest is invalid`);
  invariant(typeof item.previousDigest === 'string' && SHA256.test(item.previousDigest), `${label} previousDigest is invalid`);
  return item as SegmentDescriptor;
}

function validateSegmentedHead(value: unknown): SegmentedHead {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'segmented head is invalid');
  const head = value as Record<string, unknown>;
  exactKeys(head, SEGMENTED_HEAD_KEYS, 'segmented head');
  invariant(head.schema === 1 && head.format === 'segmented/v1', 'segmented head version is invalid');
  for (const field of ['generation', 'revision', 'journalEnd', 'checkpointRevision'] as const) nonNegativeInteger(head[field], `segmented head ${field}`);
  invariant((head.generation as number) > 0 && head.revision === head.journalEnd, 'segmented head revision is invalid');
  invariant((head.checkpointRevision as number) <= (head.journalEnd as number), 'segmented head checkpoint is invalid');
  for (const field of ['runId', 'phaseId', 'writerFence'] as const) invariant(typeof head[field] === 'string' && (head[field] as string).length > 0, `segmented head ${field} is invalid`);
  invariant(typeof head.checkpointDigest === 'string' && SHA256.test(head.checkpointDigest), 'segmented head checkpointDigest is invalid');
  invariant(Array.isArray(head.segments) && head.segments.every((item, index) => validateSegmentDescriptor(item, `segmented segment ${index + 1}`)), 'segmented head segments are invalid');
  invariant(head.active && typeof head.active === 'object', 'segmented active suffix is invalid');
  validateSegmentDescriptor(head.active, 'segmented active suffix');
  invariant(Number.isSafeInteger(head.activeCeiling) && (head.activeCeiling as number) > 0 && (head.activeCeiling as number) <= 10_000, 'segmented active ceiling is invalid');
  const descriptors = [...head.segments as SegmentDescriptor[], head.active as SegmentDescriptor];
  let expected = 1; let previous: string = digest('');
  for (const descriptor of descriptors) {
    if (descriptor.endRevision === 0) invariant(descriptors.length === 1, 'segmented empty suffix must be the only segment');
    invariant(descriptor.startRevision === expected, 'segmented journal has a gap or overlap');
    invariant(descriptor.previousDigest === previous, 'segmented digest chain is invalid');
    expected = descriptor.endRevision === 0 ? 1 : descriptor.endRevision + 1;
    previous = descriptor.digest;
  }
  invariant(expected - 1 === head.journalEnd, 'segmented journal end is invalid');
  invariant((head.active as SegmentDescriptor).endRevision - (head.active as SegmentDescriptor).startRevision + 1 <= (head.activeCeiling as number), 'segmented active suffix exceeds bound');
  invariant(head.segments.length === 0 || (head.segments.at(-1) as SegmentDescriptor).endRevision < (head.active as SegmentDescriptor).startRevision, 'segmented active suffix overlaps sealed segment');
  return head as SegmentedHead;
}

function validateSegmentedHeadV2(value: unknown): SegmentedHeadV2 {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'segmented v2 head is invalid');
  const head = value as Record<string, unknown>;
  exactKeys(head, SEGMENTED_HEAD_KEYS, 'segmented v2 head');
  invariant(head.schema === 2 && head.format === 'segmented/v2', 'segmented v2 head version is invalid');
  for (const field of ['generation', 'revision', 'journalEnd', 'checkpointRevision'] as const) nonNegativeInteger(head[field], `segmented v2 head ${field}`);
  invariant((head.generation as number) > 0 && head.revision === head.journalEnd, 'segmented v2 head revision is invalid');
  invariant((head.checkpointRevision as number) <= (head.journalEnd as number), 'segmented v2 head checkpoint is invalid');
  for (const field of ['runId', 'phaseId', 'writerFence'] as const) invariant(typeof head[field] === 'string' && (head[field] as string).length > 0, `segmented v2 head ${field} is invalid`);
  invariant(typeof head.checkpointDigest === 'string' && SHA256.test(head.checkpointDigest), 'segmented v2 head checkpointDigest is invalid');
  invariant(Array.isArray(head.segments) && head.segments.every((item, index) => validateSegmentDescriptor(item, `segmented v2 segment ${index + 1}`)), 'segmented v2 head segments are invalid');
  invariant(head.active && typeof head.active === 'object', 'segmented v2 active suffix is invalid');
  validateSegmentDescriptor(head.active, 'segmented v2 active suffix');
  invariant(Number.isSafeInteger(head.activeCeiling) && (head.activeCeiling as number) > 0 && (head.activeCeiling as number) <= 10_000, 'segmented v2 active ceiling is invalid');
  const descriptors = [...head.segments as SegmentDescriptor[], head.active as SegmentDescriptor];
  let expected = 1; let previous: string = digest('');
  for (const descriptor of descriptors) {
    if (descriptor.endRevision === 0) invariant(descriptors.length === 1, 'segmented v2 empty suffix must be the only segment');
    invariant(descriptor.startRevision === expected, 'segmented v2 journal has a gap or overlap');
    invariant(descriptor.previousDigest === previous, 'segmented v2 digest chain is invalid');
    expected = descriptor.endRevision === 0 ? 1 : descriptor.endRevision + 1;
    previous = descriptor.digest;
  }
  invariant(expected - 1 === head.journalEnd, 'segmented v2 journal end is invalid');
  invariant((head.active as SegmentDescriptor).endRevision - (head.active as SegmentDescriptor).startRevision + 1 <= (head.activeCeiling as number), 'segmented v2 active suffix exceeds bound');
  invariant(head.segments.length === 0 || (head.segments.at(-1) as SegmentDescriptor).endRevision < (head.active as SegmentDescriptor).startRevision, 'segmented v2 active suffix overlaps sealed segment');
  invariant(head.checkpointRevision === (head.segments.length ? (head.segments.at(-1) as SegmentDescriptor).endRevision : 0), 'segmented v2 checkpoint does not name sealed prefix');
  return head as SegmentedHeadV2;
}

function segmentBytes(entries: readonly Record<string, unknown>[]): string {
  return entries.length ? `${entries.map((entry) => canonicalString(entry)).join('\n')}\n` : '';
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) { await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)); return; }
  throwIfFileStoreAborted(signal);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const timer = setTimeout(() => finish(resolvePromise), milliseconds);
    const onAbort = (): void => finish(() => rejectPromise(mintFileArtifactStoreAbort()));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  throwIfFileStoreAborted(signal);
}

type FenceOwnerState = 'RETRY' | 'LIVE' | 'STALE' | 'CONTENDED';
type FenceReclaimResult = Exclude<FenceOwnerState, 'STALE'>;
const MAX_FENCE_RECLAIM_CONTENTION_POLLS = 500;
const FENCE_POLL_MS = 5;
const MAX_PROCESS_ID = 2_147_483_647;

export class MemoryArtifactStore implements ArtifactStore {
  private format: ArtifactFormat;
  get journalFormat(): ArtifactFormat { return this.format; }
  private readonly segmentEventCeiling: number;
  private state?: MachineState;
  private generation = 0;
  private fence: Promise<void> = Promise.resolve();
  private readonly publicationLeases = new Map<string, PublicationLease>();
  constructor(options: ArtifactStoreOptions = {}) {
    this.format = normalizeArtifactFormat(options.format ?? 'legacy');
    this.segmentEventCeiling = Number.isSafeInteger(options.segmentEventCeiling) && (options.segmentEventCeiling as number) > 0 ? Math.min(options.segmentEventCeiling as number, 10_000) : 1000;
  }
  private async withFence<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.fence;
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const queued = previous.then(() => current);
    this.fence = queued;
    await previous;
    try { return await fn(); }
    finally { release(); if (this.fence === queued) this.fence = Promise.resolve(); }
  }
  async load(): Promise<StoreSnapshot> {
    return this.withFence(() => {
      const state = this.state ? cloneState(this.state) : undefined;
      // Keep MemoryArtifactStore on the same trust boundary as FileArtifactStore:
      // schema-2 graph closure is proved again at every load, not only when a
      // candidate was first committed.  This also catches hostile in-process
      // mutation of the private backing state before it reaches a kernel.
      if (state) validateStateShape(state);
      return { state, generation: this.generation };
    });
  }
  async commit(previousGeneration: number, state: MachineState): Promise<number> {
    return this.withFence(() => {
      if (previousGeneration !== this.generation) throw mintStoreGenerationConflict();
      validateStateShape(state);
      validateManagedAuthorityTransition(managedAuthorityAnchors(this.state), state);
      const journalText = state.journal.map((entry) => canonicalString(entry)).join('\n') + (state.journal.length ? '\n' : '');
      validateJournal(state, journalText, { segmented: isSegmentedFormat(this.format) });
      this.state = cloneState(state); this.generation += 1;
      return this.generation;
    });
  }
  async selectFormat(format: ArtifactFormat): Promise<void> { if (!['legacy', 'segmented', 'segmented/v2', 'segmented-v2'].includes(format)) throw new Error('ManifestMismatch: unknown artifact format'); this.format = normalizeArtifactFormat(format); }
  async migrateToSegmented(): Promise<number> { this.format = 'segmented'; return this.generation; }
  async migrateToSegmentedV2(): Promise<number> { this.format = 'segmented/v2'; return this.generation; }
  async migrate(format?: ArtifactFormat): Promise<number> { return format === 'segmented/v2' || format === 'segmented-v2' || (format === undefined && this.format === 'segmented/v2') ? this.migrateToSegmentedV2() : this.migrateToSegmented(); }
  async rollbackSegmented(): Promise<number> { this.format = 'legacy'; return this.generation; }
  async rollback(): Promise<number> { return this.rollbackSegmented(); }
  async compact(): Promise<{ removed: number }> { return { removed: 0 }; }
  [STORE_LINEARIZED_DISPATCH](request: StoreLinearizedDispatchRequest, marker: EntryMarker): Promise<InternalDispatchResult> {
    return this.withFence(() => invokeIfCurrent({ state: this.state, generation: this.generation }, request, marker));
  }
  async acquirePublicationLease(leaseId: string, refs: readonly Ref[], ttlMs = 60_000): Promise<PublicationLease> {
    return this.withFence(() => {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(leaseId) || !Array.isArray(refs) || refs.length === 0 || refs.some((item) => !refIsValid(item))) throw new Error('publication lease is malformed');
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) throw new Error('publication lease ttl is invalid');
      const prior = this.publicationLeases.get(leaseId);
      if (prior && prior.status === 'ACTIVE' && prior.expiresAt > Date.now()) {
        if (canonicalString(prior.refs) !== canonicalString(refs)) throw new Error('publication lease conflicts');
        return { ...prior, refs: prior.refs.map((ref) => ({ ...ref })) };
      }
      if (prior?.status === 'PROMOTED') throw new Error('publication lease already promoted');
      const lease: PublicationLease = { leaseId, refs: refs.map((ref) => ({ ...ref })), expiresAt: Date.now() + ttlMs, status: 'ACTIVE' };
      this.publicationLeases.set(leaseId, lease); return { ...lease, refs: lease.refs.map((ref) => ({ ...ref })) };
    });
  }
  async promotePublicationLease(leaseId: string): Promise<PublicationLease> {
    return this.withFence(() => {
      const lease = this.publicationLeases.get(leaseId);
      if (!lease) throw new Error('publication lease unavailable');
      if (lease.status === 'PROMOTED') return { ...lease, refs: lease.refs.map((ref) => ({ ...ref })) };
      if (lease.status !== 'ACTIVE' || lease.expiresAt <= Date.now()) throw new Error('publication lease unavailable');
      lease.status = 'PROMOTED'; return { ...lease, refs: lease.refs.map((ref) => ({ ...ref })) };
    });
  }
  async releasePublicationLease(leaseId: string): Promise<void> { await this.withFence(() => { this.publicationLeases.delete(leaseId); }); }
  async collectPublicationLeases(now = Date.now()): Promise<{ removed: number }> {
    return this.withFence(() => {
      let removed = 0;
      const rooted = new Set(Object.keys(this.state?.managed?.leaseSets ?? {}));
      for (const [id, lease] of this.publicationLeases) {
        // CURRENT's managed leaseSets are authoritative roots. Expired rows
        // remain bounded until their root is explicitly released/converged.
        if (lease.status === 'ACTIVE' && lease.expiresAt <= now && !rooted.has(id)) {
          lease.status = 'EXPIRED'; this.publicationLeases.delete(id); removed += 1;
        }
      }
      return { removed };
    });
  }
}

export class FileArtifactStore implements ArtifactStore {
  private format: ArtifactFormat;
  get journalFormat(): ArtifactFormat { return this.format; }
  private readonly segmentEventCeiling: number;
  private readonly rootDir: string;
  private readonly kernelDir: string;
  private readonly generationsDir: string;
  private readonly lockPath: string;
  private readonly publicationLeasesDir: string;
  private readonly expectedRootIdentity?: FilesystemIdentity;
  private readonly faultInjector?: (point: string) => void;
  private rollbackRequested = false;
  private rootIdentity?: FilesystemIdentity;
  private kernelIdentity?: FilesystemIdentity;
  private fenceIdentity?: FilesystemIdentity;
  private fenceOwner?: string;
  private staleFenceObservation?: { text: string; identity: FilesystemIdentity };
  /** One-shot proof captured by load(); never durable or shared. */
  private verifiedGenerationMemo?: VerifiedGenerationMemo;

  constructor(rootDir: string, expectedRootIdentity?: FilesystemIdentity | ArtifactStoreOptions, options: ArtifactStoreOptions = {}) {
    this.rootDir = resolve(rootDir);
    this.kernelDir = join(this.rootDir, '.kernel');
    this.generationsDir = join(this.kernelDir, 'generations');
    this.lockPath = join(this.kernelDir, '.writer.lock');
    this.publicationLeasesDir = join(this.kernelDir, 'publication-leases');
    const maybeOptions = expectedRootIdentity && ('format' in expectedRootIdentity || 'segmentEventCeiling' in expectedRootIdentity || 'faultInjector' in expectedRootIdentity) ? expectedRootIdentity as ArtifactStoreOptions : undefined;
    const identity = maybeOptions ? undefined : expectedRootIdentity as FilesystemIdentity | undefined;
    const selected = options.format ?? maybeOptions?.format;
    this.expectedRootIdentity = identity;
    this.rootIdentity = identity;
    this.format = normalizeArtifactFormat(selected ?? 'legacy');
    const bound = options.segmentEventCeiling ?? maybeOptions?.segmentEventCeiling;
    this.segmentEventCeiling = Number.isSafeInteger(bound) && (bound as number) > 0 ? Math.min(bound as number, 10_000) : 1000;
    this.faultInjector = options.faultInjector ?? maybeOptions?.faultInjector;
  }

  private injectFault(point: string): void { this.faultInjector?.(point); }

  private async assertDirectory(path: string, label: string): Promise<void> {
    try {
      const trusted = await inspectTrustedPath(path, label, { allowMissing: true, surface: true, kind: 'directory' });
      if (!trusted) { const error = new Error(`ENOENT: ${label} does not exist`) as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`);
    }
  }

  private async assertRegular(path: string, label: string): Promise<void> {
    try {
      const trusted = await inspectTrustedPath(path, label, { allowMissing: true, surface: true, kind: 'file' });
      if (!trusted) { const error = new Error(`ENOENT: ${label} is absent`) as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      if ((error as Error).message.startsWith('ManifestMismatch:')) throw error;
      throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`);
    }
  }

  private async ensureDirectory(path: string, label: string): Promise<void> {
    try { await ensurePrivateDirectory(path, label); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
  }

  /** Read through an already-open descriptor with O_NOFOLLOW.  The lstat
   * check gives a useful diagnostic, while the no-follow open closes the
   * check/use race where another process swaps a regular file for a symlink
   * between those two operations. */
  private async readRegular(path: string, label: string, byteCeiling?: number): Promise<string> {
    await this.assertRegular(path, label);
    const before = await inspectTrustedPath(path, label, { allowMissing: true, surface: true, kind: 'file' });
    if (!before) { const error = new Error(`ENOENT: ${label} is absent`) as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; }
    let handle;
    try { handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`ManifestMismatch: ${label} is a symlink`);
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`ManifestMismatch: ${label} is not a regular file`);
      if (!sameFilesystemIdentity(filesystemIdentity(stat), before.identity)) throw new Error(`ManifestMismatch: ${label} changed before descriptor binding`);
      const after = await inspectTrustedPath(path, label, { allowMissing: true, surface: true, kind: 'file' });
      if (!after) { const error = new Error(`ENOENT: ${label} is absent`) as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; }
      if (!sameFilesystemIdentity(filesystemIdentity(stat), after.identity)) throw new Error(`ManifestMismatch: ${label} changed during descriptor binding`);
      if (byteCeiling === undefined) return await handle.readFile('utf8');
      if (!Number.isSafeInteger(byteCeiling) || byteCeiling < 0 || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > byteCeiling) throw new Error(`ManifestMismatch: ${label} exceeds its byte ceiling`);
      const expected = stat.size;
      const chunks: Buffer[] = [];
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected + 1)));
      let total = 0;
      while (true) {
        const result = await handle.read(buffer, 0, buffer.length, null);
        if (result.bytesRead === 0) break;
        if (result.bytesRead > expected - total || result.bytesRead > byteCeiling - total) throw new Error(`ManifestMismatch: ${label} changed during bounded read`);
        chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
        total += result.bytesRead;
      }
      if (total !== expected) throw new Error(`ManifestMismatch: ${label} changed during bounded read`);
      return Buffer.concat(chunks, total).toString('utf8');
    } finally { await handle.close(); }
  }

  /** Enumerate a trusted directory without first materializing an unbounded
   * array. The path identity checks fence ordinary rename publication; a
   * hostile same-UID ABA replacement remains outside the trust boundary. */
  private async readDirectoryBounded(path: string, label: string, entryCeiling: number): Promise<Dirent[]> {
    if (!Number.isSafeInteger(entryCeiling) || entryCeiling < 0) throw new Error(`ManifestMismatch: ${label} entry ceiling is invalid`);
    let before: FilesystemIdentity | undefined;
    try { before = await trustedIdentity(path, label, { surface: true, kind: 'directory' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!before) throw new Error(`ManifestMismatch: ${label} is absent`);
    let directory: Awaited<ReturnType<typeof fs.opendir>>;
    try { directory = await fs.opendir(path); }
    catch (error) { throw new Error(`ManifestMismatch: ${label} cannot be read: ${(error as Error).message}`); }
    const entries: Dirent[] = [];
    try {
      for await (const entry of directory) {
        if (entries.length >= entryCeiling) throw new Error(`ManifestMismatch: ${label} entry ceiling exceeded`);
        entries.push(entry);
      }
    } finally { await directory.close().catch(() => undefined); }
    let after: FilesystemIdentity | undefined;
    try { after = await trustedIdentity(path, label, { surface: true, kind: 'directory' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!after || !sameFilesystemIdentity(before, after)) throw new Error(`ManifestMismatch: ${label} changed during enumeration`);
    return entries;
  }

  /** Prove that CURRENT is not being viewed beside staged, future, aliased,
   * or otherwise unexpected generation authority. This runs before the full
   * read and again at the final read-only linearization point. */
  private async validateReadOnlyNamespace(currentGeneration: number): Promise<void> {
    const kernelEntries = await this.readDirectoryBounded(this.kernelDir, 'kernel directory', JOURNAL_EVENT_CEILING + 64);
    for (const entry of kernelEntries) {
      if (entry.name.startsWith('.CURRENT.tmp-')) throw new Error(`ManifestMismatch: staged CURRENT ${entry.name} is present`);
    }
    const generationEntries = await this.readDirectoryBounded(this.generationsDir, 'generations directory', JOURNAL_EVENT_CEILING + 1);
    for (const entry of generationEntries) {
      if (entry.name.startsWith('.g') && entry.name.includes('.tmp-')) throw new Error(`ManifestMismatch: staged generation ${entry.name} is present`);
      const match = /^g(\d+)$/.exec(entry.name);
      if (!match || entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`ManifestMismatch: unexpected generations entry ${entry.name}`);
      const candidate = Number(match[1]);
      if (!Number.isSafeInteger(candidate) || candidate <= 0 || entry.name !== `g${candidate}`) throw new Error(`ManifestMismatch: generation candidate ${entry.name} is invalid`);
      if (candidate > currentGeneration) throw new Error(`ManifestMismatch: CURRENT points before committed generation ${candidate}`);
    }
  }

  /** Write one trusted file through an O_NOFOLLOW descriptor.  Temporary
   * files are opened exclusively so a pre-created symlink cannot redirect a
   * later write outside the store root. */
  private async writeRegular(path: string, text: string, label: string, exclusive = false): Promise<void> {
    const before = await inspectTrustedPath(path, label, { allowMissing: true, surface: true, kind: 'file' });
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW | (exclusive ? fsConstants.O_EXCL : 0);
    let handle;
    try { handle = await fs.open(path, flags, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(`ManifestMismatch: ${label} is a symlink`);
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`ManifestMismatch: ${label} is not a regular file`);
      if (before && !sameFilesystemIdentity(filesystemIdentity(stat), before.identity)) throw new Error(`ManifestMismatch: ${label} changed before write`);
      const bound = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
      if (!bound || !sameFilesystemIdentity(filesystemIdentity(stat), bound.identity)) throw new Error(`ManifestMismatch: ${label} changed before write`);
      await handle.writeFile(text, 'utf8');
    } finally { await handle.close(); }
  }

  private async ensureQuarantine(baseDir: string): Promise<string> {
    const quarantine = join(baseDir, 'quarantine');
    await this.ensureDirectory(quarantine, 'quarantine directory');
    return quarantine;
  }

  private async ensure(): Promise<void> {
    await this.ensureDirectory(this.rootDir, 'root directory');
    const observed = await trustedIdentity(this.rootDir, 'root directory', { surface: true, kind: 'directory' });
    if (!observed) throw new Error('ManifestMismatch: root directory is absent');
    if (this.rootIdentity && !sameFilesystemIdentity(this.rootIdentity, observed)) throw new Error('ManifestMismatch: root directory identity changed');
    if (this.expectedRootIdentity && !sameFilesystemIdentity(this.expectedRootIdentity, observed)) throw new Error('ManifestMismatch: locked root directory identity changed');
    this.rootIdentity ??= observed;
    await this.ensureDirectory(this.kernelDir, '.kernel directory');
    const kernelObserved = await trustedIdentity(this.kernelDir, '.kernel directory', { surface: true, kind: 'directory' });
    if (!kernelObserved) throw new Error('ManifestMismatch: .kernel directory identity is unavailable');
    if (this.kernelIdentity && !sameFilesystemIdentity(this.kernelIdentity, kernelObserved)) throw new Error('ManifestMismatch: .kernel directory identity changed');
    this.kernelIdentity ??= kernelObserved;
    await this.ensureDirectory(this.generationsDir, 'generations directory');
  }

  private async fsyncFile(path: string): Promise<void> {
    await this.assertRegular(path, 'fsync target');
    let handle;
    try { handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('ManifestMismatch: fsync target is a symlink');
      throw error;
    }
    try { await handle.sync(); }
    finally { await handle.close(); }
  }

  /** Directory fsync is part of the durability contract. Do not swallow an
   * unsupported/failing call: the caller must see a durability failure and no
   * effect may be treated as committed. */
  private async fsyncDir(path: string): Promise<void> {
    await this.assertDirectory(path, 'fsync directory');
    let handle;
    try { handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('ManifestMismatch: fsync directory is a symlink');
      throw error;
    }
    try { await handle.sync(); }
    finally { await handle.close(); }
  }

  private async createExclusiveFence(owner: string): Promise<boolean> {
    const temporary = `${this.lockPath}.new-${process.pid}-${Math.random().toString(16).slice(2)}`;
    let handle;
    try {
      handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      await handle.writeFile(owner, 'utf8'); await handle.sync();
      await handle.close(); handle = undefined;
      try { await fs.link(temporary, this.lockPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
      const lockIdentity = await trustedIdentity(this.lockPath, 'writer lock', { surface: true, kind: 'file' });
      if (!lockIdentity) throw new Error('ManifestMismatch: writer lock identity is unavailable');
      this.fenceIdentity = lockIdentity;
      await this.fsyncDir(this.kernelDir);
      return true;
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async inspectWriterReclaimMarker(): Promise<WriterReclaimMarkerObservation> {
    try { return await inspectWriterReclaimMarker(`${this.lockPath}.reclaim`, 'writer lock reclaim marker'); }
    catch (error) {
      const message = (error as Error).message.replace(/^ReleaseExclusion:\s*/, '').replace(/^FilesystemTrust:\s*/, '');
      throw new Error(`ManifestMismatch: ${message}`);
    }
  }

  private async removeStaleWriterReclaimMarker(observation: WriterReclaimMarkerObservation): Promise<boolean> {
    try { return await removeStaleWriterReclaimMarker(`${this.lockPath}.reclaim`, observation, 'writer lock reclaim marker'); }
    catch (error) {
      const message = (error as Error).message.replace(/^ReleaseExclusion:\s*/, '').replace(/^FilesystemTrust:\s*/, '');
      throw new Error(`ManifestMismatch: ${message}`);
    }
  }

  private async tryAcquireWriterReclaimMarker(): Promise<WriterReclaimMarkerClaim | undefined> {
    try { return await tryAcquireWriterReclaimMarker(`${this.lockPath}.reclaim`, 'writer lock reclaim marker'); }
    catch (error) {
      const message = (error as Error).message.replace(/^ReleaseExclusion:\s*/, '').replace(/^FilesystemTrust:\s*/, '');
      throw new Error(`ManifestMismatch: ${message}`);
    }
  }

  private async classifyFenceOwner(): Promise<FenceOwnerState> {
    this.staleFenceObservation = undefined;
    let lockStat;
    try { lockStat = await fs.lstat(this.lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'RETRY'; throw error; }
    if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error('ManifestMismatch: writer lock is not a regular file');
    let lockText: string;
    try { lockText = await this.readRegular(this.lockPath, 'writer lock'); }
    catch (error) {
      // A disappearing lock is an ordinary owner transition. Trust-boundary
      // failures remain authoritative and are never interpreted as staleness.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'RETRY';
      throw error;
    }
    let afterStat;
    try { afterStat = await fs.lstat(this.lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'RETRY'; throw error; }
    if (afterStat.isSymbolicLink() || !afterStat.isFile()) throw new Error('ManifestMismatch: writer lock is not a regular file');
    const observedIdentity = filesystemIdentity(afterStat);
    if (!sameFilesystemIdentity(filesystemIdentity(lockStat), observedIdentity)) return 'CONTENDED';
    const managedLiveness = managedLaunchOwnerLiveness(lockText);
    if (managedLiveness !== undefined) {
      if (managedLiveness === 'STALE') this.staleFenceObservation = { text: lockText, identity: observedIdentity };
      return managedLiveness;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(lockText); }
    catch { this.staleFenceObservation = { text: lockText, identity: observedIdentity }; return 'STALE'; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { this.staleFenceObservation = { text: lockText, identity: observedIdentity }; return 'STALE'; }
    const record = parsed as { pid?: number };
    if (typeof record.pid !== 'number') { this.staleFenceObservation = { text: lockText, identity: observedIdentity }; return 'STALE'; }
    // Only a canonical managed-launch owner with authenticated process-start
    // evidence may wait without bound. Invalid or merely live legacy owners
    // retain the historical bounded contention behavior and their lock bytes.
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || record.pid > MAX_PROCESS_ID) return 'CONTENDED';
    try { process.kill(record.pid, 0); return 'CONTENDED'; }
    catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') return 'CONTENDED';
      this.staleFenceObservation = { text: lockText, identity: observedIdentity };
      return 'STALE';
    }
  }

  private async unlinkClassifiedStaleFence(): Promise<FenceReclaimResult> {
    const observed = this.staleFenceObservation;
    if (!observed) return 'CONTENDED';
    let actual: string;
    try { actual = await this.readRegular(this.lockPath, 'writer lock'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'RETRY'; throw error; }
    let currentStat;
    try { currentStat = await fs.lstat(this.lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'RETRY'; throw error; }
    if (currentStat.isSymbolicLink() || !currentStat.isFile()) throw new Error('ManifestMismatch: writer lock is not a regular file');
    if (actual !== observed.text || !sameFilesystemIdentity(filesystemIdentity(currentStat), observed.identity)) return 'CONTENDED';
    await fs.unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await this.fsyncDir(this.kernelDir);
    return 'RETRY';
  }

  private async reclaimFence(): Promise<FenceReclaimResult> {
    const observedMarker = await this.inspectWriterReclaimMarker();
    if (observedMarker.state !== 'ABSENT') {
      if (observedMarker.state === 'STALE') {
        await this.removeStaleWriterReclaimMarker(observedMarker);
        return 'RETRY';
      }
      // A marker loser has no mutation authority. It may still read the lock
      // through the full trust boundary so a verified live owner is not charged
      // against the bounded reclaimer-contention budget.
      const owner = await this.classifyFenceOwner();
      if (owner === 'RETRY' || owner === 'LIVE') return owner;
      return 'CONTENDED';
    }
    const markerClaim = await this.tryAcquireWriterReclaimMarker();
    if (!markerClaim) {
      const marker = await this.inspectWriterReclaimMarker();
      if (marker.state === 'ABSENT') return 'RETRY';
      if (marker.state === 'STALE') {
        await this.removeStaleWriterReclaimMarker(marker);
        return 'RETRY';
      }
      const owner = await this.classifyFenceOwner();
      if (owner === 'RETRY' || owner === 'LIVE') return owner;
      return 'CONTENDED';
    }
    try {
      const owner = await this.classifyFenceOwner();
      if (owner === 'RETRY' || owner === 'LIVE' || owner === 'CONTENDED') return owner;
      return await this.unlinkClassifiedStaleFence();
    } finally {
      await markerClaim.release();
    }
  }

  private async acquireFence(signal?: AbortSignal): Promise<void> {
    const owner = canonicalString({ pid: process.pid, started: Date.now(), nonce: Math.random().toString(16).slice(2) });
    let contendedPolls = 0;
    while (true) {
      throwIfFileStoreAborted(signal);
      const existingMarker = await this.inspectWriterReclaimMarker();
      if (existingMarker.state !== 'ABSENT') {
        const reclaim = await this.reclaimFence();
        throwIfFileStoreAborted(signal);
        if (reclaim === 'LIVE') {
          contendedPolls = 0;
          await sleep(FENCE_POLL_MS, signal);
          continue;
        }
        contendedPolls += 1;
        await sleep(FENCE_POLL_MS, signal);
        if (contendedPolls >= MAX_FENCE_RECLAIM_CONTENTION_POLLS) break;
        continue;
      }
      if (await this.createExclusiveFence(owner)) {
        this.fenceOwner = owner;
        let markerAppeared: WriterReclaimMarkerObservation;
        try { markerAppeared = await this.inspectWriterReclaimMarker(); }
        catch (error) { await this.releaseFence(); throw error; }
        if (markerAppeared.state !== 'ABSENT') {
          await this.releaseFence();
          if (markerAppeared.state === 'STALE') await this.removeStaleWriterReclaimMarker(markerAppeared);
          contendedPolls += 1;
          await sleep(FENCE_POLL_MS, signal);
          if (contendedPolls >= MAX_FENCE_RECLAIM_CONTENTION_POLLS) break;
          continue;
        }
        if (signal?.aborted) {
          await this.releaseFence();
          throw mintFileArtifactStoreAbort();
        }
        return;
      }
      try {
        try {
          const lockStat = await fs.lstat(this.lockPath);
          if (lockStat.isSymbolicLink()) throw new Error('ManifestMismatch: writer lock is a symlink');
          if (!lockStat.isFile()) throw new Error('ManifestMismatch: writer lock is not a regular file');
        } catch (lockError) {
          if ((lockError as Error).message.startsWith('ManifestMismatch:')) throw lockError;
        }
        const reclaim = await this.reclaimFence();
        throwIfFileStoreAborted(signal);
        if (reclaim === 'RETRY') {
          contendedPolls = 0;
          continue;
        }
        if (reclaim === 'LIVE') {
          contendedPolls = 0;
          await sleep(FENCE_POLL_MS, signal);
          continue;
        }
        contendedPolls += 1;
        await sleep(FENCE_POLL_MS, signal);
        if (contendedPolls >= MAX_FENCE_RECLAIM_CONTENTION_POLLS) break;
      } catch (error) {
        throw error;
      }
    }
    throw new Error('concurrent commit fence timeout');
  }

  private async releaseFence(): Promise<void> {
    const owner = this.fenceOwner;
    const identity = this.fenceIdentity;
    this.fenceOwner = undefined;
    this.fenceIdentity = undefined;
    if (owner !== undefined) {
      if (identity !== undefined) {
        const current = await trustedIdentity(this.lockPath, 'writer lock', { surface: true, kind: 'file' });
        if (!current || !sameFilesystemIdentity(current, identity)) throw new Error('ManifestMismatch: writer lock identity changed');
      }
      let actual: string;
      try { actual = await this.readRegular(this.lockPath, 'writer lock'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (actual !== owner) throw new Error('ManifestMismatch: writer lock ownership changed');
    }
    await fs.unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await this.fsyncDir(this.kernelDir);
  }

  /** Rebind the exact root, kernel directory, and writer lock immediately
   * before launch.  The ordinary acquisition checks run before a contender may
   * wait; this second proof prevents pathname drift during that wait or during
   * the verified CURRENT read from turning a post-entry release failure into a
   * call that should have failed closed. */
  private async assertHeldFence(): Promise<void> {
    const rootIdentity = this.rootIdentity;
    const kernelIdentity = this.kernelIdentity;
    const fenceIdentity = this.fenceIdentity;
    const owner = this.fenceOwner;
    if (!rootIdentity || !kernelIdentity || !fenceIdentity || owner === undefined) throw new Error('ManifestMismatch: writer fence authority is unavailable');
    await assertStableIdentity(this.rootDir, rootIdentity, 'root directory', { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
    await assertStableIdentity(this.kernelDir, kernelIdentity, '.kernel directory', { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
    const current = await trustedIdentity(this.lockPath, 'writer lock', { surface: true, kind: 'file' });
    if (!current || !sameFilesystemIdentity(current, fenceIdentity)) throw new Error('ManifestMismatch: writer lock identity changed');
    if (await this.readRegular(this.lockPath, 'writer lock') !== owner) throw new Error('ManifestMismatch: writer lock ownership changed');
  }

  private async withFence<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    // The ancestor release marker is the common production admission gate.
    // Check before any store setup and again after the per-run writer claim:
    // either a writer is already inside (and release waits for this fence), or
    // the release marker wins and this writer cannot enter.
    throwIfFileStoreAborted(signal);
    await assertReleaseAdmissionOpen(this.rootDir);
    await this.ensure();
    throwIfFileStoreAborted(signal);
    return withProcessLock(this.kernelDir, async () => {
      throwIfFileStoreAborted(signal);
      await assertReleaseAdmissionOpen(this.rootDir);
      if (!this.rootIdentity) throw new Error('ManifestMismatch: root directory identity is unavailable');
      await assertStableIdentity(this.rootDir, this.rootIdentity, 'root directory', { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
      let acquired = false;
      try {
        await this.acquireFence(signal);
        acquired = true;
        throwIfFileStoreAborted(signal);
        await assertReleaseAdmissionOpen(this.rootDir);
        throwIfFileStoreAborted(signal);
        return await fn();
      }
      finally { if (acquired) await this.releaseFence(); }
    }, signal);
  }

  private async readCurrent(): Promise<CurrentManifest | undefined> {
    const path = join(this.kernelDir, 'CURRENT');
    let text: string;
    try { text = await this.readRegular(path, 'CURRENT', CURRENT_BYTE_CEILING); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    try {
      const parsed = parseCanonical<unknown>(text);
      return validateCurrent(parsed);
    } catch (error) {
      if ((error as Error).message.startsWith('ManifestMismatch:')) throw error;
      throw new Error(`ManifestMismatch: CURRENT is malformed: ${(error as Error).message}`);
    }
  }

  private uniqueQuarantineName(name: string): string { return `${name}-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`; }

  private async quarantineOrphans(currentGeneration?: number, retainHistory = false): Promise<void> {
    // Validate every candidate before moving any one of them.  In particular,
    // a malformed CURRENT or a trust failure in a sibling must never turn
    // recovery into a partially-mutating cleanup pass.
    const entries = await this.readDirectoryBounded(this.generationsDir, 'generations directory', JOURNAL_EVENT_CEILING + 1);
    const predecessorGeneration = currentGeneration !== undefined && currentGeneration > 1 ? currentGeneration - 1 : undefined;
    const moves: Array<{ name: string; path: string }> = [];
    for (const entry of entries) {
      const match = /^g(\d+)$/.exec(entry.name);
      const isTmp = entry.name.includes('.tmp');
      const candidate = match ? Number(match[1]) : undefined;
      const canonical = candidate !== undefined && Number.isSafeInteger(candidate) && candidate > 0 && entry.name === `g${candidate}`;
      // During segmented recovery retain only committed history at or below
      // CURRENT. A future canonical gN is an interrupted successor (the
      // common crash window after generation rename and before CURRENT); it
      // must be quarantined so the next retry can stage the same generation.
      const keep = Boolean(canonical && (candidate === currentGeneration || (retainHistory && currentGeneration !== undefined && candidate < currentGeneration) || (!retainHistory && candidate === predecessorGeneration)));
      if (keep) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`ManifestMismatch: retained generation ${entry.name} is not a directory`);
        await this.assertDirectory(join(this.generationsDir, entry.name), `retained generation ${entry.name}`);
      }
      if (!keep && (isTmp || match)) {
        // Never quarantine an object whose ownership/mode/ancestor chain is
        // outside the trusted store boundary.  In particular, a forged
        // replacement must fail before rename mutates either pathname.
        if (entry.isDirectory() && !entry.isSymbolicLink()) await this.assertDirectory(join(this.generationsDir, entry.name), `generation candidate ${entry.name}`);
        else if (entry.isFile()) await this.assertRegular(join(this.generationsDir, entry.name), `generation candidate ${entry.name}`);
        else throw new Error(`ManifestMismatch: generation candidate ${entry.name} is not a trusted file or directory`);
        moves.push({ name: entry.name, path: join(this.generationsDir, entry.name) });
      } else if (!keep) throw new Error(`ManifestMismatch: unexpected generations entry ${entry.name}`);
    }
    const kernelEntries = await this.readDirectoryBounded(this.kernelDir, 'kernel directory', JOURNAL_EVENT_CEILING + 64);
    for (const entry of kernelEntries) {
      if (!entry.name.startsWith('.CURRENT.tmp-')) continue;
      // A staged CURRENT is not authority until the final rename.  It is
      // still untrusted input, however: validate ownership, mode, ancestry,
      // and regular-file type before moving it into quarantine so recovery
      // never mutates an attacker-selected replacement first.
      await this.assertRegular(join(this.kernelDir, entry.name), `staged CURRENT ${entry.name}`);
      moves.push({ name: entry.name, path: join(this.kernelDir, entry.name) });
    }
    const quarantine = await this.ensureQuarantine(this.kernelDir);
    for (const move of moves) await fs.rename(move.path, join(quarantine, this.uniqueQuarantineName(move.name)));
  }

  private async readVerifiedGenerationIdentities(generation: number): Promise<Pick<VerifiedGenerationMemo, 'proof' | 'stat'>> {
    const generationDir = join(this.generationsDir, `g${generation}`);
    const statePath = join(generationDir, 'state.json');
    const journalPath = join(generationDir, 'journal.ndjson');
    const paths = {
      current: { path: join(this.kernelDir, 'CURRENT'), label: 'CURRENT', kind: 'file' as const },
      generations: { path: this.generationsDir, label: 'generations directory', kind: 'directory' as const },
      generation: { path: generationDir, label: `generation ${generation}`, kind: 'directory' as const },
      state: { path: statePath, label: `generation ${generation} state`, kind: 'file' as const },
      journal: { path: journalPath, label: `generation ${generation} journal`, kind: 'file' as const },
    } as const;
    const inspect = async (path: string, label: string, kind: 'file' | 'directory') => {
      const trusted = await inspectTrustedPath(path, label, { surface: true, kind });
      if (!trusted) throw new Error('ManifestMismatch: verified generation identity is unavailable');
      return { identity: trusted.identity, stat: Object.freeze({ size: trusted.stat.size, mtimeMs: trusted.stat.mtimeMs, ctimeMs: trusted.stat.ctimeMs }) };
    };
    try {
      const [current, generations, generationIdentity, state, journal] = await Promise.all([
        inspect(paths.current.path, paths.current.label, paths.current.kind),
        inspect(paths.generations.path, paths.generations.label, paths.generations.kind),
        inspect(paths.generation.path, paths.generation.label, paths.generation.kind),
        inspect(paths.state.path, paths.state.label, paths.state.kind),
        inspect(paths.journal.path, paths.journal.label, paths.journal.kind),
      ]);
      return Object.freeze({
        proof: Object.freeze({ current: current.identity, generations: generations.identity, generation: generationIdentity.identity, state: state.identity, journal: journal.identity }),
        stat: Object.freeze({ current: current.stat, generations: generations.stat, generation: generationIdentity.stat, state: state.stat, journal: journal.stat }),
      });
    } catch (error) {
      if ((error as Error).message.startsWith('ManifestMismatch:')) throw error;
      throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`);
    }
  }

  /** Capture only after the complete verifier has succeeded.  The two small
   * CURRENT/identity passes close the capture window without rereading state
   * or journal payloads. */
  private async captureVerifiedGenerationMemo(current: CurrentManifest, state: MachineState): Promise<VerifiedGenerationMemo> {
    const canonicalCurrent = canonicalString(current);
    const before = await this.readCurrent();
    if (!before || canonicalString(before) !== canonicalCurrent) throw new Error('ManifestMismatch: CURRENT changed while capturing verified generation');
    const first = await this.readVerifiedGenerationIdentities(current.generation);
    const after = await this.readCurrent();
    if (!after || canonicalString(after) !== canonicalCurrent) throw new Error('ManifestMismatch: CURRENT changed while capturing verified generation');
    const second = await this.readVerifiedGenerationIdentities(current.generation);
    for (const key of ['current', 'generations', 'generation', 'state', 'journal'] as const) {
      if (!sameFilesystemIdentity(first.proof[key], second.proof[key])) throw new Error(`ManifestMismatch: verified ${key} identity changed while capturing generation`);
      if (first.stat[key].size !== second.stat[key].size || first.stat[key].mtimeMs !== second.stat[key].mtimeMs || first.stat[key].ctimeMs !== second.stat[key].ctimeMs) throw new Error(`ManifestMismatch: verified ${key} stat changed while capturing generation`);
    }
    return Object.freeze({ generation: current.generation, current: canonicalCurrent, authorityAnchors: managedAuthorityAnchors(state), proof: second.proof, stat: second.stat });
  }

  private verifiedGenerationMemoShape(value: unknown): value is VerifiedGenerationMemo {
    if (!value || typeof value !== 'object') return false;
    const memo = value as Record<string, unknown>;
    if (Object.keys(memo).sort().join(',') !== 'authorityAnchors,current,generation,proof,stat') return false;
    if (!Number.isSafeInteger(memo.generation) || (memo.generation as number) <= 0 || typeof memo.current !== 'string' || memo.current.length === 0 || Buffer.byteLength(memo.current, 'utf8') > CURRENT_BYTE_CEILING) return false;
    try {
      const current = parseCanonical<unknown>(memo.current);
      const validated = validateCurrent(current);
      if (validated.generation !== memo.generation || canonicalString(validated) !== memo.current) return false;
    } catch { return false; }
    if (!memo.authorityAnchors || typeof memo.authorityAnchors !== 'object') return false;
    const anchors = memo.authorityAnchors as Record<string, unknown>;
    if (Object.keys(anchors).sort().join(',') !== 'attempts,reports') return false;
    for (const field of ['attempts', 'reports'] as const) {
      const rows = anchors[field];
      if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return false;
      for (const [key, value] of Object.entries(rows as Record<string, unknown>)) {
        if (typeof key !== 'string' || key.length === 0 || typeof value !== 'string') return false;
        try { if (canonicalString(parseCanonical<Ref>(value)) !== value) return false; } catch { return false; }
      }
    }
    if (!memo.proof || typeof memo.proof !== 'object') return false;
    const proof = memo.proof as Record<string, unknown>;
    if (Object.keys(proof).sort().join(',') !== 'current,generation,generations,journal,state') return false;
    for (const key of ['current', 'generations', 'generation', 'state', 'journal'] as const) {
      const identity = proof[key];
      if (!identity || typeof identity !== 'object') return false;
      const value = identity as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'dev,ino' || typeof value.dev !== 'string' || value.dev.length === 0 || typeof value.ino !== 'string' || value.ino.length === 0) return false;
    }
    if (!memo.stat || typeof memo.stat !== 'object') return false;
    const stat = memo.stat as Record<string, unknown>;
    if (Object.keys(stat).sort().join(',') !== 'current,generation,generations,journal,state') return false;
    for (const key of ['current', 'generations', 'generation', 'state', 'journal'] as const) {
      const value = stat[key];
      if (!value || typeof value !== 'object') return false;
      const fields = value as Record<string, unknown>;
      if (Object.keys(fields).sort().join(',') !== 'ctimeMs,mtimeMs,size' || !Number.isSafeInteger(fields.size) || (fields.size as number) < 0 || typeof fields.mtimeMs !== 'number' || !Number.isFinite(fields.mtimeMs) || typeof fields.ctimeMs !== 'number' || !Number.isFinite(fields.ctimeMs)) return false;
    }
    return true;
  }

  /** Probe only the small CURRENT manifest, kernel namespace, and captured path identities. */
  private async probeVerifiedGenerationMemo(value: unknown, expectedGeneration: number): Promise<boolean> {
    try {
      if (!this.verifiedGenerationMemoShape(value)) return false;
      const memo = value;
      if (memo.generation !== expectedGeneration) return false;
      const current = await this.readCurrent();
      if (!current || canonicalString(current) !== memo.current) return false;
      // A staged CURRENT is disposable recovery material that is not covered
      // by the five captured predecessor paths.  Enumerate the kernel
      // namespace without mutating it so the unchanged cold verifier owns
      // quarantine/rejection and its original error ordering.
      const kernelEntries = await this.readDirectoryBounded(this.kernelDir, 'kernel directory', JOURNAL_EVENT_CEILING + 64);
      if (kernelEntries.some((entry) => entry.name.startsWith('.CURRENT.tmp-'))) return false;
      // `quarantineOrphans()` validates/creates this recovery destination on
      // every cold read.  A memo hit must prove only that the existing
      // destination remains trusted; it must never create, chmod, or otherwise
      // mutate the path from the probe.  Missing or unsafe paths deliberately
      // fall through to the unchanged cold verifier for historical ordering.
      await this.assertDirectory(join(this.kernelDir, 'quarantine'), 'quarantine directory');
      // `quarantineOrphans()` also validates the exact retained predecessor
      // before any disposable cleanup.  Preserve that historical diagnostic
      // ordering without inspecting its children (retirement remains their
      // pre-publication owner).
      if (memo.generation > 1) {
        const predecessorGeneration = memo.generation - 1;
        await this.assertDirectory(join(this.generationsDir, `g${predecessorGeneration}`), `retained generation g${predecessorGeneration}`);
      }
      const proof = await this.readVerifiedGenerationIdentities(current.generation);
      for (const key of ['current', 'generations', 'generation', 'state', 'journal'] as const) {
        if (!sameFilesystemIdentity(memo.proof[key], proof.proof[key])) return false;
        if (memo.stat[key].size !== proof.stat[key].size || memo.stat[key].mtimeMs !== proof.stat[key].mtimeMs || memo.stat[key].ctimeMs !== proof.stat[key].ctimeMs) return false;
      }
      return true;
    } catch { return false; }
  }

  /** Verify a segmented generation before any state/effect use.  Segments are
   * immutable canonical NDJSON files named by their revision range; the head
   * is the sole authority for ordering, digest chaining, and the bounded active
   * suffix. */
  private async readVerifiedSegmentedGeneration(current: CurrentManifest): Promise<{ state: MachineState; head: SegmentedHead | SegmentedHeadV2 }> {
    const generationDir = join(this.generationsDir, `g${current.generation}`);
    const statePath = join(generationDir, 'state.json');
    const headPath = join(generationDir, 'head.json');
    let stateText: string; let headText: string;
    try {
      await this.assertDirectory(generationDir, `generation ${current.generation}`);
      await this.assertRegular(statePath, `generation ${current.generation} state`);
      await this.assertRegular(headPath, `generation ${current.generation} head`);
      [stateText, headText] = await Promise.all([
        this.readRegular(statePath, `generation ${current.generation} state`),
        this.readRegular(headPath, `generation ${current.generation} head`, CURRENT_BYTE_CEILING),
      ]);
    } catch (error) { throw new Error(`ManifestMismatch: CURRENT segmented generation ${current.generation} is incomplete: ${(error as Error).message}`); }
    const v2 = current.format === 'segmented/v2';
    let state: MachineState; let head: SegmentedHead | SegmentedHeadV2;
    try {
      const parsed = parseCanonical<Record<string, unknown>>(stateText);
      if (v2) {
        // v2 keeps the journal exclusively in authenticated segment files;
        // state.json is a projection with the same schema minus `journal`.
        const stateKeys = Object.keys(parsed).sort();
        const expected = ['attemptEpoch', 'authorityEpoch', 'barrier', 'barrierEpoch', 'decisionTokens', 'gate', 'modeEpoch', 'nextAction', 'outbox', 'phaseId', 'planDigest', 'processed', 'revision', 'runId', 'schema', 'status', 'steps', 'writerFence', ...(parsed.schema === 2 ? ['managed'] : [])].sort();
        invariant(stateKeys.length === expected.length && stateKeys.every((key, index) => key === expected[index]), 'segmented v2 state fields are invalid');
        state = parsed as unknown as MachineState;
        state.journal = [];
      } else state = parsed as MachineState;
      validateStateShape(state);
    } catch (error) { throw new Error(`ManifestMismatch: segmented state is invalid: ${(error as Error).message}`); }
    try { head = v2 ? validateSegmentedHeadV2(parseCanonical<unknown>(headText)) : validateSegmentedHead(parseCanonical<unknown>(headText)); }
    catch (error) { throw new Error(`ManifestMismatch: segmented head is invalid: ${(error as Error).message}`); }
    // The active suffix ceiling is part of the signed head, so a reader may
    // inspect a run created with a non-default ceiling without guessing the
    // writer's private constructor options.
    invariant(head.active.endRevision - head.active.startRevision + 1 <= head.activeCeiling, 'segmented active suffix exceeds head bound');
    invariant(head.generation === current.generation && head.runId === state.runId && head.phaseId === state.phaseId && head.writerFence === state.writerFence, 'segmented head identity disagrees with state');
    const descriptors = [...head.segments, head.active];
    const generationEntries = await this.readDirectoryBounded(generationDir, `generation ${current.generation}`, descriptors.length + 2);
    const expectedNames = new Set(['state.json', 'head.json', ...descriptors.map((descriptor) => descriptor.name)]);
    invariant(generationEntries.length === expectedNames.size && generationEntries.every((entry) => !entry.isSymbolicLink() && expectedNames.has(entry.name)), 'segmented generation contains unexpected files');
    const entries: Array<Record<string, unknown>> = [];
    for (const descriptor of descriptors) {
      const path = join(generationDir, descriptor.name);
      if (descriptor.name.includes('/') || descriptor.name.includes('\\') || descriptor.name.startsWith('.') || !/^segment-\d+-\d+\.ndjson$/.test(descriptor.name)) throw new Error('ManifestMismatch: segmented segment path is unsafe');
      const text = await this.readRegular(path, `segmented ${descriptor.name}`, JOURNAL_BYTE_CEILING * 16);
      invariant(Buffer.byteLength(text) === descriptor.bytes, `segmented ${descriptor.name} byte count mismatch`);
      invariant(digest(text) === descriptor.digest, `segmented ${descriptor.name} digest mismatch`);
      const parsedLines = text.length === 0 ? [] : text.split('\n');
      if (parsedLines.at(-1) === '') parsedLines.pop();
      invariant(parsedLines.length === descriptor.endRevision - descriptor.startRevision + 1, `segmented ${descriptor.name} range mismatch`);
      for (const line of parsedLines) {
        let entry: Record<string, unknown>;
        try { entry = parseCanonical<Record<string, unknown>>(line); } catch { throw new Error(`ManifestMismatch: segmented ${descriptor.name} record is not canonical JSON`); }
        entries.push(entry);
      }
    }
    const journalText = segmentBytes(entries);
    if (v2) state.journal = entries as unknown as MachineState['journal'];
    validateJournal(state, journalText, { segmented: true });
    invariant(state.revision === head.revision && state.journal.length === head.journalEnd, 'segmented state revision disagrees with head');
    invariant(digest(state) === current.stateDigest && digest(state.journal) === current.journalDigest, 'segmented state digest mismatch');
    invariant(current.revision === head.revision && current.journalEnd === head.journalEnd && current.checkpointRevision === head.checkpointRevision && current.headDigest === digest(head), 'segmented CURRENT disagrees with head');
    // CURRENT is a compact CAS pointer, not an independent authority.  Bind
    // every continuity field to the fully verified state/head before exposing
    // the generation or allowing a successor commit.  Legacy verification
    // performs the same state comparison; segmented format must not weaken it.
    for (const [field, value] of Object.entries({
      writerFence: state.writerFence,
      authorityEpoch: state.authorityEpoch,
      attemptEpoch: state.attemptEpoch,
      barrierEpoch: state.barrierEpoch,
      modeEpoch: state.modeEpoch,
    })) invariant(current[field as keyof CurrentManifest] === value, `segmented CURRENT ${field} disagrees with state`);
    invariant(current.segmentCount === descriptors.length, 'segmented CURRENT segmentCount disagrees with head');
    invariant(current.activeCeiling === head.activeCeiling, 'segmented CURRENT activeCeiling disagrees with head');
    invariant(head.checkpointDigest === digest(entries.slice(0, head.checkpointRevision)), 'segmented checkpoint digest mismatch');
    return { state, head };
  }

  private async readVerifiedCurrent(includeCurrent = false): Promise<VerifiedCurrentResult> {
    let current: CurrentManifest | undefined;
    current = await this.readCurrent();
    if (!current) {
      // A brand-new root has no generation yet.  Once a generation exists,
      // however, a missing CURRENT is durable-manifest corruption rather than
      // permission to start a fresh run (which could replay an external
      // effect).  Do not mutate canonical generations on this failure.
      const generations = await this.readDirectoryBounded(this.generationsDir, 'generations directory', JOURNAL_EVENT_CEILING + 1);
      const hasCommittedGeneration = generations.some((entry) => /^g\d+$/.test(entry.name));
      if (hasCommittedGeneration) throw new Error('ManifestMismatch: CURRENT is missing while a committed generation exists');
      // A genuinely fresh root may still establish the disposable quarantine
      // surface (and move only staged debris); no canonical generation exists
      // to mutate, and this preserves the historical empty-quarantine shape.
      await this.quarantineOrphans(undefined);
      return { state: undefined, generation: 0 };
    }
    if (current.format === 'segmented/v1' || current.format === 'segmented/v2') {
      const verified = await this.readVerifiedSegmentedGeneration(current);
      await this.quarantineOrphans(current.generation, true);
      return includeCurrent ? { state: verified.state, generation: current.generation, current } : { state: verified.state, generation: current.generation };
    }
    const generationDir = join(this.generationsDir, `g${current.generation}`);
    const statePath = join(generationDir, 'state.json');
    const journalPath = join(generationDir, 'journal.ndjson');
    let stateText: string; let journalText: string;
    try {
      await this.assertDirectory(generationDir, `generation ${current.generation}`);
      await this.assertRegular(statePath, `generation ${current.generation} state`);
      await this.assertRegular(journalPath, `generation ${current.generation} journal`);
      const generationEntries = await this.readDirectoryBounded(generationDir, `generation ${current.generation}`, 2);
      const generationNames = generationEntries.map((entry) => entry.name);
      invariant(generationNames.length === 2 && generationNames.includes('state.json') && generationNames.includes('journal.ndjson'), 'generation contains unexpected files');
      [stateText, journalText] = await Promise.all([this.readRegular(statePath, `generation ${current.generation} state`), this.readRegular(journalPath, `generation ${current.generation} journal`, JOURNAL_BYTE_CEILING)]);
    } catch (error) { throw new Error(`ManifestMismatch: CURRENT generation ${current.generation} is incomplete: ${(error as Error).message}`); }
    let state: MachineState;
    try { state = parseCanonical<MachineState>(stateText); }
    catch (error) { throw new Error(`ManifestMismatch: state is not canonical JSON: ${(error as Error).message}`); }
    try {
      validateStateShape(state);
      validateJournal(state, journalText);
      invariant(digest(state) === current.stateDigest, 'state digest mismatch');
      invariant(digest(state.journal) === current.journalDigest, 'journal digest mismatch');
      invariant(current.journalEnd === state.journal.length, 'journalEnd does not match journal length');
      for (const [field, value] of Object.entries({ revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, modeEpoch: state.modeEpoch, writerFence: state.writerFence })) invariant(current[field as keyof CurrentManifest] === value, `CURRENT ${field} disagrees with state`);
    } catch (error) {
      if ((error as Error).message.startsWith('ManifestMismatch:')) throw error;
      throw new Error(`ManifestMismatch: ${(error as Error).message}`);
    }
    // The current generation is fully verified before any namespace mutation.
    // Retain the exact immediate predecessor for the next pre-stage prune;
    // all other trusted-looking debris is disposable quarantine material.
    await this.quarantineOrphans(current.generation);
    return includeCurrent ? { state, generation: current.generation, current } : { state, generation: current.generation };
  }

  /**
   * Retire only the exact sequential predecessor of CURRENT.  The directory
   * is disposable, but its pathname is still inside the trust boundary: prove
   * the parent, directory, and every child before unlinking anything.  A
   * missing or already-partially-retired predecessor is an idempotent
   * success; symlinks, unexpected children, identity drift, and unsafe modes
   * fail closed before the next generation can be staged.
   */
  private async retirePredecessor(currentGeneration: number): Promise<void> {
    const predecessorGeneration = currentGeneration - 1;
    if (predecessorGeneration <= 0) return;
    let generationsIdentity: FilesystemIdentity | undefined;
    try { generationsIdentity = await trustedIdentity(this.generationsDir, 'generations directory', { surface: true, kind: 'directory' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!generationsIdentity) throw new Error('ManifestMismatch: generations directory is absent');
    const generationPath = join(this.generationsDir, `g${predecessorGeneration}`);
    const generation = await inspectTrustedPath(generationPath, `predecessor generation ${predecessorGeneration}`, { allowMissing: true, surface: true, kind: 'directory' }).catch((error) => {
      throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`);
    });
    if (!generation) return;
    const generationIdentity = generation.identity;
    const entries = await this.readDirectoryBounded(generationPath, `predecessor generation ${predecessorGeneration}`, JOURNAL_EVENT_CEILING + 2);
    // A rollback successor may intentionally retain a segmented predecessor;
    // legacy retirement owns only the historical two-file generation shape.
    if (entries.some((entry) => entry.name === 'head.json' || entry.name.startsWith('segment-'))) return;
    const children: Array<{ path: string; identity: FilesystemIdentity }> = [];
    for (const entry of entries) {
      if (entry.name !== 'state.json' && entry.name !== 'journal.ndjson') throw new Error(`ManifestMismatch: predecessor generation contains unexpected file ${entry.name}`);
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`ManifestMismatch: predecessor ${entry.name} is not a regular file`);
      const childPath = join(generationPath, entry.name);
      await this.assertRegular(childPath, `predecessor ${entry.name}`);
      const childIdentity = await trustedIdentity(childPath, `predecessor ${entry.name}`, { surface: true, kind: 'file' });
      if (!childIdentity) throw new Error(`ManifestMismatch: predecessor ${entry.name} is absent`);
      children.push({ path: childPath, identity: childIdentity });
    }
    await assertStableIdentity(this.generationsDir, generationsIdentity, 'generations directory', { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
    await assertStableIdentity(generationPath, generationIdentity, `predecessor generation ${predecessorGeneration}`, { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
    for (const child of children) {
      let bound;
      try { bound = await inspectTrustedPath(child.path, 'predecessor child', { allowMissing: true, surface: true, kind: 'file' }); }
      catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
      if (!bound) continue;
      if (!sameFilesystemIdentity(bound.identity, child.identity)) throw new Error('ManifestMismatch: predecessor child changed before deletion');
      try { await fs.unlink(child.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await assertStableIdentity(this.generationsDir, generationsIdentity, 'generations directory', { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
    await assertStableIdentity(generationPath, generationIdentity, `predecessor generation ${predecessorGeneration}`, { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
    try { await fs.rmdir(generationPath); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') throw new Error(`ManifestMismatch: predecessor generation ${predecessorGeneration} is not empty`);
      throw error;
    }
  }

  /**
   * Read one committed generation without entering the writer/recovery path.
   * Unlike `load()`, this method deliberately does not create directories,
   * acquire a filesystem lock, quarantine staged generations, reconcile cache
   * pins, or otherwise mutate the run tree. It is the trust boundary for
   * read-only managed inspection.
   */
  private async readVerifiedCurrentNoMutation(): Promise<VerifiedReadOnlySnapshot> {
    const currentPath = join(this.kernelDir, 'CURRENT');
    let currentIdentity: FilesystemIdentity | undefined;
    try { currentIdentity = await trustedIdentity(currentPath, 'CURRENT', { surface: true, kind: 'file' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!currentIdentity) throw new Error('ManifestMismatch: CURRENT is absent');
    const current = await this.readCurrent();
    if (!current) throw new Error('ManifestMismatch: CURRENT is absent');
    // Bind the generation namespace itself, not only the individual files.
    // A concurrent pathname replacement with another private directory could
    // otherwise present a self-consistent but different gN while CURRENT's
    // inode remains unchanged.  Read-only inspection has no recovery action,
    // so any namespace identity drift fails closed.
    let generationsIdentity: FilesystemIdentity | undefined;
    try { generationsIdentity = await trustedIdentity(this.generationsDir, 'generations directory', { surface: true, kind: 'directory' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!generationsIdentity) throw new Error('ManifestMismatch: generations directory is absent');
    await this.validateReadOnlyNamespace(current.generation);
    if (current.format === 'segmented/v1' || current.format === 'segmented/v2') {
      const verified = await this.readVerifiedSegmentedGeneration(current);
      const generationDir = join(this.generationsDir, `g${current.generation}`);
      const generationIdentity = await trustedIdentity(generationDir, `generation ${current.generation}`, { surface: true, kind: 'directory' });
      const stateIdentity = await trustedIdentity(join(generationDir, 'state.json'), 'segmented state', { surface: true, kind: 'file' });
      const headIdentity = await trustedIdentity(join(generationDir, 'head.json'), 'segmented head', { surface: true, kind: 'file' });
      if (!generationIdentity || !stateIdentity || !headIdentity) throw new Error('ManifestMismatch: segmented generation identity is unavailable');
      const afterIdentity = await trustedIdentity(currentPath, 'CURRENT', { surface: true, kind: 'file' });
      if (!afterIdentity || !sameFilesystemIdentity(currentIdentity, afterIdentity)) throw new Error('ManifestMismatch: CURRENT changed during read');
      const after = await this.readCurrent();
      if (!after || canonicalString(after) !== canonicalString(current)) throw new Error('ManifestMismatch: CURRENT changed during read');
      return { state: verified.state, generation: current.generation, current, proof: { current: afterIdentity, generations: generationsIdentity, generation: generationIdentity, state: stateIdentity, journal: headIdentity } };
    }
    const generationDir = join(this.generationsDir, `g${current.generation}`);
    const statePath = join(generationDir, 'state.json');
    const journalPath = join(generationDir, 'journal.ndjson');
    let stateText: string; let journalText: string;
    let generationIdentity: FilesystemIdentity | undefined;
    let stateIdentity: FilesystemIdentity | undefined;
    let journalIdentity: FilesystemIdentity | undefined;
    try {
      await this.assertDirectory(generationDir, `generation ${current.generation}`);
      generationIdentity = await trustedIdentity(generationDir, `generation ${current.generation}`, { surface: true, kind: 'directory' });
      if (!generationIdentity) throw new Error(`ManifestMismatch: generation ${current.generation} is absent`);
      await this.assertRegular(statePath, `generation ${current.generation} state`);
      await this.assertRegular(journalPath, `generation ${current.generation} journal`);
      stateIdentity = await trustedIdentity(statePath, `generation ${current.generation} state`, { surface: true, kind: 'file' });
      journalIdentity = await trustedIdentity(journalPath, `generation ${current.generation} journal`, { surface: true, kind: 'file' });
      if (!stateIdentity || !journalIdentity) throw new Error(`ManifestMismatch: generation ${current.generation} files are absent`);
      const generationEntries = await this.readDirectoryBounded(generationDir, `generation ${current.generation}`, 2);
      const generationNames = generationEntries.map((entry) => entry.name);
      invariant(generationNames.length === 2 && generationNames.includes('state.json') && generationNames.includes('journal.ndjson'), 'generation contains unexpected files');
      [stateText, journalText] = await Promise.all([
        this.readRegular(statePath, `generation ${current.generation} state`, READ_ONLY_STATE_BYTE_CEILING),
        this.readRegular(journalPath, `generation ${current.generation} journal`, JOURNAL_BYTE_CEILING),
      ]);
    } catch (error) {
      throw new Error(`ManifestMismatch: CURRENT generation ${current.generation} is incomplete: ${(error as Error).message}`);
    }
    let state: MachineState;
    try { state = parseCanonical<MachineState>(stateText); }
    catch (error) { throw new Error(`ManifestMismatch: state is not canonical JSON: ${(error as Error).message}`); }
    try {
      validateStateShape(state);
      validateJournal(state, journalText);
      invariant(digest(state) === current.stateDigest, 'state digest mismatch');
      invariant(digest(state.journal) === current.journalDigest, 'journal digest mismatch');
      invariant(current.journalEnd === state.journal.length, 'journalEnd does not match journal length');
      for (const [field, value] of Object.entries({ revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, modeEpoch: state.modeEpoch, writerFence: state.writerFence })) invariant(current[field as keyof CurrentManifest] === value, `CURRENT ${field} disagrees with state`);
    } catch (error) {
      if ((error as Error).message.startsWith('ManifestMismatch:')) throw error;
      throw new Error(`ManifestMismatch: ${(error as Error).message}`);
    }
    let afterGenerationIdentity: FilesystemIdentity | undefined;
    let afterGenerationsIdentity: FilesystemIdentity | undefined;
    let afterStateIdentity: FilesystemIdentity | undefined;
    let afterJournalIdentity: FilesystemIdentity | undefined;
    try {
      afterGenerationIdentity = await trustedIdentity(generationDir, `generation ${current.generation}`, { surface: true, kind: 'directory' });
      afterGenerationsIdentity = await trustedIdentity(this.generationsDir, 'generations directory', { surface: true, kind: 'directory' });
      afterStateIdentity = await trustedIdentity(statePath, `generation ${current.generation} state`, { surface: true, kind: 'file' });
      afterJournalIdentity = await trustedIdentity(journalPath, `generation ${current.generation} journal`, { surface: true, kind: 'file' });
    } catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!afterGenerationIdentity || !generationIdentity || !sameFilesystemIdentity(generationIdentity, afterGenerationIdentity)) throw new Error('ManifestMismatch: committed generation changed during read');
    if (!afterGenerationsIdentity || !sameFilesystemIdentity(generationsIdentity, afterGenerationsIdentity)) throw new Error('ManifestMismatch: generations directory changed during read');
    if (!afterStateIdentity || !stateIdentity || !sameFilesystemIdentity(stateIdentity, afterStateIdentity)) throw new Error('ManifestMismatch: committed state changed during read');
    if (!afterJournalIdentity || !journalIdentity || !sameFilesystemIdentity(journalIdentity, afterJournalIdentity)) throw new Error('ManifestMismatch: committed journal changed during read');
    let afterIdentity: FilesystemIdentity | undefined;
    try { afterIdentity = await trustedIdentity(currentPath, 'CURRENT', { surface: true, kind: 'file' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!afterIdentity || !sameFilesystemIdentity(currentIdentity, afterIdentity)) throw new Error('ManifestMismatch: CURRENT changed during read');
    const after = await this.readCurrent();
    if (!after || canonicalString(after) !== canonicalString(current)) throw new Error('ManifestMismatch: CURRENT changed during read');
    return { state, generation: current.generation, current, proof: { current: afterIdentity, generations: afterGenerationsIdentity, generation: afterGenerationIdentity, state: afterStateIdentity, journal: afterJournalIdentity } };
  }

  private async readManagedRuntimeMetadata(): Promise<ManagedRuntimeMetadata> {
    const tombstonePath = join(this.kernelDir, 'BRIDGE.DELETED');
    let tombstone;
    try { tombstone = await inspectTrustedPath(tombstonePath, 'bridge tombstone', { allowMissing: true, surface: true, kind: 'file' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (tombstone) throw new Error('ManifestMismatch: runtime bridge metadata was deleted');
    const manifestPath = join(this.kernelDir, 'BRIDGE.json');
    let text: string;
    try { text = await this.readRegular(manifestPath, 'bridge manifest', MANAGED_METADATA_BYTE_CEILING); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('ManifestMismatch: runtime bridge manifest is absent'); throw error; }
    let value: unknown;
    try { value = parseCanonical(text); }
    catch (error) { throw new Error(`ManifestMismatch: bridge manifest is not canonical: ${(error as Error).message}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ManifestMismatch: bridge manifest is invalid');
    const object = value as Record<string, unknown>;
    exactKeys(object, ['bridgeVersion', 'mode', 'planDigest', 'rootPath', 'runId', 'phaseId', 'runtimeVersion', 'schema', 'sourceDigest', 'status'], 'bridge manifest');
    if (object.schema !== 1 || object.mode !== 'runtime' || object.status !== 'enabled') throw new Error('ManifestMismatch: runtime bridge is not enabled');
    for (const field of ['bridgeVersion', 'runtimeVersion', 'runId', 'phaseId', 'rootPath', 'planDigest', 'sourceDigest']) if (typeof object[field] !== 'string' || String(object[field]).length === 0) throw new Error(`ManifestMismatch: bridge manifest ${field} is invalid`);
    if (!SHA256.test(String(object.planDigest)) || !SHA256.test(String(object.sourceDigest))) throw new Error('ManifestMismatch: bridge manifest digest is invalid');
    if (String(object.sourceDigest) !== digest(BRIDGE_SOURCE_ID)) throw new Error('ManifestMismatch: bridge manifest source digest is not this managed bridge');
    if (!isAbsolute(String(object.rootPath)) || resolve(String(object.rootPath)) !== String(object.rootPath) || String(object.rootPath) !== this.rootDir) throw new Error('ManifestMismatch: bridge manifest root path differs from run root');
    return object as ManagedRuntimeMetadata;
  }

  /**
   * Acquire a verified immutable CURRENT generation and managed-runtime
   * identity without touching any filesystem bytes. State and journal receive
   * one complete validation pass; exact manifests and filesystem identities
   * are rebound after metadata so adoption or pointer replacement cannot
   * produce a mixed-generation success.
   */
  async loadReadOnly(expectedRunId?: string): Promise<ReadOnlyStoreSnapshot> {
    let root;
    try { root = await inspectTrustedPath(this.rootDir, 'root directory', { surface: true, kind: 'directory' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!root) throw new Error('ManifestMismatch: root directory is absent');
    if (this.expectedRootIdentity && !sameFilesystemIdentity(this.expectedRootIdentity, root.identity)) throw new Error('ManifestMismatch: locked root directory identity changed');
    let kernel;
    try { kernel = await inspectTrustedPath(this.kernelDir, '.kernel directory', { surface: true, kind: 'directory' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!kernel) throw new Error('ManifestMismatch: .kernel directory is absent');
    let generations;
    try { generations = await inspectTrustedPath(this.generationsDir, 'generations directory', { surface: true, kind: 'directory' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!generations) throw new Error('ManifestMismatch: generations directory is absent');
    return withProcessLock(this.kernelDir, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const snapshot = await this.readVerifiedCurrentNoMutation();
          if (!snapshot.state) throw new Error('ManifestMismatch: committed state is absent');
          if (expectedRunId !== undefined && snapshot.state.runId !== expectedRunId) throw new Error('ManifestMismatch: run identity differs from requested run');
          const metadata = await this.readManagedRuntimeMetadata();
          if (metadata.runId !== snapshot.state.runId || metadata.phaseId !== snapshot.state.phaseId || metadata.planDigest !== snapshot.state.planDigest) throw new Error('ManifestMismatch: bridge manifest disagrees with committed state');
          let afterRoot: FilesystemIdentity | undefined; let afterKernel: FilesystemIdentity | undefined;
          try {
            afterRoot = await trustedIdentity(this.rootDir, 'root directory', { surface: true, kind: 'directory' });
            afterKernel = await trustedIdentity(this.kernelDir, '.kernel directory', { surface: true, kind: 'directory' });
          } catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
          if (!afterRoot || !sameFilesystemIdentity(root.identity, afterRoot) || !afterKernel || !sameFilesystemIdentity(kernel.identity, afterKernel)) throw new Error('ManifestMismatch: run root changed during read');
          // The full state/journal parse, validation, and digest proof above is
          // intentionally performed once. Committed generations are immutable
          // rename-published files; rebind their filesystem identities and the
          // exact CURRENT manifest instead of repeating the O(state+journal)
          // work solely to close the metadata-read window.
          const generationDir = join(this.generationsDir, `g${snapshot.generation}`);
          const statePath = join(generationDir, 'state.json');
          // A segmented generation has no journal.ndjson. Its verified head
          // is the immutable journal proof and must be rebound instead.
          const journalPath = snapshot.current?.format === 'segmented/v1' || snapshot.current?.format === 'segmented/v2'
            ? join(generationDir, 'head.json')
            : join(generationDir, 'journal.ndjson');
          let afterCurrentIdentity: FilesystemIdentity | undefined; let afterGenerationsIdentity: FilesystemIdentity | undefined; let afterGenerationIdentity: FilesystemIdentity | undefined; let afterStateIdentity: FilesystemIdentity | undefined; let afterJournalIdentity: FilesystemIdentity | undefined;
          try {
            afterCurrentIdentity = await trustedIdentity(join(this.kernelDir, 'CURRENT'), 'CURRENT', { surface: true, kind: 'file' });
            afterGenerationsIdentity = await trustedIdentity(this.generationsDir, 'generations directory', { surface: true, kind: 'directory' });
            afterGenerationIdentity = await trustedIdentity(generationDir, `generation ${snapshot.generation}`, { surface: true, kind: 'directory' });
            afterStateIdentity = await trustedIdentity(statePath, `generation ${snapshot.generation} state`, { surface: true, kind: 'file' });
            afterJournalIdentity = await trustedIdentity(journalPath, `generation ${snapshot.generation} journal`, { surface: true, kind: 'file' });
          } catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
          if (!afterCurrentIdentity || !sameFilesystemIdentity(snapshot.proof.current, afterCurrentIdentity) || !afterGenerationsIdentity || !sameFilesystemIdentity(snapshot.proof.generations, afterGenerationsIdentity) || !afterGenerationIdentity || !sameFilesystemIdentity(snapshot.proof.generation, afterGenerationIdentity) || !afterStateIdentity || !sameFilesystemIdentity(snapshot.proof.state, afterStateIdentity) || !afterJournalIdentity || !sameFilesystemIdentity(snapshot.proof.journal, afterJournalIdentity)) throw new Error('ManifestMismatch: committed generation changed during read');
          const afterCurrent = await this.readCurrent();
          if (!afterCurrent || canonicalString(afterCurrent) !== canonicalString(snapshot.current)) throw new Error('ManifestMismatch: CURRENT changed during read');
          const afterMetadata = await this.readManagedRuntimeMetadata();
          if (canonicalString(afterMetadata) !== canonicalString(metadata)) throw new Error('ManifestMismatch: bridge metadata changed during read');
          try { await this.validateReadOnlyNamespace(snapshot.generation); }
          catch (error) { throw new Error(`ManifestMismatch: namespace changed during read: ${(error as Error).message.replace(/^ManifestMismatch:\s*/, '')}`); }
          return { state: snapshot.state, generation: snapshot.generation, metadata };
        } catch (error) {
          const message = (error as Error).message;
          const retryable = message.includes('CURRENT changed during read') || message.includes('committed generation changed during read') || message.includes('generations directory changed during read') || message.includes('bridge metadata changed during read') || message.includes('bridge manifest disagrees with committed state') || message.includes('namespace changed during read');
          if (!retryable || attempt === 2) throw error;
        }
      }
      throw new Error('ManifestMismatch: read retry budget exhausted');
    });
  }

  async load(signal?: AbortSignal): Promise<StoreSnapshot> {
    // Invalidate only after entering the writer fence so a queued load cannot
    // clear proof that an earlier queued commit still owns.
    return this.withFence(async () => {
      // A memo belongs to exactly one load→commit attempt.  Clear it before
      // any verification so a failed/restarted load can never inherit prior
      // proof.
      this.verifiedGenerationMemo = undefined;
      const verified = await this.readVerifiedCurrent(true);
      if (verified.current?.format === 'segmented/v1') this.format = 'segmented';
      else if (verified.current?.format === 'segmented/v2') this.format = 'segmented/v2';
      // Never expose the private proof.
      if (verified.current === undefined || verified.current.format === 'segmented/v2') {
        this.verifiedGenerationMemo = undefined;
      } else {
        // Memo capture is an optimization-only proof.  If its optional
        // identity/stat capture fails after authoritative verification and
        // reuse reconciliation have succeeded, retain the already-verified
        // public snapshot and let the next commit take the unchanged cold
        // verifier path.
        try {
          this.verifiedGenerationMemo = await this.captureVerifiedGenerationMemo(verified.current, verified.state!);
        } catch {
          this.verifiedGenerationMemo = undefined;
        }
      }
      return { state: verified.state, generation: verified.generation };
    }, signal);
  }

  /** v2 publishes a journal-free state projection and only rewrites the
   * mutable suffix.  Sealed descriptors are authenticated by the predecessor
   * head and linked into the successor generation without rereading/fsyncing
   * their bytes. */
  private async commitSegmentedV2(previousGeneration: number, state: MachineState, currentBefore: CurrentManifest | undefined): Promise<number> {
    const loadedGeneration = currentBefore?.generation ?? 0;
    if (loadedGeneration !== previousGeneration) throw mintStoreGenerationConflict();
    const generation = loadedGeneration + 1;
    const stage = join(this.generationsDir, `.g${generation}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const target = join(this.generationsDir, `g${generation}`);
    await this.ensureDirectory(stage, 'staged segmented v2 generation directory');
    const entries = state.journal as unknown as Array<Record<string, unknown>>;
    let priorHead: SegmentedHeadV2 | undefined;
    let priorState: MachineState | undefined;
    const priorGenerationDir = currentBefore?.format === 'segmented/v2' ? join(this.generationsDir, `g${currentBefore.generation}`) : undefined;
    if (currentBefore?.format === 'segmented/v2') {
      const verified = await this.readVerifiedSegmentedGeneration(currentBefore);
      priorHead = verified.head as unknown as SegmentedHeadV2;
      priorState = verified.state;
      if (entries.length < priorState.journal.length) throw new Error('ManifestMismatch: segmented v2 append would prune canonical history');
      for (let index = 0; index < priorState.journal.length; index += 1) {
        invariant(canonicalString(entries[index]) === canonicalString(priorState.journal[index]), 'segmented v2 prefix identity changed');
      }
    } else if (currentBefore?.format === 'segmented/v1') {
      // Selecting the v2 writer over a verified v1 generation is an explicit
      // format migration, not permission to prune its logical history.  The
      // v1 head cannot be hard-linked into a v2 successor, but its complete
      // replay still authenticates the append-only prefix boundary.
      const verified = await this.readVerifiedSegmentedGeneration(currentBefore);
      priorState = verified.state;
      if (entries.length < priorState.journal.length) throw new Error('ManifestMismatch: segmented v2 append would prune canonical history');
      for (let index = 0; index < priorState.journal.length; index += 1) {
        invariant(canonicalString(entries[index]) === canonicalString(priorState.journal[index]), 'segmented v2 prefix identity changed');
      }
    }
    const descriptors: SegmentDescriptor[] = [];
    const priorDescriptors = priorHead ? [...priorHead.segments, priorHead.active] : [];
    const prefixEnd = priorHead?.checkpointRevision ?? 0;
    if (priorHead && prefixEnd > entries.length) throw new Error('ManifestMismatch: segmented v2 checkpoint exceeds candidate journal');
    // Reuse only the authenticated sealed prefix. A mismatched descriptor is
    // a hard failure rather than permission to rebuild or silently compact.
    for (const descriptor of priorHead?.segments ?? []) {
      const expectedText = segmentBytes(entries.slice(descriptor.startRevision - 1, descriptor.endRevision));
      invariant(Buffer.byteLength(expectedText) === descriptor.bytes && digest(expectedText) === descriptor.digest, 'ManifestMismatch: segmented v2 sealed prefix mismatch');
      const sourcePath = join(priorGenerationDir!, descriptor.name);
      try {
        // Rebind and authenticate the source before exposing a hard link in
        // the successor. A source write/replacement between predecessor
        // verification and this link must fail closed rather than publishing
        // a mixed generation whose descriptor digest no longer matches bytes.
        const sourceIdentity = await trustedIdentity(sourcePath, `segmented v2 source ${descriptor.name}`, { surface: true, kind: 'file' });
        if (!sourceIdentity) throw new Error('ManifestMismatch: segmented v2 sealed prefix identity is unavailable');
        const sourceText = await this.readRegular(sourcePath, `segmented v2 source ${descriptor.name}`, JOURNAL_BYTE_CEILING * 16);
        invariant(sourceText === expectedText && digest(sourceText) === descriptor.digest, 'ManifestMismatch: segmented v2 sealed prefix source changed');
        this.injectFault('hard-link');
        const stagedPath = join(stage, descriptor.name);
        await fs.link(sourcePath, stagedPath);
        const reboundSource = await trustedIdentity(sourcePath, `segmented v2 source ${descriptor.name}`, { surface: true, kind: 'file' });
        const linkedIdentity = await trustedIdentity(stagedPath, `staged segmented v2 ${descriptor.name}`, { surface: true, kind: 'file' });
        if (!reboundSource || !sameFilesystemIdentity(sourceIdentity, reboundSource) || !linkedIdentity || !sameFilesystemIdentity(sourceIdentity, linkedIdentity)) throw new Error('ManifestMismatch: segmented v2 sealed prefix identity changed during link');
        const linkedText = await this.readRegular(stagedPath, `staged segmented v2 ${descriptor.name}`, JOURNAL_BYTE_CEILING * 16);
        invariant(linkedText === expectedText && digest(linkedText) === descriptor.digest, 'ManifestMismatch: segmented v2 sealed prefix changed during link');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ELOOP' || (error as Error).message.startsWith('ManifestMismatch:')) throw new Error('ManifestMismatch: segmented v2 sealed prefix identity is unavailable');
        await this.writeRegular(join(stage, descriptor.name), expectedText, 'staged segmented v2 sealed segment', true);
        this.injectFault('segment-fsync'); await this.fsyncFile(join(stage, descriptor.name));
      }
      descriptors.push(descriptor);
    }
    let offset = prefixEnd;
    if (entries.length === 0 && descriptors.length === 0) {
      const descriptor: SegmentDescriptor = { name: 'segment-00000001-00000000.ndjson', startRevision: 1, endRevision: 0, bytes: 0, digest: digest(''), previousDigest: digest('') };
      await this.writeRegular(join(stage, descriptor.name), '', 'staged segmented v2 active segment', true);
      this.injectFault('segment-fsync'); await this.fsyncFile(join(stage, descriptor.name)); descriptors.push(descriptor);
    }
    while (offset < entries.length || descriptors.length === 0) {
      const end = entries.length === 0 ? 0 : Math.min(entries.length, offset + this.segmentEventCeiling);
      const start = entries.length === 0 ? 1 : offset + 1;
      const text = entries.length === 0 ? '' : segmentBytes(entries.slice(offset, end));
      const descriptor: SegmentDescriptor = { name: `segment-${String(start).padStart(8, '0')}-${String(end).padStart(8, '0')}.ndjson`, startRevision: start, endRevision: end, bytes: Buffer.byteLength(text), digest: digest(text), previousDigest: descriptors.length ? descriptors.at(-1)!.digest : digest('') };
      const priorDescriptor = priorDescriptors.find((item) => item.name === descriptor.name && item.digest === descriptor.digest);
      let reused = false;
      if (priorDescriptor && priorGenerationDir) {
        try {
          const sourcePath = join(priorGenerationDir, descriptor.name);
          const sourceIdentity = await trustedIdentity(sourcePath, `segmented v2 source ${descriptor.name}`, { surface: true, kind: 'file' });
          if (!sourceIdentity) throw new Error('ManifestMismatch: segmented v2 source identity is unavailable');
          const sourceText = await this.readRegular(sourcePath, `segmented v2 source ${descriptor.name}`, JOURNAL_BYTE_CEILING * 16);
          invariant(sourceText === text && digest(sourceText) === descriptor.digest, 'ManifestMismatch: segmented v2 source changed');
          this.injectFault('hard-link');
          const stagedPath = join(stage, descriptor.name);
          await fs.link(sourcePath, stagedPath);
          const reboundSource = await trustedIdentity(sourcePath, `segmented v2 source ${descriptor.name}`, { surface: true, kind: 'file' });
          const linkedIdentity = await trustedIdentity(stagedPath, `staged segmented v2 ${descriptor.name}`, { surface: true, kind: 'file' });
          if (!reboundSource || !sameFilesystemIdentity(sourceIdentity, reboundSource) || !linkedIdentity || !sameFilesystemIdentity(sourceIdentity, linkedIdentity)) throw new Error('ManifestMismatch: segmented v2 source identity changed during link');
          const linkedText = await this.readRegular(stagedPath, `staged segmented v2 ${descriptor.name}`, JOURNAL_BYTE_CEILING * 16);
          invariant(linkedText === text && digest(linkedText) === descriptor.digest, 'ManifestMismatch: segmented v2 source changed during link');
          reused = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as Error).message.startsWith('ManifestMismatch:')) throw error;
        }
      }
      if (!reused) {
        await this.writeRegular(join(stage, descriptor.name), text, 'staged segmented v2 journal segment', true);
        this.injectFault('segment-fsync'); await this.fsyncFile(join(stage, descriptor.name));
      }
      descriptors.push(descriptor);
      if (entries.length === 0) break;
      offset = end;
    }
    const active = descriptors.at(-1)!;
    const sealed = descriptors.slice(0, -1);
    const checkpointRevision = sealed.length ? sealed.at(-1)!.endRevision : 0;
    const head: SegmentedHeadV2 = { schema: 2, format: 'segmented/v2', generation, runId: state.runId, phaseId: state.phaseId, writerFence: state.writerFence, revision: state.revision, journalEnd: state.journal.length, checkpointRevision, checkpointDigest: digest(entries.slice(0, checkpointRevision)), segments: sealed, active, activeCeiling: this.segmentEventCeiling };
    // Journal is intentionally absent from the v2 state projection. The
    // digest still covers the complete reconstructed state for exact replay.
    const { journal: _journal, ...stateProjection } = state;
    await this.writeRegular(join(stage, 'state.json'), canonicalString(stateProjection), 'staged segmented v2 state', true);
    await this.writeRegular(join(stage, 'head.json'), canonicalString(head), 'staged segmented v2 head', true);
    this.injectFault('state-fsync'); await this.fsyncFile(join(stage, 'state.json')); this.injectFault('head-fsync'); await this.fsyncFile(join(stage, 'head.json')); this.injectFault('seal-fsync'); await this.fsyncDir(stage);
    const existingTarget = await inspectTrustedPath(target, `generation ${generation}`, { allowMissing: true, surface: true, kind: 'directory' });
    if (existingTarget) throw new Error(`ManifestMismatch: generation ${generation} already exists`);
    this.injectFault('generation-rename'); await fs.rename(stage, target); this.injectFault('generation-published'); await this.fsyncDir(this.generationsDir);
    const manifest: CurrentManifest = { schema: 1, generation, revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, modeEpoch: state.modeEpoch, writerFence: state.writerFence, stateDigest: digest(state), journalEnd: state.journal.length, journalDigest: digest(state.journal), format: 'segmented/v2', headDigest: digest(head), checkpointRevision, segmentCount: descriptors.length, activeCeiling: this.segmentEventCeiling };
    const currentPath = join(this.kernelDir, 'CURRENT');
    const currentTmp = join(this.kernelDir, `.CURRENT.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const currentIdentityBefore = await trustedIdentity(currentPath, 'CURRENT', { allowMissing: true, surface: true, kind: 'file' });
    const currentIdentityNow = await trustedIdentity(currentPath, 'CURRENT', { allowMissing: true, surface: true, kind: 'file' });
    if ((currentIdentityBefore === undefined) !== (currentIdentityNow === undefined) || (currentIdentityBefore && currentIdentityNow && !sameFilesystemIdentity(currentIdentityBefore, currentIdentityNow))) throw new Error('ManifestMismatch: CURRENT changed before segmented v2 commit');
    await this.writeRegular(currentTmp, canonicalString(manifest), 'staged CURRENT', true); this.injectFault('CURRENT-fsync'); await this.fsyncFile(currentTmp); this.injectFault('CURRENT-rename'); await fs.rename(currentTmp, currentPath); this.injectFault('CURRENT-published'); await this.fsyncDir(this.kernelDir);
    return generation;
  }

  private async commitSegmented(previousGeneration: number, state: MachineState, currentBefore: CurrentManifest | undefined): Promise<number> {
    const loadedGeneration = currentBefore?.generation ?? 0;
    if (loadedGeneration !== previousGeneration) throw mintStoreGenerationConflict();
    const generation = loadedGeneration + 1;
    const stage = join(this.generationsDir, `.g${generation}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const target = join(this.generationsDir, `g${generation}`);
    await this.ensureDirectory(stage, 'staged segmented generation directory');
    const entries = state.journal as unknown as Array<Record<string, unknown>>;
    const descriptors: SegmentDescriptor[] = [];
    const chunkSize = this.segmentEventCeiling;
    let priorHead: SegmentedHead | undefined;
    const priorGenerationDir = currentBefore?.format === 'segmented/v1' ? join(this.generationsDir, `g${currentBefore.generation}`) : undefined;
    if (priorGenerationDir) {
      try { priorHead = validateSegmentedHead(parseCanonical(await this.readRegular(join(priorGenerationDir, 'head.json'), 'prior segmented head', CURRENT_BYTE_CEILING))); } catch { priorHead = undefined; }
    }
    for (let offset = 0; offset < entries.length; offset += chunkSize) {
      const chunk = entries.slice(offset, Math.min(entries.length, offset + chunkSize));
      const startRevision = offset + 1; const endRevision = offset + chunk.length;
      const text = segmentBytes(chunk);
      const descriptor: SegmentDescriptor = { name: `segment-${String(startRevision).padStart(8, '0')}-${String(endRevision).padStart(8, '0')}.ndjson`, startRevision, endRevision, bytes: Buffer.byteLength(text), digest: digest(text), previousDigest: descriptors.length ? descriptors.at(-1)!.digest : digest('') };
      const priorDescriptor = priorHead && [...priorHead.segments, priorHead.active].find((item) => item.name === descriptor.name && item.digest === descriptor.digest);
      if (priorDescriptor && priorGenerationDir) {
        let reused = false;
        try {
          // Bind and authenticate the predecessor source before exposing a
          // hard-link in the successor. A source write/replacement during
          // this window must fail closed rather than publishing a mixed
          // generation whose descriptor no longer matches its bytes.
          const sourcePath = join(priorGenerationDir, descriptor.name);
          const sourceIdentity = await trustedIdentity(sourcePath, `segmented source ${descriptor.name}`, { surface: true, kind: 'file' });
          if (!sourceIdentity) throw new Error('ManifestMismatch: segmented source identity is unavailable');
          const sourceText = await this.readRegular(sourcePath, `segmented source ${descriptor.name}`, JOURNAL_BYTE_CEILING * 16);
          invariant(sourceText === text && digest(sourceText) === descriptor.digest, 'ManifestMismatch: segmented source changed');
          this.injectFault('hard-link');
          const stagedPath = join(stage, descriptor.name);
          await fs.link(sourcePath, stagedPath);
          const reboundSource = await trustedIdentity(sourcePath, `segmented source ${descriptor.name}`, { surface: true, kind: 'file' });
          const linkedIdentity = await trustedIdentity(stagedPath, `staged segmented ${descriptor.name}`, { surface: true, kind: 'file' });
          if (!reboundSource || !sameFilesystemIdentity(sourceIdentity, reboundSource) || !linkedIdentity || !sameFilesystemIdentity(sourceIdentity, linkedIdentity)) throw new Error('ManifestMismatch: segmented source identity changed during link');
          const linkedText = await this.readRegular(stagedPath, `staged segmented ${descriptor.name}`, JOURNAL_BYTE_CEILING * 16);
          invariant(linkedText === text && digest(linkedText) === descriptor.digest, 'ManifestMismatch: segmented source changed during link');
          reused = true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ELOOP' || (error as Error).message.startsWith('ManifestMismatch:')) throw new Error('ManifestMismatch: segmented source identity is unavailable');
        }
        if (!reused) await this.writeRegular(join(stage, descriptor.name), text, 'staged segmented journal segment', true);
      } else await this.writeRegular(join(stage, descriptor.name), text, 'staged segmented journal segment', true);
      this.injectFault('segment-fsync'); await this.fsyncFile(join(stage, descriptor.name));
      descriptors.push(descriptor);
    }
    if (descriptors.length === 0) {
      const text = '';
      const descriptor: SegmentDescriptor = { name: 'segment-00000001-00000000.ndjson', startRevision: 1, endRevision: 0, bytes: 0, digest: digest(text), previousDigest: digest('') };
      await this.writeRegular(join(stage, descriptor.name), text, 'staged segmented journal segment', true);
      this.injectFault('segment-fsync'); await this.fsyncFile(join(stage, descriptor.name)); descriptors.push(descriptor);
    }
    const active = descriptors.at(-1)!;
    const sealed = descriptors.slice(0, -1);
    const checkpointRevision = sealed.length ? sealed.at(-1)!.endRevision : 0;
    const head: SegmentedHead = { schema: 1, format: 'segmented/v1', generation, runId: state.runId, phaseId: state.phaseId, writerFence: state.writerFence, revision: state.revision, journalEnd: state.journal.length, checkpointRevision, checkpointDigest: digest(entries.slice(0, checkpointRevision)), segments: sealed, active, activeCeiling: this.segmentEventCeiling };
    await this.writeRegular(join(stage, 'state.json'), canonicalString(state), 'staged segmented state', true);
    await this.writeRegular(join(stage, 'head.json'), canonicalString(head), 'staged segmented head', true);
    await this.fsyncFile(join(stage, 'state.json')); this.injectFault('head-fsync'); await this.fsyncFile(join(stage, 'head.json')); this.injectFault('seal-fsync'); await this.fsyncDir(stage);
    const existingTarget = await inspectTrustedPath(target, `generation ${generation}`, { allowMissing: true, surface: true, kind: 'directory' });
    if (existingTarget) throw new Error(`ManifestMismatch: generation ${generation} already exists`);
    this.injectFault('generation-rename'); await fs.rename(stage, target); this.injectFault('generation-published'); await this.fsyncDir(this.generationsDir);
    const manifest: CurrentManifest = { schema: 1, generation, revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, modeEpoch: state.modeEpoch, writerFence: state.writerFence, stateDigest: digest(state), journalEnd: state.journal.length, journalDigest: digest(state.journal), format: 'segmented/v1', headDigest: digest(head), checkpointRevision, segmentCount: descriptors.length, activeCeiling: this.segmentEventCeiling };
    const currentPath = join(this.kernelDir, 'CURRENT');
    const currentTmp = join(this.kernelDir, `.CURRENT.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const currentIdentityBefore = await trustedIdentity(currentPath, 'CURRENT', { allowMissing: true, surface: true, kind: 'file' });
    const currentNow = await trustedIdentity(currentPath, 'CURRENT', { allowMissing: true, surface: true, kind: 'file' });
    if ((currentIdentityBefore === undefined) !== (currentNow === undefined) || (currentIdentityBefore && currentNow && !sameFilesystemIdentity(currentIdentityBefore, currentNow))) throw new Error('ManifestMismatch: CURRENT changed before segmented commit');
    await this.writeRegular(currentTmp, canonicalString(manifest), 'staged CURRENT', true); this.injectFault('CURRENT-fsync'); await this.fsyncFile(currentTmp); this.injectFault('CURRENT-rename'); await fs.rename(currentTmp, currentPath); this.injectFault('CURRENT-published'); await this.fsyncDir(this.kernelDir);
    return generation;
  }

  async commit(previousGeneration: number, state: MachineState): Promise<number> {
    nonNegativeInteger(previousGeneration, 'previous generation');
    validateStateShape(state);
    // Keep file and memory stores on the same trust boundary: a caller must
    // not be able to publish a state whose journal projection is malformed,
    // non-canonical, or disconnected from its event digests.
    const candidateJournalText = state.journal.map((entry) => canonicalString(entry)).join('\n') + (state.journal.length ? '\n' : '');
    validateJournal(state, candidateJournalText, { segmented: isSegmentedFormat(this.format) });
    return this.withFence(async () => {
      // Consume before probing: no failure path may leave proof that a later
      // commit could accidentally reuse.  A miss falls through to the
      // unchanged full verifier and never refreshes this one-shot memo.
      let currentManifest: CurrentManifest | undefined;
      try { currentManifest = await this.readCurrent(); }
      catch (error) {
        // Preserve the historical cold-verifier path (and its diagnostics) on
        // malformed legacy CURRENT rather than short-circuiting through the
        // segmented format probe.
        try { await this.readVerifiedCurrent(); } catch { /* retain original parse error */ }
        throw error;
      }
      const segmentedV2 = !this.rollbackRequested && (this.format === 'segmented/v2' || currentManifest?.format === 'segmented/v2');
      const segmented = !this.rollbackRequested && (this.format === 'segmented' || currentManifest?.format === 'segmented/v1');
      this.rollbackRequested = false;
      if (segmentedV2) {
        this.format = 'segmented/v2';
        this.verifiedGenerationMemo = undefined;
        const verifiedPrior = previousGeneration > 0 ? await this.readVerifiedCurrent(true) : undefined;
        validateManagedAuthorityTransition(managedAuthorityAnchors(verifiedPrior?.state), state);
        return this.commitSegmentedV2(previousGeneration, state, verifiedPrior?.current ?? currentManifest);
      }
      if (segmented) {
        this.format = 'segmented';
        this.verifiedGenerationMemo = undefined;
        // Reader-before-writer: a segmented successor is staged only after
        // the complete predecessor head/state/segment chain has verified.
        const verifiedPrior = previousGeneration > 0 ? await this.readVerifiedCurrent(true) : undefined;
        validateManagedAuthorityTransition(managedAuthorityAnchors(verifiedPrior?.state), state);
        return this.commitSegmented(previousGeneration, state, verifiedPrior?.current ?? currentManifest);
      }
      const memo = this.verifiedGenerationMemo;
      this.verifiedGenerationMemo = undefined;
      const memoHit = await this.probeVerifiedGenerationMemo(memo, previousGeneration);
      const verifiedPrior = memoHit ? undefined : await this.readVerifiedCurrent();
      const loadedGeneration = memoHit ? previousGeneration : verifiedPrior!.generation;
      if (loadedGeneration !== previousGeneration) throw mintStoreGenerationConflict();
      validateManagedAuthorityTransition(memoHit ? memo!.authorityAnchors : managedAuthorityAnchors(verifiedPrior!.state), state);
      // Retire only the exact immediate predecessor after CURRENT has been
      // fully verified. No generation/quarantine retention cleanup runs after
      // CURRENT publication; normal lock release and disposable reuse work
      // retain their existing post-commit behavior.
      await this.retirePredecessor(loadedGeneration);
      const generation = loadedGeneration + 1;
      const currentPath = join(this.kernelDir, 'CURRENT');
      const currentBefore = await trustedIdentity(currentPath, 'CURRENT', { allowMissing: true, surface: true, kind: 'file' });
      const stage = join(this.generationsDir, `.g${generation}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const target = join(this.generationsDir, `g${generation}`);
      await this.ensureDirectory(stage, 'staged generation directory');
      const stateText = canonicalString(state);
      const journalText = state.journal.map((entry) => canonicalString(entry)).join('\n') + (state.journal.length ? '\n' : '');
      await this.writeRegular(join(stage, 'state.json'), stateText, 'staged state', true);
      await this.writeRegular(join(stage, 'journal.ndjson'), journalText, 'staged journal', true);
      this.injectFault('state-fsync'); await this.fsyncFile(join(stage, 'state.json')); this.injectFault('journal-fsync'); await this.fsyncFile(join(stage, 'journal.ndjson')); await this.fsyncDir(stage);
      const existingTarget = await inspectTrustedPath(target, `generation ${generation}`, { allowMissing: true, surface: true, kind: 'directory' });
      if (existingTarget) throw new Error(`ManifestMismatch: generation ${generation} already exists`);
      this.injectFault('generation-rename'); await fs.rename(stage, target); this.injectFault('generation-published'); await this.fsyncDir(this.generationsDir);
      const manifest: CurrentManifest = { schema: 1, generation, revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, modeEpoch: state.modeEpoch, writerFence: state.writerFence, stateDigest: digest(state), journalEnd: state.journal.length, journalDigest: digest(state.journal) };
      const currentTmp = join(this.kernelDir, `.CURRENT.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const currentNow = await trustedIdentity(currentPath, 'CURRENT', { allowMissing: true, surface: true, kind: 'file' });
      if ((currentBefore === undefined) !== (currentNow === undefined) || (currentBefore && currentNow && !sameFilesystemIdentity(currentBefore, currentNow))) throw new Error('ManifestMismatch: CURRENT changed before commit');
      await this.writeRegular(currentTmp, canonicalString(manifest), 'staged CURRENT', true); this.injectFault('CURRENT-fsync'); await this.fsyncFile(currentTmp); this.injectFault('CURRENT-rename'); await fs.rename(currentTmp, currentPath); this.injectFault('CURRENT-published'); await this.fsyncDir(this.kernelDir);
      return generation;
    });
  }

  /** Explicitly opt this store instance into the private segmented writer.
   * Existing generations must first be migrated; ordinary append never
   * changes format implicitly. */
  async selectFormat(format: ArtifactFormat): Promise<void> {
    if (!['legacy', 'segmented', 'segmented/v2', 'segmented-v2'].includes(format)) throw new Error('ManifestMismatch: unknown artifact format');
    await this.withFence(async () => {
      const current = await this.readCurrent();
      if ((current?.format === 'segmented/v1' || current?.format === 'segmented/v2') && format === 'legacy') throw new Error('ManifestMismatch: segmented format requires explicit rollback');
      this.format = normalizeArtifactFormat(format);
    });
  }

  /** Resumable one-generation migration.  The old CURRENT/generation remains
   * intact until the complete segmented successor is verified and published. */
  async migrateToSegmented(): Promise<number> {
    const loaded = await this.load();
    if (!loaded.state) throw new Error('ManifestMismatch: cannot migrate an empty store');
    const migrationMarker = join(this.kernelDir, 'MIGRATION.json');
    if (this.format === 'segmented') {
      // A crash after CURRENT publication but before marker cleanup is already
      // the verified new authority. Retire only that exact marker on retry.
      await fs.unlink(migrationMarker).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      return loaded.generation;
    }
    if (this.format === 'segmented/v2') throw new Error('ManifestMismatch: already using segmented/v2; use explicit rollback or v2 migration');
    await this.ensure();
    this.injectFault('migration-marker');
    await this.writeRegular(migrationMarker, canonicalString({ schema: 1, from: 'legacy', to: 'segmented/v1', priorGeneration: loaded.generation }), 'migration marker', true).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = parseCanonical<Record<string, unknown>>(await this.readRegular(migrationMarker, 'migration marker', CURRENT_BYTE_CEILING));
      invariant(existing.schema === 1 && existing.from === 'legacy' && existing.to === 'segmented/v1' && existing.priorGeneration === loaded.generation, 'migration marker conflicts with current generation');
    });
    this.format = 'segmented';
    try {
      const generation = await this.commit(loaded.generation, loaded.state);
      await fs.unlink(migrationMarker).catch(() => undefined);
      await this.fsyncDir(this.kernelDir).catch(() => undefined);
      return generation;
    } catch (error) { throw error; }
  }
  /** Resumable migration to the reader-first v2 namespace. The legacy/v1
   * generation remains authoritative until the complete v2 successor swaps
   * CURRENT; retries are idempotent through the exact marker. */
  async migrateToSegmentedV2(): Promise<number> {
    const loaded = await this.load();
    if (!loaded.state) throw new Error('ManifestMismatch: cannot migrate an empty store');
    const migrationMarker = join(this.kernelDir, 'MIGRATION.json');
    // The constructor's format is an opt-in writer preference, not proof that
    // CURRENT already names v2.  Re-read the verified manifest so an explicit
    // v2 store opening an existing legacy/v1 root still performs migration.
    const currentManifest = await this.readCurrent();
    if (currentManifest?.format === 'segmented/v2') {
      // A post-publication retry may still have the exact marker from the
      // predecessor generation. Validate it before cleanup; malformed or
      // foreign migration evidence must never be silently discarded merely
      // because CURRENT already names v2.
      const marker = await inspectTrustedPath(migrationMarker, 'migration marker', { allowMissing: true, surface: true, kind: 'file' });
      if (marker) {
        const existing = parseCanonical<Record<string, unknown>>(await this.readRegular(migrationMarker, 'migration marker', CURRENT_BYTE_CEILING));
        exactKeys(existing, ['from', 'priorGeneration', 'schema', 'to'], 'migration marker');
        invariant(existing.schema === 1 && (existing.from === 'legacy' || existing.from === 'segmented/v1') && existing.to === 'segmented/v2' && Number.isSafeInteger(existing.priorGeneration) && (existing.priorGeneration as number) > 0 && (existing.priorGeneration as number) < loaded.generation, 'migration marker conflicts with current generation');
      }
      await fs.unlink(migrationMarker).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      return loaded.generation;
    }
    await this.ensure();
    const priorManifest = currentManifest;
    this.injectFault('migration-marker');
    await this.writeRegular(migrationMarker, canonicalString({ schema: 1, from: priorManifest?.format ?? 'legacy', to: 'segmented/v2', priorGeneration: loaded.generation }), 'migration marker', true).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = parseCanonical<Record<string, unknown>>(await this.readRegular(migrationMarker, 'migration marker', CURRENT_BYTE_CEILING));
      invariant(existing.schema === 1 && (existing.from === 'legacy' || existing.from === 'segmented/v1') && existing.to === 'segmented/v2' && existing.priorGeneration === loaded.generation, 'migration marker conflicts with current generation');
    });
    this.format = 'segmented/v2';
    const generation = await this.commit(loaded.generation, loaded.state);
    await fs.unlink(migrationMarker).catch(() => undefined);
    await this.fsyncDir(this.kernelDir).catch(() => undefined);
    return generation;
  }
  async migrate(format?: ArtifactFormat): Promise<number> { return format === 'segmented/v2' || format === 'segmented-v2' || (format === undefined && this.format === 'segmented/v2') ? this.migrateToSegmentedV2() : this.migrateToSegmented(); }

  /** Roll back by publishing a verified legacy successor while retaining all
   * segmented generations for explicit later retention. */
  async rollbackSegmented(): Promise<number> {
    const loaded = await this.load();
    if (!loaded.state) throw new Error('ManifestMismatch: cannot roll back an empty store');
    await this.ensure();
    const rollbackMarker = join(this.kernelDir, 'ROLLBACK.json');
    const currentAfterLoad = await this.readCurrent();
    if (currentAfterLoad && currentAfterLoad.format === undefined) {
      // CURRENT already names the verified legacy successor. A prior process
      // may have crashed after the swap and before marker cleanup; clear that
      // exact marker and converge without publishing a second successor.
      const marker = await inspectTrustedPath(rollbackMarker, 'rollback marker', { allowMissing: true, surface: true, kind: 'file' });
      if (marker) {
        const existing = parseCanonical<Record<string, unknown>>(await this.readRegular(rollbackMarker, 'rollback marker', CURRENT_BYTE_CEILING));
        exactKeys(existing, ['from', 'priorGeneration', 'schema', 'to'], 'rollback marker');
        invariant(existing.schema === 1 && (existing.from === 'segmented/v1' || existing.from === 'segmented/v2') && existing.to === 'legacy' && Number.isSafeInteger(existing.priorGeneration) && (existing.priorGeneration as number) > 0, 'rollback marker is invalid');
        await fs.unlink(rollbackMarker).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
        await this.fsyncDir(this.kernelDir);
      }
      this.format = 'legacy';
      return loaded.generation;
    }
    this.injectFault('rollback-marker');
    const rollbackFrom = currentAfterLoad?.format ?? (this.format === 'segmented/v2' ? 'segmented/v2' : 'segmented/v1');
    invariant(rollbackFrom === 'segmented/v1' || rollbackFrom === 'segmented/v2', 'ManifestMismatch: rollback requires a segmented generation');
    await this.writeRegular(rollbackMarker, canonicalString({ schema: 1, from: rollbackFrom, to: 'legacy', priorGeneration: loaded.generation }), 'rollback marker', true).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // An earlier interrupted rollback is resumable only when it names the
      // same predecessor; never overwrite a foreign marker.
      const existing = parseCanonical<Record<string, unknown>>(await this.readRegular(rollbackMarker, 'rollback marker', CURRENT_BYTE_CEILING));
      invariant(existing.schema === 1 && (existing.from === 'segmented/v1' || existing.from === 'segmented/v2') && existing.to === 'legacy' && existing.priorGeneration === loaded.generation, 'rollback marker conflicts with current generation');
    });
    this.format = 'legacy';
    this.rollbackRequested = true;
    try {
      const generation = await this.commit(loaded.generation, loaded.state);
      await fs.unlink(rollbackMarker).catch(() => undefined);
      await this.fsyncDir(this.kernelDir).catch(() => undefined);
      return generation;
    } catch (error) { throw error; }
  }
  async rollback(): Promise<number> { return this.rollbackSegmented(); }

  /** Read the explicit migration/rollback retention pins.  These markers are
   * tiny, canonical operator records; a malformed marker blocks GC rather
   * than risking deletion of a generation still needed for recovery. */
  private async readRetentionGenerationRefs(): Promise<Set<number>> {
    const refs = new Set<number>();
    for (const [name, expected] of [['ROLLBACK.json', ['schema', 'from', 'to', 'priorGeneration']], ['MIGRATION.json', ['schema', 'from', 'to', 'priorGeneration']]] as const) {
      const path = join(this.kernelDir, name);
      const trusted = await inspectTrustedPath(path, name, { allowMissing: true, surface: true, kind: 'file' });
      if (!trusted) continue;
      const value = parseCanonical<Record<string, unknown>>(await this.readRegular(path, name, CURRENT_BYTE_CEILING));
      exactKeys(value, expected, name);
      invariant(value.schema === 1 && typeof value.from === 'string' && typeof value.to === 'string', `${name} identity is invalid`);
      invariant(Number.isSafeInteger(value.priorGeneration) && (value.priorGeneration as number) > 0, `${name} priorGeneration is invalid`);
      refs.add(value.priorGeneration as number);
    }
    return refs;
  }

  /** Remove one unreachable generation without recursive deletion. Every
   * child is named by the generation descriptor (or the legacy fixed pair),
   * digest/identity checked, then unlinked idempotently before the directory
   * itself is removed. */
  private async removeGenerationExactly(generation: number): Promise<boolean> {
    const path = join(this.generationsDir, `g${generation}`);
    const trusted = await inspectTrustedPath(path, `generation ${generation}`, { allowMissing: true, surface: true, kind: 'directory' });
    if (!trusted) return false;
    const generationIdentity = trusted.identity;
    const entries = await this.readDirectoryBounded(path, `generation ${generation}`, JOURNAL_EVENT_CEILING + 16);
    const names = entries.map((entry) => entry.name);
    const segmented = names.includes('head.json') || names.some((entry) => entry.startsWith('segment-'));
    let expected: string[];
    let removalOrder: string[];
    if (segmented) {
      invariant(names.includes('head.json') || (names.length === 1 && names[0] === 'state.json'), `generation ${generation} segmented descriptor is incomplete`);
      const parsedState = names.includes('state.json') ? parseCanonical<Record<string, unknown>>(await this.readRegular(join(path, 'state.json'), `generation ${generation} state`, READ_ONLY_STATE_BYTE_CEILING)) : undefined;
      const headRaw = parseCanonical<Record<string, unknown>>(await this.readRegular(join(path, 'head.json'), `generation ${generation} head`, CURRENT_BYTE_CEILING));
      const isV2 = headRaw.format === 'segmented/v2';
      let state: MachineState | undefined = parsedState as MachineState | undefined;
      if (state) {
        if (isV2) {
          // Historical GC is still a trust boundary: do not silently drop an
          // unexpected `journal` (or any other extra field) before deleting a
          // generation. Match the reader's exact journal-free projection
          // shape, then synthesize only the in-memory journal used for full
          // segment validation below.
          const projectionKeys = Object.keys(parsedState!).sort();
          const expectedProjectionKeys = ['attemptEpoch', 'authorityEpoch', 'barrier', 'barrierEpoch', 'decisionTokens', 'gate', 'modeEpoch', 'nextAction', 'outbox', 'phaseId', 'planDigest', 'processed', 'revision', 'runId', 'schema', 'status', 'steps', 'writerFence'];
          invariant(projectionKeys.length === expectedProjectionKeys.length && projectionKeys.every((key, index) => key === expectedProjectionKeys[index]), `generation ${generation} segmented v2 state projection is invalid`);
          state = { ...parsedState!, journal: [] } as unknown as MachineState;
        }
        validateStateShape(state);
      }
      const head = isV2 ? validateSegmentedHeadV2(headRaw) : validateSegmentedHead(headRaw);
      invariant(head.generation === generation && (!state || (head.runId === state.runId && head.phaseId === state.phaseId && head.writerFence === state.writerFence)), `generation ${generation} head identity is invalid`);
      expected = ['state.json', 'head.json', ...head.segments.map((item) => item.name), head.active.name];
      const unique = new Set(expected);
      invariant(unique.size === expected.length && names.every((name) => unique.has(name)), `generation ${generation} contains unexpected files`);
      const records: Array<Record<string, unknown>> = [];
      for (const descriptor of [...head.segments, head.active]) {
        const segmentPath = join(path, descriptor.name);
        const text = await this.readRegular(segmentPath, `generation ${generation} ${descriptor.name}`, JOURNAL_BYTE_CEILING * 16);
        invariant(Buffer.byteLength(text) === descriptor.bytes && digest(text) === descriptor.digest, `generation ${generation} ${descriptor.name} digest mismatch`);
        const lines = text.length === 0 ? [] : text.split('\n');
        if (lines.at(-1) === '') lines.pop();
        for (const line of lines) records.push(parseCanonical<Record<string, unknown>>(line));
      }
      if (state) {
        const verifiedState = isV2 ? ({ ...state, journal: records as unknown as MachineState['journal'] } as MachineState) : state;
        validateJournal(verifiedState, segmentBytes(records), { segmented: true });
        invariant(verifiedState.revision === head.revision && verifiedState.journal.length === head.journalEnd, `generation ${generation} state/head revision mismatch`);
      }
      removalOrder = [...head.segments.map((item) => item.name), head.active.name, 'state.json', 'head.json'];
    } else {
      expected = ['state.json', 'journal.ndjson'];
      invariant(names.every((name) => expected.includes(name)), `generation ${generation} legacy shape is invalid`);
      if (names.includes('state.json') && names.includes('journal.ndjson')) {
        const state = parseCanonical<MachineState>(await this.readRegular(join(path, 'state.json'), `generation ${generation} state`, READ_ONLY_STATE_BYTE_CEILING));
        validateStateShape(state);
        validateJournal(state, await this.readRegular(join(path, 'journal.ndjson'), `generation ${generation} journal`, JOURNAL_BYTE_CEILING));
      }
      removalOrder = ['journal.ndjson', 'state.json'];
    }
    const parentIdentity = await trustedIdentity(this.generationsDir, 'generations directory', { surface: true, kind: 'directory' });
    if (!parentIdentity) throw new Error('ManifestMismatch: generations directory is absent');
    await assertStableIdentity(this.generationsDir, parentIdentity, 'generations directory', { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
    await assertStableIdentity(path, generationIdentity, `generation ${generation}`, { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
    for (const name of removalOrder) {
      const childPath = join(path, name);
      const child = await inspectTrustedPath(childPath, `generation ${generation} ${name}`, { allowMissing: true, surface: true, kind: 'file' });
      if (!child) continue;
      this.injectFault('gc-unlink');
      await assertStableIdentity(childPath, child.identity, `generation ${generation} ${name}`, { surface: true, kind: 'file' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
      await fs.unlink(childPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
    this.injectFault('gc-rmdir');
    await assertStableIdentity(path, generationIdentity, `generation ${generation}`, { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
    try { await fs.rmdir(path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') throw new Error(`ManifestMismatch: generation ${generation} changed during compaction`);
      throw error;
    }
    return true;
  }

  /** Operator-initiated retention.  Publication never calls this method; only
   * exact, fully trusted generation names unreachable from CURRENT are removed.
   */
  async compact(): Promise<{ removed: number }> {
    return this.withFence(async () => {
      const current = await this.readCurrent();
      if (!current) return { removed: 0 };
      await this.readVerifiedCurrent();
      const retained = await this.readRetentionGenerationRefs();
      const entries = await this.readDirectoryBounded(this.generationsDir, 'generations directory', JOURNAL_EVENT_CEILING + 64);
      let removed = 0;
      for (const entry of entries) {
        const match = /^g(\d+)$/.exec(entry.name);
        if (!match || Number(match[1]) === current.generation) continue;
        const generation = Number(match[1]);
        if (retained.has(generation)) continue;
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`ManifestMismatch: generation ${entry.name} is not a directory`);
        if (await this.removeGenerationExactly(generation)) removed += 1;
      }
      await this.fsyncDir(this.generationsDir);
      return { removed };
    });
  }

  [STORE_LINEARIZED_DISPATCH](request: StoreLinearizedDispatchRequest, marker: EntryMarker): Promise<InternalDispatchResult> {
    return this.withFence(async () => {
      const snapshot = await this.readVerifiedCurrent();
      await this.assertHeldFence();
      return invokeIfCurrent(snapshot, request, marker);
    });
  }

  private publicationLeasePath(leaseId: string): string { return join(this.publicationLeasesDir, `${digest(leaseId)}.json`); }
  private validatePublicationLease(lease: PublicationLease): void {
    if (!lease || !/^[A-Za-z0-9._:-]{1,200}$/.test(lease.leaseId) || !Array.isArray(lease.refs) || lease.refs.length === 0 || lease.refs.some((item) => !refIsValid(item)) || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt < 0 || !['ACTIVE', 'PROMOTED', 'EXPIRED'].includes(lease.status)) throw new Error('publication lease is malformed');
  }
  async acquirePublicationLease(leaseId: string, refs: readonly Ref[], ttlMs = 60_000): Promise<PublicationLease> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(leaseId) || !Array.isArray(refs) || refs.length === 0 || refs.some((item) => !refIsValid(item))) throw new Error('publication lease is malformed');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) throw new Error('publication lease ttl is invalid');
    return this.withFence(async () => {
      await this.ensureDirectory(this.publicationLeasesDir, 'publication leases directory');
      const path = this.publicationLeasePath(leaseId);
      let prior: PublicationLease | undefined;
      try {
        prior = parseCanonical<PublicationLease>(await this.readRegular(path, 'publication lease'));
        this.validatePublicationLease(prior);
        if (prior.leaseId !== leaseId) throw new Error('publication lease identity mismatch');
        if (prior.status === 'ACTIVE' && prior.expiresAt > Date.now()) {
          if (canonicalString(prior.refs) !== canonicalString(refs)) throw new Error('publication lease conflicts');
          return { ...prior, refs: prior.refs.map((ref) => ({ ...ref })) };
        }
        if (prior.status === 'PROMOTED') throw new Error('publication lease already promoted');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (prior) await fs.unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      const lease: PublicationLease = { leaseId, refs: refs.map((ref) => ({ ...ref })), expiresAt: Date.now() + ttlMs, status: 'ACTIVE' };
      await this.writeRegular(path, canonicalString(lease), 'publication lease', true).catch(async (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const prior = parseCanonical<PublicationLease>(await this.readRegular(path, 'publication lease')); this.validatePublicationLease(prior);
        if (prior.status === 'ACTIVE' && prior.expiresAt > Date.now() && canonicalString(prior.refs) === canonicalString(refs)) return;
        throw new Error('publication lease conflicts');
      });
      await this.fsyncDir(this.publicationLeasesDir);
      return { ...lease, refs: lease.refs.map((ref) => ({ ...ref })) };
    });
  }
  async promotePublicationLease(leaseId: string): Promise<PublicationLease> {
    return this.withFence(async () => {
      try { await this.assertDirectory(this.publicationLeasesDir, 'publication leases directory'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('publication lease unavailable'); throw error; }
      const path = this.publicationLeasePath(leaseId);
      const lease = parseCanonical<PublicationLease>(await this.readRegular(path, 'publication lease')); this.validatePublicationLease(lease);
      if (lease.leaseId !== leaseId) throw new Error('publication lease unavailable');
      if (lease.status === 'PROMOTED') return { ...lease, refs: lease.refs.map((ref) => ({ ...ref })) };
      if (lease.status !== 'ACTIVE' || lease.expiresAt <= Date.now()) throw new Error('publication lease unavailable');
      const promoted: PublicationLease = { ...lease, status: 'PROMOTED' };
      await this.writeRegular(path, canonicalString(promoted), 'publication lease'); await this.fsyncDir(this.publicationLeasesDir);
      return { ...promoted, refs: promoted.refs.map((ref) => ({ ...ref })) };
    });
  }
  async releasePublicationLease(leaseId: string): Promise<void> {
    await this.withFence(async () => {
      try { await this.assertDirectory(this.publicationLeasesDir, 'publication leases directory'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      await fs.unlink(this.publicationLeasePath(leaseId)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); await this.fsyncDir(this.publicationLeasesDir);
    });
  }
  async collectPublicationLeases(now = Date.now()): Promise<{ removed: number }> {
    return this.withFence(async () => {
      try { await this.assertDirectory(this.publicationLeasesDir, 'publication leases directory'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0 }; throw error; }
      // Verify CURRENT once under the same writer fence before deleting any
      // expired row. A managed leaseSet in the authoritative state is a root;
      // malformed/missing CURRENT therefore fails closed instead of collecting
      // a lease that may still be needed for publication.
      const rooted = new Set<string>();
      const verified = await this.readVerifiedCurrent(true);
      for (const leaseId of Object.keys(verified.state?.managed?.leaseSets ?? {})) rooted.add(leaseId);
      const entries = await this.readDirectoryBounded(this.publicationLeasesDir, 'publication leases directory', JOURNAL_EVENT_CEILING + 1);
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error(`ManifestMismatch: unexpected publication lease ${entry.name}`);
        const path = join(this.publicationLeasesDir, entry.name);
        let lease: PublicationLease;
        try { lease = parseCanonical<PublicationLease>(await this.readRegular(path, 'publication lease')); this.validatePublicationLease(lease); }
        catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message}`); }
        if (lease.status === 'ACTIVE' && lease.expiresAt <= now && !rooted.has(lease.leaseId)) { await fs.unlink(path); removed += 1; }
      }
      if (removed) await this.fsyncDir(this.publicationLeasesDir);
      return { removed };
    });
  }


}

export function storeForRoot(rootDir?: string, expectedRootIdentity?: FilesystemIdentity, options?: ArtifactStoreOptions): ArtifactStore { return rootDir ? new FileArtifactStore(rootDir, expectedRootIdentity, options) : new MemoryArtifactStore(options); }
