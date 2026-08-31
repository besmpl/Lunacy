import { digest } from './canonical.js';
import type { MachineState, OutboxCommand, Ref } from './model.js';

export type DriverReceipt = { launchToken: string; commandDigest: string; ref: Ref; authorityAnchor?: Ref };

export function commandInCurrentFrame(state: MachineState, command: OutboxCommand): boolean {
  return state.modeEpoch === 0 && command.modeEpoch === 0
    && command.attemptEpoch === state.attemptEpoch
    && command.authorityEpoch === state.authorityEpoch
    && command.barrierEpoch === state.barrierEpoch;
}

/** Private fenced state transitions used by the kernel's composition root. */
export function claim(command: OutboxCommand, leaseId: string, modeEpoch: number, writerFence: string): OutboxCommand {
  if (modeEpoch !== 0 || command.modeEpoch !== 0) throw new Error('modeEpoch is unsupported');
  if (command.state !== 'PENDING') throw new Error(`cannot claim ${command.state}`);
  command.state = 'CLAIMED'; command.leaseId = `${leaseId}:${modeEpoch}:${writerFence}`; return command;
}
export function unknown(command: OutboxCommand): OutboxCommand {
  if (command.modeEpoch !== 0) throw new Error('modeEpoch is unsupported');
  if (command.state !== 'CLAIMED') throw new Error(`cannot mark ${command.state} unknown`);
  command.state = 'UNKNOWN'; return command;
}
export function acknowledge(command: OutboxCommand, receipt: DriverReceipt): OutboxCommand {
  if (command.modeEpoch !== 0) throw new Error('modeEpoch is unsupported');
  if (receipt.launchToken !== command.launchToken || receipt.commandDigest !== command.commandDigest) throw new Error('receipt does not match launch token or command digest');
  if (!receipt.ref || typeof receipt.ref.id !== 'string' || typeof receipt.ref.digest !== 'string') throw new Error('receipt ref is malformed');
  if (command.state !== 'CLAIMED' && command.state !== 'UNKNOWN' && command.state !== 'PENDING') throw new Error(`cannot acknowledge ${command.state}`);
  command.state = 'ACKED'; command.receipt = receipt.ref; return command;
}
export function earlyEnvelope(command: OutboxCommand, evidence: Ref): OutboxCommand {
  command.noEffectEvidence = [...(command.noEffectEvidence ?? []), evidence]; return command;
}
export function commandDigest(command: Pick<OutboxCommand, 'commandId' | 'runId' | 'phaseId' | 'stepId' | 'attemptEpoch' | 'launchToken'>) { return digest(command); }
