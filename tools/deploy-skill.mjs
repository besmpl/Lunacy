#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, existsSync, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertStableIdentity, ensurePrivateDirectory, filesystemIdentity, inspectTrustedPath, sameFilesystemIdentity, trustedIdentity } from '../dist/filesystem.js';

const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = join(sourceRoot, 'dist');
const packagePath = join(sourceRoot, 'package.json');
const defaultTarget = '/Users/mark/.codex/skills/lunacy';
const manifestName = 'runtime/DEPLOYMENT.json';
const schema = 1;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PAYLOAD_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_TOTAL_BYTES = 64 * 1024 * 1024;
// The transaction record is deliberately kept outside `runtime/`.  It is a
// short-lived, fsync'd witness for the two-directory rename transaction and is
// never part of the managed release inventory.
const transactionName = '.lunacy-runtime-deploy.json';
const lockName = '.lunacy-runtime-deploy.lock';
const transactionSchema = 1;
const lockSchema = 1;
const crashExitCode = 97;
const MAX_RETENTION_RUN_PARENTS = 64;
const MAX_RETENTION_RUNS_PER_PARENT = 4096;
const MAX_RETENTION_RUN_ENTRIES = 4096;
const transactionPhases = new Set(['prepared', 'old-moved', 'published', 'committed']);
const recoveryPhases = new Set([
  null,
  'runtime-to-failed',
  'backup-to-runtime',
  'restored-verification',
  'failed-deletion',
  'stage-deletion',
  'backup-deletion',
  'marker-deletion',
  'final-sync',
]);

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function stableCompare(a, b) { return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
function assertTrustedSurface(stat, label) {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error(`${label} is not owned by the current user`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} is group/world-writable`);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(stableCompare).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const retentionRecordSchemas = new Map([
  ['RUN-RECEIPT.json', 'lunacy-run-receipt/v1'],
  ['.RUN-RECEIPT.json.tmp', 'lunacy-run-receipt/v1'],
  ['ABANDON-RECEIPT.json', 'lunacy-run-abandon-receipt/v1'],
  ['.ABANDON-RECEIPT.json.tmp', 'lunacy-run-abandon-receipt/v1'],
  ['.lunacy-run-finalization.json', 'lunacy-run-finalization/v1'],
  ['.lunacy-parent-acceptance.json', new Set(['lunacy-parent-acceptance/v1', 'lunacy-runtime-acceptance-candidate/v1', 'lunacy-runtime-acceptance/v1'])],
  ['.lunacy-parent-abandonment.json', 'lunacy-run-abandonment/v1'],
  ['.lunacy-body-migration.json', 'lunacy-body-migration/v1'],
]);
const MIGRATION_MARKER_STAGE_PREFIX = '.lunacy-body-migration.json.stage-';
function retentionManagedName(name) { return name === '.work' || name === '.work.migrate-tmp' || name.startsWith('.work.prune-') || name.startsWith(MIGRATION_MARKER_STAGE_PREFIX) || retentionRecordSchemas.has(name); }
async function readRetentionRecord(path, label, links = 1) {
  const stat = await fs.lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== links) throw new Error(`${label} is not an exclusive regular file`);
  const bytes = await readBounded(path, MAX_MANIFEST_BYTES, label);
  const text = bytes.toString('utf8'); if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not UTF-8`);
  let value; try { value = JSON.parse(text); } catch { throw new Error(`${label} is malformed`); }
  if (text !== canonical(value) && text !== `${canonical(value)}\n` || !value || typeof value !== 'object' || Array.isArray(value) || typeof value.schema !== 'string') throw new Error(`${label} is not a canonical schema record`);
  return value.schema;
}
async function captureRetentionRunParents(parents) {
  const states = new Set(); const bindings = [];
  for (const parent of parents) {
    const trustedParent = await inspectTrustedPath(parent, 'retention run parent', { surface: true, kind: 'directory' });
    if (!trustedParent) throw new Error(`retention run parent is absent: ${parent}`);
    const children = (await fs.readdir(parent, { withFileTypes: true })).sort((a, b) => stableCompare(a.name, b.name));
    if (children.length > MAX_RETENTION_RUNS_PER_PARENT) throw new Error(`retention run parent exceeds its entry limit: ${parent}`);
    for (const child of children) {
      if (!child.name || child.name.includes('/') || child.name.includes('\\')) throw new Error(`retention run child name is unsafe under ${parent}`);
      if (child.isSymbolicLink()) throw new Error(`retention run parent contains a symlink: ${join(parent, child.name)}`);
      if (!child.isDirectory()) continue;
      const runRoot = join(parent, child.name); const trustedRun = await inspectTrustedPath(runRoot, 'retention run root', { surface: true, kind: 'directory' });
      if (!trustedRun) throw new Error(`retention run root changed during census: ${runRoot}`);
      const entries = (await fs.readdir(runRoot, { withFileTypes: true })).sort((a, b) => stableCompare(a.name, b.name));
      if (entries.length > MAX_RETENTION_RUN_ENTRIES) throw new Error(`retention run exceeds its entry limit: ${runRoot}`);
      const managed = entries.filter((entry) => retentionManagedName(entry.name)); if (managed.length === 0) continue;
      const runStates = [];
      for (const entry of managed) {
        const path = join(runRoot, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`retention state is a symlink: ${path}`);
        if (entry.name === '.work') {
          if (!entry.isDirectory()) throw new Error(`non-managed .work cannot be recovered: ${runRoot}`);
          runStates.push('BODY/lunacy-body/v1'); continue;
        }
        if (entry.name === '.work.migrate-tmp') {
          if (!entry.isDirectory()) throw new Error(`non-managed migration temp cannot be recovered: ${runRoot}`);
          runStates.push('MIGRATION_TEMP/lunacy-body-migration/v1'); continue;
        }
        if (entry.name.startsWith(MIGRATION_MARKER_STAGE_PREFIX)) {
          if (!/^\.lunacy-body-migration\.json\.stage-[0-9a-f]{64}$/.test(entry.name) || !entry.isFile()) throw new Error(`non-managed migration marker stage cannot be recovered: ${path}`);
          const staged = await fs.lstat(path); if (staged.isSymbolicLink() || !staged.isFile() || ![1, 2].includes(staged.nlink) || staged.size < 0 || staged.size > MAX_MANIFEST_BYTES) throw new Error(`unsafe migration marker stage cannot be recovered: ${path}`);
          const published = await fs.lstat(join(runRoot, '.lunacy-body-migration.json')).catch(() => undefined);
          if (staged.nlink === 1 && published) throw new Error(`unbound migration marker stage collides with final marker: ${path}`);
          if (staged.nlink === 2 && (!published || !published.isFile() || published.dev !== staged.dev || published.ino !== staged.ino || published.nlink !== 2)) throw new Error(`unbound linked migration marker stage cannot be recovered: ${path}`);
          runStates.push('MIGRATION_MARKER_STAGE/lunacy-body-migration/v1'); continue;
        }
        if (entry.name.startsWith('.work.prune-')) {
          if (!/^\.work\.prune-[0-9a-f]{64}$/.test(entry.name) || !entry.isDirectory()) throw new Error(`non-managed Body tombstone cannot be recovered: ${path}`);
          runStates.push('TOMBSTONE/lunacy-run-finalization/v1'); continue;
        }
        if (!entry.isFile()) throw new Error(`retention record is not a file: ${path}`);
        const expected = retentionRecordSchemas.get(entry.name); let links = 1;
        if (entry.name === '.lunacy-body-migration.json') { const value = await fs.lstat(path); if (value.nlink === 2) { const stages = managed.filter((candidate) => /^\.lunacy-body-migration\.json\.stage-[0-9a-f]{64}$/.test(candidate.name)); if (stages.length !== 1) throw new Error(`linked migration marker has no exact stage: ${path}`); const staged = await fs.lstat(join(runRoot, stages[0].name)); if (staged.dev !== value.dev || staged.ino !== value.ino || staged.nlink !== 2) throw new Error(`linked migration marker has an unbound stage: ${path}`); links = 2; } }
        const schemaValue = await readRetentionRecord(path, `retention record ${path}`, links);
        if (expected instanceof Set ? !expected.has(schemaValue) : schemaValue !== expected) throw new Error(`retention candidate cannot recover schema ${schemaValue}: ${path}`);
        runStates.push(`${entry.name}/${schemaValue}`);
      }
      runStates.sort(stableCompare); for (const state of runStates) states.add(state);
      bindings.push({ parent, run: child.name, dev: trustedRun.identity.dev, ino: trustedRun.identity.ino, states: runStates });
    }
  }
  bindings.sort((a, b) => stableCompare(`${a.parent}/${a.run}`, `${b.parent}/${b.run}`)); const stateSchemas = [...states].sort(stableCompare);
  return Object.freeze({ schema: 'lunacy-retention-deployment-census/v1', parents: Object.freeze([...parents]), stateSchemas: Object.freeze(stateSchemas), bindings: Object.freeze(bindings), digest: hash(Buffer.from(canonical({ parents, stateSchemas, bindings }))) });
}
async function retentionDeploymentPreflight(parents) {
  if (parents.length === 0) return Object.freeze({ schema: 'lunacy-retention-deployment-census/v1', parents: Object.freeze([]), stateSchemas: Object.freeze([]), bindings: Object.freeze([]), digest: hash(Buffer.from(canonical({ parents: [], stateSchemas: [], bindings: [] }))) });
  const first = await captureRetentionRunParents(parents); const second = await captureRetentionRunParents(parents);
  if (canonical(first) !== canonical(second)) throw new Error('retention run-parent census changed during deployment preflight');
  return first;
}
// Envelope identity paths are digests of canonical JSON values. Keep this
// helper at module scope so fresh creation, resume validation, and quiescence
// transitions all use the same representation.
function pathDigest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
async function lstat(path, label) {
  try { return (await inspectTrustedPath(resolve(path), label, { allowMissing: true, surface: true }))?.stat; }
  catch (error) { throw new Error(error.message.replace(/^FilesystemTrust:\s*/, '')); }
}
async function assertNoSymlinkSegments(path, label) {
  try { await inspectTrustedPath(resolve(path), label, { allowMissing: true, surface: true }); }
  catch (error) { throw new Error(error.message.replace(/^FilesystemTrust:\s*/, '')); }
}
async function ensureDir(path, label) {
  const target = resolve(path);
  // `ensurePrivateDirectory` deliberately keeps its API small and portable,
  // but a recursive mkdir alone does not make the newly-created directory
  // entries crash durable.  Record which components were absent first, then
  // fsync each new directory and its parent after creation.  Existing
  // components are still synced at the leaf because callers use this helper
  // immediately before creating files in that directory.
  const missing = [];
  let current = target;
  while (current !== dirname(current)) {
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory()) break;
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      missing.push(current);
    }
    current = dirname(current);
  }
  try {
    const trusted = await ensurePrivateDirectory(target, label);
    if (!trusted.stat.isDirectory()) throw new Error(`${label} is not a directory`);
  } catch (error) { throw new Error(error.message.replace(/^FilesystemTrust:\s*/, '')); }
  for (const directory of missing.reverse()) {
    await syncDir(directory);
    await syncDir(dirname(directory));
  }
  await syncDir(target);
}
async function syncFile(path) { const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function syncDir(path) { const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function collect(path, prefix = '') {
  const entries = (await fs.readdir(path, { withFileTypes: true })).sort((a, b) => stableCompare(a.name, b.name));
  const files = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`source ${name} is a symlink`);
    if (entry.isDirectory()) files.push(...await collect(full, name));
    else if (entry.isFile()) files.push({ source: full, relative: name });
    else throw new Error(`source ${name} is not a regular file`);
  }
  return files;
}
async function readBytes(path) { return fs.readFile(path); }
/** Read mutable deployment inputs through a fixed-size, stat-fenced
 * descriptor.  --check must not allocate an entire forged sparse manifest or
 * payload before it can reject the deployment. */
async function readBounded(path, limit, label) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`${label} has an invalid byte limit`);
  const before = await inspectTrustedPath(resolve(path), label, { surface: true, kind: 'file' });
  if (!before) throw new Error(`${label} is absent`);
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => {
    if (error.code === 'ELOOP') throw new Error(`${label} is a symlink`);
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    assertTrustedSurface(stat, label);
    if (!sameFilesystemIdentity(filesystemIdentity(stat), before.identity)) throw new Error(`${label} changed before descriptor binding`);
    const after = await inspectTrustedPath(resolve(path), label, { surface: true, kind: 'file' });
    if (!after || !sameFilesystemIdentity(filesystemIdentity(stat), after.identity)) throw new Error(`${label} changed during descriptor binding`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limit) throw new Error(`${label} exceeds its byte limit`);
    const expected = stat.size;
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected + 1)));
    let total = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      if (result.bytesRead > expected - total || result.bytesRead > limit - total) throw new Error(`${label} changed during bounded read`);
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
      total += result.bytesRead;
    }
    if (total !== expected) throw new Error(`${label} changed during bounded read`);
    return Buffer.concat(chunks, total);
  } finally { await handle.close().catch(() => undefined); }
}
/** Read the already-resolved Node executable through one no-follow descriptor.
 * Homebrew/system Node paths may have shared parent directories, so this
 * helper fences the executable inode and final owner/mode without applying the
 * private managed-surface ancestor policy used for deployment payloads. */
async function readBoundedExecutable(path, limit, label) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`${label} has an invalid byte limit`);
  const before = await fs.stat(path);
  if (!before.isFile()) throw new Error(`${label} is not a regular file`);
  assertTrustedSurface(before, label);
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => {
    if (error.code === 'ELOOP') throw new Error(`${label} is a symlink`);
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    assertTrustedSurface(stat, label);
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.mode !== before.mode) throw new Error(`${label} changed before descriptor binding`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limit) throw new Error(`${label} exceeds its byte limit`);
    const expected = stat.size;
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected + 1)));
    let total = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      if (result.bytesRead > expected - total || result.bytesRead > limit - total) throw new Error(`${label} changed during bounded read`);
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
      total += result.bytesRead;
    }
    if (total !== expected) throw new Error(`${label} changed during bounded read`);
    const after = await fs.stat(path);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode || after.size !== stat.size) throw new Error(`${label} changed during attestation`);
    return Buffer.concat(chunks, total);
  } finally { await handle.close().catch(() => undefined); }
}
/** Digest a mutable deployment payload without retaining its bytes. */
async function hashBounded(path, limit, label) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`${label} has an invalid byte limit`);
  const before = await inspectTrustedPath(resolve(path), label, { surface: true, kind: 'file' });
  if (!before) throw new Error(`${label} is absent`);
  const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => {
    if (error.code === 'ELOOP') throw new Error(`${label} is a symlink`);
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    assertTrustedSurface(stat, label);
    if (!sameFilesystemIdentity(filesystemIdentity(stat), before.identity)) throw new Error(`${label} changed before descriptor binding`);
    const after = await inspectTrustedPath(resolve(path), label, { surface: true, kind: 'file' });
    if (!after || !sameFilesystemIdentity(filesystemIdentity(stat), after.identity)) throw new Error(`${label} changed during descriptor binding`);
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limit) throw new Error(`${label} exceeds its byte limit`);
    const expected = stat.size;
    const digestState = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      if (result.bytesRead > expected - total || result.bytesRead > limit - total) throw new Error(`${label} changed during bounded read`);
      digestState.update(buffer.subarray(0, result.bytesRead));
      total += result.bytesRead;
    }
    if (total !== expected) throw new Error(`${label} changed during bounded read`);
    return { digest: digestState.digest('hex'), bytes: total };
  } finally { await handle.close().catch(() => undefined); }
}

/** Resolve the exact Node image used to build a managed launcher. The
 * generated launcher embeds this physical path/digest and rejects a caller
 * that reaches it through a different ambient `node` executable. */
async function attestNodeRuntime() {
  const requestedPath = resolve(process.execPath);
  const physicalPath = resolve(await fs.realpath(requestedPath));
  const requestedStat = await fs.lstat(requestedPath);
  const physicalStat = await fs.stat(physicalPath);
  if (!physicalStat.isFile() || (physicalStat.mode & 0o111) === 0) throw new Error('Node executable is not a regular executable file');
  assertTrustedSurface(physicalStat, 'Node executable');
  const bytes = await readBoundedExecutable(physicalPath, 512 * 1024 * 1024, 'Node executable');
  const afterRequested = await fs.lstat(requestedPath);
  const afterPhysical = await fs.stat(physicalPath);
  if (requestedStat.dev !== afterRequested.dev || requestedStat.ino !== afterRequested.ino || physicalStat.dev !== afterPhysical.dev || physicalStat.ino !== afterPhysical.ino || physicalStat.mode !== afterPhysical.mode) throw new Error('Node executable changed during attestation');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!Number.isInteger(major) || major < 22 || (major === 22 && (!Number.isInteger(minor) || minor < 15))) throw new Error('Node runtime is below the supported 22.15 floor');
  return Object.freeze({ path: physicalPath, version: process.versions.node, digest: hash(bytes) });
}
async function writeAtomic(path, bytes, tempName = undefined) {
  await ensureDir(dirname(path), 'deployment parent');
  if (!tempName) throw new Error('deployment atomic write requires a durable temporary pathname');
  const temp = join(dirname(path), safeTransactionName(tempName, 'deployment transaction temporary path'));
  try {
    // A prior crash may have left this exact, marker-bound temporary name
    // behind after fsync but before rename.  Replace only that bound name;
    // never scan a temporary-file namespace.
    const prior = await lstat(temp, 'deployment transaction temporary path');
    if (prior) {
      if (prior.isSymbolicLink() || !prior.isFile()) throw new Error('deployment transaction temporary path is not a regular file');
      await fs.unlink(temp);
      await syncDir(dirname(path));
    }
    await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await syncFile(temp);
    // The temporary name is now durable before the marker rename.  The
    // containing directory is synced both before and after the exchange.
    await syncDir(dirname(path));
    await fs.rename(temp, path);
    await syncDir(dirname(path));
  } catch (error) {
    await fs.unlink(temp).then(() => syncDir(dirname(path))).catch(() => undefined);
    throw error;
  }
}
function safeDeploymentPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.split('/').some((part) => part === '' || part === '..' || part === '.')) throw new Error(`deployment manifest path is unsafe: ${String(value)}`);
  if (!value.startsWith('runtime/') || value.endsWith('/')) throw new Error(`deployment manifest path is outside runtime/: ${value}`);
  return value;
}
async function assertTargetFile(path, label) { const stat = await lstat(path, label); if (!stat) throw new Error(`${label} is absent`); if (!stat.isFile()) throw new Error(`${label} is not a regular file`); }

/**
 * Return every regular file and directory in a managed runtime tree.  This is
 * intentionally independent from DEPLOYMENT.json: the manifest's `files`
 * array describes the signed source payload, while the deployment-owned
 * inventory also includes the generated launcher, README, and manifest.
 */
async function collectManagedTree(root, prefix = 'runtime') {
  const stat = await lstat(root, 'managed runtime');
  if (!stat) throw new Error('managed runtime is absent');
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('managed runtime is not a regular directory');
  const entries = [{ kind: 'directory', relative: prefix, mode: stat.mode & 0o7777 }];
  async function visit(directory, directoryPrefix) {
    const children = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => stableCompare(a.name, b.name));
    for (const entry of children) {
      const relativePath = `${directoryPrefix}/${entry.name}`;
      const path = join(directory, entry.name);
      const child = await lstat(path, `managed entry ${relativePath}`);
      if (!child) throw new Error(`managed entry ${relativePath} disappeared`);
      if (child.isSymbolicLink()) throw new Error(`managed entry ${relativePath} is a symlink`);
      if (child.isDirectory()) {
        entries.push({ kind: 'directory', relative: relativePath, mode: child.mode & 0o7777 });
        await visit(path, relativePath);
      } else if (child.isFile()) {
        entries.push({ kind: 'file', relative: relativePath, mode: child.mode & 0o7777 });
      } else {
        throw new Error(`managed entry ${relativePath} is not a regular file or directory`);
      }
    }
  }
  await visit(root, prefix);
  return entries;
}

function inventoryDigest(records) {
  return hash(Buffer.from(records
    .slice()
    .sort((a, b) => stableCompare(a.path, b.path))
    .map((record) => `${record.path}\0${record.digest}`)
    .join('\n')));
}

function expectedManagedInventory(payloadFiles, manifestBytes) {
  const inventory = payloadFiles.map((file) => ({
    path: safeDeploymentPath(file.relative),
    digest: file.digest ?? hash(file.bytes),
  }));
  // DEPLOYMENT.json is metadata, but it is still a deployment-owned byte in
  // the complete tree and must be included in exact inventory checks.
  inventory.push({ path: manifestName, digest: hash(manifestBytes) });
  inventory.sort((a, b) => stableCompare(a.path, b.path));
  if (new Set(inventory.map((record) => record.path)).size !== inventory.length) throw new Error('deployment inventory contains duplicate paths');
  return inventory;
}

const managedRootFiles = new Set([
  'runtime/BEADS.md',
  'runtime/BRIDGE.md',
  'runtime/CODEX_EXEC.md',
  'runtime/DECISION_INBOX.md',
  'runtime/DEPLOYMENT.json',
  'runtime/README.md',
  'runtime/WORKFRONT.md',
  'runtime/package.json',
  'runtime/bridge.mjs',
  'runtime/retention-launcher.mjs',
  'runtime/retention-platform-helpers.json',
  'runtime/retention-policy.json',
]);
const managedDirectories = new Set(['runtime/assets', 'runtime/assets/deliberation-policy', 'runtime/assets/deliberation-policy-compatibility', 'runtime/dist', 'runtime/schemas', 'runtime/tools']);
function isDeploymentOwnedPath(path) {
  if (managedRootFiles.has(path)) return true;
  for (const directory of managedDirectories) if (path === directory || path.startsWith(`${directory}/`)) return true;
  return false;
}

/** Capture user/skill-owned files under runtime that the deployment does not
 * own.  They are copied into the complete sibling tree rather than silently
 * deleted by the atomic exchange.  Files inside dist/schemas/tools and the
 * known runtime roots are deployment-owned and are intentionally replaced. */
async function capturePreservedRuntime(root, expectedInventory) {
  const expected = new Set(expectedInventory.map((record) => record.path));
  const entries = await collectManagedTree(root);
  const preserved = [];
  for (const entry of entries) {
    if (entry.kind !== 'file' || isDeploymentOwnedPath(entry.relative) || expected.has(entry.relative)) continue;
    const path = join(root, entry.relative.slice('runtime/'.length));
    const bytes = await readBounded(path, MAX_PAYLOAD_FILE_BYTES, `preserved managed file ${entry.relative}`);
    const stat = await lstat(path, `preserved managed file ${entry.relative}`);
    if (!stat || !stat.isFile()) throw new Error(`preserved managed file ${entry.relative} disappeared`);
    preserved.push({ path: entry.relative, digest: hash(bytes), bytes, mode: entry.mode, identity: { dev: String(stat.dev), ino: String(stat.ino) } });
  }
  preserved.sort((a, b) => stableCompare(a.path, b.path));
  if (new Set(preserved.map((record) => record.path)).size !== preserved.length) throw new Error('preserved managed inventory contains duplicate paths');
  return preserved;
}

async function assertPreservedRuntimeFence(root, expectedInventory, preservedFiles) {
  const current = await capturePreservedRuntime(root, expectedInventory);
  if (current.length !== preservedFiles.length) throw new Error('preserved unowned inventory changed before publication');
  const expected = new Map(preservedFiles.map((record) => [record.path, record]));
  for (const record of current) {
    const prior = expected.get(record.path);
    if (!prior || record.digest !== prior.digest || !sameStatIdentity(record.identity, prior.identity) || record.mode !== prior.mode) {
      throw new Error(`preserved unowned file changed before publication: ${record.path}`);
    }
  }
}

/** Capture the complete pre-publication tree so a first-red recovery can
 * verify the old directory after restoring it.  The old tree is moved as one
 * directory, but its byte inventory is still recorded in the durable marker;
 * this prevents a successful rename from being mistaken for an exact
 * rollback when a file was already stale or damaged.
 */
async function captureRuntimeInventory(root, label = 'previous managed tree') {
  const entries = await collectManagedTree(root);
  const files = [];
  let payloadBytes = 0;
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const remaining = MAX_PAYLOAD_TOTAL_BYTES - payloadBytes;
    const actual = await hashBounded(join(root, entry.relative.slice('runtime/'.length)), Math.min(MAX_PAYLOAD_FILE_BYTES, remaining), `${label} ${entry.relative}`);
    payloadBytes += actual.bytes;
    if (payloadBytes > MAX_PAYLOAD_TOTAL_BYTES) throw new Error(`${label}: managed payload exceeds aggregate byte limit`);
    files.push({ path: entry.relative, digest: actual.digest });
  }
  files.sort((a, b) => stableCompare(a.path, b.path));
  return Object.freeze({ files, aggregate: inventoryDigest(files) });
}

/**
 * Verify the complete managed tree, not merely the files named by the mutable
 * manifest.  The expected inventory is sorted path/digest data and therefore
 * also supplies the stable aggregate used in deployment evidence.
 */
async function verifyManagedTree(root, expectedInventory, label, expectedTreeDigest = undefined, preservedInventory = []) {
  const expected = new Map([...expectedInventory, ...preservedInventory].map((record) => [record.path, record.digest]));
  const entries = await collectManagedTree(root);
  const actualFiles = [];
  const actualDirectories = [];
  let payloadBytes = 0;
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      actualDirectories.push(entry.relative);
      continue;
    }
    if (!expected.has(entry.relative)) throw new Error(`${label}: unexpected managed file ${entry.relative}`);
    const remaining = MAX_PAYLOAD_TOTAL_BYTES - payloadBytes;
    const actual = await hashBounded(join(root, entry.relative.slice('runtime/'.length)), Math.min(MAX_PAYLOAD_FILE_BYTES, remaining), `${label} ${entry.relative}`);
    payloadBytes += actual.bytes;
    if (payloadBytes > MAX_PAYLOAD_TOTAL_BYTES) throw new Error(`${label}: managed payload exceeds aggregate byte limit`);
    if (actual.digest !== expected.get(entry.relative)) throw new Error(`${label}: managed file drift ${entry.relative}`);
    actualFiles.push({ path: entry.relative, digest: actual.digest });
  }
  const expectedFiles = [...expectedInventory, ...preservedInventory].map((record) => record.path).sort(stableCompare);
  const actualFilePaths = actualFiles.map((record) => record.path).sort(stableCompare);
  if (expectedFiles.length !== actualFilePaths.length || expectedFiles.some((path, index) => path !== actualFilePaths[index])) {
    const missing = expectedFiles.filter((path) => !actualFilePaths.includes(path));
    const extra = actualFilePaths.filter((path) => !expectedFiles.includes(path));
    throw new Error(`${label}: managed inventory mismatch missing=${missing.join(',')} extra=${extra.join(',')}`);
  }
  const expectedDirectories = new Set(['runtime']);
  for (const path of expectedFiles) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join('/'));
  }
  const actualDirectorySet = new Set(actualDirectories);
  if (expectedDirectories.size !== actualDirectorySet.size || [...expectedDirectories].some((path) => !actualDirectorySet.has(path))) {
    throw new Error(`${label}: managed directory inventory mismatch`);
  }
  const aggregate = inventoryDigest(actualFiles);
  if (expectedTreeDigest !== undefined && aggregate !== expectedTreeDigest) throw new Error(`${label}: managed aggregate drift`);
  return Object.freeze({ files: actualFiles.length, ownedFiles: expectedInventory.length, preservedFiles: preservedInventory.length, directories: actualDirectories.length, aggregate });
}

function transactionCrashRequested(phase) {
  const requested = process.env.LUNACY_DEPLOY_CRASH_WINDOW
    || process.env.LUNACY_DEPLOY_TEST_CRASH_WINDOW
    || process.env.LUNACY_DEPLOY_CRASH_AT
    || process.env.LUNACY_DEPLOY_FAIL_AFTER;
  if (!requested) return false;
  const normalized = String(requested).toLowerCase().replace(/_/g, '-');
  const aliases = new Set([
    phase,
    `after-${phase}`,
    `${phase}-after`,
    `before-${phase}`,
    `${phase}-before`,
    phase.replace(/^after-/, ''),
    phase.replace(/-/g, '_'),
    phase.replace(/^after-/, '').replace(/-/g, '_'),
  ]);
  const phaseAliases = {
    'stage-created': ['stage-create', 'stage-creation', 'stage-created-before-marker'],
    'stage-verified': ['stage-verify', 'stage-verification'],
    'old-tree-renamed': ['old-moved', 'old-rename', 'old-tree-rename', 'old-rename-before-marker'],
    'marker-old-moved': ['old-moved-marker', 'marker-after-old-moved'],
    'new-moved': ['new-rename', 'new-tree-renamed'],
    'marker-published': ['published-marker'],
    'recovery-runtime-to-failed': ['runtime-to-failed', 'recovery-runtime-failed', 'runtime-to-failed-after', 'runtime-rename', 'recovery-runtime-rename'],
    'recovery-runtime-to-failed-before': ['runtime-to-failed-before', 'recovery-runtime-failed-before', 'runtime-rename-before'],
    'recovery-backup-to-runtime': ['backup-to-runtime', 'recovery-backup-runtime', 'backup-to-runtime-after', 'backup-rename', 'recovery-backup-rename'],
    'recovery-backup-to-runtime-before': ['backup-to-runtime-before', 'recovery-backup-runtime-before', 'backup-rename-before'],
    'recovery-restored-verified': ['restored-verified', 'recovery-restored-verification', 'restored-verification', 'restored-tree-verified'],
    'recovery-restored-verified-before': ['restored-verified-before', 'recovery-restored-verification-before', 'restored-verification-before'],
    'recovery-failed-deletion': ['failed-deletion', 'failed-deletion-before', 'failed-deletion-after', 'failed-deleted', 'failed-tree-deletion', 'failed-tree-deleted', 'recovery-failed-delete'],
    'recovery-stage-deletion': ['stage-deletion', 'stage-deletion-before', 'stage-deletion-after', 'stage-deleted', 'stage-tree-deletion', 'stage-tree-deleted', 'recovery-stage-delete'],
    'recovery-backup-deletion': ['backup-deletion', 'backup-deletion-before', 'backup-deletion-after', 'backup-deleted', 'backup-tree-deletion', 'backup-tree-deleted', 'recovery-backup-delete'],
    'recovery-marker-deletion': ['marker-deletion', 'marker-deletion-before', 'marker-deletion-after', 'marker-deleted', 'deployment-marker-deletion', 'recovery-marker-delete'],
    'recovery-final-sync': ['final-sync', 'final-sync-before', 'final-sync-after', 'final-directory-sync', 'final-dir-sync', 'recovery-directory-sync'],
  };
  for (const alias of phaseAliases[phase] ?? []) aliases.add(alias);
  if (!aliases.has(normalized)) return false;
  process.stderr.write(`deployment transaction crash window: ${phase}\n`);
  process.exitCode = crashExitCode;
  // Exit synchronously after all preceding fsyncs.  This is test-only fault
  // injection; a normal invocation never reaches this branch.
  process.exit(crashExitCode);
}

async function testHoldTargetLock() {
  const requested = process.env.LUNACY_DEPLOY_TEST_HOLD_MS;
  if (requested === undefined || requested === '') return;
  const milliseconds = Number(requested);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 120_000) throw new Error('LUNACY_DEPLOY_TEST_HOLD_MS is invalid');
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function testDelayBeforePreservedFence() {
  const requested = process.env.LUNACY_DEPLOY_TEST_DELAY_BEFORE_PRESERVED_FENCE_MS;
  if (requested === undefined || requested === '') return;
  const milliseconds = Number(requested);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 120_000) throw new Error('LUNACY_DEPLOY_TEST_DELAY_BEFORE_PRESERVED_FENCE_MS is invalid');
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeTransactionName(value, label) {
  if (typeof value !== 'string' || value.length === 0 || basename(value) !== value || value.includes('\0') || value.startsWith('.') === false) throw new Error(`${label} is unsafe`);
  return value;
}

function transactionTempName(transactionId) {
  safeTransactionId(transactionId, 'deployment transaction id');
  return `.lunacy-runtime-deploy.json.tmp-${transactionId}`;
}

function transactionTempMatches(name, transactionId) {
  return name === transactionTempName(transactionId);
}

// Validate a name that is already bound by the durable marker.  This parser
// is not a discovery/cleanup namespace; recovery never calls it while
// scanning arbitrary directory entries.
function isValidTransactionSiblingName(value, kind = undefined) {
  const prefix = kind === undefined
    ? '(?:stage|backup|failed)'
    : kind;
  return typeof value === 'string'
    && new RegExp(`^\\.lunacy-runtime-${prefix}-[0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(value);
}

function transactionSiblingName(kind, transactionId) {
  if (!['stage', 'backup', 'failed'].includes(kind)) throw new Error(`unknown transaction sibling kind: ${kind}`);
  return `.lunacy-runtime-${kind}-${process.pid}-${transactionId}`;
}

function transactionSiblingMatches(kind, name, transactionId) {
  if (!['stage', 'backup', 'failed'].includes(kind)) throw new Error(`unknown transaction sibling kind: ${kind}`);
  return new RegExp(`^\\.lunacy-runtime-${kind}-[0-9]+-${transactionId}$`).test(name);
}

function safeTransactionId(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error(`${label} is unsafe`);
  return value;
}

function transactionPath(target, name) { return join(target, name); }

function sameStatIdentity(a, b) {
  return Boolean(a && b) && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.  It
    // is still a live owner and must therefore fail closed.
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    // Any other result is an inability to prove that the owner is gone.
    return true;
  }
}

function parseLockOwner(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('deployment target lock is not valid UTF-8');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('deployment target lock is malformed'); }
  if (`${canonical(value)}\n` !== text) throw new Error('deployment target lock is not canonical');
  if (!value || value.schema !== lockSchema || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0) {
    throw new Error('deployment target lock is malformed');
  }
  const extended = Object.hasOwn(value, 'processStartedAt') || Object.hasOwn(value, 'manifestDigest');
  if (extended && (Object.keys(value).sort(stableCompare).join(',') !== 'id,manifestDigest,pid,processStartedAt,schema,startedAt' || typeof value.processStartedAt !== 'string' || value.processStartedAt.length === 0 || typeof value.manifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.manifestDigest))) throw new Error('deployment target lock release ownership is malformed');
  return Object.freeze(value);
}

/**
 * Claim the target with a kernel-atomic O_EXCL create and retain the
 * descriptor until the complete operation (including recovery and cleanup)
 * has finished.  A live owner is never adopted.  A dead owner may be removed
 * only after its inode is rechecked, so a replacement claimant cannot be
 * accidentally unlinked during stale-owner recovery.
 */
async function acquireTargetLock(target, options = {}) {
  const path = transactionPath(target, lockName);
  while (true) {
    let handle;
    try {
      handle = await fs.open(path, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const observed = await fs.lstat(path).catch((readError) => {
        if (readError?.code === 'ENOENT') return undefined;
        throw readError;
      });
      if (!observed) continue;
      if (!observed.isFile() || observed.isSymbolicLink()) throw new Error('deployment target lock is not a regular file');
      const owner = parseLockOwner(await readBounded(path, MAX_MANIFEST_BYTES, 'deployment target lock'));
      const exactReleaseOwner = typeof owner.processStartedAt === 'string' && typeof owner.manifestDigest === 'string';
      const live = exactReleaseOwner
        ? options.releaseOwnerIsLive?.({ schema: 'lunacy-release-owner/v1', id: owner.id, pid: owner.pid, processStartedAt: owner.processStartedAt, acquiredAt: new Date(owner.startedAt).toISOString(), manifestDigest: owner.manifestDigest }) ?? true
        : processIsAlive(owner.pid);
      if (live) throw new Error(`deployment target is busy (owner pid ${owner.pid})`);
      if (options.reclaimStale === false || (options.reclaimStaleExactRelease && !exactReleaseOwner)) throw new Error(`deployment target has stale ownership residue (owner pid ${owner.pid})`);
      const current = await fs.lstat(path).catch((readError) => {
        if (readError?.code === 'ENOENT') return undefined;
        throw readError;
      });
      if (!current) continue;
      if (!sameStatIdentity(observed, current)) continue;
      await fs.unlink(path);
      await syncDir(target);
      continue;
    }
    const owner = options.releaseOwner
      ? Object.freeze({ schema: lockSchema, id: options.releaseOwner.id, pid: options.releaseOwner.pid, startedAt: Date.parse(options.releaseOwner.acquiredAt), processStartedAt: options.releaseOwner.processStartedAt, manifestDigest: options.releaseOwner.manifestDigest })
      : Object.freeze({ schema: lockSchema, id: randomUUID(), pid: process.pid, startedAt: Date.now() });
    const bytes = Buffer.from(`${canonical(owner)}\n`);
    try {
      const written = await handle.write(bytes, 0, bytes.byteLength, 0);
      if (written.bytesWritten !== bytes.byteLength) throw new Error('deployment target lock write was incomplete');
      await handle.sync();
      await syncDir(target);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(path).catch(() => undefined);
      await syncDir(target).catch(() => undefined);
      throw error;
    }
    const identity = await handle.stat();
    let released = false;
    return Object.freeze({
      path,
      owner,
      bytes: bytes.toString('utf8'),
      async release() {
        if (released) return;
        released = true;
        try {
          const current = await fs.lstat(path).catch((error) => {
            if (error?.code === 'ENOENT') return undefined;
            throw error;
          });
          if (!current && options.releaseOwner) throw new Error('deployment target lock ownership changed');
          if (current && !sameStatIdentity(current, identity)) throw new Error('deployment target lock ownership changed');
          if (current) {
            await fs.unlink(path);
            await syncDir(target);
          }
        } finally {
          await handle.close();
        }
      },
    });
  }
}

async function removeOwnedPath(path, label, expectedKind = undefined) {
  const stat = await lstat(path, label);
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  if (expectedKind === 'directory' && !stat.isDirectory()) throw new Error(`${label} is not a directory`);
  if (expectedKind === 'file' && !stat.isFile()) throw new Error(`${label} is not a regular file`);
  if (!stat.isDirectory()) {
    await fs.unlink(path);
    await syncDir(dirname(path));
    return;
  }
  // fs.rm({recursive:true}) does not expose the individual unlink/rmdir
  // boundaries needed by the crash model.  Remove children bottom-up and
  // sync each containing directory after every name transition.
  const entries = (await fs.readdir(path, { withFileTypes: true })).sort((a, b) => stableCompare(a.name, b.name));
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
    await removeOwnedPath(child, `${label} ${entry.name}`);
  }
  await fs.rmdir(path);
  await syncDir(dirname(path));
}

async function writeTransaction(target, transaction, { create = false } = {}) {
  const markerPath = transactionPath(target, transactionName);
  const bytes = Buffer.from(`${canonical(transaction)}\n`);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('deployment transaction marker exceeds byte limit');
  safeTransactionId(transaction.id, 'deployment transaction id');
  if (!Number.isSafeInteger(transaction.ownerPid) || transaction.ownerPid <= 0 || typeof transaction.ownerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(transaction.ownerId)) throw new Error('deployment transaction owner is malformed');
  const tempName = transaction.tempName ?? transactionTempName(transaction.id);
  if (!transactionTempMatches(tempName, transaction.id)) throw new Error('deployment transaction temporary path does not match transaction id');
  if (create) {
    let handle;
    try {
      handle = await fs.open(markerPath, 'wx', 0o600);
      const written = await handle.write(bytes, 0, bytes.byteLength, 0);
      if (written.bytesWritten !== bytes.byteLength) throw new Error('deployment transaction marker write was incomplete');
      await handle.sync();
    } finally {
      await handle?.close().catch(() => undefined);
    }
    await syncDir(target);
    return;
  }
  const current = await readTransaction(target);
  if (!current || current.id !== transaction.id || current.ownerPid !== transaction.ownerPid || current.ownerId !== transaction.ownerId) throw new Error('deployment transaction owner changed');
  await writeAtomic(markerPath, bytes, tempName);
}

async function readTransaction(target) {
  const markerPath = transactionPath(target, transactionName);
  const marker = await lstat(markerPath, 'deployment transaction marker');
  if (!marker) return undefined;
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('deployment transaction marker is not a regular file');
  const bytes = await readBounded(markerPath, MAX_MANIFEST_BYTES, 'deployment transaction marker');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('deployment transaction marker is not valid UTF-8');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('deployment transaction marker is malformed'); }
  if (`${canonical(value)}\n` !== text) throw new Error('deployment transaction marker is not canonical');
  if (!value || value.schema !== transactionSchema || value.target !== 'runtime' || !transactionPhases.has(value.phase)) throw new Error('deployment transaction marker is malformed');
  safeTransactionId(value.id, 'deployment transaction id');
  if (!Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0 || typeof value.ownerId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.ownerId)) throw new Error('deployment transaction marker owner is malformed');
  const tempName = value.tempName;
  if (typeof tempName !== 'string') throw new Error('deployment transaction marker has no bound temporary path');
  safeTransactionName(tempName, 'deployment transaction temporary path');
  if (!transactionTempMatches(tempName, value.id)) throw new Error('deployment transaction temporary path does not match transaction id');
  safeTransactionName(value.stageName, 'deployment transaction stage');
  if (!isValidTransactionSiblingName(value.stageName, 'stage')) throw new Error('deployment transaction stage is not owned');
  if (!transactionSiblingMatches('stage', value.stageName, value.id)) throw new Error('deployment transaction stage does not match transaction id');
  if (value.backupName !== null) safeTransactionName(value.backupName, 'deployment transaction backup');
  if (value.backupName !== null && !isValidTransactionSiblingName(value.backupName, 'backup')) throw new Error('deployment transaction backup is not owned');
  const failedName = value.failedName ?? transactionSiblingName('failed', value.id);
  safeTransactionName(failedName, 'deployment transaction failed tree');
  if (!isValidTransactionSiblingName(failedName, 'failed')) throw new Error('deployment transaction failed tree is not owned');
  if (value.backupName !== null && !transactionSiblingMatches('backup', value.backupName, value.id)) throw new Error('deployment transaction backup does not match transaction id');
  if (!transactionSiblingMatches('failed', failedName, value.id)) throw new Error('deployment transaction failed tree does not match transaction id');
  if (value.phase === 'old-moved' && value.backupName === null) throw new Error('deployment transaction old-moved marker has no rollback tree');
  if (typeof value.aggregate !== 'string' || !/^[0-9a-f]{64}$/.test(value.aggregate) || !Array.isArray(value.inventory) || value.inventory.length === 0) throw new Error('deployment transaction marker inventory is malformed');
  const inventory = value.inventory.map((record) => {
    if (!record || typeof record.path !== 'string' || typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) throw new Error('deployment transaction marker inventory is malformed');
    safeDeploymentPath(record.path);
    return { path: record.path, digest: record.digest };
  }).sort((a, b) => stableCompare(a.path, b.path));
  if (new Set(inventory.map((record) => record.path)).size !== inventory.length || inventoryDigest(inventory) !== value.aggregate) throw new Error('deployment transaction marker inventory is inconsistent');
  if (!Array.isArray(value.previousInventory) || typeof value.previousAggregate !== 'string' || !/^[0-9a-f]{64}$/.test(value.previousAggregate)) throw new Error('deployment transaction marker previous inventory is malformed');
  const previousInventory = value.previousInventory.map((record) => {
    if (!record || typeof record.path !== 'string' || typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) throw new Error('deployment transaction marker previous inventory is malformed');
    safeDeploymentPath(record.path);
    return { path: record.path, digest: record.digest };
  }).sort((a, b) => stableCompare(a.path, b.path));
  if (new Set(previousInventory.map((record) => record.path)).size !== previousInventory.length || inventoryDigest(previousInventory) !== value.previousAggregate) throw new Error('deployment transaction marker previous inventory is inconsistent');
  if (value.backupName === null && (previousInventory.length !== 0 || value.previousAggregate !== inventoryDigest([]))) throw new Error('deployment transaction first-install inventory is inconsistent');
  const recoveryPhase = value.recoveryPhase ?? null;
  if (!recoveryPhases.has(recoveryPhase)) throw new Error('deployment transaction recovery phase is malformed');
  return { ...value, tempName, failedName, recoveryPhase, inventory, previousInventory };
}

/**
 * The outer envelope is only allowed to adopt an inner transaction that was
 * created by the exact owner bound to that envelope.  The transaction marker
 * has no manifest field of its own, so the owner id is the narrow shared
 * identity: target-lock ownership and transaction publication both receive
 * this id.  A well-formed marker from another release must remain untouched
 * rather than being implicitly recovered by `--resume-release`.
 */
async function assertResumableInnerBinding(target, expectedOwnerId) {
  const transaction = await readTransaction(target);
  if (!transaction) return undefined;
  if (typeof expectedOwnerId !== 'string' || transaction.ownerId !== expectedOwnerId) {
    throw new Error('inner deployment transaction is not bound to the outer release owner');
  }
  return transaction;
}

async function syncParent(target) { await syncDir(target); }

async function syncTreeBottomUp(root, label = 'managed tree') {
  const stat = await lstat(root, label);
  if (!stat) throw new Error(`${label} is absent`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  const entries = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => stableCompare(a.name, b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`${label} contains a symlink`);
    if (entry.isDirectory()) await syncTreeBottomUp(join(root, entry.name), `${label} ${entry.name}`);
    else if (entry.isFile()) {
      // Stage writes fsync eagerly, but recovery may be re-publishing a tree
      // created by an older release.  Re-sync every file here so a restored
      // tree has the same durability proof as a newly staged tree.
      await syncFile(join(root, entry.name));
    }
    else throw new Error(`${label} contains a non-regular entry`);
  }
  // Sync the directory itself after all child names and then its parent after
  // the directory's entry was created/renamed into that parent.
  await syncDir(root);
  await syncDir(dirname(root));
}

async function pathExists(path, label) {
  const stat = await lstat(path, label);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  return true;
}

async function exactTree(path, inventory, aggregate, label) {
  if (!(await pathExists(path, label))) return false;
  try {
    const verified = await verifyManagedTree(path, inventory, label, aggregate);
    return verified.aggregate === aggregate;
  } catch {
    return false;
  }
}

async function persistRecovery(target, transaction, recoveryPhase) {
  transaction.recoveryPhase = recoveryPhase;
  await writeTransaction(target, transaction);
}

async function removeRecoveryResidue(target, transaction, kind, path, label) {
  await persistRecovery(target, transaction, `${kind}-deletion`);
  transactionCrashRequested(`recovery-${kind}-deletion-before`);
  if (path) await removeOwnedPath(path, label, kind === 'failed' || kind === 'stage' || kind === 'backup' ? 'directory' : undefined);
  await syncParent(target);
  transactionCrashRequested(`recovery-${kind}-deletion`);
  transaction.recoveryPhase = null;
  await writeTransaction(target, transaction);
}

async function removeTransactionMarker(target, transaction) {
  // A marker update may have fsync'd its exact temporary pathname before the
  // process died.  It is safe to remove only the path durably bound in this
  // transaction; unrelated `*.tmp-*` names are never scanned or touched.
  const tempPath = transaction.tempName ? transactionPath(target, transaction.tempName) : undefined;
  if (tempPath) {
    transaction.recoveryPhase = 'marker-deletion';
    await writeTransaction(target, transaction);
    transactionCrashRequested('recovery-marker-temp-deletion-before');
    await removeOwnedPath(tempPath, 'deployment transaction temporary path', 'file');
    await syncParent(target);
    transactionCrashRequested('recovery-marker-temp-deletion');
  }
  await persistRecovery(target, transaction, 'marker-deletion');
  transactionCrashRequested('recovery-marker-deletion-before');
  await removeOwnedPath(transactionPath(target, transactionName), 'deployment transaction marker', 'file');
  await syncParent(target);
  transactionCrashRequested('recovery-marker-deletion');
  // The marker is gone.  A final directory fsync is the success boundary for
  // cleanup; if the process dies before it, the next invocation simply sees a
  // complete tree and no transaction residue.
  transactionCrashRequested('recovery-final-sync-before');
  await syncParent(target);
  transactionCrashRequested('recovery-final-sync');
}

/**
 * Recover every durable transaction state.  The marker is written before the
 * stage exists, and names every stage/backup/failed sibling.  Recovery writes
 * the next phase before each rename/deletion and fsyncs the parent directory
 * after the operation.  Thus a process crash leaves either an exact previous
 * tree or an exact committed tree; a retry is deterministic and idempotent.
 */
async function recoverTransaction(target) {
  const transaction = await readTransaction(target);
  if (!transaction) {
    // Without a durable owner marker there is no proof that any sibling was
    // created by us.  Leave every matching-looking path untouched; recovery
    // is fail-closed rather than a regex-based namespace cleaner.
    return false;
  }
  // A marker whose owner is still alive cannot be adopted, even if a caller
  // somehow lost the separate target lock.  The normal path reaches here
  // under our own lock, so a marker created by this process is allowed.
  if (transaction.ownerPid !== process.pid && processIsAlive(transaction.ownerPid)) throw new Error(`deployment transaction owner is live (pid ${transaction.ownerPid})`);

  const runtimeTarget = join(target, 'runtime');
  const stagePath = transactionPath(target, transaction.stageName);
  const backupPath = transaction.backupName ? transactionPath(target, transaction.backupName) : undefined;
  const failedPath = transactionPath(target, transaction.failedName);
  const candidateExact = () => exactTree(runtimeTarget, transaction.inventory, transaction.aggregate, 'candidate managed tree during recovery');
  const failedExact = () => exactTree(failedPath, transaction.inventory, transaction.aggregate, 'failed managed runtime during recovery');
  const previousExact = () => exactTree(runtimeTarget, transaction.previousInventory, transaction.previousAggregate, 'previous managed tree during recovery');

  if (transaction.phase === 'committed') {
    if (!(await candidateExact())) throw new Error('committed deployment tree is not exact');
    if (await pathExists(failedPath, 'failed managed runtime') && !(await failedExact())) throw new Error('failed managed runtime is not exact');
    await removeRecoveryResidue(target, transaction, 'backup', backupPath, 'deployment transaction backup');
    await removeRecoveryResidue(target, transaction, 'stage', stagePath, 'deployment transaction stage');
    await removeRecoveryResidue(target, transaction, 'failed', failedPath, 'failed managed runtime');
    await removeTransactionMarker(target, transaction);
    return true;
  }

  // A first install has no previous tree.  Any runtime is transaction-owned
  // only when it exactly matches the candidate inventory; otherwise fail
  // closed rather than deleting an unrelated runtime directory.
  if (!backupPath) {
    const runtimePresent = await pathExists(runtimeTarget, 'managed runtime during recovery');
    if (runtimePresent && !(await candidateExact())) throw new Error('uncommitted first install runtime is not exact');
    if (await pathExists(failedPath, 'failed managed runtime') && !(await failedExact())) throw new Error('failed managed runtime is not exact');
    if (runtimePresent) {
      await removeRecoveryResidue(target, transaction, 'failed', runtimeTarget, 'uncommitted managed runtime');
    }
    await removeRecoveryResidue(target, transaction, 'stage', stagePath, 'deployment transaction stage');
    await removeRecoveryResidue(target, transaction, 'failed', failedPath, 'failed managed runtime');
    await removeTransactionMarker(target, transaction);
    return true;
  }

  // A marker before commit always rolls back to the exact previous tree.  A
  // `published` marker with no backup can only be an already-complete legacy
  // publication; accept it only when the candidate itself is exact.
  const backupPresent = backupPath ? await pathExists(backupPath, 'deployment transaction backup') : false;
  let runtimePresent = await pathExists(runtimeTarget, 'managed runtime during recovery');
  const failedPresent = await pathExists(failedPath, 'failed managed runtime');
  // In `prepared` phase the old runtime has not been renamed yet.  A final
  // unowned-content fence can therefore reject publication while leaving a
  // legitimately operator-mutated runtime in place.  Clean only the exact
  // stage/marker names and leave that runtime untouched; requiring the stale
  // pre-capture inventory here would strand an otherwise safe retry.
  if (!backupPresent && transaction.phase === 'prepared' && runtimePresent) {
    await removeRecoveryResidue(target, transaction, 'stage', stagePath, 'deployment transaction stage');
    await removeRecoveryResidue(target, transaction, 'failed', failedPath, 'failed managed runtime');
    await removeTransactionMarker(target, transaction);
    return true;
  }
  if (!backupPresent) {
    if (failedPresent && !(await failedExact())) throw new Error('failed managed runtime is not exact');
    if (await previousExact()) {
      // The old tree is already restored; proceed with residue cleanup.
    } else if (transaction.phase === 'published' && await candidateExact()) {
      transaction.phase = 'committed';
      transaction.recoveryPhase = null;
      await writeTransaction(target, transaction);
      await removeRecoveryResidue(target, transaction, 'stage', stagePath, 'deployment transaction stage');
      await removeRecoveryResidue(target, transaction, 'failed', failedPath, 'failed managed runtime');
      await removeTransactionMarker(target, transaction);
      return true;
    } else {
      throw new Error('deployment transaction backup is unavailable and no exact tree is recoverable');
    }
  } else {
    // If runtime is present and failed is absent, reserve the deterministic
    // failed sibling before moving it out of the way.  If a crash occurred
    // after the rename, runtime is absent and failed is already present.
    if (runtimePresent && !failedPresent) {
      // The runtime may be truncated, stale, or otherwise damaged after a
      // power loss.  The durable marker already binds this exact runtime
      // pathname to the transaction; do not require candidate equality before
      // moving it aside when an exact verified backup is available.
      await persistRecovery(target, transaction, 'runtime-to-failed');
      transactionCrashRequested('recovery-runtime-to-failed-before');
      await fs.rename(runtimeTarget, failedPath);
      await syncParent(target);
      transactionCrashRequested('recovery-runtime-to-failed');
      transaction.recoveryPhase = null;
      await writeTransaction(target, transaction);
    } else if (runtimePresent && failedPresent) {
      // Both names can coexist only after a retry was interrupted.  Require
      // the failed tree to be an exact candidate before discarding the live
      // duplicate; never remove an unknown directory.
      if (!(await exactTree(failedPath, transaction.inventory, transaction.aggregate, 'failed managed runtime'))) throw new Error('failed managed runtime is not exact');
      if (!(await exactTree(runtimeTarget, transaction.inventory, transaction.aggregate, 'candidate managed tree during recovery'))) throw new Error('runtime during recovery is not exact');
      await removeRecoveryResidue(target, transaction, 'failed', runtimeTarget, 'duplicate candidate managed runtime');
      runtimePresent = false;
    }

    const restoredRuntime = await pathExists(runtimeTarget, 'managed runtime during recovery');
    const restoredBackup = await pathExists(backupPath, 'deployment transaction backup');
    if (!restoredRuntime && restoredBackup) {
      await persistRecovery(target, transaction, 'backup-to-runtime');
      transactionCrashRequested('recovery-backup-to-runtime-before');
      await fs.rename(backupPath, runtimeTarget);
      await syncParent(target);
      await syncTreeBottomUp(runtimeTarget, 'restored managed tree');
      transactionCrashRequested('recovery-backup-to-runtime');
      transaction.recoveryPhase = null;
      await writeTransaction(target, transaction);
    }
    if (!(await previousExact())) throw new Error('restored managed tree is not exact');
    await persistRecovery(target, transaction, 'restored-verification');
    transactionCrashRequested('recovery-restored-verified-before');
    const restored = await verifyManagedTree(runtimeTarget, transaction.previousInventory, 'restored managed tree', transaction.previousAggregate);
    if (restored.aggregate !== transaction.previousAggregate) throw new Error('restored managed tree aggregate drift');
    transactionCrashRequested('recovery-restored-verified');
    transaction.recoveryPhase = null;
    await writeTransaction(target, transaction);
  }

  await removeRecoveryResidue(target, transaction, 'failed', failedPath, 'failed managed runtime');
  await removeRecoveryResidue(target, transaction, 'stage', stagePath, 'deployment transaction stage');
  await removeRecoveryResidue(target, transaction, 'backup', backupPath, 'deployment transaction backup');
  await removeTransactionMarker(target, transaction);
  return true;
}

async function writeStageFile(stageRoot, file) {
  const declaredPath = file.relative ?? file.path;
  const relativePath = safeDeploymentPath(declaredPath).slice('runtime/'.length);
  const path = join(stageRoot, relativePath);
  await ensureDir(dirname(path), 'deployment stage parent');
  if (dirname(path) !== stageRoot) transactionCrashRequested('stage-directory-created');
  await fs.writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 });
  if (Number.isInteger(file.mode)) await fs.chmod(path, file.mode & 0o7777);
  await syncFile(path);
  // A file's data and inode are not enough: the containing directory entry
  // must also be durable before the staged tree can be published.
  await syncDir(dirname(path));
}

async function buildManagedStage(target, payloadFiles, manifestBytes, expectedInventory, preservedFiles, stageName) {
  const stagePath = transactionPath(target, stageName);
  await fs.mkdir(stagePath, { mode: 0o700 });
  await syncParent(target);
  await syncDir(stagePath);
  transactionCrashRequested('stage-created');
  try {
    await fs.chmod(stagePath, 0o700);
    for (const file of preservedFiles) await writeStageFile(stagePath, file);
    for (const file of payloadFiles) await writeStageFile(stagePath, file);
    await writeStageFile(stagePath, { relative: manifestName, bytes: manifestBytes });
    await syncTreeBottomUp(stagePath, 'staged managed tree');
    const fullInventory = [...expectedInventory, ...preservedFiles.map((file) => ({ path: file.path, digest: file.digest }))];
    const verified = await verifyManagedTree(stagePath, expectedInventory, 'staged managed tree', inventoryDigest(fullInventory), preservedFiles);
    transactionCrashRequested('stage-verified');
    return Object.freeze({ stageName, stagePath, verified });
  } catch (error) {
    await removeOwnedPath(stagePath, 'deployment stage', 'directory').catch(() => undefined);
    throw error;
  }
}

async function publishManagedTree(target, payloadFiles, manifestBytes, expectedInventory, preservedFiles, owner = { pid: process.pid, id: randomUUID() }, expectedPrevious = undefined, beforePublication = undefined) {
  const runtimeTarget = join(target, 'runtime');
  const transactionId = randomUUID();
  const fullInventory = [...expectedInventory, ...preservedFiles.map((file) => ({ path: file.path, digest: file.digest }))].sort((a, b) => stableCompare(a.path, b.path));
  let transaction;
  let markerWritten = false;
  let stage;
  try {
    const existingRuntime = await lstat(runtimeTarget, 'managed runtime');
    if (existingRuntime?.isSymbolicLink() || (existingRuntime && !existingRuntime.isDirectory())) throw new Error('managed runtime is not a regular directory');
    const existingRuntimeIdentity = existingRuntime ? { dev: String(existingRuntime.dev), ino: String(existingRuntime.ino) } : undefined;
    const previous = existingRuntime ? await captureRuntimeInventory(runtimeTarget) : { files: [], aggregate: inventoryDigest([]) };
    if (expectedPrevious && (!existingRuntime || previous.aggregate !== expectedPrevious.aggregate || canonical(previous.files) !== canonical(expectedPrevious.inventory))) throw new Error('previous managed tree differs from the exact predecessor');
    const stageName = transactionSiblingName('stage', transactionId);
    const backupName = existingRuntime ? transactionSiblingName('backup', transactionId) : null;
    const failedName = transactionSiblingName('failed', transactionId);
    transaction = {
      schema: transactionSchema,
      id: transactionId,
      target: 'runtime',
      phase: 'prepared',
      ownerPid: owner.pid,
      ownerId: owner.id,
      tempName: transactionTempName(transactionId),
      stageName,
      backupName,
      failedName,
      recoveryPhase: null,
      inventory: fullInventory,
      aggregate: inventoryDigest(fullInventory),
      previousInventory: previous.files,
      previousAggregate: previous.aggregate,
    };
    await writeTransaction(target, transaction, { create: true });
    markerWritten = true;
    transactionCrashRequested('marker-prepared');
    stage = await buildManagedStage(target, payloadFiles, manifestBytes, expectedInventory, preservedFiles, stageName);
    if (existingRuntime) {
      // The old tree becomes the rollback backup on the next rename.  Sync it
      // bottom-up before the final unowned-content fence so even a runtime
      // created by an older deployment has a complete durability proof.
      await syncTreeBottomUp(runtimeTarget, 'previous managed tree before publication');
      // This is the last observation of explicitly unowned bytes before the
      // runtime directory is exchanged.  Fence both inode identity and exact
      // content so a concurrent operator edit cannot be overwritten by the
      // stale preserved snapshot copied into the stage.
      await testDelayBeforePreservedFence();
      const currentRuntime = await lstat(runtimeTarget, 'managed runtime before publication');
      if (!currentRuntime || !sameStatIdentity(currentRuntime, existingRuntimeIdentity)) throw new Error('managed runtime changed before publication');
      if (expectedPrevious) await verifyManagedTree(runtimeTarget, expectedPrevious.inventory, 'previous exact managed tree before publication', expectedPrevious.aggregate);
      await assertPreservedRuntimeFence(runtimeTarget, expectedInventory, preservedFiles);
      if (beforePublication) await beforePublication();
      await fs.rename(runtimeTarget, transactionPath(target, backupName));
      await syncParent(target);
      transactionCrashRequested('old-tree-renamed');
      transaction.phase = 'old-moved';
      await writeTransaction(target, transaction);
    } else if (beforePublication) await beforePublication();
    if (existingRuntime) transactionCrashRequested('marker-old-moved');
    await fs.rename(stage.stagePath, runtimeTarget);
    await syncParent(target);
    transactionCrashRequested('new-moved');
    transaction.phase = 'published';
    await writeTransaction(target, transaction);
    transactionCrashRequested('marker-published');
    const verified = await verifyManagedTree(runtimeTarget, expectedInventory, 'published managed tree', transaction.aggregate, preservedFiles);
    transactionCrashRequested('verified');
    // `committed` is the durable success boundary.  Keep the old tree and
    // marker until this record is fsync'd, so a crash during any cleanup can
    // still be replayed idempotently without losing rollback authority.
    transaction.phase = 'committed';
    transaction.recoveryPhase = null;
    await writeTransaction(target, transaction);
    transactionCrashRequested('committed');
    await removeRecoveryResidue(target, transaction, 'backup', backupName ? transactionPath(target, backupName) : undefined, 'deployment transaction backup');
    await removeRecoveryResidue(target, transaction, 'stage', stage.stagePath, 'deployment transaction stage');
    await removeRecoveryResidue(target, transaction, 'failed', transactionPath(target, transaction.failedName), 'failed managed runtime');
    await removeTransactionMarker(target, transaction);
    return Object.freeze({ ...verified, aggregate: transaction.aggregate });
  } catch (error) {
    if (!markerWritten) {
      throw error;
    }
    // Keep a best-effort exact old-tree restore on every first red.  If the
    // restore itself fails, retain the marker and surface the recovery error;
    // the next invocation will refuse to trust the incomplete transaction.
    try {
      await recoverTransaction(target);
    } catch (recoveryError) {
      throw new Error(`${error.message}; deployment rollback failed: ${recoveryError.message}`);
    }
    throw error;
  }
}

function normalizeLauncherBytes(bytes) {
  let source = bytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(bytes)) throw new Error('rollback launcher is not valid UTF-8');
  for (const [name, marker] of [['MANIFEST', '__LUNACY_MANIFEST_DIGEST__'], ['LAUNCHER', '__LUNACY_LAUNCHER_DIGEST__']]) {
    const pattern = new RegExp(`(^const EXPECTED_${name}_DIGEST = \")([0-9a-f]{64})(\";)$`, 'm');
    const normalized = source.replace(pattern, `$1${marker}$3`);
    if (normalized === source) throw new Error(`rollback launcher ${name.toLowerCase()} digest literal is malformed`);
    source = normalized;
  }
  return Buffer.from(source);
}

function parseClosedObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is malformed`);
  const actual = Object.keys(value).sort(stableCompare);
  const expected = [...keys].sort(stableCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has unexpected fields`);
}

async function readDeploymentBundle(payloadArgument, inventoryArgument, aggregateArgument, expected) {
  const payloadArgumentPath = resolve(payloadArgument);
  await ensureDir(payloadArgumentPath, 'rollback payload');
  const nestedRuntime = join(payloadArgumentPath, 'runtime');
  const nestedStat = await lstat(nestedRuntime, 'rollback payload runtime');
  const payloadRoot = nestedStat?.isDirectory() ? nestedRuntime : payloadArgumentPath;
  const inventoryPath = resolve(inventoryArgument);
  const inventoryBytes = await readBounded(inventoryPath, MAX_MANIFEST_BYTES, 'rollback inventory');
  const inventoryText = inventoryBytes.toString('utf8');
  if (!Buffer.from(inventoryText, 'utf8').equals(inventoryBytes)) throw new Error('rollback inventory is not valid UTF-8');
  let descriptor;
  try { descriptor = JSON.parse(inventoryText); } catch { throw new Error('rollback inventory is malformed'); }
  if (`${canonical(descriptor)}\n` !== inventoryText) throw new Error('rollback inventory is not canonical');
  parseClosedObject(descriptor, ['aggregate', 'bridgeVersion', 'files', 'launcherDigest', 'manifestDigest', 'runtimeVersion', 'schema'], 'rollback inventory');
  if (descriptor.schema !== 1 || descriptor.bridgeVersion !== expected.bridgeVersion || descriptor.runtimeVersion !== expected.runtimeVersion) throw new Error(`${expected.label} inventory is not the expected release`);
  for (const [key, value] of [['aggregate', descriptor.aggregate], ['launcherDigest', descriptor.launcherDigest], ['manifestDigest', descriptor.manifestDigest]]) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`rollback inventory ${key} is malformed`);
  }
  if (aggregateArgument !== undefined && aggregateArgument !== descriptor.aggregate) throw new Error('rollback aggregate does not match the attested inventory');
  if (!Array.isArray(descriptor.files) || descriptor.files.length === 0) throw new Error('rollback inventory files are malformed');
  const records = descriptor.files.map((record) => {
    parseClosedObject(record, ['digest', 'path'], 'rollback inventory record');
    if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) throw new Error('rollback inventory record digest is malformed');
    const path = safeDeploymentPath(record.path);
    if (!isDeploymentOwnedPath(path)) throw new Error(`rollback inventory path is not deployment-owned: ${path}`);
    return { path, digest: record.digest };
  }).sort((a, b) => stableCompare(a.path, b.path));
  if (new Set(records.map((record) => record.path)).size !== records.length) throw new Error('rollback inventory contains duplicate paths');
  if (inventoryDigest(records) !== descriptor.aggregate) throw new Error('rollback inventory aggregate is inconsistent');
  const manifestRecord = records.find((record) => record.path === manifestName);
  const launcherRecord = records.find((record) => record.path === 'runtime/bridge.mjs');
  if (!manifestRecord || !launcherRecord) throw new Error('rollback inventory is missing manifest or launcher');
  const manifestPath = join(payloadRoot, 'DEPLOYMENT.json');
  const manifestBytes = await readBounded(manifestPath, MAX_MANIFEST_BYTES, 'rollback deployment manifest');
  if (hash(manifestBytes) !== descriptor.manifestDigest || hash(manifestBytes) !== manifestRecord.digest) throw new Error('rollback deployment manifest digest does not match the attested inventory');
  const manifestText = manifestBytes.toString('utf8');
  if (!Buffer.from(manifestText, 'utf8').equals(manifestBytes)) throw new Error('rollback deployment manifest is not valid UTF-8');
  let manifest;
  try { manifest = JSON.parse(manifestText); } catch { throw new Error('rollback deployment manifest is malformed'); }
  if (`${canonical(manifest)}\n` !== manifestText) throw new Error('rollback deployment manifest is not canonical');
  parseClosedObject(manifest, ['bridgeVersion', 'files', 'launcherDigest', 'runtimeVersion', 'schema', 'sourceDigest'], 'rollback deployment manifest');
  if (manifest.schema !== 1 || manifest.bridgeVersion !== expected.bridgeVersion || manifest.runtimeVersion !== expected.runtimeVersion || manifest.launcherDigest !== descriptor.launcherDigest || typeof manifest.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sourceDigest) || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error(`${expected.label} deployment manifest is not the expected release`);
  const manifestFiles = manifest.files.map((path) => safeDeploymentPath(path));
  if (manifestFiles.includes(manifestName) || manifestFiles.includes('runtime/bridge.mjs') || manifestFiles.includes('runtime/README.md')) throw new Error('rollback deployment manifest source files contain generated entries');
  if (new Set(manifestFiles).size !== manifestFiles.length || manifestFiles.some((path) => !records.some((record) => record.path === path))) throw new Error('rollback deployment manifest files are not covered by the attested inventory');
  const sourceRecords = [];
  for (const path of manifestFiles) {
    const bytes = await readBounded(join(payloadRoot, path.slice('runtime/'.length)), MAX_PAYLOAD_FILE_BYTES, `rollback payload ${path}`);
    sourceRecords.push({ path, digest: hash(bytes) });
  }
  if (hash(Buffer.from(sourceRecords.map((record) => `${record.path}\0${record.digest}`).join('\n'))) !== manifest.sourceDigest) throw new Error('rollback deployment source digest is inconsistent');
  const launcherBytes = await readBounded(join(payloadRoot, 'bridge.mjs'), MAX_PAYLOAD_FILE_BYTES, 'rollback launcher');
  if (hash(normalizeLauncherBytes(launcherBytes)) !== descriptor.launcherDigest || launcherRecord.digest !== hash(launcherBytes)) throw new Error('rollback launcher digest does not match the attested inventory');
  const payloadFiles = [];
  let payloadBytes = 0;
  for (const record of records) {
    if (record.path === manifestName) continue;
    const path = join(payloadRoot, record.path.slice('runtime/'.length));
    const remaining = MAX_PAYLOAD_TOTAL_BYTES - payloadBytes;
    const bytes = await readBounded(path, Math.min(MAX_PAYLOAD_FILE_BYTES, remaining), `rollback payload ${record.path}`);
    payloadBytes += bytes.byteLength;
    if (payloadBytes > MAX_PAYLOAD_TOTAL_BYTES) throw new Error('rollback payload exceeds aggregate byte limit');
    const stat = await lstat(path, `rollback payload ${record.path}`);
    if (!stat || !stat.isFile() || hash(bytes) !== record.digest) throw new Error(`rollback payload ${record.path} does not match the attested inventory`);
    payloadFiles.push({ relative: record.path, bytes, digest: record.digest, mode: stat.mode & 0o7777 });
  }
  const verified = await verifyManagedTree(payloadRoot, records, 'rollback payload', descriptor.aggregate);
  if (verified.aggregate !== descriptor.aggregate) throw new Error('rollback payload aggregate drift');
  const identity = Object.freeze({
    schema: 'lunacy-deployment-identity/v1',
    runtimeVersion: descriptor.runtimeVersion,
    bridgeVersion: descriptor.bridgeVersion,
    sourceDigest: manifest.sourceDigest,
    deploymentManifestDigest: hash(manifestBytes),
    launcherDigest: descriptor.launcherDigest,
    inventoryDigest: hash(inventoryBytes),
    inventoryAggregate: descriptor.aggregate,
    fileCount: records.length,
  });
  return Object.freeze({ payloadRoot, payloadFiles, manifestBytes, expectedInventory: records, descriptor, identity });
}

async function readRestoreBundle(payloadArgument, inventoryArgument, aggregateArgument) {
  return readDeploymentBundle(payloadArgument, inventoryArgument, aggregateArgument, { label: 'rollback', runtimeVersion: '0.2.12', bridgeVersion: '0.1.0' });
}

async function readExactLegacyDeployBundles(args, manifest) {
  const [installed, candidate] = await Promise.all([
    readRestoreBundle(args.payload, args.inventory, args.aggregate),
    readDeploymentBundle(args.candidatePayload, args.candidateInventory, args.candidateAggregate, { label: 'candidate', runtimeVersion: '0.3.0', bridgeVersion: '0.2.0' }),
  ]);
  if (canonical(installed.identity) !== canonical(manifest.installedDeployment)) throw new Error('installed rollback identity differs from the release manifest');
  if (canonical(candidate.identity) !== canonical(manifest.candidateDeployment)) throw new Error('preserved candidate identity differs from the release manifest');
  return Object.freeze({ installed, candidate });
}

function assertExactLegacyRecoveryBinding(transaction, bundles) {
  if (!transaction) return;
  const candidateInventory = bundles.candidate.expectedInventory;
  const installedInventory = bundles.installed.expectedInventory;
  if (transaction.aggregate !== bundles.candidate.identity.inventoryAggregate
    || canonical(transaction.inventory) !== canonical(candidateInventory)
    || transaction.previousAggregate !== bundles.installed.identity.inventoryAggregate
    || canonical(transaction.previousInventory) !== canonical(installedInventory)) {
    throw new Error('stale deployment transaction is not bound to the exact predecessor and candidate');
  }
}

function parseArgs(argv) {
  let target = process.env.LUNACY_SKILL_ROOT || defaultTarget; let check = false; let restore = false; let exactLegacyDeploy = false; let payload; let inventory; let aggregate; let candidatePayload; let candidateInventory; let candidateAggregate; let releaseManifest; let releaseEnvelope = false; let envelopeStatus = false; let resumeRelease = false; let retentionAdmission = 'OFF'; let retentionAdmissionExplicit = false; let retentionAbandonment = 'OFF'; let retentionAbandonmentExplicit = false; const retentionRunParents = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') { check = true; continue; }
    if (arg === '--restore') { restore = true; continue; }
    if (arg === '--exact-0.2.12-to-candidate') { exactLegacyDeploy = true; continue; }
    if (arg === '--release-envelope' || arg === '--resume-release') { releaseEnvelope = true; if (arg === '--resume-release') resumeRelease = true; continue; }
    if (arg === '--release-envelope-status' || arg === '--status-release') { envelopeStatus = true; continue; }
    if (arg === '--payload' || arg === '--rollback-payload' || arg === '--rollback-dir') { payload = argv[++i]; if (!payload || payload.startsWith('--')) throw new Error(`${arg} requires a path`); continue; }
    if (arg === '--inventory' || arg === '--rollback-inventory' || arg === '--expected-inventory') { inventory = argv[++i]; if (!inventory || inventory.startsWith('--')) throw new Error(`${arg} requires a path`); continue; }
    if (arg === '--aggregate' || arg === '--rollback-aggregate' || arg === '--expected-aggregate') { aggregate = argv[++i]; if (!aggregate || aggregate.startsWith('--') || !/^[0-9a-f]{64}$/.test(aggregate)) throw new Error(`${arg} requires a 64-character SHA-256 digest`); continue; }
    if (arg === '--candidate-payload') { candidatePayload = argv[++i]; if (!candidatePayload || candidatePayload.startsWith('--')) throw new Error('--candidate-payload requires a path'); continue; }
    if (arg === '--candidate-inventory') { candidateInventory = argv[++i]; if (!candidateInventory || candidateInventory.startsWith('--')) throw new Error('--candidate-inventory requires a path'); continue; }
    if (arg === '--candidate-aggregate') { candidateAggregate = argv[++i]; if (!candidateAggregate || candidateAggregate.startsWith('--') || !/^[0-9a-f]{64}$/.test(candidateAggregate)) throw new Error('--candidate-aggregate requires a 64-character SHA-256 digest'); continue; }
    if (arg === '--target') { target = argv[++i]; if (!target || target.startsWith('--')) throw new Error('--target requires a path'); continue; }
    if (arg === '--retention-admission') { retentionAdmission = argv[++i]; retentionAdmissionExplicit = true; if (retentionAdmission !== 'OFF' && retentionAdmission !== 'ON') throw new Error('retention admission must be OFF or ON'); continue; }
    if (arg === '--retention-abandonment') { retentionAbandonment = argv[++i]; retentionAbandonmentExplicit = true; if (retentionAbandonment !== 'OFF' && retentionAbandonment !== 'ON') throw new Error('retention abandonment must be OFF or ON'); continue; }
    if (arg === '--retention-run-parent') { const parent = argv[++i]; if (!parent || parent.startsWith('--') || !isAbsolute(parent) || resolve(parent) !== parent) throw new Error('--retention-run-parent requires an absolute canonical path'); retentionRunParents.push(parent); continue; }
    if (arg === '--release-manifest') { releaseManifest = argv[++i]; if (!releaseManifest || releaseManifest.startsWith('--')) throw new Error('--release-manifest requires a path'); continue; }
    if (arg === '--help' || arg === '-h') { console.log('Usage: node tools/deploy-skill.mjs [--target SKILL_ROOT] [--check] [--retention-admission OFF|ON] [--retention-abandonment OFF|ON] --retention-run-parent ABSOLUTE [--release-envelope]\n       node tools/deploy-skill.mjs --target SKILL_ROOT --restore --payload PAYLOAD_DIR --inventory INVENTORY.json --aggregate SHA256\n       private exact predecessor deploy: --exact-0.2.12-to-candidate plus rollback and candidate payload/inventory/aggregate and --release-manifest\n       add --release-manifest MANIFEST.json for the production release boundary\n       --retention-run-parent is repeatable and scopes the bounded admitted-state census\n       --release-envelope-status inspects the private resumable envelope without mutation'); process.exit(0); }
    throw new Error(`unknown argument ${arg}`);
  }
  if ([check, restore, exactLegacyDeploy].filter(Boolean).length > 1) throw new Error('--check, --restore, and --exact-0.2.12-to-candidate are mutually exclusive');
  if (envelopeStatus && (releaseEnvelope || resumeRelease || check || restore || exactLegacyDeploy)) throw new Error('release envelope status is read-only and cannot be combined with an operation');
  if (restore && (!payload || !inventory || aggregate === undefined)) throw new Error('--restore requires --payload, --inventory, and --aggregate');
  if (exactLegacyDeploy && (!payload || !inventory || aggregate === undefined || !candidatePayload || !candidateInventory || candidateAggregate === undefined || !releaseManifest)) throw new Error('--exact-0.2.12-to-candidate requires rollback and candidate payload/inventory/aggregate plus --release-manifest');
  if (!restore && !exactLegacyDeploy && (payload || inventory || aggregate !== undefined)) throw new Error('--payload, --inventory, and --aggregate require --restore or --exact-0.2.12-to-candidate');
  if (!exactLegacyDeploy && (candidatePayload || candidateInventory || candidateAggregate !== undefined)) throw new Error('candidate payload, inventory, and aggregate require --exact-0.2.12-to-candidate');
  if (retentionRunParents.length > MAX_RETENTION_RUN_PARENTS || new Set(retentionRunParents).size !== retentionRunParents.length) throw new Error('retention run parents are duplicate or exceed their limit');
  retentionRunParents.sort(stableCompare);
  if ((retentionAdmissionExplicit || retentionAbandonmentExplicit) && retentionRunParents.length === 0) throw new Error('--retention-run-parent is required with retention policy options');
  return { target: resolve(target), check, restore, exactLegacyDeploy, releaseEnvelope, envelopeStatus, resumeRelease, retentionAdmission, retentionAdmissionExplicit, retentionAbandonment, retentionAbandonmentExplicit, retentionRunParents, payload: payload ? resolve(payload) : undefined, inventory: inventory ? resolve(inventory) : undefined, aggregate, candidatePayload: candidatePayload ? resolve(candidatePayload) : undefined, candidateInventory: candidateInventory ? resolve(candidateInventory) : undefined, candidateAggregate, releaseManifest: releaseManifest ? resolve(releaseManifest) : undefined };
}

function makeWrapper(expectedDigest, expectedFiles, expectedRuntimeVersion, expectedManifestDigest, expectedLauncherDigest, expectedNode) {
  return [
    `#!${expectedNode.path}`,
    "import { createHash } from 'node:crypto';",
    "import { constants as fsConstants, promises as fs } from 'node:fs';",
    "import { dirname, join, relative, resolve, sep } from 'node:path';",
    "import { tmpdir } from 'node:os';",
    "import { fileURLToPath } from 'node:url';",
    "import { isBuiltin, registerHooks } from 'node:module';",
    `const EXPECTED_SOURCE_DIGEST = ${JSON.stringify(expectedDigest)};`,
    `const EXPECTED_FILES = Object.freeze(${JSON.stringify(expectedFiles)});`,
    `const EXPECTED_RUNTIME_VERSION = ${JSON.stringify(expectedRuntimeVersion)};`,
    `const EXPECTED_MANIFEST_DIGEST = ${JSON.stringify(expectedManifestDigest)};`,
    `const EXPECTED_LAUNCHER_DIGEST = ${JSON.stringify(expectedLauncherDigest)};`,
    `const EXPECTED_NODE_PATH = ${JSON.stringify(expectedNode.path)};`,
    `const EXPECTED_NODE_VERSION = ${JSON.stringify(expectedNode.version)};`,
    `const EXPECTED_NODE_DIGEST = ${JSON.stringify(expectedNode.digest)};`,
    'const MAX_MANIFEST_BYTES = 1024 * 1024;',
    'const MAX_PAYLOAD_FILE_BYTES = 4 * 1024 * 1024;',
    'const MAX_PAYLOAD_TOTAL_BYTES = 64 * 1024 * 1024;',
    'const runtimeDir = dirname(fileURLToPath(import.meta.url));',
    'const skillRoot = resolve(runtimeDir, "..");',
    'const launcherPath = fileURLToPath(import.meta.url);',
    'const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");',
    'const verifyNodeRuntime = async () => { const actualPath = resolve(await fs.realpath(process.execPath)); if (actualPath !== EXPECTED_NODE_PATH || process.versions.node !== EXPECTED_NODE_VERSION) throw new Error("Node executable/version is not the attested runtime"); const stat = await fs.stat(actualPath); if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error("Node executable is not a regular executable file"); trustedStat(stat, "Node executable"); if (hash(await fs.readFile(actualPath)) !== EXPECTED_NODE_DIGEST) throw new Error("Node executable digest changed"); };',
    'const normalizeLauncher = (bytes) => { let source = bytes.toString("utf8"); for (const [name, marker] of [["MANIFEST", "__LUNACY_MANIFEST_DIGEST__"], ["LAUNCHER", "__LUNACY_LAUNCHER_DIGEST__"]]) { const pattern = new RegExp(`(^const EXPECTED_${name}_DIGEST = \")([0-9a-f]{64})(\";)$`, "m"); const normalized = source.replace(pattern, `$1${marker}$3`); if (normalized === source) throw new Error("trusted launcher fingerprint is malformed"); source = normalized; } return Buffer.from(source); };',
    'const trustedStat = (stat, label) => { if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(label + " is not owned by the current user"); if ((stat.mode & 0o022) !== 0) throw new Error(label + " is group/world-writable"); };',
    'const pathWithin = (parent, candidate) => candidate === parent || candidate.startsWith(parent + sep);',
    'const tempLexical = resolve(tmpdir());',
    'const tempRoots = [...new Set([tempLexical, "/tmp"])];',
    'const tempPhysical = await Promise.all(tempRoots.map((root) => fs.realpath(root).catch(() => root)));',
    'const allowedTempAlias = async (path) => { for (let index = 0; index < tempRoots.length; index += 1) { if (!pathWithin(path, tempRoots[index])) continue; const actual = await fs.realpath(path).catch(() => ""); if (actual && (pathWithin(actual, tempPhysical[index]) || pathWithin(tempPhysical[index], actual))) return true; } return false; };',
    'const trustedPath = async (path, label, kind = "any", allowMissing = false) => { const target = resolve(path); const parts = target.split(sep).filter(Boolean); let current = sep; let finalStat; let missing = false; for (let index = 0; index < parts.length; index += 1) { current = current === sep ? join(current, parts[index]) : join(current, parts[index]); if (missing) continue; let stat; try { stat = await fs.lstat(current); } catch (error) { if (error.code === "ENOENT") { missing = true; continue; } throw error; } const final = index === parts.length - 1; if (stat.isSymbolicLink()) { if (final || !(await allowedTempAlias(current))) throw new Error(label + " contains an untrusted symlink"); continue; } if ((stat.mode & 0o022) !== 0) { const stickyTemp = (stat.mode & 0o1000) !== 0 && (stat.mode & 0o002) !== 0 && (tempRoots.includes(current) || tempPhysical.includes(current)); if (!stickyTemp) throw new Error(label + " is group/world-writable"); } if (!final && !stat.isDirectory()) throw new Error(label + " ancestor is not a directory"); if (final) finalStat = stat; } if (!finalStat) { if (allowMissing) return undefined; throw new Error(label + " is absent"); } if (kind === "directory" && !finalStat.isDirectory()) throw new Error(label + " is not a directory"); if (kind === "file" && !finalStat.isFile()) throw new Error(label + " is not a regular file"); trustedStat(finalStat, label); return { stat: finalStat, identity: { dev: String(finalStat.dev), ino: String(finalStat.ino) } }; };',
    'const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;',
    'const stablePath = async (path, expected, label) => { const current = await trustedPath(path, label, "directory"); if (!current || !sameIdentity(current.identity, expected)) throw new Error(label + " changed identity"); };',
    'const safePath = (item) => { if (typeof item !== "string" || !item.startsWith("runtime/") || item.includes(String.fromCharCode(92)) || item.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("deployment manifest path is unsafe"); return item; };',
    'const physicalWithin = async (path, label) => { const runtimePhysical = await fs.realpath(runtimeDir); const pathPhysical = await fs.realpath(path); const rel = relative(runtimePhysical, pathPhysical); if (!rel || rel === ".." || rel.startsWith(".." + sep) || pathPhysical !== resolve(runtimePhysical, rel)) throw new Error(label + " escapes the physical runtime directory"); };',
    'const regular = async (path, label, limit = MAX_PAYLOAD_FILE_BYTES) => { if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(label + " has an invalid byte limit"); const runtime = await trustedPath(runtimeDir, "runtime directory", "directory"); const root = await trustedPath(skillRoot, "skill root", "directory"); const before = await trustedPath(path, label, "file"); await physicalWithin(path, label); const handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error(label + " is not a regular file"); trustedStat(stat, label); if (!sameIdentity({ dev: String(stat.dev), ino: String(stat.ino) }, before.identity)) throw new Error(label + " changed before descriptor binding"); const after = await trustedPath(path, label, "file"); if (!after || !sameIdentity({ dev: String(stat.dev), ino: String(stat.ino) }, after.identity)) throw new Error(label + " changed during descriptor binding"); if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > limit) throw new Error(label + " exceeds its byte limit"); const expected = stat.size; const chunks = []; const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expected + 1))); let total = 0; while (true) { const result = await handle.read(buffer, 0, buffer.length, null); if (result.bytesRead === 0) break; if (result.bytesRead > expected - total || result.bytesRead > limit - total) throw new Error(label + " changed during bounded read"); chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead))); total += result.bytesRead; } if (total !== expected) throw new Error(label + " changed during bounded read"); return Buffer.concat(chunks, total); } finally { await handle.close(); } };',
    'const ENTRY_URL = "lunacy:///dist/bridge-cli.js";',
    'const LUNACY_PREFIX = "lunacy:///";',
    'const LAUNCHER_URL = import.meta.url;',
    'let verifiedGraphHookRegistration;',
    'const registerVerifiedGraph = (bytesByPath) => {',
    '  const graph = new Map();',
    '  for (const [item, bytes] of bytesByPath) {',
    '    if (!item.startsWith("runtime/dist/") || !item.endsWith(".js")) continue;',
    '    const modulePath = item.slice("runtime/".length);',
    '    const url = LUNACY_PREFIX + modulePath;',
    '    let parsed;',
    '    try { parsed = new URL(url); } catch { throw new Error("verified module URL is malformed: " + url); }',
    '    if (parsed.href !== url || parsed.protocol !== "lunacy:" || parsed.host !== "" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") throw new Error("verified module URL is non-canonical: " + url);',
    '    const source = bytes.toString("utf8");',
    '    if (!Buffer.from(source, "utf8").equals(bytes)) throw new Error("verified module source is not UTF-8: " + url);',
    '    if (graph.has(url)) throw new Error("verified module URL is duplicated: " + url);',
    '    graph.set(url, Object.freeze({ bytes, source }));',
    '  }',
    '  const graphHas = Map.prototype.has.bind(graph);',
    '  const graphGet = Map.prototype.get.bind(graph);',
    '  if (!graphHas(ENTRY_URL)) throw new Error("verified module entry is absent: " + ENTRY_URL);',
    '  const isLunacyURL = (value) => { if (typeof value !== "string") return false; try { return new URL(value).protocol === "lunacy:"; } catch { return false; } };',
    '  verifiedGraphHookRegistration = registerHooks({',
    '    resolve(specifier, context, nextResolve) {',
    '      const parentURL = context.parentURL;',
    '      if (specifier === ENTRY_URL && parentURL === LAUNCHER_URL) return { url: ENTRY_URL, shortCircuit: true };',
    '      if (typeof parentURL === "string" && graphHas(parentURL)) {',
    '        if (specifier.startsWith("./") || specifier.startsWith("../")) {',
    '          if (specifier.includes("%")) throw new Error("verified module is absent: " + specifier);',
    '          let resolved;',
    '          try { resolved = new URL(specifier, parentURL); } catch { throw new Error("verified module is absent: " + specifier); }',
    '          const url = resolved.href;',
    '          if (resolved.protocol !== "lunacy:" || resolved.host !== "" || resolved.username !== "" || resolved.password !== "" || resolved.search !== "" || resolved.hash !== "" || !graphHas(url)) throw new Error("verified module is absent: " + url);',
    '          return { url, shortCircuit: true };',
    '        }',
    '        if (!isBuiltin(specifier)) throw new Error("unverified module specifier: " + specifier);',
    '        const resolved = nextResolve(specifier, context);',
    '        if (!resolved || typeof resolved.url !== "string" || !resolved.url.startsWith("node:") || !isBuiltin(resolved.url)) throw new Error("unverified module specifier: " + specifier);',
    '        return resolved;',
    '      }',
    '      if (isLunacyURL(specifier) || isLunacyURL(parentURL)) throw new Error("unverified module specifier: " + specifier);',
    '      const resolved = nextResolve(specifier, context);',
    '      if (isLunacyURL(resolved?.url)) throw new Error("unverified module specifier: " + specifier);',
    '      return resolved;',
    '    },',
    '    load(url, context, nextLoad) {',
    '      const record = graphGet(url);',
    '      if (record !== undefined) return { format: "module", source: record.source, shortCircuit: true };',
    '      if (isLunacyURL(url)) throw new Error("verified module is absent: " + url);',
    '      return nextLoad(url, context);',
    '    },',
    '  });',
    '  return import(ENTRY_URL).then((module) => module.runBridgeCli());',
    '};',
    'async function verifyDeployment() {',
    '  const launcherStat = await fs.lstat(launcherPath); if (launcherStat.isSymbolicLink()) throw new Error("trusted launcher is a symlink"); trustedStat(launcherStat, "trusted launcher");',
    '  const launcherBytes = await regular(launcherPath, "trusted launcher");',
    '  if (hash(normalizeLauncher(launcherBytes)) !== EXPECTED_LAUNCHER_DIGEST) throw new Error("deployment fingerprint is not the trusted release");',
    '  const skill = await trustedPath(skillRoot, "skill root", "directory"); const runtime = await trustedPath(runtimeDir, "runtime directory", "directory"); const skillIdentity = skill.identity; const runtimeIdentity = runtime.identity;',
    '  await stablePath(skillRoot, skillIdentity, "skill root"); await stablePath(runtimeDir, runtimeIdentity, "runtime directory");',
    '  const manifestPath = join(runtimeDir, "DEPLOYMENT.json");',
    '  const manifestBytes = await regular(manifestPath, "deployment manifest", MAX_MANIFEST_BYTES);',
    '  const manifest = JSON.parse(manifestBytes.toString("utf8"));',
    '  if (!manifest || Object.keys(manifest).sort().join(",") !== "bridgeVersion,files,launcherDigest,runtimeVersion,schema,sourceDigest" || manifest.schema !== 1 || manifest.bridgeVersion !== "0.2.0" || manifest.runtimeVersion !== EXPECTED_RUNTIME_VERSION || typeof manifest.sourceDigest !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sourceDigest) || typeof manifest.launcherDigest !== "string" || !/^[0-9a-f]{64}$/.test(manifest.launcherDigest) || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("deployment manifest is malformed or runtime version is not trusted");',
    '  if (hash(manifestBytes) !== EXPECTED_MANIFEST_DIGEST || manifest.launcherDigest !== EXPECTED_LAUNCHER_DIGEST) throw new Error("deployment fingerprint is not the trusted release");',
    '  const files = manifest.files.map(safePath);',
    '  if (files.length !== EXPECTED_FILES.length || files.some((item, index) => item !== EXPECTED_FILES[index]) || new Set(files).size !== files.length) throw new Error("deployment manifest release file list is not trusted");',
    '  const records = []; const bytesByPath = new Map(); let payloadBytes = 0;',
    '  for (const item of files) { await stablePath(skillRoot, skillIdentity, "skill root"); await stablePath(runtimeDir, runtimeIdentity, "runtime directory"); const path = resolve(skillRoot, item); const rel = relative(skillRoot, path); if (!rel || rel === ".." || rel.startsWith(".." + sep) || path !== resolve(skillRoot, rel)) throw new Error("deployment manifest path escapes skill root"); const remaining = MAX_PAYLOAD_TOTAL_BYTES - payloadBytes; const bytes = await regular(path, item, Math.min(MAX_PAYLOAD_FILE_BYTES, remaining)); payloadBytes += bytes.byteLength; if (payloadBytes > MAX_PAYLOAD_TOTAL_BYTES) throw new Error("deployment payload exceeds aggregate byte limit"); bytesByPath.set(item, bytes); records.push({ path: item, digest: hash(bytes) }); }',
    '  const sourceDigest = hash(Buffer.from(records.map((record) => record.path + String.fromCharCode(0) + record.digest).join(String.fromCharCode(10))));',
    '  if (sourceDigest !== EXPECTED_SOURCE_DIGEST || sourceDigest !== manifest.sourceDigest) throw new Error("deployment fingerprint is not the trusted release");',
    '  return { bytesByPath };',
    '}',
    'verifyNodeRuntime().then(() => verifyDeployment().then(({ bytesByPath }) => registerVerifiedGraph(bytesByPath))).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(JSON.stringify({ error: String(error?.message ?? error) }) + "\\n"); process.exitCode = 1; });',
    '',
  ].join('\n');
}

async function executeOperation({ target, check, restore, exactLegacyDeploy, payload, inventory, aggregate, candidatePayload, candidateInventory, candidateAggregate, exactLegacyManifest, exactLegacyBundles, retentionAdmission, retentionAbandonment, retentionCensus, releaseGenerationCensus, releaseGenerationFence }, targetLock) {
  // Complete any durable transaction left by a previous crash before taking
  // a new source snapshot.  Recovery touches only our marker/stage/backup
  // names and preserves every non-runtime skill-root path.
  // Acquire a single kernel-atomic target claim before recovery and retain it
  // through the entire check/deploy/restore operation.
  await testHoldTargetLock();
  await recoverTransaction(target);
  if (exactLegacyDeploy) {
    if (!exactLegacyManifest || exactLegacyManifest.operation !== 'deploy-exact-0.2.12') throw new Error('exact predecessor deployment manifest is absent');
    if (!exactLegacyBundles) throw new Error('exact predecessor deployment bundles are absent');
    const { installed, candidate } = exactLegacyBundles;
    const runtimeTarget = join(target, 'runtime');
    const current = await verifyManagedTree(runtimeTarget, installed.expectedInventory, 'installed exact 0.2.12 tree', installed.identity.inventoryAggregate);
    if (current.aggregate !== installed.identity.inventoryAggregate) throw new Error('installed exact 0.2.12 aggregate drift');
    const verified = await publishManagedTree(target, candidate.payloadFiles, candidate.manifestBytes, candidate.expectedInventory, [], targetLock.owner, { inventory: installed.expectedInventory, aggregate: installed.identity.inventoryAggregate }, releaseGenerationFence);
    if (verified.aggregate !== candidate.identity.inventoryAggregate) throw new Error('published candidate aggregate drift');
    console.log(JSON.stringify({ status: 'deployed-exact-predecessor', target, installedDeployment: installed.identity, candidateDeployment: candidate.identity, managedFiles: verified.files, managedDirectories: verified.directories, managedAggregate: verified.aggregate, ...(releaseGenerationCensus ? { releaseGenerationCensusDigest: releaseGenerationCensus.digest, oneShotRolloutGenerationFloor: releaseGenerationCensus.candidateFloor } : {}) }));
    return;
  }
  if (restore) {
    const rollback = await readRestoreBundle(payload, inventory, aggregate);
    const runtimeTarget = join(target, 'runtime');
    const existingRuntime = await lstat(runtimeTarget, 'managed runtime');
    if (existingRuntime?.isSymbolicLink() || (existingRuntime && !existingRuntime.isDirectory())) throw new Error('managed runtime is not a regular directory');
    const preservedFiles = existingRuntime ? await capturePreservedRuntime(runtimeTarget, rollback.expectedInventory) : [];
    const verified = await publishManagedTree(target, rollback.payloadFiles, rollback.manifestBytes, rollback.expectedInventory, preservedFiles, targetLock.owner);
    console.log(JSON.stringify({ status: 'restored', target, runtimeVersion: rollback.descriptor.runtimeVersion, rollbackAggregate: rollback.descriptor.aggregate, manifestDigest: rollback.descriptor.manifestDigest, launcherDigest: rollback.descriptor.launcherDigest, managedFiles: verified.files, managedDirectories: verified.directories, managedAggregate: verified.aggregate }));
    return;
  }
  const targetIdentity = await trustedIdentity(target, 'skill root', { surface: true, kind: 'directory' });
  if (!targetIdentity) throw new Error('skill root identity is unavailable');
  const runtimeTarget = join(target, 'runtime');
  const initialRuntime = await lstat(runtimeTarget, 'managed runtime');
  if (initialRuntime?.isSymbolicLink() || (initialRuntime && !initialRuntime.isDirectory())) throw new Error('managed runtime is not a regular directory');
  const runtimeIdentity = initialRuntime ? await trustedIdentity(runtimeTarget, 'managed runtime', { surface: true, kind: 'directory' }) : undefined;
  const assertDeploymentIdentity = async () => {
    try {
      await assertStableIdentity(target, targetIdentity, 'skill root', { surface: true, kind: 'directory' });
      if (runtimeIdentity) await assertStableIdentity(runtimeTarget, runtimeIdentity, 'managed runtime', { surface: true, kind: 'directory' });
    } catch (error) { throw new Error(error.message.replace(/^FilesystemTrust:\s*/, '')); }
  };
  const nodeAttestation = await attestNodeRuntime();
  // The recovery route is private at the package-export boundary, but the
  // managed bridge launcher must carry its exact compiled modules so the
  // installed `inspect-recovery` route is a real, verifiable deployment.
  const distFiles = await collect(distRoot);
  const policyAssetFiles = await collect(join(sourceRoot, 'assets', 'deliberation-policy'));
  const sourceFiles = [
    ...distFiles.map((item) => ({ source: item.source, relative: `runtime/dist/${item.relative}` })),
    ...policyAssetFiles.map((item) => ({ source: item.source, relative: `runtime/assets/deliberation-policy/${item.relative}` })),
    { source: join(sourceRoot, 'assets', 'deliberation-policy-compatibility', 'map.json'), relative: 'runtime/assets/deliberation-policy-compatibility/map.json' },
    { source: packagePath, relative: 'runtime/package.json' },
    { source: join(sourceRoot, 'docs', 'BRIDGE.md'), relative: 'runtime/BRIDGE.md' },
    { source: join(sourceRoot, 'docs', 'BEADS.md'), relative: 'runtime/BEADS.md' },
    { source: join(sourceRoot, 'docs', 'WORKFRONT.md'), relative: 'runtime/WORKFRONT.md' },
    { source: join(sourceRoot, 'docs', 'DECISION_INBOX.md'), relative: 'runtime/DECISION_INBOX.md' },
    // The Codex host seam is private, but its closed schemas and capability
    // probe are part of the managed skill release.  Keeping them in the
    // signed payload lets a host bind policy paths to the exact deployed
    // bytes instead of reaching back into a mutable source checkout.
    { source: join(sourceRoot, 'docs', 'CODEX_EXEC.md'), relative: 'runtime/CODEX_EXEC.md' },
    { source: join(sourceRoot, 'schemas', 'codex-worker-result.schema.json'), relative: 'runtime/schemas/codex-worker-result.schema.json' },
    { source: join(sourceRoot, 'schemas', 'codex-launch-intent-record.schema.json'), relative: 'runtime/schemas/codex-launch-intent-record.schema.json' },
    { source: join(sourceRoot, 'schemas', 'codex-launch-record.schema.json'), relative: 'runtime/schemas/codex-launch-record.schema.json' },
    { source: join(sourceRoot, 'schemas', 'codex-terminal-record.schema.json'), relative: 'runtime/schemas/codex-terminal-record.schema.json' },
    { source: join(sourceRoot, 'schemas', 'decision-inbox.schema.json'), relative: 'runtime/schemas/decision-inbox.schema.json' },
    { source: join(sourceRoot, 'schemas', 'phase-handoff.schema.json'), relative: 'runtime/schemas/phase-handoff.schema.json' },
    { source: join(sourceRoot, 'tools', 'probe-codex-exec.mjs'), relative: 'runtime/tools/probe-codex-exec.mjs' },
    { source: join(sourceRoot, 'tools', 'bind-release-process-snapshot.mjs'), relative: 'runtime/tools/bind-release-process-snapshot.mjs' },
    { source: join(sourceRoot, 'tools', 'verify-release-quiescence.mjs'), relative: 'runtime/tools/verify-release-quiescence.mjs' },
    { source: join(sourceRoot, 'tools', 'seal-run.mjs'), relative: 'runtime/tools/seal-run.mjs' },
    { source: join(sourceRoot, 'tools', 'with-body-writer.mjs'), relative: 'runtime/tools/with-body-writer.mjs' },
    { source: join(sourceRoot, 'tools', 'audit-run-artifacts.mjs'), relative: 'runtime/tools/audit-run-artifacts.mjs' },
    { source: join(sourceRoot, 'tools', 'migrate-run-body.mjs'), relative: 'runtime/tools/migrate-run-body.mjs' },
    { source: join(sourceRoot, 'tools', 'retention-launcher.mjs'), relative: 'runtime/retention-launcher.mjs' },
  ].filter((file) => {
    // Some recovery/deployment tests exercise this script from a tracked-only
    // temporary checkout.  The P2 inbox contract is additive and may not be
    // present in that fixture yet; omit only these optional files rather than
    // weakening validation for the established release surface.
    const optionalP2 = new Set([
      'runtime/DECISION_INBOX.md',
      'runtime/schemas/decision-inbox.schema.json',
      'runtime/schemas/phase-handoff.schema.json',
    ]);
    return !optionalP2.has(file.relative) || existsSync(file.source);
  });
  sourceFiles.sort((a, b) => stableCompare(a.relative, b.relative));
  const sourceRecords = [];
  const payloadSourceFiles = [];
  for (const file of sourceFiles) {
    const bytes = await readBytes(file.source);
    const digest = hash(bytes);
    payloadSourceFiles.push({ relative: file.relative, bytes, digest });
    sourceRecords.push({ path: file.relative, digest });
  }
  const retentionPolicy = Buffer.from(`${canonical({ schema: 'lunacy-retention-policy/v1', newBodyAdmission: retentionAdmission, abandonment: retentionAbandonment })}\n`);
  payloadSourceFiles.push({ relative: 'runtime/retention-policy.json', bytes: retentionPolicy, digest: hash(retentionPolicy) });
  sourceRecords.push({ path: 'runtime/retention-policy.json', digest: hash(retentionPolicy) });
  const helperPaths = process.platform === 'darwin' ? ['/bin/ps', '/sbin/mount', '/usr/sbin/lsof'] : [];
  const helpers = [];
  for (const path of helperPaths) { const stat = await fs.stat(path); if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0 || stat.size > 16 * 1024 * 1024) throw new Error(`retention platform helper is unavailable: ${path}`); const bytes = await fs.readFile(path); const after = await fs.stat(path); if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || bytes.length !== stat.size) throw new Error(`retention platform helper changed: ${path}`); helpers.push({ path, dev: String(stat.dev), ino: String(stat.ino), mode: stat.mode & 0o7777, digest: hash(bytes) }); }
  const retentionHelpers = Buffer.from(`${canonical({ schema: 'lunacy-retention-platform-helpers/v1', platform: process.platform, helpers })}\n`);
  payloadSourceFiles.push({ relative: 'runtime/retention-platform-helpers.json', bytes: retentionHelpers, digest: hash(retentionHelpers) });
  sourceRecords.push({ path: 'runtime/retention-platform-helpers.json', digest: hash(retentionHelpers) });
  payloadSourceFiles.sort((a, b) => stableCompare(a.relative, b.relative));
  sourceRecords.sort((a, b) => stableCompare(a.path, b.path));
  const sourceDigest = hash(Buffer.from(sourceRecords.map((record) => `${record.path}\0${record.digest}`).join('\n')));
  const packageValue = JSON.parse(payloadSourceFiles.find((file) => file.relative === 'runtime/package.json').bytes.toString('utf8'));
  const manifest = { schema, bridgeVersion: '0.2.0', runtimeVersion: packageValue.version, sourceDigest, files: sourceRecords.map((record) => record.path) };
  const manifestDigestPlaceholder = '__LUNACY_MANIFEST_DIGEST__';
  const launcherDigestPlaceholder = '__LUNACY_LAUNCHER_DIGEST__';
  const wrapperTemplate = Buffer.from(makeWrapper(sourceDigest, manifest.files, manifest.runtimeVersion, manifestDigestPlaceholder, launcherDigestPlaceholder, nodeAttestation));
  const launcherDigest = hash(wrapperTemplate);
  manifest.launcherDigest = launcherDigest;
  const manifestBytes = Buffer.from(`${canonical(manifest)}\n`);
  const manifestDigest = hash(manifestBytes);
  const wrapper = Buffer.from(makeWrapper(sourceDigest, manifest.files, manifest.runtimeVersion, manifestDigest, launcherDigest, nodeAttestation));
  const docs = Buffer.from(`# Lunacy runtime bridge (deployed)

This directory is generated from the canonical Desktop Lunacy runtime source.
Use "$NODE" runtime/bridge.mjs --help for one-event transitions.
Retention audit and mutations are available only through the verified
runtime/retention-launcher.mjs. Legacy migration is one explicit Git-backed
run at a time; audit is read-only and migration requires --accept. Explicit BLOCKED/STOPPED abandonment uses
the policy-gated seal-run --abandon --authority route; resume remains enabled
after the abandonment switch is turned OFF.
Use "$NODE" runtime/bridge.mjs drive --help for the private event-driven Codex
drive route.  The managed runtime also carries the exact closed Codex result,
launch-intent, launch, and terminal schemas plus the capability probe under runtime/schemas/
and runtime/tools/; all are covered by DEPLOYMENT.json.
Use "$NODE" runtime/bridge.mjs resolve-plan --help for the trusted private
pre-Plan AUTO/DIRECT/EXPLORE resolver. It accepts canonical structured inputs
and exact policy files only; it never parses free-form user text. Direct has no
managed inputs, while Focus/Explore validate and enter managed START in that
same verified bridge process. Explore authority is invocation-local and is not
written to the runtime tree or run state.
Use "$NODE" runtime/bridge.mjs workfront --help for a read-only dependency capsule.
Use "$NODE" runtime/bridge.mjs inbox --help for explicitly selected,
digest-bound decision entries; submit-decision and promote-phase remain
separate parent-authorized operations.
See runtime/DECISION_INBOX.md and runtime/schemas/{decision-inbox,phase-handoff}.schema.json
for the private envelope contracts.
Use "$NODE" runtime/bridge.mjs inspect-recovery --help for the token-scoped,
read-only recovery/effect forensics capsule.
The optional read-only Beads v1.2.2 adapter is documented in runtime/BEADS.md
and requires an operator-provisioned absolute bd path; it never installs or
searches PATH.
No package manager, network install, provider, worker scheduler, or global PATH
mutation is performed by deployment. The parent must choose --mode runtime
or --mode markdown explicitly for each run.
`);
  const payloadFiles = [...payloadSourceFiles, { bytes: wrapper, relative: 'runtime/bridge.mjs' }, { bytes: docs, relative: 'runtime/README.md' }];
  const expectedInventory = expectedManagedInventory(payloadFiles, manifestBytes);
  const preservedFiles = runtimeIdentity ? await capturePreservedRuntime(runtimeTarget, expectedInventory) : [];
  const fullInventory = [...expectedInventory, ...preservedFiles.map((file) => ({ path: file.path, digest: file.digest }))].sort((a, b) => stableCompare(a.path, b.path));
  const managedAggregate = inventoryDigest(fullInventory);
  await assertDeploymentIdentity();
  if (check) {
    if (!runtimeIdentity) throw new Error('managed runtime is absent');
    await assertDeploymentIdentity();
    const actualManifestBytes = await readBounded(join(runtimeTarget, 'DEPLOYMENT.json'), MAX_MANIFEST_BYTES, 'deployment manifest');
    if (!actualManifestBytes.equals(manifestBytes)) throw new Error('manifest bytes do not match canonical source');
    const verified = await verifyManagedTree(runtimeTarget, expectedInventory, 'managed deployment', managedAggregate, preservedFiles);
    console.log(JSON.stringify({ status: 'current', target, sourceDigest, managedFiles: verified.files, managedDirectories: verified.directories, managedAggregate, retentionCensusDigest: retentionCensus.digest, retentionStateSchemas: retentionCensus.stateSchemas }));
    return;
  }
  const verified = await publishManagedTree(target, payloadFiles, manifestBytes, expectedInventory, preservedFiles, targetLock.owner, undefined, releaseGenerationFence);
  console.log(JSON.stringify({ status: 'deployed', target, sourceDigest, files: sourceRecords.length, managedFiles: verified.files, managedDirectories: verified.directories, managedAggregate, retentionCensusDigest: retentionCensus.digest, retentionStateSchemas: retentionCensus.stateSchemas, ...(releaseGenerationCensus ? { releaseGenerationCensusDigest: releaseGenerationCensus.digest, oneShotRolloutGenerationFloor: releaseGenerationCensus.candidateFloor } : {}) }));
}

async function readProductionSnapshot(path, ownership) {
  const deadline = Date.now() + 30_000;
  let stat;
  while (!(stat = await lstat(path, 'release process snapshot'))) {
    if (Date.now() >= deadline) throw new Error('release process snapshot response timed out');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  const bytes = await readBounded(path, 16 * 1024 * 1024, 'release process snapshot');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('release process snapshot is not UTF-8');
  let response;
  try { response = JSON.parse(text); } catch (error) { throw new Error(`release process snapshot is not canonical JSON: ${error.message}`); }
  if (canonical(response) !== text) throw new Error('release process snapshot is not canonical JSON');
  if (!response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).sort(stableCompare).join(',') !== 'manifestDigest,releaseOwnerId,schema,snapshot' || response.schema !== 'lunacy-release-process-snapshot/v1' || response.releaseOwnerId !== ownership.owner.id || response.manifestDigest !== ownership.manifestDigest) throw new Error('release process snapshot response is not bound to this ownership');
  const snapshot = response.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.capturedAt !== 'string' || Number.isNaN(Date.parse(snapshot.capturedAt))) throw new Error('release process snapshot capturedAt is invalid');
  if (Date.parse(snapshot.capturedAt) < Date.parse(ownership.owner.acquiredAt) || stat.ctimeMs < Date.parse(ownership.owner.acquiredAt)) throw new Error('release process snapshot predates release ownership');
  return snapshot;
}

async function executeMain(args) {
  if (args.envelopeStatus) {
    const { releaseOperationStatus } = await import('../dist/release-operation.js');
    let manifest;
    let manifestDigest;
    if (args.releaseManifest) {
      const loaded = await import('../dist/release-admission.js').then(({ readReleaseManifest }) => readReleaseManifest(args.releaseManifest));
      manifest = loaded.manifest; manifestDigest = loaded.digest;
    }
    const result = await releaseOperationStatus({ target: args.target, ...(manifest === undefined ? {} : { manifest }), ...(manifestDigest === undefined ? {} : { manifestDigest }) });
    console.log(canonical(result));
    return;
  }
  if (!args.releaseManifest) {
    if (args.releaseEnvelope || args.resumeRelease) throw new Error('--release-envelope requires --release-manifest');
    await ensureDir(args.target, 'skill root');
    const targetLock = await acquireTargetLock(args.target);
    try { return await executeOperation(args, targetLock); }
    finally { await targetLock.release(); }
  }
  const [admission, releaseOperation, quiescence] = await Promise.all([
    import('../dist/release-admission.js'), import('../dist/release-operation.js'), import('../dist/release-quiescence.js'),
  ]);
  const { readReleaseManifest, releaseOwnerIsLive, currentReleaseOwner, verifyClosedReleaseRoots } = admission;
  const { withReleaseExclusion, createReleaseOperationEnvelope, readReleaseOperationEnvelope, transitionReleaseOperationEnvelope, writeReleaseOperationEnvelope } = releaseOperation;
  const { verifyReleaseQuiescence, verifyExactLegacyDeployQuiescence, verifyReleaseGenerationCensus } = quiescence;
  const release = await readReleaseManifest(args.releaseManifest);
  const expectedOperation = args.exactLegacyDeploy ? 'deploy-exact-0.2.12' : args.restore ? 'restore' : args.check ? 'check' : 'deploy';
  if (release.manifest.installedTarget !== args.target || release.manifest.operation !== expectedOperation) throw new Error('release manifest target/operation differs from invocation');
  const targetTrusted = await inspectTrustedPath(args.target, 'installed skill target', { surface: true, kind: 'directory' });
  if (!targetTrusted) throw new Error('release installed target is absent');
  if (await lstat(release.manifest.processSnapshotPath, 'release process snapshot') && !args.resumeRelease) throw new Error('release process snapshot path must be absent before ownership');
  let outer;
  let outerOwner;
  let outerSnapshotOwner;
  const makeOuterOwner = (epoch) => { const { schema: _schema, ...owner } = currentReleaseOwner(release.digest); return { ...owner, epoch }; };
  if (args.releaseEnvelope || args.resumeRelease) {
    const observed = await readReleaseOperationEnvelope(args.target);
    if (observed.state === 'VALID') {
      if (!args.resumeRelease) throw new Error('release operation envelope already exists; use --resume-release');
      const manifestIdentityDigest = createHash('sha256').update(canonical({ operation: release.manifest.operation, installedTarget: release.manifest.installedTarget, discoveryParents: release.manifest.discoveryParents, runRoots: release.manifest.runRoots, processSnapshotPath: release.manifest.processSnapshotPath })).digest('hex');
      if (observed.envelope.operation !== expectedOperation || observed.envelope.manifestDigest !== release.digest || observed.envelope.manifestIdentityDigest !== manifestIdentityDigest || observed.envelope.discoveryParentsDigest !== pathDigest(release.manifest.discoveryParents) || observed.envelope.runRootsDigest !== pathDigest(release.manifest.runRoots) || observed.envelope.processSnapshotPathDigest !== pathDigest(release.manifest.processSnapshotPath) || observed.envelope.installedTarget.pathDigest !== pathDigest(args.target) || observed.envelope.installedTarget.dev !== targetTrusted.identity.dev || observed.envelope.installedTarget.ino !== targetTrusted.identity.ino) throw new Error('release operation envelope binding differs from invocation');
      outer = observed;
      outerSnapshotOwner = observed.envelope.owner;
      const live = releaseOwnerIsLive(observed.envelope.owner);
      if (live && observed.envelope.owner.pid !== process.pid) throw new Error('release operation envelope owner is live');
      if (!live) {
        outerOwner = makeOuterOwner(observed.envelope.owner.epoch + 1);
        const rebound = { ...observed.envelope, owner: outerOwner, targetLock: null, phase: 'prepared', status: 'READY', recovery: { code: null, attempts: observed.envelope.recovery.attempts + 1 } };
        outer = await transitionReleaseOperationEnvelope(args.target, observed, rebound);
      } else outerOwner = observed.envelope.owner;
    } else if (observed.state === 'ABSENT') {
      // `--resume-release` is an explicit retry of a previously published
      // outer operation.  Without its exact marker there is no durable proof
      // that an earlier effect is safe to adopt; never turn resume into a
      // fresh (and potentially duplicate) release.
      if (args.resumeRelease) throw new Error('cannot resume release without an outer envelope');
      outerOwner = makeOuterOwner(0);
      outerSnapshotOwner = outerOwner;
      const envelope = createReleaseOperationEnvelope({ operation: expectedOperation, manifest: release.manifest, manifestDigest: release.digest, targetIdentity: { pathDigest: pathDigest(args.target), dev: targetTrusted.identity.dev, ino: targetTrusted.identity.ino }, owner: outerOwner });
      outer = await writeReleaseOperationEnvelope(args.target, envelope);
    } else throw new Error(`release operation envelope is ${observed.state.toLowerCase()}`);
  }
  const runRelease = withReleaseExclusion({ manifest: release.manifest, manifestDigest: release.digest, ...(outerOwner === undefined ? {} : { owner: outerOwner }) }, async (ownership) => {
    if (outer) {
      const currentTarget = await inspectTrustedPath(args.target, 'release installed target', { surface: true, kind: 'directory' });
      if (!currentTarget || currentTarget.identity.dev !== outer.envelope.installedTarget.dev || currentTarget.identity.ino !== outer.envelope.installedTarget.ino) throw new Error('release operation target identity changed before admission');
    }
    const targetLock = await acquireTargetLock(args.target, { reclaimStaleExactRelease: true, releaseOwner: ownership.owner, releaseOwnerIsLive });
    try {
      if (outer) {
        const lockIdentity = await inspectTrustedPath(targetLock.path, 'release target lock', { surface: true, kind: 'file' });
        if (!lockIdentity) throw new Error('release target lock disappeared');
        const admitted = { ...outer.envelope, phase: 'admitted', status: 'READY', targetLock: { pathDigest: createHash('sha256').update(targetLock.path).digest('hex'), dev: lockIdentity.identity.dev, ino: lockIdentity.identity.ino, ownerId: ownership.owner.id } };
        outer = await transitionReleaseOperationEnvelope(args.target, outer, admitted);
      }
      // Only the closed predecessor route adopts its own exact stale release
      // transaction before the fresh quiescence snapshot. Ordinary v1 keeps
      // treating any transaction residue as red.
      let exactLegacyBundles;
      // Before delegating recovery, bind any existing inner marker to the
      // owner recorded by the outer envelope.  A marker with a different
      // owner may be valid in isolation but belongs to another release and is
      // never safe for this resume to adopt.
      if (args.resumeRelease) await assertResumableInnerBinding(args.target, outerSnapshotOwner?.id ?? ownership.owner.id);
      if (args.exactLegacyDeploy) {
        exactLegacyBundles = await readExactLegacyDeployBundles(args, release.manifest);
        assertExactLegacyRecoveryBinding(await readTransaction(args.target), exactLegacyBundles);
        await recoverTransaction(args.target);
      }
      // An opted-in resume is the one route allowed to adopt the existing
      // inner transaction before quiescence.  The target lock and release
      // claims are already held; recoverTransaction remains the sole authority
      // for deciding whether the marker converges to the prior/candidate tree.
      if (args.resumeRelease && !args.exactLegacyDeploy) await recoverTransaction(args.target);
      const processSnapshot = await readProductionSnapshot(release.manifest.processSnapshotPath, outerSnapshotOwner && outerSnapshotOwner.id !== ownership.owner.id ? { ...ownership, owner: { schema: 'lunacy-release-owner/v1', ...outerSnapshotOwner } } : ownership);
      if (outer?.envelope.snapshot && createHash('sha256').update(canonical(processSnapshot)).digest('hex') !== outer.envelope.snapshot.digest) throw new Error('release operation process snapshot binding differs from envelope');
      const quiescenceInput = {
        installedTarget: args.target,
        runRoots: release.manifest.runRoots,
        processSnapshot,
        selfPid: process.pid,
        releaseOwnership: {
          ownerBytes: ownership.ownerBytes,
          releaseClaimPaths: ownership.releaseClaims.map((claim) => claim.path),
          bridgeClaimPaths: ownership.bridgeClaims.map((claim) => claim.path),
          writerClaimPaths: ownership.writerClaims.map((claim) => claim.path),
          targetLock: { path: targetLock.path, bytes: targetLock.bytes },
        },
      };
      const quiescenceReport = args.exactLegacyDeploy
        ? await verifyExactLegacyDeployQuiescence(quiescenceInput)
        : await verifyReleaseQuiescence(quiescenceInput);
      let releaseGenerationCensus;
      let releaseGenerationFence;
      if (expectedOperation === 'deploy' || expectedOperation === 'deploy-exact-0.2.12') {
        const { ONE_SHOT_ROLLOUT_GENERATION_FLOOR } = await import('../dist/one-shot.js');
        if (ONE_SHOT_ROLLOUT_GENERATION_FLOOR !== 22) throw new Error('built one-shot rollout generation floor differs from release floor 22');
        await verifyClosedReleaseRoots(release.manifest);
        const censusInput = {
          installedTarget: args.target,
          runRoots: release.manifest.runRoots,
          candidateFloor: ONE_SHOT_ROLLOUT_GENERATION_FLOOR,
          quiescence: quiescenceReport,
          releaseOwnership: quiescenceInput.releaseOwnership,
        };
        releaseGenerationCensus = await verifyReleaseGenerationCensus(censusInput);
        releaseGenerationFence = async () => {
          await verifyClosedReleaseRoots(release.manifest);
          const repeated = await verifyReleaseGenerationCensus(censusInput);
          if (canonical(repeated) !== canonical(releaseGenerationCensus)) throw new Error('supported-root generation census changed before candidate publication');
        };
      }
      if (outer) {
        const currentTarget = await inspectTrustedPath(args.target, 'release installed target', { surface: true, kind: 'directory' });
        if (!currentTarget || currentTarget.identity.dev !== outer.envelope.installedTarget.dev || currentTarget.identity.ino !== outer.envelope.installedTarget.ino) throw new Error('release operation target identity changed before delegation');
      }
      if (outer) {
        const quiesced = { ...outer.envelope, phase: 'quiesced', status: 'READY', snapshot: { pathDigest: pathDigest(release.manifest.processSnapshotPath), digest: createHash('sha256').update(canonical(processSnapshot)).digest('hex'), capturedAt: processSnapshot.capturedAt } };
        outer = await transitionReleaseOperationEnvelope(args.target, outer, quiesced);
        outer = await transitionReleaseOperationEnvelope(args.target, outer, { ...outer.envelope, phase: 'delegated', status: 'READY' });
      }
      const result = await executeOperation({ ...args, exactLegacyManifest: args.exactLegacyDeploy ? release.manifest : undefined, exactLegacyBundles, releaseGenerationCensus, releaseGenerationFence }, targetLock);
      if (outer) {
        let aggregate = null;
        try { const runtime = join(args.target, 'runtime'); const inventory = await captureRuntimeInventory(runtime, 'outer committed managed tree'); aggregate = inventory.aggregate; } catch { aggregate = null; }
        if (!aggregate) throw new Error('outer release commit lacks an exact inner aggregate');
        outer = await transitionReleaseOperationEnvelope(args.target, outer, { ...outer.envelope, phase: 'committed', status: 'COMMITTED', inner: { ...outer.envelope.inner, aggregate } });
      }
      return result;
    } finally { await targetLock.release(); }
  });
  return runRelease.catch(async (error) => {
    if (outer && outer.state === 'VALID' && outer.envelope.phase !== 'committed' && outer.envelope.phase !== 'failed') {
      try { await transitionReleaseOperationEnvelope(args.target, outer, { ...outer.envelope, phase: 'attention', status: 'ATTENTION', recovery: { code: 'operation-failed', attempts: outer.envelope.recovery.attempts + 1 } }); } catch { /* preserve the first failure and never mask it with marker cleanup */ }
    }
    throw error;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.envelopeStatus) return executeMain(args);
  if (!args.releaseManifest) await ensureDir(args.target, 'skill root');
  else if (!await inspectTrustedPath(args.target, 'installed skill target', { surface: true, kind: 'directory' })) throw new Error('release installed target is absent');
  if (!args.retentionAdmissionExplicit && !args.retentionAbandonmentExplicit) { args.retentionCensus = await retentionDeploymentPreflight([]); return executeMain(args); }
  const admission = await import('../dist/release-admission.js'); const physicalTarget = resolve(await fs.realpath(args.target));
  const ownerDigest = hash(Buffer.from(canonical({ schema: 'lunacy-retention-admission/v1', installedRuntime: physicalTarget, runRoot: '', operation: 'ADMIT' })));
  const owner = admission.currentReleaseOwner(ownerDigest); const claim = await admission.acquireOwnedFileClaim(join(args.target, '.lunacy-retention-admission.lock'), owner, { waitMs: 120_000, reclaimStaleReleaseOwner: true, nonReleaseOwnerIsBusy: true, writerReclaimProtocol: true, label: 'retention policy deployment' });
  try { args.retentionCensus = await retentionDeploymentPreflight(args.retentionRunParents); return await executeMain(args); } finally { await claim.release(); }
}

main().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
