import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/canonical.js';
import {
  CHECK_CONTRACT_SCHEMA,
  WORKER_PROOF_SCHEMA,
  createCheckContract,
  createWorkerProof,
  decodeCheckContract,
  decodeWorkerProof,
  encodeCheckContract,
  encodeWorkerProof,
  verifyWorkerProof,
} from '../dist/codex-worker-proof.js';

const HASH = 'a'.repeat(64);
const NOW = '2025-01-01T00:00:00.000Z';
const EXPIRY = '2025-01-02T00:00:00.000Z';

function terminal(overrides = {}) {
  return {
    schema: 'lunacy-codex-terminal/v1', launchToken: 'proof-token', commandDigest: HASH,
    status: 'PASS', outcome: 'normal-completion', exitCode: 0, signal: null,
    resultDigest: null, reportPath: '/tmp/report.md', reportDigest: HASH,
    eventsDigest: HASH, finishedAt: NOW, ...overrides,
  };
}
function fixture() {
  const contract = createCheckContract({
    phaseId: 'phase-a', stepId: 'step-a', attemptEpoch: 3, expectedResult: 'PASS',
    producer: { kind: 'machine-checker', version: '1' },
    checks: [{ id: 'terminal-report', expected: 'PASS', evidence: ['report'] }],
    requiredEvidence: [{ id: 'report', digest: HASH, maxBytes: 4096, sensitivity: 'redacted' }],
    ceilings: { maxChecks: 4, maxEvidence: 4, maxEvidenceBytes: 8192, maxRecordBytes: 65536 }, expiresAt: EXPIRY,
  });
  const proof = createWorkerProof({
    contract, terminal: terminal(), checks: [{ id: 'terminal-report', result: 'PASS', evidence: ['report'] }],
    evidence: [{ id: 'report', digest: HASH, bytes: 20 }], createdAt: NOW,
  });
  return { contract, proof, terminal: terminal() };
}

test('closed contract/proof canonical bytes round-trip and certify only with terminal witness', () => {
  const { contract, proof, terminal: record } = fixture();
  assert.equal(contract.schema, CHECK_CONTRACT_SCHEMA);
  assert.equal(proof.schema, WORKER_PROOF_SCHEMA);
  assert.deepEqual(decodeCheckContract(encodeCheckContract(contract)), contract);
  assert.deepEqual(decodeWorkerProof(encodeWorkerProof(proof)), proof);
  assert.equal(verifyWorkerProof(contract, proof, { at: '2025-01-01T01:00:00.000Z', binding: { terminal: record } }), 'CERTIFIED');
  assert.equal(verifyWorkerProof(contract, proof, { at: '2025-01-01T01:00:00.000Z' }), 'ATTENTION:TERMINAL_EVIDENCE_MISSING');
});

test('tampered, stale, undeclared and failed evidence fail closed without throwing', () => {
  const { contract, proof, terminal: record } = fixture();
  const options = { at: '2025-01-01T01:00:00.000Z', binding: { terminal: record } };
  assert.equal(verifyWorkerProof(contract, { ...proof, contractDigest: digest({ ...contract, stepId: 'other' }) }, options), 'ATTENTION:CONTRACT_DIGEST_MISMATCH');
  assert.equal(verifyWorkerProof(contract, { ...proof, checks: [{ ...proof.checks[0], result: 'FAIL' }] }, options), 'ATTENTION:CHECK_RESULT_NOT_PASS');
  assert.equal(verifyWorkerProof(contract, { ...proof, evidence: [{ id: 'extra', digest: HASH, bytes: 1 }] }, options), 'ATTENTION:EVIDENCE_UNDECLARED');
  assert.equal(verifyWorkerProof(contract, { ...proof, diffDigest: 'b'.repeat(64) }, options), 'ATTENTION:EVIDENCE_UNDECLARED');
  assert.equal(verifyWorkerProof(contract, { ...proof, artifactDigests: ['b'.repeat(64)] }, options), 'ATTENTION:EVIDENCE_UNDECLARED');
  assert.equal(verifyWorkerProof(contract, proof, { at: EXPIRY, binding: { terminal: record } }), 'ATTENTION:EXPIRED');
  assert.equal(verifyWorkerProof(contract, proof, { at: 'not-a-time', binding: { terminal: record } }), 'ATTENTION:INVALID_TIME');
  assert.equal(verifyWorkerProof(contract, proof, null), 'ATTENTION:INVALID_TIME');
  assert.equal(verifyWorkerProof(contract, proof, { at: '2025-01-01T01:00:00.000Z', binding: { terminal: terminal({ reportDigest: 'b'.repeat(64) }) } }), 'ATTENTION:TERMINAL_EVIDENCE_MISMATCH');
  assert.equal(verifyWorkerProof(contract, { ...proof, evidence: [{ id: 'report', digest: HASH, bytes: 4097 }] }, options), 'ATTENTION:EVIDENCE_MISMATCH');
  assert.equal(verifyWorkerProof({ ...contract, unexpected: true }, proof, options), 'ATTENTION:MALFORMED_CONTRACT');
});

test('codec rejects unknown fields, duplicate ids and non-canonical bytes', () => {
  const { contract, proof } = fixture();
  assert.throws(() => decodeCheckContract(encodeCheckContract({ ...contract, extra: true })), /closed/);
  assert.throws(() => decodeWorkerProof(`${encodeWorkerProof(proof).slice(0, -1)},\"extra\":true}`), /non-canonical|closed/);
  assert.throws(() => createCheckContract({ ...contract, checks: [{ ...contract.checks[0] }, { ...contract.checks[0] }] }), /unique/);
  assert.throws(() => decodeWorkerProof(new Uint8Array([0xc3, 0x28])), /UTF-8|JSON/);
});
