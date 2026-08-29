# P4 S1 — outer release-operation envelope

Status: FINAL

## Scope / exact paths owned

- `src/release-operation.ts` — private closed `lunacy-release-operation/v2` envelope schema/parser, exact marker/CAS publication, mutation-free status capsule, phase transitions, owner/target/snapshot/inner digest bindings; optional owner reuse in `withReleaseExclusion`.
- `tools/deploy-skill.mjs` — opt-in `--release-envelope`, `--resume-release`, and read-only `--release-envelope-status`; phase updates wrap existing exclusion, target lock, quiescence, recovery, and inner deploy/check/restore transaction. Legacy route remains unchanged without flags.
- `schemas/release-operation.schema.json` — maintained closed schema fixture.
- `docs/INSTALL.md` — private envelope operator contract and disablement/recovery guidance.
- `test/r11e-release-envelope.test.js` — deterministic status/CAS/tamper/mutation-free coverage.

Existing P1–P3 files and artifacts were preserved; no unrelated files were reverted.

## Behavior

The marker is exact-name `.lunacy-release-operation.v2.json` beside the installed target, stores digests/identities only, and never replaces release manifest, exclusion claims, quiescence, target lock, or inner deployment marker authority. Status performs no lock, discovery, cleanup, or mutation and omits paths/process arguments. Resume rebinds stale owners only through the existing liveness proof, reacquires established lock order, reuses a prior snapshot without rewriting it, recovers the existing inner transaction, and commits only after an exact managed-tree aggregate is observed. Crashes leave prepared/admitted/quiesced/delegated/attention evidence; legacy/exact CLI and transaction bytes remain unchanged when disabled.

## Verification

- `npm run typecheck`: PASS (log `/tmp/p4-typecheck.log`).
- `npm run build`: PASS (log `/tmp/p4-build.log`).
- Focused release/envelope matrix: `node --test test/r11e-release-envelope.test.js test/r11a2-release-exclusion.test.js` — 12/12 PASS (log `/tmp/p4-focused.log`).
- Crash/resume smoke: inner `marker-published` crash followed by `--resume-release` converged to successful deploy and committed outer marker (manual fixture; no residue).
- Terminal `npm run check`: PASS; 475 tests, 473 pass, 0 fail (2 skipped), package dry-run succeeded (log `/tmp/p4-terminal-check-final.log`; rerun after final target/manifest/snapshot revalidation edits).

## Remaining risk / gate handoff

The outer `inner.markerDigest` remains nullable for operations whose existing transaction marker is intentionally absent (for example check/first install); the required aggregate proof is mandatory before `committed`. P4 S2 should attack marker/owner/snapshot drift, residue and concurrent release races against this seam.

## Control Block

- Scope: P4 S1 outer envelope/integration/schema/docs/tests only.
- Authority: roadmap Direction 4 O4-A–O4-E; existing release admission/quiescence/target transaction remain authoritative.
- Compatibility: default route and exact legacy route unchanged unless explicit envelope flags are used.
- Evidence: `/tmp/p4-terminal-check-final.log`, `/tmp/p4-focused.log`.
- Result: FINAL; ready for P4 S2 adversarial pass.
