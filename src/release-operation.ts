import { join } from 'node:path';
import { inspectTrustedPath } from './filesystem.js';
import {
  BRIDGE_OPERATION_LOCK, RELEASE_EXCLUSION_LOCK, WRITER_LOCK,
  acquireOwnedFileClaim, assertExactDiscoveredRoots, currentReleaseOwner,
  discoverManagedRunRoots, validateReleaseManifest,
  type OwnedFileClaim, type ReleaseManifest, type ReleaseOwner,
} from './release-admission.js';

export type ReleaseExclusionOwnership = Readonly<{
  manifest: ReleaseManifest;
  manifestDigest: string;
  owner: ReleaseOwner;
  ownerBytes: string;
  releaseClaims: readonly OwnedFileClaim[];
  bridgeClaims: readonly OwnedFileClaim[];
  writerClaims: readonly OwnedFileClaim[];
}>;

export type ReleaseExclusionOptions = Readonly<{
  manifest: ReleaseManifest;
  manifestDigest: string;
  waitMs?: number;
  signal?: AbortSignal;
}>;

function fail(message: string): never { throw new Error(`ReleaseExclusion: ${message}`); }
function stableCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }

async function releaseReverse(claims: readonly OwnedFileClaim[]): Promise<void> {
  let failure: unknown;
  for (const claim of [...claims].reverse()) {
    try { await claim.release(); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

/**
 * Private production release boundary.
 *
 * Global deadlock-free order:
 *   1. byte-sorted discovery-parent + installed-target release claims;
 *   2. byte-sorted per-run bridge/managed-launch admission claims;
 *   3. byte-sorted per-run store writer claims;
 *   4. the caller's installed-target deployment transaction claim.
 *
 * Normal bridge work already takes (2) before (3). Store writers take only
 * (3), and target deployment takes only (4). The ancestor release marker is
 * checked on both sides of every maintained admission, so a pre-existing
 * entrant settles before this function owns its lower-order claim while a
 * later entrant cannot cross it.
 */
export async function withReleaseExclusion<T>(options: ReleaseExclusionOptions, operation: (ownership: ReleaseExclusionOwnership) => Promise<T>): Promise<T> {
  const manifest = validateReleaseManifest(options.manifest);
  if (!/^[0-9a-f]{64}$/.test(options.manifestDigest)) fail('manifest digest is invalid');
  if (typeof operation !== 'function') fail('operation callback is required');
  const waitMs = options.waitMs ?? 30_000;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 120_000) fail('wait is invalid');
  const owner = currentReleaseOwner(options.manifestDigest);
  const acquired: OwnedFileClaim[] = [];
  const releaseClaims: OwnedFileClaim[] = [];
  const bridgeClaims: OwnedFileClaim[] = [];
  const writerClaims: OwnedFileClaim[] = [];
  try {
    const anchors = [...new Set([...manifest.discoveryParents, manifest.installedTarget])].sort(stableCompare);
    for (const anchor of anchors) {
      const trusted = await inspectTrustedPath(anchor, 'release anchor', { surface: true, kind: 'directory' }).catch((error) => fail(`release anchor is unsafe: ${(error as Error).message}`));
      if (!trusted) fail(`release anchor is absent: ${anchor}`);
      const claim = await acquireOwnedFileClaim(join(anchor, RELEASE_EXCLUSION_LOCK), owner, { waitMs, signal: options.signal, reclaimStaleReleaseOwner: true, label: 'release ownership' });
      acquired.push(claim); releaseClaims.push(claim);
    }
    const discovered = await discoverManagedRunRoots(manifest.discoveryParents);
    assertExactDiscoveredRoots(manifest, discovered);
    for (const root of manifest.runRoots) {
      const kernel = await inspectTrustedPath(join(root, '.kernel'), 'managed run kernel', { surface: true, kind: 'directory' }).catch((error) => fail(`managed run kernel is unsafe: ${(error as Error).message}`));
      if (!kernel) fail(`managed run kernel is absent: ${root}`);
      const claim = await acquireOwnedFileClaim(join(root, '.kernel', BRIDGE_OPERATION_LOCK), owner, { waitMs, signal: options.signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, label: 'managed launch admission' });
      acquired.push(claim); bridgeClaims.push(claim);
    }
    for (const root of manifest.runRoots) {
      const claim = await acquireOwnedFileClaim(join(root, '.kernel', WRITER_LOCK), owner, { waitMs, signal: options.signal, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, writerReclaimProtocol: true, label: 'run writer exclusion' });
      acquired.push(claim); writerClaims.push(claim);
    }
    const ownership = Object.freeze({
      manifest, manifestDigest: options.manifestDigest, owner,
      ownerBytes: writerClaims[0]?.bytes ?? releaseClaims[0]!.bytes,
      releaseClaims: Object.freeze([...releaseClaims]), bridgeClaims: Object.freeze([...bridgeClaims]), writerClaims: Object.freeze([...writerClaims]),
    });
    if (options.signal?.aborted) { const error = new Error('release operation cancelled'); error.name = 'AbortError'; throw error; }
    return await operation(ownership);
  } finally {
    await releaseReverse(acquired);
  }
}
