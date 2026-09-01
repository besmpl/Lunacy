import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalString, digest, parseCanonical } from '../dist/canonical.js';
import { classifyRetentionSnapshot, validateFinalizationMarker, validateParentAcceptance, validateRunReceipt } from '../dist/run-retention.js';

const sha = (char) => char.repeat(64);
const resultIdentity = { kind: 'commit', root: '/workspace', oid: 'a'.repeat(40) };
const acceptance = { schema: 'lunacy-parent-acceptance/v1', runId: 'run', disposition: 'ACCEPTED', activeWorkers: 'NONE', authorityDigest: sha('1'), outcomeDigest: sha('2'), terminalStateDigest: sha('3'), resultIdentity, resultIdentityDigest: digest(resultIdentity) };
const runtimeAcceptance = { schema: 'lunacy-runtime-acceptance/v1', runId: 'run', candidate: { schema: 'lunacy-runtime-acceptance-candidate/v1', runId: 'run', prePass: { generation: 2, revision: 4, stateDigest: sha('b') }, gate: { token: 'gate', eventDigest: sha('c'), eventIdentityDigest: sha('d') }, activeWorkers: 'NONE', authorityDigest: sha('1'), outcomeDigest: sha('2'), resultIdentity, resultIdentityDigest: digest(resultIdentity) }, passRecord: { revision: 5, eventDigest: sha('c'), eventIdentityDigest: sha('d') }, terminal: { generation: 3, stateDigest: sha('3') } };
const receipt = { schema: 'lunacy-run-receipt/v1', runId: 'run', disposition: 'ACCEPTED', authorityDigest: sha('1'), seedDigest: sha('4'), terminalStateDigest: sha('3'), quiescence: { schema: 'lunacy-run-quiescence/v1', digest: sha('5'), openHandles: 0, publicationGate: 'REQUIRED_ZERO_HANDLES' }, outcome: { path: 'OUTCOME.md', digest: sha('2') }, acceptance: { kind: 'manual-parent/v1', digest: digest(acceptance), witness: acceptance }, resultIdentity, body: { root: '.work', treeDigest: sha('6'), files: 2, bytes: 8, action: 'PRUNE' } };
const runtimeReceipt = { ...receipt, acceptance: { kind: 'runtime-pass/v1', digest: digest(runtimeAcceptance), witness: runtimeAcceptance } };
const marker = { schema: 'lunacy-run-finalization/v1', runId: 'run', receiptDigest: sha('7'), disposition: 'ACCEPTED', receiptPath: 'RUN-RECEIPT.json', acceptanceDigest: digest(acceptance), authorityDigest: sha('1'), resultIdentityDigest: digest(resultIdentity), quiescenceDigest: sha('5'), acceptanceInput: { path: '.lunacy-parent-acceptance.json', dev: '1', ino: '2', digest: sha('8') }, stagedReceipt: { path: '.RUN-RECEIPT.json.tmp', dev: '1', ino: '3', digest: sha('7') }, body: { sourcePath: '.work', dev: '1', ino: '4', treeDigest: sha('6') }, tombstonePath: `.work.prune-${sha('7')}`, cleanupEntries: [{ relativePath: '.', dev: '1', ino: '4', mode: 448 }, { relativePath: 'a.txt', dev: '1', ino: '5', mode: 384, size: 8, digest: sha('9') }, { relativePath: 'nested', dev: '1', ino: '6', mode: 448 }] };
const abandonmentMarker = { ...marker, disposition: 'ABANDONED', receiptPath: 'ABANDON-RECEIPT.json', resultIdentityDigest: sha('0'), acceptanceInput: { ...marker.acceptanceInput, path: '.lunacy-parent-abandonment.json' }, stagedReceipt: { ...marker.stagedReceipt, path: '.ABANDON-RECEIPT.json.tmp' } };
const empty = { body: 'ABSENT', receipt: 'ABSENT', abandonmentReceipt: 'ABSENT', marker: 'ABSENT', stagedReceipt: 'ABSENT', tombstone: 'ABSENT', acceptanceInput: 'ABSENT' };

test('private retention records are closed and cross-bind exact canonical identities', async () => {
  assert.deepEqual(validateParentAcceptance(acceptance), acceptance); assert.deepEqual(validateRunReceipt(receipt), receipt); assert.deepEqual(validateRunReceipt(runtimeReceipt), runtimeReceipt); assert.deepEqual(validateFinalizationMarker(marker), marker); assert.deepEqual(validateFinalizationMarker(abandonmentMarker), abandonmentMarker);
  for (const value of [{ ...acceptance, extra: true }, { ...acceptance, resultIdentityDigest: sha('0') }, { ...acceptance, activeWorkers: 'ONE' }]) assert.throws(() => validateParentAcceptance(value));
  assert.throws(() => validateRunReceipt({ ...receipt, authorityDigest: sha('0') }), /disagrees/);
  assert.throws(() => validateRunReceipt({ ...receipt, acceptance: { ...receipt.acceptance, kind: 'runtime-pass/v1' } }), /kind disagrees/);
  assert.throws(() => validateRunReceipt({ ...runtimeReceipt, acceptance: { ...runtimeReceipt.acceptance, kind: 'manual-parent/v1' } }), /kind disagrees/);
  assert.throws(() => validateFinalizationMarker({ ...marker, tombstonePath: '.work.prune-unsafe' }));
  assert.throws(() => validateFinalizationMarker({ ...marker, acceptanceInput: { ...marker.acceptanceInput, path: '.arbitrary-acceptance.json' } }), /acceptance input path/);
  assert.throws(() => validateFinalizationMarker({ ...marker, stagedReceipt: { ...marker.stagedReceipt, path: '.arbitrary-receipt.tmp' } }), /staged receipt path/);
  assert.throws(() => validateFinalizationMarker({ ...abandonmentMarker, acceptanceInput: { ...abandonmentMarker.acceptanceInput, path: '.arbitrary-abandonment.json' } }), /abandonment input path/);
  assert.throws(() => validateFinalizationMarker({ ...abandonmentMarker, stagedReceipt: { ...abandonmentMarker.stagedReceipt, path: '.arbitrary-abandonment.tmp' } }), /staged abandonment receipt path/);
  assert.throws(() => parseCanonical(` ${canonicalString(acceptance)}`), /non-canonical/);
  assert.equal((await import('../dist/index.js')).validateRunReceipt, undefined);
});

test('closed classifier maps every R1 state and sends ambiguity to attention', () => {
  const code = (overrides) => classifyRetentionSnapshot({ ...empty, ...overrides }).code;
  assert.equal(code({}), 'LEGACY_LAYOUT'); assert.equal(code({ body: 'VALID' }), 'BODY_ACTIVE'); assert.equal(code({ body: 'VALID', acceptanceInput: 'VALID' }), 'READY_TO_SEAL'); assert.equal(code({ body: 'VALID', stagedReceipt: 'VALID' }), 'BODY_ACTIVE'); assert.equal(code({ body: 'VALID', stagedReceipt: 'VALID', acceptanceInput: 'VALID' }), 'READY_TO_SEAL'); assert.equal(code({ body: 'VALID', marker: 'VALID', stagedReceipt: 'VALID' }), 'RESUME_PRE_RENAME'); assert.equal(code({ marker: 'VALID', stagedReceipt: 'VALID', tombstone: 'VALID' }), 'RESUME_PRE_PUBLISH'); assert.equal(code({ marker: 'VALID', receipt: 'VALID', tombstone: 'VALID' }), 'RESUME_CLEANUP'); assert.equal(code({ marker: 'VALID', receipt: 'VALID' }), 'RESUME_CLEANUP'); assert.equal(code({ receipt: 'VALID' }), 'SEALED_CLEAN');
  assert.equal(code({ unsafePath: true }), 'ATTENTION_UNSAFE_PATH'); assert.equal(code({ identityDrift: true }), 'ATTENTION_IDENTITY_DRIFT'); assert.equal(code({ custodyCollision: true }), 'ATTENTION_CUSTODY'); assert.equal(code({ inconsistentRead: true }), 'INCONSISTENT_READ'); assert.equal(code({ body: 'INVALID' }), 'ATTENTION_UNKNOWN_COMBINATION'); assert.equal(code({ receipt: 'VALID', body: 'VALID' }), 'ATTENTION_UNKNOWN_COMBINATION');
});
