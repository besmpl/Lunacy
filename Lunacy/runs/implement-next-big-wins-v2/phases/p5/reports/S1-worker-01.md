# P5 S1 — integrated release-candidate certification

**Status: FINAL — Recommendation: READY for parent final gate; no production action performed.**

## Candidate and maintained-surface inventory
- Baseline: `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7` plus accepted uncommitted roadmap/control artifacts.
- Tracked delta (15 files, +984/-56): `bench/README.md`; `docs/{API,DURABILITY,INSTALL,MIGRATION,WORKFRONT}.md`; `src/{bridge-cli,cli,public,recovery-forensics,release-operation,store}.ts`; `test/{r2-deployment,recovery-forensics}.test.js`; `tools/deploy-skill.mjs` (`evidence/diff-name-only.txt`, `diff-stat.txt`).
- Untracked product payload (13): `bench/segmented-v2-paired.mjs`; `docs/{DECISION_INBOX,FLEET,NEXT_BIG_WINS_ROADMAP}.md`; `schemas/{decision-inbox,phase-handoff,release-operation}.schema.json`; `src/{decision-inbox,fleet-coordinator}.ts`; `test/{decision-inbox,fleet-coordinator,p3-segmented-v2,r11e-release-envelope}.test.js`.
- `git status` has 241 untracked paths: 228 are `Lunacy/` run evidence/reports (not release payload); the 13 above are product. No P1–P4 integration defect or unauthorized public export was found; no repair was required. `git diff --check` passes (`evidence/git-diff-check.log`).
- Reviewed fleet, inbox/promotion, v2 reader/oracle + private writer, recovery-forensics, outer envelope, bridge/package CLI, deploy/install/rollback, schemas, docs, tests, benchmark, and compatibility. `docs/FLEET.md` is packaged; schema fixtures remain outside npm `files` by the existing boundary (observed, not changed; no defect proven).

## Final proof matrix (terminal evidence after settled P1–P4 state)
- Cross-feature: `node --test test/fleet-coordinator.test.js test/decision-inbox.test.js test/p3-segmented-v2.test.js test/recovery-forensics.test.js test/r11e-release-envelope.test.js test/r2-deployment.test.js` — **46/46 pass, 0 fail, 0 skip** (`focused-integration.log`).
- `npm run check` — **479 total, 477 pass, 0 fail, 2 platform skips**; typecheck/build/test/pack exit 0 (`npm-check.log`). Skips are Linux fixed-child-descriptor tests only.
- Disposable deploy target `/tmp/lunacy-p5-deploy-2VOhJx`: source digest `4c6703de632a9c21cfefbcf84aef1ed114704fbe8d7d5da6b81ac0028be7a6da`, `files=171`, `managedFiles=174`, `managedDirectories=4`, aggregate `4a3dc512c4b18c00fda2e31625c824a516bba1b30512eb6b5cdfc1522f9af925`; direct `--check` is `current` with identical values (`deploy.json`, `deploy-check.json`). Stale-target fixture `managedFiles=175` intentionally includes preserved unowned `runtime/operator-sentinel`.
- Package: `lunacy-runtime-0.3.0.tgz`, **132 files**, 353,301 bytes, 1,758,530 unpacked, shasum `8c4729534c3e3b2a6136047ec43dce4807d3578d`; private fleet/inbox/release dist and Fleet/Inbox docs present (`npm-pack.json`, `package-summary.txt`).
- Exact legacy/predecessor route **6/6 pass**; one-event CLI returns `WAITING` revision 1; installed bridge `--help`, `inbox`, `inspect-recovery`, `workfront` help all exit 0 (`exact-legacy-compat.log`, `legacy-cli-example.log`, `*help.txt`).
- Migration/rollback/recovery segmented/v2 matrix **33/33 pass** (`migration-recovery.log`). Writer-default guard **1/1**; mutation-free inbox/status/forensics **4/4** (`writer-default-guard.log`, `mutation-free.log`).

## Claim, release, and rollback boundary
- P3 is explicit: reader/oracle ships; writer is private opt-in experiment only. Corpus metrics are recursive artifact stat-size, fsync injector-point count, and mixed wall samples—not bytes read/written, prefix operations, speed, token, provider, or native value. **No value claim and no default/managed v2 writer selection.**
- Parent-controlled release sequence (not executed): freeze/review gates; `npm run check`; `npm pack --dry-run --json`; disposable `node tools/deploy-skill.mjs --target "$TARGET"` and direct `--check`; only after explicit authority, production install/deploy/push using release manifest and optional envelope flags.
- Roll back on red gate, digest/count drift, malformed/stale marker, owner/process uncertainty, failed check, or aggregate mismatch: stop new routes/writes; restore prior payload with `node tools/deploy-skill.mjs --target "$TARGET" --restore --payload "$PAYLOAD_DIR" --inventory "$INVENTORY.json" --aggregate "$AGGREGATE"`, or disable opt-in routes and return to exact legacy/segmented/v1/manual paths. Retain prior generations/transactions; never rewrite evidence.
- Residual risks: bounded lease-loss can return `LeaseLost`; outer envelope is subordinate; Linux skips above; v2 value unclaimed; no production install/deploy/push attempted.

## Control Block / exact final-gate navigation
- **FINAL / READY; no DECISION_REQUIRED, no repair, no production install/deploy/push/commit.**
- Authority: `PLAN.md` P5 + “Final gate”; `USER_NOTES.md`; `DECISIONS.md`; `docs/NEXT_BIG_WINS_ROADMAP.md`.
- Gates: `phases/p1/hard-gate-01.md`; `phases/p2/hard-gate-02.md` (supersedes 01); `phases/p3/hard-gate-01.md`; `phases/p4/hard-gate-01.md`.
- P3 value: `phases/p3/decision-briefs/S2-value.md`, `phases/p3/reports/S2-worker-01-addendum-02.md`.
- Evidence: `phases/p5/evidence/{npm-check.log,focused-integration.log,deploy.json,deploy-check.json,npm-pack.json,exact-legacy-compat.log,migration-recovery.log,writer-default-guard.log,mutation-free.log,git-diff-check.log}`.
- Parent must run one bounded acceptance sample, reread notes, inspect exact diff, and decide completion/release readiness. Any P5 source repair reopens its owning barrier and needs fresh terminal evidence.
