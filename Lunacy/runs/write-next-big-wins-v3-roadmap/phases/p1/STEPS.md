# P1 Step — roadmap authoring

## S1 — write the detailed four-direction roadmap
- Status: PASS
- Owner may write only `docs/NEXT_BIG_WINS_V3_ROADMAP.md` and `reports/S1-worker-01.md`.
- Authority: this run's `PLAN.md`, the accepted S5 report and hard gate under `Lunacy/runs/next-big-wins-v3/phases/p2/`, applicable project instructions, and existing repository roadmap/documentation conventions.
- Begin with an existing-system/reuse inventory; use exact local references rather than inventing mechanisms already present.
- Detail all four directions with: problem/evidence; target outcome; non-goals; smallest coherent first release; staged follow-ons; concrete ownership/reuse seams; compatibility and recovery invariants; test/fault/benchmark evidence; rollout/rollback; dependencies; risks; and explicit exit gates.
- Add a portfolio sequence explaining shared proof vocabulary and ordering while preserving four distinct boundaries.
- Facts, hypotheses, and future proof must be visibly distinct. Do not make unsupported performance, token, provider, security, or production claims.
- Documentation only: no product code, tests, package/release/install state, git history, or accepted discovery artifacts may change.
- Verify all four directions are present exactly once at top level, links/references resolve locally, Markdown formatting is clean, and `git diff --check` passes for owned files.
- Report: `reports/S1-worker-01.md`.
