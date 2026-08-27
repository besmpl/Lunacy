import { digest } from './canonical.js';
import type { OutboxCommand, Ref } from './model.js';

export type DriverReceipt = { launchToken: string; commandDigest: string; ref: Ref };

/** Private fenced state transitions used by the kernel's composition root. */
export function claim(command: OutboxCommand, leaseId: string, modeEpoch: number, writerFence: string): OutboxCommand {
  if (command.state !== 'PENDING') throw new Error(`cannot claim ${command.state}`);
  command.state = 'CLAIMED'; command.leaseId = `${leaseId}:${modeEpoch}:${writerFence}`; return command;
}
export function unknown(command: OutboxCommand): OutboxCommand {
  if (command.state !== 'CLAIMED') throw new Error(`cannot mark ${command.state} unknown`);
  command.state = 'UNKNOWN'; return command;
}
export function acknowledge(command: OutboxCommand, receipt: DriverReceipt): OutboxCommand {
  if (receipt.launchToken !== command.launchToken || receipt.commandDigest !== command.commandDigest) throw new Error('receipt does not match launch token or command digest');
  if (!receipt.ref || typeof receipt.ref.id !== 'string' || typeof receipt.ref.digest !== 'string') throw new Error('receipt ref is malformed');
  if (command.state !== 'CLAIMED' && command.state !== 'UNKNOWN' && command.state !== 'PENDING') throw new Error(`cannot acknowledge ${command.state}`);
  command.state = 'ACKED'; command.receipt = receipt.ref; return command;
}
export function earlyEnvelope(command: OutboxCommand, evidence: Ref): OutboxCommand {
  command.noEffectEvidence = [...(command.noEffectEvidence ?? []), evidence]; return command;
}
export function commandDigest(command: Pick<OutboxCommand, 'commandId' | 'runId' | 'phaseId' | 'stepId' | 'attemptEpoch' | 'launchToken'>) { return digest(command); }
