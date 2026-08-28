# API contract

The public entry point (`import 'lunacy-runtime'`) intentionally exports only
`makeRunKernel`, the error classes, `RunKernel`, `KernelOptions`, and model
types. The stable seam is:

```ts
type RunKernel = { advance(input: AdvanceInput): Promise<Yield> };
```

`AdvanceInput` carries an explicit `runId`, structured event identity, optional
`expectedRevision`, and one closed `Event` value (`START`, `RESUME`,
`PARENT_DECISION`, `DISPATCH_RECEIPT`, `WORKER_ENVELOPE`, or `OBSERVATION`).
The input and identity records are closed at the boundary: unknown fields,
non-plain objects, non-canonical values, and unsafe epochs are rejected before
the store or any accelerator is touched.
`Yield` is one of `WAITING`, `DECISION_REQUIRED`, `BLOCKED`, or `FINAL` and
always includes a compact snapshot. Duplicate identities return the exact
committed yield bytes. Conflicting identities, stale revisions, invalid
payload digests, authority drift, malformed refs, unknown event kinds, and
non-canonical result/recovery envelopes fail closed. `START.intentRef` must
name the supplied canonical plan (raw or validator-normalized digest).
Dispatch receipts must carry canonical proof bytes containing the launch token
and command digest; a bare ref cannot acknowledge an effect. `COMPLETE` and a
closed gate/barrier are sticky and reject later ordinary events.

## Private asynchronous driver composition

The private `lunacy-runtime/dist/composition.js` subpath accepts a driver plus
bounded dispatcher controls without changing the public lifecycle:

```js
const kernel = composeKernel({
  plan,
  driver: {
    dispatch(command, launchToken, signal) { /* return receipt or Promise */ },
    observe(launchToken) { /* optional receipt reconciliation */ },
  },
  timeoutMs: 30_000,
  signal: abortController.signal,
  onYield: (value) => wakeParent(value),
});
```

`advance(RESUME)` durably records `CLAIMED` and returns without waiting for a
remote Promise. The dispatcher rechecks its host `AbortSignal` and internal
deadline after that commit and immediately before `dispatch`; cancellation in
that window records `UNKNOWN` without invoking the driver. A timeout, throw, or
cancellation after claim records `UNKNOWN`; the same launch token is never
relaunched. A late, matching receipt
may reconcile that `UNKNOWN` command, and the private `onYield` callback gets
the resulting `WAITING`/`BLOCKED` yield. A live in-process dispatch is fenced
from premature UNKNOWN recovery; after restart, an unproven `CLAIMED` lease is
conservatively recovered. Cancellation before claim leaves the command
`PENDING` with no effect. `composeKernel` still returns only `RunKernel`.

The managed skill's Codex implementation is one private binding of this seam:
`CodexExecDriver` delegates one already-claimed command to a one-token
supervisor and exposes only exact-token receipt/terminal observation. The
event-driven bridge pump calls the same `advance` method repeatedly; it does
not add a public lifecycle or a second scheduler. A host that does not bind a
conforming driver must receive the normal `HumanReceiptRequired` block.

When a live plan changes, `DECISION_REQUIRED` includes a durable,
digest-bound authority token. Recovery events may reconcile old work while the
token is pending. A parent may acknowledge `{ kind: 'ADOPT', digest }` only
after all old `PENDING`/`CLAIMED`/`UNKNOWN` commands and `ACTIVE` steps are
reconciled; adoption atomically advances authority/attempt/barrier epochs and
rebuilds the new step projection without remapping old command identities.
`PARENT_DECISION` with `FINDINGS` similarly opens a fresh attempt and barrier;
finalized prior evidence remains immutable.

`KernelOptions.acceleration` is composition-time configuration only. Graph,
context, reuse, metrics, cell, and snapshot are private optional accelerators;
there is no public graph/cache lifecycle. All modes preserve the direct
validator/reducer/store path. The default for every accelerator is `OFF`.

The package-root `KernelOptions` intentionally has no journal-format switch.
Long-lived local runs may select the private `FileArtifactStore` format through
the operator/store seam described in [durability](DURABILITY.md); ordinary
append never implicitly migrates or compacts a run.

The private driver hook is documented in [installation](INSTALL.md). Only the
composition subpath documented there is intentionally available for host binding;
other `dist/` modules are not package exports and may change between releases.
Do not persist or depend on private `MachineState` fields outside `.kernel`.

### Private bridge filesystem boundary

The optional managed bridge is safe only when its canonical launcher and
runtime bundle are trusted entrypoints. It verifies the release bytes before
loading private modules and rejects current-user ownership failures and
group/world-writable launcher/runtime, run-root, `.kernel`, or projection-parent
surfaces where the host exposes ownership metadata. Callers must provide an
exclusively-owned run root and must not let another process rename or replace
that root during a transition. This private contract does not protect against
a same-UID owner who replaces the trusted launcher/root; such protection needs
an OS/vendor trust root or native descriptor-based storage and is out of scope.
