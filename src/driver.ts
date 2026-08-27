import type { OutboxCommand, Ref } from './model.js';
import { canonicalString, digest } from './canonical.js';
import type { DriverReceipt } from './outbox.js';

export type HumanReceiptRequest = { kind: 'HUMAN_RECEIPT_REQUIRED'; launchToken: string; commandDigest: string; command: Ref };

/**
 * Private composition capability.  It deliberately does not appear in the
 * package entry point: hosts bind a driver when composing a kernel, while the
 * parent-facing lifecycle remains only `RunKernel.advance`.
 *
 * A driver must echo the persisted launch token and command digest in its
 * receipt.  That echo is what lets the kernel distinguish a receipt for this
 * exact command from an old or otherwise confused host response. The optional
 * signal is aborted on dispatcher timeout/cancellation; drivers that cannot
 * cancel must still tolerate a late completion because the token fence remains
 * authoritative.
 */
export type EffectDriver = {
  dispatch(command: OutboxCommand, launchToken: string, signal?: AbortSignal): Promise<DriverReceipt> | DriverReceipt;
  observe?(launchToken: string, signal?: AbortSignal): Promise<DriverReceipt | undefined> | DriverReceipt | undefined;
};

/** Truthful fallback: it never claims that a native launch happened. */
export class ProseDriver {
  request(command: OutboxCommand): HumanReceiptRequest {
    const commandRef: Ref = { id: `command:${command.commandId}`, scope: 'outbox', digest: digest(command), bytes: canonicalString(command) };
    return { kind: 'HUMAN_RECEIPT_REQUIRED', launchToken: command.launchToken, commandDigest: command.commandDigest, command: commandRef };
  }
}
