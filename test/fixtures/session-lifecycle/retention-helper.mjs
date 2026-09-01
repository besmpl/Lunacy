import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalString, digest, digestBytes } from '../../../dist/canonical.js';

export const syntheticPlatform = Object.freeze({
  async captureMountIdentity(root) { return { schema: 'lunacy-retention-mounts/v1', platform: process.platform === 'linux' ? 'linux' : 'darwin', digest: 'a'.repeat(64), mountPoints: ['/'] }; },
  async captureRunSealQuiescence(_runtime, _run, _body) { return { schema: 'lunacy-run-quiescence/v1', digest: 'b'.repeat(64), openHandles: 0, publicationGate: 'REQUIRED_ZERO_HANDLES', platform: process.platform === 'linux' ? 'linux' : 'darwin', inspectedProcesses: 0 }; },
});

export async function retentionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'lunacy-retention-')); const runRoot = join(root, 'run'); await mkdir(join(runRoot, '.work/nested'), { recursive: true });
  const files = { 'PLAN.md': '# Plan\n', 'STATE.md': '# State\nstatus: COMPLETE\n', 'OUTCOME.md': '# Outcome\nPASS\n' };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(runRoot, name), bytes);
  await writeFile(join(runRoot, '.work/output.log'), 'raw output'); await writeFile(join(runRoot, '.work/nested/proof.txt'), 'proof');
  await mkdir(join(runRoot, '.kernel')); await writeFile(join(runRoot, '.kernel/CURRENT'), 'custody-current'); await mkdir(join(runRoot, '.codex-effects')); await writeFile(join(runRoot, '.codex-effects/token'), 'custody-effect'); await writeFile(join(runRoot, 'unknown.txt'), 'unknown');
  const productBytes = await readFile(resolve('package.json')); const resultIdentity = { kind: 'manifest', schema: 'lunacy-product-manifest/v1', roots: ['package.json'], entries: [{ path: 'package.json', digest: digestBytes(productBytes) }] };
  const authorityDigest = digest([{ path: 'PLAN.md', digest: digestBytes(Buffer.from(files['PLAN.md'])) }]);
  const acceptance = { schema: 'lunacy-parent-acceptance/v1', runId: 'fixture-run', disposition: 'ACCEPTED', activeWorkers: 'NONE', authorityDigest, outcomeDigest: digestBytes(Buffer.from(files['OUTCOME.md'])), terminalStateDigest: digestBytes(Buffer.from(files['STATE.md'])), resultIdentity, resultIdentityDigest: digest(resultIdentity) };
  const acceptanceSource = join(root, 'acceptance.json'); await writeFile(acceptanceSource, canonicalString(acceptance));
  return { root, runRoot, acceptanceSource, acceptance };
}
