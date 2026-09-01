# S1 Worker 02 — R4 hard-gate repair

## Control Block
- Status: PASS; both findings in `phases/p4/hard-gate-01.md` are repaired in the bounded R4 cell.
- Reference guard: current-worktree and immutable-HEAD candidates are scanned as bounded bytes regardless of extension or UTF-8 validity. Missing, special, oversized, unreadable, unstable, malformed-path, or HEAD-drift candidates report `REFERENCE_UNSCANNABLE` and cannot authorize original deletion.
- Marker publication: the canonical marker is written to the same-directory digest-bound `.lunacy-body-migration.json.stage-<sha256>` path in two observable prefixes, file-synced, atomically no-clobber linked to the fixed final name, parent-synced, then the exact linked stage is unlinked and the parent synced again.
- Recovery: a partial stage is removable only when its exact name binds the expected canonical marker digest and its bytes are an exact prefix of that expected marker. A linked publication is removable only when stage and final are the same exact two-link inode and canonical bytes. Foreign/malformed/different-content stages refuse and remain untouched.
- Safety: at every injected copy, fsync, rename, partial-stage, publish, and stage-cleanup prefix, the final marker name is absent or fully canonical and restart converges without source loss.
- Deployment: the bounded census recognizes the exact staged prefix, distinguishes one-link pre-publication from the exact two-link publication state, and refuses malformed or final-colliding unbound stages without removal.
- Rollout: still blocked by the metric prerequisite. No live install, deploy, corpus migration, commit, push, reset, clean, or real-run mutation was performed.

## Files
- `src/run-body-migration.ts` — byte-complete current/HEAD reference scans; staged marker publication, exact-prefix recovery, linked-state settlement, and fault boundaries.
- `test/run-body-migration.test.js` — invalid-UTF-8 current and HEAD binary references, missing/oversized refusal, genuine partial stage restart, final absent-or-canonical assertion at every prefix, and foreign-stage preservation.
- `tools/deploy-skill.mjs` and `test/r2-deployment.test.js` — exact staged-prefix census and collision coverage.
- `.gitignore` — exact private staged-marker prefix.
- This report only; no public package export, schema/event surface, second sealer, CAS, GC, or live policy was added.

## Verification
- `npm run build && node --test test/run-body-migration.test.js` — PASS, 31/31.
- `node --test test/run-body-migration.test.js test/run-retention-*.test.js test/run-abandonment.test.js` — PASS, 85/85.
- `node --test test/run-retention-*.test.js test/r5b-recovery-restore.test.js` — PASS, 46/46.
- `node --test test/r2-deployment.test.js` — PASS, 8/8; final focused census rerun also PASS, 1/1.
- `npm run check` — PASS: typecheck, build, package dry-run, 685 tests (681 pass, 4 skip).
- Git-history-preserving tracked-candidate checkout excluding `Lunacy/**`: `npm ci --ignore-scripts && npm run check` — PASS with the same 685/681/4 result.
- Git rollback fixture remains in the focused migration suite and reverified restored source mode/size/digest aggregate.
- `git diff --check` plus untracked-file whitespace checks — PASS.

## Remaining risk / rollback
- No live pilot is authorized until the recorded metric prerequisite earns rollout and an operator explicitly selects exactly one eligible Git-backed Markdown-only COMPLETE run.
- Before marker publication, retry performs only exact bound stage recovery; any unknown stage collision is preserved for escalation. After a completed pilot cleanup, rollback remains `git restore -- <marker-recorded paths>` followed by exact marker-recorded mode/size/digest aggregate verification.
