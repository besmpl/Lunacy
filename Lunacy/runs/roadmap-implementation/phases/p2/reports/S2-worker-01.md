# S2 Worker Report — R2 segmented journals/checkpoints

## Control
- **Status:** PASS.
- **Scope:** Private `ArtifactStore` segmented/v1 format with immutable revision-range segments, chained digests, canonical head/checkpoint, bounded active suffix, dual legacy reader, explicit migration/rollback/compaction, and Memory/File logical parity. Legacy format remains default and ordinary append never prunes history.
- **Implementation:** `src/store.ts` adds strict segmented CURRENT/head schemas, crash-safe bottom-up segment/head/CURRENT publication, quarantine-compatible recovery, format selection, resumable migration, rollback successor, and explicit retention. `src/reducer.ts` carries a process-local unbounded marker so segmented runs lift only the legacy journal ceiling without changing event/reducer semantics. `src/public.ts` adds optional `journalFormat` selection and bypasses legacy admission ceilings only for selected segmented stores.
- **Docs/corpus:** `docs/DURABILITY.md`, `docs/MIGRATION.md`, `docs/API.md`, and `bench/r2-corpus.json` document operator format choice, crash/rollback/retention semantics, and measurement claim policy.

## Verification
- `node --test test/r2-segmented.test.js` — **4 passed** (10,001-transition segmented fixture, bounded suffix, Memory/File parity, migration/rollback/compaction, unknown-version rejection).
- `node --test test/p5-generation-memo.test.js` — **14 passed**; legacy memo/cold-verifier behavior preserved.
- `npm run check` — **PASS**; full suite **425 passed, 0 failed, 2 skipped**, build, typecheck, and pack dry-run. Full log: `/tmp/r2-check-final.log`.

## Compatibility / residual risk
- Segmented writes are opt-in (`journalFormat: 'segmented'` or `migrateToSegmented()`); legacy generations remain readable and rollback retains prior segmented generations until explicit `compact()`.
- Segmented commit currently rewrites the state projection each generation and may hard-link unchanged segment files; the corpus records observations only and makes no performance/provider/token claim.
