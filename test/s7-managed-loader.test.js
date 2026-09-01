import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalString } from '../dist/canonical.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function normalizeLauncher(source) {
  let normalized = source;
  for (const [name, marker] of [['MANIFEST', '__LUNACY_MANIFEST_DIGEST__'], ['LAUNCHER', '__LUNACY_LAUNCHER_DIGEST__']]) {
    const pattern = new RegExp(`(^const EXPECTED_${name}_DIGEST = ")([0-9a-f]{64})(";)$`, 'm');
    const next = normalized.replace(pattern, `$1${marker}$3`);
    assert.notEqual(next, normalized, `launcher ${name.toLowerCase()} digest literal is present`);
    normalized = next;
  }
  return Buffer.from(normalized);
}

async function sourceFixture() {
  const repo = await mkdtemp(join(tmpdir(), 'lunacy-s7-loader-repo-'));
  for (const name of ['assets', 'dist', 'docs', 'schemas', 'tools']) await cp(join(root, name), join(repo, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) await cp(join(root, name), join(repo, name));
  await mkdir(join(repo, 'dist', 'synthetic'), { recursive: true });
  const canaryMarker = join(repo, 's7-canary-evaluated');
  await writeFile(join(repo, 'dist', 'synthetic', 'canary.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(canaryMarker)}, 'evaluated');\nexport const canary = true;\n`);
  return { repo, canaryMarker };
}

function runDeploy(repo, target, ...args) {
  return spawnSync(process.execPath, ['tools/deploy-skill.mjs', '--target', target, ...args], { cwd: repo, encoding: 'utf8' });
}

async function rebindLauncher(target, edit) {
  const launcherPath = join(target, 'runtime', 'bridge.mjs');
  const manifestPath = join(target, 'runtime', 'DEPLOYMENT.json');
  let launcher = edit(await readFile(launcherPath, 'utf8'));
  const launcherDigest = hash(normalizeLauncher(launcher));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.launcherDigest = launcherDigest;
  const manifestBytes = Buffer.from(`${canonicalString(manifest)}\n`);
  const manifestDigest = hash(manifestBytes);
  launcher = launcher
    .replace(/(^const EXPECTED_MANIFEST_DIGEST = ")[0-9a-f]{64}(";$)/m, `$1${manifestDigest}$2`)
    .replace(/(^const EXPECTED_LAUNCHER_DIGEST = ")[0-9a-f]{64}(";$)/m, `$1${launcherDigest}$2`);
  await writeFile(manifestPath, manifestBytes);
  await writeFile(launcherPath, launcher);
  return { launcherPath, manifestPath };
}

async function runtimeDigests(target) {
  const files = [];
  async function collect(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path, relative);
      else {
        assert.equal(entry.isSymbolicLink(), false, `managed file is not a symlink: ${relative}`);
        files.push([relative, hash(await readFile(path))]);
      }
    }
  }
  await collect(join(target, 'runtime'), 'runtime');
  return files;
}

test('managed graph rejects mixed-case absolute URLs and chain-produced graph URLs before canary evaluation', async () => {
  const fixture = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-s7-loader-target-'));
  const probeMarker = join(target, 'probe-marker');
  const chainLog = join(target, 'chain-log.json');
  try {
    const deployed = runDeploy(fixture.repo, target);
    assert.equal(deployed.status, 0, deployed.stderr);
    await rebindLauncher(target, (launcher) => {
      const injection = `  return (async () => {\n    for (const [name, specifier] of [["upper", "LUNACY:///dist/synthetic/canary.js"], ["entry", "LUNACY:///dist/bridge-cli.js"], ["chain", "host-alias"]]) {\n      try { await import(specifier); await fs.writeFile(${JSON.stringify(probeMarker)}, "executed:" + name); }\n      catch { await fs.writeFile(${JSON.stringify(probeMarker)} + "." + name, "rejected"); }\n    }\n    return import(ENTRY_URL).then((module) => module.runBridgeCli());\n  })();`;
      const marker = '  return import(ENTRY_URL).then((module) => module.runBridgeCli());';
      assert.equal(launcher.split(marker).length, 2, 'launcher entry seam must remain unique');
      return launcher.replace(marker, injection);
    });
    const preloadPath = join(target, 'preload.mjs');
    await writeFile(preloadPath, `import { registerHooks } from 'node:module';\nimport { writeFileSync } from 'node:fs';\nconst seen = [];\nregisterHooks({ resolve(specifier, context, nextResolve) {\n  if (specifier === 'host-alias') return { url: 'lunacy:///dist/synthetic/canary.js', shortCircuit: true };\n  if (specifier.toLowerCase().startsWith('lunacy:')) seen.push(specifier);\n  return nextResolve(specifier, context);\n} });\nprocess.on('exit', () => writeFileSync(${JSON.stringify(chainLog)}, JSON.stringify(seen)));\n`);
    const result = spawnSync(process.execPath, ['--import', preloadPath, join(target, 'runtime', 'bridge.mjs'), '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: lunacy-bridge/);
    assert.equal(await readFile(fixture.canaryMarker, 'utf8').catch(() => undefined), undefined, 'outside URL attempts evaluated the canary');
    assert.equal(await readFile(probeMarker, 'utf8').catch(() => undefined), undefined, 'a rejected graph URL was marked as evaluated');
    assert.equal(await readFile(`${probeMarker}.upper`, 'utf8'), 'rejected');
    assert.equal(await readFile(`${probeMarker}.entry`, 'utf8'), 'rejected');
    assert.equal(await readFile(`${probeMarker}.chain`, 'utf8'), 'rejected');
    assert.deepEqual(JSON.parse(await readFile(chainLog, 'utf8')), [], 'mixed-case URL reached the prior resolver');
  } finally {
    await rm(fixture.repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('deployment check requires exact manifest bytes and redeploy is deterministic', async () => {
  const fixture = await sourceFixture();
  const target = await mkdtemp(join(tmpdir(), 'lunacy-s7-deploy-target-'));
  try {
    let result = runDeploy(fixture.repo, target);
    assert.equal(result.status, 0, result.stderr);
    result = runDeploy(fixture.repo, target, '--check');
    assert.equal(result.status, 0, result.stderr);
    const first = await runtimeDigests(target);
    await writeFile(join(target, 'runtime', 'DEPLOYMENT.json'), `${await readFile(join(target, 'runtime', 'DEPLOYMENT.json'), 'utf8')}\n`);
    result = runDeploy(fixture.repo, target, '--check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest bytes do not match canonical source/);
    result = spawnSync(process.execPath, [join(target, 'runtime', 'bridge.mjs'), '--help'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fingerprint|trusted release/);
    result = runDeploy(fixture.repo, target);
    assert.equal(result.status, 0, result.stderr);
    result = runDeploy(fixture.repo, target, '--check');
    assert.equal(result.status, 0, result.stderr);
    const second = await runtimeDigests(target);
    assert.deepEqual(second, first);
    result = runDeploy(fixture.repo, target);
    assert.equal(result.status, 0, result.stderr);
    result = runDeploy(fixture.repo, target, '--check');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await runtimeDigests(target), first);
  } finally {
    await rm(fixture.repo, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
