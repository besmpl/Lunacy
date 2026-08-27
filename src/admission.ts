import type { Claim, PlanStep } from './model.js';
import { relationConflict } from './validator.js';

export type AdmissionInput = { runId: string; claims: Claim[]; workspace?: string; ownership?: string };
export type Admission = (input: AdmissionInput) => boolean | Promise<boolean>;

export function canonicalClaims(steps: PlanStep[]): Claim[] { return steps.flatMap((s) => s.claims ?? []).map((c) => ({ resource: c.resource, mode: c.mode, aliases: [...(c.aliases ?? [])].sort() })); }
export function claimsConflict(a: Claim[], b: Claim[]): boolean { return a.some((x) => b.some((y) => relationConflict(x, y))); }
export async function proveAdmission(proof: Admission | undefined, input: AdmissionInput): Promise<boolean> {
  if (proof) return Boolean(await proof(input));
  return input.claims.length === 0;
}
