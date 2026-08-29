# P2 S2 — terminal re-verification addendum 01

## Purpose

This immutable addendum closes the authorized rerun after the shared P3 checkpoint
was interrupted and the worktree became quiescent. No P3 file was edited, reverted,
or regenerated. The prior S2 report remains immutable; this addendum records the
post-report test additions and the final terminal evidence.

## Exact post-change scope

- `test/decision-inbox.test.js`: added/retained the async caller-plan snapshot
  regression and the async successor-handoff snapshot regression. These pause the
  first verified predecessor read, mutate the caller object, then assert the
  committed decision/promotion still uses the entry snapshot.
- `src/decision-inbox.ts`: no edits after `S2-worker-01.md`; re-verified the
  existing P2 repairs (exact phase fence, canonical inbox/handoff/plan/value
  snapshots before awaits, bounded token control characters).
- No P1/P3/P4 source, test, schema, CLI, docs, deployment, or run artifacts were
  changed by this rerun (the pre-existing P3 checkpoint was preserved verbatim).

## Verification evidence

- Focused snapshot suite: `npm test -- --test-name-pattern='decision inbox|phase binding|phase promotion|snapshot'` — exit 0; 69 tests discovered, 69 passed, 0 failed, 0 skipped. Log: `/tmp/p2-s2-addendum-focused.log`.
- Terminal gate: `npm run check` — exit 0; 463 tests, 461 passed, 0 failed, 2 skipped (platform skips); typecheck/build/package dry-run completed. Log: `/tmp/p2-s2-addendum-terminal-check.log`; exit marker: `/tmp/p2-s2-addendum-terminal-exit`.

## Control Block

- **Status:** FINAL / PASS (authorized terminal rerun).
- **Scope:** P2 S2 decision-inbox/promotion adversarial verification only.
- **Post-report delta:** two async mutation regressions in `test/decision-inbox.test.js`; no source delta.
- **Authority:** kernel remains the sole token/transition authority; inbox is read-only projection.
- **Focused:** 69/69 passed, 0 failed, 0 skipped.
- **Terminal:** 463 total; 461 pass, 0 fail, 2 skipped; exit 0.
- **P3 safety:** interrupted checkpoint preserved; no P3 edits/reverts.
- **Evidence:** `/tmp/p2-s2-addendum-focused.log`, `/tmp/p2-s2-addendum-terminal-check.log`.
- **Parent gate navigation:** inspect `phases/p2/reports/S1-worker-01.md` + `S2-worker-01.md` + this addendum, then evaluate `phases/p2/hard-gate-01.md`; keep P3 blocked until the parent records PASS.
