#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeDir = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(runtimeDir, '..');
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);

async function bounded(path, limit, label) {
  const before = await fs.lstat(path); if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} is not a regular file`); if ((before.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && before.uid !== process.getuid())) throw new Error(`${label} is not trusted`); if (before.size < 0 || before.size > limit) throw new Error(`${label} exceeds its byte limit`);
  const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { const bound = await handle.stat(); if (String(bound.dev) !== String(before.dev) || String(bound.ino) !== String(before.ino) || bound.size !== before.size) throw new Error(`${label} changed before read`); const bytes = await handle.readFile(); if (bytes.length !== bound.size) throw new Error(`${label} changed during read`); return bytes; } finally { await handle.close(); }
}
function safePath(value) { if (typeof value !== 'string' || !value.startsWith('runtime/') || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('deployment manifest path is unsafe'); const path = resolve(skillRoot, value); const rel = relative(skillRoot, path); if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('deployment manifest path escapes skill root'); return path; }
function normalizedBridge(bytes) { let source = bytes.toString('utf8'); for (const [name, marker] of [['MANIFEST', '__LUNACY_MANIFEST_DIGEST__'], ['LAUNCHER', '__LUNACY_LAUNCHER_DIGEST__']]) { const pattern = new RegExp(`(^const EXPECTED_${name}_DIGEST = ")([0-9a-f]{64})(";)$`, 'm'); const updated = source.replace(pattern, `$1${marker}$3`); if (updated === source) throw new Error(`bridge ${name.toLowerCase()} binding is malformed`); source = updated; } return Buffer.from(source); }

async function verifyDeployment() {
  const manifestBytes = await bounded(join(runtimeDir, 'DEPLOYMENT.json'), 1024 * 1024, 'deployment manifest'); let manifest; try { manifest = JSON.parse(manifestBytes); } catch { throw new Error('deployment manifest is malformed'); }
  if (`${canonical(manifest)}\n` !== manifestBytes.toString('utf8') || !manifest || Object.keys(manifest).sort().join(',') !== 'bridgeVersion,files,launcherDigest,runtimeVersion,schema,sourceDigest' || manifest.schema !== 1 || !Array.isArray(manifest.files) || typeof manifest.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sourceDigest) || typeof manifest.launcherDigest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.launcherDigest)) throw new Error('deployment manifest is malformed');
  const files = manifest.files.map(safePath); if (new Set(manifest.files).size !== manifest.files.length || !manifest.files.includes('runtime/retention-launcher.mjs') || !manifest.files.includes('runtime/tools/seal-run.mjs') || !manifest.files.includes('runtime/tools/with-body-writer.mjs') || !manifest.files.includes('runtime/tools/audit-run-artifacts.mjs') || !manifest.files.includes('runtime/tools/migrate-run-body.mjs') || !manifest.files.includes('runtime/dist/run-retention.js') || !manifest.files.includes('runtime/dist/run-retention-platform.js') || !manifest.files.includes('runtime/dist/run-body-migration.js') || !manifest.files.includes('runtime/retention-policy.json') || !manifest.files.includes('runtime/retention-platform-helpers.json')) throw new Error('retention deployment payload is incomplete');
  let total = 0; const records = [];
  for (let index = 0; index < files.length; index += 1) { const remaining = MAX_TOTAL_BYTES - total; const bytes = await bounded(files[index], Math.min(MAX_FILE_BYTES, remaining), manifest.files[index]); total += bytes.length; if (total > MAX_TOTAL_BYTES) throw new Error('deployment payload exceeds aggregate byte limit'); records.push({ path: manifest.files[index], digest: hash(bytes) }); }
  if (hash(Buffer.from(records.map((item) => `${item.path}\0${item.digest}`).join('\n'))) !== manifest.sourceDigest) throw new Error('deployment fingerprint is not the trusted release');
  const bridgeBytes = await bounded(join(runtimeDir, 'bridge.mjs'), MAX_FILE_BYTES, 'verified bridge'); const bridgeSource = bridgeBytes.toString('utf8'); const manifestBinding = bridgeSource.match(/^const EXPECTED_MANIFEST_DIGEST = "([0-9a-f]{64})";$/m)?.[1]; if (manifestBinding !== hash(manifestBytes) || hash(normalizedBridge(bridgeBytes)) !== manifest.launcherDigest) throw new Error('deployment fingerprint is not the trusted release');
  const nodePath = bridgeSource.match(/^const EXPECTED_NODE_PATH = (".*");$/m)?.[1]; const nodeVersion = bridgeSource.match(/^const EXPECTED_NODE_VERSION = (".*");$/m)?.[1]; const nodeDigest = bridgeSource.match(/^const EXPECTED_NODE_DIGEST = "([0-9a-f]{64})";$/m)?.[1]; if (!nodePath || !nodeVersion || !nodeDigest) throw new Error('deployment Node attestation is malformed'); const expectedNodePath = JSON.parse(nodePath); const expectedNodeVersion = JSON.parse(nodeVersion); const actualNodePath = resolve(await fs.realpath(process.execPath)); if (actualNodePath !== expectedNodePath || process.versions.node !== expectedNodeVersion || hash(await bounded(actualNodePath, 256 * 1024 * 1024, 'Node executable')) !== nodeDigest) throw new Error('Node executable/version is not the attested runtime');
  const policyBytes = await bounded(join(runtimeDir, 'retention-policy.json'), 1024, 'retention policy'); let policy; try { policy = JSON.parse(policyBytes); } catch { throw new Error('retention policy is not canonical'); } if (`${canonical(policy)}\n` !== policyBytes.toString('utf8') || Object.keys(policy).sort().join(',') !== 'abandonment,newBodyAdmission,schema' || policy.schema !== 'lunacy-retention-policy/v1' || !['OFF', 'ON'].includes(policy.newBodyAdmission) || !['OFF', 'ON'].includes(policy.abandonment)) throw new Error('retention policy is not canonical');
  const helperBytes = await bounded(join(runtimeDir, 'retention-platform-helpers.json'), 4096, 'retention platform helpers'); let helperRecord; try { helperRecord = JSON.parse(helperBytes); } catch { throw new Error('retention platform helpers are malformed'); }
  if (`${canonical(helperRecord)}\n` !== helperBytes.toString('utf8') || helperRecord?.schema !== 'lunacy-retention-platform-helpers/v1' || helperRecord.platform !== process.platform || !Array.isArray(helperRecord.helpers)) throw new Error('retention platform helpers are malformed');
  const expectedHelpers = process.platform === 'darwin' ? ['/bin/ps', '/sbin/mount', '/usr/sbin/lsof'] : []; if (helperRecord.helpers.length !== expectedHelpers.length) throw new Error('retention platform helper set differs');
  for (let index = 0; index < expectedHelpers.length; index += 1) { const record = helperRecord.helpers[index]; if (!record || Object.keys(record).sort().join(',') !== 'dev,digest,ino,mode,path' || record.path !== expectedHelpers[index] || typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) throw new Error('retention platform helper record is malformed'); const stat = await fs.stat(record.path); if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (stat.mode & 0o022) !== 0 || String(stat.dev) !== record.dev || String(stat.ino) !== record.ino || (stat.mode & 0o7777) !== record.mode) throw new Error('retention platform helper changed'); const bytes = await fs.readFile(record.path); const after = await fs.stat(record.path); if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || bytes.length !== stat.size || hash(bytes) !== record.digest) throw new Error('retention platform helper changed'); }
  return policy;
}

async function main() {
  const policy = await verifyDeployment();
  const route = process.argv[2]; globalThis[Symbol.for('lunacy.verified-retention-launch')] = runtimeDir;
  if (route === 'seal-run') { const args = process.argv.slice(3); if (args.includes('--abandon') && policy.abandonment !== 'ON') throw new Error('run abandonment is OFF'); const module = await import(pathToFileURL(join(runtimeDir, 'tools', 'seal-run.mjs')).href); return module.runSealRun(args); }
  if (route === 'with-body-writer') { const module = await import(pathToFileURL(join(runtimeDir, 'tools', 'with-body-writer.mjs')).href); return module.runBodyWriter(process.argv.slice(3)); }
  if (route === 'audit-run-artifacts') { const module = await import(pathToFileURL(join(runtimeDir, 'tools', 'audit-run-artifacts.mjs')).href); return module.runArtifactAudit(process.argv.slice(3)); }
  if (route === 'migrate-run-body') { const module = await import(pathToFileURL(join(runtimeDir, 'tools', 'migrate-run-body.mjs')).href); return module.runBodyMigration(process.argv.slice(3)); }
  if (route === 'admit-body') {
    const args = process.argv.slice(3); if (args.length !== 2 || args[0] !== '--run-root' || resolve(args[1]) !== args[1]) throw new Error('admit-body accepts only --run-root ABSOLUTE');
    const module = await import(pathToFileURL(join(runtimeDir, 'dist', 'release-admission.js')).href); const status = await module.admitRunBody(runtimeDir, args[1]); process.stdout.write(`${JSON.stringify({ schema: 'lunacy-body-admission/v1', status })}\n`); return 0;
  }
  throw new Error('retention launcher route is not allowlisted');
}

main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`); process.exitCode = 1; });
