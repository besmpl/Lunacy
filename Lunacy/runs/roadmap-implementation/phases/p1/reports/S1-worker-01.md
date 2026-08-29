# S1 Worker Report — R1 lifecycle controller

## Control
- **Status:** PASS.
- **Scope:** Additive private lifecycle controller composed from the existing bridge transition and `BridgeDrivePump`; no scheduler, registry, Markdown authority, approval, R2–R4, or public package export changes.
- **Implementation:** `src/orchestration.ts` exposes the private `lunacy-lifecycle/v1` contract (`initRun`, `runRun`, `resumeRun`, aliases, and `LifecycleController`); `src/bridge-cli.ts` adds `init`, `run`, `resume`, and `lifecycle --command …` routes. Operator semantics are documented in `docs/BRIDGE.md`.
- **Durability:** `init` submits deterministic `lifecycle-start` and relies on bridge/kernel replay for duplicate START. Run/resume recreates the ephemeral pump, preserves UNKNOWN one-observe/no-relaunch behavior, parent boundaries, cancellation, and transition limits. Policy/plan validation occurs before bridge/store access.

## Verification
- `node --test test/controller.test.js` — **6 passed** (idempotent START, dependent drive terminal, UNKNOWN observe/no-relaunch, invalid plan/policy, duplicate RESUME, cancellation/limit).
- `node --test test/r2-deployment.test.js` — **4 passed** (managed-file inventory remains unchanged after composition).
- `npm run check` — **PASS**; typecheck, full suite (**422 tests: 420 pass, 0 fail, 2 skipped**), build, and pack dry-run. Full log: `/tmp/lunacy-r1-check-final.log`.
- `git diff --check` — **PASS**.

## Compatibility / residual risk
- Legacy one-event/manual bridge route and package-root exports remain unchanged. Projection errors retain existing `ProjectionFailed` behavior; retrying the same deterministic event reuses durable replay rather than appending a second transition.
