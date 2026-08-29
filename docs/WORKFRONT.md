# Private native Workfront inspection

Workfront is a disposable, read-only dependency explanation over one verified
committed runtime generation. It derives active steps, dependency-eligible
steps, bounded waiting reasons, and attention signals from the native Plan and
MachineState already owned by `RunKernel`.

The managed launcher exposes it privately:

```sh
"$NODE" runtime/bridge.mjs workfront \
  --run-root /absolute/run/root \
  --run-id exact-run-id \
  --limit 16 \
  --focus S7
```

The command emits one canonical `lunacy-workfront/v1` JSON value. `--limit`
defaults to 16 and is capped at 64; `--focus` narrows the blocked explanation
to the selected step and its direct dependency neighborhood. The capsule does
not include goals, claims, refs, payloads, receipts, paths, or journal text.

The route uses the artifact store's shared committed-state validator: managed
runtime metadata, run identity, CURRENT, generation, state, journal, dependency
topology, action/status values, and command epochs are checked once. A final
lightweight identity rebind plus a second bounded namespace scan detects
pointer, file, staged-CURRENT, or future-generation publication without
parsing and hashing the state and journal a second time. Historical generation
enumeration streams only to the runtime's journal-event ceiling.
CURRENT, managed metadata, journal, and Workfront state reads are descriptor-
bound and size-checked before allocation; an oversized or changing sparse file
fails as `ManifestMismatch`. Dependency validation uses an iterative graph
walk, so a valid deeply nested plan cannot exhaust the JavaScript call stack.

Only commands in the exact current attempt/authority/barrier/mode frame are
reported. The shared committed-state validator requires every active step to
own exactly one deterministic command for its admitted attempt; current-
attempt work must also match the exact current frame. Missing, forged, or
ambiguous bindings fail closed. Older commands, including UNKNOWN records kept
for late reconciliation, are never guessed into the current view. CLI failures
use stable, non-sensitive error classes rather than echoing internal step IDs
or paths, and the route is loaded only after Workfront argument selection.

The route does not parse Markdown, call
Beads, run a scheduler, dispatch work, or write a cache, projection, lock,
quarantine, manifest, or other file. Any trust, identity, integrity,
disabled/deleted, or topology failure is surfaced rather than downgraded to a
Markdown answer.

Workfront is intentionally private and opt-in/SHADOW-only. Existing package
exports, the public `RunKernel.advance` lifecycle, and default resume behavior
remain unchanged. Private Workfront/bridge benchmarks are excluded from the
public tarball because their runtime modules are intentionally not exported.
The local paired gate binds a frozen corpus and golden capsule digests and
enforces checkpoint, byte-reduction, output-size, and p95 latency thresholds.
Provider token or value savings are **NOT_CLAIMED**.

## Decision inbox handoff

The private `lunacy-bridge inbox` route is a projection over the same verified
generation used by Workfront. It accepts only explicitly supplied run roots;
rows contain bounded cursor/epoch and digest identities, with briefs,
receipts, paths, and payloads redacted. `submit-decision` rebinds that row and
delegates one canonical `PARENT_DECISION` to `RunKernel.advance`; it never
consumes a token itself. See [`DECISION_INBOX.md`](DECISION_INBOX.md) for the
exact parent-authorized phase promotion envelope.
