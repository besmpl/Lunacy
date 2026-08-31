import { canonicalString, digest } from './canonical.js';
import type { Sha256 } from './model.js';

/** The private, effect-denied host profile used by managed deliberation. */
export const MANAGED_CAPABILITY_SCHEMA = 'lunacy-managed-capability/v1' as const;
export const MANAGED_ROUTE = 'gpt-5.6-luna/max' as const;
export const MANAGED_ROLLOUT_SCHEMA = 'lunacy-managed-rollout-policy/v1' as const;
export const MANAGED_ROLLOUT_MODES = Object.freeze([
  'disabled',
  'shadow',
  'focus-canary',
  'explicit-explore-canary',
  'automatic-focus',
  'automatic-explore',
] as const);
export type ManagedRolloutMode = (typeof MANAGED_ROLLOUT_MODES)[number];

export type ManagedRolloutPolicy = Readonly<{
  schema: typeof MANAGED_ROLLOUT_SCHEMA;
  generation: number;
  mode: ManagedRolloutMode;
  digest: Sha256;
}>;

export type ManagedRolloutPolicyInput = Readonly<{
  schema?: typeof MANAGED_ROLLOUT_SCHEMA;
  generation?: number;
  mode?: ManagedRolloutMode;
  digest?: string;
}>;

export type ManagedRolloutProjection = Readonly<Pick<ManagedRolloutPolicy, 'generation' | 'mode' | 'digest'>>;

export type ManagedRolloutFacts = Readonly<{
  gear: 'DIRECT' | 'FOCUS' | 'EXPLORE';
  synthetic: boolean;
  disposable: boolean;
  effectDenied: boolean;
  oneDecisionKey: boolean;
  staticTopology: boolean;
  childDelegation: boolean;
  claimsOrEffects: boolean;
  sealedEvidenceOnly: boolean;
  explicitExplore: boolean;
  decisionUnsettled: boolean;
  openEnded: boolean;
  highStakes: boolean;
  openlyPhrased: boolean;
}>;

export type ManagedRolloutDecision = Readonly<{
  admitted: boolean;
  shadow: boolean;
  authorityDenied: boolean;
  reason: 'DIRECT_BYPASS' | 'DISABLED' | 'CAPABILITY' | 'D0_CORRIDOR' | 'D1_CORRIDOR' | 'D2_EXPLICIT' | 'D3_FOCUS' | 'D4_EXPLORE' | 'COHORT_REFUSED';
}>;
/** Closed artifact profile understood by the managed reducer.  Future or
 * caller-selected schema labels are intentionally rejected until a new
 * capability version publishes their semantics. */
export const MANAGED_ARTIFACT_SCHEMAS = Object.freeze(['Wave/v2', 'Report/v2'] as const);
const SHA256 = /^[0-9a-f]{64}$/i;

/** The only graph root admitted by the C1–C5 managed START envelope.  The
 * identity is deliberately exact; later report roots require a separate
 * capability/schema rather than silently widening this closure. */
export const MANAGED_WAVE_REF_ID = 'plan' as const;

export type ManagedGraphRef = Readonly<{ id: string; digest: string; scope?: string; bytes?: string }>;
export type ManagedGraphLeaseSet = Readonly<{ leaseId: string; closedRefGraph: readonly ManagedGraphRef[] }>;
export type ManagedGraphProposal = Readonly<{ leaseSetId: string; waveRef: ManagedGraphRef }>;
export type ManagedGraphAttemptOwner = Readonly<{ commandId: string; authorityAnchor: ManagedGraphRef }>;
export type ManagedGraphDecisionOwner = Readonly<{ token: string; leaseSetId: string; disposition: string; waveRef: ManagedGraphRef; orderedReportRefs: readonly ManagedGraphRef[]; authorityAnchors?: readonly ManagedGraphRef[]; settlement?: ManagedGraphRef | null; successorWaveRef?: ManagedGraphRef }>;
export type ManagedGraph = Readonly<{ proposal?: ManagedGraphProposal; leaseSets: Readonly<Record<string, ManagedGraphLeaseSet>>; attemptOwners?: readonly ManagedGraphAttemptOwner[]; decisionOwners?: readonly ManagedGraphDecisionOwner[] }>;

function graphPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`managed graph ${label} is invalid`);
  const object = value as object;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(object).length !== 0) throw new Error(`managed graph ${label} is not a plain object`);
  // The graph is also an untrusted START boundary.  Do not invoke accessors
  // while proving ownership, and do not let non-enumerable fields hide an
  // extra root/ref field from the closed-key checks below.
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(object))) {
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error(`managed graph ${label} contains an accessor or hidden field`);
  }
  return value as Record<string, unknown>;
}

function graphRefKey(ref: ManagedGraphRef): string {
  return canonicalString({ id: ref.id, digest: ref.digest, ...(ref.scope === undefined ? {} : { scope: ref.scope }), bytes: ref.bytes });
}

function assertManagedGraphRef(value: unknown, label: string): asserts value is ManagedGraphRef {
  const ref = graphPlainRecord(value, label);
  const keys = Object.keys(ref).sort();
  if (keys.some((key) => !['bytes', 'digest', 'id', 'scope'].includes(key))) throw new Error(`managed graph ${label} fields are invalid`);
  if (!Object.prototype.hasOwnProperty.call(ref, 'id') || !Object.prototype.hasOwnProperty.call(ref, 'digest') || !Object.prototype.hasOwnProperty.call(ref, 'bytes') || Object.prototype.hasOwnProperty.call(ref, 'scope')) throw new Error(`managed graph ${label} identity is foreign`);
  if (typeof ref.id !== 'string' || ref.id !== MANAGED_WAVE_REF_ID || typeof ref.digest !== 'string' || !SHA256.test(ref.digest)) throw new Error(`managed graph ${label} identity is foreign`);
  if (typeof ref.bytes !== 'string' || ref.bytes.length === 0) throw new Error(`managed graph ${label} bytes are missing`);
  try {
    const parsed = JSON.parse(ref.bytes);
    if (canonicalString(parsed) !== ref.bytes || digest(parsed) !== ref.digest) throw new Error('digest mismatch');
  } catch { throw new Error(`managed graph ${label} bytes are not canonical`); }
}

function assertCanonicalGraphRef(value: unknown, label: string): asserts value is ManagedGraphRef {
  const ref = graphPlainRecord(value, label);
  if (Object.keys(ref).some((key) => !['bytes', 'digest', 'id', 'scope'].includes(key)) || typeof ref.id !== 'string' || ref.id.length === 0 || typeof ref.digest !== 'string' || !SHA256.test(ref.digest) || typeof ref.bytes !== 'string' || ref.bytes.length === 0) throw new Error(`managed graph ${label} identity is invalid`);
  try { const parsed = JSON.parse(ref.bytes); if (canonicalString(parsed) !== ref.bytes || digest(parsed) !== ref.digest) throw new Error('digest mismatch'); }
  catch { throw new Error(`managed graph ${label} bytes are not canonical`); }
}

/** Validate the complete C1–C5 managed graph closure.  This is intentionally
 * shared by START admission and schema-2 store validation: a proposal must
 * own exactly one lease root, and that root's closed graph must contain the
 * exact canonical Wave Ref (with no orphan or foreign roots). */
export function assertManagedGraph(value: ManagedGraph): void {
  const graph = graphPlainRecord(value, 'envelope');
  if (Object.keys(graph).some((key) => !['leaseSets', 'proposal', 'attemptOwners', 'decisionOwners'].includes(key))) throw new Error('managed graph envelope fields are invalid');
  if (!Object.prototype.hasOwnProperty.call(graph, 'leaseSets')) throw new Error('managed graph leaseSets are missing');
  const leaseSets = graphPlainRecord(graph.leaseSets, 'leaseSets');
  const proposal = Object.prototype.hasOwnProperty.call(graph, 'proposal') ? graph.proposal : undefined;
  const attemptsValue = Object.prototype.hasOwnProperty.call(graph, 'attemptOwners') ? graph.attemptOwners : undefined;
  const ownersValue = Object.prototype.hasOwnProperty.call(graph, 'decisionOwners') ? graph.decisionOwners : undefined;
  if (attemptsValue !== undefined && (!Array.isArray(attemptsValue) || attemptsValue.some((owner) => !owner || typeof owner !== 'object'))) throw new Error('managed graph attempt owners are invalid');
  if (ownersValue !== undefined && (!Array.isArray(ownersValue) || ownersValue.some((owner) => !owner || typeof owner !== 'object'))) throw new Error('managed graph decision owners are invalid');
  if (proposal === undefined && (!attemptsValue || attemptsValue.length === 0) && (!ownersValue || ownersValue.length === 0)) {
    if (Object.keys(leaseSets).length !== 0) throw new Error('managed graph has orphan lease roots');
    return;
  }
  if (proposal === undefined) throw new Error('managed graph owner has no proposal');
  const proposalRecord = graphPlainRecord(proposal, 'proposal');
  if (Object.keys(proposalRecord).some((key) => !['leaseSetId', 'waveRef'].includes(key))) throw new Error('managed graph proposal fields are invalid');
  if (!Object.prototype.hasOwnProperty.call(proposalRecord, 'leaseSetId') || !Object.prototype.hasOwnProperty.call(proposalRecord, 'waveRef')) throw new Error('managed graph proposal fields are invalid');
  if (typeof proposalRecord.leaseSetId !== 'string' || proposalRecord.leaseSetId.length === 0) throw new Error('managed graph proposal lease root is invalid');
  const hasDecisionOwners = Boolean(ownersValue && ownersValue.length > 0);
  if (hasDecisionOwners) assertCanonicalGraphRef(proposalRecord.waveRef, 'proposal.waveRef');
  else assertManagedGraphRef(proposalRecord.waveRef, 'proposal.waveRef');
  const leaseIds = Object.keys(leaseSets);
  const attemptAnchors = (attemptsValue as readonly ManagedGraphAttemptOwner[] | undefined)?.map((owner) => {
    const item = graphPlainRecord(owner, 'attempt owner');
    if (Object.keys(item).some((key) => !['commandId', 'authorityAnchor'].includes(key)) || typeof item.commandId !== 'string' || item.commandId.length === 0) throw new Error('managed graph attempt owner fields are invalid');
    assertCanonicalGraphRef(item.authorityAnchor, 'attempt owner authorityAnchor');
    return item.authorityAnchor as ManagedGraphRef;
  }) ?? [];
  if (new Set((attemptsValue as readonly ManagedGraphAttemptOwner[] | undefined)?.map((owner) => owner.commandId) ?? []).size !== (attemptsValue?.length ?? 0)
    || new Set(attemptAnchors.map(graphRefKey)).size !== attemptAnchors.length) throw new Error('managed graph attempt owners conflict');
  const ownerIds = (ownersValue as readonly ManagedGraphDecisionOwner[] | undefined)?.map((owner) => {
    const item = graphPlainRecord(owner, 'decision owner');
    if (Object.keys(item).some((key) => !['token', 'leaseSetId', 'disposition', 'waveRef', 'orderedReportRefs', 'authorityAnchors', 'settlement', 'successorWaveRef'].includes(key))) throw new Error('managed graph decision owner fields are invalid');
    if (typeof item.token !== 'string' || item.token.length === 0 || typeof item.leaseSetId !== 'string' || item.leaseSetId.length === 0 || !['SELECTION', 'SYNTHESIS', 'WIDEN'].includes(String(item.disposition)) || !Array.isArray(item.orderedReportRefs) || (item.authorityAnchors !== undefined && !Array.isArray(item.authorityAnchors))) throw new Error('managed graph decision owner fields are invalid');
    assertCanonicalGraphRef(item.waveRef, 'decision owner waveRef');
    item.orderedReportRefs.forEach((ref, index) => assertCanonicalGraphRef(ref, `decision owner orderedReportRefs[${index}]`));
    (item.authorityAnchors as unknown[] | undefined)?.forEach((ref, index) => assertCanonicalGraphRef(ref, `decision owner authorityAnchors[${index}]`));
    if (item.disposition === 'WIDEN') { if (item.settlement !== null && item.settlement !== undefined) throw new Error('managed graph WIDEN settlement is invalid'); }
    else { if (!item.settlement) throw new Error('managed graph settlement is missing'); assertCanonicalGraphRef(item.settlement, 'decision owner settlement'); }
    if (item.successorWaveRef !== undefined) assertCanonicalGraphRef(item.successorWaveRef, 'decision owner successorWaveRef');
    return item.leaseSetId;
  }) ?? [];
  const expectedLeaseIds = [proposalRecord.leaseSetId, ...ownerIds];
  if (new Set(expectedLeaseIds).size !== expectedLeaseIds.length || leaseIds.length !== expectedLeaseIds.length || leaseIds.some((id) => !expectedLeaseIds.includes(id))) throw new Error('managed graph has orphan or foreign lease roots');
  const lease = graphPlainRecord(leaseSets[proposalRecord.leaseSetId], 'leaseSet');
  if (Object.keys(lease).some((key) => !['closedRefGraph', 'leaseId'].includes(key))) throw new Error('managed graph lease root fields are invalid');
  if (!Object.prototype.hasOwnProperty.call(lease, 'leaseId') || !Object.prototype.hasOwnProperty.call(lease, 'closedRefGraph')) throw new Error('managed graph lease root fields are invalid');
  if (lease.leaseId !== proposalRecord.leaseSetId || !Array.isArray(lease.closedRefGraph)) throw new Error('managed graph lease root is not an exact closure');
  const proposalClosure = [proposalRecord.waveRef as ManagedGraphRef, ...attemptAnchors];
  (lease.closedRefGraph as unknown[]).forEach((ref, index) => index === 0 && !hasDecisionOwners ? assertManagedGraphRef(ref, `leaseSet.closedRefGraph[${index}]`) : assertCanonicalGraphRef(ref, `leaseSet.closedRefGraph[${index}]`));
  if ((lease.closedRefGraph as ManagedGraphRef[]).length !== proposalClosure.length || new Set((lease.closedRefGraph as ManagedGraphRef[]).map(graphRefKey)).size !== proposalClosure.length
    || proposalClosure.some((ref) => !(lease.closedRefGraph as ManagedGraphRef[]).some((candidate) => graphRefKey(candidate) === graphRefKey(ref)))) throw new Error('managed graph proposal lease closure is not exact');
  for (const owner of (ownersValue as readonly ManagedGraphDecisionOwner[] | undefined) ?? []) {
    const ownerRecord = owner as Record<string, unknown>;
    const ownerLease = graphPlainRecord(leaseSets[ownerRecord.leaseSetId as string], 'decision leaseSet');
    if (ownerLease.leaseId !== ownerRecord.leaseSetId || !Array.isArray(ownerLease.closedRefGraph)) throw new Error('managed graph decision lease closure is invalid');
    (ownerLease.closedRefGraph as unknown[]).forEach((ref, index) => assertCanonicalGraphRef(ref, `decision leaseSet.closedRefGraph[${index}]`));
    const expected = [ownerRecord.waveRef as ManagedGraphRef, ...ownerRecord.orderedReportRefs as ManagedGraphRef[], ...(ownerRecord.authorityAnchors as ManagedGraphRef[] | undefined ?? []), ...(ownerRecord.settlement ? [ownerRecord.settlement as ManagedGraphRef] : []), ...(ownerRecord.successorWaveRef ? [ownerRecord.successorWaveRef as ManagedGraphRef] : [])];
    const actual = ownerLease.closedRefGraph as ManagedGraphRef[];
    if (actual.length !== expected.length || new Set(actual.map(graphRefKey)).size !== actual.length || expected.some((ref) => !actual.some((candidate) => graphRefKey(candidate) === graphRefKey(ref)))) throw new Error('managed graph decision lease closure is not exact');
  }
}

export type ManagedCeilings = Readonly<{
  waves: number;
  calls: number;
  inTok: number;
  outTok: number;
  reportBytes: number;
  refs: number;
  persistedBytes: number;
  deadline: number;
}>;

export type ManagedCapability = Readonly<{
  schema: typeof MANAGED_CAPABILITY_SCHEMA;
  route: typeof MANAGED_ROUTE;
  effectDenied: true;
  ceilings: ManagedCeilings;
  artifactSchemas: readonly string[];
  checksum: Sha256;
}>;

export type ManagedCapabilityInput = Readonly<{
  schema?: typeof MANAGED_CAPABILITY_SCHEMA;
  route?: typeof MANAGED_ROUTE;
  effectDenied?: true;
  ceilings?: Partial<ManagedCeilings>;
  artifactSchemas?: readonly string[];
  checksum?: string;
}>;

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`ManagedCapability: ${label} must be a non-negative safe integer`);
  return value as number;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`ManagedCapability: ${label} is invalid`);
  const object = value as object;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(object).length !== 0) throw new Error(`ManagedCapability: ${label} is not a plain object`);
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(object))) {
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error(`ManagedCapability: ${label} contains an accessor`);
    result[key] = descriptor.value;
  }
  return result;
}

function payload(capability: Omit<ManagedCapability, 'checksum'>): unknown {
  return {
    schema: capability.schema,
    route: capability.route,
    effectDenied: capability.effectDenied,
    ceilings: capability.ceilings,
    artifactSchemas: capability.artifactSchemas,
  };
}

function rolloutPayload(policy: Omit<ManagedRolloutPolicy, 'digest'>): unknown {
  return { schema: policy.schema, generation: policy.generation, mode: policy.mode };
}

/** Closed, immutable rollout authority. The numeric generation is the CAS
 * ordering fence; digest binds its exact canonical bytes. */
export function createManagedRolloutPolicy(input: ManagedRolloutPolicyInput = {}): ManagedRolloutPolicy {
  const descriptor = plainRecord(input, 'rollout policy');
  if (Object.keys(descriptor).some((key) => !['schema', 'generation', 'mode', 'digest'].includes(key))) throw new Error('ManagedCapability: rollout policy fields are not closed');
  if (descriptor.schema !== undefined && descriptor.schema !== MANAGED_ROLLOUT_SCHEMA) throw new Error('ManagedCapability: rollout policy schema is invalid');
  const generation = descriptor.generation ?? 0;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) throw new Error('ManagedCapability: rollout generation must be a non-negative safe integer');
  const mode = descriptor.mode ?? 'disabled';
  if (!MANAGED_ROLLOUT_MODES.includes(mode as ManagedRolloutMode)) throw new Error('ManagedCapability: rollout mode is invalid');
  const base = { schema: MANAGED_ROLLOUT_SCHEMA, generation: generation as number, mode: mode as ManagedRolloutMode };
  const policyDigest = digest(rolloutPayload(base));
  if (descriptor.digest !== undefined && descriptor.digest !== policyDigest) throw new Error('ManagedCapability: rollout policy digest mismatch');
  return Object.freeze({ ...base, digest: policyDigest });
}

export function verifyManagedRolloutPolicy(value: unknown): value is ManagedRolloutPolicy {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).sort().join(',') !== 'digest,generation,mode,schema') return false;
    const rebuilt = createManagedRolloutPolicy(value as ManagedRolloutPolicyInput);
    return rebuilt.digest === candidate.digest && canonicalString(rebuilt) === canonicalString(value);
  } catch { return false; }
}

export function projectManagedRolloutPolicy(policy: ManagedRolloutPolicy): ManagedRolloutProjection {
  if (!verifyManagedRolloutPolicy(policy)) throw new Error('ManagedCapability: rollout policy is invalid');
  return Object.freeze({ generation: policy.generation, mode: policy.mode, digest: policy.digest });
}

export function verifyManagedRolloutProjection(value: unknown): value is ManagedRolloutProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== 'digest,generation,mode') return false;
  if (!Number.isSafeInteger(candidate.generation) || (candidate.generation as number) < 0 || !MANAGED_ROLLOUT_MODES.includes(candidate.mode as ManagedRolloutMode) || typeof candidate.digest !== 'string') return false;
  return verifyManagedRolloutPolicy({ schema: MANAGED_ROLLOUT_SCHEMA, generation: candidate.generation as number, mode: candidate.mode as ManagedRolloutMode, digest: candidate.digest });
}

/** Exact D0-D4 corridor decision. It is pure and cannot consume a parent
 * token, adopt a Plan, or read diagnostics. */
export function managedRolloutDecision(policy: ManagedRolloutPolicy, capability: ManagedCapability | undefined, facts: ManagedRolloutFacts): ManagedRolloutDecision {
  if (facts.gear === 'DIRECT') return Object.freeze({ admitted: false, shadow: false, authorityDenied: false, reason: 'DIRECT_BYPASS' });
  if (!verifyManagedRolloutPolicy(policy) || policy.mode === 'disabled') return Object.freeze({ admitted: false, shadow: false, authorityDenied: false, reason: 'DISABLED' });
  if (!capability || !verifyManagedCapability(capability) || capability.route !== MANAGED_ROUTE || capability.effectDenied !== true) return Object.freeze({ admitted: false, shadow: false, authorityDenied: false, reason: 'CAPABILITY' });
  const d1 = facts.effectDenied && facts.oneDecisionKey && facts.staticTopology && !facts.childDelegation && !facts.claimsOrEffects && facts.sealedEvidenceOnly;
  const d0 = d1 && facts.synthetic && facts.disposable;
  if (policy.mode === 'shadow') return Object.freeze({ admitted: d0, shadow: d0, authorityDenied: d0, reason: d0 ? 'D0_CORRIDOR' : 'COHORT_REFUSED' });
  if (!d1) return Object.freeze({ admitted: false, shadow: false, authorityDenied: false, reason: 'COHORT_REFUSED' });
  if (facts.gear === 'FOCUS') {
    const reason = policy.mode === 'focus-canary' ? 'D1_CORRIDOR' : policy.mode === 'explicit-explore-canary' ? 'D1_CORRIDOR' : policy.mode === 'automatic-focus' || policy.mode === 'automatic-explore' ? 'D3_FOCUS' : 'COHORT_REFUSED';
    const admitted = reason !== 'COHORT_REFUSED' && facts.decisionUnsettled;
    return Object.freeze({ admitted, shadow: false, authorityDenied: false, reason: admitted ? reason : 'COHORT_REFUSED' });
  }
  const explicit = facts.explicitExplore;
  if (explicit && facts.decisionUnsettled && ['explicit-explore-canary', 'automatic-focus', 'automatic-explore'].includes(policy.mode)) return Object.freeze({ admitted: true, shadow: false, authorityDenied: false, reason: 'D2_EXPLICIT' });
  const implicit = policy.mode === 'automatic-explore' && facts.decisionUnsettled && facts.openEnded && facts.highStakes && facts.openlyPhrased;
  return Object.freeze({ admitted: implicit, shadow: false, authorityDenied: false, reason: implicit ? 'D4_EXPLORE' : 'COHORT_REFUSED' });
}

/** Build a canonical descriptor.  The checksum is over the complete closed
 * descriptor (without the checksum field), so any mutation is fail-closed. */
export function createManagedCapability(input: ManagedCapabilityInput = {}): ManagedCapability {
  const descriptor = plainRecord(input, 'descriptor');
  const allowed = new Set(['schema', 'route', 'effectDenied', 'ceilings', 'artifactSchemas', 'checksum']);
  if (Object.keys(descriptor).some((key) => !allowed.has(key))) throw new Error('ManagedCapability: descriptor fields are not closed');
  if (descriptor.schema !== undefined && descriptor.schema !== MANAGED_CAPABILITY_SCHEMA) throw new Error('ManagedCapability: schema is invalid');
  if (descriptor.route !== undefined && descriptor.route !== MANAGED_ROUTE) throw new Error('ManagedCapability: route must be gpt-5.6-luna/max');
  if (descriptor.effectDenied !== undefined && descriptor.effectDenied !== true) throw new Error('ManagedCapability: effectDenied must be true');
  const raw = descriptor.ceilings === undefined ? {} : plainRecord(descriptor.ceilings, 'ceilings');
  const allowedCeilings = ['waves', 'calls', 'inTok', 'outTok', 'reportBytes', 'refs', 'persistedBytes', 'deadline'];
  if (Object.keys(raw).some((key) => !allowedCeilings.includes(key))) throw new Error('ManagedCapability: ceilings fields are not closed');
  const ceilings: ManagedCeilings = Object.freeze({
    waves: positive((raw as Partial<ManagedCeilings>).waves ?? 1, 'ceilings.waves'),
    calls: positive((raw as Partial<ManagedCeilings>).calls ?? 1, 'ceilings.calls'),
    inTok: positive((raw as Partial<ManagedCeilings>).inTok ?? 0, 'ceilings.inTok'),
    outTok: positive((raw as Partial<ManagedCeilings>).outTok ?? 0, 'ceilings.outTok'),
    reportBytes: positive((raw as Partial<ManagedCeilings>).reportBytes ?? 0, 'ceilings.reportBytes'),
    refs: positive((raw as Partial<ManagedCeilings>).refs ?? 1, 'ceilings.refs'),
    persistedBytes: positive((raw as Partial<ManagedCeilings>).persistedBytes ?? 0, 'ceilings.persistedBytes'),
    deadline: positive((raw as Partial<ManagedCeilings>).deadline ?? Number.MAX_SAFE_INTEGER, 'ceilings.deadline'),
  });
  const schemas = descriptor.artifactSchemas ?? MANAGED_ARTIFACT_SCHEMAS;
  if (!Array.isArray(schemas) || schemas.length !== MANAGED_ARTIFACT_SCHEMAS.length
    || schemas.some((value, index) => value !== MANAGED_ARTIFACT_SCHEMAS[index])) {
    throw new Error('ManagedCapability: artifactSchemas profile is invalid');
  }
  const artifactSchemas = Object.freeze([...MANAGED_ARTIFACT_SCHEMAS]);
  const base = { schema: MANAGED_CAPABILITY_SCHEMA, route: MANAGED_ROUTE, effectDenied: true as const, ceilings, artifactSchemas };
  const checksum = digest(payload(base));
  if (descriptor.checksum !== undefined && descriptor.checksum !== checksum) throw new Error('ManagedCapability: checksum mismatch');
  return Object.freeze({ ...base, checksum });
}

/** Non-throwing authenticity check for untrusted persisted/host input. */
export function verifyManagedCapability(value: unknown): value is ManagedCapability {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).sort().join(',') !== 'artifactSchemas,ceilings,checksum,effectDenied,route,schema') return false;
    const rebuilt = createManagedCapability(value as ManagedCapabilityInput);
    return rebuilt.checksum === candidate.checksum && canonicalString(rebuilt) === canonicalString(value);
  } catch {
    return false;
  }
}

export type ManagedAdmission = Readonly<{ capability: ManagedCapability; generation: number; killSwitch: boolean }>;

/** Exact CAS gate used by managed admission callers. */
export function managedAdmissionAllowed(admission: ManagedAdmission | undefined, expectedGeneration: number, killSwitch = false): boolean {
  return Boolean(admission && !killSwitch && !admission.killSwitch && admission.generation === expectedGeneration && verifyManagedCapability(admission.capability));
}

/** Validate and freeze an all-dimension reservation before provider entry. */
export function reserveManaged(used: ManagedCeilings, request: ManagedCeilings, ceiling?: ManagedCeilings): ManagedCeilings | undefined {
  const fields: (keyof ManagedCeilings)[] = ['waves', 'calls', 'inTok', 'outTok', 'reportBytes', 'refs', 'persistedBytes', 'deadline'];
  for (const field of fields) {
    if (!Number.isSafeInteger(used[field]) || used[field] < 0 || !Number.isSafeInteger(request[field]) || request[field] < 0) return undefined;
  }
  // deadline is an absolute budget: reservations must not move it forward.
  if (request.deadline > used.deadline) return undefined;
  const next = { ...used };
  for (const field of fields) if (field !== 'deadline') {
    const sum = used[field] + request[field];
    if (!Number.isSafeInteger(sum)) return undefined;
    next[field] = sum;
  }
  next.deadline = used.deadline === Number.MAX_SAFE_INTEGER ? request.deadline : Math.min(used.deadline, request.deadline);
  if (ceiling) {
    for (const field of fields) if (field !== 'deadline' && next[field] > ceiling[field]) return undefined;
    if (next.deadline > ceiling.deadline) return undefined;
  }
  return Object.freeze(next);
}
