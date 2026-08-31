#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';

const EXIT = Object.freeze({
  zeroSelection: 65,
  skippedOnly: 66,
  missingTestFile: 67,
  missingImportedModule: 68,
  syntaxOrImportParseFailure: 69,
  tapParseFailure: 70,
  executedAssertionNameMismatch: 71,
  wrapperDigestMismatch: 72,
});

function argsOf(values) {
  const out = new Map();
  for (let i = 0; i < values.length; i += 1) {
    const key = values[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    if (key === '--self-test' || key === '--require-executed' || key === '--forbid-skipped-only') out.set(key, key === '--require-executed' && values[i + 1] && !values[i + 1].startsWith('--') ? values[++i] : true);
    else {
      const value = values[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${key}`);
      out.set(key, value);
    }
  }
  return out;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function ownDigest() { return sha256(await readFile(new URL(import.meta.url))); }
function runNode(argv, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => resolve({ code: 127, stdout: '', stderr: String(error) }));
    child.on('close', (code) => resolve({ code: code ?? 127, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}

function tapAssertions(tap) {
  if (typeof tap !== 'string' || !/^TAP version 13$/m.test(tap) || !/^1\.\.[0-9]+$/m.test(tap)) return undefined;
  const lines = tap.split(/\r?\n/); const rows = [];
  for (const line of lines) {
    const match = /^\s*(not )?ok\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/i.exec(line);
    if (!match) continue;
    const name = match[2].trim();
    if (name.startsWith('/')) continue;
    rows.push({ name, failed: Boolean(match[1]), skipped: Boolean(match[3]) });
  }
  return rows;
}

async function classify({ pattern, expectedName, file, wrapperSha256File, resultReceipt, requireExecuted = 1, checkDigest = true }) {
  if (checkDigest) {
    let expectedDigest;
    try { expectedDigest = (await readFile(wrapperSha256File, 'utf8')).trim(); } catch { return EXIT.wrapperDigestMismatch; }
    if (expectedDigest !== await ownDigest()) return EXIT.wrapperDigestMismatch;
  }
  try { await readFile(file); } catch { return EXIT.missingTestFile; }
  const result = await runNode(['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, file]);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/.test(combined)) return EXIT.missingImportedModule;
  if (/SyntaxError|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_DIR_IMPORT/.test(combined)) return EXIT.syntaxOrImportParseFailure;
  const assertions = tapAssertions(result.stdout);
  if (!assertions) return EXIT.tapParseFailure;
  const named = assertions.filter((row) => row.name === expectedName);
  if (named.length === 0) return EXIT.zeroSelection;
  const executed = assertions.filter((row) => !row.skipped && !row.name.startsWith('test at '));
  if (named.every((row) => row.skipped)) return EXIT.skippedOnly;
  const executedNames = [...new Set(executed.map((row) => row.name))];
  if (!executedNames.includes(expectedName) || executedNames.some((name) => name !== expectedName) || executedNames.length < requireExecuted) return EXIT.executedAssertionNameMismatch;
  if (result.code !== 0 && result.code !== 1) return EXIT.tapParseFailure;
  const receipt = {
    schema: 'checked-filter-result/v1', wrapperSha256: await ownDigest(), requestedPattern: pattern,
    requestedAssertionName: expectedName, testFile: file, executedNonSkippedNames: executedNames,
    underlyingExit: result.code, classification: result.code === 1 ? 'behavioral-failure' : 'pass',
  };
  if (resultReceipt) await writeFile(resultReceipt, `${JSON.stringify(receipt)}\n`, { flag: 'wx' });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  return result.code;
}

async function selfTest(options) {
  const expected = options.get('--expected-wrapper-sha256'); const actual = await ownDigest();
  const receipt = options.get('--self-test-receipt');
  if (expected !== actual) return EXIT.wrapperDigestMismatch;
  const root = await mkdtemp(join(tmpdir(), 'lunacy-filter-selftest-'));
  try {
    const pass = join(root, 'pass.test.mjs');
    const failure = join(root, 'failure.test.mjs');
    const skipped = join(root, 'skipped.test.mjs');
    const missingImport = join(root, 'missing-import.test.mjs');
    const syntax = join(root, 'syntax.test.mjs');
    await writeFile(pass, "import test from 'node:test'; test('target',()=>{}); test('other',()=>{});\n");
    await writeFile(failure, "import test from 'node:test'; import assert from 'node:assert/strict'; test('target',()=>assert.fail('red'));\n");
    await writeFile(skipped, "import test from 'node:test'; test.skip('target',()=>{});\n");
    await writeFile(missingImport, "import './does-not-exist.mjs';\n");
    await writeFile(syntax, "import test from 'node:test'; test('target',()=>{;\n");
    const common = { pattern: '^target$', expectedName: 'target', checkDigest: false };
    const cases = {
      exactNamedPass: await classify({ ...common, file: pass }),
      exactNamedBehavioralFailure: await classify({ ...common, file: failure }),
      zeroSelection: await classify({ pattern: '^absent$', expectedName: 'absent', file: pass, checkDigest: false }),
      skippedOnly: await classify({ ...common, file: skipped }),
      missingTestFile: await classify({ ...common, file: join(root, 'missing.test.mjs') }),
      missingImportedModule: await classify({ ...common, file: missingImport }),
      syntaxOrImportParseFailure: await classify({ ...common, file: syntax }),
      tapParseFailure: tapAssertions('not tap') === undefined ? EXIT.tapParseFailure : 0,
      executedAssertionNameMismatch: await classify({ pattern: '.*', expectedName: 'target', file: pass, checkDigest: false }),
      wrapperDigestMismatch: expected === `${actual.slice(0, 63)}${actual.endsWith('0') ? '1' : '0'}` ? 0 : EXIT.wrapperDigestMismatch,
    };
    const expectedCases = { exactNamedPass: 0, exactNamedBehavioralFailure: 1, zeroSelection: 65, skippedOnly: 66, missingTestFile: 67, missingImportedModule: 68, syntaxOrImportParseFailure: 69, tapParseFailure: 70, executedAssertionNameMismatch: 71, wrapperDigestMismatch: 72 };
    if (JSON.stringify(cases) !== JSON.stringify(expectedCases)) {
      process.stderr.write(`${JSON.stringify({ cases, expectedCases })}\n`);
      return 74;
    }
    await writeFile(receipt, `${JSON.stringify({ schema: 'checked-filter-self-test/v1', wrapperPath: 'test/fixtures/run-filtered-test.mjs', wrapperSha256: actual, cases })}\n`, { flag: 'wx' });
    return 0;
  } finally { await rm(root, { recursive: true, force: true }); }
}

let code = 64;
try {
  const options = argsOf(process.argv.slice(2));
  if (options.has('--self-test')) code = await selfTest(options);
  else code = await classify({
    pattern: options.get('--pattern'), expectedName: options.get('--expected-assertion-name'), file: options.get('--file'),
    wrapperSha256File: options.get('--wrapper-sha256-file'), resultReceipt: options.get('--result-receipt'),
    requireExecuted: Number(options.get('--require-executed') ?? 1),
  });
} catch (error) { process.stderr.write(`${basename(process.argv[1])}: ${error instanceof Error ? error.message : String(error)}\n`); code = 64; }
process.exitCode = code;
