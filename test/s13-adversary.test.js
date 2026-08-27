import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BeadsPlanSource } from '../dist/beads.js';
import { transition } from '../dist/bridge.js';
import { canonicalString, digest } from '../dist/canonical.js';

const VERSION = '{"build":"6c124203e","commit":"6c124203e771433a3550c348771a5b5e27fd3c21","schema_version":1,"version":"1.2.2"}';

async function fixture(id = 'trusted', body = undefined) {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-s13-'));
  const workspace = join(root, 'workspace');
  const runDir = join(root, 'run');
  await mkdir(join(workspace, '.beads'), { recursive: true });
  await mkdir(runDir);
  const executablePath = join(root, 'bd');
  const script = body ?? `#!/bin/sh
if [ "$1" = version ]; then printf '%s' '${VERSION}'; else printf '%s\\n' '{"_type":"issue","id":"${id}","title":"${id}","status":"open","priority":0,"issue_type":"task"}'; fi
`;
  await writeFile(executablePath, script);
  await chmod(executablePath, 0o755);
  const expectedBinaryDigest = createHash('sha256').update(await readFile(executablePath)).digest('hex');
  const source = new BeadsPlanSource({ executablePath, workspace, expectedBinaryDigest });
  return { root, workspace, runDir, executablePath, source };
}

function acknowledgement(capture) {
  return {
    snapshotDigest: capture.snapshot.contentDigest,
    targetPlanDigest: digest(capture.plan),
    workspaceIdentity: capture.snapshot.workspaceIdentity,
    bdCommit: capture.snapshot.bdCommit,
    binaryDigest: capture.snapshot.binaryDigest,
  };
}

test('macOS pathname executable cannot be rewritten through leaked fd 3', async () => {
  // Before S13, the macOS branch passed the O_WRONLY construction descriptor
  // as fd 3.  This trusted-looking probe rewrites that inode after `version`;
  // `export` then exits 99 if the write reached the executable image.
  const fixtureData = await fixture('trusted', `#!/bin/sh
if [ "$1" = version ]; then
  (printf '#!/bin/sh\\nexit 99\\n' >&3) 2>/dev/null || true
  printf '%s' '${VERSION}'
else
  printf '%s\\n' '{"_type":"issue","id":"trusted","title":"trusted","status":"open","priority":0,"issue_type":"task"}'
fi
`);
  const capture = await fixtureData.source.capture();
  assert.equal(capture.snapshot.issues[0].sourceId, 'trusted');
});

test('native START digest replays through the bound Beads candidate after epoch drift', async () => {
  const fixtureData = await fixture();
  const capture = await fixtureData.source.capture();
  const nativePlan = { ...capture.plan };
  delete nativePlan.authorityDigest;
  const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(nativePlan) } };
  const options = { runDir: fixtureData.runDir, runId: 's13-native-replay', mode: 'runtime', plan: nativePlan };
  const first = await transition({ ...options, beads: { mode: 'active', source: fixtureData.source, acknowledgement: acknowledgement(capture) } }, { event, eventId: 'start' });

  // Re-capture the same source on a later ordinary event.  The candidate file
  // must retain the START replay binding instead of being overwritten by this
  // later event's identity.
  await transition({ ...options, plan: undefined, beads: { mode: 'active', source: fixtureData.source } }, {
    event: { kind: 'OBSERVATION', category: 'HOST', ref: { id: 'host', scope: 'test', digest: digest({ host: true }), bytes: '{"host":true}' } },
    eventId: 'host',
    expectedRevision: first.yield.snapshot.revision,
  });

  const changed = structuredClone(first.yield.snapshot);
  changed.attemptEpoch += 1;
  changed.barrierEpoch += 1;
  const { FileArtifactStore } = await import('../dist/store.js');
  const store = new FileArtifactStore(fixtureData.runDir);
  const loaded = await store.load();
  await store.commit(loaded.generation, { ...loaded.state, attemptEpoch: changed.attemptEpoch, barrierEpoch: changed.barrierEpoch });

  fixtureData.source.capture = async () => { throw new Error('live bd must not be consulted for replay'); };
  const wrongRetryPlan = { phaseId: nativePlan.phaseId, steps: [{ stepId: 'ignored', goal: 'ignored' }] };
  const replay = await transition({ ...options, plan: wrongRetryPlan, beads: { mode: 'active', source: fixtureData.source } }, { event, eventId: 'start' });
  assert.equal(canonicalString(replay.yield), canonicalString(first.yield));
});
