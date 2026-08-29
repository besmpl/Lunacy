# P3 S2 adversarial durability/migration/value pass

Status: FINAL

## Scope and authorized repair
- Audited the settled `segmented/v2` reader/writer, migration/rollback/retention/GC, Memory/File parity, fault seams, and paired corpus. Preserved P1/P2 and unrelated work.
- Parent-authorized repair: `FileArtifactStore.commitSegmented` now binds a reused `segmented/v1` source by filesystem identity, reads and checks exact bytes/digest before `fs.link`, rebinds source and staged identities after linking, and verifies staged bytes; identity/content drift fails closed before `CURRENT` publication. Healthy fallback/defaults/read compatibility remain unchanged.
- Added `segmented/v1` hard-link-window tamper regression in `test/p3-segmented-v2.test.js`.

## Adversarial evidence
- Focused `node --test test/p3-segmented-v2.test.js test/r2-segmented.test.js`: **20/20 pass**, including v2 journal-free projection/reuse, v1/v2 tamper, exact v2 GC projection, long-prefix oracle, migration/rollback, P2 continuity and publication faults (`evidence/S2-adversary-focused-v1-final.log`).
- Publication fault sample covers state/segment/head/seal fsync, generation rename/publish, and CURRENT fsync/rename/publish: each failed commit restarts with one complete old-or-new authority (`S2-adversary-semantic.log`). Hard-link injector fallback remains healthy; source tamper now rejects v1 before CURRENT (`S2-v1-hardlink-race-fixed.log`).
- Gap/overlap/unknown-schema, v2 extra projection field, migration-marker/state/generation/CURRENT retry, retention pin, exact rollback, and Memory/File read-only parity all reject or converge as expected (`S2-adversary-semantic.log`, `S2-adversary-migration.log`). Ordinary append pruning is rejected by the v2 prefix check; stale generation/CURRENT CAS remains fenced.
- Exact baseline proof of the v1 defect is retained in `S2-v1-hardlink-race.log`: baseline `9e77159` committed generation 2 while linked bytes were 13 vs descriptor 962 and restart rejected; fixed run keeps CURRENT at generation 1 and rejects before publication.
- Terminal `npm run check`: **468 tests, 466 pass, 0 fail, 2 skipped**; typecheck/build/package dry-run pass (`evidence/S2-adversary-terminal-check-v1-final.log`).

## Value and release boundary
- Recomputed frozen paired run after the repair: 30 short + 30 long pairs, 0 arithmetic mismatches. Bytes deltas are positive in all pairs (short mean 94,773; long mean 2,036,919); injected segment-fsync deltas are +1/+32. Wall samples are mixed (short 17/30 positive, long 29/30 positive).
- These `bytes` are final recursive `.kernel` stat-size sums (hard-links counted per directory entry), not bytes read/written or prefix operations; fsync values are injection-point counts and wall values are environmental. No performance/token/provider/native claim is supported. Full meaning and recommendation: `decision-briefs/S2-value.md` and `evidence/S2-adversary-value-v1-fix.log`.
- Value remains **UNCLAIMED**: retain reader/oracle and explicit opt-in writer only; do not release-enable or change defaults from this corpus. Add operation/bytes-read-written instrumentation before any value claim.

## Scope-bound residual
- `src/recovery-forensics.ts:306` classifies only `current.format === 'segmented/v1'`; a v2 recovery capsule can therefore report legacy journal ceilings despite `loadReadOnly` verifying v2. This is a reporting-budget compatibility issue outside the authorized store parity seam (no authority mutation observed); schedule a follow-up before treating v2 capsule budgets as authoritative.

## Control Block / exact gate navigation
- Correctness disposition: **PASS** for this S2 semantic/recovery/fault adversary sample, including the authorized v1 parity repair; no public API expansion, silent pruning, cache authority, or default writer enablement.
- Value disposition: **UNCLAIMED / reader-only recommendation**. Follow `PLAN.md` P3 Gate and `STEPS.md` Gate: semantic/recovery/fault parity is satisfied, but H3-E writer release requires accepted bounded-prefix paired evidence; otherwise record the explicit parent reader-only decision and keep P4 blocked until that gate is closed.
