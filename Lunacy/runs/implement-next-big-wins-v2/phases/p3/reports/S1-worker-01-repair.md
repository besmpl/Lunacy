# P3 S1 repair attempt — segmented/v2 reader/reuse trust fixes

Status: FINAL

## Scope
- Repaired two adversarial v2 reader/protocol defects discovered after the prior FINAL: `loadReadOnly` now rebinds `head.json` for both `segmented/v1` and `segmented/v2` (never probes nonexistent `journal.ndjson`), and `generationFence` fully verifies v2 head/segments before accepting a journal-free state projection for reuse publication.
- Hardened v2 hard-link reuse: source inode and bytes are authenticated before link and rebound/read-verified after link for sealed and active descriptors. In-place source mutation at the hard-link boundary now fails closed before CURRENT publication.
- Added regressions covering managed read-only v2 inspection, v2 reuse publication/lookup fence, and tampered sealed source rejection with CURRENT unchanged.

## Verification (terminal snapshot)
- `npm run build` — PASS.
- Focused `node --test test/p3-segmented-v2.test.js test/r2-segmented.test.js` — 18/18 PASS.
- `npm run typecheck` — PASS; `git diff --check` — PASS.
- `npm run check` — PASS; 466 tests, 464 passed, 0 failed, 2 skipped; package dry-run PASS. Full log: `phases/p3/evidence/terminal-check-repair-final.log`.

## Value / release boundary
- Paired benchmark evidence remains unchanged: 30 short + 30 long repetitions, bytes/fsync/wall distributions in `phases/p3/evidence/segmented-v2-paired.json`; wall deltas are mixed. No performance/value claim is made and v2 writer remains explicit opt-in pending parent gate.

## Control Block
- Value disposition: UNCLAIMED / explicit opt-in only.
- Repair is reader-first and fail-closed; no public API expansion or default writer enablement.
- Parent should supersede the prior S1 report with this repair report for final integration review.
