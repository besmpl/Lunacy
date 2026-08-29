# P3 S1 repair attempt 2 — segmented/v2 historical GC trust boundary

Status: FINAL

## Scope
- Closed a GC trust gap: `removeGenerationExactly` now enforces the exact journal-free v2 state projection before synthesizing an in-memory journal. Historical generations carrying an unexpected `journal` (or any extra/missing projection field) fail closed instead of being silently normalized and deleted.
- Added a regression that tampers a historical v2 projection with `journal` and proves `compact()` rejects while CURRENT and the generation remain intact.

## Verification (terminal snapshot)
- `npm run build` — PASS; `npm run typecheck` and `git diff --check` — PASS.
- Focused `node --test test/p3-segmented-v2.test.js test/r2-segmented.test.js` — 19/19 PASS.
- `npm run check` — PASS; 467 tests, 465 passed, 0 failed, 2 skipped; package dry-run PASS. Full log: `phases/p3/evidence/terminal-check-repair2-final.log`.

## Value / release boundary
- Paired benchmark evidence remains 30 short + 30 long repetitions in `phases/p3/evidence/segmented-v2-paired.json`; wall deltas mixed. No performance/value claim; v2 writer remains explicit opt-in pending parent gate.

## Control Block
- Value disposition: UNCLAIMED / explicit opt-in only.
- Reader, reuse, link, and GC paths now fail closed on v2 projection/path tamper; no public API expansion/default writer enablement.
- Parent should supersede prior S1 repair report with this attempt-2 report for final integration review.
