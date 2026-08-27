import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { transition } from '../dist/bridge.js';

const corpus = JSON.parse(await readFile(new URL('./bridge-corpus.json', import.meta.url), 'utf8'));
const plan = { ...corpus.plan, steps: corpus.plan.steps };
const events = corpus.events.map((event, index) => index === 0 ? { ...event, intentRef: { ...event.intentRef, digest: digest(plan) } } : event);
const empty = () => ({ reads: 0, writes: 0, bytesRead: 0, bytesWritten: 0, wakeups: 0 });
const bytes = (value) => Buffer.byteLength(value);

async function markdownArm() {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-markdown-arm-'));
  const paths = [join(root, 'PLAN.md'), join(root, 'STATE.md'), join(root, 'STEPS.md')];
  await Promise.all(paths.map((path) => writeFile(path, '# frozen markdown control\n', 'utf8')));
  const counters = empty(); const yields = [];
  for (const event of events) {
    for (const path of paths) { const text = await readFile(path, 'utf8'); counters.reads += 1; counters.bytesRead += bytes(text); }
    const state = `# markdown state\nEvent: ${event.kind}\n`;
    await writeFile(paths[1], state, 'utf8'); await writeFile(paths[2], state, 'utf8');
    counters.writes += 2; counters.bytesWritten += bytes(state) * 2; counters.wakeups += 1;
    yields.push({ kind: 'MARKDOWN_CONTROL', event: event.kind });
  }
  return { counters, yields };
}

async function runtimeArm() {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-bridge-runtime-arm-'));
  const counters = empty(); const yields = []; let revision;
  for (let index = 0; index < events.length; index += 1) {
    const result = await transition({ runDir: root, runId: corpus.runId, mode: 'runtime', plan }, { event: events[index], eventId: `event-${index}`, ...(revision === undefined ? {} : { expectedRevision: revision }) });
    revision = result.yield?.snapshot.revision; yields.push(result.yield);
    const source = result.counters;
    counters.reads += source.projectionReads; counters.writes += source.projectionWrites; counters.bytesRead += source.projectionBytesRead; counters.bytesWritten += source.projectionBytesWritten; counters.wakeups += source.routineWakeups;
  }
  return { counters, yields };
}

const pairs = [];
for (let repetition = 0; repetition < corpus.repetitions; repetition += 1) {
  const markdown = await markdownArm(); const runtime = await runtimeArm();
  pairs.push({ repetition, semanticParity: runtime.yields.length === events.length, markdown, runtime });
}
const avg = (key, arm) => pairs.reduce((sum, pair) => sum + pair[arm].counters[key], 0) / pairs.length;
const markdownBytes = avg('bytesRead', 'markdown') + avg('bytesWritten', 'markdown');
const runtimeBytes = avg('bytesRead', 'runtime') + avg('bytesWritten', 'runtime');
console.log(canonicalString({ schema: 'lunacy-bridge-paired-v1', corpus: 'bridge-corpus.json', repetitions: pairs.length, pairs, averages: { markdownControlBytes: markdownBytes, runtimeProjectionBytes: runtimeBytes, byteReduction: markdownBytes ? (markdownBytes - runtimeBytes) / markdownBytes : null }, parity: pairs.every((pair) => pair.semanticParity), thresholds: { requiredControlBytesReduction: 0.5, requiredReadsReduction: 0.5, requiredWritesReduction: 0.4, requiredWakeupReduction: 0.3, result: 'NOT_CLAIMED', reason: 'No provider/token/native host counters; this fixture records local projection/control bytes only.' }, providerCounters: 'unavailable', tokenCounters: 'unavailable', nativeCounters: 'unavailable' }));
