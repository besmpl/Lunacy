# P2 Hard Gate 02 — re-gate after late snapshot regressions

## Verdict: PASS

This gate supersedes `hard-gate-01.md`, which was invalidated when two async caller-mutation regressions were added after its terminal verification snapshot.

## Evidence

- The post-report delta is test-only: async plan mutation and successor-handoff mutation regressions in `test/decision-inbox.test.js`; `src/decision-inbox.ts` did not change after the S2 report.
- P3 was interrupted without revert, making the shared state quiescent; S2 did not edit P3 files.
- Authorized focused rerun: 69/69 PASS.
- Authorized terminal `npm run check`: 463 tests = 461 pass, 0 fail, 2 platform skips; typecheck/build/pack PASS.
- The original P2 authority/compatibility findings and parent source inspection remain valid; the added tests strengthen the immutable-snapshot proof.

P2 write barrier is CLOSED again. Any later P2-owned source or test change invalidates this gate.
