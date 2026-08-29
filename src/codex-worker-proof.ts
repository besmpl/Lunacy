import type { Sha256, Ref } from './model.js';
import { canonicalString, digest, parseCanonical } from './canonical.js';
import {
  validateLaunchRecord,
  validateTerminalRecord,
  type LaunchRecord,
  type TerminalRecord,
} from './codex-effect-records.js';

/**
 * Private evidence contracts for the proof-only continuation route.  These
 * records are deliberately not exported from the package root.  They carry
 * evidence, never a kernel event or a worker instruction.
 */
export const CHECK_CONTRACT_SCHEMA = 'lunacy-check-contract/v1' as const;
export const WORKER_PROOF_SCHEMA = 'lunacy-worker-proof/v1' as const;
export const CHECK_CONTRACT_VERSION = 1 as const;
export const WORKER_PROOF_VERSION = 1 as const;

/** Hard ceilings are part of the codec, rather than a caller convention. */
export const MAX_CHECK_CONTRACT_BYTES = 64 * 1024;
export const MAX_WORKER_PROOF_BYTES = 256 * 1024;
export const MAX_CHECKS = 64;
export const MAX_EVIDENCE = 128;
export const MAX_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_DIGESTS = 128;
export const MAX_IDENTIFIER_LENGTH = 256;

const SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CHECK_RESULTS = ['PASS', 'FAIL'] as const;
const SENSITIVITY = ['redacted', 'public'] as const;
const RETENTION = ['ephemeral', 'run'] as const;

export type CheckResult = (typeof CHECK_RESULTS)[number];
export type EvidenceSensitivity = (typeof SENSITIVITY)[number];
export type EvidenceRetention = (typeof RETENTION)[number];

export type CheckContractCheck = Readonly<{
  id: string;
  expected: 'PASS';
  evidence: readonly string[];
}>;

export type RequiredEvidence = Readonly<{
  id: string;
  digest: Sha256;
  maxBytes: number;
  sensitivity: EvidenceSensitivity;
  retention: EvidenceRetention;
}>;

export type CheckContract = Readonly<{
  schema: typeof CHECK_CONTRACT_SCHEMA;
  version: typeof CHECK_CONTRACT_VERSION;
  phaseId: string;
  stepId: string;
  attemptEpoch: number;
  expectedResult: 'PASS';
  producer: Readonly<{ kind: string; version: string }>;
  checks: readonly CheckContractCheck[];
  requiredEvidence: readonly RequiredEvidence[];
  ceilings: Readonly<{
    maxChecks: number;
    maxEvidence: number;
    maxEvidenceBytes: number;
    maxRecordBytes: number;
  }>;
  expiresAt: string;
}>;

export type WorkerProofCheck = Readonly<{
  id: string;
  result: CheckResult;
  evidence: readonly string[];
}>;

export type WorkerProofEvidence = Readonly<{
  id: string;
  digest: Sha256;
  bytes: number;
}>;

export type WorkerProof = Readonly<{
  schema: typeof WORKER_PROOF_SCHEMA;
  version: typeof WORKER_PROOF_VERSION;
  contractDigest: Sha256;
  phaseId: string;
  stepId: string;
  attemptEpoch: number;
  launchToken: string;
  commandDigest: Sha256;
  terminalDigest: Sha256;
  reportDigest: Sha256 | null;
  diffDigest: Sha256 | null;
  artifactDigests: readonly Sha256[];
  producer: Readonly<{ kind: string; version: string }>;
  checks: readonly WorkerProofCheck[];
  evidence: readonly WorkerProofEvidence[];
  createdAt: string;
  expiresAt: string;
}>;

export type WorkerProofRef = Ref;

export type WorkerProofBinding = Readonly<{
  /** A validated immutable terminal record from the existing effect store. */
  terminal?: TerminalRecord;
  /** Optional launch witness; when supplied all launch identity is checked. */
  launch?: LaunchRecord;
  launchToken?: string;
  commandDigest?: string;
  phaseId?: string;
  stepId?: string;
  attemptEpoch?: number;
}>;

export type WorkerProofVerifyOptions = Readonly<{
  /** Injected evaluation time keeps the verifier deterministic and pure. */
  at?: string | number | Date;
  binding?: WorkerProofBinding;
}>;

export type WorkerProofVerification = 'CERTIFIED' | `ATTENTION:${WorkerProofAttentionCode}`;
export const WORKER_PROOF_ATTENTION_CODES = Object.freeze([
  'MALFORMED_CONTRACT',
  'MALFORMED_PROOF',
  'CONTRACT_DIGEST_MISMATCH',
  'CONTRACT_BINDING_MISMATCH',
  'PRODUCER_MISMATCH',
  'CHECKS_MISMATCH',
  'CHECK_RESULT_NOT_PASS',
  'EVIDENCE_MISMATCH',
  'EVIDENCE_UNDECLARED',
  'CEILING_EXCEEDED',
  'EXPIRED',
  'INVALID_TIME',
  'TERMINAL_EVIDENCE_MISSING',
  'TERMINAL_EVIDENCE_MISMATCH',
  'LAUNCH_EVIDENCE_MISMATCH',
] as const);
export type WorkerProofAttentionCode = (typeof WORKER_PROOF_ATTENTION_CODES)[number];

function attention(code: WorkerProofAttentionCode): WorkerProofVerification {
  return `ATTENTION:${code}`;
}
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plain(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} fields are not closed`);
  return value;
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH || CONTROL.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}
function sha(value: unknown, label: string, nullable = false): Sha256 | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${label} is invalid`);
  return value as Sha256;
}
function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} is invalid`);
  return value as number;
}
function positive(value: unknown, label: string): number {
  const result = nonNegative(value, label);
  if (result < 1) throw new TypeError(`${label} must be positive`);
  return result;
}
function isoTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 64 || CONTROL.test(value) || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} is invalid`);
  // Date.parse accepts several non-ISO spellings.  Requiring a canonical UTC
  // representation prevents equivalent spellings from changing a digest.
  const parsed = new Date(value);
  if (parsed.toISOString() !== value) throw new TypeError(`${label} is not canonical UTC`);
  return value;
}
function stableCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')); }
function sortedUnique(values: readonly string[], label: string): readonly string[] {
  const result = values.map((value, index) => id(value, `${label}[${index}]`));
  for (let index = 1; index < result.length; index += 1) {
    if (stableCompare(result[index - 1]!, result[index]!) >= 0) throw new TypeError(`${label} must be sorted and unique`);
  }
  return Object.freeze([...result]);
}
function freezeProducer(value: unknown, label: string): Readonly<{ kind: string; version: string }> {
  const producer = exact(value, ['kind', 'version'], label);
  return Object.freeze({ kind: id(producer.kind, `${label}.kind`), version: id(producer.version, `${label}.version`) });
}
function freezeContractCheck(value: unknown, index: number): CheckContractCheck {
  const check = exact(value, ['evidence', 'expected', 'id'], `checks[${index}]`);
  if (check.expected !== 'PASS') throw new TypeError(`checks[${index}].expected must be PASS`);
  if (!Array.isArray(check.evidence)) throw new TypeError(`checks[${index}].evidence must be an array`);
  return Object.freeze({ id: id(check.id, `checks[${index}].id`), expected: 'PASS' as const, evidence: sortedUnique(check.evidence, `checks[${index}].evidence`) });
}
function freezeRequiredEvidence(value: unknown, index: number): RequiredEvidence {
  const evidence = exact(value, ['digest', 'id', 'maxBytes', 'retention', 'sensitivity'], `requiredEvidence[${index}]`);
  if (evidence.sensitivity !== 'redacted' && evidence.sensitivity !== 'public') throw new TypeError(`requiredEvidence[${index}].sensitivity is invalid`);
  if (evidence.retention !== 'ephemeral' && evidence.retention !== 'run') throw new TypeError(`requiredEvidence[${index}].retention is invalid`);
  const maxBytes = positive(evidence.maxBytes, `requiredEvidence[${index}].maxBytes`);
  if (maxBytes > MAX_EVIDENCE_BYTES) throw new TypeError(`requiredEvidence[${index}].maxBytes exceeds ceiling`);
  return Object.freeze({ id: id(evidence.id, `requiredEvidence[${index}].id`), digest: sha(evidence.digest, `requiredEvidence[${index}].digest`)!, maxBytes, sensitivity: evidence.sensitivity as EvidenceSensitivity, retention: evidence.retention as EvidenceRetention });
}

/** Validate and freeze the closed parent declaration. */
export function validateCheckContract(value: unknown): CheckContract {
  const contract = exact(value, ['attemptEpoch', 'ceilings', 'checks', 'expiresAt', 'expectedResult', 'phaseId', 'producer', 'requiredEvidence', 'schema', 'stepId', 'version'], 'check contract');
  if (contract.schema !== CHECK_CONTRACT_SCHEMA || contract.version !== CHECK_CONTRACT_VERSION) throw new TypeError('check contract schema/version is invalid');
  if (contract.expectedResult !== 'PASS') throw new TypeError('check contract expectedResult must be PASS');
  const phaseId = id(contract.phaseId, 'phaseId');
  const stepId = id(contract.stepId, 'stepId');
  const attemptEpoch = nonNegative(contract.attemptEpoch, 'attemptEpoch');
  const producer = freezeProducer(contract.producer, 'producer');
  if (!Array.isArray(contract.checks) || contract.checks.length === 0 || contract.checks.length > MAX_CHECKS) throw new TypeError('checks exceed ceiling or are empty');
  const checks = contract.checks.map(freezeContractCheck);
  for (let index = 1; index < checks.length; index += 1) if (stableCompare(checks[index - 1]!.id, checks[index]!.id) >= 0) throw new TypeError('checks must be sorted and unique');
  if (!Array.isArray(contract.requiredEvidence) || contract.requiredEvidence.length > MAX_EVIDENCE) throw new TypeError('requiredEvidence exceeds ceiling');
  const requiredEvidence = contract.requiredEvidence.map(freezeRequiredEvidence);
  for (let index = 1; index < requiredEvidence.length; index += 1) if (stableCompare(requiredEvidence[index - 1]!.id, requiredEvidence[index]!.id) >= 0) throw new TypeError('requiredEvidence must be sorted and unique');
  const ceilings = exact(contract.ceilings, ['maxChecks', 'maxEvidence', 'maxEvidenceBytes', 'maxRecordBytes'], 'ceilings');
  const maxChecks = positive(ceilings.maxChecks, 'ceilings.maxChecks');
  const maxEvidence = positive(ceilings.maxEvidence, 'ceilings.maxEvidence');
  const maxEvidenceBytes = positive(ceilings.maxEvidenceBytes, 'ceilings.maxEvidenceBytes');
  const maxRecordBytes = positive(ceilings.maxRecordBytes, 'ceilings.maxRecordBytes');
  if (maxChecks > MAX_CHECKS || maxEvidence > MAX_EVIDENCE || maxEvidenceBytes > MAX_EVIDENCE_BYTES || maxRecordBytes > MAX_WORKER_PROOF_BYTES) throw new TypeError('ceilings exceed codec limits');
  if (checks.length > maxChecks || requiredEvidence.length > maxEvidence) throw new TypeError('declaration exceeds its ceilings');
  const evidenceMap = new Map(requiredEvidence.map((entry) => [entry.id, entry]));
  for (const check of checks) for (const evidenceId of check.evidence) if (!evidenceMap.has(evidenceId)) throw new TypeError(`check ${check.id} references undeclared evidence`);
  const expiresAt = isoTime(contract.expiresAt, 'expiresAt');
  const result: CheckContract = Object.freeze({ schema: CHECK_CONTRACT_SCHEMA, version: CHECK_CONTRACT_VERSION, phaseId, stepId, attemptEpoch, expectedResult: 'PASS', producer, checks: Object.freeze(checks), requiredEvidence: Object.freeze(requiredEvidence), ceilings: Object.freeze({ maxChecks, maxEvidence, maxEvidenceBytes, maxRecordBytes }), expiresAt });
  if (Buffer.byteLength(canonicalString(result), 'utf8') > maxRecordBytes || Buffer.byteLength(canonicalString(result), 'utf8') > MAX_CHECK_CONTRACT_BYTES) throw new TypeError('check contract exceeds byte ceiling');
  return result;
}

export function encodeCheckContract(value: CheckContract): string {
  const checked = validateCheckContract(value);
  const bytes = canonicalString(checked);
  if (Buffer.byteLength(bytes, 'utf8') > checked.ceilings.maxRecordBytes || Buffer.byteLength(bytes, 'utf8') > MAX_CHECK_CONTRACT_BYTES) throw new TypeError('check contract exceeds byte ceiling');
  return bytes;
}
export function decodeCheckContract(bytes: string | Uint8Array): CheckContract {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  if (typeof bytes !== 'string' && !Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) throw new TypeError('check contract bytes are not valid UTF-8');
  if (Buffer.byteLength(text, 'utf8') > MAX_CHECK_CONTRACT_BYTES) throw new TypeError('check contract exceeds byte ceiling');
  return validateCheckContract(parseCanonical<unknown>(text));
}
export function checkContractDigest(value: CheckContract): Sha256 { return digest(validateCheckContract(value)); }

export type CheckContractInput = Readonly<Partial<Pick<CheckContract, 'schema' | 'version'>> & Omit<CheckContract, 'schema' | 'version'>>;

/** Construct a declaration with deterministic ordering before validation. */
export function createCheckContract(input: CheckContractInput): CheckContract {
  const checks = [...input.checks].map((check) => ({ ...check, evidence: [...check.evidence].sort(stableCompare) })).sort((left, right) => stableCompare(left.id, right.id));
  const requiredEvidence = [...input.requiredEvidence].map((entry) => ({ ...entry, retention: entry.retention ?? 'ephemeral' as const })).sort((left, right) => stableCompare(left.id, right.id));
  return validateCheckContract({ ...input, schema: CHECK_CONTRACT_SCHEMA, version: CHECK_CONTRACT_VERSION, checks, requiredEvidence });
}

function freezeProofCheck(value: unknown, index: number): WorkerProofCheck {
  const check = exact(value, ['evidence', 'id', 'result'], `proof.checks[${index}]`);
  if (!CHECK_RESULTS.includes(check.result as CheckResult)) throw new TypeError(`proof.checks[${index}].result is invalid`);
  if (!Array.isArray(check.evidence)) throw new TypeError(`proof.checks[${index}].evidence must be an array`);
  return Object.freeze({ id: id(check.id, `proof.checks[${index}].id`), result: check.result as CheckResult, evidence: sortedUnique(check.evidence, `proof.checks[${index}].evidence`) });
}
function freezeProofEvidence(value: unknown, index: number): WorkerProofEvidence {
  const evidence = exact(value, ['bytes', 'digest', 'id'], `proof.evidence[${index}]`);
  return Object.freeze({ id: id(evidence.id, `proof.evidence[${index}].id`), digest: sha(evidence.digest, `proof.evidence[${index}].digest`)!, bytes: nonNegative(evidence.bytes, `proof.evidence[${index}].bytes`) });
}

/** Validate and freeze disposable worker evidence. */
export function validateWorkerProof(value: unknown): WorkerProof {
  const proof = exact(value, ['artifactDigests', 'attemptEpoch', 'checks', 'commandDigest', 'contractDigest', 'createdAt', 'diffDigest', 'evidence', 'expiresAt', 'launchToken', 'phaseId', 'producer', 'reportDigest', 'schema', 'stepId', 'terminalDigest', 'version'], 'worker proof');
  if (proof.schema !== WORKER_PROOF_SCHEMA || proof.version !== WORKER_PROOF_VERSION) throw new TypeError('worker proof schema/version is invalid');
  const contractDigest = sha(proof.contractDigest, 'contractDigest')!;
  const phaseId = id(proof.phaseId, 'phaseId');
  const stepId = id(proof.stepId, 'stepId');
  const attemptEpoch = nonNegative(proof.attemptEpoch, 'attemptEpoch');
  const launchToken = id(proof.launchToken, 'launchToken');
  const commandDigest = sha(proof.commandDigest, 'commandDigest')!;
  const terminalDigest = sha(proof.terminalDigest, 'terminalDigest')!;
  const reportDigest = sha(proof.reportDigest, 'reportDigest', true);
  const diffDigest = sha(proof.diffDigest, 'diffDigest', true);
  if (!Array.isArray(proof.artifactDigests) || proof.artifactDigests.length > MAX_ARTIFACT_DIGESTS) throw new TypeError('artifactDigests exceeds ceiling');
  const artifactDigests = proof.artifactDigests.map((entry, index) => sha(entry, `artifactDigests[${index}]`)!);
  for (let index = 1; index < artifactDigests.length; index += 1) if (stableCompare(artifactDigests[index - 1]!, artifactDigests[index]!) >= 0) throw new TypeError('artifactDigests must be sorted and unique');
  const producer = freezeProducer(proof.producer, 'proof.producer');
  if (!Array.isArray(proof.checks) || proof.checks.length === 0 || proof.checks.length > MAX_CHECKS) throw new TypeError('proof checks exceed ceiling or are empty');
  const checks = proof.checks.map(freezeProofCheck);
  for (let index = 1; index < checks.length; index += 1) if (stableCompare(checks[index - 1]!.id, checks[index]!.id) >= 0) throw new TypeError('proof checks must be sorted and unique');
  if (!Array.isArray(proof.evidence) || proof.evidence.length > MAX_EVIDENCE) throw new TypeError('proof evidence exceeds ceiling');
  const evidence = proof.evidence.map(freezeProofEvidence);
  for (let index = 1; index < evidence.length; index += 1) if (stableCompare(evidence[index - 1]!.id, evidence[index]!.id) >= 0) throw new TypeError('proof evidence must be sorted and unique');
  let evidenceBytes = 0;
  for (const entry of evidence) {
    if (entry.bytes > MAX_EVIDENCE_BYTES || evidenceBytes > MAX_EVIDENCE_BYTES - entry.bytes) throw new TypeError('proof evidence bytes exceed ceiling');
    evidenceBytes += entry.bytes;
  }
  const createdAt = isoTime(proof.createdAt, 'createdAt');
  const expiresAt = isoTime(proof.expiresAt, 'expiresAt');
  if (Date.parse(createdAt) >= Date.parse(expiresAt)) throw new TypeError('proof createdAt must precede expiresAt');
  const result: WorkerProof = Object.freeze({ schema: WORKER_PROOF_SCHEMA, version: WORKER_PROOF_VERSION, contractDigest, phaseId, stepId, attemptEpoch, launchToken, commandDigest, terminalDigest, reportDigest, diffDigest, artifactDigests: Object.freeze([...artifactDigests]), producer, checks: Object.freeze(checks), evidence: Object.freeze(evidence), createdAt, expiresAt });
  if (Buffer.byteLength(canonicalString(result), 'utf8') > MAX_WORKER_PROOF_BYTES) throw new TypeError('worker proof exceeds byte ceiling');
  return result;
}

export function encodeWorkerProof(value: WorkerProof): string {
  const checked = validateWorkerProof(value);
  const bytes = canonicalString(checked);
  if (Buffer.byteLength(bytes, 'utf8') > MAX_WORKER_PROOF_BYTES) throw new TypeError('worker proof exceeds byte ceiling');
  return bytes;
}
export function decodeWorkerProof(bytes: string | Uint8Array): WorkerProof {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  if (typeof bytes !== 'string' && !Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) throw new TypeError('worker proof bytes are not valid UTF-8');
  if (Buffer.byteLength(text, 'utf8') > MAX_WORKER_PROOF_BYTES) throw new TypeError('worker proof exceeds byte ceiling');
  return validateWorkerProof(parseCanonical<unknown>(text));
}
export function workerProofDigest(value: WorkerProof): Sha256 { return digest(validateWorkerProof(value)); }
export function workerProofRef(value: WorkerProof): WorkerProofRef {
  const checked = validateWorkerProof(value);
  return { id: `worker-proof:${checked.launchToken}`, scope: 'codex/worker-proof', digest: digest(checked), bytes: canonicalString(checked) };
}

/** Create the immutable binding fields from existing effect records. */
export function effectProofBinding(launch: LaunchRecord, terminal: TerminalRecord): Pick<WorkerProof, 'launchToken' | 'commandDigest' | 'terminalDigest' | 'reportDigest'> {
  const checkedLaunch = validateLaunchRecord(launch);
  const checkedTerminal = validateTerminalRecord(terminal);
  if (checkedLaunch.launchToken !== checkedTerminal.launchToken || checkedLaunch.commandDigest !== checkedTerminal.commandDigest) throw new TypeError('launch and terminal records do not bind');
  return Object.freeze({ launchToken: checkedLaunch.launchToken, commandDigest: checkedLaunch.commandDigest as Sha256, terminalDigest: digest(checkedTerminal), reportDigest: checkedTerminal.reportDigest as Sha256 | null });
}

export type WorkerProofInput = Readonly<Partial<Pick<WorkerProof, 'schema' | 'version' | 'reportDigest' | 'diffDigest' | 'artifactDigests' | 'producer' | 'createdAt' | 'expiresAt'>> & {
  contract: CheckContract;
  launch?: LaunchRecord;
  terminal?: TerminalRecord;
  launchToken?: string;
  commandDigest?: Sha256;
  terminalDigest?: Sha256;
  phaseId?: string;
  stepId?: string;
  attemptEpoch?: number;
  contractDigest?: Sha256;
  checks: readonly WorkerProofCheck[];
  evidence: readonly WorkerProofEvidence[];
}>;

/** Construct proof fields from immutable launch/terminal records when present. */
export function createWorkerProof(input: WorkerProofInput): WorkerProof {
  const contract = validateCheckContract(input.contract);
  const checkedTerminal = input.terminal ? validateTerminalRecord(input.terminal) : undefined;
  const effect = input.launch && checkedTerminal ? effectProofBinding(input.launch, checkedTerminal) : checkedTerminal ? {
    launchToken: checkedTerminal.launchToken,
    commandDigest: checkedTerminal.commandDigest as Sha256,
    terminalDigest: digest(checkedTerminal),
    reportDigest: checkedTerminal.reportDigest as Sha256 | null,
  } : undefined;
  const expiresAt = input.expiresAt ?? contract.expiresAt;
  const createdAt = input.createdAt ?? new Date(Date.parse(expiresAt) - 1).toISOString();
  return validateWorkerProof({
    schema: WORKER_PROOF_SCHEMA,
    version: WORKER_PROOF_VERSION,
    contractDigest: input.contractDigest ?? checkContractDigest(contract),
    phaseId: input.phaseId ?? contract.phaseId,
    stepId: input.stepId ?? contract.stepId,
    attemptEpoch: input.attemptEpoch ?? contract.attemptEpoch,
    launchToken: input.launchToken ?? effect?.launchToken,
    commandDigest: input.commandDigest ?? effect?.commandDigest,
    terminalDigest: input.terminalDigest ?? effect?.terminalDigest,
    reportDigest: input.reportDigest === undefined ? (effect?.reportDigest ?? null) : input.reportDigest,
    diffDigest: input.diffDigest ?? null,
    artifactDigests: [...(input.artifactDigests ?? [])].sort(stableCompare),
    producer: input.producer ?? contract.producer,
    checks: [...input.checks].map((check) => ({ ...check, evidence: [...check.evidence].sort(stableCompare) })).sort((left, right) => stableCompare(left.id, right.id)),
    evidence: [...input.evidence].sort((left, right) => stableCompare(left.id, right.id)),
    createdAt,
    expiresAt,
  });
}

function atMillis(value: string | number | Date | undefined): number | undefined {
  if (value === undefined) return undefined;
  const millis = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}
/**
 * Pure fail-closed verifier.  It returns no event, effect, or decision—only a
 * stable certificate or bounded attention code.  `at` and effect witnesses
 * are explicit inputs so the same bytes can be replayed deterministically.
 */
export function verifyWorkerProof(contractInput: unknown, proofInput: unknown, options: WorkerProofVerifyOptions = {}): WorkerProofVerification {
  if (!plain(options)) return attention('INVALID_TIME');
  let contract: CheckContract;
  try { contract = validateCheckContract(contractInput); } catch { return attention('MALFORMED_CONTRACT'); }
  let proof: WorkerProof;
  try { proof = validateWorkerProof(proofInput); } catch { return attention('MALFORMED_PROOF'); }
  if (proof.contractDigest !== checkContractDigest(contract)) return attention('CONTRACT_DIGEST_MISMATCH');
  if (proof.phaseId !== contract.phaseId || proof.stepId !== contract.stepId || proof.attemptEpoch !== contract.attemptEpoch || proof.expiresAt !== contract.expiresAt) return attention('CONTRACT_BINDING_MISMATCH');
  if (proof.producer.kind !== contract.producer.kind || proof.producer.version !== contract.producer.version) return attention('PRODUCER_MISMATCH');
  if (proof.checks.length !== contract.checks.length || proof.checks.some((check, index) => check.id !== contract.checks[index]?.id)) return attention('CHECKS_MISMATCH');
  for (let index = 0; index < contract.checks.length; index += 1) {
    const expected = contract.checks[index]!;
    const actual = proof.checks[index]!;
    if (actual.result !== expected.expected || actual.evidence.length !== expected.evidence.length || actual.evidence.some((value, evidenceIndex) => value !== expected.evidence[evidenceIndex])) return actual.result === 'FAIL' ? attention('CHECK_RESULT_NOT_PASS') : attention('CHECKS_MISMATCH');
  }
  const required = new Map(contract.requiredEvidence.map((entry) => [entry.id, entry]));
  // Optional diff/artifact fields are only projections of evidence the parent
  // declared up front.  A worker cannot smuggle extra digests as decoration.
  const requiredDigests = new Set(contract.requiredEvidence.map((entry) => entry.digest));
  if (proof.diffDigest !== null && !requiredDigests.has(proof.diffDigest)) return attention('EVIDENCE_UNDECLARED');
  if (proof.artifactDigests.some((entry) => !requiredDigests.has(entry))) return attention('EVIDENCE_UNDECLARED');
  if (proof.evidence.some((entry) => !required.has(entry.id))) return attention('EVIDENCE_UNDECLARED');
  if (proof.evidence.length !== contract.requiredEvidence.length) return attention('EVIDENCE_MISMATCH');
  let evidenceBytes = 0;
  for (let index = 0; index < contract.requiredEvidence.length; index += 1) {
    const requiredEntry = contract.requiredEvidence[index]!;
    const actual = proof.evidence[index]!;
    if (actual.id !== requiredEntry.id || actual.digest !== requiredEntry.digest || actual.bytes > requiredEntry.maxBytes) return attention('EVIDENCE_MISMATCH');
    evidenceBytes += actual.bytes;
  }
  if (evidenceBytes > contract.ceilings.maxEvidenceBytes || proof.evidence.length > contract.ceilings.maxEvidence) return attention('CEILING_EXCEEDED');
  const proofBytes = Buffer.byteLength(canonicalString(proof), 'utf8');
  if (proofBytes > contract.ceilings.maxRecordBytes || proofBytes > MAX_WORKER_PROOF_BYTES) return attention('CEILING_EXCEEDED');
  const now = atMillis(options.at);
  if (now === undefined) return attention('INVALID_TIME');
  if (now < Date.parse(proof.createdAt) || now >= Date.parse(contract.expiresAt)) return attention('EXPIRED');
  const binding = options.binding;
  if (!binding?.terminal) return attention('TERMINAL_EVIDENCE_MISSING');
  try {
    const terminal = validateTerminalRecord(binding.terminal);
    if (digest(terminal) !== proof.terminalDigest || terminal.launchToken !== proof.launchToken || terminal.commandDigest !== proof.commandDigest || terminal.status !== 'PASS' || terminal.outcome !== 'normal-completion' || terminal.reportDigest === null || proof.reportDigest === null || terminal.reportDigest !== proof.reportDigest) return attention('TERMINAL_EVIDENCE_MISMATCH');
    if (binding.launch) {
      const launch = validateLaunchRecord(binding.launch);
      if (launch.launchToken !== proof.launchToken || launch.commandDigest !== proof.commandDigest || launch.phaseId !== proof.phaseId || launch.stepId !== proof.stepId || launch.attemptEpoch !== proof.attemptEpoch) return attention('LAUNCH_EVIDENCE_MISMATCH');
    }
  } catch { return attention('TERMINAL_EVIDENCE_MISMATCH'); }
  if (binding.launchToken !== undefined && binding.launchToken !== proof.launchToken) return attention('CONTRACT_BINDING_MISMATCH');
  if (binding.commandDigest !== undefined && binding.commandDigest !== proof.commandDigest) return attention('CONTRACT_BINDING_MISMATCH');
  if (binding.phaseId !== undefined && binding.phaseId !== proof.phaseId) return attention('CONTRACT_BINDING_MISMATCH');
  if (binding.stepId !== undefined && binding.stepId !== proof.stepId) return attention('CONTRACT_BINDING_MISMATCH');
  if (binding.attemptEpoch !== undefined && binding.attemptEpoch !== proof.attemptEpoch) return attention('CONTRACT_BINDING_MISMATCH');
  return 'CERTIFIED';
}
