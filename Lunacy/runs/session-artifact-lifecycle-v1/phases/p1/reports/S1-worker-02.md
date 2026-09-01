# P1 / S1 — R1 Doctor Repair 02

## Control Block
Status: PASS
Step: P1/S1 repair (D1 closed contracts)
Authority: `phases/p1/hard-gate-01.md`
Product delta: `src/run-retention.ts`
Test delta: `test/run-retention-model.test.js`
Focused gate: PASS — typecheck, build, 6 lifecycle tests, 11 deployment/product tests, pack dry-run
Broad gate: PASS — `npm run check`; 601 tests, 597 pass, 0 fail, 4 skipped
Mutation authority: NONE; R1 remains doctor-only
Live effects: no live install/deploy, run mutation, commit, or push
Residual risk: R2 mutation/admission/recovery remains intentionally absent
Result: all three `hard-gate-01.md` findings repaired at the shared validator/classifier seam

## Repairs

- Restricted `RESUME_PRE_RENAME` to the authoritative marker + staged receipt +
  unchanged Body prefix. A pre-marker staged receipt is now treated as
  preflight debris: the semantic state remains `BODY_ACTIVE`, or
  `READY_TO_SEAL` when exact acceptance is already present.
- Bound receipt `acceptance.kind` bidirectionally to its closed witness schema:
  manual kind accepts only `lunacy-parent-acceptance/v1`, and runtime kind
  accepts only `lunacy-runtime-acceptance/v1`.
- Bound abandonment markers to fixed
  `.lunacy-parent-abandonment.json` and `.ABANDON-RECEIPT.json.tmp` paths, while
  retaining the accepted marker's fixed-name corridor.
- Added direct positive and negative tests for both witness kinds, accepted and
  abandonment marker variants, every fixed path, and both pre-marker and
  marker-authorized classifier states.

## Terminal Verification

- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `node --test test/session-lifecycle-compat.test.js test/run-retention-model.test.js test/run-retention-doctor.test.js` — PASS, 6/6.
- `node --test test/r2-deployment.test.js test/product-surface.test.js` — PASS, 11/11.
- `npm pack --dry-run` — PASS, 139 files.
- `npm run check` — PASS, 601 tests / 597 pass / 0 fail / 4 skipped;
  typecheck, build, and package dry-run also passed.

## Self-review

Re-read the closed crash table and abandonment names in the architecture,
traced both validators and the shared classifier, and checked adjacent accepted
variants as well as the three reported refusals. No public export, installed
mutation route, deployment policy, or unrelated file was changed. The dirty
`README.md`, untracked authority documents, concurrent work, and immutable
`S1-worker-01.md` were preserved.
