import { canonicalString, digest, digestBytes, parseCanonical } from './canonical.js';
import { compareStable } from './dependency.js';
import { validatePlan } from './validator.js';
import type { Plan, PlanStep, Ref, Sha256 } from './model.js';

/** Private P2 deliberation contracts.  This module deliberately has no I/O,
 * scheduler, store, worker, or authority dependencies. */

export type Gear = 'DIRECT' | 'FOCUS' | 'EXPLORE';
export type ProjectedRef = { id: string; digest: Sha256; scope: string | null };
export type ValidationCode = 'NON_CANONICAL' | 'EXTRA_KEY' | 'MISSING_KEY' | 'INVALID_REF' | 'FOREIGN_REF' | 'INVALID_LIMIT' | 'LIMIT_EXCEEDED' | 'INVALID_GEAR' | 'INVALID_LENS' | 'INVALID_FRAME' | 'INVALID_SLOT' | 'INVALID_REPORT' | 'INVALID_LOCATOR' | 'POOL_PARTITION' | 'SCORE_RANGE' | 'RANKING' | 'PREDECESSOR' | 'CARDINALITY' | 'TOPOLOGY' | 'INPUT_TOO_LARGE' | 'CONFLICT' | 'STALE';
export type Validation<T> = { ok: true; value: T } | { ok: false; code: ValidationCode; path: string; message: string };

export type PlanAuthorshipInput = { runId: string; phaseId: string; intent: Ref; evidenceSnapshot: Ref; authorityDigest: Sha256; policyVersion: Ref; settlements: readonly Ref[] };
export type DecisionFrontier = { key: string; prospectiveEffectFrontierOrdinal: number; settled: boolean; witness: boolean; unresolvedDiscriminator?: string };
export type GearPredicates = { decisionUnsettled: boolean; explicitExplore: boolean; citedWitness: boolean; planEquivalent: boolean; containedDiscovery: boolean; openEnded: boolean; highStakes: boolean; openlyPhrased: boolean; namedDiscriminator: boolean };
export type DeliberationPolicy = Readonly<{ version: Ref; frameCatalog: readonly { frameId: string; tag: 'code' | 'design' | 'wild'; text: string }[]; maxMaterialDecisions: number; maxSettlementBytes: number; maxResolvedRoleInputBytes: number; convergeCount: number; nonObviousNovelty: number; viableFloor: number }>;
export type GearProposal = { gear: 'DIRECT' } | { gear: 'FOCUS' | 'EXPLORE'; decisionKey: string; frontierOrdinal: number } | { gear: 'NO_SETTLEMENT'; reason: Ref };
export type PlanAuthorshipResult = { kind: 'COMPLETE_PLAN'; plan: Plan } | { kind: 'DELIBERATION_REQUIRED'; wave: Ref } | { kind: 'NO_SETTLEMENT'; reason: Ref };
/** Closed parent dissent disposition carried by managed settlement records.
 * The v1 profile intentionally admits only an explicit no-dissent value; a
 * future profile may add a typed winner-relative rival without reopening this
 * opaque boundary. */
export type ManagedDissent = { kind: 'NONE' };

export function isManagedDissent(value: unknown): value is ManagedDissent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 1 && candidate.kind === 'NONE';
}

export type DeliberationWave = {
  schema: 'lunacy-deliberation-wave/v2';
  authorship: { runId: string; phaseId: string; intent: Ref; evidenceSnapshot: Ref; authorityDigest: Sha256; policyVersion: Ref; settlementPrefixDigest: Sha256; decisionKey: string; prospectiveEffectFrontierOrdinal: number };
  question: { text: string; decisionImpact: string; discriminator?: string; evidence: readonly Ref[]; constraints: readonly Ref[] };
  limits: { maxModelCalls: number; maxWaveBytes: number; maxRefs: number; maxResolvedRoleInputBytes: number; maxReportBytes: number; maxTotalReportBytes: number };
} & ({ gear: 'FOCUS'; generatorLenses: readonly { text: string }[] } | { gear: 'EXPLORE'; generatorLenses: readonly { frameId: string }[] });

export type SlotRole = 'GENERATOR' | 'CRITIC' | 'DEEPENER';
export type TopologySlot = { slotOrdinal: number; role: SlotRole; dependencies: readonly number[]; stepId: string; route: { model: 'gpt-5.6-luna'; effort: 'max' } };
export type DeliberationTopology = { slots: readonly TopologySlot[]; edges: readonly { from: number; to: number }[]; terminalGate: 'PARENT_REQUIRED' };
export type ResolvedRef = { ref: Ref; bytes: string; size: number };

export type BaseReport = { schema: 'lunacy-deliberation-report/v2'; wave: Ref; slotOrdinal: number };
export type Idea = { text: string; rationale: string };
export type IdeaLocator = { generatorReport: Ref; oneBasedOrdinal: number };
export type GeneratorReport = BaseReport & { ideas: readonly Idea[] };
export type CriticReport = BaseReport & { scores: readonly { idea: IdeaLocator; novelty: number; viability: number; fit: number; trap?: string; evidence: readonly Ref[] }[]; clusters: readonly { label: string; ideas: readonly IdeaLocator[] }[] };
export type DeepenerReport = BaseReport & { sketch: string; loadBearingRisk: string; firstConcreteStep: string; childIdeas: readonly [string, string, string, string?, string?] };
export type DeliberationReport = GeneratorReport | CriticReport | DeepenerReport;
export type AcceptedReport = { ref: Ref; report: DeliberationReport; receipt: { commandDigest: Sha256; resultDigest: Sha256; attemptEpoch: number } };
type AcceptedReportIndex = ReadonlyMap<string, AcceptedReport>;
/** Provider-facing predecessor projections.  The accepted Report Ref binds
 * the complete durable Report while every embedded Ref is provenance-only;
 * canonical bytes (most importantly Wave bytes) never cross the role seam. */
export type RoleRef = { id: string; digest: Sha256; scope?: string };
export type RoleGeneratorReport = Omit<GeneratorReport, 'wave'> & { wave: RoleRef };
export type RoleCriticReport = Omit<CriticReport, 'wave' | 'scores' | 'clusters'> & {
  wave: RoleRef;
  scores: readonly { idea: { generatorReport: RoleRef; oneBasedOrdinal: number }; novelty: number; viability: number; fit: number; trap?: string; evidence: readonly RoleRef[] }[];
  clusters: readonly { label: string; ideas: readonly { generatorReport: RoleRef; oneBasedOrdinal: number }[] }[];
};
export type RoleBoundReport<T> = { ref: RoleRef; report: T };
export type ReconcileResult = { architecture: 'COMPLETE' | 'MISSING' | 'CONFLICT' | 'STALE'; reports: readonly DeliberationReport[]; refs: readonly Ref[]; missingSlots: readonly number[]; reason?: string };
export type GeneratorView = { kind: 'GENERATOR'; question: string; decisionImpact: string; discriminator?: string; evidence: readonly ResolvedRef[]; constraints: readonly ResolvedRef[]; lens: { text: string }; contract: string };
export type CriticView = { kind: 'CRITIC'; question: string; decisionImpact: string; discriminator?: string; evidence: readonly ResolvedRef[]; constraints: readonly ResolvedRef[]; generators: readonly RoleBoundReport<RoleGeneratorReport>[]; contract: string };
export type DeepenerView = { kind: 'DEEPENER'; question: string; decisionImpact: string; discriminator?: string; evidence: readonly ResolvedRef[]; constraints: readonly ResolvedRef[]; critic: RoleBoundReport<RoleCriticReport>; selected: { idea: Idea; generatorReport: RoleRef; oneBasedOrdinal: number }; contract: string };

const fail = <T>(code: ValidationCode, path: string, message: string): Validation<T> => ({ ok: false, code, path, message });
const ok = <T>(value: T): Validation<T> => ({ ok: true, value });
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
const exact = (v: Record<string, unknown>, keys: readonly string[], path: string): Validation<true> => {
  const actual = Object.keys(v); const wanted = [...keys];
  const extra = actual.filter((k) => !wanted.includes(k)); const missing = wanted.filter((k) => !actual.includes(k));
  if (extra.length) return fail('EXTRA_KEY', path, `unknown key ${extra[0]}`);
  if (missing.length) return fail('MISSING_KEY', path, `missing key ${missing[0]}`);
  return ok(true);
};
const safeInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const refKey = (r: Ref | ProjectedRef): string => `${r.id}\u0000${r.digest}\u0000${r.scope ?? ''}`;
/** Exact identity used by admitted provenance sets.  Callers must not be
 * able to match a Ref by only its id or digest: both are untrusted aliases. */
const provenanceKey = (r: Ref | ProjectedRef): string => canonicalString({ id: r.id, digest: r.digest, scope: r.scope ?? null });
const sameRef = (a: Ref, b: Ref): boolean => a.id === b.id && a.digest === b.digest && (a.scope ?? null) === (b.scope ?? null);
const hasRef = (set: ReadonlySet<string>, r: Ref): boolean => set.has(provenanceKey(r));
const roleRef = (ref: Ref): RoleRef => ({ id: ref.id, digest: ref.digest, ...(ref.scope === undefined ? {} : { scope: ref.scope }) });
const roleGeneratorReport = (report: GeneratorReport): RoleGeneratorReport => ({ schema: report.schema, wave: roleRef(report.wave), slotOrdinal: report.slotOrdinal, ideas: report.ideas.map((idea) => ({ text: idea.text, rationale: idea.rationale })) });
const roleLocator = (locator: IdeaLocator): { generatorReport: RoleRef; oneBasedOrdinal: number } => ({ generatorReport: roleRef(locator.generatorReport), oneBasedOrdinal: locator.oneBasedOrdinal });
const roleCriticReport = (report: CriticReport): RoleCriticReport => ({
  schema: report.schema,
  wave: roleRef(report.wave),
  slotOrdinal: report.slotOrdinal,
  scores: report.scores.map((score) => ({ idea: roleLocator(score.idea), novelty: score.novelty, viability: score.viability, fit: score.fit, ...(score.trap === undefined ? {} : { trap: score.trap }), evidence: score.evidence.map(roleRef) })),
  clusters: report.clusters.map((cluster) => ({ label: cluster.label, ideas: cluster.ideas.map(roleLocator) })),
});

export function validateRef(value: unknown): Validation<Ref> {
  if (!isObj(value)) return fail('INVALID_REF', '', 'ref must be a plain object');
  const keys = exact(value, ['id', 'digest', 'scope', 'bytes'].filter((k) => value[k] !== undefined), 'ref');
  if (!keys.ok) return keys as Validation<Ref>;
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)) return fail('INVALID_REF', 'ref', 'id/digest malformed');
  if (value.scope !== undefined && (typeof value.scope !== 'string' || value.scope.length === 0)) return fail('INVALID_REF', 'ref.scope', 'scope malformed');
  if (value.bytes !== undefined) {
    if (typeof value.bytes !== 'string') return fail('INVALID_REF', 'ref.bytes', 'bytes must be a string');
    try {
      const parsed = parseCanonical<unknown>(value.bytes);
      if (digest(parsed) !== value.digest) return fail('INVALID_REF', 'ref.bytes', 'bytes digest mismatch');
    } catch { return fail('NON_CANONICAL', 'ref.bytes', 'bytes are not canonical JSON'); }
  }
  return ok({ id: value.id, digest: value.digest as Sha256, ...(value.scope === undefined ? {} : { scope: value.scope }), ...(value.bytes === undefined ? {} : { bytes: value.bytes }) });
}

export function projectRef(value: unknown): Validation<ProjectedRef> {
  const result = validateRef(value); return result.ok ? ok({ id: result.value.id, digest: result.value.digest, scope: result.value.scope ?? null }) : result as Validation<ProjectedRef>;
}

export function settlementPrefixDigest(settlements: readonly Ref[]): Sha256 {
  if (!Array.isArray(settlements)) throw new TypeError('settlements must be an array');
  const projected = settlements.map((r) => { const p = projectRef(r); if (!p.ok) throw new TypeError(p.message); return p.value; });
  return digest({ domain: 'lunacy/settlement-prefix/v1', settlements: projected });
}

export function authorshipInputDigest(input: PlanAuthorshipInput): Sha256 {
  if (!isObj(input)) throw new TypeError('authorship input is malformed');
  for (const [name, value] of [['intent', input.intent], ['evidenceSnapshot', input.evidenceSnapshot], ['policyVersion', input.policyVersion]] as const) { const p = projectRef(value); if (!p.ok) throw new TypeError(`${name}: ${p.message}`); }
  if (!Array.isArray(input.settlements)) throw new TypeError('settlements must be an array');
  const refs = input.settlements.map((r) => { const p = projectRef(r); if (!p.ok) throw new TypeError(p.message); return p.value; });
  if (typeof input.runId !== 'string' || typeof input.phaseId !== 'string' || typeof input.authorityDigest !== 'string' || !/^[0-9a-f]{64}$/.test(input.authorityDigest)) throw new TypeError('authorship identity malformed');
  const intent = projectRef(input.intent); const evidenceSnapshot = projectRef(input.evidenceSnapshot); const policyVersion = projectRef(input.policyVersion);
  if (!intent.ok || !evidenceSnapshot.ok || !policyVersion.ok) throw new TypeError('invalid authorship refs');
  const prefix = digest({ domain: 'lunacy/settlement-prefix/v1', settlements: refs });
  return digest({ domain: 'lunacy/authorship-input/v1', runId: input.runId, phaseId: input.phaseId, intent: intent.value, evidenceSnapshot: evidenceSnapshot.value, authorityDigest: input.authorityDigest, policyVersion: policyVersion.value, settlementPrefixDigest: prefix });
}

export function firstUnsettledDecision(frontier: readonly DecisionFrontier[]): DecisionFrontier | undefined {
  return [...frontier].filter((d) => !d.settled).sort((a, b) => a.prospectiveEffectFrontierOrdinal - b.prospectiveEffectFrontierOrdinal || compareStable(a.key, b.key))[0];
}

export function settlementWitness(predicates: GearPredicates): 'SETTLED' | 'BOUNDED' | 'OPEN' {
  if (!predicates.decisionUnsettled) return 'SETTLED';
  if (predicates.citedWitness || predicates.planEquivalent || predicates.containedDiscovery || predicates.namedDiscriminator) return 'BOUNDED';
  return 'OPEN';
}

export function selectGear(predicates: GearPredicates): Gear {
  if (!predicates.decisionUnsettled) return 'DIRECT';
  if (predicates.explicitExplore) return 'EXPLORE';
  if (predicates.citedWitness || predicates.planEquivalent || predicates.containedDiscovery) return 'DIRECT';
  if (predicates.openEnded && predicates.highStakes && predicates.openlyPhrased) return 'EXPLORE';
  if (predicates.namedDiscriminator) return 'FOCUS';
  return 'FOCUS';
}

const reasonRef = (reason: string, input?: unknown): Ref => { const value = { domain: 'lunacy/no-settlement/v1', reason, ...(input === undefined ? {} : { input }) }; return { id: `no-settlement:${digest(value).slice(0, 16)}`, digest: digest(value), scope: 'deliberation', bytes: canonicalString(value) }; };

export function proposeGear(input: { frontier: readonly DecisionFrontier[]; predicates: GearPredicates; decisionKey: string; frontierOrdinal: number; policyAvailable: boolean; budgetAvailable: boolean }): GearProposal {
  if (!input.predicates.decisionUnsettled) return { gear: 'DIRECT' };
  const selected = selectGear(input.predicates); if (selected === 'DIRECT') return { gear: 'DIRECT' };
  if (!input.policyAvailable) return { gear: 'NO_SETTLEMENT', reason: reasonRef('POLICY_UNAVAILABLE', input.decisionKey) };
  if (!input.budgetAvailable) return { gear: 'NO_SETTLEMENT', reason: reasonRef('BUDGET_UNAVAILABLE', input.decisionKey) };
  const frontier = firstUnsettledDecision(input.frontier); const key = frontier?.key ?? input.decisionKey; const ordinal = frontier?.prospectiveEffectFrontierOrdinal ?? input.frontierOrdinal;
  return { gear: selected, decisionKey: key, frontierOrdinal: ordinal };
}

function defaultLimits(policy: DeliberationPolicy, gear: Gear): DeliberationWave['limits'] {
  const slots = gear === 'EXPLORE' ? 9 : gear === 'FOCUS' ? 4 : 1; const reportBytes = Math.max(1, Math.floor(policy.maxSettlementBytes / slots));
  return { maxModelCalls: gear === 'EXPLORE' ? 9 : gear === 'FOCUS' ? 4 : 0, maxWaveBytes: policy.maxSettlementBytes, maxRefs: 128, maxResolvedRoleInputBytes: policy.maxResolvedRoleInputBytes, maxReportBytes: reportBytes, maxTotalReportBytes: policy.maxSettlementBytes };
}

export function authorPlan(input: PlanAuthorshipInput, predicates: GearPredicates, policy?: DeliberationPolicy): PlanAuthorshipResult {
  const gear = selectGear(predicates);
  if (gear === 'DIRECT') {
    try {
      const bound = validateRef(input.intent); if (!bound.ok) return { kind: 'NO_SETTLEMENT', reason: reasonRef('DIRECT_INTENT_INVALID') };
      if (typeof input.intent.bytes !== 'string') return { kind: 'NO_SETTLEMENT', reason: reasonRef('DIRECT_INTENT_UNAVAILABLE') };
      const parsed = parseCanonical<Plan>(input.intent.bytes); const plan = validatePlan(parsed).plan; if (plan.phaseId !== input.phaseId) return { kind: 'NO_SETTLEMENT', reason: reasonRef('DIRECT_PLAN_PHASE_MISMATCH', { expected: input.phaseId, actual: plan.phaseId }) }; return { kind: 'COMPLETE_PLAN', plan };
    } catch { return { kind: 'NO_SETTLEMENT', reason: reasonRef('DIRECT_INTENT_INVALID') }; }
  }
  if (!policy) return { kind: 'NO_SETTLEMENT', reason: reasonRef('POLICY_UNAVAILABLE') };
  const admittedPolicy = policyBinding(policy, input.policyVersion);
  if (!admittedPolicy.ok) return { kind: 'NO_SETTLEMENT', reason: reasonRef('POLICY_INVALID') };
  const frontierKey = input.intent.id; const ordinal = 0;
  const codeDesign = policy.frameCatalog.filter((f) => f.tag === 'code' || f.tag === 'design'); const wild = policy.frameCatalog.filter((f) => f.tag === 'wild');
  if (codeDesign.length < 4 || wild.length < 1) return { kind: 'NO_SETTLEMENT', reason: reasonRef('FRAME_CATALOG_INSUFFICIENT') };
  const wave: DeliberationWave = {
    schema: 'lunacy-deliberation-wave/v2',
    authorship: { runId: input.runId, phaseId: input.phaseId, intent: input.intent, evidenceSnapshot: input.evidenceSnapshot, authorityDigest: input.authorityDigest, policyVersion: input.policyVersion, settlementPrefixDigest: settlementPrefixDigest(input.settlements), decisionKey: frontierKey, prospectiveEffectFrontierOrdinal: ordinal },
    question: { text: input.intent.id, decisionImpact: 'prospective effect', evidence: [], constraints: [] },
    limits: defaultLimits(policy, gear),
    ...(gear === 'FOCUS' ? { gear, generatorLenses: [{ text: 'counterexample' }, { text: 'simplify' }] } : { gear, generatorLenses: [...policy.frameCatalog.filter((f) => f.tag === 'code' || f.tag === 'design').slice(0, 4), ...policy.frameCatalog.filter((f) => f.tag === 'wild').slice(0, 1)].map((f) => ({ frameId: f.frameId })) }),
  } as DeliberationWave;
  const admittedWave = validateWave(wave, { runId: input.runId, phaseId: input.phaseId, policy, committedEvidence: new Set(), reachableConstraints: new Set() });
  if (!admittedWave.ok) return { kind: 'NO_SETTLEMENT', reason: reasonRef('WAVE_NOT_ADMISSIBLE') };
  const bytes = canonicalString(wave); const d = digest(wave); const ref: Ref = { id: `wave:${d.slice(0, 16)}`, digest: d, scope: 'deliberation/wave', bytes }; return { kind: 'DELIBERATION_REQUIRED', wave: ref };
}

type ParsedInput = { value: unknown; originalBytes: Uint8Array };

function parseWaveInput(valueOrBytes: unknown): Validation<ParsedInput> {
  if (isObj(valueOrBytes) && 'id' in valueOrBytes && 'digest' in valueOrBytes && 'bytes' in valueOrBytes) {
    const keys = exact(valueOrBytes, ['id', 'digest', 'scope', 'bytes'].filter((key) => valueOrBytes[key] !== undefined), 'wave.ref');
    if (!keys.ok) return keys as Validation<ParsedInput>;
    if (typeof valueOrBytes.id !== 'string' || valueOrBytes.id.length === 0 || typeof valueOrBytes.digest !== 'string' || !/^[0-9a-f]{64}$/.test(valueOrBytes.digest) || typeof valueOrBytes.bytes !== 'string' || (valueOrBytes.scope !== undefined && (typeof valueOrBytes.scope !== 'string' || valueOrBytes.scope.length === 0))) return fail('INVALID_REF', 'wave.ref', 'wave ref is malformed');
    const originalBytes = new TextEncoder().encode(valueOrBytes.bytes);
    if (digestBytes(originalBytes) !== valueOrBytes.digest) return fail('INVALID_REF', 'wave.ref.digest', 'wave bytes digest mismatch');
    try { return ok({ value: parseCanonical<unknown>(originalBytes), originalBytes }); } catch { return fail('NON_CANONICAL', 'wave.ref.bytes', 'non-canonical JSON'); }
  }
  if (typeof valueOrBytes === 'string') {
    const originalBytes = new TextEncoder().encode(valueOrBytes);
    try { return ok({ value: parseCanonical<unknown>(originalBytes), originalBytes }); } catch { return fail('NON_CANONICAL', '', 'non-canonical JSON'); }
  }
  if (valueOrBytes instanceof Uint8Array) {
    const originalBytes = valueOrBytes.slice();
    try { return ok({ value: parseCanonical<unknown>(originalBytes), originalBytes }); } catch { return fail('NON_CANONICAL', '', 'non-canonical JSON'); }
  }
  try { const originalBytes = new TextEncoder().encode(canonicalString(valueOrBytes)); return ok({ value: valueOrBytes, originalBytes }); } catch { return fail('NON_CANONICAL', '', 'value is not canonical JSON'); }
}

function parseInput(valueOrBytes: unknown): Validation<unknown> {
  if (typeof valueOrBytes === 'string') { try { return ok(parseCanonical<unknown>(valueOrBytes)); } catch { return fail('NON_CANONICAL', '', 'non-canonical JSON'); } }
  if (valueOrBytes instanceof Uint8Array) { try { return ok(parseCanonical<unknown>(valueOrBytes)); } catch { return fail('NON_CANONICAL', '', 'non-canonical JSON'); } }
  try { canonicalString(valueOrBytes); return ok(valueOrBytes); } catch { return fail('NON_CANONICAL', '', 'value is not canonical JSON'); }
}

function policyValid(policy: DeliberationPolicy): Validation<true> {
  if (!policy || !isObj(policy)) return fail('INVALID_LIMIT', 'policy', 'policy malformed');
  const pk = exact(policy, ['version', 'frameCatalog', 'maxMaterialDecisions', 'maxSettlementBytes', 'maxResolvedRoleInputBytes', 'convergeCount', 'nonObviousNovelty', 'viableFloor'], 'policy'); if (!pk.ok) return pk as Validation<true>;
  for (const n of ['maxMaterialDecisions', 'maxSettlementBytes', 'maxResolvedRoleInputBytes', 'convergeCount', 'nonObviousNovelty', 'viableFloor'] as const) if (!safeInt(policy[n])) return fail('INVALID_LIMIT', `policy.${n}`, 'must be a non-negative safe integer');
  if (policy.convergeCount < 2 || policy.convergeCount > 4) return fail('INVALID_LIMIT', 'policy.convergeCount', 'convergeCount must be 2-4');
  if (policy.nonObviousNovelty > 10 || policy.viableFloor > 10) return fail('INVALID_LIMIT', 'policy', 'score thresholds must be within 0-10');
  const p = validateRef(policy.version); if (!p.ok) return p as Validation<true>;
  if (!Array.isArray(policy.frameCatalog)) return fail('INVALID_FRAME', 'policy.frameCatalog', 'frame catalog must be an array');
  const frameIds = new Set<string>();
  for (const frame of policy.frameCatalog) { if (!isObj(frame)) return fail('INVALID_FRAME', 'policy.frameCatalog', 'frame malformed'); const fk = exact(frame, ['frameId', 'tag', 'text'], 'policy.frameCatalog'); if (!fk.ok) return fk as Validation<true>; if (typeof frame.frameId !== 'string' || frame.frameId.length === 0 || typeof frame.text !== 'string' || !['code', 'design', 'wild'].includes(String(frame.tag))) return fail('INVALID_FRAME', 'policy.frameCatalog', 'frame malformed'); if (frameIds.has(frame.frameId)) return fail('INVALID_FRAME', 'policy.frameCatalog', 'duplicate frameId'); frameIds.add(frame.frameId); }
  return ok(true);
}

/** One policy admission/binding invariant shared by every Wave+policy seam. */
function policyBinding(policy: DeliberationPolicy, wavePolicyVersion: unknown): Validation<true> {
  const pv = policyValid(policy); if (!pv.ok) return pv;
  const waveVersion = validateRef(wavePolicyVersion); if (!waveVersion.ok) return fail('INVALID_REF', 'wave.authorship.policyVersion', 'wave policy version is malformed');
  if (!sameRef(waveVersion.value, policy.version)) return fail('FOREIGN_REF', 'wave.authorship.policyVersion', 'policy version is not the admitted policy');
  return ok(true);
}

export function validateWave(valueOrBytes: unknown, ctx: { runId: string; phaseId: string; policy: DeliberationPolicy; committedEvidence: ReadonlySet<string>; reachableConstraints: ReadonlySet<string> }): Validation<DeliberationWave> {
  const parsed = parseWaveInput(valueOrBytes); if (!parsed.ok) return parsed as Validation<DeliberationWave>; if (!isObj(parsed.value.value)) return fail('INVALID_FRAME', '', 'wave must be an object'); const value = parsed.value.value;
  const keys = exact(value, ['schema', 'authorship', 'question', 'limits', 'gear', 'generatorLenses'], 'wave'); if (!keys.ok) return keys as Validation<DeliberationWave>;
  if (value.schema !== 'lunacy-deliberation-wave/v2') return fail('INVALID_FRAME', 'wave.schema', 'schema mismatch'); if (value.gear !== 'FOCUS' && value.gear !== 'EXPLORE') return fail('INVALID_GEAR', 'wave.gear', 'invalid gear');
  if (!isObj(value.authorship) || !isObj(value.question) || !isObj(value.limits) || !Array.isArray(value.generatorLenses)) return fail('INVALID_FRAME', 'wave', 'wave sections malformed');
  const ak = exact(value.authorship, ['runId', 'phaseId', 'intent', 'evidenceSnapshot', 'authorityDigest', 'policyVersion', 'settlementPrefixDigest', 'decisionKey', 'prospectiveEffectFrontierOrdinal'], 'wave.authorship'); if (!ak.ok) return ak as Validation<DeliberationWave>;
  if (value.authorship.runId !== ctx.runId || value.authorship.phaseId !== ctx.phaseId || typeof value.authorship.decisionKey !== 'string' || !safeInt(value.authorship.prospectiveEffectFrontierOrdinal)) return fail('FOREIGN_REF', 'wave.authorship', 'authorship identity mismatch');
  for (const key of ['intent', 'evidenceSnapshot'] as const) { const r = validateRef(value.authorship[key]); if (!r.ok) return fail('INVALID_REF', `wave.authorship.${key}`, r.message); }
  const boundPolicy = policyBinding(ctx.policy, value.authorship.policyVersion); if (!boundPolicy.ok) return boundPolicy as Validation<DeliberationWave>;
  if (typeof value.authorship.authorityDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.authorship.authorityDigest) || typeof value.authorship.settlementPrefixDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.authorship.settlementPrefixDigest)) return fail('INVALID_REF', 'wave.authorship', 'digest malformed');
  const qk = exact(value.question, ['text', 'decisionImpact', 'evidence', 'constraints', ...(value.question.discriminator === undefined ? [] : ['discriminator'])], 'wave.question'); if (!qk.ok) return qk as Validation<DeliberationWave>;
  if (typeof value.question.text !== 'string' || typeof value.question.decisionImpact !== 'string' || (value.question.discriminator !== undefined && typeof value.question.discriminator !== 'string') || !Array.isArray(value.question.evidence) || !Array.isArray(value.question.constraints)) return fail('INVALID_FRAME', 'wave.question', 'question malformed');
  for (const [kind, refs] of [['evidence', value.question.evidence], ['constraints', value.question.constraints]] as const) { const seen = new Set<string>(); for (let i = 0; i < refs.length; i += 1) { const r = validateRef(refs[i]); if (!r.ok) return fail('INVALID_REF', `wave.question.${kind}[${i}]`, r.message); if (kind === 'evidence' && !hasRef(ctx.committedEvidence, r.value)) return fail('FOREIGN_REF', `wave.question.evidence[${i}]`, 'evidence not committed'); if (kind === 'constraints' && !hasRef(ctx.reachableConstraints, r.value)) return fail('FOREIGN_REF', `wave.question.constraints[${i}]`, 'constraint not reachable'); if (seen.has(refKey(r.value))) return fail('INVALID_REF', `wave.question.${kind}[${i}]`, 'duplicate ref'); seen.add(refKey(r.value)); } }
  const retainedLimitKeys = ['maxModelCalls', 'maxWaveBytes', 'maxRefs', 'maxResolvedRoleInputBytes', 'maxReportBytes', 'maxTotalReportBytes'];
  const legacyLimitKeys = ['maxInputTokens', 'maxOutputTokens', 'maxWallClockMs'];
  const actualLimitKeys = Object.keys(value.limits); const admittedLimitKeys = [...retainedLimitKeys, ...legacyLimitKeys];
  const extraLimitKeys = actualLimitKeys.filter((key) => !admittedLimitKeys.includes(key)); const missingLimitKeys = retainedLimitKeys.filter((key) => !actualLimitKeys.includes(key));
  if (extraLimitKeys.length) return fail('EXTRA_KEY', 'wave.limits', `unknown key ${extraLimitKeys[0]}`);
  if (missingLimitKeys.length) return fail('MISSING_KEY', 'wave.limits', `missing key ${missingLimitKeys[0]}`);
  for (const key of Object.keys(value.limits)) if (!safeInt(value.limits[key])) return fail('INVALID_LIMIT', `wave.limits.${key}`, 'must be a finite safe integer');
  if (value.gear === 'FOCUS') {
    for (const lens of value.generatorLenses) if (!isObj(lens) || Object.keys(lens).some((k) => k !== 'text') || typeof lens.text !== 'string' || lens.text.length === 0) return fail('INVALID_LENS', 'wave.generatorLenses', 'invalid Focus lens');
    const texts = value.generatorLenses.map((l) => l.text); if (texts.length < 2 || texts.length > 3 || new Set(texts).size !== texts.length) return fail('CARDINALITY', 'wave.generatorLenses', 'Focus requires 2-3 distinct lenses');
    if ((value.limits.maxModelCalls as number) < texts.length + 1) return fail('LIMIT_EXCEEDED', 'wave.limits.maxModelCalls', 'Focus model-call ceiling is too low');
  } else {
    for (const frame of value.generatorLenses) if (!isObj(frame) || Object.keys(frame).some((k) => k !== 'frameId') || typeof frame.frameId !== 'string') return fail('INVALID_FRAME', 'wave.generatorLenses', 'invalid Explore frame');
    const ids = value.generatorLenses.map((f) => f.frameId); if (ids.length !== 5 || new Set(ids).size !== 5) return fail('CARDINALITY', 'wave.generatorLenses', 'Explore requires five distinct frames');
    const catalog = new Map(ctx.policy.frameCatalog.map((f) => [f.frameId, f])); let codeDesign = 0; let wild = 0; for (const id of ids) { const frame = catalog.get(id); if (!frame) return fail('INVALID_FRAME', 'wave.generatorLenses', `unknown frame ${id}`); if (frame.tag === 'wild') wild += 1; else codeDesign += 1; } if (codeDesign !== 4 || wild !== 1) return fail('CARDINALITY', 'wave.generatorLenses', 'Explore requires four code/design and one wild frame');
    if ((value.limits.maxModelCalls as number) < 9) return fail('LIMIT_EXCEEDED', 'wave.limits.maxModelCalls', 'Explore model-call ceiling is too low');
  }
  const refs = [...value.question.evidence, ...value.question.constraints]; if (refs.length + 3 > (value.limits.maxRefs as number)) return fail('LIMIT_EXCEEDED', 'wave.limits.maxRefs', 'reference ceiling exceeded');
  const maxWaveBytes = value.limits.maxWaveBytes as number; const maxResolved = value.limits.maxResolvedRoleInputBytes as number; const maxReport = value.limits.maxReportBytes as number; const maxTotal = value.limits.maxTotalReportBytes as number;
  const topologySlots = value.gear === 'EXPLORE' ? 9 : value.generatorLenses.length + 1;
  // Charge every Wave-authorship Ref, every BaseReport.wave occurrence, and
  // the closed critic locator/evidence ceiling before any provider attempt.
  // Locator occurrences are score + cluster references; the evidence ceiling
  // reserves one sealed provenance Ref per scored idea.  Actual evidence may
  // use more of the admitted headroom but can never exceed maxRefs.
  const ideaCount = value.gear === 'EXPLORE' ? 5 * 6 : value.generatorLenses.length;
  const locatorOccurrences = ideaCount * 2;
  const criticEvidenceCeiling = ideaCount;
  const nominalRefs = 3 + refs.length + topologySlots + locatorOccurrences + criticEvidenceCeiling;
  if (parsed.value.originalBytes.byteLength > maxWaveBytes || maxWaveBytes > ctx.policy.maxSettlementBytes || maxResolved > ctx.policy.maxResolvedRoleInputBytes || maxReport > ctx.policy.maxSettlementBytes || maxTotal > ctx.policy.maxSettlementBytes || maxTotal < maxReport * topologySlots || (value.limits.maxRefs as number) < nominalRefs) return fail('LIMIT_EXCEEDED', 'wave.limits', 'policy or cumulative quota exceeded');
  const normalizedLimits = Object.fromEntries(retainedLimitKeys.map((key) => [key, (value.limits as Record<string, unknown>)[key]]));
  return ok({ ...value, limits: normalizedLimits } as unknown as DeliberationWave);
}

function slotId(role: SlotRole, ordinal: number, waveRef: Ref): string { return `dw2-${role.toLowerCase()}-${ordinal}-${waveRef.digest.slice(0, 16)}`; }
export function deriveTopology(waveRef: Ref, wave: DeliberationWave): DeliberationTopology {
  const slots: TopologySlot[] = []; const edges: { from: number; to: number }[] = [];
  const generators = wave.gear === 'FOCUS' ? wave.generatorLenses.length : 5; for (let i = 0; i < generators; i += 1) slots.push({ slotOrdinal: i, role: 'GENERATOR', dependencies: [], stepId: slotId('GENERATOR', i, waveRef), route: { model: 'gpt-5.6-luna', effort: 'max' } });
  const critic = generators; slots.push({ slotOrdinal: critic, role: 'CRITIC', dependencies: [...Array(generators).keys()], stepId: slotId('CRITIC', critic, waveRef), route: { model: 'gpt-5.6-luna', effort: 'max' } }); for (let i = 0; i < generators; i += 1) edges.push({ from: i, to: critic });
  if (wave.gear === 'EXPLORE') for (let i = 1; i <= 3; i += 1) { const ordinal = critic + i; slots.push({ slotOrdinal: ordinal, role: 'DEEPENER', dependencies: [critic], stepId: slotId('DEEPENER', ordinal, waveRef), route: { model: 'gpt-5.6-luna', effort: 'max' } }); edges.push({ from: critic, to: ordinal }); }
  return { slots, edges, terminalGate: 'PARENT_REQUIRED' };
}

function exactSlot(actual: TopologySlot, expected: TopologySlot): boolean {
  try { return canonicalString(actual) === canonicalString(expected); } catch { return false; }
}

function acceptedEnvelope(ref: Ref, index: AcceptedReportIndex, path: string): Validation<AcceptedReport> {
  const key = provenanceKey(ref); const envelope = index.get(key);
  if (!envelope || !isObj(envelope)) return fail('PREDECESSOR', path, 'accepted predecessor envelope is missing');
  const envelopeKeys = exact(envelope, ['ref', 'report', 'receipt'], path); if (!envelopeKeys.ok) return envelopeKeys as Validation<AcceptedReport>;
  const envelopeRef = validateRef(envelope.ref); if (!envelopeRef.ok) return fail('INVALID_REF', path, 'accepted predecessor Ref is malformed');
  if (!sameRef(envelopeRef.value, ref)) return fail('FOREIGN_REF', path, 'accepted predecessor Ref does not match requested provenance');
  if (!isObj(envelope.report) || !isObj(envelope.receipt)) return fail('PREDECESSOR', path, 'accepted predecessor envelope is malformed');
  const receiptKeys = exact(envelope.receipt, ['commandDigest', 'resultDigest', 'attemptEpoch'], `${path}.receipt`); if (!receiptKeys.ok) return receiptKeys as Validation<AcceptedReport>;
  if (typeof envelope.receipt.commandDigest !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.receipt.commandDigest) || typeof envelope.receipt.resultDigest !== 'string' || !/^[0-9a-f]{64}$/.test(envelope.receipt.resultDigest) || !safeInt(envelope.receipt.attemptEpoch)) return fail('PREDECESSOR', path, 'accepted predecessor receipt is malformed');
  let reportBytes: string; try { reportBytes = canonicalString(envelope.report); } catch { return fail('NON_CANONICAL', path, 'accepted predecessor Report is not canonical'); }
  if (typeof envelopeRef.value.bytes !== 'string' || envelopeRef.value.bytes !== reportBytes || digest(envelope.report) !== envelopeRef.value.digest || envelope.receipt.resultDigest !== envelopeRef.value.digest) return fail('FOREIGN_REF', path, 'accepted predecessor Report/Ref/receipt digests disagree');
  return ok({ ref: envelopeRef.value, report: envelope.report as DeliberationReport, receipt: envelope.receipt });
}

function directPredecessors(input: { waveRef: Ref; wave: DeliberationWave; slot: TopologySlot; predecessorRefs: readonly Ref[]; acceptedReportsByRef: AcceptedReportIndex; policy: DeliberationPolicy }): Validation<DeliberationReport[]> {
  if (input.predecessorRefs.length !== input.slot.dependencies.length) return fail('PREDECESSOR', 'predecessorRefs', 'predecessor closure cardinality does not match topology');
  const topology = deriveTopology(input.waveRef, input.wave); const reports: DeliberationReport[] = [];
  for (let i = 0; i < input.predecessorRefs.length; i += 1) {
    const requested = validateRef(input.predecessorRefs[i]); if (!requested.ok) return requested as Validation<DeliberationReport[]>;
    const dependencyOrdinal = input.slot.dependencies[i]; const dependencySlot = topology.slots[dependencyOrdinal]; if (!dependencySlot) return fail('INVALID_SLOT', `predecessorRefs[${i}]`, 'predecessor slot is not derived');
    const envelope = acceptedEnvelope(requested.value, input.acceptedReportsByRef, `predecessorRefs[${i}]`); if (!envelope.ok) return envelope as Validation<DeliberationReport[]>;
    if (!sameRef(envelope.value.report.wave, input.waveRef) || envelope.value.report.slotOrdinal !== dependencySlot.slotOrdinal) return fail('FOREIGN_REF', `predecessorRefs[${i}]`, 'predecessor Report is not the derived current-Wave slot');
    const validated = validateReport(envelope.value.report, { waveRef: input.waveRef, wave: input.wave, slot: dependencySlot, predecessors: [], policy: input.policy }); if (!validated.ok) return validated as Validation<DeliberationReport[]>;
    reports.push(validated.value);
  }
  return ok(reports);
}

export function compileWavePlan(waveRef: Ref, wave: DeliberationWave): Validation<Plan> {
  const topology = deriveTopology(waveRef, wave); const steps: PlanStep[] = topology.slots.map((slot) => ({ stepId: slot.stepId, dependencies: slot.dependencies.map((d) => topology.slots[d].stepId), goal: `${slot.role.toLowerCase()} deliberation slot ${slot.slotOrdinal}` })); return ok({ schema: 'lunacy-plan-v1', phaseId: wave.authorship.phaseId, gateRequired: true, steps });
}
export function verifyWavePlan(plan: Plan, topology: DeliberationTopology): Validation<true> { try { if (plan.gateRequired !== true) return fail('TOPOLOGY', 'plan.gateRequired', 'terminal gate must be parent-required'); const v = validatePlan(plan); const ids = new Set(topology.slots.map((s) => s.stepId)); if (v.plan.steps.length !== topology.slots.length || v.plan.steps.some((s) => !ids.has(s.stepId))) return fail('TOPOLOGY', 'plan.steps', 'plan does not match topology'); for (const slot of topology.slots) { const step = v.plan.steps.find((s) => s.stepId === slot.stepId)!; if (step.claims?.some((c) => c.mode !== 'READ')) return fail('TOPOLOGY', `plan.${slot.stepId}.claims`, 'deliberation slots may not write or exclusively claim resources'); const deps = [...(step.dependencies ?? [])]; const expected = slot.dependencies.map((d) => topology.slots[d].stepId); if (deps.length !== expected.length || deps.some((d) => !expected.includes(d))) return fail('TOPOLOGY', `plan.${slot.stepId}`, 'dependency mismatch'); } return ok(true); } catch (e) { return fail('TOPOLOGY', 'plan', (e as Error).message); } }

function resolvedRefs(wave: DeliberationWave, input: ReadonlyMap<string, ResolvedRef>, policy: DeliberationPolicy): Validation<{ evidence: ResolvedRef[]; constraints: ResolvedRef[] }> {
  const convert = (refs: readonly Ref[], path: string): Validation<ResolvedRef[]> => { const out: ResolvedRef[] = []; let bytes = 0; for (const r of refs) { const p = validateRef(r); if (!p.ok) return p as Validation<ResolvedRef[]>; const found = input.get(provenanceKey(p.value)); if (!found || !isObj(found) || typeof found.bytes !== 'string' || !safeInt(found.size)) return fail('INVALID_REF', path, 'resolved ref missing or unknown size'); const foundRef = validateRef(found.ref); if (!foundRef.ok || !sameRef(foundRef.value, p.value)) return fail('FOREIGN_REF', path, 'resolved value Ref does not match requested provenance'); if (found.size !== Buffer.byteLength(found.bytes, 'utf8')) return fail('INVALID_REF', path, 'resolved ref size mismatch'); let parsed: unknown; try { parsed = parseCanonical(found.bytes); } catch { return fail('NON_CANONICAL', path, 'resolved bytes are not canonical'); } if (digest(parsed) !== p.value.digest) return fail('FOREIGN_REF', path, 'resolved bytes digest does not match requested provenance'); bytes += found.size; if (bytes > policy.maxResolvedRoleInputBytes) return fail('INPUT_TOO_LARGE', path, 'resolved role input exceeds policy'); out.push({ ref: p.value, bytes: found.bytes, size: found.size }); } return ok(out); };
  const evidence = convert(wave.question.evidence, 'evidence'); if (!evidence.ok) return evidence as Validation<{ evidence: ResolvedRef[]; constraints: ResolvedRef[] }>; const constraints = convert(wave.question.constraints, 'constraints'); if (!constraints.ok) return constraints as Validation<{ evidence: ResolvedRef[]; constraints: ResolvedRef[] }>; return ok({ evidence: evidence.value, constraints: constraints.value });
}

function criticGeneratorRefs(report: DeliberationReport): Validation<Ref[]> {
  if (!isObj(report) || !('scores' in report) || !Array.isArray(report.scores)) return fail('INVALID_REPORT', 'critic', 'critic predecessor is malformed');
  const refs: Ref[] = []; const seen = new Set<string>();
  for (const score of report.scores) { if (!isObj(score)) return fail('INVALID_REPORT', 'critic.scores', 'critic score is malformed'); const locator = validateLocator(score.idea); if (!locator.ok) return locator as Validation<Ref[]>; const key = provenanceKey(locator.value.generatorReport); if (!seen.has(key)) { seen.add(key); refs.push(locator.value.generatorReport); } }
  return ok(refs);
}

export function materializeRoleView(input: { waveRef: Ref; wave: DeliberationWave; slot: TopologySlot; predecessorRefs: readonly Ref[]; acceptedReportsByRef: AcceptedReportIndex; resolved: ReadonlyMap<string, ResolvedRef>; policy: DeliberationPolicy }): Validation<GeneratorView | CriticView | DeepenerView> {
  const boundPolicy = policyBinding(input.policy, input.wave.authorship.policyVersion); if (!boundPolicy.ok) return boundPolicy as Validation<GeneratorView | CriticView | DeepenerView>;
  const topology = deriveTopology(input.waveRef, input.wave); const expected = topology.slots.find((s) => s.slotOrdinal === input.slot.slotOrdinal); if (!expected || !exactSlot(input.slot, expected)) return fail('INVALID_SLOT', 'slot', 'slot is not exactly derived from wave');
  const base = resolvedRefs(input.wave, input.resolved, input.policy); if (!base.ok) return base as Validation<GeneratorView | CriticView | DeepenerView>; const common = { question: input.wave.question.text, decisionImpact: input.wave.question.decisionImpact, ...(input.wave.question.discriminator === undefined ? {} : { discriminator: input.wave.question.discriminator }), evidence: base.value.evidence, constraints: base.value.constraints };
  const baseContractBytes = input.slot.role === 'GENERATOR' ? (input.wave.gear === 'FOCUS' ? 'Return exactly one candidate idea.' : 'Return exactly six candidate ideas.') : input.slot.role === 'CRITIC' ? 'Score every idea exactly once and partition the pool into mechanism clusters.' : 'Return a 4–8 sentence sketch, risk, first step, and 3–5 child ideas.';
  let inputBytes = Buffer.byteLength(input.wave.question.text, 'utf8') + Buffer.byteLength(input.wave.question.decisionImpact, 'utf8') + Buffer.byteLength(baseContractBytes, 'utf8');
  if (input.wave.question.discriminator) inputBytes += Buffer.byteLength(input.wave.question.discriminator, 'utf8');
  for (const r of [...base.value.evidence, ...base.value.constraints]) inputBytes += r.size;
  for (const lens of input.wave.generatorLenses) inputBytes += Buffer.byteLength(canonicalString(lens), 'utf8');
  for (const frame of input.policy.frameCatalog) inputBytes += Buffer.byteLength(canonicalString(frame), 'utf8');
  const tooLarge = (): Validation<never> | undefined => inputBytes > input.policy.maxResolvedRoleInputBytes || inputBytes > input.wave.limits.maxResolvedRoleInputBytes ? fail('INPUT_TOO_LARGE', 'role', 'complete role input exceeds byte ceiling') : undefined;
  if (input.slot.role === 'GENERATOR') {
    if (input.predecessorRefs.length !== 0) return fail('PREDECESSOR', 'predecessorRefs', 'generator cannot receive predecessors');
    const lens = input.wave.generatorLenses[input.slot.slotOrdinal]; if (!lens) return fail('INVALID_SLOT', 'slot', 'generator lens is unavailable'); const frame = input.wave.gear === 'EXPLORE' ? input.policy.frameCatalog.find((f) => f.frameId === (lens as { frameId: string }).frameId) : undefined; if (input.wave.gear === 'EXPLORE' && !frame) return fail('INVALID_FRAME', 'slot.lens', 'frame is not in policy catalog'); const limit = tooLarge(); if (limit) return limit as Validation<GeneratorView>;
    if (input.wave.gear === 'FOCUS') return ok({ kind: 'GENERATOR', ...common, lens: lens as { text: string }, contract: 'Return exactly one candidate idea.' });
    return ok({ kind: 'GENERATOR', ...common, lens: { text: frame!.text }, contract: 'Return exactly six candidate ideas.' });
  }
  if (input.slot.role === 'CRITIC') {
    const direct = directPredecessors({ ...input, policy: input.policy }); if (!direct.ok) return direct as Validation<GeneratorView | CriticView | DeepenerView>;
    const generators = (direct.value as GeneratorReport[]).map((report, index) => ({ ref: roleRef(input.predecessorRefs[index]!), report: roleGeneratorReport(report) }));
    for (const predecessor of generators) inputBytes += Buffer.byteLength(canonicalString(predecessor), 'utf8'); const limit = tooLarge(); if (limit) return limit as Validation<CriticView>; return ok({ kind: 'CRITIC', ...common, generators, contract: 'Score every idea exactly once and partition the pool into mechanism clusters.' });
  }
  if (input.predecessorRefs.length !== 1 || input.slot.dependencies.length !== 1) return fail('PREDECESSOR', 'predecessorRefs', 'deepener requires exactly one critic predecessor'); const criticRef = validateRef(input.predecessorRefs[0]); if (!criticRef.ok) return criticRef as Validation<DeepenerView>; const criticEnvelope = acceptedEnvelope(criticRef.value, input.acceptedReportsByRef, 'predecessorRefs[0]'); if (!criticEnvelope.ok) return criticEnvelope as Validation<DeepenerView>; const criticSlot = topology.slots[input.slot.dependencies[0]]; if (!criticSlot || criticSlot.role !== 'CRITIC' || !sameRef(criticEnvelope.value.report.wave, input.waveRef) || criticEnvelope.value.report.slotOrdinal !== criticSlot.slotOrdinal) return fail('FOREIGN_REF', 'predecessorRefs[0]', 'critic predecessor is not the derived current-Wave critic');
  const generatorRefs = criticGeneratorRefs(criticEnvelope.value.report); if (!generatorRefs.ok) return generatorRefs as Validation<DeepenerView>; const generatorsBySlot = new Map<number, GeneratorReport>();
  for (const generatorRef of generatorRefs.value) { const envelope = acceptedEnvelope(generatorRef, input.acceptedReportsByRef, 'acceptedReportsByRef'); if (!envelope.ok) return envelope as Validation<DeepenerView>; if (!sameRef(envelope.value.report.wave, input.waveRef) || !('ideas' in envelope.value.report)) return fail('FOREIGN_REF', 'acceptedReportsByRef', 'generator predecessor is not current-wave'); const generatorSlot = topology.slots[envelope.value.report.slotOrdinal]; if (!generatorSlot || generatorSlot.role !== 'GENERATOR' || generatorsBySlot.has(generatorSlot.slotOrdinal)) return fail('PREDECESSOR', 'acceptedReportsByRef', 'generator closure has duplicate or invalid slot'); const validated = validateReport(envelope.value.report, { waveRef: input.waveRef, wave: input.wave, slot: generatorSlot, predecessors: [], policy: input.policy }); if (!validated.ok) return validated as Validation<DeepenerView>; generatorsBySlot.set(generatorSlot.slotOrdinal, validated.value as GeneratorReport); }
  const expectedGeneratorCount = input.wave.gear === 'EXPLORE' ? 5 : input.wave.generatorLenses.length; if (generatorsBySlot.size !== expectedGeneratorCount || [...Array(expectedGeneratorCount).keys()].some((ordinal) => !generatorsBySlot.has(ordinal))) return fail('PREDECESSOR', 'acceptedReportsByRef', 'generator closure is incomplete'); const generators = [...Array(expectedGeneratorCount).keys()].map((ordinal) => generatorsBySlot.get(ordinal)!);
  const validatedCritic = validateReport(criticEnvelope.value.report, { waveRef: input.waveRef, wave: input.wave, slot: criticSlot, predecessors: generators, policy: input.policy }); if (!validatedCritic.ok) return validatedCritic as Validation<DeepenerView>; const critic = validatedCritic.value as CriticReport;
  const ranked = critic.scores.filter((score) => !score.trap).sort((a, b) => (35 * b.novelty + 40 * b.viability + 25 * b.fit) - (35 * a.novelty + 40 * a.viability + 25 * a.fit) || compareIdeaLocators(a.idea, b.idea, generators)); const criticOrdinal = criticSlot.slotOrdinal; const rank = input.slot.slotOrdinal - criticOrdinal; if (rank < 1 || rank > 3 || ranked.length < 3) return fail('CARDINALITY', 'predecessorRefs', 'deepener requires top three non-traps'); const target = ranked[rank - 1]; const selectedEnvelope = acceptedEnvelope(target.idea.generatorReport, input.acceptedReportsByRef, 'acceptedReportsByRef'); if (!selectedEnvelope.ok) return selectedEnvelope as Validation<DeepenerView>; const selectedGenerator = generators.find((generator) => sameRef(target.idea.generatorReport, reportRefFor(generator))); if (!selectedGenerator || !sameRef(selectedEnvelope.value.ref, reportRefFor(selectedGenerator)) || target.idea.oneBasedOrdinal > selectedGenerator.ideas.length) return fail('PREDECESSOR', 'acceptedReportsByRef', 'selected generator is unavailable'); const selected = { idea: selectedGenerator.ideas[target.idea.oneBasedOrdinal - 1], generatorReport: roleRef(target.idea.generatorReport), oneBasedOrdinal: target.idea.oneBasedOrdinal }; if (!selected.idea) return fail('INVALID_LOCATOR', 'critic.scores', 'selected idea ordinal is unavailable'); const projectedCritic = { ref: roleRef(criticRef.value), report: roleCriticReport(critic) }; inputBytes += Buffer.byteLength(canonicalString(projectedCritic), 'utf8') + Buffer.byteLength(canonicalString(selected), 'utf8'); const limit = tooLarge(); if (limit) return limit as Validation<DeepenerView>; return ok({ kind: 'DEEPENER', ...common, critic: projectedCritic, selected, contract: 'Return a 4–8 sentence sketch, risk, first step, and 3–5 child ideas.' });
}

function reportBase(value: Record<string, unknown>, path: string): Validation<BaseReport> { for (const key of ['schema', 'wave', 'slotOrdinal']) if (!Object.prototype.hasOwnProperty.call(value, key)) return fail('MISSING_KEY', path, `missing key ${key}`); if (value.schema !== 'lunacy-deliberation-report/v2' || !safeInt(value.slotOrdinal)) return fail('INVALID_REPORT', path, 'base report malformed'); const wave = validateRef(value.wave); if (!wave.ok) return wave as Validation<BaseReport>; return ok({ schema: 'lunacy-deliberation-report/v2', wave: wave.value, slotOrdinal: value.slotOrdinal }); }
const sentenceCount = (text: string): number => text.trim().split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).length;
function locatorKey(l: IdeaLocator): string { return `${l.generatorReport.id}\u0000${l.generatorReport.digest}\u0000${l.generatorReport.scope ?? ''}:${l.oneBasedOrdinal}`; }
function reportRefFor(report: GeneratorReport): Ref { const reportDigest = digest(report); return { id: `report:${reportDigest.slice(0, 16)}`, digest: reportDigest, scope: 'deliberation/report' }; }
function orderedGeneratorClosure(waveRef: Ref, wave: DeliberationWave, predecessors: readonly DeliberationReport[], policy: DeliberationPolicy): Validation<GeneratorReport[]> {
  const expectedCount = wave.gear === 'FOCUS' ? wave.generatorLenses.length : 5;
  if (predecessors.length !== expectedCount) return fail('PREDECESSOR', 'predecessors', 'critic predecessor closure is incomplete');
  const generators: GeneratorReport[] = [];
  for (let i = 0; i < predecessors.length; i += 1) {
    const predecessor = predecessors[i];
    if (!isObj(predecessor) || !('ideas' in predecessor)) return fail('PREDECESSOR', `predecessors[${i}]`, 'critic predecessors must all be generators');
    if (predecessor.slotOrdinal !== i) return fail('PREDECESSOR', `predecessors[${i}].slotOrdinal`, 'generator predecessor order must match slot ordinal');
    if (!sameRef(predecessor.wave, waveRef)) return fail('FOREIGN_REF', `predecessors[${i}].wave`, 'generator predecessor belongs to another wave');
    const slot = deriveTopology(waveRef, wave).slots[i]; const validated = validateReport(predecessor, { waveRef, wave, slot, predecessors: [], policy }); if (!validated.ok) return validated as Validation<GeneratorReport[]>; generators.push(validated.value as GeneratorReport);
  }
  return ok(generators);
}
function generatorSlotOrdinal(locator: IdeaLocator, generators: readonly GeneratorReport[]): number {
  return generators.find((generator) => sameRef(locator.generatorReport, reportRefFor(generator)))?.slotOrdinal ?? Number.MAX_SAFE_INTEGER;
}
function compareIdeaLocators(a: IdeaLocator, b: IdeaLocator, generators: readonly GeneratorReport[]): number {
  return generatorSlotOrdinal(a, generators) - generatorSlotOrdinal(b, generators) || a.oneBasedOrdinal - b.oneBasedOrdinal || compareStable(locatorKey(a), locatorKey(b));
}
function validateLocator(l: unknown): Validation<IdeaLocator> { if (!isObj(l)) return fail('INVALID_LOCATOR', 'locator', 'locator malformed'); const k = exact(l, ['generatorReport', 'oneBasedOrdinal'], 'locator'); if (!k.ok) return k as Validation<IdeaLocator>; const r = validateRef(l.generatorReport); if (!r.ok || !safeInt(l.oneBasedOrdinal) || l.oneBasedOrdinal < 1) return fail('INVALID_LOCATOR', 'locator', 'locator malformed'); return ok({ generatorReport: r.value, oneBasedOrdinal: l.oneBasedOrdinal }); }

export function validateReport(valueOrBytes: unknown, ctx: { waveRef: Ref; wave: DeliberationWave; slot: TopologySlot; predecessors: readonly DeliberationReport[]; policy: DeliberationPolicy }): Validation<DeliberationReport> {
  const boundPolicy = policyBinding(ctx.policy, ctx.wave.authorship.policyVersion); if (!boundPolicy.ok) return boundPolicy as Validation<DeliberationReport>;
  const parsed = parseInput(valueOrBytes); if (!parsed.ok) return parsed as Validation<DeliberationReport>; if (!isObj(parsed.value)) return fail('INVALID_REPORT', '', 'report must be an object'); const base = reportBase(parsed.value, 'report'); if (!base.ok) return base as Validation<DeliberationReport>; if (!sameRef(base.value.wave, ctx.waveRef) || base.value.slotOrdinal !== ctx.slot.slotOrdinal) return fail('FOREIGN_REF', 'report.wave/slotOrdinal', 'report is not for current wave slot');
  const expected = deriveTopology(ctx.waveRef, ctx.wave).slots.find((s) => s.slotOrdinal === ctx.slot.slotOrdinal); if (!expected || !exactSlot(ctx.slot, expected)) return fail('INVALID_SLOT', 'slot', 'slot mismatch');
  let report: DeliberationReport;
  if (ctx.slot.role === 'GENERATOR') {
    if (ctx.predecessors.length !== 0) return fail('PREDECESSOR', 'predecessors', 'generator cannot receive predecessors');
    const k = exact(parsed.value, ['schema', 'wave', 'slotOrdinal', 'ideas'], 'report'); if (!k.ok) return k as Validation<DeliberationReport>; if (!Array.isArray(parsed.value.ideas)) return fail('INVALID_REPORT', 'report.ideas', 'ideas must be an array'); const want = ctx.wave.gear === 'FOCUS' ? 1 : 6; if (parsed.value.ideas.length !== want) return fail('CARDINALITY', 'report.ideas', `expected ${want} ideas`); const ideas: Idea[] = []; for (const item of parsed.value.ideas) { if (!isObj(item)) return fail('INVALID_REPORT', 'report.ideas', 'idea malformed'); const ik = exact(item, ['text', 'rationale'], 'idea'); if (!ik.ok) return ik as Validation<DeliberationReport>; if (typeof item.text !== 'string' || typeof item.rationale !== 'string' || !item.text || !item.rationale) return fail('INVALID_REPORT', 'idea', 'idea text/rationale required'); ideas.push({ text: item.text, rationale: item.rationale }); } report = { ...base.value, ideas };
  } else if (ctx.slot.role === 'CRITIC') {
    const generatorClosure = orderedGeneratorClosure(ctx.waveRef, ctx.wave, ctx.predecessors, ctx.policy); if (!generatorClosure.ok) return generatorClosure as Validation<DeliberationReport>; const generators = generatorClosure.value;
    const k = exact(parsed.value, ['schema', 'wave', 'slotOrdinal', 'scores', 'clusters'], 'report'); if (!k.ok) return k as Validation<DeliberationReport>; if (!Array.isArray(parsed.value.scores) || !Array.isArray(parsed.value.clusters)) return fail('INVALID_REPORT', 'report', 'critic arrays required'); const expectedLocators: IdeaLocator[] = []; for (const g of generators) { const reportRef = reportRefFor(g); for (let i = 0; i < g.ideas.length; i += 1) expectedLocators.push({ generatorReport: reportRef, oneBasedOrdinal: i + 1 }); } const expectedKeys = new Set(expectedLocators.map(locatorKey)); const scores: CriticReport['scores'][number][] = []; const seen = new Set<string>();
    const allowedEvidence = new Set<string>([ctx.waveRef, ctx.wave.authorship.intent, ctx.wave.authorship.evidenceSnapshot, ctx.wave.authorship.policyVersion, ...ctx.wave.question.evidence, ...ctx.wave.question.constraints, ...generators.map(reportRefFor)].map(provenanceKey));
    let evidenceOccurrences = 0;
    for (const raw of parsed.value.scores) { if (!isObj(raw)) return fail('INVALID_REPORT', 'scores', 'score malformed'); const sk = exact(raw, ['idea', 'novelty', 'viability', 'fit', 'trap', 'evidence'].filter((x) => raw[x] !== undefined), 'score'); if (!sk.ok) return sk as Validation<DeliberationReport>; const l = validateLocator(raw.idea); if (!l.ok) return l as Validation<DeliberationReport>; const key = locatorKey(l.value); if (!expectedKeys.has(key)) return fail('FOREIGN_REF', 'scores.idea', 'locator does not resolve to a generator report'); if (seen.has(key)) return fail('INVALID_LOCATOR', 'scores', 'duplicate locator'); seen.add(key); const validScore = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 10; if (![raw.novelty, raw.viability, raw.fit].every(validScore)) return fail('SCORE_RANGE', 'scores', 'scores must be integers 0..10'); if (raw.trap !== undefined && typeof raw.trap !== 'string') return fail('INVALID_REPORT', 'scores.trap', 'trap must be text'); if (!Array.isArray(raw.evidence)) return fail('INVALID_REPORT', 'scores.evidence', 'evidence must be array'); const evidence: Ref[] = []; for (const er of raw.evidence) { const rv = validateRef(er); if (!rv.ok) return rv as Validation<DeliberationReport>; if (!allowedEvidence.has(provenanceKey(rv.value))) return fail('FOREIGN_REF', 'scores.evidence', 'evidence is outside the sealed wave/predecessor closure'); evidence.push(rv.value); evidenceOccurrences += 1; } if (evidence.some((r, i) => i > 0 && compareStable(refKey(evidence[i - 1]), refKey(r)) > 0)) return fail('INVALID_REF', 'scores.evidence', 'evidence refs not UTF-8 sorted'); scores.push({ idea: l.value, novelty: raw.novelty as number, viability: raw.viability as number, fit: raw.fit as number, ...(raw.trap === undefined ? {} : { trap: raw.trap }), evidence }); } if (scores.length !== expectedLocators.length || seen.size !== expectedKeys.size) return fail('CARDINALITY', 'scores', 'every idea must be scored exactly once'); const waveOwnRefOccurrences = 3 + ctx.wave.question.evidence.length + ctx.wave.question.constraints.length; const reportWaveRefOccurrences = deriveTopology(ctx.waveRef, ctx.wave).slots.length; const locatorOccurrences = expectedLocators.length * 2; if (waveOwnRefOccurrences + reportWaveRefOccurrences + locatorOccurrences + evidenceOccurrences > ctx.wave.limits.maxRefs) return fail('LIMIT_EXCEEDED', 'scores.evidence', 'critic evidence exceeds the admitted Ref occurrence quota');
    const order = new Map(expectedLocators.map((l, i) => [locatorKey(l), i]));
    if (scores.some((s, i) => locatorKey(s.idea) !== locatorKey(expectedLocators[i]))) return fail('RANKING', 'scores', 'scores must use generator-slot/idea order');
    const clusters: CriticReport['clusters'][number][] = []; const clustered = new Set<string>(); if (parsed.value.clusters.length < 3 || parsed.value.clusters.length > 6) return fail('CARDINALITY', 'clusters', '3-6 clusters required'); for (const c of parsed.value.clusters) { if (!isObj(c)) return fail('POOL_PARTITION', 'clusters', 'cluster malformed'); const ck = exact(c, ['label', 'ideas'], 'cluster'); if (!ck.ok) return ck as Validation<DeliberationReport>; if (typeof c.label !== 'string' || !Array.isArray(c.ideas)) return fail('POOL_PARTITION', 'clusters', 'cluster malformed'); const ideas: IdeaLocator[] = []; for (const raw of c.ideas) { const l = validateLocator(raw); if (!l.ok) return l as Validation<DeliberationReport>; const key = locatorKey(l.value); if (!expectedKeys.has(key)) return fail('FOREIGN_REF', 'clusters.ideas', 'locator does not resolve to a generator report'); if (clustered.has(key)) return fail('POOL_PARTITION', 'clusters', 'idea occurs in multiple clusters'); clustered.add(key); ideas.push(l.value); } if (ideas.some((l, i) => i > 0 && (order.get(locatorKey(ideas[i - 1])) ?? -1) > (order.get(locatorKey(l)) ?? -1))) return fail('POOL_PARTITION', 'clusters.ideas', 'ideas are not generator-slot/idea ordered'); clusters.push({ label: c.label, ideas }); } if (clustered.size !== expectedLocators.length) return fail('POOL_PARTITION', 'clusters', 'cluster partition incomplete'); if (clusters.some((a, i) => i > 0 && compareStable(clusters[i - 1].label, a.label) > 0)) return fail('POOL_PARTITION', 'clusters', 'clusters not UTF-8 sorted'); report = { ...base.value, scores, clusters };
  } else {
    const k = exact(parsed.value, ['schema', 'wave', 'slotOrdinal', 'sketch', 'loadBearingRisk', 'firstConcreteStep', 'childIdeas'], 'report'); if (!k.ok) return k as Validation<DeliberationReport>; if (ctx.predecessors.length !== 1) return fail('PREDECESSOR', 'predecessors', 'deepener requires exactly one critic predecessor'); const critic = ctx.predecessors.find((p): p is CriticReport => 'scores' in p); const expectedCritic = deriveTopology(ctx.waveRef, ctx.wave).slots.find((s) => s.role === 'CRITIC'); if (!critic || !expectedCritic || critic.slotOrdinal !== expectedCritic.slotOrdinal) return fail('PREDECESSOR', 'predecessors', 'deepener requires the current-wave critic predecessor'); if (!sameRef(critic.wave, ctx.waveRef)) return fail('FOREIGN_REF', 'predecessors[0].wave', 'critic predecessor belongs to another wave'); if (critic.scores.filter((s) => !s.trap).length < 3) return fail('PREDECESSOR', 'predecessors', 'deepener requires critic with three non-traps'); if (typeof parsed.value.sketch !== 'string' || sentenceCount(parsed.value.sketch) < 4 || sentenceCount(parsed.value.sketch) > 8 || typeof parsed.value.loadBearingRisk !== 'string' || typeof parsed.value.firstConcreteStep !== 'string' || !Array.isArray(parsed.value.childIdeas) || parsed.value.childIdeas.length < 3 || parsed.value.childIdeas.length > 5 || parsed.value.childIdeas.some((x) => typeof x !== 'string' || !x)) return fail('INVALID_REPORT', 'deepener', 'deepener fields malformed'); report = { ...base.value, sketch: parsed.value.sketch, loadBearingRisk: parsed.value.loadBearingRisk, firstConcreteStep: parsed.value.firstConcreteStep, childIdeas: parsed.value.childIdeas as unknown as DeepenerReport['childIdeas'] };
  }
  try { if (Buffer.byteLength(canonicalString(report), 'utf8') > ctx.wave.limits.maxReportBytes || Buffer.byteLength(canonicalString(report), 'utf8') > ctx.policy.maxSettlementBytes) return fail('INPUT_TOO_LARGE', 'report', 'report exceeds byte ceiling'); } catch { return fail('NON_CANONICAL', 'report', 'report is not canonical'); }
  return ok(report);
}

export function reconcileWave(waveRef: Ref, wave: DeliberationWave, accepted: readonly AcceptedReport[]): ReconcileResult {
  const topology = deriveTopology(waveRef, wave);
  const bySlot = new Map<number, { ref: Ref; report: DeliberationReport; receipt: AcceptedReport['receipt'] }>();
  let conflict = false; let stale = false;
  // First scan only groups immutable candidates.  Validation is deliberately
  // deferred to the ordered slot pass below so arrival order cannot alter
  // predecessor closure or the resulting architecture.
  for (const item of accepted) {
    if (!item || !isObj(item) || !isObj(item.report) || !isObj(item.receipt)) { conflict = true; continue; }
    const ordinal = item.report.slotOrdinal;
    const slot = topology.slots.find((s) => s.slotOrdinal === ordinal);
    if (!slot) { stale = true; continue; }
    const rv = validateRef(item.ref); if (!rv.ok) { conflict = true; continue; }
    if (typeof item.receipt.commandDigest !== 'string' || !/^[0-9a-f]{64}$/.test(item.receipt.commandDigest) || typeof item.receipt.resultDigest !== 'string' || !/^[0-9a-f]{64}$/.test(item.receipt.resultDigest) || !safeInt(item.receipt.attemptEpoch)) { conflict = true; continue; }
    const resultDigest = digest(item.report);
    if (item.ref.digest !== resultDigest || item.receipt.resultDigest !== resultDigest) { conflict = true; continue; }
    const prior = bySlot.get(ordinal);
    if (prior) {
      if (sameRef(prior.ref, rv.value) && digest(prior.report) === resultDigest && prior.receipt.commandDigest === item.receipt.commandDigest && prior.receipt.attemptEpoch === item.receipt.attemptEpoch) continue;
      conflict = true; continue;
    }
    bySlot.set(ordinal, { ref: rv.value, report: item.report, receipt: item.receipt });
  }
  const policy: DeliberationPolicy = { version: wave.authorship.policyVersion, frameCatalog: [], maxMaterialDecisions: 0, maxSettlementBytes: wave.limits.maxReportBytes, maxResolvedRoleInputBytes: wave.limits.maxResolvedRoleInputBytes, convergeCount: 3, nonObviousNovelty: 0, viableFloor: 0 };
  // Validate in topology order; each slot sees exactly its derived
  // predecessor reports, never arbitrary arrival/progress state.
  for (const slot of topology.slots) {
    const item = bySlot.get(slot.slotOrdinal); if (!item) continue;
    const predecessors = slot.dependencies.map((d) => bySlot.get(d)?.report).filter((r): r is DeliberationReport => r !== undefined);
    const vr = validateReport(item.report, { waveRef, wave, slot, predecessors, policy });
    if (!vr.ok) { if (vr.code === 'FOREIGN_REF' || vr.code === 'STALE') stale = true; else conflict = true; bySlot.delete(slot.slotOrdinal); }
    else item.report = vr.value;
  }
  const ordered = [...bySlot.entries()].sort((a, b) => a[0] - b[0]); const reports = ordered.map(([, v]) => v.report); const refs = ordered.map(([, v]) => v.ref); const missingSlots = topology.slots.map((s) => s.slotOrdinal).filter((n) => !bySlot.has(n)); const architecture = conflict ? 'CONFLICT' : stale ? 'STALE' : missingSlots.length ? 'MISSING' : 'COMPLETE'; return { architecture, reports, refs, missingSlots, ...(conflict ? { reason: 'conflicting accepted reports' } : stale ? { reason: 'stale report' } : {}) };
}

export function renderExplore(input: { waveRef: Ref; wave: DeliberationWave; reports: readonly DeliberationReport[]; policy: DeliberationPolicy }): Validation<{ brief: string; wide: string; converge: string; focus: string; provocation: string }> {
  const boundPolicy = policyBinding(input.policy, input.wave.authorship.policyVersion); if (!boundPolicy.ok) return boundPolicy as Validation<{ brief: string; wide: string; converge: string; focus: string; provocation: string }>;
  if (input.wave.gear !== 'EXPLORE') return fail('INVALID_GEAR', 'wave.gear', 'renderer requires Explore wave');
  const critic = input.reports.find((r): r is CriticReport => 'scores' in r); const generators = input.reports.filter((r): r is GeneratorReport => 'ideas' in r).sort((a, b) => a.slotOrdinal - b.slotOrdinal); const deepeners = input.reports.filter((r): r is DeepenerReport => 'sketch' in r).sort((a, b) => a.slotOrdinal - b.slotOrdinal); if (!critic || generators.length !== 5 || deepeners.length !== 3 || input.reports.length !== 9) return fail('CARDINALITY', 'reports', 'Explore requires exactly nine reports');
  const boundWaveRef = validateRef(input.waveRef); if (!boundWaveRef.ok) return boundWaveRef as Validation<{ brief: string; wide: string; converge: string; focus: string; provocation: string }>; if (boundWaveRef.value.digest !== digest(input.wave)) return fail('FOREIGN_REF', 'waveRef', 'wave Ref digest does not bind the supplied wave'); const waveRef = boundWaveRef.value; if (input.reports.some((r) => !sameRef(r.wave, waveRef))) return fail('FOREIGN_REF', 'reports.wave', 'report belongs to another wave');
  const expectedOrdinals = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]); const slotSet = new Set(input.reports.map((r) => r.slotOrdinal)); if (slotSet.size !== 9 || [...expectedOrdinals].some((n) => !slotSet.has(n))) return fail('INVALID_SLOT', 'reports.slotOrdinal', 'report slots are not the Explore topology');
  const topology = deriveTopology(waveRef, input.wave); for (const g of generators) { const vr = validateReport(g, { waveRef, wave: input.wave, slot: topology.slots[g.slotOrdinal], predecessors: [], policy: input.policy }); if (!vr.ok) return vr as Validation<{ brief: string; wide: string; converge: string; focus: string; provocation: string }>; }
  const cv = validateReport(critic, { waveRef, wave: input.wave, slot: topology.slots[5], predecessors: generators, policy: input.policy }); if (!cv.ok) return cv as Validation<{ brief: string; wide: string; converge: string; focus: string; provocation: string }>;
  for (const d of deepeners) { const dv = validateReport(d, { waveRef, wave: input.wave, slot: topology.slots[d.slotOrdinal], predecessors: [critic], policy: input.policy }); if (!dv.ok) return dv as Validation<{ brief: string; wide: string; converge: string; focus: string; provocation: string }>; }
  const nonTraps = critic.scores.filter((s) => !s.trap && s.viability >= input.policy.viableFloor); if (nonTraps.length < 3) return fail('CARDINALITY', 'critic.scores', 'Explore requires at least three viable non-traps');
  const ideaBy = new Map<string, Idea>();
  for (const g of generators) { const reportDigest = digest(g); for (let i = 0; i < g.ideas.length; i += 1) { ideaBy.set(`${reportDigest}:${i + 1}`, g.ideas[i]); ideaBy.set(`${g.wave.digest}:${i + 1}`, g.ideas[i]); } }
  const ranked = [...nonTraps].sort((a, b) => (35 * b.novelty + 40 * b.viability + 25 * b.fit) - (35 * a.novelty + 40 * a.viability + 25 * a.fit) || compareIdeaLocators(a.idea, b.idea, generators));
  const finalists = ranked.slice(0, input.policy.convergeCount);
  const nonRankOne = finalists.slice(1).filter((s) => s.viability >= input.policy.viableFloor && s.novelty >= input.policy.nonObviousNovelty); const star = nonRankOne.sort((a, b) => b.novelty - a.novelty || (35 * b.novelty + 40 * b.viability + 25 * b.fit) - (35 * a.novelty + 40 * a.viability + 25 * a.fit) || compareIdeaLocators(a.idea, b.idea, generators))[0];
  const textFor = (l: IdeaLocator): string => ideaBy.get(`${l.generatorReport.digest}:${l.oneBasedOrdinal}`)?.text ?? '';
  const wide = critic.clusters.map((c) => `${c.label}: ${c.ideas.map((l) => { const s = critic.scores.find((x) => locatorKey(x.idea) === locatorKey(l)); return `${textFor(l)} [N${s?.novelty ?? 0} V${s?.viability ?? 0} F${s?.fit ?? 0}]`; }).join('; ')}`).join('\n');
  const brief = `${input.wave.question.text} — ${generators.reduce((n, g) => n + g.ideas.length, 0)} ideas across ${critic.clusters.length} clusters.`;
  const converge = finalists.map((s, i) => `${i + 1}. ${i > 0 && star && locatorKey(star.idea) === locatorKey(s.idea) ? '★ ' : ''}${textFor(s.idea)} (${35 * s.novelty + 40 * s.viability + 25 * s.fit})`).join('\n');
  const focus = deepeners.map((d, i) => `${i + 1}. ${d.sketch}\nRisk: ${d.loadBearingRisk}\nFirst: ${d.firstConcreteStep}\nChildren: ${d.childIdeas.join('; ')}`).join('\n');
  const provocation = [...critic.scores].filter((s) => !s.trap && s.viability >= input.policy.viableFloor && !finalists.some((f) => locatorKey(f.idea) === locatorKey(s.idea))).sort((a, b) => b.novelty - a.novelty || compareIdeaLocators(a.idea, b.idea, generators))[0];
  const traps = critic.scores.filter((s) => s.trap).map((s) => `Trap: ${textFor(s.idea)} — ${s.trap}`).join('\n');
  return ok({ brief, wide, converge: traps ? `${converge}\n${traps}` : converge, focus, provocation: provocation ? textFor(provocation.idea) : (input.policy.frameCatalog.find((f) => f.tag === 'wild')?.text ?? '') });
}

export function shadowPolicy(input: { authorship: PlanAuthorshipInput; predicates: GearPredicates; policy?: DeliberationPolicy; mode: 'OFF' | 'SHADOW'; sink?: (receipt: Readonly<{ gear: Gear; decisionKey?: string; inputDigest: Sha256 }>) => void }): { mode: 'OFF' | 'SHADOW'; proposal?: GearProposal } {
  if (input.mode === 'OFF') return { mode: 'OFF' };
  const proposal = proposeGear({ frontier: [], predicates: input.predicates, decisionKey: input.authorship.phaseId, frontierOrdinal: 0, policyAvailable: input.policy !== undefined, budgetAvailable: true });
  if (input.sink && proposal.gear !== 'NO_SETTLEMENT') { try { input.sink({ gear: proposal.gear, ...(proposal.gear === 'DIRECT' ? {} : { decisionKey: proposal.decisionKey }), inputDigest: authorshipInputDigest(input.authorship) }); } catch { /* bounded diagnostic sink is non-authoritative */ } }
  return { mode: 'SHADOW', proposal };
}
