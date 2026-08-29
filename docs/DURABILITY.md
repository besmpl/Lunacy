# Durable format and recovery

A filesystem kernel owns one `.kernel/` directory below `rootDir`:

- `CURRENT` is the sole authoritative pointer. It is canonical JSON containing
a positive generation, revisions/epochs, writer fence, state digest, journal
end, and journal digest.
- `generations/gN/state.json` is a complete immutable machine projection.
- `generations/gN/journal.ndjson` is the committed canonical journal prefix.
  Each line names structured identity, event, digest, and monotonic revision.
- `reuse/` is disposable private BASE blob/index/pin material. It is never
  authority and a bad or orphaned row is quarantined as a miss.
- `quarantine/` holds untrusted temporary, orphan, corrupt, and conflicting
  material discovered during recovery.

Commit stages state and journal, fsyncs files and directories, renames the
complete generation, atomically replaces `CURRENT`, and fsyncs its parent.
Readers trust only a complete, non-symlink generation named by `CURRENT`;
mixed files, symlink escapes, unknown generations, and crash debris are
quarantined or rejected before state/effect use. The in-memory store uses the
same generation CAS and is suitable for deterministic tests. Writer locks are
nonce-owned and stale locks are reclaimed only when the recorded process is
definitively gone. A missing `CURRENT` is treated as a fresh root only when no
committed generation exists; if a generation is present the load fails closed
without moving canonical generations instead of replaying a run.

Routine generation history is bounded: after a verified commit, `CURRENT` and
at most its exact immediate predecessor (`g(current-1)`) remain canonical.
Before staging the next generation, that predecessor is preflighted under the
writer fence and retired with explicit child `unlink` operations followed by
`rmdir`; missing or partially retired children are idempotent. Unsafe types,
ownership/mode drift, unexpected children, or identity changes fail closed
before deletion or successor publication. Older generations and genuinely
untrusted crash debris remain quarantine material. A malformed or
missing-with-history `CURRENT` is rejected without moving canonical
generations. The disposable `reuse/` namespace is reconciled on load only when
it already exists; default-off loads do not create an empty accelerator tree.

## Journal formats and ceiling

The legacy format is intentionally finite: **10,000 records or 1 MiB of
canonical journal bytes**, whichever comes first. An attempted event that
would cross either ceiling returns `BLOCKED` with code `JournalCeiling` and
leaves the committed state untouched.

An operator may explicitly select the private `segmented/v1` format (or call
the resumable `migrateToSegmented()` operation on `FileArtifactStore`). A
segmented generation contains immutable, canonical NDJSON files named by
contiguous revision ranges plus a canonical `head.json`; the final range is a
bounded active suffix (default 1,000 records). `CURRENT.format` and
`CURRENT.headDigest` select and bind the segmented reader. Readers validate
all ranges, chained digests, byte counts, checkpoint digest, writer fence, and
logical replay before state/effect use; unknown versions, gaps, overlaps,
mixed files, unsafe names, or digest mismatches fail closed. Legacy generations
remain loadable and are never implicitly converted.

Segmented publication stages and fsyncs every segment, state, and head, then
atomically swaps `CURRENT`; a failure leaves either the previous complete head
or a fully verified successor authoritative. A renamed-but-unreferenced future
generation is quarantined on restart so the same generation can be retried.
Ordinary append never prunes history. Retention is explicit via `compact()`
only, after the successor head is verified; cleanup validates exact descriptors,
unlinks only named children, is idempotent across partial GC, and preserves
generation references in pending migration/rollback markers. `rollbackSegmented()`
publishes a verified legacy successor while retaining segmented generations until
a later explicit retention pass.

The private `segmented/v2` marker is a separate opt-in protocol. v2 keeps
`state.json` journal-free, authenticates a contiguous sealed prefix/checkpoint
and bounded active suffix from `head.json`, and reconstructs the full logical
journal before reducer/effect use. Successors hard-link only verified unchanged
sealed ranges and stage changed suffix/state/head bytes under the existing
writer fence; ordinary append never prunes canonical history. Migration is
available through `migrateToSegmentedV2()`, rollback remains explicit, and
`compact()` is the only retention/GC operation. v2 writer enablement is
value-unclaimed until the required paired corpus and fault/parity evidence pass.

The segmented protocol changes storage layout only: reducer/event semantics,
generation CAS, writer fences, outbox/effect records, and replay bytes remain
unchanged. Measurements belong to the paired release corpus; no latency,
byte, fsync, provider, or token-saving claim is implied by segmentation.

## Restart and effects

On restart, `CURRENT` and its journal prefix are verified before state is used.
`PENDING`/`CLAIMED`/`UNKNOWN` outbox commands are reconciled by launch token.
`RESUME` commits `CLAIMED` before the private asynchronous dispatcher invokes
the driver. The final validation and synchronous entry into `driver.dispatch`
share the store's exclusive mutation fence: the current generation, writer
fence, run/phase and epochs, and the exact `CLAIMED` command bytes including
its lease must still match the caller's committed claim. A later committed
generation therefore revokes an unlaunched task even when that generation did
not change the command. File stores use the run root's writer fence; each
Memory store uses its own FIFO fence. A File launch also rebinds the root,
`.kernel` directory, and exact nonce-owned writer-lock identity after the
verified read and before driver entry, so ordinary pathname drift fails closed.

The deadline and `AbortSignal` are bounded and rechecked after the claim commit
and immediately before invocation; an abort during a slow commit or while
waiting for the store fence therefore cannot launch an effect. A throw,
malformed result, timeout, or uncertain cancellation becomes lease-scoped
`UNKNOWN` and is never blindly retried. Dispatch and observation share one safe
result classifier: arbitrary thenables, proxies, and accessor receipts are
rejected without assimilation or field access, while real Promises are watched
through the intrinsic Promise operation rather than an own `then` property. A
synchronous receipt already returned before a later successful-unlock
cancellation remains valid proof; cancellation observed during the call remains
uncertain. Promise settlement is never awaited under the store fence, and a
late matching receipt remains token-and-digest scoped so it may reconcile
`UNKNOWN` to `ACKED`. Local task cleanup is bound to the exact lease, and task
installation is monotonic by committed generation, so a delayed old
continuation cannot replace or erase a successor claim. Timeout
also removes its cancellation watcher while retaining the Promise receipt
observer. A driver with `observe` must likewise return the matching token and
command digest. Without that proof the result stays `BLOCKED` as
`UnknownDispatch`. A non-composed kernel returns
`HumanReceiptRequired` with an immutable receipt request containing the exact
launch token and command digest.

The managed Codex binding keeps the host effect witness separate from kernel
authority. Its one-token supervisor publishes a canonical launch record before
`dispatch` returns and one canonical terminal record after the child exits;
both bind the command token/digest, policy and executable identity, handoff,
expected report path/digest, and worker-result status. The drive pump may submit
those records only as the kernel's current receipt/envelope events. A missing,
stale, malformed, or conflicting record is `UNKNOWN`/`BLOCKED`; it never mints
a replacement token or launches a successor.

Dispatcher yield notification is observational: immediate receipt/uncertainty
replay is published durably first, and `onYield` runs only in a detached,
rejection-contained Promise continuation. A synchronous callback throw cannot
change the returned or replayed yield.

This boundary orders only entry into a conforming driver's synchronous
`dispatch` call; it is not a general exactly-once or remote-effect guarantee.
Rollout for a File root must stop old writers and in-flight tasks first: older
runtimes honor the writer lock for commits but do not fence dispatch entry, so
mixed-version launchers are incompatible. On-disk rollback remains readable
but reintroduces the stale-launch defect.

Gate `FINDINGS` is a new repair attempt: the parent decision consumes its
one-shot token, increments attempt/barrier epochs, reopens the barrier, and
rebuilds mutable steps while old generations remain immutable. Plan drift
creates a durable digest-bound adoption token. Recovery may reconcile old work
while that token is pending; adoption is refused until every old `ACTIVE`,
`PENDING`, `CLAIMED`, and `UNKNOWN` identity is reconciled, then one CAS
advances authority/attempt/barrier epochs and rebuilds the acknowledged plan.

Deletion of graph/context/reuse sidecars, or a corrupt/missing accelerator,
falls back to direct evaluation. It must not alter yields, revisions, journal,
receipts, barriers, or effects.

## Exclusive run-root boundary

The durable store is an exclusive local surface: the bridge requires the run
root, `.kernel`, and projection parents to be owned by the current user and
not group/world-writable (on hosts that expose ownership metadata). Keep the
root private and stable for the lifetime of a transition. The same desktop user
and its already-running processes are the host trust boundary: a malicious
same-UID actor can replace the launcher, mutate owner-writable resources, trace
the process, or rename the root and therefore requires an OS sandbox/separate
account rather than selective path checks. Crashes, cooperative cross-process
contention, unsafe ownership/modes, symlinks, stale locks, and ordinary source
drift remain fail-closed in-scope cases.
