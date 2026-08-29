# S1R1 Repair Report — R1 lifecycle controller

## Control

- **Status:** PASS.
- **Scope:** Repaired the parent-gate documentation omission and re-audited the
  existing R1 implementation against the roadmap and S1 contract. No R2–R4,
  scheduler, registry, Markdown authority, automatic approval, or public package
  export changes were introduced.
- **Documentation:** `docs/BRIDGE.md` now truthfully documents private `init`,
  `run`, and `resume` syntax, explicit boundaries/non-goals, deterministic
  restart/UNKNOWN handling, the legacy one-event fallback, projection retry,
  and invocation/package rollback.
- **Re-audit:** The controller remains an additive composition in
  `src/orchestration.ts` and the private CLI routes in `src/bridge-cli.ts`.
  Input plan/policy binding is validated before bridge/store mutation; `init`
  uses deterministic `lifecycle-start` replay; run/resume delegate all durable
  decisions to the existing pump/kernel; parent boundaries, cancellation,
  UNKNOWN observe/no-relaunch, projection failure, and transition limits remain
  visible. Package-root exports and the legacy one-event route are unchanged.

## Verification

- `node --test test/controller.test.js` — **7 passed** (duplicate START/RESUME,
  dependent parent boundary, UNKNOWN observe, invalid plan/policy, cancellation,
  projection failure/replay, and transition limit).
- `node --test test/r2-deployment.test.js` — **4 passed**; managed deployment
  inventory remains unchanged.
- `npm run typecheck -- --pretty false` — **PASS**.
- `git diff --check` — **PASS**.
- Terminal `npm run check` — **PASS**; full suite **423 tests: 421 pass,
  0 fail, 2 skipped**, build and pack dry-run included. Log:
  `/tmp/lunacy-r1r1-check-final.log`.

## Residual risk

Projection faults intentionally retain the established `BridgeError`/
`ProjectionFailed` surface; retrying the same deterministic identity reuses the
committed kernel replay and does not append another transition.
