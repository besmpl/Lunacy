# P2 / S1 — R2 Lifecycle Release Candidate

## Control Block
Status: PASS
Step: P2/S1 (D3-D9)
Scope: Body admission, atomic PASS acceptance, platform quiescence, exact inventory, rename-only sealing, published-receipt cleanup recovery, doctrine, and verified deployment
Product files: `src/{release-admission,decision-inbox,run-retention-platform,run-retention}.ts`; `tools/{with-body-writer,seal-run,retention-launcher,deploy-skill}.mjs`
Focused gate: PASS — typecheck, build, and 48/48 R2 lifecycle/deployment/product tests
Broad gate: PASS — `npm run check`; 633 tests, 629 pass, 0 fail, 4 skipped; package dry-run PASS
Tracked-candidate gate: PASS — isolated candidate snapshot excluding all `Lunacy/**`; typecheck, build, and 48/48 tests; `Lunacy/runs` absent
Live effects: no live install/deploy, real or historical run mutation, commit, push, R3 abandonment, or R4 migration
Result: the coupled R2 release candidate satisfies the D3-D9 acceptance boundary

## Implemented

- Added the shared owned-file admission protocol for supported Body writers and
  mutually exclusive retention finalization. The supported writer publishes a
  completed child artifact atomically and refuses direct installed invocation.
- Added manual acceptance and atomic runtime PASS acceptance through the shared
  decision-submission constructor. Runtime acceptance is bound to exact parent,
  journal, terminal PASS, seed, authority, and zero-active-worker evidence, with
  candidate-after-PASS recovery from the committed journal.
- Added Darwin and Linux trusted platform censuses, declared-parent process
  quiescence, open-descriptor detection, exact Body inventory, deterministic
  digests, protected-path refusal, and fail-closed unsupported-platform behavior.
- Added dry-run, accept, and resume flows with staged receipts, finalization
  markers, rename-only Body sealing, a second quiescence gate, receipt
  publication, exact cleanup, and recovery after every closed fault cursor.
- Extended the verified launcher and deployment manifest with the R2 allowlist,
  helper payloads, explicit retained-parent deployment, double census, and
  repeatable candidate compatibility while preserving admission-OFF behavior.
- Published canonical OFF policy and updated product, recovery, workspace,
  planning, engineering, ignore, and README doctrine for the supported route.

## Verification

- `npm run check` — PASS: typecheck, build, 633 tests / 629 pass / 0 fail /
  4 skipped, and package dry-run.
- Exact R2 gate — PASS: typecheck, build, and 48/48 tests spanning lifecycle
  compatibility, model/doctor, admission/writer/acceptance, native platform and
  inventory, all rename/cleanup fault cursors, E2E, deployment, and product
  surface.
- Candidate-only gate — PASS from an isolated snapshot containing tracked files
  plus the release-candidate additions, with all `Lunacy/**` excluded and
  `Lunacy/runs` verified absent: typecheck, build, and the same 48/48 tests.
- `git diff --check` — PASS before report publication.

## Self-review and Residual Risk

Rechecked fixed record names, exact identity bindings, launcher non-bypassability,
deployment ownership and crash restoration, parent/process/descriptor races,
cleanup authorization, compatibility defaults, private package surface, and
fault-state resumability. V1 runtime census support is intentionally Darwin and
Linux only; other platforms fail closed. Process-quiescence custody is scoped to
the explicitly declared parent set. P1 evidence, authority/control files, and
unrelated dirty work were preserved.
