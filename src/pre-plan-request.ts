import { canonicalString, parseCanonical } from './canonical.js';
import {
  authorManagedWave,
  authorshipInputDigest,
  completeDirectPlan,
  noSettlement,
  projectRef,
  semanticClosure,
  validateRef,
  type DecisionContext,
  type DeliberationPolicy,
  type PlanAuthorshipInput,
  type PrePlanResolution,
  type ProjectedRef,
} from './deliberation.js';
import type { Ref } from './model.js';

type FrontierItem = Readonly<{
  key: string;
  prospectiveEffectFrontierOrdinal: number;
  status: 'SETTLED' | 'UNSETTLED';
  discriminator?: string;
  context: DecisionContext;
}>;

type ExploreRequestAuthority = Readonly<{
  schema: 'lunacy-explore-request-authority/v1';
  runId: string;
  phaseId: string;
  intentDigest: string;
  authorityDigest: string;
  decisionKey: string;
  prospectiveEffectFrontierOrdinal: number;
  cutoff: 'OPEN';
}>;

export type PrePlanRequest =
  | Readonly<{ mode: 'DIRECT'; authorship: PlanAuthorshipInput }>
  | Readonly<{ mode: 'AUTO'; authorship: PlanAuthorshipInput; frontier: readonly FrontierItem[] }>
  | Readonly<{
      mode: 'EXPLORE'; authorship: PlanAuthorshipInput; decisionKey: string;
      prospectiveEffectFrontierOrdinal: number; context: DecisionContext;
      taskProfile: 'CODE' | 'PRODUCT'; requestAuthority: ExploreRequestAuthority;
    }>;

const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
const exact = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`${label} fields are not exact`);
};
const normalized = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim().replace(/\s+/g, ' ')) throw new Error(`${label} must be normalized nonblank text`);
  return value;
};
const ordinal = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
};
const refKey = (ref: Ref | ProjectedRef): string => canonicalString({ id: ref.id, digest: ref.digest, scope: ref.scope ?? null });

function authorship(value: unknown): PlanAuthorshipInput {
  if (!plain(value)) throw new Error('authorship must be a plain object');
  exact(value, ['authorityDigest', 'evidenceSnapshot', 'intent', 'phaseId', 'policyVersion', 'runId', 'settlements'], 'authorship');
  authorshipInputDigest(value as PlanAuthorshipInput);
  return value as PlanAuthorshipInput;
}

function refs(value: unknown, label: string, allowed: ReadonlySet<string>): readonly Ref[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const out: Ref[] = []; let prior: string | undefined;
  for (const item of value) {
    const checked = validateRef(item); if (!checked.ok || checked.value.bytes === undefined) throw new Error(`${label} entries require exact canonical bytes`);
    const key = refKey(checked.value);
    if (!allowed.has(key)) throw new Error(`${label} entry is outside the retained semantic closure`);
    if (prior !== undefined && prior >= key) throw new Error(`${label} entries must be unique and canonically ordered`);
    out.push(checked.value); prior = key;
  }
  return out;
}

function context(value: unknown, input: PlanAuthorshipInput, label: string): DecisionContext {
  if (!plain(value)) throw new Error(`${label} must be a plain object`);
  exact(value, ['problem', 'decisionImpact', 'evidence', 'constraints'], label);
  const closure = semanticClosure(input.evidenceSnapshot); if (!closure.ok) throw new Error(`${label} semantic closure is invalid: ${closure.message}`);
  return Object.freeze({
    problem: normalized(value.problem, `${label}.problem`),
    decisionImpact: normalized(value.decisionImpact, `${label}.decisionImpact`),
    evidence: Object.freeze([...refs(value.evidence, `${label}.evidence`, closure.value.committedEvidence)]),
    constraints: Object.freeze([...refs(value.constraints, `${label}.constraints`, closure.value.reachableConstraints)]),
  });
}

function frontier(value: unknown, input: PlanAuthorshipInput): readonly FrontierItem[] {
  if (!Array.isArray(value)) throw new Error('frontier must be an array');
  const out: FrontierItem[] = []; const keys = new Set<string>(); let priorOrdinal = -1; let priorKey = '';
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]; if (!plain(item)) throw new Error(`frontier[${index}] must be a plain object`);
    const hasDiscriminator = Object.prototype.hasOwnProperty.call(item, 'discriminator');
    exact(item, ['key', 'prospectiveEffectFrontierOrdinal', 'status', 'context', ...(hasDiscriminator ? ['discriminator'] : [])], `frontier[${index}]`);
    const key = normalized(item.key, `frontier[${index}].key`); const position = ordinal(item.prospectiveEffectFrontierOrdinal, `frontier[${index}].prospectiveEffectFrontierOrdinal`);
    if (keys.has(key)) throw new Error('frontier keys must be unique');
    if (position < priorOrdinal || (position === priorOrdinal && key <= priorKey)) throw new Error('frontier must be in canonical ordinal/key order');
    if (item.status !== 'SETTLED' && item.status !== 'UNSETTLED') throw new Error(`frontier[${index}].status is invalid`);
    const discriminator = hasDiscriminator ? normalized(item.discriminator, `frontier[${index}].discriminator`) : undefined;
    if (item.status === 'SETTLED' && discriminator !== undefined) throw new Error('a settled frontier item cannot carry a discriminator');
    out.push(Object.freeze({ key, prospectiveEffectFrontierOrdinal: position, status: item.status, ...(discriminator === undefined ? {} : { discriminator }), context: context(item.context, input, `frontier[${index}].context`) }));
    keys.add(key); priorOrdinal = position; priorKey = key;
  }
  return Object.freeze(out);
}

function exploreAuthority(value: unknown, input: PlanAuthorshipInput, decisionKey: string, position: number): ExploreRequestAuthority {
  if (!plain(value)) throw new Error('requestAuthority must be a plain object');
  exact(value, ['schema', 'runId', 'phaseId', 'intentDigest', 'authorityDigest', 'decisionKey', 'prospectiveEffectFrontierOrdinal', 'cutoff'], 'requestAuthority');
  if (value.schema !== 'lunacy-explore-request-authority/v1' || value.cutoff !== 'OPEN'
    || value.runId !== input.runId || value.phaseId !== input.phaseId || value.intentDigest !== input.intent.digest
    || value.authorityDigest !== input.authorityDigest || value.decisionKey !== decisionKey
    || value.prospectiveEffectFrontierOrdinal !== position) throw new Error('requestAuthority does not bind the current open pre-Plan request');
  return Object.freeze(value as unknown as ExploreRequestAuthority);
}

/** Decode and freeze the only fresh private request document. */
export function parsePrePlanRequest(value: unknown): PrePlanRequest {
  if (!plain(value)) throw new Error('pre-Plan request must be a plain object');
  const mode = value.mode; if (mode !== 'DIRECT' && mode !== 'AUTO' && mode !== 'EXPLORE') throw new Error('mode must be DIRECT, AUTO, or EXPLORE');
  const input = authorship(value.authorship);
  if (mode === 'DIRECT') {
    exact(value, ['mode', 'authorship'], 'DIRECT request');
    return Object.freeze({ mode, authorship: input });
  }
  if (mode === 'AUTO') {
    exact(value, ['mode', 'authorship', 'frontier'], 'AUTO request');
    return Object.freeze({ mode, authorship: input, frontier: frontier(value.frontier, input) });
  }
  exact(value, ['mode', 'authorship', 'decisionKey', 'prospectiveEffectFrontierOrdinal', 'context', 'taskProfile', 'requestAuthority'], 'EXPLORE request');
  const decisionKey = normalized(value.decisionKey, 'decisionKey');
  const position = ordinal(value.prospectiveEffectFrontierOrdinal, 'prospectiveEffectFrontierOrdinal');
  if (value.taskProfile !== 'CODE' && value.taskProfile !== 'PRODUCT') throw new Error('taskProfile must be CODE or PRODUCT');
  return Object.freeze({ mode, authorship: input, decisionKey, prospectiveEffectFrontierOrdinal: position, context: context(value.context, input, 'context'), taskProfile: value.taskProfile, requestAuthority: exploreAuthority(value.requestAuthority, input, decisionKey, position) });
}

export function resolveTypedPrePlan(request: PrePlanRequest, policy?: DeliberationPolicy): PrePlanResolution {
  if (request.mode === 'DIRECT') return completeDirectPlan(request.authorship);
  if (request.mode === 'AUTO') {
    const unsettled = request.frontier.find((item) => item.status === 'UNSETTLED');
    const direct = completeDirectPlan(request.authorship);
    if (!unsettled && direct.kind === 'COMPLETE_PLAN') return direct;
    if (!unsettled?.discriminator) return noSettlement('AUTO_UNSETTLED_WITHOUT_DISCRIMINATOR');
    return authorManagedWave(request.authorship, {
      gear: 'FOCUS', decisionKey: unsettled.key, prospectiveEffectFrontierOrdinal: unsettled.prospectiveEffectFrontierOrdinal,
      discriminator: unsettled.discriminator, context: unsettled.context,
    }, policy);
  }
  return authorManagedWave(request.authorship, {
    gear: 'EXPLORE', decisionKey: request.decisionKey, prospectiveEffectFrontierOrdinal: request.prospectiveEffectFrontierOrdinal,
    context: request.context, taskProfile: request.taskProfile,
  }, policy);
}

/** Canonical request bytes are the freeze boundary for caller-owned values. */
export function clonePrePlanRequest(value: PrePlanRequest): PrePlanRequest {
  return parsePrePlanRequest(parseCanonical(canonicalString(value)));
}
