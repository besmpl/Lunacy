import { canonicalString, parseCanonical } from './canonical.js';
import { deliberationPolicyFromAsset, type DeliberationPolicy, type DeliberationWave } from './deliberation.js';
import { validateCodexDeliberationHostPolicy, type CodexDeliberationHostPolicy } from './codex-host-policy.js';
import { createManagedCapability, createManagedRolloutPolicy, projectManagedRolloutPolicy, verifyManagedCapability, verifyManagedRolloutPolicy, type ManagedCapability, type ManagedRolloutPolicy } from './managed-capability.js';
import type { EffectDriver } from './driver.js';
import type { MachineState, Ref } from './model.js';

/**
 * Invocation-local inputs needed to reconstruct a retained managed Wave after
 * the process that admitted START has exited.  Every member uses an existing
 * closed schema; this carrier is neither persisted nor projected.
 */
export type ManagedBridgeContext = Readonly<{
  capability: ManagedCapability;
  rolloutPolicy: ManagedRolloutPolicy;
  deliberationPolicyAsset: unknown;
  hostPolicy: CodexDeliberationHostPolicy;
}>;

export type RetainedManagedComposition = Readonly<{
  driver?: EffectDriver;
  workspace: string;
  managedCapability: ManagedCapability;
  managedRollout: Readonly<{
    policy: ManagedRolloutPolicy;
    wave: Ref;
    deliberationPolicy: DeliberationPolicy;
    decisionUnsettled: true;
    explicitExplore?: true;
  }>;
  managedDeliberationPolicy: CodexDeliberationHostPolicy;
}>;

function cloneCanonical<T>(value: T, label: string): T {
  try { return parseCanonical<T>(canonicalString(value)); }
  catch (error) { throw new Error(`managed bridge ${label} is not canonical JSON: ${(error as Error).message}`); }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot and validate the four existing-schema documents before an await. */
export function createManagedBridgeContext(input: ManagedBridgeContext): ManagedBridgeContext {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('managed bridge context is required');
  if (Object.keys(input).sort().join(',') !== 'capability,deliberationPolicyAsset,hostPolicy,rolloutPolicy') throw new Error('managed bridge context fields are not closed');
  if (!verifyManagedCapability(input.capability)) throw new Error('managed bridge capability is invalid');
  if (!verifyManagedRolloutPolicy(input.rolloutPolicy) || input.rolloutPolicy.mode === 'disabled') throw new Error('managed bridge rollout policy is unavailable');
  const capability = createManagedCapability(cloneCanonical(input.capability, 'capability'));
  const rolloutPolicy = createManagedRolloutPolicy(cloneCanonical(input.rolloutPolicy, 'rollout policy'));
  const hostPolicy = validateCodexDeliberationHostPolicy(cloneCanonical(input.hostPolicy, 'host policy'));
  const deliberationPolicyAsset = freezeDeep(cloneCanonical(input.deliberationPolicyAsset, 'deliberation policy asset'));
  return Object.freeze({ capability, rolloutPolicy, deliberationPolicyAsset, hostPolicy });
}

function same(left: unknown, right: unknown): boolean {
  try { return canonicalString(left) === canonicalString(right); }
  catch { return false; }
}

/**
 * Bind the invocation-local carrier to exact retained state.  The Wave and
 * policy semantics come from the retained roleWaveRef; callers cannot supply a
 * replacement Wave or reinterpret it with current defaults.
 */
export function retainedManagedComposition(state: MachineState | undefined, context: ManagedBridgeContext, ordinaryDriver?: EffectDriver): RetainedManagedComposition {
  const checked = createManagedBridgeContext(context);
  if (state?.schema !== 2 || !state.managed?.proposal) throw new Error('managed bridge retained state is unavailable');
  if (!same(state.managed.capability, checked.capability)) throw new Error('managed bridge capability does not match retained state');
  const retainedRollout = state.managed.rolloutOrigin ?? state.managed.rollout;
  if (!retainedRollout || !same(retainedRollout, projectManagedRolloutPolicy(checked.rolloutPolicy))) throw new Error('managed bridge rollout policy does not match retained state');
  const waveRef = state.managed.proposal.roleWaveRef;
  if (!waveRef || waveRef.scope !== 'deliberation/wave' || typeof waveRef.bytes !== 'string') throw new Error('managed bridge retained Wave is unavailable');
  let wave: DeliberationWave;
  try { wave = parseCanonical<DeliberationWave>(waveRef.bytes); }
  catch { throw new Error('managed bridge retained Wave is malformed'); }
  if (wave.authorship.runId !== state.runId || wave.authorship.phaseId !== state.phaseId) throw new Error('managed bridge retained Wave identity mismatch');
  const policy = deliberationPolicyFromAsset(checked.deliberationPolicyAsset, wave.authorship.policyVersion);
  if (!policy.ok) throw new Error(`managed bridge deliberation policy mismatch: ${policy.path} ${policy.message}`.trim());
  return Object.freeze({
    ...(ordinaryDriver === undefined ? {} : { driver: ordinaryDriver }),
    workspace: checked.hostPolicy.targetWorkspace,
    managedCapability: checked.capability,
    managedRollout: Object.freeze({
      policy: checked.rolloutPolicy,
      wave: Object.freeze(cloneCanonical(waveRef, 'retained Wave')),
      deliberationPolicy: policy.value,
      decisionUnsettled: true as const,
      ...(wave.gear === 'EXPLORE' ? { explicitExplore: true as const } : {}),
    }),
    managedDeliberationPolicy: checked.hostPolicy,
  });
}
