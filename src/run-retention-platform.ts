import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalString, digestBytes } from './canonical.js';
import { inspectTrustedPath, type FilesystemIdentity } from './filesystem.js';

export type TrustedIdentity = Readonly<{ path: string; identity: FilesystemIdentity }>;
export type MountSnapshot = Readonly<{ schema: 'lunacy-retention-mounts/v1'; platform: 'darwin' | 'linux'; digest: string; mountPoints: readonly string[] }>;
export type RunSealQuiescenceSnapshot = Readonly<{
  schema: 'lunacy-run-quiescence/v1';
  digest: string;
  openHandles: 0;
  publicationGate: 'REQUIRED_ZERO_HANDLES';
  platform: 'darwin' | 'linux';
  inspectedProcesses: number;
}>;
export interface RetentionPlatform {
  captureRunSealQuiescence(installedRuntime: TrustedIdentity, runRoot: TrustedIdentity, body: TrustedIdentity): Promise<RunSealQuiescenceSnapshot>;
  captureMountIdentity(root: TrustedIdentity): Promise<MountSnapshot>;
}

const MAX_INSPECTOR_BYTES = 16 * 1024 * 1024;
const MAX_MOUNTS = 16_384;
const MAX_ENTRIES = 4096;
const MAX_BYTES = 64 * 1024 * 1024;
function stableCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function within(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function physical(value: string): string { if (!isAbsolute(value) || resolve(value) !== value || value.includes('\0')) throw new Error('RetentionPlatform: path is not absolute and canonical'); return value; }
async function verifyTrustedIdentity(value: TrustedIdentity, label: string): Promise<string> {
  const path = resolve(await fs.realpath(physical(value.path))); const trusted = await inspectTrustedPath(path, label, { surface: true, kind: 'directory' });
  if (!trusted || trusted.identity.dev !== value.identity.dev || trusted.identity.ino !== value.identity.ino) throw new Error(`RetentionPlatform: ${label} identity changed`);
  return path;
}
function command(path: string, args: readonly string[]): Buffer {
  try { return execFileSync(path, args, { encoding: 'buffer', maxBuffer: MAX_INSPECTOR_BYTES, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`RetentionPlatform: inspector unavailable: ${(error as Error).message}`); }
}
function closedSnapshot(platform: 'darwin' | 'linux', inspectedProcesses: number, facts: unknown): RunSealQuiescenceSnapshot {
  const base = { schema: 'lunacy-run-quiescence/v1' as const, openHandles: 0 as const, publicationGate: 'REQUIRED_ZERO_HANDLES' as const, platform, inspectedProcesses };
  return Object.freeze({ ...base, digest: createHash('sha256').update(canonicalString({ ...base, facts })).digest('hex') });
}
function decodeMountEscape(value: string): string {
  if (/\\(?!0(?:40|11|12|134))/u.test(value)) throw new Error('RetentionPlatform: mount escape is invalid');
  return value.replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\');
}

class NativeRetentionPlatform implements RetentionPlatform {
  async captureMountIdentity(root: TrustedIdentity): Promise<MountSnapshot> {
    const rootPath = await verifyTrustedIdentity(root, 'mount root');
    let mountPoints: string[];
    let platform: 'darwin' | 'linux';
    if (process.platform === 'linux') {
      platform = 'linux';
      const bytes = await fs.readFile('/proc/self/mountinfo');
      if (bytes.length > MAX_INSPECTOR_BYTES || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('RetentionPlatform: mount snapshot is incomplete');
      mountPoints = bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line) => {
        const fields = line.split(' '); if (fields.length < 10 || !fields.includes('-')) throw new Error('RetentionPlatform: mountinfo grammar is invalid');
        return resolve(decodeMountEscape(fields[4]!));
      });
    } else if (process.platform === 'darwin') {
      platform = 'darwin';
      const bytes = command('/sbin/mount', []); if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('RetentionPlatform: mount snapshot is not UTF-8');
      mountPoints = bytes.toString('utf8').trimEnd().split('\n').filter(Boolean).map((line) => {
        const match = line.match(/ on (.+) \([^\n]+\)$/); if (!match) throw new Error('RetentionPlatform: mount grammar is invalid');
        return resolve(match[1]!.replace(/\\040/g, ' '));
      });
    } else throw new Error('RetentionPlatform: unsupported platform');
    if (mountPoints.length === 0 || mountPoints.length > MAX_MOUNTS || new Set(mountPoints).size !== mountPoints.length) throw new Error('RetentionPlatform: mount snapshot is ambiguous');
    mountPoints.sort(stableCompare);
    const owners = mountPoints.filter((point) => within(point, rootPath)).sort((a, b) => b.length - a.length);
    if (owners.length === 0 || (owners.length > 1 && owners[0]!.length === owners[1]!.length)) throw new Error('RetentionPlatform: mount identity is ambiguous');
    return Object.freeze({ schema: 'lunacy-retention-mounts/v1', platform, mountPoints: Object.freeze(mountPoints), digest: createHash('sha256').update(canonicalString({ root: rootPath, mountPoints })).digest('hex') });
  }

  async captureRunSealQuiescence(installedRuntime: TrustedIdentity, runRoot: TrustedIdentity, body: TrustedIdentity): Promise<RunSealQuiescenceSnapshot> {
    const runtimePath = await verifyTrustedIdentity(installedRuntime, 'installed runtime'); const runPath = await verifyTrustedIdentity(runRoot, 'run root'); const bodyPath = await verifyTrustedIdentity(body, 'Body');
    const runtimeAliases = [...new Set([runtimePath, installedRuntime.path])]; const runAliases = [...new Set([runPath, runRoot.path])];
    const ownedToken = (token: string): boolean => isAbsolute(token) && [...runtimeAliases, ...runAliases].some((root) => within(root, resolve(token)));
    if (process.platform === 'linux') {
      const entries = await fs.readdir('/proc'); const pids = entries.filter((name) => /^[1-9][0-9]*$/.test(name)).sort((a, b) => Number(a) - Number(b));
      let inspected = 0; const facts: string[] = [];
      for (const pid of pids) {
        let owner: Stats; try { owner = await fs.stat(`/proc/${pid}`); } catch { continue; }
        if (typeof process.getuid === 'function' && owner.uid !== process.getuid()) continue;
        let fds: string[]; try { fds = await fs.readdir(`/proc/${pid}/fd`); } catch (error) { throw new Error(`RetentionPlatform: descriptor inspection denied for ${pid}: ${(error as Error).message}`); }
        inspected += 1;
        for (const fd of fds) {
          let target: string; try { target = await fs.readlink(`/proc/${pid}/fd/${fd}`); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error(`RetentionPlatform: descriptor inspection failed for ${pid}: ${(error as Error).message}`); }
          const deleted = target.endsWith(' (deleted)') ? target.slice(0, -10) : target;
          if (isAbsolute(deleted) && (within(bodyPath, deleted) || within(bodyPath.replace(/\.work(?:\.prune-[0-9a-f]{64})?$/, '.work'), deleted))) throw new Error('RetentionPlatform: WRITER_ACTIVE');
        }
        let commandBytes: Buffer;
        try {
          const handle = await fs.open(`/proc/${pid}/cmdline`, fsConstants.O_RDONLY); const chunks: Buffer[] = []; let total = 0; const buffer = Buffer.allocUnsafe(4096);
          try { while (true) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (bytesRead === 0) break; total += bytesRead; if (total > 64 * 1024) throw new Error('command line exceeds limit'); chunks.push(Buffer.from(buffer.subarray(0, bytesRead))); } } finally { await handle.close(); }
          commandBytes = Buffer.concat(chunks);
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error(`RetentionPlatform: process inspection failed for ${pid}: ${(error as Error).message}`); }
        if (!Buffer.from(commandBytes.toString('utf8')).equals(commandBytes)) throw new Error(`RetentionPlatform: process command is not UTF-8 for ${pid}`);
        const tokens = commandBytes.toString('utf8').split('\0').filter(Boolean); if (Number(pid) !== process.pid && tokens.some(ownedToken)) throw new Error('RetentionPlatform: WRITER_ACTIVE');
        facts.push(`${pid}:${createHash('sha256').update(commandBytes).digest('hex')}`);
      }
      return closedSnapshot('linux', inspected, { runtimePath, runPath, run: runRoot.identity, body: body.identity, processes: facts });
    }
    if (process.platform === 'darwin') {
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (uid === undefined) throw new Error('RetentionPlatform: user identity unavailable');
      const bytes = command('/usr/sbin/lsof', ['-F0pnf', '-u', String(uid)]);
      const fields = bytes.toString('utf8').split(/\0?\n|\0/).filter(Boolean); let pid = ''; const processes = new Set<string>();
      for (const field of fields) {
        const tag = field[0]; const value = field.slice(1);
        if (tag === 'p') { if (!/^[1-9][0-9]*$/.test(value)) throw new Error('RetentionPlatform: lsof pid grammar is invalid'); pid = value; processes.add(value); }
        else if (tag === 'n') { if (!pid) throw new Error('RetentionPlatform: lsof record is unbound'); if (isAbsolute(value)) { const normalized = value.endsWith(' (deleted)') ? value.slice(0, -10) : value; if (within(bodyPath, normalized)) throw new Error('RetentionPlatform: WRITER_ACTIVE'); } }
        else if (tag !== 'f') throw new Error('RetentionPlatform: lsof field grammar is invalid');
      }
      const processBytes = command('/bin/ps', ['-axo', 'pid=,uid=,pgid=,command=']); if (!Buffer.from(processBytes.toString('utf8')).equals(processBytes)) throw new Error('RetentionPlatform: process snapshot is not UTF-8');
      const processFacts: string[] = [];
      for (const line of processBytes.toString('utf8').split('\n').filter(Boolean)) {
        const match = line.match(/^\s*([1-9][0-9]*)\s+([0-9]+)\s+([1-9][0-9]*)\s+(.+)$/); if (!match) throw new Error('RetentionPlatform: process snapshot grammar is invalid');
        const [, pid, owner, pgid, processCommand] = match; if (Number(owner) !== uid) continue; processFacts.push(`${pid}:${pgid}:${createHash('sha256').update(processCommand!).digest('hex')}`);
        if (Number(pid) !== process.pid && [...runtimeAliases, ...runAliases].some((root) => processCommand!.includes(root))) throw new Error('RetentionPlatform: WRITER_ACTIVE');
      }
      if (processFacts.length > 131_072) throw new Error('RetentionPlatform: process snapshot exceeds limit');
      return closedSnapshot('darwin', processFacts.length, { runtimePath, runPath, run: runRoot.identity, body: body.identity, processes: processFacts.sort(stableCompare) });
    }
    throw new Error('RetentionPlatform: unsupported platform');
  }
}

export const nativeRetentionPlatform: RetentionPlatform = new NativeRetentionPlatform();

export type BodyCleanupEntry = Readonly<{ relativePath: string; dev: string; ino: string; mode: number; size?: number; digest?: string }>;
export type BodyInventory = Readonly<{ root: TrustedIdentity; treeDigest: string; files: number; bytes: number; cleanupEntries: readonly BodyCleanupEntry[]; mount: MountSnapshot }>;

async function fileDigest(path: string, stat: Stats): Promise<string> {
  const handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const bound = await handle.stat(); if (bound.dev !== stat.dev || bound.ino !== stat.ino || bound.size !== stat.size) throw new Error('RetentionPlatform: Body entry changed before read');
    const bytes = await handle.readFile(); if (bytes.length !== stat.size) throw new Error('RetentionPlatform: Body entry changed during read');
    return digestBytes(bytes);
  } finally { await handle.close(); }
}

export async function inventoryRetentionBody(bodyPathInput: string, platform: RetentionPlatform = nativeRetentionPlatform): Promise<BodyInventory> {
  const bodyPath = physical(bodyPathInput);
  const trusted = await inspectTrustedPath(bodyPath, 'retention Body', { surface: true, kind: 'directory' }); if (!trusted) throw new Error('RetentionPlatform: Body is absent');
  const root: TrustedIdentity = Object.freeze({ path: bodyPath, identity: trusted.identity });
  const mount = await platform.captureMountIdentity(root);
  if (mount.mountPoints.some((point) => point !== bodyPath && within(bodyPath, point)) || mount.mountPoints.includes(bodyPath)) throw new Error('RetentionPlatform: Body contains a mount boundary');
  const entries: BodyCleanupEntry[] = [{ relativePath: '.', dev: String(trusted.stat.dev), ino: String(trusted.stat.ino), mode: trusted.stat.mode & 0o777 }];
  const tuples: string[] = []; let files = 0; let bytes = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const names = await fs.readdir(directory, { encoding: 'buffer' });
    const decoded = names.map((name) => { const text = name.toString('utf8'); if (!Buffer.from(text, 'utf8').equals(name) || !text || text === '.' || text === '..' || text.includes('/') || text.includes('\\') || text.includes('\0')) throw new Error('RetentionPlatform: Body path is invalid UTF-8'); return text; }).sort(stableCompare);
    if (new Set(decoded).size !== decoded.length) throw new Error('RetentionPlatform: duplicate Body path');
    for (const name of decoded) {
      if (entries.length >= MAX_ENTRIES) throw new Error('RetentionPlatform: LIMIT_EXCEEDED');
      const relativePath = prefix ? `${prefix}/${name}` : name; const path = `${directory}/${name}`; const stat = await fs.lstat(path);
      if (String(stat.dev) !== root.identity.dev) throw new Error('RetentionPlatform: Body crosses device boundary');
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('RetentionPlatform: Body contains unsafe file kind');
      if (stat.isFile()) {
        if (stat.nlink !== 1 || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_BYTES - bytes) throw new Error(stat.nlink !== 1 ? 'RetentionPlatform: Body contains hardlink' : 'RetentionPlatform: LIMIT_EXCEEDED');
        const contentDigest = await fileDigest(path, stat); files += 1; bytes += stat.size;
        entries.push(Object.freeze({ relativePath, dev: String(stat.dev), ino: String(stat.ino), mode: stat.mode & 0o777, size: stat.size, digest: contentDigest }));
        tuples.push(`${relativePath}\0${(stat.mode & 0o777).toString(8)}\0${stat.size}\0${contentDigest}`);
      } else {
        entries.push(Object.freeze({ relativePath, dev: String(stat.dev), ino: String(stat.ino), mode: stat.mode & 0o777 }));
        await visit(path, relativePath);
      }
    }
  };
  await visit(bodyPath, '');
  const after = await inspectTrustedPath(bodyPath, 'retention Body', { surface: true, kind: 'directory' }); if (!after || after.identity.dev !== root.identity.dev || after.identity.ino !== root.identity.ino) throw new Error('RetentionPlatform: Body root changed during inventory');
  entries.sort((a, b) => stableCompare(a.relativePath, b.relativePath)); tuples.sort(stableCompare);
  return Object.freeze({ root, treeDigest: createHash('sha256').update(Buffer.from(tuples.join('\0'))).digest('hex'), files, bytes, cleanupEntries: Object.freeze(entries), mount });
}
