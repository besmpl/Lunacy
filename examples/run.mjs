import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(root, '..', 'dist', 'cli.js'), '--plan', join(root, 'canonical-plan.json'), '--event', join(root, 'canonical-event.json')], { stdio: 'inherit' });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
