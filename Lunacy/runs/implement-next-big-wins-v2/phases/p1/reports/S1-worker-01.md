# P1 S1 — explicit multi-run fleet coordinator

## Path inventory (before edits)
- `src/fleet-coordinator.ts` (new private coordinator/runtime seam)
- `src/cli.ts` (private `--fleet-manifest` / `--fleet-state` route)
- `test/fleet-coordinator.test.js` (new focused manifest/delegation/stale-root tests)
- `docs/FLEET.md` (operator/API contract)
- Existing lifecycle/admission/storage/filesystem paths inspected and reused: `src/orchestration.ts`, `src/admission.ts`, `src/store.ts`, `src/filesystem.ts`, `src/validator.ts`, `src/codex-host-policy.ts`; package-root exports intentionally unchanged.

## Implemented
- Added versioned `lunacy-fleet/v1` explicit manifest validation with canonical plan, policy, claims and digest bindings; bounded entry count, canonical absolute roots, closed field sets, and runtime-driver validation.
- Added versioned durable fleet state with atomic old-or-new publication (file + directory fsync), process/cross-process lock, owner/epoch/expiry CAS lease, deterministic round-robin cursor, root inode identity and verified kernel revision evidence.
- Added one-turn `runFleet`/`coordinateFleet`/private `FleetCoordinator` API: explicit root rebind, plan/claim drift checks, cross-run claim conflict checks, exactly one `resumeRun` delegation, deterministic bounded attention, lease-loss protection, and no queue/metadata transition authority.
- Added stale-root/identity, malformed-state, manifest mismatch, lease busy/lost, claim conflict, lifecycle-error handling; UNKNOWN and parent boundaries remain lifecycle results and are never relaunched.
- Added private CLI route and `docs/FLEET.md`; one-run/manual package lifecycle and root exports remain unchanged.

## Verification
- Focused: `node --test test/fleet-coordinator.test.js` — 3 passed.
- Terminal `npm run check` — typecheck/build and 449-test run reached 446 passed, 2 skipped, 1 known baseline failure at `test/r2-deployment.test.js:30` (expected mode value 164, observed 168); failure reproduces prior to this change and is unrelated to fleet files. Pack dry-run separately completed and included the private module required by `dist/cli.js`.
- `git diff --check` passed; no package-root API export added.

## ENGINEERING.md Control Block
- Status: FINAL (implementation complete; no decision required).
- Baseline: `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7` plus accepted roadmap artifacts.
- Owned paths: `src/fleet-coordinator.ts`, `src/cli.ts`, `test/fleet-coordinator.test.js`, `docs/FLEET.md`.
- Authority preserved: kernel `RunKernel.advance` and existing lifecycle/bridge remain sole transition authorities.
- Evidence: `/tmp/lunacy-fleet-check.log`; focused test output from terminal command above.
- Remaining risk: existing R2 deployment mode-value red blocks a fully green package check; parent gate should retain this baseline-known red.
