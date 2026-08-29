# P3 Gate Pack — fresh post-write-barrier scout

## Decision

**FINDINGS — do not accept P3 yet.** Focused lifecycle parity checks pass, but
the current coordinator/facade path accepts a late receipt from an older lease
and can acknowledge a successor claim with the same token and command digest.

## Exact finding

1. **Dispatch receipt settlement does not enforce the dispatch lease fence.**
   DispatchCoordinator.finishReceipt() passes the captured dispatch leaseId
   (src/dispatch-coordinator.ts:228-239). In
   KernelImpl.commitDispatcherOutcome(), the RECEIPT branch checks receiptLeaseId
   (the observer-only argument) but never checks expectedLeaseId against
   command.leaseId (src/public.ts:667-675). A stale asynchronous dispatch receipt
   therefore matches by token+digest and can acknowledge a later PENDING/CLAIMED
   successor after UNKNOWN -> NEVER_LAUNCHED -> PENDING recovery and a new claim,
   even though the successor lease differs. The old continuation must be
   rejected; only a receipt bound to the current dispatch lease may settle.

   I reproduced this on the current dist build with a FileArtifactStore:
   old dispatch enters and remains pending; a second kernel recovers the command
   to UNKNOWN, a NEVER_LAUNCHED recovery returns it to PENDING, and a successor
   claims the same token with a new lease. Resolving the old dispatch promise
   changed the successor state from CLAIMED to ACKED (after old receipt ACKED,
   successor lease still present), without a successor receipt.

## Named parent acceptance sample

- **P3-LATE-DISPATCH-LEASE:** hold an old dispatch Promise after its CLAIMED
  commit; recover that command to UNKNOWN, explicitly reconcile it to PENDING,
  and claim it with a new lease. Resolve the old Promise with the original
  token/digest while the successor remains CLAIMED. Assert no receipt commit
  occurs, the successor remains CLAIMED, and only a receipt carrying the
  successor lease can move it to ACKED. Repeat with the successor still PENDING
  to ensure the stale receipt cannot pre-ack it.

## Bounded verification

- npm run build — PASS.
- P3 ownership/replay/admission/repair/cross-phase tests (43 tests) — PASS.
- test/orchestration.test.js + test/kernel-repair.test.js (22 tests) — PASS.
- Codex driver/supervisor tests (20 tests) — PASS.
- Worker differential logs /work/r3-pre-focused.log and
  /work/r3-post-focused.log each report 70/70, but neither includes the stale
  dispatch-receipt-after-successor-lease sample above.
- git diff --check — PASS.

## Suggested repair

In the receipt branch of commitDispatcherOutcome, reject when
expectedLeaseId !== undefined && command.leaseId !== expectedLeaseId (in
addition to the observer receiptLeaseId check), preserving token, digest, and
current writer/generation fencing.
