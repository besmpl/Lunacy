#!/usr/bin/env node
import { constants as fsConstants, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalString, parseCanonical } from '../dist/canonical.js';
import { RELEASE_EXCLUSION_LOCK, readReleaseManifest, releaseOwnerIsLive } from '../dist/release-admission.js';
import { inspectTrustedPath, sameFilesystemIdentity, syncDirectory } from '../dist/filesystem.js';

const LIMIT = 16 * 1024 * 1024;
const stableCompare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));

function parseArgs(argv) {
  let manifest; let snapshot;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]; const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path`);
    if (flag === '--release-manifest') manifest = resolve(value);
    else if (flag === '--snapshot') snapshot = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!manifest || !snapshot) throw new Error('--release-manifest and --snapshot are required');
  return { manifest, snapshot };
}

async function boundedCanonical(path, label) {
  const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
  if (!trusted || trusted.stat.size < 1 || trusted.stat.size > LIMIT) throw new Error(`${label} is absent or exceeds its byte limit`);
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try {
    const descriptor = await handle.stat();
    if (!descriptor.isFile() || !sameFilesystemIdentity(trusted.identity, { dev: String(descriptor.dev), ino: String(descriptor.ino) }) || descriptor.size !== trusted.stat.size) throw new Error(`${label} changed before descriptor binding`);
    bytes = await handle.readFile();
    if (bytes.byteLength !== descriptor.size) throw new Error(`${label} changed during read`);
  } finally { await handle.close(); }
  const after = await inspectTrustedPath(path, label, { surface: true, kind: 'file' });
  if (!after || !sameFilesystemIdentity(trusted.identity, after.identity) || after.stat.size !== trusted.stat.size) throw new Error(`${label} changed during read`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not UTF-8`);
  return { value: parseCanonical(text), stat: trusted.stat };
}

async function waitOwner(release, timeoutMs = 30_000) {
  const anchors = [...new Set([...release.manifest.discoveryParents, release.manifest.installedTarget])].sort(stableCompare);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const owners = [];
    for (const anchor of anchors) {
      try { owners.push((await boundedCanonical(join(anchor, RELEASE_EXCLUSION_LOCK), 'release owner')).value); }
      catch { owners.length = 0; break; }
    }
    if (owners.length === anchors.length && owners.every((owner) => canonicalString(owner) === canonicalString(owners[0]))) {
      const owner = owners[0];
      const live = owner && releaseOwnerIsLive(owner);
      if (live && owner.manifestDigest !== release.digest) throw new Error('a different live release owner holds the boundary');
      if (live && owner.manifestDigest === release.digest) return owner;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error('release owner wait timed out');
}

async function writeExclusiveDurable(path, bytes) {
  const parent = await inspectTrustedPath(dirname(path), 'release snapshot response parent', { surface: true, kind: 'directory' });
  if (!parent) throw new Error('release snapshot response parent is absent');
  const handle = await fs.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const after = await inspectTrustedPath(dirname(path), 'release snapshot response parent', { surface: true, kind: 'directory' });
  if (!after || !sameFilesystemIdentity(parent.identity, after.identity)) throw new Error('release snapshot response parent changed');
  await syncDirectory(dirname(path), 'release snapshot response parent');
}

async function main() {
  const args = parseArgs(process.argv.slice(2)); const release = await readReleaseManifest(args.manifest);
  const owner = await waitOwner(release);
  const source = await boundedCanonical(args.snapshot, 'process snapshot');
  if (!source.value || typeof source.value !== 'object' || source.value.schema !== 'lunacy-process-snapshot/v1' || typeof source.value.capturedAt !== 'string' || Number.isNaN(Date.parse(source.value.capturedAt))) throw new Error('process snapshot is malformed');
  if (Date.parse(source.value.capturedAt) < Date.parse(owner.acquiredAt) || source.stat.ctimeMs < Date.parse(owner.acquiredAt)) throw new Error('process snapshot predates release ownership');
  const response = { schema: 'lunacy-release-process-snapshot/v1', releaseOwnerId: owner.id, manifestDigest: release.digest, snapshot: source.value };
  await writeExclusiveDurable(release.manifest.processSnapshotPath, canonicalString(response));
  process.stdout.write(`${canonicalString({ status: 'BOUND', processSnapshotPath: release.manifest.processSnapshotPath, releaseOwnerId: owner.id, manifestDigest: release.digest })}\n`);
}

main().catch((error) => { process.stderr.write(`${String(error?.stack ?? error)}\n`); process.exitCode = 1; });
