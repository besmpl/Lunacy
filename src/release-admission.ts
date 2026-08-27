import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalString, parseCanonical } from './canonical.js';
import { inspectTrustedPath, sameFilesystemIdentity, syncDirectory } from './filesystem.js';

export const RELEASE_EXCLUSION_LOCK = '.lunacy-release-exclusion.lock';
export const BRIDGE_OPERATION_LOCK = '.bridge.lock';
export const WRITER_LOCK = '.writer.lock';
const MANIFEST_V1_SCHEMA = 'lunacy-release-operation/v1';
const MANIFEST_V2_SCHEMA = 'lunacy-release-operation/v2';
const DEPLOYMENT_IDENTITY_SCHEMA = 'lunacy-deployment-identity/v1';
const OWNER_SCHEMA = 'lunacy-release-owner/v1';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_DISCOVERY_DIRECTORIES = 65_536;
const MAX_DISCOVERY_DEPTH = 64;
const SHA256 = /^[0-9a-f]{64}$/;
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
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
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

export async function acquireOwnedFileClaim(path: string, owner: ReleaseOwner, options: Readonly<{ waitMs: number; signal?: AbortSignal; reclaimStaleReleaseOwner?: boolean; nonReleaseOwnerIsBusy?: boolean; label: string }>): Promise<OwnedFileClaim> {
  const canonical = canonicalPath(path, options.label);
  const directory = dirname(canonical);
  const directoryTrusted = await inspectTrustedPath(directory, `${options.label} parent`, { surface: true, kind: 'directory' }).catch((error) => fail(`${options.label} parent is unreadable: ${(error as Error).message}`));
  if (!directoryTrusted) fail(`${options.label} parent is absent`);
  if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > 120_000) fail(`${options.label} wait is invalid`);
  const bytes = canonicalString(owner);
  const deadline = Date.now() + options.waitMs;
  while (true) {
    if (options.signal?.aborted) { const error = new Error(`${options.label} acquisition cancelled`); error.name = 'AbortError'; throw error; }
    let handle;
    try { handle = await fs.open(canonical, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (options.reclaimStaleReleaseOwner) {
        let observed: Awaited<ReturnType<typeof readExact>>;
        try { observed = await readExact(canonical, options.label); }
        catch (readError) {
          // A contender may remove its exact claim between the two identity
          // reads. Retry acquisition, but never interpret an identity change
          // as authority to unlink either the old or replacement owner.
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT' || (readError as Error).message.endsWith('changed during read')) continue;
          throw readError;
        }
        let observedOwner: ReleaseOwner | undefined;
        try { observedOwner = parseOwner(observed.text); }
        catch (parseError) { if (!options.nonReleaseOwnerIsBusy) throw parseError; }
        if (observedOwner && !releaseOwnerIsLive(observedOwner)) {
          await unlinkExact(canonical, observed.text, observed.identity, directory, options.label);
          continue;
        }
      }
      if (Date.now() >= deadline) fail(`${options.label} is busy`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
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
  const claim = await acquireOwnedFileClaim(join(root, '.kernel', WRITER_LOCK), owner, { waitMs: 120_000, signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, label: 'managed launch writer admission' });
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
