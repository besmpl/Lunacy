import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeKernel } from '../../dist/composition.js';
import { canonicalString, digest } from '../../dist/canonical.js';
import { FileArtifactStore } from '../../dist/store.js';

const rootDir = process.argv[2]; const runId = process.argv[3];
if (!rootDir || !runId) throw new Error('usage: c1-claimed-crash-child.mjs ROOT RUN_ID');
const plan = { phaseId: 'c1', steps: [{ stepId: 'worker' }] };
const eventInput = (eventId, event, snapshot) => ({
  runId, ...(snapshot ? { expectedRevision: snapshot.revision } : {}),
  identity: { runId, phaseId: 'run', stepId: 'run', attemptEpoch: snapshot?.attemptEpoch ?? 0, authorityEpoch: snapshot?.authorityEpoch ?? 0, barrierEpoch: snapshot?.barrierEpoch ?? 0, eventId, payloadDigest: digest(event) }, event,
});
const driver = {
  dispatch(command, launchToken) {
    const evidence = { schema: 'C1.CLAIMED_AFTER_PASS/v1', launchToken, commandDigest: command.commandDigest, status: 'PASS' };
    writeFileSync(join(rootDir, 'CLAIMED_AFTER_PASS.json'), canonicalString(evidence));
    return new Promise(() => undefined);
  },
};
const kernel = composeKernel({ plan, rootDir, driver, timeoutMs: 60_000 });
let yielded = await kernel.advance(eventInput('start', { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } }));
yielded = await kernel.advance(eventInput('claim', { kind: 'RESUME' }, yielded.snapshot));
assert.equal(yielded.kind, 'WAITING');
const loaded = await new FileArtifactStore(rootDir).load();
const command = Object.values(loaded.state.outbox)[0];
assert.equal(command.state, 'CLAIMED');
assert.equal(typeof command.leaseId, 'string');
process.stdout.write(`${canonicalString({ generation: loaded.generation, state: command.state, launchToken: command.launchToken, commandDigest: command.commandDigest })}\n`);
process.exit(0);
