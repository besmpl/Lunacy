# Private graph and context acceleration

The package has one public lifecycle operation, `RunKernel.advance(input)`. The
graph, stable-prefix compiler, fixed-cell reuse adapter, and counters are
private composition details. They are disabled by default and are not package
exports or a second store/lifecycle API.

Hosts that use the private `composeKernel` composition hook may opt into
`acceleration.graph`, `acceleration.context`, or `acceleration.reuse` with
`OFF`, `SHADOW`, or `ON`. `SHADOW` builds and verifies candidates but does not
publish or influence admission. `ON` may reuse only deterministic immutable
`BASE` bytes after ACL/sensitivity, source, authority, epoch, and snapshot
proof checks. A hit is also compared with a fresh pure render from the current
request; a self-consistent but forged index/blob digest therefore becomes a
quarantined cold miss rather than an authority-visible substitution. `SECRET`,
missing proofs, corruption, mutation, cancellation, and unsupported
capabilities always take the ordinary direct/cold path.
`VIEW`/state-derived requests are likewise always cold; the fixed-cell path is
reserved for immutable `BASE` material.

The mandatory plan validator and reducer remain authoritative in every mode.
Graph candidates are proposals only; commands, receipts, gates, barriers,
finality, and `.kernel/CURRENT` are still created solely by the reducer and
artifact store. Dynamic event tails are framed per call and never enter a
stable lookup key or reusable bytes. Deleting or disabling these private
modules therefore preserves yields, journal/revision transitions, effects,
recovery, and deletion parity; only local counters and acceleration latency
can differ.

Graph preparation runs after a pure reducer preflight, so a completion can
admit an indexed successor in the same `advance` call. The reducer rechecks
the base/post state digests, journal prefix, epochs, writer fence, complete
frontier and each candidate before staging a command; a stale or corrupt frame
falls back to direct evaluation. `ON` fixed-cell reuse uses the private
ArtifactStore `.kernel/reuse/` BASE blob/index/root-pin transaction path. The
blob is staged and pinned before the normal CURRENT commit, then its disposable
index row is published only after that commit. The staged row names the exact
target generation and per-event writer fence; publication re-reads CURRENT and
rejects delayed or old writers. Restart/failed-commit recovery quarantines any
pin that is not already represented by the exact index row, so orphan blobs
become safe misses and are eligible for GC. Bad-index/blob material and
differing same-key content are quarantined with no winner; deletion removes the
row and never changes the authoritative generation. No GraphView is emitted
because this package has no viewer reauthorization/timing proof.

`AccelerationMetrics.snapshot()` is diagnostic in-process state. It is not
durable authority and is intentionally lost on restart.

## Operating policy

The switches are policy, not an authority source: `OFF` is the default and is
always safe. Use `SHADOW` for compare-only traces, then a fenced `ON` canary
only after the [migration](MIGRATION.md) checks pass. `SECRET` scope, missing
ACL/read-set/snapshot proof, mutable sources, corruption, cancellation, and
rollback always bypass persistent reuse before a probe. Deleting these
private modules is therefore a supported cold-path operation, not a data or
journal migration.
