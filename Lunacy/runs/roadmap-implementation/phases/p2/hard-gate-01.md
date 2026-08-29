# P2 Hard Gate 01 — R2 segmented journals/checkpoints

Status: PASS

## Accepted implementation
- Private ArtifactStore/operator opt-in segmented/v1 format with immutable revision-range segments, chained digests, checkpoint/head, and bounded active suffix.
- Legacy format remains default and readable; reducer/event semantics and package-root kernel API remain unchanged.
- Reader-before-writer validation, crash-safe old-or-new publication, explicit migration/rollback markers, exact descriptor/marker-pinned idempotent retention, Memory/File parity, and >10,000 logical-history support.
- No ordinary append silently prunes history and no performance/token/provider claim is made.

## Gate history and repairs
- Gate pack 01 found six material reds: future-generation retry, segmented read-only inspection, process-local ceiling authority, recursive GC, public API expansion, and missing fault matrix. S2R1 repaired all six.
- Gate pack 02 independently confirmed those six closures, then found unbound segmented CURRENT fence/epoch/count fields. S2R2 bound every field to verified state/head and added independent tamper coverage.
- Parent inspected the final verifier and exact continuity test; the final change is focused and preserves the already reviewed protocol.

## Verification
- S2R2 terminal `npm run check`: PASS — 434 tests, 432 pass, 0 fail, 2 platform skips; typecheck/build/pack included.
- Parent bounded acceptance: `node --test test/r2-segmented.test.js` PASS — 12/12, including long-history oracle, Memory/File parity, migration/rollback/compaction, mixed/unknown format rejection, orphan retry, read-only parity, CURRENT continuity, legacy ceiling authority, marker-pinned GC, and publication fault matrix.
- `git diff --check`: PASS.

## Compatibility / recovery / rollback
- Existing legacy generations remain loadable and are not implicitly migrated.
- A crash exposes only the verified old or verified new head; unreferenced future generations are quarantined and retryable.
- Migration/rollback are explicit and marker-bound; retention preserves marker-referenced history and removes only verified exact children.
- Segmented selection is a private store/operator seam, not a public `KernelOptions` expansion.

## Decision
R2 satisfies its roadmap exit criteria. P3 may begin.
