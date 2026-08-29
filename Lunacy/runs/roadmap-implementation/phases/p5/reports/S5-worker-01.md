# S5 Worker Report
## Control
Status: PASS
Goal/result: Integrated R1–R4 release verified, atomically installed, rollback-drilled, committed, and published to fork main.
Changed: 30 product files (R1–R4 runtime/source/tests/schemas/docs/bench/deployment); Lunacy run-control/evidence excluded from commit.
Verification: terminal `npm run check`: PASS — 446 tests, 444 pass, 0 fail, 2 platform skips; focused integration: 45/45.
Release/install: disposable deploy/check → exact 0.2.12 restore → 0.3.0 redeploy/check all exit 0; production deploy and release-boundary check exit 0.
Installed: runtime 0.3.0 / bridge 0.2.0, sourceDigest `82c364f4…`, managed aggregate `2c99447f…`; top-level policy files byte-identical.
Compatibility samples: installed legacy one-event, lifecycle init/help, inspect-recovery bounded capsule, and deployment check all PASS; no dedicated `quick_validate` entrypoint exists, so npm check + installed check are the validation proof.
Rollback: immutable 0.2.12 bundle retained (aggregate `ce68a709…`); pre-install complete-tree tar backup SHA-256 recorded.
Publication: commit `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7`; fork `main` and feature branch resolve exactly to this commit; no force push.
Self-review/fixes: NONE; no unsupported performance/provider/token claims introduced.
Principle/contract impact: NONE; kernel/public API, legacy route, durable schemas, and release exclusion contracts preserved.
Decision needed: NO
Risk/blocker: NONE
Evidence: `phases/p5/evidence/` (inventory, focused/check logs, disposable cycle, production deploy/check, installed smokes, provenance, backup, remote-head verification).

## Detail
The production release boundary used canonical manifests and a fresh owner-bound process snapshot; release and target locks were cleaned with no residue. The final installed check reported `status: current` with 163 managed files and 4 managed directories. The release commit intentionally contains no `Lunacy/` paths.
