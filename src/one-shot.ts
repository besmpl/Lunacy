import { canonicalString } from './canonical.js';
import { commandExecutionOwner, readExecutionWave } from './execution-plane.js';
import type { DecisionToken, MachineState, OutboxCommand } from './model.js';
import type { ProviderIntentFenceObservation } from './driver.js';

/**
 * Private installed writer boundary.  The accepted compatibility census
 * contains supported rollout origins through generation 21, so generation 22
 * is the first generation that may use the one-shot lifecycle.
 */
export const ONE_SHOT_ROLLOUT_GENERATION_FLOOR = 22;

export type ManagedRecoveryDisposition = 'RETRY_FULL_RESERVATION' | 'RETAIN_CUSTODY' | 'RECONCILE_COMPLETE';

/** Pure monotone recovery classifier.  More evidence can close recovery but
 * can never move a fenced or ambiguous attempt closer to provider entry. */
export function classifyManagedRecovery(input: Readonly<{
  started: boolean;
  providerIntent: ProviderIntentFenceObservation;
  completeResultChain: boolean;
}>): ManagedRecoveryDisposition {
  if (input.completeResultChain) return 'RECONCILE_COMPLETE';
  if (input.providerIntent.kind !== 'ABSENT_PROVED') return 'RETAIN_CUSTODY';
  return 'RETRY_FULL_RESERVATION';
}

function sameOrigin(left: unknown, right: unknown): boolean {
  try { return canonicalString(left ?? null) === canonicalString(right ?? null); }
  catch { return false; }
}

function oneShotWave(state: MachineState, record?: DecisionToken): boolean {
  const managed = state.schema === 2 ? state.managed : undefined;
  const proposal = managed?.proposal;
  const origin = proposal?.rolloutOrigin;
  if (!proposal || !origin || !Number.isSafeInteger(origin.generation) || origin.generation < ONE_SHOT_ROLLOUT_GENERATION_FLOOR) return false;
  if (!sameOrigin(managed?.rolloutOrigin, origin)) return false;
  if (record && !sameOrigin(record.rolloutOrigin, origin)) return false;
  const retained = readExecutionWave(record?.waveRef ?? proposal.roleWaveRef, state.runId, state.phaseId);
  return retained?.wave.gear === 'FOCUS' || retained?.wave.gear === 'EXPLORE';
}

/** Exact immutable decision/origin derivation shared by lease preflight and CAS. */
export function isOneShotManagedDecision(state: MachineState, token: string): boolean {
  const record = state.decisionTokens[token];
  return Boolean(record && oneShotWave(state, record));
}

/** Exact command/origin/attempt derivation used by retirement and restart. */
export function isOneShotManagedCommand(state: MachineState, command: OutboxCommand): boolean {
  const attempt = state.managed?.attempts?.[command.commandId];
  const origin = state.managed?.proposal?.rolloutOrigin;
  return Boolean(command.roleView
    && attempt
    && attempt.commandId === command.commandId
    && attempt.epoch === command.attemptEpoch
    && attempt.reservationId === command.commandId
    && sameOrigin(attempt.rolloutOrigin, origin)
    && commandExecutionOwner(state, command) === 'DELIBERATION'
    && oneShotWave(state));
}

/** A terminal one-shot command is immutable custody, never resume work. */
export function terminalOneShotManagedCommand(state: MachineState): OutboxCommand | undefined {
  return Object.values(state.outbox).find((command) => {
    const status = state.managed?.attempts?.[command.commandId]?.status;
    return command.state === 'UNKNOWN'
      && (status === 'TIMED_OUT' || status === 'CANCELLED' || status === 'FAILED')
      && isOneShotManagedCommand(state, command);
  });
}

/** Refuse every spelling that can request another Wave from this decision. */
export function requestsManagedSuccessor(value: unknown): boolean {
  const requested = typeof value === 'string'
    ? { disposition: value } as Record<string, unknown>
    : value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  const disposition = requested.disposition ?? requested.kind ?? requested.decision;
  if (disposition === 'WIDEN') return true;
  if (Object.prototype.hasOwnProperty.call(requested, 'successorWaveRef') || Object.prototype.hasOwnProperty.call(requested, 'nextWaveRef')) return true;
  const result = requested.result && typeof requested.result === 'object' && !Array.isArray(requested.result)
    ? requested.result as Record<string, unknown>
    : undefined;
  if (!result) return false;
  if (Object.prototype.hasOwnProperty.call(result, 'wave') || Object.prototype.hasOwnProperty.call(result, 'successorWaveRef') || Object.prototype.hasOwnProperty.call(result, 'nextWaveRef')) return true;
  return (disposition === 'SELECTION' || disposition === 'SYNTHESIS') && result.kind === 'DELIBERATION_REQUIRED';
}
