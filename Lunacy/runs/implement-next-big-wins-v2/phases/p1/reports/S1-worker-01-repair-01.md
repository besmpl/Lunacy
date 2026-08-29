# P1 S1 repair attempt — fleet CLI import boundary

## Delta
- Changed `src/cli.ts` to dynamically import `./fleet-coordinator.js` only when `--fleet-manifest` is selected. This preserves the existing one-run/manual CLI startup/import boundary while retaining the private fleet route.
- No coordinator semantics, schemas, state bytes, or public exports changed from `S1-worker-01.md`.

## Verification
- Focused `node --test test/product-surface.test.js test/fleet-coordinator.test.js`: 8 passed.
- Terminal `npm run check` on this exact state: typecheck/build completed; 449 tests yielded 446 passed, 2 skipped, 1 known baseline failure at `test/r2-deployment.test.js:30` (expected mode 164, observed 168). Full output: `/tmp/lunacy-fleet-check-final.log`.
- No further edits after this terminal snapshot; prior S1 report remains immutable.

## ENGINEERING.md Control Block
- Status: FINAL repair (import-boundary delta complete; no decision required).
- Baseline: `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7` plus accepted roadmap artifacts.
- Owned delta: `src/cli.ts`; coordinator implementation/tests/docs remain as in S1 report.
- Authority preserved: kernel `RunKernel.advance` and lifecycle/bridge remain sole transition authorities.
- Evidence: `/tmp/lunacy-fleet-check-final.log` and focused command output above.
- Remaining risk: existing R2 deployment mode-value red remains baseline-known and unrelated.
