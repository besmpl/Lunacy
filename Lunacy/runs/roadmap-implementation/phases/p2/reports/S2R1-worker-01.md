# S2R1 worker report — segmented journal gate repair

## Scope

Repaired the P2/S2 gate-pack findings against the final tree. The segmented
protocol remains an ArtifactStore/operator seam; package-root `KernelOptions`
was not expanded.

## Repairs

- Future canonical generations left by a crash after generation rename are
  quarantined on restart (only generations at or below CURRENT are retained),
  allowing the old head to reload and the same successor generation to retry.
  Publication exposes old-or-verified-new authority, including post-CURRENT
  fault windows.
- Segmented read-only inspection rebinds `head.json` as the journal proof and
  never probes `journal.ndjson`.
- Removed the reducer WeakSet authority bypass. Legacy ceiling checks are
  authoritative in the selected store format; reducer unbounded append is an
  explicit private mode passed by a segmented store. Compatibility marker
  exports are inert no-ops for old private fixtures.
- Replaced recursive generation `fs.rm` GC with descriptor/shape/digest and
  filesystem-identity checked exact child unlink/rmdir. GC is idempotent after
  partial deletion and preserves references in canonical migration/rollback
  markers; malformed or mixed generations fail closed.
- Added private deterministic fault injection points for segment/head/state
  fsync, seal, hard-link fallback, generation/CURRENT publication, migration
  and rollback markers, and exact GC unlink/rmdir.
- Added deterministic tests for named P2 samples, stale concurrent writers,
  >10,000-transition semantic-oracle parity, segmented read-only parity,
  marker-versus-legacy ceiling authority, marker-pinned retention, partial-GC
  recovery, publication fault matrix, and hard-link fallback.
- Updated API, migration, and durability/operator docs to describe private
  format selection, marker retention, exact GC, and old-or-new recovery without
  performance or token-saving claims.

## Verification

- `node --test test/r2-segmented.test.js` — 11 passing.
- Terminal `npm run check` after the final change — 432 passing, 2 skipped, 0
  failures; package dry-run completed.
- `git diff --check` — clean.
