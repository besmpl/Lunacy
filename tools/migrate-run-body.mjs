#!/usr/bin/env node

import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRunBody } from '../dist/run-body-migration.js';

const thisPath = fileURLToPath(import.meta.url);
const installed = thisPath.includes(`${sep}runtime${sep}tools${sep}`);
function absolute(value) { if (typeof value !== 'string' || resolve(value) !== value) throw new Error('run root must be absolute and canonical'); return value; }

export async function runBodyMigration(argv = process.argv.slice(2)) {
  if (installed && globalThis[Symbol.for('lunacy.verified-retention-launch')] !== dirname(dirname(thisPath))) throw new Error('direct installed retention tool invocation is forbidden');
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('Usage: migrate-run-body --run-root ABSOLUTE --accept\n'); return 0; }
  if (argv.length !== 3 || argv[0] !== '--run-root' || argv[2] !== '--accept') throw new Error('migrate-run-body accepts only --run-root ABSOLUTE --accept');
  process.stdout.write(`${JSON.stringify(await migrateRunBody(absolute(argv[1])))}\n`); return 0;
}

if (process.argv[1] && await import('node:fs/promises').then(({ realpath }) => realpath(process.argv[1]).catch(() => resolve(process.argv[1]))).then((path) => path === thisPath)) runBodyMigration().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exitCode = 1; });
