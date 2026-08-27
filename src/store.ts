import { promises as fs, constants as fsConstants, type Dirent } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isPromise, isProxy } from 'node:util/types';
import type { Event, EventIdentity, MachineState, OutboxCommand, Ref } from './model.js';
import type { DriverReceipt } from './outbox.js';
import { canonicalString, digest, identityKey, parseCanonical } from './canonical.js';
import { validateDependencyTopology } from './dependency.js';
import { CURRENT_BYTE_CEILING, JOURNAL_BYTE_CEILING, JOURNAL_EVENT_CEILING, MANAGED_METADATA_BYTE_CEILING, READ_ONLY_STATE_BYTE_CEILING } from './limits.js';
import { assertStableIdentity, ensurePrivateDirectory, filesystemIdentity, inspectTrustedPath, sameFilesystemIdentity, trustedIdentity, type FilesystemIdentity } from './filesystem.js';
import { assertReleaseAdmissionOpen } from './release-admission.js';

export type StoreSnapshot = { state: MachineState | undefined; generation: number };

/** Private pre-publication generation CAS conflict. */
const storeGenerationConflicts = new WeakSet<object>();

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

/** Private immutable BASE row used by ContextCompiler/FixedCellReuse.  It is
 * intentionally not part of the package's public index or lifecycle API. */
export type ReuseRecord = {
  key: string;
  contentAddress: string;
  bytes: string;
  runId: string;
  generation: number;
  authorityDigest: string;
  authorityEpoch: number;
  cellDigest: string | null;
  snapshotDigest: string | null;
  reuseEpoch: number | null;
  writerFence: string;
  schema: 'safe-fixed-base/v1';
};

export interface ArtifactStore {
  load(): Promise<StoreSnapshot>;
  commit(previousGeneration: number, state: MachineState): Promise<number>;
  /** Optional private fixed-cell transaction hooks. Implementations supplied
   * by this repository always provide them; absence is a fail-closed miss. */
  reuseLookup?(key: string): Promise<ReuseRecord | undefined>;
  reuseStage?(record: ReuseRecord): Promise<void>;
  reusePublish?(record: ReuseRecord): Promise<void>;
  reuseQuarantine?(key: string): Promise<void>;
  reuseClear?(): Promise<void>;
}

function cloneState(state: MachineState): MachineState { return JSON.parse(JSON.stringify(state)) as MachineState; }
function cloneCommand(command: OutboxCommand): OutboxCommand { return JSON.parse(JSON.stringify(command)) as OutboxCommand; }
const SHA256 = /^[0-9a-f]{64}$/i;
const BRIDGE_SOURCE_ID = 'lunacy-runtime-skill-bridge/v1';
const RESERVED_PROJECTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const NEXT_ACTIONS = new Set(['start', 'blocked', 'advance-ready-steps', 'await-dispatch-receipt', 'await-dispatch-reconciliation', 'await-worker-envelope', 'await-parent-gate-decision', 'complete']);

/** Serialize calls from one process. The filesystem fence below extends the
 * same CAS to independent kernel processes sharing a root directory. */
const locks = new Map<string, Promise<void>>();
async function withProcessLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try { return await fn(); }
  finally { release(); if (locks.get(key) === queued) locks.delete(key); }
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

function dispatchProofIsValid(ref: Ref): boolean {
  try {
    const proof = parseCanonical<Record<string, unknown>>(ref.bytes ?? '');
    return Boolean(proof && typeof proof === 'object' && !Array.isArray(proof) && typeof proof.launchToken === 'string' && typeof proof.commandDigest === 'string' && Object.keys(proof).every((key) => ['launchToken', 'commandDigest', 'receipt'].includes(key)) && (proof.receipt === undefined || refIsValid(proof.receipt)));
  } catch { return false; }
}

function workerEnvelopeIsValid(ref: Ref): boolean {
  try {
    const result = parseCanonical<Record<string, unknown>>(ref.bytes ?? '');
    return Boolean(result && typeof result === 'object' && !Array.isArray(result) && typeof result.status === 'string' && Object.keys(result).length === 1);
  } catch { return false; }
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
  exactKeys(receipt, ['launchToken', 'commandDigest', 'ref'], 'driver receipt');
  invariant(typeof receipt.launchToken === 'string' && receipt.launchToken.length > 0, 'driver receipt launchToken is invalid');
  invariant(typeof receipt.commandDigest === 'string' && SHA256.test(receipt.commandDigest), 'driver receipt commandDigest is invalid');
  const refValue = enumerableData(receipt.ref, 'driver receipt ref');
  invariant(Object.keys(refValue).every((key) => ['id', 'digest', 'scope', 'bytes'].includes(key)), 'driver receipt ref fields are invalid');
  const clonedRef = { ...refValue } as Ref;
  invariant(refIsValid(clonedRef), 'driver receipt ref is invalid');
  return { launchToken: receipt.launchToken, commandDigest: receipt.commandDigest, ref: clonedRef };
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
    if (value.kind === 'BLOCKED') return Object.keys(value).every((key) => ['kind', 'code', 'reason', 'retryable', 'snapshot', 'receipt', 'launchToken'].includes(key)) && ['kind', 'code', 'reason', 'retryable', 'snapshot'].every((key) => Object.prototype.hasOwnProperty.call(value, key)) && ['CrossRunUnproven', 'UnknownDispatch', 'HumanReceiptRequired', 'ManifestMismatch', 'JournalCeiling', 'InvalidEvent'].includes(String(value.code)) && typeof value.reason === 'string' && typeof value.retryable === 'boolean' && (value.receipt === undefined || refIsValid(value.receipt)) && (value.launchToken === undefined || typeof value.launchToken === 'string');
    if (value.kind === 'FINAL') return Object.keys(value).sort().join(',') === 'artifacts,kind,snapshot,status' && ['phase-ready', 'complete'].includes(String(value.status)) && Array.isArray(value.artifacts) && value.artifacts.every(refIsValid);
    return false;
  } catch { return false; }
}

function validateJournal(state: MachineState, journalText: string): Array<Record<string, unknown>> {
  const lines = journalText.length === 0 ? [] : journalText.split('\n');
  if (lines.length && lines.at(-1) === '') lines.pop();
  invariant(lines.every((line) => line.length > 0), 'journal contains blank records');
  const entries: Array<Record<string, unknown>> = [];
  invariant(lines.length <= JOURNAL_EVENT_CEILING, 'journal event ceiling exceeded');
  invariant(Buffer.byteLength(journalText) <= JOURNAL_BYTE_CEILING, 'journal byte ceiling exceeded');
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

function validateStateShape(state: MachineState): void {
  invariant(state && typeof state === 'object', 'state is not an object');
  exactKeys(state as unknown as object, ['schema', 'runId', 'phaseId', 'revision', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch', 'modeEpoch', 'writerFence', 'status', 'gate', 'barrier', 'steps', 'outbox', 'processed', 'decisionTokens', 'planDigest', 'nextAction', 'journal'], 'state');
  invariant(state.schema === 1, 'state schema is invalid');
  for (const [field, value] of Object.entries({ revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, modeEpoch: state.modeEpoch })) nonNegativeInteger(value, field);
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
    invariant(Object.keys(command as object).every((field) => ['commandId', 'runId', 'phaseId', 'stepId', 'attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'modeEpoch', 'launchToken', 'commandDigest', 'state', 'receipt', 'leaseId', 'noEffectEvidence'].includes(field)), `outbox ${key} fields are invalid`);
    // A safely adopted authority may remove a display node while preserving
    // the old command identity for late receipt/UNKNOWN reconciliation.  The
    // command remains bound to this run/phase; membership in the *current*
    // step projection is intentionally not required.
    invariant(command.commandId === key && typeof command.commandId === 'string' && /^[0-9a-f]{32}$/.test(command.commandId) && typeof command.runId === 'string' && command.runId === state.runId && typeof command.phaseId === 'string' && command.phaseId === state.phaseId && typeof command.stepId === 'string' && command.stepId.length > 0, `outbox ${key} identity is invalid`);
    for (const field of ['attemptEpoch', 'authorityEpoch', 'barrierEpoch', 'modeEpoch'] as const) { const epoch = command[field]; invariant(typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch >= 0, `outbox ${key} ${field} is invalid`); }
    invariant(command.attemptEpoch! <= state.attemptEpoch && command.authorityEpoch! <= state.authorityEpoch && command.barrierEpoch! <= state.barrierEpoch && command.modeEpoch! <= state.modeEpoch, `outbox ${key} is from a future epoch`);
    invariant(typeof command.launchToken === 'string' && command.launchToken.length > 0 && !launchTokens.has(command.launchToken), `outbox ${key} launch token is invalid`); launchTokens.add(command.launchToken);
    invariant(typeof command.commandDigest === 'string' && SHA256.test(command.commandDigest) && command.commandDigest === digest({ commandId: command.commandId, runId: command.runId, phaseId: command.phaseId, stepId: command.stepId, attemptEpoch: command.attemptEpoch, launchToken: command.launchToken }), `outbox ${key} digest is invalid`);
    invariant(typeof command.state === 'string' && outboxStates.has(command.state), `outbox ${key} state is invalid`);
    invariant(command.leaseId === undefined || typeof command.leaseId === 'string', `outbox ${key} lease is invalid`);
    invariant(command.receipt === undefined || refIsValid(command.receipt), `outbox ${key} receipt is invalid`);
    invariant(command.noEffectEvidence === undefined || (Array.isArray(command.noEffectEvidence) && command.noEffectEvidence.every(refIsValid)), `outbox ${key} evidence is invalid`);
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
    invariant(commands[0].commandId === expectedCommandId && commands[0].launchToken === `launch-${expectedCommandId}`, `active step ${key} command identity is invalid`);
  }
  for (const [token, value] of Object.entries(state.decisionTokens)) {
    invariant(!RESERVED_PROJECTION_KEYS.has(token) && value && typeof value === 'object', `decision token ${token} is invalid`);
    const record = value as Record<string, unknown>;
    invariant(typeof record.kind === 'string' && typeof record.consumed === 'boolean' && typeof record.identity === 'string' && SHA256.test(record.identity), `decision token ${token} fields are invalid`);
    if (record.kind === 'AUTHORITY_ADOPTION') {
      exactKeys(record, ['kind', 'consumed', 'identity', 'expectedDigest', 'observedDigest', 'targetDigest'], `decision token ${token}`);
      invariant(typeof record.expectedDigest === 'string' && SHA256.test(record.expectedDigest) && typeof record.observedDigest === 'string' && SHA256.test(record.observedDigest) && typeof record.targetDigest === 'string' && SHA256.test(record.targetDigest), `decision token ${token} authority digests are invalid`);
    } else {
      exactKeys(record, ['kind', 'consumed', 'identity'], `decision token ${token}`);
    }
  }
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

type VerifiedCurrentResult = StoreSnapshot & { current?: CurrentManifest };

const CURRENT_KEYS = ['schema', 'generation', 'revision', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch', 'modeEpoch', 'writerFence', 'stateDigest', 'journalEnd', 'journalDigest'] as const;

function validateCurrent(value: unknown): CurrentManifest {
  invariant(value && typeof value === 'object', 'CURRENT is not an object');
  const current = value as Record<string, unknown>;
  exactKeys(current, CURRENT_KEYS, 'CURRENT');
  invariant(current.schema === 1, 'CURRENT schema is invalid');
  nonNegativeInteger(current.generation, 'CURRENT generation'); invariant((current.generation as number) > 0, 'CURRENT generation must be positive');
  for (const field of ['revision', 'authorityEpoch', 'attemptEpoch', 'barrierEpoch', 'modeEpoch', 'journalEnd']) nonNegativeInteger(current[field], `CURRENT ${field}`);
  invariant(typeof current.writerFence === 'string' && current.writerFence.length > 0, 'CURRENT writerFence is invalid');
  invariant(typeof current.stateDigest === 'string' && SHA256.test(current.stateDigest), 'CURRENT stateDigest is invalid');
  invariant(typeof current.journalDigest === 'string' && SHA256.test(current.journalDigest), 'CURRENT journalDigest is invalid');
  return current as CurrentManifest;
}

async function sleep(milliseconds: number): Promise<void> { await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)); }

export class MemoryArtifactStore implements ArtifactStore {
  private state?: MachineState;
  private generation = 0;
  private fence: Promise<void> = Promise.resolve();
  private readonly reuse = new Map<string, ReuseRecord>();
  /** Keep the small committed-generation fence history needed to reject a
   * delayed publication in deterministic/in-memory tests as well as on disk. */
  private readonly generationFences = new Map<number, { writerFence: string; runId: string; authorityEpoch: number }>();
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
    return this.withFence(() => ({ state: this.state ? cloneState(this.state) : undefined, generation: this.generation }));
  }
  async commit(previousGeneration: number, state: MachineState): Promise<number> {
    return this.withFence(() => {
      if (previousGeneration !== this.generation) throw mintStoreGenerationConflict();
      validateStateShape(state);
      const journalText = state.journal.map((entry) => canonicalString(entry)).join('\n') + (state.journal.length ? '\n' : '');
      validateJournal(state, journalText);
      this.state = cloneState(state); this.generation += 1;
      this.generationFences.set(this.generation, { writerFence: state.writerFence, runId: state.runId, authorityEpoch: state.authorityEpoch });
      return this.generation;
    });
  }
  [STORE_LINEARIZED_DISPATCH](request: StoreLinearizedDispatchRequest, marker: EntryMarker): Promise<InternalDispatchResult> {
    return this.withFence(() => invokeIfCurrent({ state: this.state, generation: this.generation }, request, marker));
  }
  async reuseLookup(key: string): Promise<ReuseRecord | undefined> {
    const row = this.reuse.get(key);
    if (!row || !this.state || row.generation <= 0 || row.generation > this.generation) return undefined;
    if (this.state.runId !== row.runId || this.state.authorityEpoch !== row.authorityEpoch) return undefined;
    const fence = this.generationFences.get(row.generation);
    if (!fence || fence.writerFence !== row.writerFence || fence.runId !== row.runId || fence.authorityEpoch !== row.authorityEpoch) return undefined;
    return { ...row };
  }
  async reuseStage(_record: ReuseRecord): Promise<void> { /* memory has no fsync boundary */ }
  async reusePublish(record: ReuseRecord): Promise<void> {
    const prior = this.reuse.get(record.key);
    const fence = this.generationFences.get(record.generation);
    if (!fence || record.generation !== this.generation || fence.writerFence !== record.writerFence || fence.runId !== record.runId || fence.authorityEpoch !== record.authorityEpoch) throw new Error('reuse publication fence mismatch');
    if (prior && prior.contentAddress !== record.contentAddress) { this.reuse.delete(record.key); throw new Error('reuse key has conflicting content'); }
    this.reuse.set(record.key, { ...record });
  }
  async reuseQuarantine(key: string): Promise<void> { this.reuse.delete(key); }
  async reuseClear(): Promise<void> { this.reuse.clear(); }
}

export class FileArtifactStore implements ArtifactStore {
  private readonly rootDir: string;
  private readonly kernelDir: string;
  private readonly generationsDir: string;
  private readonly lockPath: string;
  private readonly reuseDir: string;
  private readonly reuseBlobsDir: string;
  private readonly reusePinsDir: string;
  private readonly reuseIndexPath: string;
  private readonly expectedRootIdentity?: FilesystemIdentity;
  private rootIdentity?: FilesystemIdentity;
  private kernelIdentity?: FilesystemIdentity;
  private fenceIdentity?: FilesystemIdentity;
  private fenceOwner?: string;
  /** One-shot proof captured by load(); never durable or shared. */
  private verifiedGenerationMemo?: VerifiedGenerationMemo;

  constructor(rootDir: string, expectedRootIdentity?: FilesystemIdentity) {
    this.rootDir = resolve(rootDir);
    this.kernelDir = join(this.rootDir, '.kernel');
    this.generationsDir = join(this.kernelDir, 'generations');
    this.lockPath = join(this.kernelDir, '.writer.lock');
    this.reuseDir = join(this.kernelDir, 'reuse');
    this.reuseBlobsDir = join(this.reuseDir, 'blobs');
    this.reusePinsDir = join(this.reuseDir, 'pins');
    this.reuseIndexPath = join(this.reuseDir, 'index.json');
    this.expectedRootIdentity = expectedRootIdentity;
    this.rootIdentity = expectedRootIdentity;
  }

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
    const before = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
    if (!before) throw new Error(`ManifestMismatch: ${label} is absent`);
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
      const after = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
      if (!after || !sameFilesystemIdentity(filesystemIdentity(stat), after.identity)) throw new Error(`ManifestMismatch: ${label} changed during descriptor binding`);
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

  private async reclaimFence(): Promise<boolean> {
    const marker = `${this.lockPath}.reclaim`;
    try { await fs.mkdir(marker, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    try {
      let lockStat;
      try { lockStat = await fs.lstat(this.lockPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
      if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new Error('ManifestMismatch: writer lock is not a regular file');
      let stale = true;
      let lockText: string | undefined;
      try { lockText = await this.readRegular(this.lockPath, 'writer lock'); }
      catch (error) {
        // A disappearing lock is a normal contender race.  Trust-boundary
        // failures (ownership, mode, type, ancestor, or descriptor drift)
        // are not malformed lock content and must not be converted into
        // permission to unlink an unsafe authoritative object.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (lockText !== undefined) {
        try {
          const record = JSON.parse(lockText) as { pid?: number };
          if (typeof record.pid === 'number' && record.pid !== process.pid) {
            try { process.kill(record.pid, 0); stale = false; }
            catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') stale = false; }
          } else if (record.pid === process.pid) stale = false;
        } catch { /* malformed/partial lock is recoverable only under marker */ }
      }
      if (!stale) return false;
      await fs.unlink(this.lockPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      await this.fsyncDir(this.kernelDir);
      return true;
    } finally {
      await fs.rmdir(marker).catch(() => undefined);
      await this.fsyncDir(this.kernelDir).catch(() => undefined);
    }
  }

  private async acquireFence(): Promise<void> {
    const owner = canonicalString({ pid: process.pid, started: Date.now(), nonce: Math.random().toString(16).slice(2) });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (await this.createExclusiveFence(owner)) {
        this.fenceOwner = owner;
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
        if (await this.reclaimFence()) continue;
        await sleep(5);
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

  private async withFence<T>(fn: () => Promise<T>): Promise<T> {
    // The ancestor release marker is the common production admission gate.
    // Check before any store setup and again after the per-run writer claim:
    // either a writer is already inside (and release waits for this fence), or
    // the release marker wins and this writer cannot enter.
    await assertReleaseAdmissionOpen(this.rootDir);
    await this.ensure();
    return withProcessLock(this.kernelDir, async () => {
      await assertReleaseAdmissionOpen(this.rootDir);
      if (!this.rootIdentity) throw new Error('ManifestMismatch: root directory identity is unavailable');
      await assertStableIdentity(this.rootDir, this.rootIdentity, 'root directory', { surface: true, kind: 'directory' }).catch((error) => { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); });
      await this.acquireFence();
      try {
        await assertReleaseAdmissionOpen(this.rootDir);
        return await fn();
      }
      finally { await this.releaseFence(); }
    });
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

  private async quarantineOrphans(currentGeneration?: number): Promise<void> {
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
      const keep = Boolean(canonical && (candidate === currentGeneration || candidate === predecessorGeneration));
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
  private async captureVerifiedGenerationMemo(current: CurrentManifest): Promise<VerifiedGenerationMemo> {
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
    return Object.freeze({ generation: current.generation, current: canonicalCurrent, proof: second.proof, stat: second.stat });
  }

  private verifiedGenerationMemoShape(value: unknown): value is VerifiedGenerationMemo {
    if (!value || typeof value !== 'object') return false;
    const memo = value as Record<string, unknown>;
    if (Object.keys(memo).sort().join(',') !== 'current,generation,proof,stat') return false;
    if (!Number.isSafeInteger(memo.generation) || (memo.generation as number) <= 0 || typeof memo.current !== 'string' || memo.current.length === 0 || Buffer.byteLength(memo.current, 'utf8') > CURRENT_BYTE_CEILING) return false;
    try {
      const current = parseCanonical<unknown>(memo.current);
      const validated = validateCurrent(current);
      if (validated.generation !== memo.generation || canonicalString(validated) !== memo.current) return false;
    } catch { return false; }
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
    const entries = await this.readDirectoryBounded(generationPath, `predecessor generation ${predecessorGeneration}`, 2);
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
          const journalPath = join(generationDir, 'journal.ndjson');
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

  async load(): Promise<StoreSnapshot> {
    // Invalidate only after entering the writer fence so a queued load cannot
    // clear proof that an earlier queued commit still owns.
    return this.withFence(async () => {
      // A memo belongs to exactly one load→commit attempt.  Clear it before
      // any verification so a failed/restarted load can never inherit prior
      // proof.
      this.verifiedGenerationMemo = undefined;
      const verified = await this.readVerifiedCurrent(true);
      // A staged pin is intentionally allowed to survive the commit call so
      // publication can consume it.  Reconcile only at a load/restart
      // boundary, where no in-flight caller can still prove ownership.
      await this.reconcileReusePins();
      // Never expose the private proof or retain it if reconciliation fails.
      if (verified.current === undefined) {
        this.verifiedGenerationMemo = undefined;
      } else {
        // Memo capture is an optimization-only proof.  If its optional
        // identity/stat capture fails after authoritative verification and
        // reuse reconciliation have succeeded, retain the already-verified
        // public snapshot and let the next commit take the unchanged cold
        // verifier path.
        try {
          this.verifiedGenerationMemo = await this.captureVerifiedGenerationMemo(verified.current);
        } catch {
          this.verifiedGenerationMemo = undefined;
        }
      }
      return { state: verified.state, generation: verified.generation };
    });
  }

  async commit(previousGeneration: number, state: MachineState): Promise<number> {
    nonNegativeInteger(previousGeneration, 'previous generation');
    validateStateShape(state);
    // Keep file and memory stores on the same trust boundary: a caller must
    // not be able to publish a state whose journal projection is malformed,
    // non-canonical, or disconnected from its event digests.
    const candidateJournalText = state.journal.map((entry) => canonicalString(entry)).join('\n') + (state.journal.length ? '\n' : '');
    validateJournal(state, candidateJournalText);
    return this.withFence(async () => {
      // Consume before probing: no failure path may leave proof that a later
      // commit could accidentally reuse.  A miss falls through to the
      // unchanged full verifier and never refreshes this one-shot memo.
      const memo = this.verifiedGenerationMemo;
      this.verifiedGenerationMemo = undefined;
      const memoHit = await this.probeVerifiedGenerationMemo(memo, previousGeneration);
      const loadedGeneration = memoHit ? previousGeneration : (await this.readVerifiedCurrent()).generation;
      if (loadedGeneration !== previousGeneration) throw mintStoreGenerationConflict();
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
      await this.fsyncFile(join(stage, 'state.json')); await this.fsyncFile(join(stage, 'journal.ndjson')); await this.fsyncDir(stage);
      const existingTarget = await inspectTrustedPath(target, `generation ${generation}`, { allowMissing: true, surface: true, kind: 'directory' });
      if (existingTarget) throw new Error(`ManifestMismatch: generation ${generation} already exists`);
      await fs.rename(stage, target); await this.fsyncDir(this.generationsDir);
      const manifest: CurrentManifest = { schema: 1, generation, revision: state.revision, authorityEpoch: state.authorityEpoch, attemptEpoch: state.attemptEpoch, barrierEpoch: state.barrierEpoch, modeEpoch: state.modeEpoch, writerFence: state.writerFence, stateDigest: digest(state), journalEnd: state.journal.length, journalDigest: digest(state.journal) };
      const currentTmp = join(this.kernelDir, `.CURRENT.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      const currentNow = await trustedIdentity(currentPath, 'CURRENT', { allowMissing: true, surface: true, kind: 'file' });
      if ((currentBefore === undefined) !== (currentNow === undefined) || (currentBefore && currentNow && !sameFilesystemIdentity(currentBefore, currentNow))) throw new Error('ManifestMismatch: CURRENT changed before commit');
      await this.writeRegular(currentTmp, canonicalString(manifest), 'staged CURRENT', true); await this.fsyncFile(currentTmp); await fs.rename(currentTmp, currentPath); await this.fsyncDir(this.kernelDir);
      return generation;
    });
  }

  [STORE_LINEARIZED_DISPATCH](request: StoreLinearizedDispatchRequest, marker: EntryMarker): Promise<InternalDispatchResult> {
    return this.withFence(async () => {
      const snapshot = await this.readVerifiedCurrent();
      await this.assertHeldFence();
      return invokeIfCurrent(snapshot, request, marker);
    });
  }

  private validateReuseRecord(record: ReuseRecord): void {
    invariant(record && typeof record === 'object', 'reuse record is invalid');
    exactKeys(record as unknown as object, ['key', 'contentAddress', 'bytes', 'runId', 'generation', 'authorityDigest', 'authorityEpoch', 'cellDigest', 'snapshotDigest', 'reuseEpoch', 'writerFence', 'schema'], 'reuse record');
    invariant(record.schema === 'safe-fixed-base/v1', 'reuse schema is invalid');
    invariant(SHA256.test(record.key) && SHA256.test(record.contentAddress), 'reuse digest is invalid');
    invariant(typeof record.bytes === 'string' && record.bytes.length > 0, 'reuse bytes are invalid');
    invariant(typeof record.runId === 'string' && record.runId.length > 0, 'reuse runId is invalid');
    nonNegativeInteger(record.generation, 'reuse generation');
    invariant(SHA256.test(record.authorityDigest), 'reuse authority digest is invalid');
    nonNegativeInteger(record.authorityEpoch, 'reuse authority epoch');
    invariant(record.cellDigest === null || SHA256.test(record.cellDigest), 'reuse cell digest is invalid');
    invariant(record.snapshotDigest === null || SHA256.test(record.snapshotDigest), 'reuse snapshot digest is invalid');
    invariant(record.reuseEpoch === null || (Number.isSafeInteger(record.reuseEpoch) && record.reuseEpoch >= 0), 'reuse epoch is invalid');
    invariant(typeof record.writerFence === 'string' && record.writerFence.length > 0, 'reuse writer fence is invalid');
    invariant(digest(record.bytes) === record.contentAddress, 'reuse content digest mismatch');
  }

  private async readReuseIndex(): Promise<Record<string, ReuseRecord>> {
    try {
      await this.assertRegular(this.reuseIndexPath, 'reuse index');
      const text = await this.readRegular(this.reuseIndexPath, 'reuse index');
      const parsed = parseCanonical<Record<string, ReuseRecord>>(text);
      invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'reuse index is invalid');
      for (const [key, row] of Object.entries(parsed)) { invariant(key === row.key, 'reuse index key mismatch'); this.validateReuseRecord(row); }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      if ((error as Error).message.startsWith('ManifestMismatch:')) throw error;
      throw new Error(`ManifestMismatch: reuse index is malformed: ${(error as Error).message}`);
    }
  }

  private async writeReuseIndex(index: Record<string, ReuseRecord>): Promise<void> {
    await this.assertDirectory(this.reuseDir, 'reuse directory');
    const temp = join(this.reuseDir, `.index.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await this.writeRegular(temp, canonicalString(index), 'staged reuse index', true); await this.fsyncFile(temp);
    await fs.rename(temp, this.reuseIndexPath); await this.fsyncDir(this.reuseDir);
  }

  /** Reclaim only unindexed, unpinned cache blobs. Authoritative generations,
   * CURRENT, journal and outbox files are in a different namespace. */
  private async gcReuseUnsafe(index: Record<string, ReuseRecord>): Promise<void> {
    // Never enumerate a cache directory before proving that it is a real
    // directory.  `readdir` follows symlinks; doing this check only at the
    // public call sites left the load/restart recovery path able to inspect
    // (and quarantine) names from an attacker-controlled directory outside
    // the store root.
    await this.assertDirectory(this.reuseDir, 'reuse directory');
    await this.assertDirectory(this.reuseBlobsDir, 'reuse blobs directory');
    await this.assertDirectory(this.reusePinsDir, 'reuse pins directory');
    const pinned = new Set<string>();
    for (const row of Object.values(index)) pinned.add(row.contentAddress);
    const quarantine = await this.ensureQuarantine(this.reuseDir);
    let pins: string[] = [];
    try { pins = await fs.readdir(this.reusePinsDir); }
    catch (error) {
      // A cache directory disappearing between the trusted check and
      // enumeration is a normal cleanup race.  Permission, ownership, and
      // ancestor failures are not an empty cache: keep the trust error
      // visible instead of silently skipping unsafe entries.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of pins) {
      const pinPath = join(this.reusePinsDir, name);
      try {
        const pinStat = await fs.lstat(pinPath);
        if (pinStat.isSymbolicLink() || !pinStat.isFile()) {
          await fs.rename(pinPath, join(quarantine, this.uniqueQuarantineName(name))).catch(() => undefined);
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      const match = /^([0-9a-f]{64})-([0-9a-f]{64})\.pin$/i.exec(name);
      if (!match) {
        // Even an unaddressed debris file is quarantined only after its own
        // trust surface has been proven.  Otherwise a mode/ownership drift
        // would be hidden by the disposable-cache cleanup path.
        await this.assertRegular(pinPath, 'reuse pin');
        await fs.rename(pinPath, join(quarantine, this.uniqueQuarantineName(name))).catch(() => undefined);
        continue;
      }
      let pinText: string;
      try {
        pinText = await this.readRegular(pinPath, 'reuse pin');
      } catch (error) {
        // Only ordinary disappearance is a cleanup race.  A trust-boundary
        // failure must not be converted into permission to quarantine a pin
        // whose ownership, mode, type, or ancestry cannot be proven.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      try {
        const row = parseCanonical<ReuseRecord>(pinText);
        this.validateReuseRecord(row);
        if (row.key !== match[1] || row.contentAddress !== match[2]) throw new Error('reuse pin name/content mismatch');
        pinned.add(match[2]);
      } catch {
        await fs.rename(pinPath, join(quarantine, this.uniqueQuarantineName(name))).catch(() => undefined);
      }
    }
    let blobs: string[] = [];
    try { blobs = await fs.readdir(this.reuseBlobsDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of blobs) {
      const blobPath = join(this.reuseBlobsDir, name);
      let blobStat;
      try { blobStat = await fs.lstat(blobPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      if (blobStat.isSymbolicLink()) { await fs.rename(blobPath, join(quarantine, this.uniqueQuarantineName(name))).catch(() => undefined); continue; }
      const match = /^([0-9a-f]{64})\.blob$/i.exec(name); if (!match || pinned.has(match[1])) continue;
      // Before moving a disposable regular blob, still prove it belongs to
      // the trusted cache surface.  A malformed but unsafe object is not
      // allowed to turn a trust failure into a successful quarantine.
      await this.assertRegular(blobPath, 'reuse blob');
      await fs.rename(blobPath, join(quarantine, this.uniqueQuarantineName(name))).catch(() => undefined);
    }
  }

  /** Remove staged pins that cannot be proven to be the exact row already
   * published in the disposable index.  Recovery deliberately chooses a
   * quarantine/miss over guessing that a CURRENT commit happened: an orphan
   * pin must never keep an unindexed blob alive forever. */
  private async reconcileReusePins(): Promise<void> {
    // A cold/default-OFF load must not create an accelerator namespace merely
    // to discover that it is empty.  If the namespace already exists, retain
    // the full trust and reconciliation behavior below; unsafe types, modes,
    // ownership, and ancestry still fail closed through inspectTrustedPath.
    let reuse;
    try { reuse = await inspectTrustedPath(this.reuseDir, 'reuse directory', { allowMissing: true, surface: true, kind: 'directory' }); }
    catch (error) { throw new Error(`ManifestMismatch: ${(error as Error).message.replace(/^FilesystemTrust:\s*/, '')}`); }
    if (!reuse) return;
    await this.ensureDirectory(this.reuseDir, 'reuse directory');
    // This helper runs during `load()` before the normal lookup path has had
    // a chance to establish the cache directories.  Establish and verify all
    // three directories here before any readdir/rename so a symlinked cache
    // subtree cannot turn restart recovery into an outside-root operation.
    await this.ensureDirectory(this.reuseBlobsDir, 'reuse blobs directory');
    await this.ensureDirectory(this.reusePinsDir, 'reuse pins directory');
    let index: Record<string, ReuseRecord>;
    try {
      index = await this.readReuseIndex();
    } catch (error) {
      // Only malformed cache bytes are disposable.  Ownership, mode, path,
      // and descriptor failures must remain visible instead of becoming an
      // implicit quarantine/delete operation on an unsafe object.
      if (!isMalformedReuseIndex(error)) throw error;
      const quarantine = await this.ensureQuarantine(this.reuseDir);
      await fs.rename(this.reuseIndexPath, join(quarantine, this.uniqueQuarantineName('index.json'))).catch(() => undefined);
      index = {};
      await this.writeReuseIndex(index);
    }
    let pins: string[] = [];
    try { pins = await fs.readdir(this.reusePinsDir); } catch { pins = []; }
    const quarantine = await this.ensureQuarantine(this.reuseDir);
    for (const name of pins) {
      const pinPath = join(this.reusePinsDir, name);
      try { if ((await fs.lstat(pinPath)).isSymbolicLink()) { await fs.rename(pinPath, join(quarantine, this.uniqueQuarantineName(name))).catch(() => undefined); continue; } } catch { continue; }
      let row: ReuseRecord | undefined;
      try {
        const bytes = await this.readRegular(pinPath, 'reuse pin');
        try {
          const parsed = parseCanonical<ReuseRecord>(bytes);
          this.validateReuseRecord(parsed); row = parsed;
        } catch { /* malformed pin bytes are quarantined below */ }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      const indexed = row ? index[row.key] : undefined;
      if (row && indexed && canonicalString(indexed) === canonicalString(row)) {
        // Publication completed but cleanup did not.  It is safe to drop the
        // duplicate pin because the exact immutable row is already indexed.
        await fs.unlink(pinPath).catch(() => undefined);
      } else {
        await fs.rename(pinPath, join(quarantine, this.uniqueQuarantineName(name))).catch(() => undefined);
      }
    }
    await this.gcReuseUnsafe(index);
  }

  private async generationFence(generation: number): Promise<{ writerFence: string; runId: string; authorityEpoch: number } | undefined> {
    if (!Number.isSafeInteger(generation) || generation <= 0) return undefined;
    const generationDir = join(this.generationsDir, `g${generation}`);
    const statePath = join(this.generationsDir, `g${generation}`, 'state.json');
    try {
      await this.assertDirectory(generationDir, `generation ${generation}`);
      const state = parseCanonical<MachineState>(await this.readRegular(statePath, 'reuse generation state'));
      validateStateShape(state);
      return { writerFence: state.writerFence, runId: state.runId, authorityEpoch: state.authorityEpoch };
    } catch (error) {
      // A generation that disappeared before the fence read is an ordinary
      // stale accelerator row.  Every other failure is an authoritative
      // generation-state error (including ownership/mode/ancestry and
      // descriptor identity drift) and must remain visible.  In particular,
      // do not let reusePublish treat trust failure as permission to mutate
      // quarantine, blobs, or pins.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async reuseRowIsCommitted(row: ReuseRecord, current: StoreSnapshot): Promise<boolean> {
    if (!current.state || row.generation <= 0 || row.generation > current.generation) return false;
    // Historical generation directories are disposable and may already have
    // been quarantined.  The target generation bound at publication is still
    // valid for later calls in the same run; only a future generation or a
    // different run/authority is rejected here.  The writer fence is checked
    // strictly at publication, where exact CURRENT identity is available.
    return current.state.runId === row.runId && current.state.authorityEpoch === row.authorityEpoch;
  }

  /** Stage the immutable BASE blob and an in-flight root pin.  Publication of
   * the disposable index is intentionally a separate post-CURRENT operation. */
  async reuseStage(record: ReuseRecord): Promise<void> {
    this.validateReuseRecord(record);
    await this.withFence(async () => {
      if (record.generation <= 0) throw new Error('reuse stage generation must be positive');
      await this.ensureDirectory(this.reuseDir, 'reuse directory'); await this.ensureDirectory(this.reuseBlobsDir, 'reuse blobs directory'); await this.ensureDirectory(this.reusePinsDir, 'reuse pins directory'); await this.fsyncDir(this.reuseDir);
      const blobPath = join(this.reuseBlobsDir, `${record.contentAddress}.blob`);
      try {
        await this.assertRegular(blobPath, 'reuse blob');
        const existing = await this.readRegular(blobPath, 'reuse blob');
        if (existing !== record.bytes) throw new Error('reuse blob has conflicting content');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const temp = join(this.reuseBlobsDir, `.${record.contentAddress}.tmp-${process.pid}-${Date.now()}`);
        await this.writeRegular(temp, record.bytes, 'staged reuse blob', true); await this.fsyncFile(temp); await fs.rename(temp, blobPath); await this.fsyncDir(this.reuseBlobsDir);
      }
      const pinPath = join(this.reusePinsDir, `${record.key}-${record.contentAddress}.pin`);
      try { await this.assertRegular(pinPath, 'reuse pin'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.writeRegular(pinPath, canonicalString(record), 'reuse pin'); await this.fsyncFile(pinPath); await this.fsyncDir(this.reusePinsDir);
    });
  }

  async reuseLookup(key: string): Promise<ReuseRecord | undefined> {
    invariant(SHA256.test(key), 'reuse lookup key is invalid');
    return this.withFence(async () => {
      await this.ensureDirectory(this.reuseDir, 'reuse directory');
      await this.ensureDirectory(this.reuseBlobsDir, 'reuse blobs directory');
      await this.ensureDirectory(this.reusePinsDir, 'reuse pins directory');
      const current = await this.readVerifiedCurrent();
      await this.reconcileReusePins();
      let index: Record<string, ReuseRecord>;
      try { index = await this.readReuseIndex(); }
      catch (error) {
        if (!isMalformedReuseIndex(error)) throw error;
        const quarantine = await this.ensureQuarantine(this.reuseDir);
        await fs.rename(this.reuseIndexPath, join(quarantine, this.uniqueQuarantineName('index.json'))).catch(() => undefined);
        await this.writeReuseIndex({});
        throw error;
      }
      const row = index[key];
      if (!row) return undefined;
      if (!(await this.reuseRowIsCommitted(row, current))) {
        await this.reuseQuarantineUnsafe(index, key);
        return undefined;
      }
      const blobPath = join(this.reuseBlobsDir, `${row.contentAddress}.blob`);
      let bytes: string | undefined;
      try {
        await this.assertRegular(blobPath, 'reuse blob');
        bytes = await this.readRegular(blobPath, 'reuse blob');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (bytes === undefined || bytes !== row.bytes || digest(bytes) !== row.contentAddress) {
        delete index[key]; await this.writeReuseIndex(index);
        const quarantine = await this.ensureQuarantine(this.reuseDir);
        await fs.rename(blobPath, join(quarantine, this.uniqueQuarantineName(`${row.contentAddress}.blob`))).catch(() => undefined);
        return undefined;
      }
      return { ...row };
    });
  }

  private async reuseQuarantineUnsafe(index: Record<string, ReuseRecord>, key: string): Promise<void> {
    const row = index[key]; if (!row) return;
    const quarantine = await this.ensureQuarantine(this.reuseDir);
    await this.writeRegular(join(quarantine, this.uniqueQuarantineName(`${key}.row`)), canonicalString(row), 'quarantined reuse row', true).catch(() => undefined);
    delete index[key]; await this.writeReuseIndex(index); await this.gcReuseUnsafe(index);
  }

  async reusePublish(record: ReuseRecord): Promise<void> {
    this.validateReuseRecord(record);
    await this.withFence(async () => {
      await this.ensureDirectory(this.reuseDir, 'reuse directory');
      await this.ensureDirectory(this.reuseBlobsDir, 'reuse blobs directory');
      await this.ensureDirectory(this.reusePinsDir, 'reuse pins directory');
      // Publication is valid only for the exact CURRENT generation/fence the
      // staged row named.  This closes the delayed-old-writer window: a row
      // staged against generation N cannot publish after N+1 wins.
      const current = await this.readCurrent();
      const committed = current && current.generation === record.generation && current.writerFence === record.writerFence
        ? await this.generationFence(record.generation)
        : undefined;
      if (!current || !committed || committed.writerFence !== record.writerFence || committed.runId !== record.runId || committed.authorityEpoch !== record.authorityEpoch) {
        const quarantine = await this.ensureQuarantine(this.reuseDir);
        await this.writeRegular(join(quarantine, this.uniqueQuarantineName(`${record.key}.stale`)), canonicalString(record), 'quarantined stale reuse row', true).catch(() => undefined);
        await fs.rename(join(this.reuseBlobsDir, `${record.contentAddress}.blob`), join(quarantine, this.uniqueQuarantineName(`${record.contentAddress}.blob`))).catch(() => undefined);
        await fs.unlink(join(this.reusePinsDir, `${record.key}-${record.contentAddress}.pin`)).catch(() => undefined);
        throw new Error('reuse publication fence mismatch');
      }
      const index = await this.readReuseIndex(); const prior = index[record.key];
      const pinPath = join(this.reusePinsDir, `${record.key}-${record.contentAddress}.pin`);
      try {
        await this.assertRegular(pinPath, 'reuse pin');
        const staged = parseCanonical<ReuseRecord>(await this.readRegular(pinPath, 'reuse pin'));
        this.validateReuseRecord(staged);
        invariant(canonicalString(staged) === canonicalString(record), 'reuse staged pin proof mismatch');
      } catch (error) {
        throw new Error(`reuse staged pin is invalid: ${(error as Error).message}`);
      }
      if (prior && prior.contentAddress !== record.contentAddress) {
        const quarantine = await this.ensureQuarantine(this.reuseDir);
        // Deterministic conflict has no winner. Remove the prior index row
        // before surfacing the conflict, and quarantine both materials.
        delete index[record.key]; await this.writeReuseIndex(index);
        await this.writeRegular(join(quarantine, this.uniqueQuarantineName(`${record.key}.prior.conflict`)), canonicalString(prior), 'quarantined prior reuse row', true).catch(() => undefined);
        await this.writeRegular(join(quarantine, this.uniqueQuarantineName(`${record.key}.conflict`)), canonicalString(record), 'quarantined conflicting reuse row', true);
        await fs.rename(join(this.reuseBlobsDir, `${record.contentAddress}.blob`), join(quarantine, this.uniqueQuarantineName(`${record.contentAddress}.blob`))).catch(() => undefined);
        await fs.rename(join(this.reuseBlobsDir, `${prior.contentAddress}.blob`), join(quarantine, this.uniqueQuarantineName(`${prior.contentAddress}.blob`))).catch(() => undefined);
        await fs.unlink(join(this.reusePinsDir, `${record.key}-${record.contentAddress}.pin`)).catch(() => undefined);
        await fs.unlink(join(this.reusePinsDir, `${prior.key}-${prior.contentAddress}.pin`)).catch(() => undefined);
        await this.fsyncDir(this.reusePinsDir); await this.gcReuseUnsafe(index);
        throw new Error('reuse key has conflicting content');
      }
      const blobPath = join(this.reuseBlobsDir, `${record.contentAddress}.blob`);
      await this.assertRegular(blobPath, 'reuse blob');
      const bytes = await this.readRegular(blobPath, 'reuse blob'); invariant(bytes === record.bytes && digest(bytes) === record.contentAddress, 'reuse staged blob is invalid');
      index[record.key] = { ...record }; await this.writeReuseIndex(index);
      await fs.unlink(pinPath).catch(() => undefined); await this.fsyncDir(this.reusePinsDir);
      await this.gcReuseUnsafe(index);
    });
  }

  async reuseQuarantine(key: string): Promise<void> {
    if (!SHA256.test(key)) return;
    await this.withFence(async () => {
      await this.ensureDirectory(this.reuseDir, 'reuse directory');
      const index = await this.readReuseIndex(); if (!index[key]) return;
      const quarantine = await this.ensureQuarantine(this.reuseDir);
      await this.writeRegular(join(quarantine, this.uniqueQuarantineName(`${key}.row`)), canonicalString(index[key]), 'quarantined reuse row', true);
      delete index[key]; await this.writeReuseIndex(index);
    });
  }

  async reuseClear(): Promise<void> {
    await this.withFence(async () => {
      try { await this.assertDirectory(this.reuseDir, 'reuse directory'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fs.rm(this.reuseDir, { recursive: true, force: true });
      await this.ensureDirectory(this.reuseDir, 'reuse directory'); await this.ensureDirectory(this.reuseBlobsDir, 'reuse blobs directory'); await this.ensureDirectory(this.reusePinsDir, 'reuse pins directory'); await this.fsyncDir(this.reuseDir);
    });
  }
}

export function storeForRoot(rootDir?: string, expectedRootIdentity?: FilesystemIdentity): ArtifactStore { return rootDir ? new FileArtifactStore(rootDir, expectedRootIdentity) : new MemoryArtifactStore(); }
