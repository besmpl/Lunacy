import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants, promises as fs, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeadsPlanSource } from '../dist/beads.js';
import { digest } from '../dist/canonical.js';
import { transition } from '../dist/bridge.js';
import { copyImmutableEvidenceFile, EVIDENCE_REFLINK_MIN_BYTES, EvidenceCopyError } from '../dist/evidence-copy.js';

const LARGE_BYTES = EVIDENCE_REFLINK_MIN_BYTES + 64 * 1024;
const bytes = (length = LARGE_BYTES, fill = 0x5a) => Buffer.alloc(length, fill);
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function copyFixture(fill = 0x5a) {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-reflink-'));
  const source = join(root, 'source.bin');
  await writeFile(source, bytes(LARGE_BYTES, fill), { mode: 0o600 });
  return { root, source };
}

async function leftovers(root) {
  return (await readdir(root)).filter((name) => name.includes('.copy-') || name.includes('.reflink-'));
}

async function actualCloneProbe(root, source, name = 'probe.bin') {
  const destination = join(root, name);
  try {
    const result = await copyImmutableEvidenceFile(source, destination, { policy: 'require', maximumBytes: LARGE_BYTES });
    return { supported: true, result, destination };
  } catch (error) {
    if (error instanceof EvidenceCopyError && error.code === 'CLONE_REQUIRED') return { supported: false, error, destination };
    throw error;
  }
}

test('off preserves the direct-copy artifact shape, bytes, SHA, mode, and independent inode', async () => {
  const fixture = await copyFixture();
  const destination = join(fixture.root, 'off.bin');
  const result = await copyImmutableEvidenceFile(fixture.source, destination, { policy: 'off', maximumBytes: LARGE_BYTES });
  const [sourceStat, destinationStat, copied] = await Promise.all([stat(fixture.source), stat(destination), readFile(destination)]);
  assert.equal(result.method, 'off-full-copy');
  assert.equal(result.digest, sha(copied));
  assert.deepEqual(copied, bytes());
  assert.notEqual(destinationStat.ino, sourceStat.ino);
  assert.equal(destinationStat.mode & 0o777, 0o500);
  await chmod(destination, 0o700); await writeFile(destination, bytes(LARGE_BYTES, 0x33));
  assert.deepEqual(await readFile(fixture.source), bytes());
  assert.deepEqual(await leftovers(fixture.root), []);
});

test('off fails closed without deleting a destination that replaces its open inode', async () => {
  const fixture = await copyFixture(0x39);
  const destination = join(fixture.root, 'off-raced.bin');
  const competitor = Buffer.from('concurrent destination');
  let boundaries = 0;
  await assert.rejects(
    () => copyImmutableEvidenceFile(fixture.source, destination, {
      policy: 'off', maximumBytes: LARGE_BYTES,
      checkBoundary: () => {
        boundaries += 1;
        if (boundaries === 2) { unlinkSync(destination); writeFileSync(destination, competitor); }
      },
    }),
    (error) => error instanceof EvidenceCopyError && error.code === 'INVALID',
  );
  assert.deepEqual(await readFile(destination), competitor);
  assert.deepEqual(await leftovers(fixture.root), []);
});

test('off rejects a source mutation during the descriptor copy and removes only its own destination', async () => {
  const fixture = await copyFixture(0x3a);
  const destination = join(fixture.root, 'off-source-raced.bin');
  let boundaries = 0;
  await assert.rejects(
    () => copyImmutableEvidenceFile(fixture.source, destination, {
      policy: 'off', maximumBytes: LARGE_BYTES,
      checkBoundary: () => {
        boundaries += 1;
        if (boundaries === 2) writeFileSync(fixture.source, bytes(LARGE_BYTES, 0x3b));
      },
    }),
    (error) => error instanceof EvidenceCopyError && error.code === 'SOURCE_UNSTABLE',
  );
  await assert.rejects(() => stat(destination), { code: 'ENOENT' });
  assert.deepEqual(await leftovers(fixture.root), []);
});

test('require is explicit about host clone support and never publishes or leaks a temporary on failure', async () => {
  const fixture = await copyFixture(0x41);
  const probe = await actualCloneProbe(fixture.root, fixture.source);
  if (probe.supported) {
    assert.equal(probe.result.method, 'reflink');
    assert.deepEqual(await readFile(probe.destination), bytes(LARGE_BYTES, 0x41));
    assert.notEqual((await stat(probe.destination)).ino, (await stat(fixture.source)).ino);
  } else {
    assert.match(probe.error.message, /^required evidence reflink failed: /);
    await assert.rejects(() => stat(probe.destination), { code: 'ENOENT' });
  }
  assert.deepEqual(await leftovers(fixture.root), []);
});

test('prefer records a truthful fallback and publishes only a fully verified file', async () => {
  const fixture = await copyFixture(0x42);
  const destination = join(fixture.root, 'prefer.bin');
  const result = await copyImmutableEvidenceFile(fixture.source, destination, { policy: 'prefer', maximumBytes: LARGE_BYTES });
  assert.ok(result.method === 'reflink' || result.method === 'fallback-full-copy');
  if (result.method === 'fallback-full-copy') assert.ok(result.fallbackReason);
  else assert.equal(result.fallbackReason, undefined);
  const copied = await readFile(destination);
  assert.deepEqual(copied, bytes(LARGE_BYTES, 0x42));
  assert.equal(result.digest, sha(copied));
  assert.equal((await stat(destination)).mode & 0o777, 0o500);
  assert.deepEqual(await leftovers(fixture.root), []);
});

test('small files are ineligible rather than a require-policy clone failure', async () => {
  const fixture = await copyFixture();
  const small = join(fixture.root, 'small'); const destination = join(fixture.root, 'small-copy');
  await writeFile(small, bytes(4096));
  const result = await copyImmutableEvidenceFile(small, destination, { policy: 'require', maximumBytes: 4096 });
  assert.equal(result.method, 'ineligible-full-copy');
  assert.deepEqual(await readFile(destination), bytes(4096));
});

test('symlink and non-regular sources are rejected without publication', async () => {
  const fixture = await copyFixture();
  const alias = join(fixture.root, 'alias'); await symlink(fixture.source, alias);
  await assert.rejects(() => copyImmutableEvidenceFile(alias, join(fixture.root, 'alias-copy'), { policy: 'prefer', maximumBytes: LARGE_BYTES }), EvidenceCopyError);
  const directory = join(fixture.root, 'directory'); await mkdir(directory);
  await assert.rejects(() => copyImmutableEvidenceFile(directory, join(fixture.root, 'directory-copy'), { policy: 'prefer', maximumBytes: LARGE_BYTES }), EvidenceCopyError);
  assert.deepEqual(await leftovers(fixture.root), []);
});

test('require rejects an eligible cross-volume destination before publication', async (t) => {
  if (process.platform !== 'darwin') { t.skip('cross-volume APFS policy is Darwin-only'); return; }
  const fixture = await copyFixture();
  const sourceDev = (await stat(fixture.source)).dev;
  let otherVolume;
  try {
    for (const entry of await readdir('/Volumes', { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join('/Volumes', entry.name);
      try { if ((await stat(candidate)).dev !== sourceDev) { otherVolume = candidate; break; } } catch { /* unavailable mount */ }
    }
  } catch { /* no mounted volume */ }
  if (!otherVolume) { t.skip('no mounted cross-volume destination is available'); return; }
  const destination = join(otherVolume, `lunacy-cross-volume-${process.pid}.bin`);
  await assert.rejects(
    () => copyImmutableEvidenceFile(fixture.source, destination, { policy: 'require', maximumBytes: LARGE_BYTES }),
    (error) => error instanceof EvidenceCopyError && error.code === 'CLONE_REQUIRED' && error.fallbackReason === 'cross-volume',
  );
  await assert.rejects(() => stat(destination), { code: 'ENOENT' });
});

test('require rejects a same-volume non-APFS eligibility probe without invoking copy', async () => {
  if (process.platform !== 'darwin') return;
  const fixture = await copyFixture();
  const destination = join(fixture.root, 'non-apfs.bin');
  const originalStatfs = fs.statfs; const originalCopyFile = fs.copyFile;
  let copyCalls = 0;
  fs.statfs = async (...args) => ({ ...await originalStatfs(...args), type: 25n });
  fs.copyFile = async (...args) => { copyCalls += 1; return originalCopyFile(...args); };
  try {
    await assert.rejects(
      () => copyImmutableEvidenceFile(fixture.source, destination, { policy: 'require', maximumBytes: LARGE_BYTES }),
      (error) => error instanceof EvidenceCopyError && error.code === 'CLONE_REQUIRED' && error.fallbackReason === 'unsupported-filesystem',
    );
  } finally { fs.statfs = originalStatfs; fs.copyFile = originalCopyFile; }
  assert.equal(copyCalls, 0);
  await assert.rejects(() => stat(destination), { code: 'ENOENT' });
});

test('source mutation during the clone call fails closed and cleans the exclusive sibling', async () => {
  const fixture = await copyFixture(0x51);
  const destination = join(fixture.root, 'raced.bin');
  const originalCopyFile = fs.copyFile;
  fs.copyFile = async (source, target) => {
    await originalCopyFile(source, target, fsConstants.COPYFILE_EXCL);
    await writeFile(source, bytes(LARGE_BYTES, 0x52));
  };
  try {
    await assert.rejects(
      () => copyImmutableEvidenceFile(fixture.source, destination, { policy: 'prefer', maximumBytes: LARGE_BYTES }),
      (error) => error instanceof EvidenceCopyError && error.code === 'SOURCE_UNSTABLE',
    );
  } finally { fs.copyFile = originalCopyFile; }
  await assert.rejects(() => stat(destination), { code: 'ENOENT' });
  assert.deepEqual(await leftovers(fixture.root), []);
});

test('clone failure after a partial temporary cannot become a require-policy destination', async () => {
  const fixture = await copyFixture(0x61);
  const destination = join(fixture.root, 'partial.bin');
  const originalCopyFile = fs.copyFile;
  fs.copyFile = async (source, target) => {
    await originalCopyFile(source, target, fsConstants.COPYFILE_EXCL);
    await fs.truncate(target, 1);
    const error = new Error('injected clone failure'); error.code = 'EIO'; throw error;
  };
  try {
    await assert.rejects(
      () => copyImmutableEvidenceFile(fixture.source, destination, { policy: 'require', maximumBytes: LARGE_BYTES }),
      (error) => error instanceof EvidenceCopyError && error.code === 'CLONE_REQUIRED' && error.fallbackReason === 'clone-failed',
    );
  } finally { fs.copyFile = originalCopyFile; }
  await assert.rejects(() => stat(destination), { code: 'ENOENT' });
  assert.deepEqual(await leftovers(fixture.root), []);
});

test('verified publication never overwrites a concurrently created destination', async () => {
  const fixture = await copyFixture(0x69);
  const destination = join(fixture.root, 'publication-raced.bin');
  const competitor = Buffer.from('concurrent destination');
  const originalCopyFile = fs.copyFile; const originalLink = fs.link;
  fs.copyFile = async (source, target) => originalCopyFile(source, target, fsConstants.COPYFILE_EXCL);
  fs.link = async (source, target) => {
    await writeFile(target, competitor);
    return originalLink(source, target);
  };
  try {
    await assert.rejects(
      () => copyImmutableEvidenceFile(fixture.source, destination, { policy: 'prefer', maximumBytes: LARGE_BYTES }),
      (error) => error instanceof EvidenceCopyError && error.code === 'INVALID' && /created concurrently/.test(error.message),
    );
  } finally { fs.copyFile = originalCopyFile; fs.link = originalLink; }
  assert.deepEqual(await readFile(destination), competitor);
  assert.deepEqual(await leftovers(fixture.root), []);
});

test('concurrent destinations remain complete and independent', async () => {
  const fixture = await copyFixture(0x71);
  const destinations = [join(fixture.root, 'left.bin'), join(fixture.root, 'right.bin')];
  const results = await Promise.all(destinations.map((destination) => copyImmutableEvidenceFile(fixture.source, destination, { policy: 'prefer', maximumBytes: LARGE_BYTES })));
  assert.equal(results.length, 2);
  assert.deepEqual(await Promise.all(destinations.map((destination) => readFile(destination))), [bytes(LARGE_BYTES, 0x71), bytes(LARGE_BYTES, 0x71)]);
  const stats = await Promise.all([stat(fixture.source), ...destinations.map(stat)]);
  assert.equal(new Set(stats.map((value) => value.ino)).size, 3);
  assert.deepEqual(await leftovers(fixture.root), []);
});

test('COW isolation and comparable allocated-block measurement are explicit when the host clone path is supported', async (t) => {
  const fixture = await copyFixture(0x22);
  const probe = await actualCloneProbe(fixture.root, fixture.source, 'clone.bin');
  if (!probe.supported) {
    t.skip(`COPYFILE_FICLONE_FORCE unavailable: ${probe.error.fallbackReason}`);
    return;
  }
  const off = join(fixture.root, 'full.bin');
  await copyImmutableEvidenceFile(fixture.source, off, { policy: 'off', maximumBytes: LARGE_BYTES });
  const [cloneStat, offStat] = await Promise.all([stat(probe.destination), stat(off)]);
  const cloneAllocatedBytes = cloneStat.blocks * 512;
  const offAllocatedBytes = offStat.blocks * 512;
  assert.ok(cloneAllocatedBytes <= offAllocatedBytes, `${cloneAllocatedBytes} clone bytes must not exceed ${offAllocatedBytes} full-copy bytes`);
  await chmod(probe.destination, 0o700); await writeFile(probe.destination, bytes(LARGE_BYTES, 0x23));
  assert.deepEqual(await readFile(fixture.source), bytes(LARGE_BYTES, 0x22));
});

async function beadsFixture(policy) {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-reflink-beads-'));
  const workspace = join(root, 'workspace'); const home = join(root, 'home'); const config = join(root, 'config');
  await mkdir(join(workspace, '.beads'), { recursive: true }); await mkdir(home, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
  await writeFile(join(workspace, '.beads', 'evidence.db'), bytes(LARGE_BYTES, 0x32));
  const executablePath = join(root, 'bd');
  const issue = '{"_type":"issue","id":"x","title":"X","status":"open","priority":0,"issue_type":"task"}';
  await writeFile(executablePath, `#!/bin/sh\nif [ "$1" = version ]; then printf '%s' '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}'; exit 0; fi\nprintf '%s\\n' '${issue}'\n`);
  await chmod(executablePath, 0o755);
  const expectedBinaryDigest = sha(await readFile(executablePath));
  return { root, source: new BeadsPlanSource({ executablePath, workspace, homeDir: home, xdgConfigHome: config, expectedBinaryDigest, ...(policy === undefined ? {} : { evidenceCopyPolicy: policy }) }) };
}

test('default and explicit off omit storage metadata while prefer receipts persist through ordinary recovery', async () => {
  const omitted = await beadsFixture(undefined);
  const explicitSource = new BeadsPlanSource({ ...omitted.source.options, evidenceCopyPolicy: 'off' });
  const [omittedCapture, explicitCapture] = await Promise.all([omitted.source.capture(), explicitSource.capture()]);
  assert.deepEqual(Object.keys(omittedCapture).sort(), ['plan', 'snapshot', 'sourceIds']);
  assert.deepEqual(Object.keys(explicitCapture).sort(), ['plan', 'snapshot', 'sourceIds']);
  assert.equal(omittedCapture.snapshot.contentDigest, explicitCapture.snapshot.contentDigest);

  const fixture = await beadsFixture('prefer');
  const captured = await fixture.source.capture();
  assert.equal(captured.evidenceCopy.policy, 'prefer');
  assert.equal(captured.evidenceCopy.eligibleFiles, 1);
  assert.equal(captured.evidenceCopy.clonedFiles + captured.evidenceCopy.fallbackFullCopyFiles, 1);
  if (captured.evidenceCopy.fallbackFullCopyFiles === 1) assert.equal(captured.evidenceCopy.fallbackReasons.reduce((sum, row) => sum + row.count, 0), 1);
  const acknowledgement = { snapshotDigest: captured.snapshot.contentDigest, targetPlanDigest: digest(captured.plan), workspaceIdentity: captured.snapshot.workspaceIdentity, bdCommit: captured.snapshot.bdCommit, binaryDigest: captured.snapshot.binaryDigest };
  const runDir = await mkdtemp(join(tmpdir(), 'lunacy-reflink-recovery-'));
  const started = await transition({ runDir, runId: 'reflink-recovery', mode: 'runtime', beads: { mode: 'active', source: fixture.source, acknowledgement } }, { event: { kind: 'START', intentRef: { id: 'plan', digest: digest(captured.plan) } }, eventId: 'start' });
  const inputName = (await readdir(join(runDir, '.kernel'))).find((name) => /^BEADS\.INPUT\.[0-9a-f]{64}\.json$/.test(name));
  assert.ok(inputName);
  const persisted = JSON.parse(await readFile(join(runDir, '.kernel', inputName), 'utf8'));
  assert.deepEqual(persisted.evidenceCopy, captured.evidenceCopy);
  let calls = 0; fixture.source.capture = async () => { calls += 1; throw new Error('must not recapture'); };
  const recovery = await transition({ runDir, runId: 'reflink-recovery', mode: 'runtime', beads: { mode: 'active', source: fixture.source } }, { event: { kind: 'RESUME' }, eventId: 'resume', expectedRevision: started.yield.snapshot.revision });
  assert.equal(calls, 0);
  assert.equal(recovery.projected, true);
  assert.ok(['WAITING', 'BLOCKED', 'DECISION_REQUIRED', 'FINAL'].includes(recovery.yield.kind));
});

test('private CLI exposes only the explicit off, prefer, and require policy values', () => {
  const help = spawnSync(process.execPath, ['dist/bridge-cli.js', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--beads-evidence-copy off\|prefer\|require/);
  const invalid = spawnSync(process.execPath, ['dist/bridge-cli.js', '--beads-evidence-copy', 'automatic'], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must be off, prefer, or require/);
});
