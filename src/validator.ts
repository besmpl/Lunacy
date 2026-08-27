import type { Claim, ClaimMode, Plan, PlanStep } from './model.js';
import { compareStable, dependencyTerminal, validateDependencyTopology } from './dependency.js';

export type ValidationResult = { plan: Plan; order: string[]; depths: Record<string, number> };

// Plan step IDs become keys in several ordinary object projections.  Reject
// prototype-bearing names at the plan boundary rather than allowing a
// declaration such as "__proto__" to mutate a projection's prototype or to
// disappear during assignment.
const RESERVED_STEP_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function relationConflict(a: Claim, b: Claim): boolean {
  const namesA = new Set([a.resource, ...(a.aliases ?? [])]);
  const namesB = new Set([b.resource, ...(b.aliases ?? [])]);
  const overlap = [...namesA].some((x) => [...namesB].some((y) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
  if (!overlap) return false;
  if (a.mode === 'READ' && b.mode === 'READ') return false;
  return true;
}

export function validatePlan(input: Plan): ValidationResult {
  if (!input || input.schema && input.schema !== 'lunacy-plan-v1') throw new Error('invalid plan schema');
  if (typeof input.phaseId !== 'string' || input.phaseId.length === 0) throw new Error('plan phaseId is required');
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error('plan must contain executable steps');
  const steps = new Map<string, PlanStep>();
  for (const raw of input.steps) {
    if (!raw || typeof raw.stepId !== 'string' || raw.stepId.length === 0) throw new Error('stepId is required');
    if (RESERVED_STEP_KEYS.has(raw.stepId)) throw new Error(`reserved stepId ${raw.stepId}`);
    if (steps.has(raw.stepId)) throw new Error(`duplicate step ${raw.stepId}`);
    if (raw.executable === false) throw new Error(`non-executable node ${raw.stepId}`);
    const rawDeps = raw.dependencies ?? [];
    if (!Array.isArray(rawDeps) || rawDeps.some((dependency) => typeof dependency !== 'string')) throw new Error(`dependencies for ${raw.stepId} are invalid`);
    if (new Set(rawDeps).size !== rawDeps.length) throw new Error(`duplicate dependency ${raw.stepId}`);
    const deps = [...rawDeps];
    if (deps.some((d) => d === raw.stepId)) throw new Error(`self dependency ${raw.stepId}`);
    const claims = (raw.claims ?? []).map((claim) => {
      if (!claim || typeof claim.resource !== 'string' || claim.resource.length === 0 || !['READ', 'WRITE', 'EXCLUSIVE'].includes(claim.mode)) throw new Error(`invalid claim in ${raw.stepId}`);
      if (claim.aliases !== undefined && (!Array.isArray(claim.aliases) || claim.aliases.some((alias) => typeof alias !== 'string' || alias.length === 0))) throw new Error(`invalid claim aliases in ${raw.stepId}`);
      return { resource: claim.resource, mode: claim.mode as ClaimMode, aliases: [...new Set(claim.aliases ?? [])].sort() };
    });
    const claimNames = new Map<string, ClaimMode>();
    for (const claim of claims) {
      for (const name of [claim.resource, ...(claim.aliases ?? [])]) {
        const prior = claimNames.get(name);
        if (prior && prior !== claim.mode) throw new Error(`contradictory claim ${name} in ${raw.stepId}`);
        if (prior === claim.mode) throw new Error(`duplicate claim ${name} in ${raw.stepId}`);
        claimNames.set(name, claim.mode);
      }
    }
    steps.set(raw.stepId, { ...raw, dependencies: deps.sort(), claims });
  }
  for (const step of steps.values()) for (const dep of step.dependencies ?? []) if (!steps.has(dep)) throw new Error(`missing dependency ${dep}`);
  const depths = validateDependencyTopology(Object.fromEntries(steps));
  const order = [...steps.keys()].sort((a, b) => depths[a] - depths[b] || compareStable(a, b));
  return { plan: { ...input, schema: 'lunacy-plan-v1', steps: order.map((id) => steps.get(id)!) }, order, depths };
}

export function readySteps(plan: Plan, status: Record<string, string>, activeClaims: Claim[] = [], maxInFlight = Number.POSITIVE_INFINITY): PlanStep[] {
  const candidates = plan.steps.filter((s) => status[s.stepId] === 'READY' && (s.dependencies ?? []).every((d) => dependencyTerminal(status[d])));
  const selected: PlanStep[] = [];
  const planOrder = new Map(plan.steps.map((step, index) => [step.stepId, index]));
  for (const step of candidates.sort((a, b) => {
    const orderA = planOrder.get(a.stepId) ?? Number.MAX_SAFE_INTEGER;
    const orderB = planOrder.get(b.stepId) ?? Number.MAX_SAFE_INTEGER;
    const phaseA = Number.isSafeInteger((a as PlanStep & { phaseOrder?: number }).phaseOrder) ? (a as PlanStep & { phaseOrder?: number }).phaseOrder! : orderA;
    const phaseB = Number.isSafeInteger((b as PlanStep & { phaseOrder?: number }).phaseOrder) ? (b as PlanStep & { phaseOrder?: number }).phaseOrder! : orderB;
    // validatePlan already normalizes plan order by depth then stable ID, so a
    // phase-order tie can use that order directly without a second recursive
    // graph traversal.
    return phaseA - phaseB || orderA - orderB || compareStable(a.stepId, b.stepId);
  })) {
    const claims = step.claims ?? [];
    if ([...activeClaims, ...selected.flatMap((s) => s.claims ?? [])].some((held) => claims.some((c) => relationConflict(c, held)))) continue;
    selected.push(step);
    if (selected.length >= maxInFlight) break;
  }
  return selected;
}
