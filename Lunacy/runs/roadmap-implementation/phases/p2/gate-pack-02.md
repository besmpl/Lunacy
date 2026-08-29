# P2 Gate Pack — fresh post-repair scout 02

## Decision

**FINDINGS — do not accept P2 yet.** The prior six gate-pack-01 findings are
closed in the repaired paths, but the segmented manifest verifier still has a
decisive continuity gap in the current checkout.

## Prior finding closure

- **Orphan generation:** `quarantineOrphans(current.generation, true)` keeps
  only canonical generations at or below segmented `CURRENT` and quarantines a
  renamed future `gN`; the same successor generation can then be retried
  (`src/store.ts:1338-1371`, `1574-1576`, `1899-1950`).
- **Segmented read-only:** the segmented branch binds `head.json` as the
  journal proof and selects `head.json` in `loadReadOnly()`; it does not probe
  `journal.ndjson` (`src/store.ts:1677-1733`, `1819-1844`).
- **Ceiling authority:** reducer marker helpers are inert, legacy validation
  remains store-format-selected, and segmented mode is passed explicitly from
  the store (`src/reducer.ts:37-43`, `120-129`; `src/store.ts:783-801`,
  `1959-1961`; `src/public.ts:120`, `463-471`).
- **Exact GC:** `compact()` reads marker pins and calls descriptor/shape/digest
  checked exact-child unlink/rmdir; it is idempotent and does not use
  recursive deletion (`src/store.ts:2105-2190`).
- **Public API:** `KernelOptions` has no journal-format selector; format choice
  remains on the private store seam (`src/public.ts:33-61`; `docs/API.md:78-82`).
- **Fault/race matrix:** the focused R2 test has 11 passing cases covering
  orphan retry, read-only segmented parity, marker-vs-legacy ceilings,
  marker-pinned GC/partial cleanup, all segmented publication points, stale
  concurrent writers, and hard-link fallback (`test/r2-segmented.test.js:168-241`).

## Exact finding

1. **Segmented `CURRENT` fields are not fully bound to the verified head/state.**
   `validateCurrent()` only type/range-checks segmented `writerFence`, epoch
   fields, `checkpointRevision`, `segmentCount`, and `headDigest`
   (`src/store.ts:645-660`). The segmented verifier then checks state/head
   identity and state/journal digests, but its final `CURRENT` comparison only
   covers `revision`, `journalEnd`, `checkpointRevision`, and `headDigest`
   (`src/store.ts:1526-1553`). Unlike the legacy branch, it never compares
   `CURRENT.writerFence`, `authorityEpoch`, `attemptEpoch`, `barrierEpoch`, or
   `modeEpoch` to the committed state/head, nor `CURRENT.segmentCount` to the
   actual descriptor count. A tampered canonical `CURRENT` with any of these
   fields changed is accepted by both `load()` and the read-only path, despite
  the roadmap's generation/writer-fence and checkpoint/head/state continuity
  contract.

## R2 exit-criteria assessment

- **Reader-before-writer / migration / rollback:** PASS in the current paths;
  segmented commits verify the predecessor before staging, and explicit
  migration/rollback markers converge through old-or-new publication
  (`src/store.ts:1899-1950`, `2022-2100`).
- **Format/mixed-version trust and checkpoint/head/journal continuity:** **RED**
  for the unbound segmented `CURRENT` fields above; segment ranges, chained
  digests, checkpoint digest, state digest, and journal digest otherwise verify
  (`src/store.ts:1524-1553`).
- **>10,000 logical replay / bounded suffix:** PASS for the exercised 10,001
  record oracle and active-segment bound (`test/r2-segmented.test.js:23-56`,
  `src/store.ts:1526`).
- **Hard-link safety / concurrent and stale writers:** PASS in the repaired
  exact-name and generation-CAS paths and focused race/fallback tests
  (`src/store.ts:1918-1925`, `1961-2018`; `test/r2-segmented.test.js:217-241`).
- **Memory/File parity / no silent pruning / legacy compatibility:** PASS in
  focused parity, migration/rollback, and legacy-ceiling samples; ordinary
  segmented append retains prior generations and legacy format remains the
  default (`test/r2-segmented.test.js:59-85`, `143-166`; `src/store.ts:2192-2210`).
- **Docs / unsupported claims / R1 compatibility:** PASS on the reviewed
  roadmap, durability, migration, API, bridge, controller, and legacy paths;
  no performance/provider/token-saving claim was added, and package-root
  exports remain unchanged.

## Named parent acceptance sample

- **P2-CURRENT-CONTINUITY:** create one valid segmented generation, mutate one
  of `writerFence`, `authorityEpoch`, `attemptEpoch`, `barrierEpoch`,
  `modeEpoch`, or `segmentCount` in `.kernel/CURRENT` while leaving the head,
  state, and segment files untouched, then call `new FileArtifactStore(root).load()`
  and `loadReadOnly()` (with valid bridge metadata). Each must fail closed with
  `ManifestMismatch`; no mutated field may be returned or used for a subsequent
  commit. Add deterministic coverage beside the existing unknown-version and
  mixed-file tests (`test/r2-segmented.test.js:87-108`).

## Bounded verification run

- `node --test test/r2-segmented.test.js` — **11 passing**.
- `git diff --check` — clean.
