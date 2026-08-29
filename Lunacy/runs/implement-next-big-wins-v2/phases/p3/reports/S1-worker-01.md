# P3 S1 — segmented/v2 reader-first implementation

## Control Block
- **Status:** FINAL — H3-A through H3-E implementation and proof complete; no
  default/public writer enablement or unsupported speed/token/provider claim.
- **Value disposition:** paired observations show bounded-write work (30
  short/long pairs; bytes/fsync deltas), but release value remains explicitly
  **UNCLAIMED/opt-in** pending parent gate acceptance. Wall samples are mixed
  and are not a performance claim.
- **Authority preserved:** `ArtifactStore`/`CURRENT`, generation CAS, writer
  fence, reducer/event identities, quarantine, migration/rollback and explicit
  `compact()` remain authoritative; legacy and segmented/v1 routes unchanged.

## Changed surfaces (owned inventory)
- `src/store.ts`: private `segmented/v2` selector/marker, schema-2 head,
  journal-free state projection, authenticated prefix/suffix reader, suffix-only
  successor writer with hard-link reuse, migration/rollback and GC parity.
- `src/public.ts`: segmented journal ceiling lift recognizes v2 (private store
  seam; package-root API unchanged).
- `test/p3-segmented-v2.test.js`: replay, prefix reuse, tamper, migration,
  rollback, Memory/File parity, and 9 publication-fault old-or-new cases.
- `bench/segmented-v2-paired.mjs`, `bench/README.md`: frozen 30-repetition
  short/long paired observation harness (ops/bytes/fsync-point/wall records).
- `docs/API.md`, `docs/DURABILITY.md`, `docs/MIGRATION.md`: v2 format,
  recovery, rollback, and value-boundary contract.

## Evidence and checks
- Focused semantic/fault/R2: `phases/p3/evidence/focused-semantic-fault.log`
  — 16/16 pass (legacy/v1/v2 paths, tamper, migration/rollback, fault matrix).
- Paired corpus: `phases/p3/evidence/segmented-v2-paired.json` — 30 short +
  30 long pairs. Mean bytes delta v1→v2: 94,773 (short), 2,036,919 (long);
  segment-fsync delta: 1 and 32 respectively. Measurements are observations.
- Terminal `npm run check`: `phases/p3/evidence/terminal-check.log` — 464
  tests, 462 pass, 0 fail, 2 platform skips; typecheck/build/pack PASS.
- `git diff --check` and terminal typecheck: PASS.

## Recovery/compatibility boundary
v2 readers reject unknown schema/marker, malformed or mixed generations,
gaps/overlaps, digest/range/path tamper, partial suffix/head, and stale
publication. State is exposed only after full logical journal reconstruction and
digest parity. Sealed ranges are never rewritten in place; ordinary append does
not prune history. Migration writes beside legacy/v1 and retains old
generations; rollback restores legacy through a verified successor; GC remains
explicit and idempotent.

**Parent action:** inspect evidence and decide whether the opt-in v2 writer may
be release-enabled; reader/oracle capability is safe to retain independently.
