# P3 S1 repair attempt 3 — segmented/v2 migration marker and v1-prefix guard

Status: FINAL

## Scope
- Hardened v2 migration retry: a pre-existing `MIGRATION.json` is parsed and exact-validated before cleanup when CURRENT already names v2; foreign/malformed markers remain visible and fail closed.
- Prevented v2 selection over a verified v1 generation from pruning its logical prefix; migration/append verifies the complete v1 replay before publishing a v2 successor.
- Preserved concurrent adversary hard-link source checks for v1/v2 and their regression coverage.
- Added regressions for marker tamper and v1→v2 prune rejection.

## Verification (terminal snapshot)
- `npm run build` and `npm run typecheck` — PASS; `git diff --check` — PASS.
- Focused `node --test test/p3-segmented-v2.test.js test/r2-segmented.test.js` — 22/22 PASS.
- `npm run check` — PASS; 472 tests, 470 passed, 0 failed, 2 skipped; package dry-run PASS. Full log: `phases/p3/evidence/terminal-check-repair3-final.log`.

## Value / release boundary
- Paired benchmark evidence remains 30 short + 30 long repetitions in `phases/p3/evidence/segmented-v2-paired.json`; wall deltas mixed. No performance/value claim; v2 writer remains explicit opt-in pending parent gate.

## Control Block
- Value disposition: UNCLAIMED / explicit opt-in only.
- Reader, reuse, link, GC, migration, and rollback paths fail closed on v2 projection/path/marker tamper; no public API expansion/default writer enablement.
- Parent should supersede prior S1 repair reports with this attempt-3 report for final integration review.
