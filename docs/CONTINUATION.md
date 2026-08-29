# Private durable continuation (v1)

`src/continuation.ts` is a disabled-by-default, private observation seam. It
stores one bounded `lunacy-continuation/v1` record at
`.kernel/continuation.json` under an already initialized FileArtifactStore
root. The sidecar is feature-owned metadata: it never edits `CURRENT`, the
journal, outbox, projections, or decision-inbox state.

A session is explicitly created with a run/phase/plan (and optional host-policy)
binding. Creation first performs the existing read-only `CURRENT` verification
and records root filesystem identity, owner nonce/lease epoch, deadline,
maximum wakes, revocation generation, an in-flight wake fence, and a closed
wake-source allow-list.

## Filesystem and crash contract

Continuation assumes a stable namespace for the duration of one operation: the
selected run root, `.kernel`, their ancestors, and continuation-owned names are
existing, current-user-owned, private, and are not concurrently renamed,
replaced, unlinked, or relinked by another same-UID actor. This is an explicit
contract ceiling, not a hostile same-UID containment claim.

Within that stable namespace, publication samples the run-root and parent
`{dev, ino}` identities at entry and around every lexical mutation. It creates
one unpredictable same-parent temporary with
`O_CREAT|O_EXCL|O_NOFOLLOW`, captures and rechecks the temporary inode, writes
canonical bytes, fsyncs and closes it, validates parent/temporary identity again,
renames it over the sidecar, then validates and fsyncs the parent directory. A
crash therefore exposes either the prior complete sidecar or the complete next
sidecar. An already observable parent, temporary, or sidecar substitution fails
closed before the next mutation; no fallback pathname is used.

Lock acquisition uses the fixed lock name with exclusive no-follow creation,
canonical owner nonce/PID bytes, file fsync, and exact parent/inode/byte
verification. Existing locks are never reclaimed by mtime, age, lease expiry,
or presumed liveness; contention returns bounded `SIDECAR_CONFLICT`. Release
and temporary cleanup unlink only after the current parent and captured inode
still match, plus exact canonical owner bytes for a lock or exact expected
temporary bytes for a publication. Any
absence, mismatch, symlink, parse/read, or identity inspection error is a
no-op. A same-UID replacement scheduled after the final sample and before a
lexical syscall is outside this stable-namespace contract and is not claimed to
be atomically prevented.

The in-flight fence prevents two owners from driving the same session; if a
process crashes after checkpoint, restart sees the fence and returns bounded
attention rather than relaunching. `loadContinuationSession` repeats the
`CURRENT` and filesystem-identity checks, which is the restart boundary.
`wakeContinuationSession` accepts only an `explicit-resume`, or a `proof`
accompanied by a certified terminal/launch witness that is bound under the
checkpoint lock to the exact current run, outbox command, effect token/digest,
phase, and attempt. The ACKED outbox receipt envelope and immutable launch
record are revalidated byte-for-byte; bare receipt, terminal, or inbox labels
are disabled. It checkpoints one wake atomically and invokes the existing
`resumeRun`/`BridgeDrivePump` lifecycle once. No timer, queue, discovery,
daemon, scheduler, or decision submission is present. A cancellation,
lease/binding drift, stale liveness, malformed or stale proof, `UNKNOWN`,
unsupported boundary, deadline, or wake exhaustion yields bounded `ATTENTION`
and never relaunches work.

Missing sidecars are treated as `DISABLED`; manual lifecycle, fleet, and inbox
paths therefore remain byte-compatible and require no run rewrite.
