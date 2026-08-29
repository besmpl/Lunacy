# P1 hard gate 01 — release-envelope path digest repair

Status: **PASS**

- Root cause repaired: canonical path digesting is now module-scoped and shared by fresh creation, resume validation, and quiescence.
- A real temporary-target CLI regression covers fresh `--release-envelope` creation, snapshot binding, deployment, committed envelope publication, and both target/snapshot path digests.
- Worker verification passed: typecheck, build, focused release/deployment tests 12/12, and `git diff --check`.
- Parent inspected the exact repair/test seam and reran the fresh-envelope regression: 1/1 PASS.

Production was not mutated by this repair gate. The production retry must use a fresh response path and retain the exact manifest, ownership, snapshot, quiescence, target-lock, and inner transaction boundaries.
