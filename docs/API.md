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
`PARENT_DECISION` with the legacy string `FINDINGS` similarly opens a fresh
attempt and barrier by conservatively resetting every step. An opt-in
`{ decision: 'FINDINGS', ownerStepId }` value instead marks that known Plan
owner `REPAIR` and resets only its transitive DAG dependents; unrelated DONE
steps and historical command/proof identities remain unchanged. The shape and
owner are validated before the one-shot token is consumed, and ambiguous
topology falls back to the legacy reset. Finalized prior evidence remains
immutable.

`KernelOptions.acceleration` retains only in-process managed diagnostics.
Legacy graph-mode decorations are accepted as inert input and never alter the
direct validator/reducer/store admission path or create a second lifecycle.

The package-root `KernelOptions` intentionally has no journal-format switch.
Long-lived local runs may select the private `FileArtifactStore` format through
the operator/store seam described in [durability](DURABILITY.md); ordinary
append never implicitly migrates or compacts a run.

The opt-in `segmented/v2` selector (or `migrateToSegmentedV2()`) stores a
journal-free state projection beside an authenticated sealed-prefix/checkpoint
and bounded active suffix. The reader reconstructs and verifies the complete
logical journal before returning a snapshot; v1 and legacy selectors are
unchanged. This is a private experiment and remains value-unclaimed until the
paired corpus and recovery/fault evidence authorize a release decision.

The private driver hook is documented in [installation](INSTALL.md). Only the
composition subpath documented there is intentionally available for host binding;
other `dist/` modules are not package exports and may change between releases.
Do not persist or depend on private `MachineState` fields outside `.kernel`.

### Private adaptive deliberation

Adaptive Direct/Focus/Explore does not add a public lifecycle, event, store,
or authority API. Direct is a true managed bypass. Focus/Explore use private
composition inputs and the same `RunKernel.advance()` state machine; Wave v2
and Report v2 are content artifacts, while topology/progress and managed
receipt/anchor state remain private. The parent alone consumes a deliberation
decision and adopts a complete Plan.

The package/runtime has no ambient rollout policy: when the host supplies no
managed composition inputs, the ordinary path remains the fail-safe default.
Plain `$lunacy` Plan authorship defaults to exactly one canonical typed `AUTO`
request in the separately installed operator profile; explicit `DIRECT` and
explicit `EXPLORE` remain authoritative overrides. AUTO never selects Explore,
and a complete Plan takes the physically isolated zero-call Direct branch. An
eligible unresolved named discriminator separately composes D3 with
`createManagedRolloutPolicy({ generation: 1, mode: 'automatic-focus' })` only
for one generation-1,
effect-denied Wave before the acceptance pointer/Plan is sealed and before the
first implementation spawn. It never automatically WIDENs or re-enters from a
gate, repair, worker completion, resume, rollout, or an existing
rollout-bearing run; an unsettled Wave returns exactly one parent decision
boundary. Direct remains a true bypass; user-explicit ADHD/Explore remains
available and explicit-only. Missing or nonconforming capability, Wave, role
policy, or eligibility is disabled/refused without fallback. Shadow is synthetic/disposable and mechanically
non-authoritative; every admitted mode requires exact closed eligibility and
the attested Luna/max effect-denied host.
`managedKillSwitch: true` refuses managed admission, and a strictly newer
`disabled` policy revokes subsequent resume/admission. Diagnostics are lossy
and cannot feed policy or authority. Do not persist, edit, or build an operator
API around private `managed` MachineState fields. See the [adaptive operator
contract](../orchestrator/DELIBERATION.md).

The installed host boundary is not a package API. The fingerprinted private
`runtime/bridge.mjs resolve-plan` route accepts the exact existing
closed `DIRECT | AUTO | EXPLORE` request; managed routes additionally carry exact deliberation/rollout policies. It calls the private resolver once. Direct
returns a complete Plan with no managed composition; Focus/Explore validate and
enter the existing START path. Current Explore requires a fresh one-use
process-local exact binding verified by composition and kernel admission. No
authorization type, mode enum, state field, or root export is added.

### Private decision inbox and phase handoff

`dist/decision-inbox.js` is a private, additive route. `listDecisionInbox`
accepts only an explicit list of run roots and returns deterministic,
redacted `lunacy-decision-inbox/v1` projections. `submitParentDecision`
rebinds the projection's generation, cursor, epochs, plan digest, and token
identity before delegating one `PARENT_DECISION` to `RunKernel.advance`.
Invalid bindings do not consume a token; retries use the same event identity
and return the kernel's committed replay.

When that call wins a fresh decision CAS and supplies a live driver, the
private boundary retains one process-local symbol only until the durable
commit returns, consumes it, and tail-calls the existing `resumeRun` pump.
The returned decision result and every durable byte keep their established
shape. Replays, CAS losers, and driverless submissions never tail-call; a
driverless or crashed process may leave ordinary `PENDING` work, which a fresh
process recovers through the normal `resume` lifecycle.

`promotePhase` accepts one `lunacy-phase-handoff/v1` envelope containing exact
predecessor proof, successor plan/phase identity, and a parent authorization
digest. It requires predecessor `COMPLETE`/`PASS` with no live old work before
calling `initRun` for the explicitly named successor. It performs no discovery,
queue scheduling, automatic approval, or general DAG traversal.

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
