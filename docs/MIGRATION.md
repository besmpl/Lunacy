# Migration, shadow, rollback, and deletion

Keep accelerators `OFF` until the local semantic, recovery, privacy, and
package matrix is green. The migration path is deliberately one-way per mode
epoch:

1. **Baseline/OFF:** mandatory plan validation, direct ready evaluation,
   reducer/CAS, CURRENT, journal, and outbox are the reference trace.
2. **SHADOW:** compile graph/context candidates and compare digests, but discard
   proposals and never publish effects or reuse rows. Shadow has an isolated
   namespace and cannot prewarm a canary.
3. **CANARY/ON:** enable only for an explicitly eligible composition-root cell
   with immutable snapshot/read-set, ACL/sensitivity, authority/epoch, and
   writer-fence proof. A failed proof is a cold miss.
4. **Promotion:** requires recorded local counters/bytes/wall timing and exact
   OFF-vs-ON semantic/deletion parity. This package does not claim provider,
   token, native, or speedup gains.

Rollback first stops new admissions and drains/observes every outbox launch
by token. Unresolved effects remain `UNKNOWN`/`BLOCKED`; no command is replayed.
Disable the mode or delete its disposable namespace under a new mode/reuse
epoch. CURRENT, journal, finalized artifacts, and evidence remain untouched;
stale rows and writers fail closed.

## Journal-format migration

`FileArtifactStore` keeps legacy `gN/state.json` + `journal.ndjson` as the
default. Select the private store format (or invoke
`migrateToSegmented()`) explicitly. Migration stages a complete successor with
sealed `segment-<start>-<end>.ndjson` files and `head.json`, verifies logical
prefix/replay and digest continuity, then swaps `CURRENT` once. The old
generation is retained, so an interrupted stage is resumable and cannot create
a mixed reader. Migration and rollback leave canonical marker records until
their `CURRENT` successor is published; restart retries or clears only the
matching marker. `rollbackSegmented()` publishes a verified legacy successor;
only an explicit `compact()` may remove unreachable generations, and pending
markers pin their referenced history. No ordinary append performs retention or
history deletion.

Deletion testing removes graph indexes, context compiler output, and reuse
blobs/indexes, then replays the same fixture through OFF. The expected result is
byte/identity-equivalent yields, revisions, journal transitions, refs,
receipts, barriers, and effects; only private diagnostic counters and local
latency may differ. `SECRET` scope is denied before any reuse probe and always
uses the cold path.
