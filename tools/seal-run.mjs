#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCanonical } from '../dist/canonical.js';
import { withRunAbandonmentPolicy } from '../dist/release-admission.js';
import { acceptRuntimePass, inspectRetentionRun, prepareManualAcceptance, prepareRunAbandonment, sealRetentionRun } from '../dist/run-retention.js';

const thisPath = fileURLToPath(import.meta.url);
const installed = thisPath.includes(`${sep}runtime${sep}tools${sep}`);
function absolute(value, label) { if (typeof value !== 'string' || resolve(value) !== value) throw new Error(`${label} must be absolute and canonical`); return value; }
function option(argv, name) { const index = argv.indexOf(name); if (index < 0 || index + 1 >= argv.length || argv.filter((item) => item === name).length !== 1) throw new Error(`${name} is required exactly once`); return argv[index + 1]; }

export async function runSealRun(argv = process.argv.slice(2)) {
  if (installed && globalThis[Symbol.for('lunacy.verified-retention-launch')] !== dirname(dirname(thisPath))) throw new Error('direct installed retention tool invocation is forbidden');
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: seal-run (--doctor|--dry-run|--accept|--resume) --run-root /absolute/run/root\n       seal-run --abandon --run-root ABSOLUTE --authority ABSOLUTE\n       seal-run --prepare-manual --run-root ABSOLUTE --acceptance ABSOLUTE\n       seal-run --accept-runtime-pass --inbox ABSOLUTE --plan ABSOLUTE --run-root ABSOLUTE --run-id ID --token TOKEN --event-id EVENT (--result-commit OID|--result-manifest ABSOLUTE)\n');
    return 0;
  }
  const modes = ['--doctor', '--dry-run', '--accept', '--abandon', '--resume', '--prepare-manual', '--accept-runtime-pass'].filter((mode) => argv.includes(mode)); if (modes.length !== 1) throw new Error('exactly one seal-run mode is required');
  const runRoot = absolute(option(argv, '--run-root'), 'run root'); const mode = modes[0];
  if (mode === '--doctor') { if (argv.length !== 3) throw new Error('doctor accepts only --run-root'); process.stdout.write(`${JSON.stringify(await inspectRetentionRun(runRoot))}\n`); return 0; }
  if (mode === '--prepare-manual') { if (argv.length !== 5) throw new Error('manual preparation accepts only --run-root and --acceptance'); const acceptance = absolute(option(argv, '--acceptance'), 'acceptance'); process.stdout.write(`${JSON.stringify(await prepareManualAcceptance(runRoot, acceptance))}\n`); return 0; }
  if (mode === '--abandon') { if (argv.length !== 5) throw new Error('abandon accepts only --run-root and --authority'); const authority = absolute(option(argv, '--authority'), 'authority'); const installedRuntime = installed ? dirname(dirname(thisPath)) : resolve('.'); const operation = async () => { await prepareRunAbandonment(runRoot, authority); return sealRetentionRun(runRoot, { mode: 'abandon', installedRuntime }); }; const result = installed ? await withRunAbandonmentPolicy(installedRuntime, undefined, operation) : await operation(); process.stdout.write(`${JSON.stringify(result)}\n`); return 0; }
  if (mode === '--accept-runtime-pass') {
    const inboxPath = absolute(option(argv, '--inbox'), 'inbox'); const planPath = absolute(option(argv, '--plan'), 'plan'); const runId = option(argv, '--run-id'); const token = option(argv, '--token'); const eventId = option(argv, '--event-id'); const commit = argv.includes('--result-commit') ? option(argv, '--result-commit') : undefined; const manifestPath = argv.includes('--result-manifest') ? absolute(option(argv, '--result-manifest'), 'result manifest') : undefined;
    if (Boolean(commit) === Boolean(manifestPath)) throw new Error('exactly one result identity is required'); if (argv.length !== 15) throw new Error('runtime acceptance has unknown or duplicate options');
    const inbox = parseCanonical(await readFile(inboxPath, 'utf8')); const plan = parseCanonical(await readFile(planPath, 'utf8')); const resultIdentity = commit ? { kind: 'commit', root: resolve('.'), oid: commit } : parseCanonical(await readFile(manifestPath, 'utf8'));
    process.stdout.write(`${JSON.stringify(await acceptRuntimePass({ runRoot, runId, token, eventId, inbox, plan, resultIdentity }))}\n`); return 0;
  }
  if (argv.length !== 3) throw new Error(`${mode} accepts only --run-root`);
  const installedRuntime = installed ? dirname(dirname(thisPath)) : resolve('.'); const result = await sealRetentionRun(runRoot, { mode: mode === '--dry-run' ? 'dry-run' : mode === '--accept' ? 'accept' : 'resume', installedRuntime }); process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (process.argv[1] && await import('node:fs/promises').then(({ realpath }) => realpath(process.argv[1]).catch(() => resolve(process.argv[1]))).then((path) => path === thisPath)) runSealRun().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
