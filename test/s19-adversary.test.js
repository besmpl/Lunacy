import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}';

test('pathname Beads snapshots are removed after a successful capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s19-cleanup-'));
  const captureTmp = await mkdtemp(join(root, 'capture-tmp-'));
  const workspace = join(captureTmp, 'workspace');
  const beads = join(workspace, '.beads');
  const executablePath = join(captureTmp, 'bd');
  try {
    await mkdir(beads, { recursive: true });
    const issue = JSON.stringify({ _type: 'issue', id: 'cleanup', title: 'cleanup', status: 'open', priority: 0, issue_type: 'task' });
    await writeFile(executablePath, `#!/bin/sh\nif [ "$1" = version ]; then printf '%s' '${VERSION}'; exit 0; fi\nprintf '%s\\n' '${issue}'\n`);
    await chmod(executablePath, 0o755);
    const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
    // Run the capture in a child with an isolated TMPDIR.  Other test files
    // exercise Beads concurrently, so a parent-process directory diff would
    // mistake their in-flight snapshots for a cleanup failure.
    const script = `import { readdir } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { BeadsPlanSource } from './dist/beads.js'; const [executablePath, workspace, expectedBinaryDigest] = process.argv.slice(1); const before = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith('lunacy-beads-snapshot-'))); const source = new BeadsPlanSource({ executablePath, workspace, expectedBinaryDigest }); await source.capture(); const after = (await readdir(tmpdir())).filter((entry) => entry.startsWith('lunacy-beads-snapshot-')); const added = after.filter((entry) => !before.has(entry)); if (added.length !== 0) throw new Error('snapshot cleanup left ' + added.join(','));`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, executablePath, workspace, expectedBinaryDigest], { cwd: process.cwd(), env: { ...process.env, TMPDIR: captureTmp }, stdio: 'pipe' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
