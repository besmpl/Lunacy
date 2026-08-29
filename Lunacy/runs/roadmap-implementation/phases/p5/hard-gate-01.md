# P5 Hard Gate 01 — integrated release

Status: PASS

## Accepted result
- R1 lifecycle controller, R2 segmented journals/checkpoints, R3 private dispatch coordinator, and R4 recovery forensics are integrated in one exact release.
- Thirty product files are committed; `Lunacy/` run-control/evidence remains intentionally untracked and outside the product commit.
- Commit `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7` is the exact head of fork `main` and `lunacy-production-orchestration-routing`, pushed normally without force.

## Verification and release
- Terminal `npm run check`: PASS — 446 tests, 444 pass, 0 fail, 2 platform skips; typecheck/build/pack included.
- Integrated focused matrix: PASS — 45/45.
- Disposable deploy/check, exact 0.2.12 restore, 0.3.0 redeploy/check, production deploy, and release-boundary check: all PASS.
- Installed managed check: current, 163 managed files and 4 directories; no lock/residue red.
- Installed smokes: legacy one-event, lifecycle init/help, and bounded inspect-recovery capsule PASS.

## Parent acceptance
- Verified local HEAD and both remote refs equal `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7`.
- Verified installed runtime contains `lunacy-lifecycle/v1` and `lunacy-recovery/v1` and reports runtime version 0.3.0.
- Ran installed skill quick validation: PASS (`Skill is valid!`).
- Ran installed lifecycle and inspect-recovery help smokes: PASS.
- Compared all seven top-level policy files byte-for-byte against the accepted source: PASS.

## Rollback / provenance
- Immutable 0.2.12 rollback bundle is retained; disposable restore/redeploy proof passed.
- A complete pre-install tree backup and its SHA-256 are recorded under `phases/p5/evidence/`.
- Installed runtime/source aggregates and production release evidence are recorded in the S5 report/evidence directory.

## Decision
The whole roadmap is implemented, verified, installed, published to fork main, and recoverable. Final gate PASS.
