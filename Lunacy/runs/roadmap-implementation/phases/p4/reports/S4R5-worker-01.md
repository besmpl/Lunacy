# S4R5 repair report — R4 recovery forensics gate closure

## Result

Repaired all eight gate-pack findings for the private, explicit,
token-scoped, strictly read-only `lunacy-recovery/v1` route. Every launch
intent, launch, and terminal binding is fenced by a supplied command digest;
terminal outcome/status/result/report invariants mirror the production
supervisor; deterministic report paths are derived from run/phase/step/attempt
without requiring policy; and conflicting API/CLI selector aliases are
rejected. UNKNOWN causes now use only verified matching terminal/recovery
evidence, while state-aware lease/lock classes fail closed on stale or malformed
values.

Effect reads use trusted no-follow descriptors and chunk ceilings. Namespace
iteration is bounded and target symlink/oversize/unreadable records become
stable per-record unverifiable evidence without weakening the namespace fence.
Segmented CURRENT/head manifests persist and verify their actual active suffix
ceiling. Added strict nested recovery schema, frozen canonical goldens and
schema/digest manifest, operator docs, deterministic fault/mutation tests, and
managed-wrapper coverage. Private recovery JS/declaration/source-map modules
are now carried by the managed deployment inventory; package-root exports,
Workfront, one-event, and drive routes remain unchanged.

## Verification

- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- Focused recovery/deployment/legacy restore suites — PASS (6 + 5 + 4 tests).
- `git diff --check` — PASS.
- Terminal `npm run check` — PASS; 444 tests, 442 passed, 0 failed, 2 skipped;
  npm pack dry-run completed and includes `dist/recovery-forensics.*` and
  `dist/recovery.*` (log: `/tmp/r4r5-terminal-check-final3.log`).
