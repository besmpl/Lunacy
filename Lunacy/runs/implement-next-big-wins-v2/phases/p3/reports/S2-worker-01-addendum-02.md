# P3 S2 adversarial addendum 02 — repair3 migration/prune audit

Status: FINAL (immutable)

## Scope and findings

Audited the quiescent S1 repair3 state against the P3 named risks (digest/range/checkpoint continuity, mixed history, stale CAS/fence, path/symlink tamper, migration/rollback/GC, Memory/File parity, and release-value claim discipline). The repair3 marker validator and v1→v2 prefix guard are sound in the exercised boundaries:

- A foreign `MIGRATION.json` is rejected before cleanup and remains present; a symlink marker is rejected by the filesystem trust boundary and remains a symlink (see `evidence/S2-adversary-focused-repair3-explicit-migration.log`).
- Selecting v2 over a verified v1 generation rejects a shortened or changed canonical prefix before CURRENT publication; CURRENT remains v1 (focused regression).
- I found and repaired one adjacent P3 defect: constructing `FileArtifactStore(..., {format:'segmented/v2'})` over an existing legacy CURRENT made `migrateToSegmentedV2()` return the legacy generation without publishing v2. Migration now branches on the verified CURRENT manifest rather than constructor preference. Regression: `explicit v2 migration preference still migrates a legacy CURRENT`.
- Existing v1/v2 source identity+byte+digest rebind/fail-closed checks, journal-free v2 projection verification, historical GC exact-projection guard, rollback marker validation, and fault old-or-new convergence remain green. No mixed-generation or unverified journal exposure was reproduced.
- Maintained callers still construct stores without a v2 format; only explicit tests/bench/private migration paths select v2. The managed transition regression confirms default CURRENT has no `format` and never selects the v2 writer.

The repair leaves only bounded temporary stage debris on a rejected append; normal load quarantines such debris and no authority or recoverable generation is deleted.

## Verification

- Focused build + `node --test test/p3-segmented-v2.test.js test/recovery-forensics.test.js test/r2-segmented.test.js`: **33/33 pass**, evidence `evidence/S2-adversary-focused-repair3-explicit-migration.log`.
- Terminal `npm run check` after the last source/test change: **473 tests, 471 passed, 0 failed, 2 skipped**; typecheck/build/package dry-run pass, evidence `evidence/S2-adversary-terminal-check-repair3-explicit-migration.log`.
- `git diff --check`: pass.
- Paired corpus remains 30 short + 30 long. Arithmetic is internally consistent, but the measured `bytes` is final recursive artifact size (not bytes read/written), fsync is injector-point count, and wall deltas are environmental/mixed. Therefore value is **UNCLAIMED**; no speed/token/provider/native claim is justified.

## Control Block / gate navigation

- P3 gate: `Lunacy/runs/implement-next-big-wins-v2/PLAN.md` §“P3 — incremental bounded-prefix segmented history”, gate paragraph; `phases/p3/STEPS.md` §“Gate”.
- Recommendation: retain reader/oracle plus private explicit experimental v2 writer; do **not** enable/default/managed-select v2. P4 remains blocked pending parent gate and any new operations/bytes-read-written evidence.
- Compatibility: legacy and segmented/v1 bytes/read behavior remain unchanged; v2 remains versioned and opt-in only.
