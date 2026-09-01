# S1 Worker 01 — R4 legacy pilot

## Control Block
- Status: PASS; R4 M0-M3 source cell is complete.
- Observable: one explicit Git-backed Markdown-only COMPLETE run can audit, copy-publish Body, pass normal manifest acceptance/sealing, and restartably remove exact originals.
- Safety: audit is byte/mode/mtime/inode inert; originals survive until matching `RUN-RECEIPT.json`; reference/custody/identity uncertainty refuses.
- Recovery: all normative temp/Body/marker/finalizer/receipt/partial-source/completed and collision rows are closed and exercised.
- Deployment: audit/migrate are private verified-launcher routes; direct installed invocation and byte tamper refuse.
- Compatibility: no package-root export, event/state/schema change, bulk selection, live install, or real-run mutation.
- Rollout: still blocked by the architecture's metric prerequisite; only hermetic temporary Git fixtures were mutated.
- Verification: focused 23 migration tests + 77 integrated retention tests + 8 deployment tests + 11 restore tests PASS.
- Broad: `npm run check` PASS (677 tests: 673 pass, 4 skip; build and pack dry-run PASS).
- Isolated: Git-history-preserving candidate excluding `Lunacy/**`, `npm ci` + `npm run check` PASS with the same 677/673/4 result.
- Hygiene: `git diff --check` PASS; no live deploy, commit, push, reset, clean, or corpus migration.

## Implementation
- Added private `src/run-body-migration.ts`: fixed allowlist, closed marker validator, bounded no-follow inventories, Git/reference eligibility, inert audit, copy/publish transaction, receipt-bound cleanup, and recovery state machine.
- Added `tools/audit-run-artifacts.mjs` and `tools/migrate-run-body.mjs`; extended `tools/retention-launcher.mjs` and `tools/deploy-skill.mjs` so the installed routes are fingerprinted and non-bypassable.
- The allowlist is only Markdown beneath `phases/<id>/{evidence,decision-briefs}/**` plus numbered phase `gate-pack`/`hard-gate` files. Managed/ambiguous `phases/*/reports`, runtime Custody, unknown paths, unsafe kinds, dirty/untracked sources, and ceilings refuse.
- The marker binds exact run/source-root identities, sorted source identities/digests/modes/counts, published Body identity/tree digest/counts, and `BODY_PUBLISHED`; no legacy source is removed during copy publication.
- Cleanup requires a matching accepted receipt, embedded `lunacy-product-manifest/v1`, explicit manifest coverage of baseline inbound references, a clean current reference scan, and exact present-source revalidation before every unlink. Marker is last.
- Deployment census now understands migration temp/marker states and rejects direct or drifted installed tools. `.gitignore` owns only the two fixed private migration names.
- Updated `.gitignore`, `README.md`, `WORKSPACE.md`, `docs/RECOVERY.md`, `test/r2-deployment.test.js`, and the compact deployment fixture in `test/r5b-recovery-restore.test.js`.

## Verification detail
- `npm run build && npm run typecheck && node --test test/run-body-migration.test.js` — PASS, 23/23.
- `node --test test/run-body-migration.test.js test/run-retention-*.test.js test/run-abandonment.test.js` — PASS, 77/77.
- `node --test test/r2-deployment.test.js` — PASS, 8/8, including verified installed audit/migration and tamper refusal.
- `node --test test/r5b-recovery-restore.test.js` — PASS, 11/11 after carrying the new private tools in its intentionally tiny deployment fixture.
- `npm run check` — PASS; typecheck, 677-test suite, build, and `npm pack --dry-run`.
- Git-backed tracked-candidate checkout preserving repository history, excluding `Lunacy/**`: `npm ci --ignore-scripts && npm run check` — PASS.
- Git rollback fixture: exact marker-recorded sources restored from Git and mode/size/digest aggregate reverified.

## Remaining risk / rollback
- No live pilot is authorized until metrics earn rollout. A later operator must re-audit and explicitly select exactly one eligible run.
- Post-prune pilot rollback is `git restore -- <marker-recorded paths>` followed by exact mode/size/digest verification; receipts do not reconstruct bytes.
