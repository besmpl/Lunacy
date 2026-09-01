#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBodyWriterAdmission } from '../dist/release-admission.js';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const thisPath = fileURLToPath(import.meta.url);
const installed = thisPath.includes(`${sep}runtime${sep}tools${sep}`);
function usage() { return 'Usage: with-body-writer --run-root /absolute/run/root --destination RELATIVE -- COMMAND [ARG...]\n'; }
function safeDestination(value) { if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Body destination is unsafe'); return value; }
function within(root, path) { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
async function hashFile(path) { const bytes = await fs.readFile(path); if (bytes.length > MAX_OUTPUT_BYTES) throw new Error('child output exceeds byte limit'); return { bytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') }; }
async function ensureBodyParent(body, relativeDestination) {
  let cursor = body;
  for (const part of relativeDestination.split('/').slice(0, -1)) {
    cursor = join(cursor, part);
    try { await fs.mkdir(cursor, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1) throw new Error('Body destination parent is unsafe');
  }
  return dirname(join(body, relativeDestination));
}
async function publish(runRoot, destination, externalPath, expected) {
  return withBodyWriterAdmission(runRoot, undefined, async () => {
    const body = join(runRoot, '.work'); const target = resolve(body, destination); if (!within(body, target) || target === body) throw new Error('Body destination escapes .work');
    const parent = await ensureBodyParent(body, destination); const temporary = join(parent, `.lunacy-body-write-${randomUUID()}.tmp`);
    try {
      const prior = await fs.lstat(target).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error)); if (prior) throw new Error('Body destination already exists');
      await fs.copyFile(externalPath, temporary, fsConstants.COPYFILE_EXCL); await fs.chmod(temporary, 0o600);
      const actual = await hashFile(temporary); if (actual.bytes !== expected.bytes || actual.digest !== expected.digest) throw new Error('Body copy changed');
      const handle = await fs.open(temporary, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); try { await handle.sync(); } finally { await handle.close(); }
      const collision = await fs.lstat(target).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error)); if (collision) throw new Error('Body destination already exists');
      await fs.rename(temporary, target); const directory = await fs.open(parent, fsConstants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
      return { schema: 'lunacy-body-publication/v1', destination, digest: actual.digest, bytes: actual.bytes };
    } finally { await fs.unlink(temporary).catch(() => undefined); }
  });
}

export async function runBodyWriter(argv = process.argv.slice(2)) {
  if (installed && globalThis[Symbol.for('lunacy.verified-retention-launch')] !== dirname(dirname(thisPath))) throw new Error('direct installed retention tool invocation is forbidden');
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage()); return 0; }
  const separator = argv.indexOf('--'); if (separator < 0) throw new Error(usage().trim()); const options = argv.slice(0, separator); const command = argv.slice(separator + 1); if (command.length === 0) throw new Error('child command is required');
  let runRoot; let destination;
  for (let index = 0; index < options.length; index += 2) { const key = options[index]; const value = options[index + 1]; if (key === '--run-root') runRoot = value; else if (key === '--destination') destination = value; else throw new Error(`unknown Body writer option: ${key}`); }
  if (!runRoot || resolve(runRoot) !== runRoot) throw new Error('run root must be absolute and canonical'); destination = safeDestination(destination);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'lunacy-body-writer-')); const externalPath = join(temporaryDirectory, 'stdout'); const output = await fs.open(externalPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  let child; const forward = (signal) => { if (!child || child.exitCode !== null) return; try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
  const signals = ['SIGINT', 'SIGTERM']; for (const signal of signals) process.on(signal, forward);
  try {
    child = spawn(command[0], command.slice(1), { cwd: temporaryDirectory, stdio: ['inherit', output.fd, 'inherit'], detached: process.platform !== 'win32' });
    const result = await new Promise((resolvePromise, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolvePromise({ code, signal })); }); await output.close();
    if (result.signal) { process.kill(process.pid, result.signal); return 128; } if (result.code !== 0) return result.code ?? 1;
    const expected = await hashFile(externalPath); const publication = await publish(runRoot, destination, externalPath, expected); process.stdout.write(`${JSON.stringify(publication)}\n`); return 0;
  } finally {
    for (const signal of signals) process.off(signal, forward); await output.close().catch(() => undefined); await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => resolve(process.argv[1])).then((path) => path === thisPath)) runBodyWriter().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
