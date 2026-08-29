# P1 Step — production deploy blocker repair

## S1 — fix and prove fresh release-envelope creation
- Status: PASS
- Reproduce/trace the fresh `--release-envelope` path and repair the shared canonical path-digest ownership seam, not only the observed line.
- Own `tools/deploy-skill.mjs`, the smallest relevant focused deployment test file(s), and `reports/S1-worker-01.md`. Do not alter product/runtime contracts unless a scope decision is returned first.
- Add a regression that would fail on the current lexical-scope bug and exercises the concrete fresh CLI envelope path far enough to prove creation does not throw; keep production filesystem/user targets out of tests.
- Verify focused release-envelope/deployment tests, typecheck/build as relevant, `git diff --check`, and terminal self-review.
- Preserve all unrelated edits; do not deploy/install/commit/push.
- Report: `reports/S1-worker-01.md`.
