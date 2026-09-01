import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

async function runFixture() { const root = await mkdtemp(join(tmpdir(), 'lunacy-body-writer-test-')); const run = join(root, 'run'); await mkdir(join(run, '.work'), { recursive: true }); return { root, run }; }
function invoke(run, destination, script) { return spawnSync(process.execPath, ['tools/with-body-writer.mjs', '--run-root', run, '--destination', destination, '--', process.execPath, '-e', script], { cwd: resolve('.'), encoding: 'utf8' }); }

test('supported writer captures external child output then claimed-publishes one complete Body file', async () => {
  const fixture = await runFixture(); const result = invoke(fixture.run, 'logs/output.txt', `process.stdout.write('x'.repeat(1024 * 1024))`); assert.equal(result.status, 0, result.stderr); assert.equal((await readFile(join(fixture.run, '.work/logs/output.txt'))).length, 1024 * 1024); assert.equal((await readdir(join(fixture.run, '.work/logs'))).some((name) => name.endsWith('.tmp')), false);
  const collision = invoke(fixture.run, 'logs/output.txt', `process.stdout.write('replacement')`); assert.notEqual(collision.status, 0); assert.equal((await readFile(join(fixture.run, '.work/logs/output.txt'))).length, 1024 * 1024);
});

test('failed child never opens or publishes a Body destination', async () => {
  const fixture = await runFixture(); const result = invoke(fixture.run, 'failure.txt', `process.stdout.write('partial'); process.exit(7)`); assert.equal(result.status, 7); await assert.rejects(() => readFile(join(fixture.run, '.work/failure.txt')));
});

test('writer refuses symlinked destination parents', async (context) => {
  const fixture = await runFixture(); const outside = join(fixture.root, 'outside'); await mkdir(outside); try { await import('node:fs/promises').then(({ symlink }) => symlink(outside, join(fixture.run, '.work/link'))); } catch (error) { context.skip(`symlink unavailable: ${error.message}`); return; }
  const result = invoke(fixture.run, 'link/escaped.txt', `process.stdout.write('no')`); assert.notEqual(result.status, 0); await assert.rejects(() => readFile(join(outside, 'escaped.txt')));
});
