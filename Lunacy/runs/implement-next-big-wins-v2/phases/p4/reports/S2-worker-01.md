# P4 S2 — adversarial outer/inner recovery pass

Status: FINAL

## Scope / exact paths owned

- `src/release-operation.ts` — outer envelope validation and CAS transition seam.
- `tools/deploy-skill.mjs` — opt-in release-envelope/resume identity and inner-marker binding.
- `test/r11e-release-envelope.test.js` — adversarial regressions for phase CAS, resume, and aggregate binding.

## Findings and repairs

1. **Resume was unusable for envelopes created by the CLI.** The resume comparison mixed raw pathname hashes with the shared canonical-value digest and double-canonicalized discovery/run-root arrays; every valid CLI envelope failed binding before admission. All path identities now use one canonical-value digest representation, matching `src/release-operation.ts`.
2. **Envelope CAS could retarget identities or swap owner fields.** `transitionReleaseOperationEnvelope` previously checked only operation id/manifest digest. It now validates immutable operation/manifest/target/discovery/run-root/snapshot-path identities, rejects owner changes outside a prepared rebind, requires an advancing epoch and definitive stale-owner proof, and keeps snapshot/lock/inner proofs immutable across phases.
3. **Resume could relaunch with no durable outer marker.** `--resume-release` now fails closed when the exact marker is absent instead of silently creating a fresh operation.
4. **Resume could adopt a foreign well-formed inner transaction.** Before recovery, the marker owner id is now required to match the owner captured by the outer envelope; unrelated transaction evidence remains untouched.
5. **A low-level write could publish `committed` without proof.** Validation now requires a non-null inner aggregate for committed envelopes (marker digest remains nullable for first-install/check paths).

## Verification

- `npm run build` — PASS (after repairs; `/tmp/p4-s2-build-after5.log`).
- Focused release matrix: `node --test test/r11e-release-envelope.test.js test/r11a2-release-exclusion.test.js` — PASS, 16/16 (individual runs; final envelope run 6/6).
- Terminal `npm run check` — PASS evidence: 479 tests, 477 pass, 0 fail, 2 skipped; package dry-run succeeded (`/tmp/p4-s2-terminal-check.log`).
- `git diff --check` — PASS.

## Remaining risk / gate handoff

The outer marker remains a projection; managed-tree bytes, quiescence, target lock, and inner transaction remain authoritative. The envelope stores no cryptographic authenticity beyond canonical/digest binding; tamper is fail-closed through identity/aggregate checks and CAS. No scheduler, discovery expansion, auto-approval, relaunch of uncertain effects, public API, or performance/token claim was added.

## Control Block

- Scope: P4 S2 adversarial repairs in release-operation/deploy/test surfaces.
- Authority: existing release admission/exclusion/quiescence/target transaction; outer envelope subordinate.
- Regressions: immutable phase CAS, absent-resume rejection, foreign inner-marker rejection, committed aggregate requirement.
- Compatibility: default/legacy/exact routes unchanged unless explicit envelope flags are used.
- Evidence: `/tmp/p4-s2-terminal-check.log`, `/tmp/p4-s2-build-after5.log`.
- Result: FINAL; parent P4 gate may inspect exact diff/symbols and rerun its bounded acceptance sample.
