# P1 S2 — fleet authority/concurrency adversary

## Scope and attack
Read-only attack covered coordinator metadata authority, competing turns/duplicate launch, lease expiry/loss, root/plan/claim binding, cross-run conflict, UNKNOWN/parent delegation boundaries, bounded metadata parsing, redaction, and manual-route compatibility. S1 owned paths were `src/fleet-coordinator.ts`, `src/cli.ts`, `test/fleet-coordinator.test.js`, and `docs/FLEET.md`; the maintained R2 count fixture was changed only after explicit parent decision.

## Proven findings and repairs
- **Lease-expiry race:** the coordinator could enter `resumeRun` after its advisory lease had expired but before a successor reclaimed it. Added a fail-closed expiry fence immediately before delegation; regression proves zero dispatches with a 1 ms lease (`test/fleet-coordinator.test.js`, `expired lease` case).
- **Unbounded/unsafe state read:** `readState` used unbounded `readFile` and followed a state symlink. Added a 1 MiB bounded descriptor read with trusted regular-file/no-follow identity binding; oversized and symlinked records now return `StateMalformed` without mutation.
- **Policy/driver ambiguity:** an entry could carry both policy and driver while runtime silently preferred the driver. Manifest validation now rejects the combination; factory-returned driver plus policy returns `InvalidEntry`.
- **Attention leakage:** arbitrary lifecycle/filesystem error text could be returned in `attention.detail`. Details are now retained only for compact identifier-like hints (≤200 bytes); path/provider text is omitted.
- **Competing coordinator proof:** added concurrent invocation regression; two coordinators converge to one kernel launch and one `advanced`/one `idle` result.
- **Deployment count integration:** clean baseline passes `managedFiles === 164`; P1 fleet adds four reachable dist artifacts, making the maintained count 168. Parent-authorized fixture update is in `test/r2-deployment.test.js:47`; semantics unchanged. Exact cause/options/recommendation are frozen in `phases/p1/decision-briefs/S2-deployment-count.md`.

## Verification (terminal snapshot)
- `node --test test/fleet-coordinator.test.js` — **8 passed, 0 failed**.
- `node --test test/r2-deployment.test.js` — **5 passed, 0 failed**.
- `npm run check` — **454 tests, 452 passed, 2 skipped, 0 failed**; typecheck/build, package dry-run (127 files), and fleet/R2 regressions included. Log: `/tmp/lunacy-s2-check-final.log`.
- `git diff --check` — passed.
- Baseline red determination: clean baseline rebuild/test passes 164 (`/tmp/lunacy-baseline-r2.log`); pre-decision P1 tree failed 168 (`/tmp/lunacy-current-r2.log`). The count was therefore integration-related, not baseline/unrelated.

## Remaining bounded risk
A lease can expire during a long `resumeRun`; finish-time owner/epoch CAS returns `LeaseLost`, while kernel writer/token fences remain the no-duplicate transition authority. No scheduler, discovery, automatic approval, DAG, or new public export was introduced; one-run/manual routes remain unchanged.

## Control Block
- **Status:** FINAL — adversarial repairs complete; no open S2 decision.
- **Baseline:** `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7` plus accepted roadmap/control artifacts.
- **Owned implementation:** `src/fleet-coordinator.ts`, `src/cli.ts`, `test/fleet-coordinator.test.js`, `docs/FLEET.md`; authorized maintained fixture `test/r2-deployment.test.js:47`.
- **Authority preserved:** `RunKernel.advance`/existing lifecycle remain the sole run-transition authority; coordinator state is advisory.
- **Evidence:** `/tmp/lunacy-s2-check-final.log`, `/tmp/lunacy-s2-fleet-final.log`, `/tmp/s2-r2-final.log`, and decision brief above.
- **Gate navigation:** P1 hard gate should inspect lease/metadata seams at `src/fleet-coordinator.ts:255-327` and `:441-485`, concurrency/expiry/redaction regressions at `test/fleet-coordinator.test.js:50-130`, and count fixture at `test/r2-deployment.test.js:45-48`. After parent gate PASS and write barrier closure, proceed to P2 per `Lunacy/runs/implement-next-big-wins-v2/PLAN.md` (P2 remains blocked until then).
