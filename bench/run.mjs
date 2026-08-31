#!/usr/bin/env node
/**
 * S4's preregistered local benchmark. It measures this process only: semantic
 * yields, acceleration counters, committed bytes, and wall time. It does not
 * infer provider/token/native work and never reports a speedup claim.
 */
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { makeRunKernel } from '../dist/index.js';
import { digest, canonicalString, parseCanonical } from '../dist/canonical.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, 'manifest.json');
const manifest = parseCanonical(await readFile(manifestPath, 'utf8'));
const fixture = { plan: manifest.plan, events: manifest.events };
const fixtureDigest = digest(fixture);
if (fixtureDigest !== manifest.fixtureDigest) throw new Error(`manifest integrity mismatch: expected ${manifest.fixtureDigest}, got ${fixtureDigest}`);

function sha(value) { return createHash('sha256').update(canonicalString(value)).digest('hex'); }
async function bytesUnder(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await bytesUnder(full);
    else total += (await stat(full)).size;
  }
  return total;
}
async function run(mode) {
  const rootDir = await mkdtemp(join(tmpdir(), 'lunacy-s4-bench-'));
  const kernel = makeRunKernel({ plan: fixture.plan, rootDir });
  const yields = [];
  let previous;
  const started = process.hrtime.bigint();
  for (const item of fixture.events) {
    const event = item.event;
    const input = {
      runId: 'benchmark-run',
      ...(previous ? { expectedRevision: previous.snapshot.revision } : {}),
      identity: {
        runId: 'benchmark-run', phaseId: fixture.plan.phaseId, stepId: 'run',
        attemptEpoch: previous?.snapshot.attemptEpoch ?? 0,
        authorityEpoch: previous?.snapshot.authorityEpoch ?? 0,
        barrierEpoch: previous?.snapshot.barrierEpoch ?? 0,
        eventId: item.eventId, payloadDigest: digest(event),
      },
      event,
    };
    previous = await kernel.advance(input);
    yields.push(previous);
  }
  const wallNs = Number(process.hrtime.bigint() - started);
  const kernelDir = join(rootDir, '.kernel');
  const bytes = await bytesUnder(kernelDir);
  const yieldBytes = yields.map((value) => canonicalString(value));
  return {
    mode, eventCount: yields.length, yieldDigest: sha(yieldBytes),
    yieldBytes: yieldBytes.reduce((sum, value) => sum + Buffer.byteLength(value), 0),
    committedBytes: bytes, wallNs, counters: {},
    final: previous?.kind ?? 'NONE',
  };
}

const off = await run('OFF');
const shadow = await run('SHADOW');
const output = {
  schema: 'lunacy-benchmark-output-v1', fixtureId: manifest.fixtureId, fixtureDigest,
  capabilities: { provider: false, token: false, native: false },
  semanticParity: off.yieldDigest === shadow.yieldDigest,
  modes: { OFF: off, SHADOW: shadow },
  note: 'Local counters, bytes, and wallNs only; no token/provider/native or speedup claim.',
};
const text = `${canonicalString(output)}\n`;
const outArg = process.argv.indexOf('--out');
if (outArg >= 0) {
  const path = process.argv[outArg + 1];
  if (!path || path.startsWith('--')) throw new Error('--out requires a path');
  await writeFile(path, text, 'utf8');
}
process.stdout.write(text);
