# P5 Steps — integrated certification and release preparation

## S1 — audit, certify, and prepare the complete release candidate

- Status: COMPLETE — FINAL / READY.
- Owner/route: one exact Luna/xhigh integration worker; read-only product review first and repair only proven integration defects within P1-P4 maintained surfaces.
- Authority: run `PLAN.md`, all four phase gates, `docs/NEXT_BIG_WINS_ROADMAP.md`, current user notes, existing install/deploy/release contracts.
- Required inventory: every maintained affected source, CLI/runtime, schema, deploy/install, test/fixture, benchmark, docs, packaging, and compatibility surface across P1-P4; distinguish untracked run evidence from release payload.
- Required checks after last repair: focused cross-feature integration sample; authoritative `npm run check`; supported disposable deploy + direct `--check`; exact legacy/default-disabled compatibility; package contents/count/aggregate; migration/rollback/recovery smokes; writer-default guard; mutation-free status/inbox/forensics checks; `git diff --check`.
- Required evidence bundle: exact candidate baseline/diff inventory, terminal results, known skips, explicit P3 no-value/no-default-writer disposition, release/install/push plan, rollback commands/conditions, residual risks, and one recommendation: READY or BLOCKED.
- No production install/deploy/push/commit occurs in this step.
- Material contradiction or product change beyond P1-P4 authority: decision brief + DECISION_REQUIRED.
- Report: `phases/p5/reports/S1-worker-01.md`; evidence under `phases/p5/evidence/`.

## Final gate

Parent reviews the integration report and exact targeted diff/behavior, runs one bounded acceptance sample, rereads user notes, and decides goal completion/release readiness. Any P5 repair reopens the relevant phase barrier and requires fresh terminal evidence.
