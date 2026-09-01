import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalString, parseCanonical } from './canonical.js';
import { inspectTrustedPath, sameFilesystemIdentity, syncDirectory } from './filesystem.js';

export const RELEASE_EXCLUSION_LOCK = '.lunacy-release-exclusion.lock';
export const BRIDGE_OPERATION_LOCK = '.bridge.lock';
export const WRITER_LOCK = '.writer.lock';
export const BODY_WRITER_LOCK = '.lunacy-body-writer.lock';
export const RETENTION_ADMISSION_LOCK = '.lunacy-retention-admission.lock';
const MAX_CLAIM_ACQUISITION_WAIT_MS = 120_000;
const MANIFEST_V1_SCHEMA = 'lunacy-release-operation/v1';
const MANIFEST_V2_SCHEMA = 'lunacy-release-operation/v2';
const DEPLOYMENT_IDENTITY_SCHEMA = 'lunacy-deployment-identity/v1';
const OWNER_SCHEMA = 'lunacy-release-owner/v1';
const WRITER_RECLAIM_OWNER_SCHEMA = 'lunacy-writer-reclaim-owner/v1';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DISCOVERY_DIRECTORIES = 65_536;
const MAX_DISCOVERY_DEPTH = 64;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PROCESS_ID = 2_147_483_647;
const MANAGED_LAUNCH_DIGEST = createHash('sha256').update('lunacy-managed-launch-admission/v1').digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ReleaseOperation = 'deploy' | 'check' | 'restore';
export type ReleaseManifestV1 = Readonly<{
  schema: typeof MANIFEST_V1_SCHEMA;
  operation: ReleaseOperation;
  installedTarget: string;
  discoveryParents: readonly string[];
  runRoots: readonly string[];
  processSnapshotPath: string;
}>;
export type DeploymentIdentity = Readonly<{
  schema: typeof DEPLOYMENT_IDENTITY_SCHEMA;
  runtimeVersion: string;
  bridgeVersion: string;
  sourceDigest: string;
  deploymentManifestDigest: string;
  launcherDigest: string;
  inventoryDigest: string;
  inventoryAggregate: string;
  fileCount: number;
}>;
export type ExactLegacyDeployManifest = Readonly<{
  schema: typeof MANIFEST_V2_SCHEMA;
  operation: 'deploy-exact-0.2.12';
  installedTarget: string;
  discoveryParents: readonly string[];
  runRoots: readonly string[];
  processSnapshotPath: string;
  installedDeployment: DeploymentIdentity;
  candidateDeployment: DeploymentIdentity;
}>;
export type ReleaseManifest = ReleaseManifestV1 | ExactLegacyDeployManifest;
export type ReleaseOwner = Readonly<{
  schema: typeof OWNER_SCHEMA;
  id: string;
  pid: number;
  processStartedAt: string;
  acquiredAt: string;
  manifestDigest: string;
}>;
export type OwnedFileClaim = Readonly<{
  path: string;
  bytes: string;
  owner: ReleaseOwner;
  release(): Promise<void>;
}>;
type WriterReclaimOwner = Readonly<{
  schema: typeof WRITER_RECLAIM_OWNER_SCHEMA;
  id: string;
  pid: number;
  processStartedAt: string;
  acquiredAt: string;
}>;
export type WriterReclaimMarkerObservation =
  | Readonly<{ state: 'ABSENT' | 'LIVE' | 'CONTENDED' }>
  | Readonly<{ state: 'STALE'; text: string; identity: { dev: string; ino: string } }>;
export type WriterReclaimMarkerClaim = Readonly<{
  path: string;
  bytes: string;
  release(): Promise<void>;
}>;
type ManagedLaunchOwnerState = 'LIVE' | 'STALE' | 'CONTENDED';
type OwnedFileClaimOptions = Readonly<{
  waitMs: number;
  signal?: AbortSignal;
  reclaimStaleReleaseOwner?: boolean;
  nonReleaseOwnerIsBusy?: boolean;
  writerReclaimProtocol?: boolean;
  label: string;
}>;

function fail(message: string): never { throw new Error(`ReleaseExclusion: ${message}`); }
function stableCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function pathWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(stableCompare); const wanted = [...expected].sort(stableCompare);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields are not closed`);
}
function canonicalPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value) || resolve(value) !== value) fail(`${label} is not an absolute canonical path`);
  return value;
}
function canonicalPaths(value: unknown, label: string, allowEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 4096) fail(`${label} is invalid`);
  const paths = value.map((item, index) => canonicalPath(item, `${label} ${index}`));
  const sorted = [...paths].sort(stableCompare);
  if (new Set(paths).size !== paths.length || paths.some((item, index) => item !== sorted[index])) fail(`${label} must be unique and byte-sorted`);
  return Object.freeze(paths);
}

export function validateDeploymentIdentity(value: unknown, label = 'deployment identity'): DeploymentIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is malformed`);
  const object = value as Record<string, unknown>;
  exactKeys(object, ['schema', 'runtimeVersion', 'bridgeVersion', 'sourceDigest', 'deploymentManifestDigest', 'launcherDigest', 'inventoryDigest', 'inventoryAggregate', 'fileCount'], label);
  if (object.schema !== DEPLOYMENT_IDENTITY_SCHEMA) fail(`${label} schema is invalid`);
  for (const field of ['runtimeVersion', 'bridgeVersion'] as const) { const fieldValue = object[field]; if (typeof fieldValue !== 'string' || fieldValue.length === 0 || fieldValue.includes('\0')) fail(`${label} ${field} is invalid`); }
  for (const field of ['sourceDigest', 'deploymentManifestDigest', 'launcherDigest', 'inventoryDigest', 'inventoryAggregate'] as const) { const fieldValue = object[field]; if (typeof fieldValue !== 'string' || !SHA256.test(fieldValue)) fail(`${label} ${field} is invalid`); }
  if (!Number.isSafeInteger(object.fileCount) || (object.fileCount as number) <= 0 || (object.fileCount as number) > 65_536) fail(`${label} file count is invalid`);
  return Object.freeze({
    schema: DEPLOYMENT_IDENTITY_SCHEMA,
    runtimeVersion: object.runtimeVersion as string,
    bridgeVersion: object.bridgeVersion as string,
    sourceDigest: object.sourceDigest as string,
    deploymentManifestDigest: object.deploymentManifestDigest as string,
    launcherDigest: object.launcherDigest as string,
    inventoryDigest: object.inventoryDigest as string,
    inventoryAggregate: object.inventoryAggregate as string,
    fileCount: object.fileCount as number,
  });
}

export function validateReleaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('manifest is malformed');
  const object = value as Record<string, unknown>;
  const isExactLegacyDeploy = object.schema === MANIFEST_V2_SCHEMA;
  exactKeys(object, isExactLegacyDeploy
    ? ['schema', 'operation', 'installedTarget', 'discoveryParents', 'runRoots', 'processSnapshotPath', 'installedDeployment', 'candidateDeployment']
    : ['schema', 'operation', 'installedTarget', 'discoveryParents', 'runRoots', 'processSnapshotPath'], 'manifest');
  if (isExactLegacyDeploy ? object.operation !== 'deploy-exact-0.2.12' : object.schema !== MANIFEST_V1_SCHEMA || !['deploy', 'check', 'restore'].includes(String(object.operation))) fail('manifest schema or operation is invalid');
  const installedTarget = canonicalPath(object.installedTarget, 'installed target');
  const discoveryParents = canonicalPaths(object.discoveryParents, 'discovery parents', false);
  const runRoots = canonicalPaths(object.runRoots, 'run roots', true);
  const processSnapshotPath = canonicalPath(object.processSnapshotPath, 'process snapshot path');
  if (pathWithin(installedTarget, processSnapshotPath) || discoveryParents.some((parent) => pathWithin(parent, processSnapshotPath))) fail('process snapshot path must be outside release-owned trees');
  for (let left = 0; left < discoveryParents.length; left += 1) for (let right = left + 1; right < discoveryParents.length; right += 1) {
    if (pathWithin(discoveryParents[left]!, discoveryParents[right]!) || pathWithin(discoveryParents[right]!, discoveryParents[left]!)) fail('discovery parents overlap');
  }
  for (let left = 0; left < runRoots.length; left += 1) for (let right = left + 1; right < runRoots.length; right += 1) {
    if (pathWithin(runRoots[left]!, runRoots[right]!) || pathWithin(runRoots[right]!, runRoots[left]!)) fail('run roots overlap');
  }
  for (const root of runRoots) if (!discoveryParents.some((parent) => pathWithin(parent, root))) fail(`run root is outside every discovery parent: ${root}`);
  if (!isExactLegacyDeploy) return Object.freeze({ schema: MANIFEST_V1_SCHEMA, operation: object.operation as ReleaseOperation, installedTarget, discoveryParents, runRoots, processSnapshotPath });
  if (runRoots.length !== 0) fail('exact 0.2.12 deploy requires an empty run-root set');
  const installedDeployment = validateDeploymentIdentity(object.installedDeployment, 'installed deployment identity');
  const candidateDeployment = validateDeploymentIdentity(object.candidateDeployment, 'candidate deployment identity');
  if (installedDeployment.runtimeVersion !== '0.2.12' || installedDeployment.bridgeVersion !== '0.1.0') fail('installed deployment identity is not exact 0.2.12');
  if (candidateDeployment.runtimeVersion !== '0.3.0' || candidateDeployment.bridgeVersion !== '0.2.0') fail('candidate deployment identity is not exact 0.3.0');
  return Object.freeze({ schema: MANIFEST_V2_SCHEMA, operation: 'deploy-exact-0.2.12', installedTarget, discoveryParents, runRoots: Object.freeze([]), processSnapshotPath, installedDeployment, candidateDeployment });
}

export async function readReleaseManifest(path: string): Promise<{ manifest: ReleaseManifest; digest: string; bytes: string }> {
  const canonical = canonicalPath(path, 'manifest path');
  const trusted = await inspectTrustedPath(canonical, 'release manifest', { surface: true, kind: 'file' }).catch((error) => fail(`manifest is unreadable: ${(error as Error).message}`));
  if (!trusted || trusted.stat.size < 1 || trusted.stat.size > MAX_MANIFEST_BYTES) fail('manifest is absent or exceeds its byte limit');
  const handle = await fs.open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('manifest is not UTF-8');
  let value: unknown;
  try { value = parseCanonical(text); } catch (error) { fail(`manifest is not canonical JSON: ${(error as Error).message}`); }
  const manifest = validateReleaseManifest(value);
  if (canonicalString(manifest) !== text) fail('manifest bytes are not canonical');
  return { manifest, digest: createHash('sha256').update(bytes).digest('hex'), bytes: text };
}

// undefined proves that the pid does not exist; null means that liveness or
// exact start evidence could not be established and must be treated as live.
function processStart(pid: number): string | null | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PROCESS_ID) return undefined;
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null;
  }
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return null;
  const value = result.stdout.trim().replace(/\s+/g, ' ');
  return value.length > 0 ? value : null;
}

export function currentReleaseOwner(manifestDigest: string, now = new Date()): ReleaseOwner {
  if (!SHA256.test(manifestDigest)) fail('manifest digest is invalid');
  const processStartedAt = processStart(process.pid);
  if (!processStartedAt) fail('current process start evidence is unavailable');
  return Object.freeze({ schema: OWNER_SCHEMA, id: randomUUID(), pid: process.pid, processStartedAt, acquiredAt: now.toISOString(), manifestDigest });
}

function parseOwner(text: string): ReleaseOwner {
  let value: unknown;
  try { value = parseCanonical(text); } catch { fail('owner record is not canonical JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('owner record is malformed');
  const object = value as Record<string, unknown>;
  exactKeys(object, ['schema', 'id', 'pid', 'processStartedAt', 'acquiredAt', 'manifestDigest'], 'owner record');
  if (object.schema !== OWNER_SCHEMA || typeof object.id !== 'string' || !UUID.test(object.id) || !Number.isSafeInteger(object.pid) || (object.pid as number) <= 0 || typeof object.processStartedAt !== 'string' || object.processStartedAt.length === 0 || typeof object.acquiredAt !== 'string' || Number.isNaN(Date.parse(object.acquiredAt)) || typeof object.manifestDigest !== 'string' || !SHA256.test(object.manifestDigest)) fail('owner record is malformed');
  return Object.freeze(object as ReleaseOwner);
}

export function releaseOwnerIsLive(owner: ReleaseOwner): boolean {
  const started = processStart(owner.pid);
  return started === null || (started !== undefined && started === owner.processStartedAt);
}

/** Classify only the exact canonical owner record minted by managed launch. */
export function managedLaunchOwnerLiveness(text: string): ManagedLaunchOwnerState | undefined {
  let owner: ReleaseOwner;
  try { owner = parseOwner(text); }
  catch { return undefined; }
  if (canonicalString(owner) !== text || owner.pid > MAX_PROCESS_ID || owner.manifestDigest !== MANAGED_LAUNCH_DIGEST) return undefined;
  const started = processStart(owner.pid);
  if (started === null) return 'CONTENDED';
  return started !== undefined && started === owner.processStartedAt ? 'LIVE' : 'STALE';
}

async function readExact(path: string, label: string): Promise<{ text: string; identity: { dev: string; ino: string } }> {
  const before = await inspectTrustedPath(path, label, { allowMissing: true, surface: true, kind: 'file' }).catch((error) => fail(`${label} is unreadable: ${(error as Error).message}`));
  if (!before) { const error = new Error(`${label} is absent`) as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; }
  if (before.stat.size < 1 || before.stat.size > MAX_MANIFEST_BYTES) fail(`${label} is too large`);
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  const after = await inspectTrustedPath(path, label, { surface: true, kind: 'file' }).catch(() => undefined);
  if (!after || !sameFilesystemIdentity(before.identity, after.identity)) fail(`${label} changed during read`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail(`${label} is not UTF-8`);
  return { text, identity: before.identity };
}

async function unlinkExact(path: string, expectedText: string, expectedIdentity: { dev: string; ino: string }, directory: string, label: string): Promise<void> {
  const current = await readExact(path, label);
  if (current.text !== expectedText || !sameFilesystemIdentity(current.identity, expectedIdentity)) fail(`${label} ownership changed`);
  await fs.unlink(path);
  await syncDirectory(directory, `${label} parent`);
}

function parseWriterReclaimOwner(text: string): WriterReclaimOwner | undefined {
  let value: unknown;
  try { value = parseCanonical(text); }
  catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort(stableCompare);
  const expected = ['schema', 'id', 'pid', 'processStartedAt', 'acquiredAt'].sort(stableCompare);
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return undefined;
  if (object.schema !== WRITER_RECLAIM_OWNER_SCHEMA || typeof object.id !== 'string' || !UUID.test(object.id)
    || !Number.isSafeInteger(object.pid) || (object.pid as number) <= 0 || (object.pid as number) > MAX_PROCESS_ID
    || typeof object.processStartedAt !== 'string' || object.processStartedAt.length === 0
    || typeof object.acquiredAt !== 'string' || Number.isNaN(Date.parse(object.acquiredAt))) return undefined;
  const owner = Object.freeze(object as WriterReclaimOwner);
  return canonicalString(owner) === text ? owner : undefined;
}

/** Inspect the private shared writer-reclaim marker without granting mutation
 * authority to malformed records or owners whose liveness cannot be proven. */
export async function inspectWriterReclaimMarker(path: string, label: string): Promise<WriterReclaimMarkerObservation> {
  let observed: Awaited<ReturnType<typeof readExact>>;
  try { observed = await readExact(path, label); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze({ state: 'ABSENT' });
    if ((error as Error).message.endsWith('changed during read')) return Object.freeze({ state: 'CONTENDED' });
    throw error;
  }
  const owner = parseWriterReclaimOwner(observed.text);
  if (!owner) return Object.freeze({ state: 'CONTENDED' });
  const started = processStart(owner.pid);
  if (started === null) return Object.freeze({ state: 'CONTENDED' });
  if (started === owner.processStartedAt) return Object.freeze({ state: 'LIVE' });
  return Object.freeze({ state: 'STALE', text: observed.text, identity: observed.identity });
}

/** Remove only the exact stale marker classified by inspectWriterReclaimMarker.
 * A missing or replaced marker is an ordinary lost race, not authority to
 * remove the replacement. */
export async function removeStaleWriterReclaimMarker(path: string, observation: WriterReclaimMarkerObservation, label: string): Promise<boolean> {
  if (observation.state !== 'STALE') return false;
  try { await unlinkExact(path, observation.text, observation.identity, dirname(path), label); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as Error).message.endsWith('ownership changed') || (error as Error).message.endsWith('changed during read')) return false;
    throw error;
  }
  return true;
}

/** Publish an owner-bound marker atomically. A crash can leave either no
 * marker or one complete record whose exact process start can later be
 * classified; an empty marker namespace is never visible. */
export async function tryAcquireWriterReclaimMarker(path: string, label: string): Promise<WriterReclaimMarkerClaim | undefined> {
  const canonical = canonicalPath(path, label);
  const directory = dirname(canonical);
  const processStartedAt = processStart(process.pid);
  if (!processStartedAt) fail(`${label} current process start evidence is unavailable`);
  const owner: WriterReclaimOwner = Object.freeze({
    schema: WRITER_RECLAIM_OWNER_SCHEMA,
    id: randomUUID(),
    pid: process.pid,
    processStartedAt,
    acquiredAt: new Date().toISOString(),
  });
  const bytes = canonicalString(owner);
  const temporary = `${canonical}.new-${process.pid}-${randomUUID()}`;
  let handle;
  let identity: { dev: string; ino: string } | undefined;
  let linked = false;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    const stat = await handle.stat();
    identity = Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
    await handle.close(); handle = undefined;
    try { await fs.link(temporary, canonical); linked = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined; throw error; }
    await syncDirectory(directory, `${label} parent`);
  } catch (error) {
    if (linked && identity) await unlinkExact(canonical, bytes, identity, directory, label).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
  }
  let released = false;
  return Object.freeze({
    path: canonical,
    bytes,
    async release(): Promise<void> {
      if (released) return;
      await unlinkExact(canonical, bytes, identity!, directory, label);
      released = true;
    },
  });
}

export async function acquireOwnedFileClaim(path: string, owner: ReleaseOwner, options: OwnedFileClaimOptions): Promise<OwnedFileClaim> {
  const canonical = canonicalPath(path, options.label);
  const directory = dirname(canonical);
  const directoryTrusted = await inspectTrustedPath(directory, `${options.label} parent`, { surface: true, kind: 'directory' }).catch((error) => fail(`${options.label} parent is unreadable: ${(error as Error).message}`));
  if (!directoryTrusted) fail(`${options.label} parent is absent`);
  if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > MAX_CLAIM_ACQUISITION_WAIT_MS) fail(`${options.label} wait is invalid`);
  const bytes = canonicalString(owner);
  const deadline = Date.now() + options.waitMs;
  const reclaimMarker = options.writerReclaimProtocol ? `${canonical}.reclaim` : undefined;
  const inspectMarker = async (): Promise<WriterReclaimMarkerObservation> => reclaimMarker
    ? inspectWriterReclaimMarker(reclaimMarker, `${options.label} reclaim marker`)
    : Object.freeze({ state: 'ABSENT' });
  const waitForContention = async (): Promise<void> => {
    if (Date.now() >= deadline) fail(`${options.label} is busy`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  };
  const reclaimExisting = async (): Promise<boolean> => {
    let observed: Awaited<ReturnType<typeof readExact>>;
    try { observed = await readExact(canonical, options.label); }
    catch (readError) {
      // A contender may remove its exact claim between the two identity
      // reads. Retry acquisition, but never interpret an identity change
      // as authority to unlink either the old or replacement owner.
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT' || (readError as Error).message.endsWith('changed during read')) return true;
      throw readError;
    }
    let observedOwner: ReleaseOwner | undefined;
    try { observedOwner = parseOwner(observed.text); }
    catch (parseError) { if (!options.nonReleaseOwnerIsBusy) throw parseError; }
    if (!observedOwner || releaseOwnerIsLive(observedOwner)) return false;
    try { await unlinkExact(canonical, observed.text, observed.identity, directory, options.label); }
    catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code === 'ENOENT' || (unlinkError as Error).message.endsWith('changed during read')) return true;
      throw unlinkError;
    }
    return true;
  };
  const observeExisting = async (): Promise<void> => {
    let observed: Awaited<ReturnType<typeof readExact>>;
    try { observed = await readExact(canonical, options.label); }
    catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT' || (readError as Error).message.endsWith('changed during read')) return;
      throw readError;
    }
    try { parseOwner(observed.text); }
    catch (parseError) { if (!options.nonReleaseOwnerIsBusy) throw parseError; }
  };
  while (true) {
    if (options.signal?.aborted) { const error = new Error(`${options.label} acquisition cancelled`); error.name = 'AbortError'; throw error; }
    const existingMarker = await inspectMarker();
    if (existingMarker.state !== 'ABSENT') {
      if (existingMarker.state === 'STALE') {
        await removeStaleWriterReclaimMarker(reclaimMarker!, existingMarker, `${options.label} reclaim marker`);
        continue;
      }
      await observeExisting(); await waitForContention(); continue;
    }
    let handle;
    try { handle = await fs.open(canonical, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (options.reclaimStaleReleaseOwner) {
        let markerClaim: WriterReclaimMarkerClaim | undefined;
        if (reclaimMarker) {
          markerClaim = await tryAcquireWriterReclaimMarker(reclaimMarker, `${options.label} reclaim marker`);
          if (!markerClaim) {
            const marker = await inspectMarker();
            if (marker.state === 'ABSENT') continue;
            if (marker.state === 'STALE') {
              await removeStaleWriterReclaimMarker(reclaimMarker, marker, `${options.label} reclaim marker`);
              continue;
            }
            await observeExisting();
            await waitForContention();
            continue;
          }
        }
        try {
          if (await reclaimExisting()) continue;
        } finally {
          await markerClaim?.release();
        }
      }
      await waitForContention();
      continue;
    }
    let identity: { dev: string; ino: string };
    try {
      await handle.writeFile(bytes, 'utf8'); await handle.sync(); await syncDirectory(directory, `${options.label} parent`);
      const stat = await handle.stat(); identity = Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(canonical).catch(() => undefined);
      await syncDirectory(directory, `${options.label} parent`).catch(() => undefined);
      throw error;
    }
    let markerAppeared: WriterReclaimMarkerObservation;
    try { markerAppeared = await inspectMarker(); }
    catch (error) {
      try { await unlinkExact(canonical, bytes, identity, directory, options.label); }
      finally { await handle.close(); }
      throw error;
    }
    if (markerAppeared.state !== 'ABSENT') {
      try { await unlinkExact(canonical, bytes, identity, directory, options.label); }
      finally { await handle.close(); }
      if (markerAppeared.state === 'STALE') await removeStaleWriterReclaimMarker(reclaimMarker!, markerAppeared, `${options.label} reclaim marker`);
      await waitForContention();
      continue;
    }
    let released = false;
    return Object.freeze({
      path: canonical, bytes, owner,
      async release(): Promise<void> {
        if (released) return;
        released = true;
        try { await unlinkExact(canonical, bytes, identity, directory, options.label); }
        finally { await handle.close(); }
      },
    });
  }
}

export async function assertReleaseAdmissionOpen(runRoot: string): Promise<void> {
  const root = canonicalPath(resolve(runRoot), 'run root');
  let directory = root;
  while (true) {
    const marker = join(directory, RELEASE_EXCLUSION_LOCK);
    const found = await inspectTrustedPath(marker, 'release exclusion marker', { allowMissing: true, surface: true, kind: 'file' }).catch((error) => fail(`release exclusion marker is unsafe: ${(error as Error).message}`));
    if (found) fail(`release exclusion is held at ${directory}`);
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

const RETENTION_WAIT_MS = 120_000;

function retentionOwner(operation: 'ADMIT' | 'WRITE' | 'FINALIZE' | 'ABANDON', installedRuntime: string, runRoot: string): ReleaseOwner {
  return currentReleaseOwner(createHash('sha256').update(canonicalString({
    schema: 'lunacy-retention-admission/v1', installedRuntime, runRoot, operation,
  })).digest('hex'));
}

async function canonicalPhysicalDirectory(path: string, label: string): Promise<string> {
  const canonical = canonicalPath(resolve(path), label);
  const physical = resolve(await fs.realpath(canonical).catch((error) => fail(`${label} is unreadable: ${(error as Error).message}`)));
  const trusted = await inspectTrustedPath(physical, label, { surface: true, kind: 'directory' }).catch((error) => fail(`${label} is unsafe: ${(error as Error).message}`));
  if (!trusted) fail(`${label} is absent`);
  return physical;
}

async function readRetentionPolicy(runtime: string): Promise<Readonly<{ newBodyAdmission: 'ON' | 'OFF'; abandonment: 'ON' | 'OFF' }>> {
  const path = join(runtime, 'retention-policy.json');
  const trusted = await inspectTrustedPath(path, 'retention policy', { surface: true, kind: 'file' }).catch((error) => fail(`retention policy is unsafe: ${(error as Error).message}`));
  if (!trusted || trusted.stat.size < 1 || trusted.stat.size > 1024 || trusted.stat.nlink !== 1) fail('retention policy is absent or invalid');
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Buffer;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  const text = bytes.toString('utf8');
  let value: unknown; try { if (!text.endsWith('\n')) throw new Error('missing newline'); value = parseCanonical<unknown>(text.slice(0, -1)); } catch { fail('retention policy is not canonical'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('retention policy is not canonical'); const policy = value as Record<string, unknown>;
  if (Object.keys(policy).sort().join(',') !== 'abandonment,newBodyAdmission,schema' || policy.schema !== 'lunacy-retention-policy/v1' || !['OFF', 'ON'].includes(policy.newBodyAdmission as string) || !['OFF', 'ON'].includes(policy.abandonment as string)) fail('retention policy is not canonical');
  return Object.freeze({ newBodyAdmission: policy.newBodyAdmission as 'ON' | 'OFF', abandonment: policy.abandonment as 'ON' | 'OFF' });
}

export async function withRunAbandonmentPolicy<T>(installedRuntimeInput: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  if (typeof operation !== 'function') fail('abandonment operation callback is required'); const installedRuntime = await canonicalPhysicalDirectory(installedRuntimeInput, 'installed runtime'); const owner = retentionOwner('ABANDON', installedRuntime, '');
  const claim = await acquireOwnedFileClaim(join(dirname(installedRuntime), RETENTION_ADMISSION_LOCK), owner, { waitMs: RETENTION_WAIT_MS, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, writerReclaimProtocol: true, label: 'retention abandonment policy' });
  try { if ((await readRetentionPolicy(installedRuntime)).abandonment !== 'ON') fail('run abandonment is OFF'); return await operation(); }
  finally { await claim.release(); }
}

async function assertBodyWritableState(runRoot: string): Promise<void> {
  const body = await inspectTrustedPath(join(runRoot, '.work'), 'run Body', { allowMissing: true, surface: true, kind: 'directory' }).catch((error) => fail(`run Body is unsafe: ${(error as Error).message}`));
  if (!body) fail('run Body is not admitted');
  for (const name of ['RUN-RECEIPT.json', 'ABANDON-RECEIPT.json', '.lunacy-run-finalization.json', '.RUN-RECEIPT.json.tmp', '.ABANDON-RECEIPT.json.tmp']) {
    const terminal = await inspectTrustedPath(join(runRoot, name), `retention terminal ${name}`, { allowMissing: true, surface: true }).catch((error) => fail(`retention terminal is unsafe: ${(error as Error).message}`));
    if (terminal) fail('run Body is terminal or finalizing');
  }
  const names = await fs.readdir(runRoot);
  if (names.some((name) => name.startsWith('.work.prune-'))) fail('run Body has a finalization tombstone');
}

/** Maintained Body publication fence: release-open, Body claim, release-open. */
export async function withBodyWriterAdmission<T>(runRootInput: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  if (typeof operation !== 'function') fail('Body writer operation callback is required');
  const runRoot = await canonicalPhysicalDirectory(runRootInput, 'run root');
  await assertReleaseAdmissionOpen(runRoot);
  const owner = retentionOwner('WRITE', '', runRoot);
  const claim = await acquireOwnedFileClaim(join(runRoot, BODY_WRITER_LOCK), owner, { waitMs: RETENTION_WAIT_MS, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, writerReclaimProtocol: true, label: 'Body writer admission' });
  try {
    await assertReleaseAdmissionOpen(runRoot);
    await assertBodyWritableState(runRoot);
    return await operation();
  } finally { await claim.release(); }
}

/** The only first-Body creation surface. Policy and run claims linearize ON/OFF. */
export async function admitRunBody(installedRuntimeInput: string, runRootInput: string, signal?: AbortSignal): Promise<'ADMITTED' | 'ALREADY_ADMITTED'> {
  const installedRuntime = await canonicalPhysicalDirectory(installedRuntimeInput, 'installed runtime');
  const runRoot = await canonicalPhysicalDirectory(runRootInput, 'run root');
  const owner = retentionOwner('ADMIT', installedRuntime, runRoot);
  const claims: OwnedFileClaim[] = [];
  try {
    claims.push(await acquireOwnedFileClaim(join(dirname(installedRuntime), RETENTION_ADMISSION_LOCK), owner, { waitMs: RETENTION_WAIT_MS, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, writerReclaimProtocol: true, label: 'retention policy admission' }));
    if ((await readRetentionPolicy(installedRuntime)).newBodyAdmission !== 'ON') fail('new Body admission is OFF');
    claims.push(await acquireOwnedFileClaim(join(runRoot, RELEASE_EXCLUSION_LOCK), owner, { waitMs: RETENTION_WAIT_MS, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, label: 'run release admission' }));
    claims.push(await acquireOwnedFileClaim(join(runRoot, BODY_WRITER_LOCK), owner, { waitMs: RETENTION_WAIT_MS, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, writerReclaimProtocol: true, label: 'Body writer admission' }));
    if ((await readRetentionPolicy(installedRuntime)).newBodyAdmission !== 'ON') fail('new Body admission is OFF');
    const existing = await inspectTrustedPath(join(runRoot, '.work'), 'run Body', { allowMissing: true, surface: true, kind: 'directory' }).catch((error) => fail(`run Body is unsafe: ${(error as Error).message}`));
    if (existing) { await assertBodyWritableState(runRoot); return 'ALREADY_ADMITTED'; }
    for (const name of ['RUN-RECEIPT.json', 'ABANDON-RECEIPT.json', '.lunacy-run-finalization.json']) if (await inspectTrustedPath(join(runRoot, name), `retention terminal ${name}`, { allowMissing: true, surface: true })) fail('terminal run cannot admit Body');
    if ((await fs.readdir(runRoot)).some((name) => name.startsWith('.work.prune-'))) fail('finalizing run cannot admit Body');
    await fs.mkdir(join(runRoot, '.work'), { mode: 0o700 });
    await syncDirectory(join(runRoot, '.work'), 'new Body');
    await syncDirectory(runRoot, 'run root');
    return 'ADMITTED';
  } finally {
    let failure: unknown;
    for (const claim of claims.reverse()) try { await claim.release(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
}

export type RunFinalizationOwnership = Readonly<{ owner: ReleaseOwner; claims: readonly OwnedFileClaim[] }>;

/** Exact finalizer order: run release, Body writer, bridge, store writer. */
export async function withRunFinalizationExclusion<T>(runRootInput: string, signal: AbortSignal | undefined, operation: (ownership: RunFinalizationOwnership) => Promise<T>): Promise<T> {
  if (typeof operation !== 'function') fail('finalization callback is required');
  const runRoot = await canonicalPhysicalDirectory(runRootInput, 'run root');
  const owner = retentionOwner('FINALIZE', '', runRoot);
  const claims: OwnedFileClaim[] = [];
  try {
    claims.push(await acquireOwnedFileClaim(join(runRoot, RELEASE_EXCLUSION_LOCK), owner, { waitMs: RETENTION_WAIT_MS, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, label: 'run finalization release exclusion' }));
    claims.push(await acquireOwnedFileClaim(join(runRoot, BODY_WRITER_LOCK), owner, { waitMs: RETENTION_WAIT_MS, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, writerReclaimProtocol: true, label: 'run finalization Body exclusion' }));
    const kernel = await inspectTrustedPath(join(runRoot, '.kernel'), 'managed run kernel', { allowMissing: true, surface: true, kind: 'directory' }).catch((error) => fail(`managed run kernel is unsafe: ${(error as Error).message}`));
    if (kernel) {
      claims.push(await acquireOwnedFileClaim(join(runRoot, '.kernel', BRIDGE_OPERATION_LOCK), owner, { waitMs: RETENTION_WAIT_MS, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, label: 'run finalization bridge exclusion' }));
      claims.push(await acquireOwnedFileClaim(join(runRoot, '.kernel', WRITER_LOCK), owner, { waitMs: RETENTION_WAIT_MS, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, writerReclaimProtocol: true, label: 'run finalization writer exclusion' }));
    }
    return await operation(Object.freeze({ owner, claims: Object.freeze([...claims]) }));
  } finally {
    let failure: unknown;
    for (const claim of claims.reverse()) try { await claim.release(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  }
}

/**
 * Keep the final asynchronous managed-launch preparation inside the existing
 * run writer fence. The kernel's claim fence may be released as soon as a
 * driver Promise is observed, so the driver takes this second, short-lived
 * claim through immutable launch-record publication. A release marker that
 * wins first rejects the launch; a launch claim that wins first remains
 * visible and the release waits for it before verification.
 *
 * Disposable direct-driver fixtures have no CURRENT and retain their prior
 * interface; production managed roots necessarily have CURRENT and use the
 * exclusion protocol.
 */
export async function withManagedLaunchAdmission<T>(runRoot: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  const root = canonicalPath(resolve(runRoot), 'run root');
  await assertReleaseAdmissionOpen(root);
  const current = await inspectTrustedPath(join(root, '.kernel', 'CURRENT'), 'managed launch CURRENT', { allowMissing: true, surface: true, kind: 'file' }).catch((error) => fail(`managed launch CURRENT is unsafe: ${(error as Error).message}`));
  if (!current) { await assertReleaseAdmissionOpen(root); return operation(); }
  const owner = currentReleaseOwner(MANAGED_LAUNCH_DIGEST);
  const claim = await acquireOwnedFileClaim(join(root, '.kernel', WRITER_LOCK), owner, { waitMs: MAX_CLAIM_ACQUISITION_WAIT_MS, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, writerReclaimProtocol: true, label: 'managed launch writer admission' });
  try { await assertReleaseAdmissionOpen(root); return await operation(); }
  finally { await claim.release(); }
}

export async function discoverManagedRunRoots(parents: readonly string[]): Promise<readonly string[]> {
  const roots: string[] = []; let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DISCOVERY_DEPTH || ++visited > MAX_DISCOVERY_DIRECTORIES) fail('discovery boundary exceeds its bound');
    const trusted = await inspectTrustedPath(directory, 'discovery directory', { surface: true, kind: 'directory' }).catch((error) => fail(`discovery directory is unsafe: ${(error as Error).message}`));
    if (!trusted) fail(`discovery directory disappeared: ${directory}`);
    const current = await inspectTrustedPath(join(directory, '.kernel', 'CURRENT'), 'discovered CURRENT', { allowMissing: true, surface: true, kind: 'file' }).catch((error) => fail(`discovered CURRENT is unsafe: ${(error as Error).message}`));
    if (current) roots.push(directory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => stableCompare(a.name, b.name));
    for (const entry of entries) {
      if (entry.name === RELEASE_EXCLUSION_LOCK || entry.name === '.kernel' || entry.name === '.codex-effects') continue;
      if (entry.isSymbolicLink()) fail(`discovery boundary contains symlink ${join(directory, entry.name)}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), depth + 1);
    }
  };
  for (const parent of parents) await visit(parent, 0);
  roots.sort(stableCompare);
  if (new Set(roots).size !== roots.length) fail('discovery aliases a managed run root');
  return Object.freeze(roots);
}

export function assertExactDiscoveredRoots(manifest: ReleaseManifest, discovered: readonly string[]): void {
  if (discovered.length !== manifest.runRoots.length || discovered.some((root, index) => root !== manifest.runRoots[index])) fail(`discovered run-root set differs from release manifest`);
}

/** Re-prove the manifest's closed discovery-parent/run-root census. */
export async function verifyClosedReleaseRoots(manifestInput: ReleaseManifest): Promise<readonly string[]> {
  const manifest = validateReleaseManifest(manifestInput);
  const discovered = await discoverManagedRunRoots(manifest.discoveryParents);
  assertExactDiscoveredRoots(manifest, discovered);
  return discovered;
}
