# P3 Hard Gate 01 — R3 dispatch coordinator

Status: PASS

## Accepted implementation
- Private `DispatchCoordinator` owns driver/options snapshots, active tasks, launch/observe races, timeout/cancellation watchers, receipt classification/settlement, cleanup, and `onYield` notification.
- `KernelImpl` remains the sole durable validation, reducer, event/receipt/UNKNOWN commit, replay, generation-CAS, and writer-fence facade.
- No package-root API, durable schema/encoding, scheduler, retry policy, or store/journal behavior was added.

## Gate history and repair
- The implementer froze and replayed 70 focused lifecycle traces before/after extraction and ran the full package matrix.
- Fresh gate scout found a missing captured dispatch-lease fence: a late old Promise could ACK a successor PENDING/CLAIMED lease with the same token/digest.
- S3R1 fixed the shared settlement seam by enforcing expectedLeaseId and rejecting dispatch settlement against PENDING; observer lease semantics remain separate and preserved.
- Parent inspected the final commit seam and both successor-state tests.

## Verification
- S3R1 terminal `npm run check`: PASS — 437 tests, 435 pass, 0 fail, 2 platform skips; typecheck/build/pack included.
- Differential lifecycle set after repair: PASS — 72/72.
- Parent bounded acceptance: `node --test test/p3-late-dispatch-lease.test.js` PASS — 2/2.
- `git diff --check`: PASS.

## Compatibility / recovery / rollback
- Claim-before-launch, sync receipt vs real Promise, UNKNOWN one-observe/no-relaunch, late matching receipt, cancellation/deadline, successor cleanup, and Memory/File behavior remain intact.
- Existing diagnostic activeDispatches shape is retained as an own alias; coordinator remains private.
- Durable files are unchanged, so rollback is a package redeploy/internal delegation revert against the same state.

## Decision
R3 satisfies its roadmap exit criteria. P4 may begin.
