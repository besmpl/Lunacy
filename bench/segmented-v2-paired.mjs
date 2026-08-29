#!/usr/bin/env node
/**
 * Direction-3 paired storage observations. This intentionally reports local
 * operations/bytes/fsync points/wall distributions only; it does not infer a
 * performance or token/provider claim and never changes the default writer.
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileArtifactStore } from '../dist/store.js';
import { createInitialState } from '../dist/reducer.js';
import { canonicalString, digest } from '../dist/canonical.js';

const repetitions = Number(process.env.LUNACY_V2_REPETITIONS ?? 30);
if (!Number.isSafeInteger(repetitions) || repetitions < 30) throw new Error('LUNACY_V2_REPETITIONS must be >= 30');
const plan = { phaseId: 'p3-v2-bench', steps: [{ stepId: 'step' }] };
function stateWithEvents(count, repetition) {
  const state = createInitialState(`bench-v2-${repetition}`, plan, digest(plan), `fence-${repetition}`);
  state.journal = [];
  for (let index = 0; index < count; index += 1) {
    const event = { kind: 'OBSERVATION', category: 'HOST', ref: { id: `bench-${repetition}-${index}`, digest: digest({ index }), bytes: canonicalString({ index }) } };
    state.journal.push({ identity: { runId: state.runId, phaseId: 'run', stepId: 'run', attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0, eventId: `event-${index}`, payloadDigest: digest(event) }, event, digest: digest(event), revision: index + 1 });
  }
  state.revision = count;
  return state;
}
async function bytesUnder(path) {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? await bytesUnder(full) : (await stat(full)).size;
  }
  return total;
}
async function observe(format, count, repetition) {
  const root = await mkdtemp(join(tmpdir(), `lunacy-p3-v2-${format.replace('/', '-')}-`));
  const points = Object.create(null);
  const store = new FileArtifactStore(root, undefined, { format, segmentEventCeiling: 64, faultInjector: (point) => { points[point] = (points[point] ?? 0) + 1; } });
  try {
    const started = performance.now();
    await store.commit(0, stateWithEvents(count, repetition));
    // A second append makes the unchanged sealed prefix reuse observable.
    await store.commit(1, stateWithEvents(count + 1, repetition));
    await store.load();
    const wallMilliseconds = performance.now() - started;
    return { format, repetition, events: count + 1, bytes: await bytesUnder(join(root, '.kernel')), fsyncPoints: { ...points }, wallMilliseconds };
  } finally { await rm(root, { recursive: true, force: true }); }
}
const observations = [];
for (let repetition = 0; repetition < repetitions; repetition += 1) {
  for (const [kind, count] of [['short', 96], ['long', 2048]]) {
    const legacy = await observe('segmented', count, repetition);
    const v2 = await observe('segmented/v2', count, repetition);
    observations.push({ kind, legacy, v2 });
  }
}
const values = observations.map(({ kind, legacy, v2 }) => ({ kind, bytesDelta: legacy.bytes - v2.bytes, segmentFsyncDelta: (legacy.fsyncPoints['segment-fsync'] ?? 0) - (v2.fsyncPoints['segment-fsync'] ?? 0), wallDeltaMilliseconds: legacy.wallMilliseconds - v2.wallMilliseconds }));
const output = { schema: 'lunacy-segmented-v2-paired-v1', repetitions, observations, values, valueDecision: 'UNCLAIMED', claimBoundary: 'Measurements are local observations only; no provider/token/native/speed claim and no default writer enablement.' };
process.stdout.write(`${canonicalString(output)}\n`);
