# P1 / S1 — R1 Doctor

## Control Block
Status: PASS
Step: P1/S1 (D0-D2)
Scope: private records/classifier, inert doctor, doctor-only verified installed route, compatibility/deployment proof
Product files: `src/run-retention.ts`; `tools/{seal-run,retention-launcher,deploy-skill}.mjs`
Tests/fixtures: `test/{session-lifecycle-compat,run-retention-model,run-retention-doctor,r2-deployment,r5b-recovery-restore}.test.js`; `test/fixtures/session-lifecycle/baseline.json`
Focused gate: PASS — typecheck, build, 6 lifecycle tests, 11 deployment/product tests, pack dry-run
Broad gate: PASS — `npm run check`; 601 tests, 597 pass, 0 fail (remaining skipped), package dry-run PASS
Mutation authority: NONE; installed launcher allowlists only `seal-run --doctor`
Live effects: no live install/deploy, run mutation, commit, or push
Residual risk: R2 mutation/admission/recovery remains intentionally absent
Result: R1 release candidate satisfies the D0-D2 acceptance boundary

## Implemented

- Froze canonical public Yield/event/state digests, restart replay, bridge paths,
  managed report path, package exports, and admission-OFF legacy behavior in a
  tracked synthetic fixture independent of `Lunacy/runs`.
- Added closed private validation for manual/runtime parent acceptance, accepted
  receipts, finalization markers, result identities, bounded cleanup entries,
  and the closed retention snapshot classifier. Nothing is exported at the
  package root.
- Added bounded trusted-path double census and deterministic doctor output with
  closed code/next-action values and an exhaustive protected-path list.
- Added source CLI and manifest/fingerprint/Node-attested installed launcher.
  Deployment atomically carries canonical OFF policy and owns the new runtime
  files across deploy/check/restore/crash paths.
- Proved bytes, mode, mtime, inode, and directory entries remain inert; census
  races, unsafe nodes, hard links, malformed records, unknown combinations,
  installed tampering, and mutation-shaped commands fail closed.

## Verification

- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `node --test test/session-lifecycle-compat.test.js test/run-retention-model.test.js test/run-retention-doctor.test.js` — PASS, 6/6.
- `node --test test/r2-deployment.test.js test/product-surface.test.js` — PASS, 11/11.
- `npm pack --dry-run` — PASS, 139 files.
- `npm run check` — PASS, 601 tests / 597 pass / 0 fail; typecheck, build, and package dry-run passed.

## Self-review

Rechecked public exports, deployment ownership/rollback fixtures, every R1
mutation-shaped route, fixed-name record bindings, receipt/marker cross-digests,
unknown-state refusal, and final diff whitespace. The pre-existing dirty
`README.md` and authority documents were preserved; no unrelated work was
reset, reverted, or overwritten.
