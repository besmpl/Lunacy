import { canonicalString, digest } from './canonical.js';
import type { MachineState, Ref } from './model.js';

export function stateRef(state: MachineState): Ref { return { id: `state:${state.revision}`, scope: 'projection', digest: digest(state), bytes: canonicalString(state) }; }
export function renderStateProjection(state: MachineState): string {
  return [
    `# STATE.md (generated; generation revision ${state.revision})`,
    `Status: ${state.status}`,
    `Phase: ${state.phaseId}`,
    `Gate: ${state.gate}`,
    `Barrier: ${state.barrier}`,
    `Next action: ${state.nextAction}`,
    `Revision: ${state.revision}`,
  ].join('\n') + '\n';
}
export function renderStepsProjection(state: MachineState): string {
  const rows = Object.values(state.steps).map((s) => `- ${s.stepId}: ${s.status} (attempt ${s.attempt})`);
  return `# Steps (generated; revision ${state.revision})\n${rows.join('\n')}\n`;
}
