import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalString, digest } from '../dist/canonical.js';
import { makeRunKernel } from '../dist/index.js';
import { FileArtifactStore } from '../dist/store.js';

const plan = {
  phaseId: 'l2-wide',
  steps: [
    { stepId: 'd', dependencies: ['a'] },
    { stepId: 'c', claims: [{ resource: 'independent', mode: 'WRITE' }] },
    { stepId: 'b', claims: [{ resource: 'shared', mode: 'READ' }] },
    { stepId: 'a', claims: [{ resource: 'shared', mode: 'WRITE' }] },
  ],
};

function startInput() {
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
  return {
    runId: 'l2-wide-run',
    identity: {
      runId: 'l2-wide-run', phaseId: 'run', stepId: 'run', attemptEpoch: 0,
      authorityEpoch: 0, barrierEpoch: 0, eventId: 'start', payloadDigest: digest(event),
    },
    event,
  };
}

async function journey(rootDir, acceleration) {
  const kernel = makeRunKernel({ plan, rootDir, maxInFlight: 2, acceleration });
  const first = await kernel.advance(startInput());
  const replay = await kernel.advance(startInput());
  const state = (await new FileArtifactStore(rootDir).load()).state;
  return {
    first: canonicalString(first),
    replay: canonicalString(replay),
    stateBytes: await readFile(join(rootDir, '.kernel', 'generations', 'g1', 'state.json'), 'utf8'),
    projection: Object.fromEntries(Object.entries(state.steps).map(([id, step]) => [id, step.status])),
    outboxOrder: Object.values(state.outbox).map((command) => command.stepId),
    journalEvents: state.journal.map((row) => row.identity.eventId),
  };
}

test('L2 wide plan dependencies conflicts order and replay remain reducer-authoritative twice', async (t) => {
  const roots = await Promise.all(['a', 'b', 'legacy'].map((suffix) => mkdtemp(join(tmpdir(), `lunacy-l2-wide-${suffix}-`))));
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  const first = await journey(roots[0]);
  const second = await journey(roots[1]);
  const legacy = await journey(roots[2], { graph: 'ON' });
  assert.equal(first.replay, first.first);
  assert.deepEqual(first, second);
  assert.deepEqual(legacy, first);
  assert.deepEqual(first.projection, { a: 'ACTIVE', b: 'READY', c: 'ACTIVE', d: 'READY' });
  assert.deepEqual(first.outboxOrder, ['a', 'c']);
  assert.deepEqual(first.journalEvents, ['start']);
});
