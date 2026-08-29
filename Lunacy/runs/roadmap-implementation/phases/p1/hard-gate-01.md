# P1 Hard Gate 01 — R1 lifecycle controller

Status: PASS

## Accepted implementation
- Additive private `lunacy-lifecycle/v1` controller with explicit `init`, `run`, and `resume` commands.
- Deterministic START/replay, ephemeral pump composition, bounded terminal/attention result, policy/plan binding, cancellation/limit handling, and truthful parent/UNKNOWN boundaries.
- Private CLI routes and operator documentation; package-root API and legacy one-event/manual path remain unchanged.

## Parent inspection
- Inspected the complete `src/orchestration.ts` controller diff, `src/bridge-cli.ts` route diff, and focused controller tests.
- Found one initial gate red: the S1 report claimed operator documentation that was absent from the diff. S1R1 added the missing documentation and projection-failure coverage, then reran terminal verification.
- Inspected the S1R1 documentation diff and focused test inventory; no R2-R4 behavior or unrelated product surface was introduced.

## Verification
- S1R1 terminal `npm run check`: PASS — 423 tests, 421 pass, 0 fail, 2 platform skips; typecheck/build/pack included.
- Parent bounded acceptance: `node --test test/controller.test.js` PASS — 7/7.
- `git diff --check` and untracked roadmap whitespace check: PASS.

## Compatibility / recovery / rollback
- Existing one-event/manual CLI and package exports are unchanged.
- UNKNOWN receives at most the existing exact-token observe attempt and is never blindly relaunched.
- Projection failure after committed START remains replayable without another journal event.
- Rollback is to stop invoking the additive route or redeploy the prior package; durable state is not deleted or migrated.

## Decision
R1 satisfies its roadmap exit criteria. P2 may begin.
