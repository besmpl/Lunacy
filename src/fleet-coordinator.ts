import { promises as fs, constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalString, digest, parseCanonical } from './canonical.js';
import { canonicalClaims } from './admission.js';
import { resumeRun, type LifecycleResult, type TerminalEffectDriver } from './orchestration.js';
import { canonicalizeDeclaration } from './bridge.js';
import { codexHostPolicyDigest, validateCodexHostPolicy, type CodexHostPolicy } from './codex-host-policy.js';
import { inspectTrustedPath, ensurePrivateDirectory, sameFilesystemIdentity, filesystemIdentity, type FilesystemIdentity } from './filesystem.js';
import { FileArtifactStore } from './store.js';
import type { Claim, Plan } from './model.js';
import { relationConflict } from './validator.js';
import { MANAGED_METADATA_BYTE_CEILING } from './limits.js';

/** Versioned, explicit-only fleet coordination metadata.  This module is
 * intentionally not re-exported from the package root: the kernel remains the
 * only run-transition authority and the coordinator is an advisory wrapper. */
export const FLEET_SCHEMA = 'lunacy-fleet/v1' as const;
export const FLEET_VERSION = 1 as const;
export const FLEET_STATE_SCHEMA = 'lunacy-fleet-state/v1' as const;
export const FLEET_STATE_VERSION = 1 as const;
export const FLEET_STATE_FILE = 'FLEET.STATE.json' as const;

export type FleetManifestEntry = Readonly<{
  /** Stable caller-selected entry identity. Defaults to runId. */
  entryId?: string;
  runRoot: string;
  runId: string;
  plan: Plan;
  /** Optional closed host policy. A policy is validated and digest-bound. */
  policy?: CodexHostPolicy;
  /** Optional explicit canonical claim declaration; defaults to plan claims. */
  claims?: Claim[];
  planDigest?: string;
  policyDigest?: string;
  claimsDigest?: string;
  /** Runtime-only driver for in-process hosts; never serialized or discovered. */
  driver?: TerminalEffectDriver;
  /** Optional key consumed by a caller-supplied driver factory. */
  driverKey?: string;
}>;

export type FleetManifest = Readonly<{
  schema: typeof FLEET_SCHEMA;
  version: typeof FLEET_VERSION;
  entries: readonly FleetManifestEntry[];
  /** Explicit coordinator metadata path. If omitted, statePath may be supplied in options. */
  statePath?: string;
  /** Initial deterministic round-robin cursor. */
  cursor?: number;
  /** Caller-owned generation fence for manifest revisions. */
  generation?: number;
}>;

export type FleetLease = Readonly<{
  owner: string;
  epoch: number;
  expiresAt: number;
  manifestDigest: string;
  rootIdentity: FilesystemIdentity;
  observedRevision: number | null;
}>;

export type FleetObservation = Readonly<{
  entryId: string;
  status: 'idle' | 'advanced' | 'attention';
  stop?: string;
  code?: string;
  revision: number | null;
  rootIdentity?: FilesystemIdentity;
  resultDigest?: string;
}>;

export type FleetState = Readonly<{
  schema: typeof FLEET_STATE_SCHEMA;
  version: typeof FLEET_STATE_VERSION;
  manifestDigest: string;
  generation: number;
  cursor: number;
  leases: Record<string, FleetLease>;
  observations: Record<string, FleetObservation>;
}>;

export type FleetAttentionCode =
  | 'ManifestMismatch'
  | 'StateMalformed'
  | 'CoordinatorBusy'
  | 'LeaseBusy'
  | 'LeaseLost'
  | 'StaleRoot'
  | 'RootIdentityChanged'
  | 'PlanMismatch'
  | 'PolicyMismatch'
  | 'ClaimsMismatch'
  | 'ClaimConflict'
  | 'InvalidEntry'
  | 'LifecycleError';

export type FleetResult = Readonly<{
  schema: typeof FLEET_SCHEMA;
  version: typeof FLEET_VERSION;
  manifestDigest: string;
  generation: number;
  cursor: number;
  status: 'advanced' | 'attention' | 'idle';
  entryId?: string;
  leaseEpoch?: number;
  lifecycle?: LifecycleResult;
  attention?: Readonly<{ code: FleetAttentionCode; entryId?: string; detail?: string }>;
  observations: readonly FleetObservation[];
}>;

export type FleetCoordinatorOptions = Readonly<{
  manifest: FleetManifest;
  /** Explicit metadata path; otherwise manifest.statePath or first root/.kernel/FLEET.STATE.json. */
  statePath?: string;
  owner?: string;
  leaseTtlMs?: number;
  lockWaitMs?: number;
  signal?: AbortSignal;
  maxTransitions?: number;
  driverFactory?: (entry: FleetManifestEntry) => TerminalEffectDriver | undefined;
}>;

function fail(message: string): never { throw new Error(`FleetManifest: ${message}`); }
function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} must be a non-negative integer`);
  return value as number;
}
function canonicalEntryId(entry: FleetManifestEntry): string {
  const id = entry.entryId ?? entry.runId;
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) fail('entryId is invalid');
  return id;
}
function canonicalClaimsFor(entry: FleetManifestEntry, plan: Plan): Claim[] {
  const fromPlan = canonicalClaims(plan.steps);
  const claims = entry.claims === undefined ? fromPlan : entry.claims;
  if (!Array.isArray(claims)) fail('claims must be an array');
  const normalized = claims.map((claim, index) => {
    if (!plainObject(claim) || Object.keys(claim).some((key) => !['resource', 'mode', 'aliases'].includes(key)) || typeof claim.resource !== 'string' || claim.resource.length === 0 || !['READ', 'WRITE', 'EXCLUSIVE'].includes(claim.mode as string)) fail(`claims[${index}] is invalid`);
    if (claim.aliases !== undefined && (!Array.isArray(claim.aliases) || claim.aliases.some((alias) => typeof alias !== 'string' || alias.length === 0))) fail(`claims[${index}] aliases are invalid`);
    const aliases = claim.aliases === undefined ? undefined : [...claim.aliases].sort();
    return { resource: claim.resource, mode: claim.mode, ...(aliases === undefined ? {} : { aliases }) } as Claim;
  }).sort((a, b) => canonicalString(a).localeCompare(canonicalString(b)));
  if (entry.claims !== undefined && digest(normalized) !== digest(fromPlan.slice().sort((a, b) => canonicalString(a).localeCompare(canonicalString(b))))) fail('claims do not match plan claims');
  return normalized;
}
function claimsDigest(claims: readonly Claim[]): string { return digest([...claims].sort((a, b) => canonicalString(a).localeCompare(canonicalString(b)))); }

/** Validate and canonicalize an explicit manifest. No filesystem discovery is performed. */
export function validateFleetManifest(input: unknown): FleetManifest {
  if (!plainObject(input)) fail('manifest is required');
  if (Object.keys(input).some((key) => !['schema', 'version', 'entries', 'statePath', 'cursor', 'generation'].includes(key))) fail('manifest contains unknown fields');
  if (input.schema !== FLEET_SCHEMA || input.version !== FLEET_VERSION) fail('schema/version is invalid');
  if (!Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > 256) fail('entries must be a bounded non-empty array');
  const seen = new Set<string>();
  const entries: FleetManifestEntry[] = [];
  for (const raw of input.entries) {
    if (!plainObject(raw)) fail('entry is invalid');
    if (Object.keys(raw).some((key) => !['entryId', 'runRoot', 'runId', 'plan', 'policy', 'claims', 'planDigest', 'policyDigest', 'claimsDigest', 'driver', 'driverKey'].includes(key))) fail('entry contains unknown fields');
    if (typeof raw.runRoot !== 'string' || !raw.runRoot.startsWith('/') || resolve(raw.runRoot) !== raw.runRoot || raw.runRoot.includes('\0')) fail('runRoot must be an absolute canonical path');
    if (typeof raw.runId !== 'string' || raw.runId.length === 0) fail('runId is required');
    let plan: Plan;
    try { plan = canonicalizeDeclaration(raw.plan); } catch (error) { fail(`plan is invalid: ${error instanceof Error ? error.message : String(error)}`); }
    const entryId = canonicalEntryId({ runRoot: raw.runRoot as string, runId: raw.runId as string, plan, ...(typeof raw.entryId === 'string' ? { entryId: raw.entryId } : {}) });
    if (seen.has(entryId)) fail('entryId values must be unique');
    seen.add(entryId);
    const claims = canonicalClaimsFor(raw as unknown as FleetManifestEntry, plan);
    const planDigest = digest(plan);
    if (raw.driver !== undefined && raw.policy !== undefined) fail('entry cannot include both driver and policy');
    let policy: CodexHostPolicy | undefined;
    if (raw.policy !== undefined) {
      try { policy = validateCodexHostPolicy(raw.policy as CodexHostPolicy); } catch (error) { fail(`policy is invalid: ${error instanceof Error ? error.message : String(error)}`); }
      if (policy.runId !== raw.runId || policy.runRoot !== raw.runRoot || policy.planDigest !== planDigest) fail('policy does not match run identity or plan');
    }
    if (raw.planDigest !== undefined && raw.planDigest !== planDigest) fail('planDigest does not match plan');
    if (raw.driver !== undefined && (!raw.driver || (typeof raw.driver !== 'object' && typeof raw.driver !== 'function') || typeof (raw.driver as { dispatch?: unknown }).dispatch !== 'function')) fail('driver is invalid');
    const policyDigest = policy === undefined ? undefined : codexHostPolicyDigest(policy);
    if (raw.policyDigest !== undefined && raw.policyDigest !== policyDigest) fail('policyDigest does not match policy');
    const claimsDigestValue = claimsDigest(claims);
    if (raw.claimsDigest !== undefined && raw.claimsDigest !== claimsDigestValue) fail('claimsDigest does not match claims');
    entries.push(Object.freeze({
      entryId, runRoot: raw.runRoot, runId: raw.runId, plan,
      ...(policy === undefined ? {} : { policy }), claims,
      planDigest, ...(policyDigest === undefined ? {} : { policyDigest }), claimsDigest: claimsDigestValue,
      ...(raw.driver === undefined ? {} : { driver: raw.driver as TerminalEffectDriver }), ...(typeof raw.driverKey !== 'string' ? {} : { driverKey: raw.driverKey }),
    }));
  }
  const cursor = input.cursor === undefined ? 0 : nonNegative(input.cursor, 'cursor');
  if (cursor >= entries.length) fail('cursor is outside entries');
  const generation = input.generation === undefined ? 0 : nonNegative(input.generation, 'generation');
  let statePath: string | undefined;
  if (input.statePath !== undefined) {
    if (typeof input.statePath !== 'string' || !input.statePath.startsWith('/') || resolve(input.statePath) !== input.statePath || input.statePath.includes('\0')) fail('statePath must be absolute canonical');
    statePath = input.statePath;
  }
  return Object.freeze({ schema: FLEET_SCHEMA, version: FLEET_VERSION, entries: Object.freeze(entries), ...(statePath === undefined ? {} : { statePath }), cursor, generation });
}

function manifestProjection(manifest: FleetManifest): unknown {
  return { schema: manifest.schema, version: manifest.version, ...(manifest.statePath === undefined ? {} : { statePath: manifest.statePath }), generation: manifest.generation ?? 0, cursor: manifest.cursor ?? 0, entries: manifest.entries.map((entry) => ({ entryId: entry.entryId ?? entry.runId, runRoot: entry.runRoot, runId: entry.runId, plan: entry.plan, planDigest: entry.planDigest, ...(entry.policy === undefined ? {} : { policy: entry.policy, policyDigest: entry.policyDigest }), claims: entry.claims, claimsDigest: entry.claimsDigest, ...(entry.driverKey === undefined ? {} : { driverKey: entry.driverKey }) })) };
}

const processLocks = new Map<string, Promise<void>>();
async function withProcessLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = processLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const queued = prior.then(() => current); processLocks.set(key, queued);
  try { await prior; return await fn(); } finally { release(); if (processLocks.get(key) === queued) void queued.then(() => { if (processLocks.get(key) === queued) processLocks.delete(key); }); }
}

async function acquireFileLock(path: string, owner: string, waitMs: number, staleMs: number, signal?: AbortSignal): Promise<(() => Promise<void>) | undefined> {
  const started = Date.now();
  await ensurePrivateDirectory(dirname(path), 'fleet lock parent');
  for (;;) {
    if (signal?.aborted) return undefined;
    try {
      const handle = await fs.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      await handle.writeFile(canonicalString({ owner, createdAt: Date.now() })); await handle.sync(); await handle.close();
      return async () => { try { await fs.unlink(path); } catch { /* already reclaimed */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(path);
        if (Date.now() - stat.mtimeMs > staleMs) await fs.unlink(path);
      } catch { /* a racing owner may have released it */ }
      if (Date.now() - started >= waitMs) return undefined;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(10, Math.max(1, waitMs - (Date.now() - started)))));
    }
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(dirname(path), 'fleet state parent');
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try { await handle.writeFile(canonicalString(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, path);
  // Persist the directory entry as well as file bytes so a crash exposes the
  // prior or the complete new state, never a partially named record.
  let directory;
  try { directory = await fs.open(dirname(path), fsConstants.O_RDONLY); await directory.sync(); }
  finally { await directory?.close(); }
}

/** Read one coordinator record through a bounded, no-follow descriptor.  The
 * record is advisory metadata, but it still must not become an unbounded
 * allocation or a pathname/symlink escape at the trust boundary. */
async function readBoundedStateFile(path: string): Promise<string | undefined> {
  const trusted = await inspectTrustedPath(path, 'fleet state', { allowMissing: true, surface: true, kind: 'file' });
  if (!trusted) return undefined;
  let handle;
  try { handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('fleet state is a symlink'); throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameFilesystemIdentity(filesystemIdentity(stat), trusted.identity)) throw new Error('fleet state changed before descriptor binding');
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MANAGED_METADATA_BYTE_CEILING) throw new Error('fleet state exceeds its byte ceiling');
    const expected = stat.size;
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected + 1)));
    let total = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      if (result.bytesRead > expected - total || result.bytesRead > MANAGED_METADATA_BYTE_CEILING - total) throw new Error('fleet state changed during bounded read');
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead))); total += result.bytesRead;
    }
    if (total !== expected) throw new Error('fleet state changed during bounded read');
    return Buffer.concat(chunks, total).toString('utf8');
  } finally { await handle.close(); }
}

function emptyState(manifestDigest: string, manifest: FleetManifest): FleetState {
  return { schema: FLEET_STATE_SCHEMA, version: FLEET_STATE_VERSION, manifestDigest, generation: manifest.generation ?? 0, cursor: manifest.cursor ?? 0, leases: {}, observations: {} };
}
function stateValid(value: unknown, manifestDigest: string, count: number): value is FleetState {
  if (!plainObject(value) || Object.keys(value).sort().join(',') !== 'cursor,generation,leases,manifestDigest,observations,schema,version' || value.schema !== FLEET_STATE_SCHEMA || value.version !== FLEET_STATE_VERSION || value.manifestDigest !== manifestDigest || !Number.isSafeInteger(value.generation) || (value.generation as number) < 0 || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0 || (value.cursor as number) >= count || !plainObject(value.leases) || !plainObject(value.observations)) return false;
  for (const lease of Object.values(value.leases)) {
    const record = lease as Record<string, unknown>;
    const identity = record.rootIdentity as Record<string, unknown> | undefined;
    if (!plainObject(lease) || Object.keys(record).sort().join(',') !== 'epoch,expiresAt,manifestDigest,observedRevision,owner,rootIdentity' || typeof record.owner !== 'string' || record.owner.length === 0 || record.owner.length > 200 || !Number.isSafeInteger(record.epoch) || (record.epoch as number) < 1 || !Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0 || record.manifestDigest !== manifestDigest || !plainObject(identity) || Object.keys(identity).sort().join(',') !== 'dev,ino' || typeof identity.dev !== 'string' || identity.dev.length === 0 || identity.dev.length > 100 || typeof identity.ino !== 'string' || identity.ino.length === 0 || identity.ino.length > 100 || (record.observedRevision !== null && (!Number.isSafeInteger(record.observedRevision) || (record.observedRevision as number) < 0))) return false;
  }
  for (const [id, observation] of Object.entries(value.observations)) {
    const record = observation as Record<string, unknown>;
    const identity = record.rootIdentity as Record<string, unknown> | undefined;
    if (!plainObject(observation) || Object.keys(record).some((key) => !['entryId', 'status', 'stop', 'code', 'revision', 'rootIdentity', 'resultDigest'].includes(key)) || record.entryId !== id || !['idle', 'advanced', 'attention'].includes(record.status as string) || (record.stop !== undefined && typeof record.stop !== 'string') || (record.code !== undefined && typeof record.code !== 'string') || (record.revision !== null && (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0)) || (record.resultDigest !== undefined && !/^[0-9a-f]{64}$/i.test(record.resultDigest as string)) || (record.rootIdentity !== undefined && (!plainObject(identity) || Object.keys(identity).sort().join(',') !== 'dev,ino' || typeof identity.dev !== 'string' || typeof identity.ino !== 'string'))) return false;
  }
  return true;
}
async function readState(path: string, manifest: FleetManifest, manifestDigest: string): Promise<{ state?: FleetState; malformed?: boolean; manifestMismatch?: boolean }> {
  let bytes: string | undefined;
  try { bytes = await readBoundedStateFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; return { malformed: true }; }
  if (bytes === undefined) return {};
  let parsed: unknown; try { parsed = parseCanonical(bytes); } catch { return { malformed: true }; }
  if (plainObject(parsed) && parsed.schema === FLEET_STATE_SCHEMA && parsed.version === FLEET_STATE_VERSION && parsed.manifestDigest !== manifestDigest) return { manifestMismatch: true };
  if (!stateValid(parsed, manifestDigest, manifest.entries.length)) return { malformed: true };
  return { state: parsed };
}

function resultBase(manifestDigest: string, state: FleetState, status: FleetResult['status'], observations: FleetObservation[]): FleetResult {
  return Object.freeze({ schema: FLEET_SCHEMA, version: FLEET_VERSION, manifestDigest, generation: state.generation, cursor: state.cursor, status, observations: Object.freeze(observations) });
}
function staleLease(lease: FleetLease | undefined, now = Date.now()): boolean { return lease === undefined || lease.expiresAt <= now; }
/** Keep operator-facing attention bounded and free of arbitrary filesystem or
 * provider details. Only a compact identifier-like hint is retained. */
function redactedDetail(detail: string | undefined): string | undefined {
  if (detail === undefined || detail.length === 0 || detail.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(detail)) return undefined;
  return detail;
}

/** Coordinate exactly one explicit manifest entry. Every run transition is delegated once to resumeRun. */
export async function runFleet(options: FleetCoordinatorOptions): Promise<FleetResult> {
  if (!options || typeof options !== 'object') throw new Error('FleetCoordinator: options are required');
  const manifest = validateFleetManifest(options.manifest);
  const manifestDigest = digest(manifestProjection(manifest));
  const statePath = options.statePath ?? manifest.statePath ?? join(manifest.entries[0]!.runRoot, '.kernel', FLEET_STATE_FILE);
  if (!statePath.startsWith('/') || resolve(statePath) !== statePath) throw new Error('FleetCoordinator: statePath must be absolute canonical');
  const owner = options.owner ?? `fleet-${process.pid}-${randomUUID()}`;
  if (typeof owner !== 'string' || owner.length === 0 || owner.length > 200) throw new Error('FleetCoordinator: owner is invalid');
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const lockWaitMs = options.lockWaitMs ?? 100;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1 || leaseTtlMs > 86_400_000) throw new Error('FleetCoordinator: leaseTtlMs is invalid');
  if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 60_000) throw new Error('FleetCoordinator: lockWaitMs is invalid');
  const lockPath = `${statePath}.lock`;
  const staleLockMs = Math.max(1000, leaseTtlMs * 2);
  const observations: FleetObservation[] = [];
  const acquireState = async (): Promise<{ state: FleetState; release: () => Promise<void> } | FleetResult> => {
    // The derived default metadata path is anchored to the first explicitly
    // named root. Never create that root merely to hold coordinator state.
    if (options.statePath === undefined && manifest.statePath === undefined) {
      const anchor = await inspectTrustedPath(manifest.entries[0]!.runRoot, 'fleet run root', { allowMissing: true, surface: true, kind: 'directory' });
      if (!anchor) {
        const fallback = emptyState(manifestDigest, manifest);
        return Object.freeze({ ...resultBase(manifestDigest, fallback, 'attention', []), attention: { code: 'StaleRoot' as const, entryId: manifest.entries[0]!.entryId ?? manifest.entries[0]!.runId } });
      }
    }
    const release = await acquireFileLock(lockPath, owner, lockWaitMs, staleLockMs, options.signal);
    if (!release) {
      const fallback = emptyState(manifestDigest, manifest);
      return Object.freeze({ ...resultBase(manifestDigest, fallback, 'attention', []), attention: { code: 'CoordinatorBusy' as const } });
    }
    try {
      const loaded = await readState(statePath, manifest, manifestDigest);
      if (loaded.manifestMismatch) {
        await release();
        const fallback = emptyState(manifestDigest, manifest);
        return Object.freeze({ ...resultBase(manifestDigest, fallback, 'attention', []), attention: { code: 'ManifestMismatch' as const } });
      }
      if (loaded.malformed) {
        await release();
        const fallback = emptyState(manifestDigest, manifest);
        return Object.freeze({ ...resultBase(manifestDigest, fallback, 'attention', []), attention: { code: 'StateMalformed' as const } });
      }
      const state = loaded.state ?? emptyState(manifestDigest, manifest);
      if (!loaded.state) await atomicWrite(statePath, state);
      return { state, release };
    } catch (error) { await release(); throw error; }
  };

  const selected = await withProcessLock(statePath, async () => acquireState());
  if (!('state' in selected)) return selected;
  let { state, release } = selected;
  try {
    const count = manifest.entries.length;
    let chosen: FleetManifestEntry | undefined;
    let chosenIndex = -1;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (state.cursor + offset) % count;
      const entry = manifest.entries[index]!;
      const id = entry.entryId ?? entry.runId;
      const lease = state.leases[id];
      if (!staleLease(lease)) continue;
      chosen = entry; chosenIndex = index; break;
    }
    if (!chosen) return Object.freeze({ ...resultBase(manifestDigest, state, 'idle', []), attention: { code: 'LeaseBusy' as const } });
    const entryId = chosen.entryId ?? chosen.runId;
    let trusted = await inspectTrustedPath(chosen.runRoot, 'fleet run root', { allowMissing: true, surface: true, kind: 'directory' });
    if (!trusted) {
      const next = { ...state, generation: state.generation + 1, cursor: (chosenIndex + 1) % count, observations: { ...state.observations, [entryId]: { entryId, status: 'attention', code: 'StaleRoot', revision: null } } } as FleetState;
      await atomicWrite(statePath, next); state = next;
      return Object.freeze({ ...resultBase(manifestDigest, state, 'attention', [next.observations[entryId]!]), entryId, attention: { code: 'StaleRoot' as const, entryId } });
    }
    const priorObservation = state.observations[entryId];
    if (priorObservation?.rootIdentity && !sameFilesystemIdentity(priorObservation.rootIdentity, trusted.identity)) {
      return Object.freeze({ ...resultBase(manifestDigest, state, 'attention', [priorObservation]), entryId, attention: { code: 'RootIdentityChanged' as const, entryId } });
    }
    const priorLease = state.leases[entryId];
    let lease: FleetLease = { owner, epoch: (priorLease?.epoch ?? 0) + 1, expiresAt: Date.now() + leaseTtlMs, manifestDigest, rootIdentity: trusted.identity, observedRevision: null };
    state = { ...state, generation: state.generation + 1, leases: { ...state.leases, [entryId]: lease } };
    await atomicWrite(statePath, state);
    await release(); release = async () => undefined;

    // Rebind root and verified kernel state after lease publication. Metadata is
    // never authority; a changed root or plan simply returns attention.
    trusted = await inspectTrustedPath(chosen.runRoot, 'fleet run root', { allowMissing: true, surface: true, kind: 'directory' });
    if (!trusted) return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'StaleRoot', observations, entryId);
    if (!sameFilesystemIdentity(lease.rootIdentity, trusted.identity)) return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'RootIdentityChanged', observations, entryId);
    let loadedRoot;
    try { loadedRoot = await new FileArtifactStore(chosen.runRoot, trusted.identity).load(); }
    catch (error) { return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'StaleRoot', observations, entryId, error instanceof Error ? error.message : String(error)); }
    // Bind the lease to the verified kernel cursor before invoking lifecycle;
    // this is advisory evidence only and cannot authorize a transition.
    const cursorLock = await acquireFileLock(lockPath, owner, 500, staleLockMs, options.signal);
    if (!cursorLock) return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'LeaseLost', observations, entryId);
    let cursorLost = false;
    try {
      const cursorState = await readState(statePath, manifest, manifestDigest);
      const currentLease = cursorState.state?.leases[entryId];
      if (!cursorState.state || !currentLease || currentLease.owner !== owner || currentLease.epoch !== lease.epoch) cursorLost = true;
      else {
        lease = { ...lease, observedRevision: loadedRoot.state?.revision ?? null };
        state = { ...cursorState.state, generation: cursorState.state.generation + 1, leases: { ...cursorState.state.leases, [entryId]: lease } };
        await atomicWrite(statePath, state);
      }
    } finally { await cursorLock(); }
    if (cursorLost) return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'LeaseLost', observations, entryId);
    if (loadedRoot.state && loadedRoot.state.planDigest !== chosen.planDigest) return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'PlanMismatch', observations, entryId);
    if (loadedRoot.state && claimsDigest(canonicalClaims(Object.values(loadedRoot.state.steps))) !== chosen.claimsDigest) return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'ClaimsMismatch', observations, entryId);
    // Cross-run admission is recomputed from the explicit manifest only. A
    // queue/lease cannot authorize a turn and complete roots do not block claims.
    for (const other of manifest.entries) {
      const otherId = other.entryId ?? other.runId;
      if (otherId === entryId || !canonicalClaimsFor(other, other.plan).length || !canonicalClaimsFor(chosen, chosen.plan).length) continue;
      if (!canonicalClaimsFor(other, other.plan).some((x) => canonicalClaimsFor(chosen!, chosen!.plan).some((y) => relationConflictLocal(x, y)))) continue;
      let otherState;
      try {
        const otherRoot = await inspectTrustedPath(other.runRoot, 'fleet peer root', { allowMissing: true, surface: true, kind: 'directory' });
        if (!otherRoot) continue;
        otherState = (await new FileArtifactStore(other.runRoot, otherRoot.identity).load()).state;
      } catch { continue; }
      if (!otherState || otherState.status !== 'COMPLETE') return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'ClaimConflict', observations, entryId, otherId);
    }
    // Expiry itself invalidates the advisory lease, even when no competing
    // process has reclaimed it yet. Never enter the kernel after that fence.
    if (options.signal?.aborted || lease.expiresAt <= Date.now()) return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'LeaseLost', observations, entryId);
    const driver = chosen.driver ?? options.driverFactory?.(chosen);
    if (driver !== undefined && chosen.policy !== undefined) return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'InvalidEntry', observations, entryId, 'entry policy/driver conflict');
    if (!driver && chosen.policy === undefined) return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'InvalidEntry', observations, entryId, 'entry requires driver or policy');
    let lifecycle: LifecycleResult;
    try {
      lifecycle = await resumeRun({ runDir: chosen.runRoot, runId: chosen.runId, plan: chosen.plan, ...(driver === undefined ? { policy: chosen.policy } : { driver }), ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.maxTransitions === undefined ? {} : { maxTransitions: options.maxTransitions }) });
    } catch (error) {
      return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, 'LifecycleError', observations, entryId, error instanceof Error ? error.message : String(error));
    }
    const status: FleetObservation['status'] = lifecycle.status === 'terminal' ? 'advanced' : 'attention';
    const observed: FleetObservation = { entryId, status, ...(lifecycle.stop === undefined ? {} : { stop: lifecycle.stop }), ...(lifecycle.attention?.code === undefined ? {} : { code: lifecycle.attention.code }), revision: lifecycle.yield?.snapshot.revision ?? null, rootIdentity: lease.rootIdentity, resultDigest: digest(lifecycle) };
    observations.push(observed);
    return await finishLease(statePath, manifest, manifestDigest, owner, lease, state, undefined, observations, entryId, undefined, lifecycle);
  } finally {
    try { await release(); } catch { /* metadata cleanup is advisory */ }
  }
}

function relationConflictLocal(a: Claim, b: Claim): boolean { return relationConflict(a, b); }

async function finishLease(statePath: string, manifest: FleetManifest, manifestDigest: string, owner: string, lease: FleetLease, prior: FleetState, code: FleetAttentionCode | undefined, observations: FleetObservation[], entryId: string, detail?: string, lifecycle?: LifecycleResult): Promise<FleetResult> {
  const release = await acquireFileLock(`${statePath}.lock`, owner, 500, Math.max(1000, (lease.expiresAt - Date.now()) * 2));
  if (!release) {
    const result = Object.freeze({ ...resultBase(manifestDigest, prior, 'attention', observations), entryId, leaseEpoch: lease.epoch, ...(lifecycle === undefined ? {} : { lifecycle }), attention: { code: 'LeaseLost' as const, entryId } });
    return result;
  }
  try {
    const loaded = await readState(statePath, manifest, manifestDigest);
    const current = loaded.state;
    if (!current) return Object.freeze({ ...resultBase(manifestDigest, prior, 'attention', observations), entryId, leaseEpoch: lease.epoch, attention: { code: 'LeaseLost' as const, entryId } });
    const currentLease = current.leases[entryId];
    if (!currentLease || currentLease.owner !== owner || currentLease.epoch !== lease.epoch) return Object.freeze({ ...resultBase(manifestDigest, current, 'attention', observations), entryId, leaseEpoch: lease.epoch, ...(lifecycle === undefined ? {} : { lifecycle }), attention: { code: 'LeaseLost' as const, entryId } });
    const obs = observations[observations.length - 1] ?? { entryId, status: 'attention' as const, ...(code === undefined ? {} : { code }), revision: null, rootIdentity: lease.rootIdentity };
    const next: FleetState = { ...current, generation: current.generation + 1, cursor: (manifest.entries.findIndex((entry) => (entry.entryId ?? entry.runId) === entryId) + 1) % manifest.entries.length, leases: { ...current.leases, [entryId]: undefined as never }, observations: { ...current.observations, [entryId]: { ...obs, ...(code === undefined ? {} : { code }) } } };
    const cleanLeases = { ...next.leases }; delete cleanLeases[entryId];
    const committed = { ...next, leases: cleanLeases } as FleetState;
    await atomicWrite(statePath, committed);
    const status: FleetResult['status'] = lifecycle?.status === 'terminal' ? 'advanced' : (lifecycle === undefined && code === undefined ? 'advanced' : 'attention');
    const effectiveCode = code ?? (lifecycle?.status === 'terminal' ? undefined : 'LifecycleError' as const);
    const safeDetail = redactedDetail(detail);
    return Object.freeze({ ...resultBase(manifestDigest, committed, status, observations), entryId, leaseEpoch: lease.epoch, ...(lifecycle === undefined ? {} : { lifecycle }), ...(effectiveCode === undefined ? {} : { attention: { code: effectiveCode, entryId, ...(safeDetail === undefined ? {} : { detail: safeDetail }) } }) });
  } finally { await release(); }
}

export const coordinateFleet = runFleet;
export const fleet = runFleet;

export class FleetCoordinator {
  private readonly options: FleetCoordinatorOptions;
  constructor(options: FleetCoordinatorOptions) { this.options = Object.freeze({ ...options }); }
  run(): Promise<FleetResult> { return runFleet(this.options); }
  coordinate(): Promise<FleetResult> { return this.run(); }
}
