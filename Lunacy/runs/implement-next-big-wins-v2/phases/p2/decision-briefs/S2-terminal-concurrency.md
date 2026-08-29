# P2 S2 terminal-verification concurrency decision brief

## Question
Can S2 rerun the required terminal `npm run check` after the final snapshot regressions while another active worker is mutating shared P3 source/test surfaces?

## Facts
- S2 changed only `src/decision-inbox.ts` and `test/decision-inbox.test.js`; focused tests pass.
- The first full `/tmp/p2-s2-terminal-check.log` predates the final two snapshot regressions.
- Shared workspace now has concurrent uncommitted P3 edits in `src/public.ts`, `src/store.ts`, and `test/p3-segmented-v2.test.js`.
- Running the broad matrix while those files are in flight would not be an immutable S2 terminal snapshot and would consume another worker's unfinished result.

## Recommendation
Pause/settle the active P3 worker, then rerun `npm run check` once on the settled shared state. If P3 remains active, parent may authorize a bounded P2-only check and record broad verification as deferred; do not alter or hide P3 files.

## Evidence
- Prior broad log: `/tmp/p2-s2-terminal-check.log` (459 tests; predates final snapshot tests).
- Current S2 focused run: terminal output from `npm test -- --test-name-pattern='decision inbox|phase binding|phase promotion|snapshot'` (69 tests, all pass).
