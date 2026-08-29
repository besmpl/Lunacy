# S3R1 Worker Report — late dispatch lease fence

## Control
- **Status:** PASS.
- **Scope:** Repaired the shared `KernelImpl.commitDispatcherOutcome` receipt seam so a dispatch settlement captured under `expectedLeaseId` cannot acknowledge a successor command: the persisted lease must still match, and a dispatch settlement cannot pre-ack a command that has returned to `PENDING` after explicit `NEVER_LAUNCHED` reconciliation.
- **Preserved:** Observer receipts continue to use their separate `receiptLeaseId` fence; token, command digest, generation, writer-fence, late matching receipt, cancellation/deadline, UNKNOWN one-observe/no-relaunch, and R1/R2 segmented/legacy behavior are unchanged. Launch and observe settlement paths were re-audited; observer already enforced its captured lease, with no other concrete defect found.

## Named acceptance sample
- Added deterministic `test/p3-late-dispatch-lease.test.js` coverage for **P3-LATE-DISPATCH-LEASE** successor `PENDING` and `CLAIMED` states. Each holds an old dispatch Promise through `CLAIMED -> UNKNOWN -> NEVER_LAUNCHED -> PENDING`, resolves the old token/digest receipt, proves no generation/state commit, then proves only the successor receipt reaches `ACKED`.
- Focused run: `node --test test/p3-late-dispatch-lease.test.js` — 2/2 pass.
- Differential lifecycle set (P3 lease tests plus repair/orchestration/Codex and massive-win suites) — 72/72 pass.

## Verification
- Terminal `/Users/mark/Documents/Codex/2026-08-26/continuously-pursue-major-local-lunacy-architecture/work/r3s1-terminal-check.log`: `npm run check` completed; 437 tests, 435 pass, 0 fail, 2 platform skips; typecheck/build/pack dry-run pass.
- Focused evidence: `/Users/mark/Documents/Codex/2026-08-26/continuously-pursue-major-local-lunacy-architecture/work/r3s1-focused.log`.
- `git diff --check`: PASS.
