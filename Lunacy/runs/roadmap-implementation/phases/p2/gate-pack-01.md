# P2 Gate Pack — fresh post-write-barrier scout

## Decision

**FINDINGS — do not accept P2 yet.** The current checkout contains the R2
implementation, but the targeted gate is not closed. The worker report is not
authoritative for the final tree; the findings below are from the current
symbols and diff.

## Exact findings

1. **Segmented crash recovery leaves a future generation that blocks retry.**
   `FileArtifactStore.commitSegmented()` renames `stage` to `g{N}` and fsyncs
   `generations` before swapping `CURRENT` (`src/store.ts:1928-1937`). If the
   process dies in that window, `CURRENT` still names `g{N-1}`. On segmented
   load, `quarantineOrphans(current.generation, true)` deliberately retains all
   canonical `g*` directories (`src/store.ts:1333-1358`), including the
   unreferenced future `gN`. The next append computes `gN` and fails with
   `generation N already exists` instead of recovering the old head or adopting
   a verified new head. The same window affects rollback's staged legacy
   successor. This violates crash-safe old-or-new publication and resumable
   migration/rollback.

2. **Read-only managed inspection is hard-coded to the legacy journal path.**
   The segmented branch of `readVerifiedCurrentNoMutation()` returns the
   `head.json` identity as `proof.journal` (`src/store.ts:1685-1696`), but
   `loadReadOnly()` later unconditionally probes
   `g{generation}/journal.ndjson` and compares that identity
   (`src/store.ts:1825-1838`). Segmented generations have no such file, so
   `loadReadOnly()` cannot succeed for a valid segmented run. This breaks the
   Memory/File/read-only parity boundary used by `workfront` and quiescence.

3. **The process-local WeakSet is an authority bypass for legacy stores.**
   `markUnboundedJournal()`/`isUnboundedJournal()` are process-local and copied
   with every reducer clone (`src/reducer.ts:37-48`). Both Memory and File
   `commit()` treat that marker as sufficient to skip legacy ceilings even when
   `journalFormat === 'legacy'` (`src/store.ts:788-794`, `1941-1948`), and
   `appendJournal()` itself skips the ceilings on the marker
   (`src/reducer.ts:120-129`). A state loaded from a segmented store can thus
   be passed to a legacy store in the same process and publish >10,000 records;
   the explicit format marker, not a non-durable object bit, must be the sole
   authority. This violates opt-in legacy compatibility and the requested
   process-local-ceiling review.

4. **Compaction is recursive generation deletion, not exact reachable-segment
   GC.** `compact()` verifies only `CURRENT` and that each non-current `g*`
   entry is a directory, then calls `fs.rm(..., { recursive: true, force: true })`
   (`src/store.ts:2057-2073`). It does not validate the retired generation's
   head/segment descriptors, prove rollback/migration-marker reachability, or
   unlink only exact segment names. A pending `ROLLBACK.json` is ignored, so an
   interrupted rollback can have its referenced segmented predecessor removed.
   This is outside R2-D's required reachability/retention safety contract.

5. **The public contract was expanded despite the R2 non-goal.**
   `KernelOptions` now exposes `journalFormat?: ArtifactFormat` and validates
   it (`src/public.ts:33-41`, `69-75`), and the option is documented as a
   caller-facing selector (`docs/API.md:79-83`). The roadmap explicitly says
   R2 must not change the public API; the segmented selector should remain a
   private/operator seam (or be covered by an explicit compatibility decision).

6. **Required fault evidence is absent.** `test/r2-segmented.test.js` has only
   four happy-path tests: long prefix, Memory/File parity, migration/rollback
   plus compaction, and unknown version. There are no deterministic injections
   at segment write/fsync/rename, head/CURRENT exchange, restart, migration
   marker, rollback marker, hard-link, concurrent-writer, or GC points. The
   worker's `npm run check` therefore cannot certify the P2 fault matrix.

## Named parent acceptance samples

- **P2-ORPHAN-GENERATION:** inject failure after `gN` rename and before
  `CURRENT` rename; restart, load, and retry append. Must expose old head and
  permit retry without manual deletion, or expose a fully verified new head.
- **P2-READONLY-SEGMENTED:** create a valid segmented generation plus bridge
  metadata and call `FileArtifactStore.loadReadOnly()`. Must return the same
  state as `load()` without probing `journal.ndjson`.
- **P2-MARKER-LEGACY:** load a segmented state, pass it to a separate
  `MemoryArtifactStore({format:'legacy'})`, and attempt a >10,000-record commit.
  Must fail with `JournalCeiling`; object-local marker state must not authorize
  a legacy store.
- **P2-ROLLBACK-GC:** leave a valid `ROLLBACK.json` for an interrupted
  rollback, invoke `compact()`, and verify the marker-referenced predecessor
  remains; GC must be descriptor/reachability bounded and idempotent.
- **P2-FAULT-MATRIX:** deterministic failures at each seal/fsync/rename/head/
  CURRENT/rollback/migration/GC boundary, plus stale writer and hard-link
  races, with old-or-new-only restart assertions.

