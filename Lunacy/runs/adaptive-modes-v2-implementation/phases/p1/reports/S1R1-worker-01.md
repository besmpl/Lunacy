# P1 S1R1 Worker 01 — Retained Managed Restart and Authority Firewall Repair

## Control Block
- Status: **PASS**
- Scope: the two S1 gate blockers only: production multi-process retained managed composition and ordinary implementation authority confinement.
- Repair commit: `60e0c2c0b67a0f68dc050b5189cde4c3fec80181`.
- Repair tree: `fd21271cc9bda0b0340a0e4e47991423b2b66278`.
- Baseline / remote predecessor: `979e169b05230ac2793da609c8afa6eb95ad4262`.
- Remote promotion: safe fast-forward `origin/main` to the repair commit; no force push.
- Full terminal matrix: **715 tests, 711 pass, 0 fail, 4 platform/provider skips**.
- Focused repair matrices: **58/58** and **21/21** pass.
- Installed state: production target atomically redeployed with retention admission/abandonment `OFF`; final production `--check` is `current`.
- Installed source digest: `07e6f31e0479ad139c8e19635535623221ff808e542dd452a30ef18e5d7d02b0`.

## Repair
- Added an invocation-local managed bridge context that reconstructs the exact retained managed composition from existing closed capability, rollout, deliberation-policy, host-policy, retained Wave, and policy-version bindings. No controller, public mode state, scheduler, ledger, or persisted authority was added.
- Extended bridge lifecycle, drive, generic transition, and decision submission so each separate installed CLI process can recompose the retained Luna/max route. START now goes through the production bridge manifest path rather than a test-only direct kernel closure.
- Delayed provider dispatch until the bridge operation lock is durably released while keeping provider preparation and recovery ahead of the gate. Accepted deliberation receipts become real report envelopes, and token rebinding handles managed preparation across both same-process pumps and process restarts.
- Routed a managed COMPLETE_PLAN settlement through the production decision bridge, adopted its distinct Plan digest, and resumed the subsequent roleless command on the existing ordinary Sol/high policy.
- Restricted caller-supplied ordinary instruction paths to the exact adopted run `PLAN.md` and `DECISIONS.md`. Dynamic STEPS, ENGINEERING, and worker schema remain internally owned authority. Raw Wave, Reports, renderer output, Body, and transcripts cannot enter the handoff or sealed launch snapshot.
- Preserved accepted Plan proof/criteria/risks and decisions in ordinary authority, Direct isolation, compatibility assets/floor, fences, and existing state/receipt ownership.
- Corrected the production Darwin immutable-entry fence when workspace and run root share one filesystem identity; the fence now releases that identity once.

## Exact-Commit Verification
- Focused bridge/orchestration/inbox/host-policy/supervisor/resolve-plan/post-plan/multi-process matrix — PASS 58/58; log `/tmp/s1r1-focused.log`, SHA-256 `617cbf95fef3c5337a405afc777572149ef7adb3df33cef7c7228d10f6693d86`.
- Cancellation/writer-boundary matrix after the final rebind fix — PASS 21/21; log `/tmp/s1r1-cancel2.log`, SHA-256 `b85e087056dafdbecca4630ccf313f22f5db44d2e9cf95a321efb63b73b1fd21`.
- `npm run check` — PASS: typecheck, build, 711/0/4 of 715 tests, and `npm pack --dry-run` (167 files, 636.8 kB); log `/tmp/lunacy-s1r1-check3.log`, SHA-256 `47ccc2d3d2bdaf066c07595f6fd5ce4d4ba94828f8dfd7ca97a529bf3e160f01`.
- Self-review repaired the only discovered regressions: deployment inventory cardinality, cancellation of internal deliberation, fresh-kernel claimed-command recovery, and writer-admission blocking during ordinary prompt capture. All affected matrices then passed.

## Required Installed Samples
- The installed built CLI ran separate processes for production START, drive/restart to Reports, decision-inbox listing, submit-decision/adoption of a distinct Plan, and ordinary dispatch. It proved retained Reports used Luna/max, both managed and ordinary provider entry observed no bridge lock, and the post-adoption command used Sol/high — PASS 1/1; log SHA-256 `c96e8dad8a400df2304d04b7d8d83bf3143fabb9659b6a4989c6129970a8a7c6`.
- The installed policy/supervisor modules ran the authority poison fixture. Exact policy, command paths, handoff stdin, and sealed snapshot excluded Wave, raw Report, renderer, Body, and transcript poison while retaining the adopted Plan, accepted proof, and accepted risk — PASS 5/5; log SHA-256 `c0fe733d74288f252c446d244c5c4810fddd3600b89b722551a3109cd3ed06f5`.

## Disabled Atomic Production Reinstall
- Confirmed no live installed-runtime process, acquired the existing production release exclusions, and bound a fresh post-acquisition canonical process snapshot to the exact release owner.
- Used only `tools/deploy-skill.mjs` with a canonical production release manifest, bounded retention parent, and both retention switches `OFF`; no hand-copy or piecemeal installed edit.
- Deploy returned `deployed`: 217 payload files, 223 managed files, managed aggregate `1cbf1ecd71e6a38fcc28933d910ed6931f1bf42da12ef0ce9274fd7499b079c4`, empty retention-state census, and one-shot floor 22.
- After both installed samples, a separately owner-bound production check returned `current` with the same source digest, managed aggregate, and empty retention-state census.
- Evidence directory: `/Users/mark/Documents/Codex/2026-09-01/lunacy-execution-evidence/adaptive-v2-s1r1-60e0c2c/`.

## Remaining Risk
- No known S1R1 gate defect remains. The managed reconstruction carrier is intentionally invocation-local: every post-exit CLI operation must present the same closed four-file managed context, and mismatched retained bindings fail closed rather than fall back or downgrade.
