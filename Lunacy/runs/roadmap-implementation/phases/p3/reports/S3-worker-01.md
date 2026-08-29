# S3 Worker Report — private dispatch coordinator

## Control
- **Status:** PASS.
- **Scope:** Extracted the private in-flight dispatch lifecycle from `KernelImpl` into `src/dispatch-coordinator.ts`; no public API, durable encoding, scheduler, retry policy, store/journal refactor, or UNKNOWN relaunch behavior was added.
- **Facade boundary:** `KernelImpl` still owns validation, plan/admission/reducer decisions, caller-event/claim/receipt/UNKNOWN commits, exact replay, and writer/generation fences. `DispatchCoordinator` owns driver/options snapshots, active task map, claim-after-commit launch, UNKNOWN observation, cancellation/deadline watchers, settlement/classification, cleanup, and `onYield` notification.
- **Compatibility:** Existing diagnostic `kernel.activeDispatches` view remains an own alias to the coordinator-owned map so current in-process probes retain their shape; driver/options are otherwise coordinator-owned. Package-root and composition exports are unchanged.

## Evidence
- Pre-extraction focused lifecycle freeze: `/Users/mark/Documents/Codex/2026-08-26/continuously-pursue-major-local-lunacy-architecture/work/r3-pre-focused.log` (70/70 pass).
- Post-extraction focused differential: `/Users/mark/Documents/Codex/2026-08-26/continuously-pursue-major-local-lunacy-architecture/work/r3-post-focused.log` (70/70 pass; same named lifecycle matrix).
- Coordinator ownership/race checks: `/Users/mark/Documents/Codex/2026-08-26/continuously-pursue-major-local-lunacy-architecture/work/r3-coord-tests.log` (36/36 pass).
- Terminal full verification: `/Users/mark/Documents/Codex/2026-08-26/continuously-pursue-major-local-lunacy-architecture/work/r3-terminal-check.log` — `npm run check` completed; 435 tests, 433 pass, 0 fail, 2 platform skips; typecheck/build/pack dry-run pass.
- `git diff --check`: PASS.

## Notes
- The complete-tree deployment inventory expectation was updated from 152 to 156 managed files because the private coordinator adds the required JS, declaration, and source-map runtime artifacts; the deployment still preserves unrelated operator files.
- No lifecycle policy was changed: claim-before-launch, sync receipt vs intrinsic Promise handling, lease/digest/generation/writer fences, one-observe UNKNOWN, late receipt, cancellation/deadline, successor cleanup, Memory/File behavior, and `onYield` detachment remain delegated through the same durable callbacks.
