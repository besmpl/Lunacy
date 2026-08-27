#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseCanonical } from '../dist/canonical.js';
import { verifyReleaseQuiescence } from '../dist/release-quiescence.js';

const SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const usage = () => 'Usage: verify-release-quiescence --target ABSOLUTE --process-snapshot FILE|- --run-root ABSOLUTE [--run-root ABSOLUTE ...]\n';

function parseArgs(argv) {
  const out = { runRoots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') return { help: true };
    if (!['--target', '--process-snapshot', '--run-root'].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index += 1];
    if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`);
    if (flag === '--target') {
      if (out.installedTarget !== undefined) throw new Error('--target may be supplied only once');
      out.installedTarget = value;
    } else if (flag === '--process-snapshot') {
      if (out.snapshotPath !== undefined) throw new Error('--process-snapshot may be supplied only once');
      out.snapshotPath = value;
    } else out.runRoots.push(value);
  }
  if (!out.installedTarget || !out.snapshotPath || out.runRoots.length === 0) throw new Error('target, process snapshot, and at least one run root are required');
  return out;
}

async function boundedSnapshot(path) {
  let bytes;
  if (path === '-') {
    const chunks = []; let total = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > SNAPSHOT_LIMIT) throw new Error('process snapshot exceeds byte limit');
      chunks.push(buffer);
    }
    bytes = Buffer.concat(chunks, total);
  } else {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > SNAPSHOT_LIMIT) throw new Error('process snapshot is not a bounded regular file');
      bytes = await handle.readFile();
      if (bytes.byteLength !== stat.size) throw new Error('process snapshot changed during read');
    } finally { await handle.close(); }
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('process snapshot is not valid UTF-8');
  return parseCanonical(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage()); return; }
  const report = await verifyReleaseQuiescence({
    installedTarget: args.installedTarget,
    runRoots: args.runRoots,
    processSnapshot: await boundedSnapshot(args.snapshotPath),
    selfPid: process.pid,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: 'NOT_QUIESCENT', error: String(error?.message ?? error) })}\n`);
  process.exitCode = 1;
});
