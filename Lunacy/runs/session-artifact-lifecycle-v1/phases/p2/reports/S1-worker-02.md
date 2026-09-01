# P2 / S1 — R2 Tree-Digest Repair 02

## Control Block
Status: PASS
Step: P2/S1 repair (tree-digest encoding)
Authority: `phases/p2/hard-gate-01.md`
Product delta: `src/run-retention-platform.ts`
Test delta: `test/run-retention-inventory.test.js`
Focused gate: PASS — typecheck, build, inventory 3/3, exact R2 49/49
Broad gate: PASS — `npm run check`; 634 tests, 630 pass, 0 fail, 4 skipped; package dry-run PASS
Tracked-candidate gate: PASS — isolated candidate snapshot excluding all `Lunacy/**`; typecheck, build, 49/49 tests; `Lunacy/runs` absent
Live effects: no live install/deploy, real or historical run mutation, commit, push, P3, or P4
Result: the sole `hard-gate-01.md` finding is repaired without schema or record changes

## Repair

- Replaced the newline tuple-boundary separator with NUL. The existing sorted
  UTF-8 path, octal mode, decimal size, and lowercase content-SHA fields now
  form one unambiguous NUL-delimited byte sequence across both fields and tuple
  boundaries.
- Added an independently assembled expected digest over two files, including a
  valid filename containing a newline. The expectation uses explicit UTF-8,
  NUL bytes, fixed octal modes, decimal sizes, and independently calculated
  content hashes, so the former newline boundary encoding cannot satisfy it.
- Preserved the existing inventory, receipt, state, deployment, and lifecycle
  schemas and all other R2 behavior.

## Verification

- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `node --test test/run-retention-inventory.test.js` — PASS, 3/3.
- Exact R2 focused test set — PASS, 49/49.
- `npm run check` — PASS, 634 tests / 630 pass / 0 fail / 4 skipped;
  typecheck, build, and package dry-run also passed.
- Candidate-only gate — PASS from an isolated snapshot containing tracked files
  plus candidate additions, with all `Lunacy/**` excluded and `Lunacy/runs`
  verified absent: typecheck, build, and 49/49 tests.
- `git diff --check` — PASS before report publication.

## Self-review

Re-read the sealed architecture and hard-gate wording, checked byte-order
sorting and delimiter placement, and confirmed the test is not derived through
the production encoder. Only the assigned implementation, inventory test, and
this report were changed during repair. P1, the rest of P2, concurrent work,
authority/control files, and unrelated dirty work were preserved.
