import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalString, digest } from '../../dist/canonical.js';
import { submitParentDecision } from '../../dist/decision-inbox.js';
import { FileArtifactStore } from '../../dist/store.js';

const [mode, configPath, markerPath, readyPath, releasePath] = process.argv.slice(2);
if (!mode || !configPath) throw new Error('usage: p1-pending-crash-child.mjs MODE CONFIG [MARKER READY RELEASE]');
const input = JSON.parse(readFileSync(configPath, 'utf8'));

const commands = new Map();
const driver = {
  dispatch(command, launchToken) {
    commands.set(launchToken, command);
    appendFileSync(markerPath, `${process.pid}\n`);
    return { launchToken, commandDigest: command.commandDigest, ref: { id: 'p1-race', scope: 'test', digest: digest({ accepted: true }), bytes: canonicalString({ accepted: true }) } };
  },
  terminal(launchToken) {
    const command = commands.get(launchToken);
    return { schema: 'lunacy-codex-terminal/v1', launchToken, commandDigest: command.commandDigest, status: 'PASS', outcome: 'normal-completion', exitCode: 0, signal: null, resultDigest: null, reportPath: null, reportDigest: null, eventsDigest: digest('p1-events'), finishedAt: '2025-01-01T00:00:00Z' };
  },
};

if (mode === 'race') {
  const originalLoadReadOnly = FileArtifactStore.prototype.loadReadOnly;
  let first = true;
  FileArtifactStore.prototype.loadReadOnly = async function synchronizedRead(...args) {
    const loaded = await originalLoadReadOnly.apply(this, args);
    if (first) {
      first = false;
      writeFileSync(readyPath, `${process.pid}\n`);
      while (!existsSync(releasePath)) await delay(5);
    }
    return loaded;
  };
  const result = await submitParentDecision({ ...input, driver });
  process.stdout.write(`${JSON.stringify({ status: result.status, code: result.code ?? null, consumed: result.consumed, revision: result.revision })}\n`);
  process.exit(0);
}

if (mode === 'crash') {
  const result = await submitParentDecision(input);
  assert.equal(result.status, 'committed');
  const loaded = await new FileArtifactStore(input.selection.runRoot).loadReadOnly(input.selection.runId);
  assert.ok(Object.values(loaded.state.outbox).some((command) => command.state === 'PENDING'));
  process.stdout.write(`${JSON.stringify({ status: result.status, pending: true })}\n`);
  process.kill(process.pid, 'SIGKILL');
}

throw new Error(`unknown mode ${mode}`);
