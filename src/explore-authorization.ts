import { canonicalString } from './canonical.js';
import { projectRef, type ProjectedRef } from './deliberation.js';
import type { Ref, Sha256 } from './model.js';

/**
 * Process-local proof minted only by the private pre-Plan bridge adapter.
 *
 * This is deliberately not durable or exported from the package root;
 * serialization cannot preserve its authority. The WeakSet is the actual
 * invocation-local provenance; the
 * frozen fields are the exact tuple that composition and kernel admission
 * independently bind before the proof is consumed once.
 */
export type ExploreAuthorization = Readonly<{
  intent: ProjectedRef;
  authorityDigest: Sha256;
  waveDigest: Sha256;
  runId: string;
  phaseId: string;
  rolloutPolicyDigest: Sha256;
}>;

export type ExploreAuthorizationBinding = Readonly<{
  intent: Ref;
  authorityDigest: Sha256;
  waveDigest: Sha256;
  runId: string;
  phaseId: string;
  rolloutPolicyDigest: Sha256;
}>;

const live = new WeakSet<object>();

function projection(ref: Ref): ProjectedRef {
  const projected = projectRef(ref);
  if (!projected.ok) throw new Error(`ExploreAuthorization: intent Ref is invalid: ${projected.message}`);
  return projected.value;
}

function exactBinding(value: ExploreAuthorization, binding: ExploreAuthorizationBinding): boolean {
  try {
    return value.runId === binding.runId
      && value.phaseId === binding.phaseId
      && value.authorityDigest === binding.authorityDigest
      && value.waveDigest === binding.waveDigest
      && value.rolloutPolicyDigest === binding.rolloutPolicyDigest
      && canonicalString(value.intent) === canonicalString(projection(binding.intent));
  } catch {
    return false;
  }
}

/** Mint one non-reusable proof for the current trusted bridge invocation. */
export function mintExploreAuthorization(binding: ExploreAuthorizationBinding): ExploreAuthorization {
  const value = Object.freeze({
    intent: Object.freeze({ ...projection(binding.intent) }),
    authorityDigest: binding.authorityDigest,
    waveDigest: binding.waveDigest,
    runId: binding.runId,
    phaseId: binding.phaseId,
    rolloutPolicyDigest: binding.rolloutPolicyDigest,
  });
  live.add(value);
  return value;
}

/** Non-consuming check used by composition before it constructs a driver. */
export function inspectExploreAuthorization(value: unknown, binding: ExploreAuthorizationBinding): value is ExploreAuthorization {
  if (!value || typeof value !== 'object' || !live.has(value)) return false;
  const candidate = value as ExploreAuthorization;
  return Object.isFrozen(candidate) && Object.isFrozen(candidate.intent)
    && Object.keys(candidate).sort().join(',') === 'authorityDigest,intent,phaseId,rolloutPolicyDigest,runId,waveDigest'
    && exactBinding(candidate, binding);
}

/** Consume at most once at the kernel admission boundary. */
export function consumeExploreAuthorization(value: unknown, binding: ExploreAuthorizationBinding): boolean {
  if (!value || typeof value !== 'object' || !live.has(value)) return false;
  live.delete(value);
  return inspectConsumed(value, binding);
}

function inspectConsumed(value: object, binding: ExploreAuthorizationBinding): boolean {
  const candidate = value as ExploreAuthorization;
  return Object.isFrozen(candidate) && Object.isFrozen(candidate.intent)
    && Object.keys(candidate).sort().join(',') === 'authorityDigest,intent,phaseId,rolloutPolicyDigest,runId,waveDigest'
    && exactBinding(candidate, binding);
}
