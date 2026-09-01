import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const CHILD = new URL('./p2-one-shot-crash-child.mjs', import.meta.url);
const FLOOR = 22;
const GENERATIONS = [FLOOR - 1, FLOOR, FLOOR + 1];
const CUTS = [
  ['claim-cas', 'pending'],
  ['provider-entry', 'pending'],
  ['teardown-publication', 'claimed'],
  ['claimed-to-unknown-publication', 'claimed'],
  ['exact-token-observation', 'unknown'],
  ['receipt-publication', 'pending'],
  ['terminal-retirement', 'unknown'],
  ['processed-yield-publication', 'unknown'],
  ['file-restart-load', 'unknown'],
];
const SIDES = ['before', 'after'];

function child(mode, args, expectedStatus = 0) {
  const flat = Object.entries(args).flatMap(([key, value]) => [`--${key}`, String(value)]);
  const result = spawnSync(process.execPath, [CHILD.pathname, mode, ...flat], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(
    result.status,
    expectedStatus,
    `${mode} ${JSON.stringify(args)} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function jsonResult(result) {
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  assert.ok(lines.length > 0, `child emitted no JSON; stderr:\n${result.stderr}`);
  return JSON.parse(lines.at(-1));
}

function lowerGenerationRetires(cut, side) {
  if (cut === 'claim-cas') return side === 'before';
  if (cut === 'provider-entry' || cut === 'teardown-publication') return false;
  if (cut === 'claimed-to-unknown-publication') return side === 'after';
  if (cut === 'receipt-publication') return false;
  return true;
}

test('P2 isolated-child crash lattice fences every one-shot cut on Memory and File stores', { timeout: 180_000 }, () => {
  const temp = mkdtempSync(join(tmpdir(), 'lunacy-p2-one-shot-lattice-'));
  try {
    const bases = new Map();
    for (const generation of GENERATIONS) {
      for (const state of ['pending', 'claimed', 'unknown']) {
        const root = join(temp, `base-g${generation}-${state}`);
        child('setup', { root, generation, state });
        bases.set(`${generation}:${state}`, root);
      }
    }

    for (const generation of GENERATIONS) {
      const memory = jsonResult(child('memory-matrix', { generation }));
      assert.deepEqual(memory.missing, [], `Memory cut coverage g${generation}`);
      assert.equal(memory.maxProviderEntries, 1, `Memory provider entry count g${generation}`);
      if (generation >= FLOOR) {
        assert.equal(memory.retired.runStatus, 'BLOCKED');
        assert.equal(memory.retired.attemptEpoch, 0);
        assert.deepEqual(memory.repeated, {
          runStatus: 'BLOCKED',
          attemptEpoch: 0,
          revision: memory.retired.revision ?? memory.repeated.revision,
        });
      } else {
        assert.equal(memory.retired.runStatus, 'WAITING');
        assert.equal(memory.retired.attemptEpoch, 1);
      }
    }

    const rows = [];
    for (const generation of GENERATIONS) {
      for (const [cut, baseState] of CUTS) {
        for (const side of SIDES) {
          const root = join(temp, `cell-g${generation}-${cut}-${side}`);
          cpSync(bases.get(`${generation}:${baseState}`), root, { recursive: true });
          child('cut', { root, generation, cut, side }, 86);
          const row = jsonResult(child('verify', { root, generation, cut, side }));
          rows.push(row);

          assert.ok(row.maxProviderEntries <= 1, `${cut}/${side}/g${generation}: provider re-entry`);
          if (generation >= FLOOR) {
            assert.equal(row.after.attemptEpoch, 0, `${cut}/${side}/g${generation}: epoch churn`);
            assert.equal(row.reservationsUnchanged, true, `${cut}/${side}/g${generation}: reservation churn`);
            assert.equal(row.countersUnchanged, true, `${cut}/${side}/g${generation}: counter churn`);
            if (lowerGenerationRetires(cut, side)) {
              assert.equal(row.after.stateStatus, 'BLOCKED', `${cut}/${side}/g${generation}: terminal state`);
              assert.equal(row.after.nextAction, 'blocked', `${cut}/${side}/g${generation}: terminal action`);
              assert.equal(row.repeatedStable, true, `${cut}/${side}/g${generation}: repeated RESUME drift`);
              assert.equal(row.lateReceiptInert, true, `${cut}/${side}/g${generation}: late receipt changed terminal state`);
            }
          } else if (lowerGenerationRetires(cut, side)) {
            assert.equal(row.after.attemptEpoch, 1, `${cut}/${side}/g${generation}: historical epoch`);
            assert.equal(row.after.stateStatus, 'ACTIVE', `${cut}/${side}/g${generation}: historical state`);
            assert.equal(row.after.hasFreshCommand, true, `${cut}/${side}/g${generation}: historical retry command`);
            assert.ok(row.after.attemptStatuses.some((status) => ['UNKNOWN', 'TIMED_OUT', 'FAILED'].includes(status)));
          } else {
            assert.equal(row.after.attemptEpoch, 0, `${cut}/${side}/g${generation}: premature retry`);
          }

          if (cut === 'teardown-publication') {
            assert.equal(row.teardownCustody, side === 'after', `${cut}/${side}/g${generation}: custody`);
          }
          if (cut === 'claimed-to-unknown-publication') {
            assert.equal(row.teardownCustody, true, `${cut}/${side}/g${generation}: teardown evidence lost`);
          }
          if (cut === 'exact-token-observation') {
            assert.equal(row.observationCustody, side === 'after', `${cut}/${side}/g${generation}: observation custody`);
          }
        }
      }
    }

    assert.equal(rows.length, GENERATIONS.length * CUTS.length * SIDES.length);
    for (const generation of GENERATIONS) {
      for (const [cut] of CUTS) {
        for (const side of SIDES) {
          assert.ok(rows.some((row) => row.generation === generation && row.cut === cut && row.side === side));
        }
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
