#!/usr/bin/env node

import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRunArtifacts } from '../dist/run-body-migration.js';

const thisPath = fileURLToPath(import.meta.url);
const installed = thisPath.includes(`${sep}runtime${sep}tools${sep}`);
function absolute(value) { if (typeof value !== 'string' || resolve(value) !== value) throw new Error('run root must be absolute and canonical'); return value; }

export async function runArtifactAudit(argv = process.argv.slice(2)) {
  if (installed && globalThis[Symbol.for('lunacy.verified-retention-launch')] !== dirname(dirname(thisPath))) throw new Error('direct installed retention tool invocation is forbidden');
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('Usage: audit-run-artifacts --run-root ABSOLUTE\n'); return 0; }
  if (argv.length !== 2 || argv[0] !== '--run-root') throw new Error('audit-run-artifacts accepts only --run-root ABSOLUTE');
  process.stdout.write(`${JSON.stringify(await auditRunArtifacts(absolute(argv[1])))}\n`); return 0;
}

if (process.argv[1] && await import('node:fs/promises').then(({ realpath }) => realpath(process.argv[1]).catch(() => resolve(process.argv[1]))).then((path) => path === thisPath)) runArtifactAudit().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
