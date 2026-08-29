import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import { readFileSync, renameSync, symlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun, runRun } from '../dist/orchestration.js';
import { canonicalString, digest } from '../dist/canonical.js';
import { FileArtifactStore } from '../dist/store.js';
import { createContinuationSession, loadContinuationSession, wakeContinuation, validateContinuationRecord } from '../dist/continuation.js';

const plan = { phaseId: 'continuation-test', steps: [{ stepId: 'one' }] };
function driver(calls = []) {
  const commands = new Map();
  return {
    dispatch(command, token) { calls.push(`dispatch:${token}`); commands.set(token, command); return { launchToken: token, commandDigest: command.commandDigest, ref: { id: `launch:${token}`, scope: 'test', digest: digest({ token }), bytes: canonicalString({ token }) } }; },
    terminal(token) { const command = commands.get(token); return { schema: 'lunacy-codex-terminal/v1', launchToken: token, commandDigest: command.commandDigest, status: 'PASS', outcome: 'normal-completion', exitCode: 0, signal: null, resultDigest: null, reportPath: null, reportDigest: null, eventsDigest: digest('events'), finishedAt: '2025-01-01T00:00:00.000Z' }; },
  };
}
async function rootRun(prefix = 'continuation-') { const root = await mkdtemp(join(tmpdir(), prefix)); await initRun({ runDir: root, runId: 'run', plan }); return root; }

test('creates closed sidecar and restart reload revalidates CURRENT/root binding', async () => {
  const root = await rootRun(); const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', maxWakes: 2 });
  assert.equal(session.record.schema, 'lunacy-continuation/v1'); assert.equal(session.record.state, 'ACTIVE');
  const reloaded = await loadContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' });
  assert.equal(reloaded?.record.ownerNonce, 'nonce');
  assert.deepEqual(validateContinuationRecord(JSON.parse(await readFile(session.sidecarPath, 'utf8'))), session.record);
});

test('one explicit wake calls existing lifecycle once and decisions remain disabled', async () => {
  const root = await rootRun(); const calls = []; const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' });
  const result = await session.wake({ source: 'explicit-resume', plan, driver: driver(calls), maxTransitions: 1 });
  assert.equal(calls.length, 1); // exactly one existing lifecycle/pump invocation
  assert.equal(result.status, 'advanced');
  assert.equal(result.lifecycle?.command, 'resume');
  assert.equal((await new FileArtifactStore(root).load()).state?.journal.some((row) => row.event.kind === 'PARENT_DECISION'), false);
});

test('concurrent wakes checkpoint one in-flight lifecycle and fence the second', async () => {
  const root = await rootRun(); const calls = []; const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', maxWakes: 2 });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const first = session.wake({ source: 'explicit-resume', plan, driver: { ...driver(calls), dispatch(command, token) { calls.push(`dispatch:${token}`); return gate.then(() => ({ launchToken: token, commandDigest: command.commandDigest, ref: { id: `launch:${token}`, scope: 'test', digest: digest({ token }), bytes: canonicalString({ token }) } })); } }, maxTransitions: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await session.wake({ source: 'explicit-resume', plan, driver: driver(calls), maxTransitions: 1 });
  assert.equal(second.attention?.code, 'SIDECAR_CONFLICT');
  release(); await first; assert.equal(calls.filter((entry) => entry.startsWith('dispatch:')).length, 1);
});

test('wake race has one owner and bounded checkpoint; second owner is rejected', async () => {
  const root = await rootRun();
  const first = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'first', ownerNonce: 'one', maxWakes: 1 });
  await assert.rejects(() => createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'second', ownerNonce: 'two' }), /active owner/);
  const result = await first.wake({ source: 'explicit-resume', plan, driver: driver(), maxTransitions: 1 });
  assert.equal(result.wakeCount, 1);
  const next = await first.wake({ source: 'explicit-resume', plan, driver: driver(), maxTransitions: 1 });
  assert.equal(next.attention?.code, 'MAX_WAKES');
});

test('receipt, terminal, and inbox labels are not wake sources', async () => {
  const root = await rootRun(); const calls = [];
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' });
  for (const source of ['receipt', 'terminal', 'inbox']) {
    const result = await session.wake({ source, plan, driver: driver(calls), maxTransitions: 1 });
    assert.equal(result.attention?.code, 'UNSUPPORTED_WAKE');
  }
  assert.deepEqual(calls, []);
  assert.equal((await loadContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' }))?.record.state, 'ACTIVE');
});

test('expired lease renewal cannot resurrect the owner', async () => {
  const root = await rootRun();
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', leaseTtlMs: 10, deadline: '2030-01-01T00:00:00.000Z', now: '2025-01-01T00:00:00.000Z' });
  const renewed = await session.renew({ now: '2025-01-01T00:00:01.000Z', leaseTtlMs: 1000 });
  assert.equal(renewed.state, 'ATTENTION');
  assert.ok(['STALE_LIVENESS', 'LEASE_EXPIRED'].includes(renewed.attention));
  assert.equal(renewed.leaseEpoch, 1);
  assert.equal(renewed.leaseExpiresAt, session.record.leaseExpiresAt);
});

test('dead owner liveness cannot renew a still-future lease', async () => {
  const root = await rootRun();
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', leaseTtlMs: 60_000, deadline: '2030-01-01T00:00:00.000Z', now: '2025-01-01T00:00:00.000Z' });
  const value = JSON.parse(await readFile(session.sidecarPath, 'utf8'));
  value.ownerPid = 99_999_999;
  await writeFile(session.sidecarPath, canonicalString(value));
  const reloaded = await loadContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' });
  assert.ok(reloaded);
  const renewed = await reloaded.renew({ now: '2025-01-01T00:00:01.000Z', leaseTtlMs: 1000 });
  assert.equal(renewed.state, 'ATTENTION');
  assert.equal(renewed.attention, 'STALE_LIVENESS');
  assert.equal(renewed.leaseEpoch, 1);
});

test('revoke wins over an in-flight lifecycle finalization', async () => {
  const root = await rootRun(); const calls = []; let release; const gate = new Promise((resolve) => { release = resolve; });
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' });
  const first = session.wake({ source: 'explicit-resume', plan, driver: { ...driver(calls), dispatch(command, token) { calls.push(`dispatch:${token}`); return gate.then(() => ({ launchToken: token, commandDigest: command.commandDigest, ref: { id: `launch:${token}`, scope: 'test', digest: digest({ token }), bytes: canonicalString({ token }) } })); } }, maxTransitions: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const revoked = await session.revoke();
  assert.equal(revoked.state, 'REVOKED');
  release();
  const result = await first;
  assert.equal(result.status, 'attention');
  const latest = validateContinuationRecord(JSON.parse(await readFile(session.sidecarPath, 'utf8')));
  assert.equal(latest.state, 'REVOKED');
  assert.equal(latest.attention, 'REVOKED');
});

test('sidecar parent substitution is rejected at a publication boundary', async () => {
  const root = await rootRun(); const kernel = join(root, '.kernel'); const moved = `${kernel}.moved`;
  let substituted = false; let fault = false;
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', faultInjector(point) {
    if (fault && !substituted && point === 'before-rename') { substituted = true; renameSync(kernel, moved); symlinkSync(moved, kernel); }
  } });
  fault = true;
  await assert.rejects(() => session.revoke(), /SIDECAR_FAULT|parent changed|symlink/);
  await rm(kernel, { force: true }); await rename(moved, kernel);
  const restored = await loadContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' });
  assert.equal(restored?.record.state, 'ACTIVE');
});

test('continuation stays Node-only with no external runtime helper', () => {
  const source = readFileSync(new URL('../src/continuation.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /python3|AT_HELPER|dir_fd|spawn\(/);
});

test('replacement lock inode and bytes survive conservative release', async () => {
  const root = await rootRun(); const kernel = join(root, '.kernel'); const lockPath = join(kernel, '.continuation.lock');
  let armed = false; let replaced = false; const replacement = `${lockPath}.replacement`;
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', faultInjector(point) {
    if (armed && !replaced && point === 'before-temp') {
      replaced = true;
      writeFileSync(replacement, 'replacement-lock-bytes');
      renameSync(replacement, lockPath);
    }
  } });
  armed = true;
  await session.revoke();
  assert.equal(await readFile(lockPath, 'utf8'), 'replacement-lock-bytes');
  await rm(lockPath, { force: true });
});

test('replacement temp inode survives identity-only cleanup', async () => {
  const root = await rootRun(); const kernel = join(root, '.kernel');
  let armed = false; let replaced = false; let temporary;
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', faultInjector(point) {
    if (armed && !replaced && point === 'before-rename') {
      temporary = readdirSync(kernel).find((name) => name.endsWith('.tmp'));
      assert.ok(temporary);
      const replacement = join(kernel, '.replacement-temp');
      writeFileSync(replacement, 'replacement-temp-bytes');
      renameSync(replacement, join(kernel, temporary));
      replaced = true;
      throw new Error('fault');
    }
  } });
  armed = true;
  const before = await readFile(session.sidecarPath, 'utf8');
  await assert.rejects(() => session.revoke(), /fault/);
  assert.equal(await readFile(session.sidecarPath, 'utf8'), before);
  assert.equal(await readFile(join(kernel, temporary), 'utf8'), 'replacement-temp-bytes');
  await rm(join(kernel, temporary), { force: true });
});


test('same-inode temp byte tamper survives identity-and-bytes cleanup', async () => {
  const root = await rootRun(); const kernel = join(root, '.kernel');
  let armed = false; let tampered = false; let temporary;
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', faultInjector(point) {
    if (armed && !tampered && point === 'before-rename') {
      temporary = readdirSync(kernel).find((name) => name.endsWith('.tmp'));
      assert.ok(temporary);
      writeFileSync(join(kernel, temporary), 'TAMPERED-IN-PLACE');
      tampered = true;
      throw new Error('fault');
    }
  } });
  armed = true;
  await assert.rejects(() => session.revoke(), /fault/);
  assert.equal(await readFile(join(kernel, temporary), 'utf8'), 'TAMPERED-IN-PLACE');
  await rm(join(kernel, temporary), { force: true });
});

test('lock release inspection error is a conservative no-op', async () => {
  const root = await rootRun(); const kernel = join(root, '.kernel'); const lockPath = join(kernel, '.continuation.lock');
  let armed = false; let injected = false; const originalLstat = fsPromises.lstat;
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', faultInjector(point) {
    if (armed && !injected && point === 'after-directory-sync') {
      injected = true;
      fsPromises.lstat = async (path, ...rest) => path === lockPath ? Promise.reject(new Error('inspection')) : originalLstat(path, ...rest);
    }
  } });
  armed = true;
  try { await session.revoke(); } finally { fsPromises.lstat = originalLstat; }
  assert.equal(await readFile(lockPath, 'utf8').then(() => true, () => false), true);
  await rm(lockPath, { force: true });
});

test('temp cleanup inspection error leaves the temporary path intact', async () => {
  const root = await rootRun(); const kernel = join(root, '.kernel');
  let armed = false; let injected = false; let temporary; const originalLstat = fsPromises.lstat;
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', faultInjector(point) {
    if (armed && !injected && point === 'before-rename') {
      temporary = readdirSync(kernel).find((name) => name.endsWith('.tmp'));
      assert.ok(temporary);
      injected = true;
      fsPromises.lstat = async (path, ...rest) => path === join(kernel, temporary) ? Promise.reject(new Error('inspection')) : originalLstat(path, ...rest);
      throw new Error('fault');
    }
  } });
  armed = true;
  try { await assert.rejects(() => session.revoke(), /fault/); } finally { fsPromises.lstat = originalLstat; }
  assert.equal(await readFile(join(kernel, temporary), 'utf8').then(() => true, () => false), true);
  await rm(join(kernel, temporary), { force: true });
});

test('an existing lock is never reclaimed from mtime', async () => {
  const root = await rootRun();
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' });
  const lockPath = join(root, '.kernel', '.continuation.lock');
  await writeFile(lockPath, '{"ownerPid":1,"acquiredAt":"2025-01-01T00:00:00.000Z"}', { mode: 0o600 });
  const result = await session.wake({ source: 'explicit-resume', plan, driver: driver(), maxTransitions: 1, now: '2025-01-01T00:00:00.000Z' });
  assert.equal(result.attention?.code, 'SIDECAR_CONFLICT');
  assert.equal((await readFile(lockPath, 'utf8')).includes('ownerPid'), true);
});

test('cancellation and UNKNOWN stop without relaunch; absent sidecar is disabled', async () => {
  const root = await rootRun(); const calls = []; const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' });
  const controller = new AbortController(); controller.abort();
  const cancelled = await session.wake({ source: 'explicit-resume', plan, driver: driver(calls), signal: controller.signal });
  assert.equal(cancelled.attention?.code, 'CANCELLED'); assert.deepEqual(calls, []);
  const missingRoot = await mkdtemp(join(tmpdir(), 'continuation-disabled-'));
  const disabled = await wakeContinuation({ runRoot: missingRoot, runId: 'run', plan, source: 'explicit-resume', driver: driver() });
  assert.equal(disabled.status, 'disabled'); assert.equal(disabled.attention?.code, 'DISABLED');
});

test('sidecar publication fault leaves old-or-new valid bytes', async () => {
  const root = await rootRun(); let fault = false;
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce', faultInjector(point) { if (fault && point === 'before-rename') throw new Error('fault'); } });
  fault = true;
  const before = await readFile(session.sidecarPath, 'utf8');
  await assert.rejects(() => session.revoke(), /fault/);
  fault = false;
  const after = await readFile(session.sidecarPath, 'utf8');
  assert.equal(after, before);
  assert.equal((await loadContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' }))?.record.state, 'ACTIVE');
});

test('UNKNOWN and malformed proof are bounded attention with no relaunch', async () => {
  const root = await rootRun();
  const attempts = [];
  await runRun({ runDir: root, runId: 'run', plan, driver: { dispatch() { attempts.push('dispatch'); throw new Error('launch failure'); } }, maxTransitions: 1 });
  const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' });
  const before = attempts.length;
  const unknown = await session.wake({ source: 'explicit-resume', plan, driver: { dispatch() { attempts.push('dispatch'); throw new Error('must not relaunch'); } }, maxTransitions: 1 });
  assert.equal(unknown.attention?.code, 'UNKNOWN'); assert.equal(attempts.length, before);
  const malformed = await session.wake({ source: 'proof', plan, driver: driver() });
  assert.equal(malformed.attention?.code, 'MALFORMED_PROOF'); assert.equal(attempts.length, before);
});

test('restart rejects sidecar binding drift before lifecycle', async () => {
  const root = await rootRun(); const session = await createContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' });
  const value = JSON.parse(await readFile(session.sidecarPath, 'utf8')); value.runId = 'other';
  await writeFile(session.sidecarPath, canonicalString(value));
  await assert.rejects(() => loadContinuationSession({ runRoot: root, runId: 'run', plan, owner: 'owner', ownerNonce: 'nonce' }), /BINDING|CURRENT/);
});
