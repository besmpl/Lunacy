# Lunacy Runtime: next-big-wins implementation roadmap

**Status:** implementation roadmap (post-release)

**Authority:** the accepted ranking in [`S5-worker-01.md`](../Lunacy/runs/next-big-wins/phases/p2/reports/S5-worker-01.md) and the PASS hard gate in [`hard-gate-01.md`](../Lunacy/runs/next-big-wins/phases/p2/hard-gate-01.md). This document is a plan, not an authorization to change source, tests, or release policy by itself.

**Order is fixed:**

1. Idempotent per-run lifecycle controller (`init` + `run`/`resume`).
2. Versioned journal segments and checkpoints.
3. Private dispatch lifecycle coordinator.
4. Token-scoped, read-only recovery/effect forensics.

The four directions are deliberately separate: lifecycle composition, durable history, private effect ownership, and diagnosis. A later direction must not be used to smuggle an unapproved scheduler, approval policy, release wrapper, or performance claim into an earlier release.

## Reading the roadmap

- The current public boundary is one `RunKernel.advance` operation; see [`docs/API.md`](API.md) (lines 1–25, 27–62).
- The bridge is an explicit, selected-run adapter and does not parse Markdown as executable authority; see [`docs/BRIDGE.md`](BRIDGE.md) (lines 1–31, 50–82).
- A run has no ambient registry or scheduler; see [`WORKSPACE.md`](../WORKSPACE.md) (lines 5–31).
- Current durability, restart, and effect rules are normative; see [`docs/DURABILITY.md`](DURABILITY.md) (lines 1–83).
- Current managed inspection is bounded and read-only; see [`docs/WORKFRONT.md`](WORKFRONT.md) (lines 1–56).
- Observed timings/bytes in the accepted report are investigation evidence only. This roadmap makes no provider, token, native, throughput, latency, or speedup claim.

## Overall sequencing and release strategy

### Baseline (R0, no product change)

Before each implementation run, capture the current direct validator/reducer/store trace and the existing bridge/pump traces as the comparison oracle. Keep the package-root exports and the one-event/manual bridge route unchanged. Record the exact test command and fixture revision in that run's evidence; do not infer a target from a small local timing sample.

### Ordered releases

| Release | Direction | User-visible boundary | Enablement and rollback |
| --- | --- | --- |
| R1 | Lifecycle controller | An explicit run-root/run-id command scaffolds or resumes one run and drives only to an existing parent boundary. | Additive private route. Disable by not invoking it; redeploy the prior package if the contract or proof fails. The one-event route remains the fallback. |
| R2 | Segments/checkpoints | A selected runtime-format run can retain history beyond the legacy append-only ceiling while preserving replay and digest continuity. | Reader compatibility lands before any writer. New format is opt-in per run/format marker. Disable new writes and keep the verified old generation on any publication/recovery red. |
| R3 | Dispatch coordinator | No new public behavior; effect ownership moves behind one private seam. | Package-compatible refactor. Revert the private delegation and redeploy the prior package; durable state/event bytes are unchanged. |
| R4 | Recovery forensics | An explicit token-scoped read-only capsule explains verified UNKNOWN/effect evidence. | Additive private route. Remove/disable the route without touching `.kernel`, effect records, or projections. |

Each release is independently releasable after its own gate. R2 must not depend on R3's code motion; R3 must not depend on R4's output schema. R1's command/result contract is frozen before R3 so a future coordinator can be substituted without changing the controller boundary. After R4, revisit deferred candidates (multi-run scheduling, decision inbox/automatic approval, release-operation wrapper, bridge projection optimization, accelerator admission, and narrower planner/reuse extraction) only as new scoped decisions.

### Cross-cutting invariants for every release

- `RunKernel.advance`, event identities, state encodings, epoch/writer fences, and exact committed-yield replay remain authoritative.
- Parent intent, adoption, approval, gate, redirect, cancellation, and final-result decisions remain parent-visible; no route reads Markdown to authorize work.
- Unknown or uncertain external effects fail closed and are never blindly relaunched.
- Filesystem reads are bounded and trust-checked; mutations hold the existing run/store fences and are crash-recoverable.
- A release is accepted on semantic parity and fault-injection evidence, not on an unmeasured forecast.

---

## 1. Idempotent per-run lifecycle controller (`init` + `run`/`resume`)

### Current evidence

- Run creation and binding are caller work: there is no registry, scheduler, lock database, or `CURRENT_RUN`; callers create `PLAN.md`, `STATE.md`, and phase material and select runtime versus Markdown mode ([`WORKSPACE.md`](../WORKSPACE.md), lines 5–31; [`SKILL.md`](../SKILL.md), lines 116–145).
- The one-event bridge CLI requires the caller to provide run directory, run ID, event, event ID, and plan ([`src/bridge-cli.ts`](../src/bridge-cli.ts), lines 145–176).
- Admission and identity checks are deterministic in the kernel ([`src/public.ts`](../src/public.ts), lines 400–469), while `BridgeDrivePump` is intentionally ephemeral and restartable from verified state ([`src/orchestration.ts`](../src/orchestration.ts), lines 103–107, 149–223).
- Projection is retryable after a successful kernel commit; durable `.kernel/CURRENT` and journal remain authority ([`docs/BRIDGE.md`](BRIDGE.md), lines 84–100).

These facts identify a composition gap, not a missing authority mechanism.

### Intended outcome

One explicit command can create or safely resume one selected run, perform the existing mechanical pump loop, and return a bounded terminal or attention result. Repeating the command after a crash or duplicate invocation must replay committed identities or stop at the same parent boundary; it must not create duplicate work or bypass an approval/gate.

### Scope and non-goals

**In scope**

- A private/additive controller contract with explicit run root, run ID, canonical plan, and (for managed drive) closed driver policy.
- `init`: scaffold only required run metadata, establish the selected runtime bridge, and submit the canonical `START` through the existing transition path idempotently.
- `run`/`resume`: load verified state, invoke the existing `BridgeDrivePump`, and return a bounded status/attention value with stop reason and transition count.
- Explicit cancellation, max-transition bound, projection retry, and stable non-sensitive error classes.

**Non-goals**

- No ambient run discovery, global registry, multi-run scheduler, queue, or fairness policy.
- No Markdown parsing for authority; no plan synthesis, auto-adoption, gate/decision resolution, or human-receipt fabrication.
- No replacement of the one-event/manual CLI, public `RunKernel` API, reducer, store, or dispatch semantics.
- No claim about provider calls, token use, native capability, or speed.

### Architecture seam

The controller is an effectful boundary around existing seams:

1. Validate explicit arguments and canonical plan/policy before touching the store.
2. Establish/verify bridge metadata and run-root trust using the existing bridge preflight.
3. Call `transition` for `START`/`RESUME`; the kernel owns identity, epoch, journal, outbox, and replay rules.
4. Delegate mechanical continuation to `BridgeDrivePump`; its `onYield`/notification channel remains the only wake mechanism.
5. Project machine-owned sections only after the committed result, preserving non-machine Markdown.

The controller must carry no durable scheduler state. Its result is a view of the verified current generation, not a second authority.

### Independently releasable milestones

**R1-A — Contract and fixture freeze.** Define canonical argument/result schemas, explicit command names, bounded output fields, error mapping, and stop-reason vocabulary. Add a two-step dependent plan fixture and a restart fixture. Freeze the one-event compatibility cases before implementation.

**R1-B — Idempotent `init`.** Implement scaffolding and bridge metadata creation through existing helpers. Submit `START` with the canonical plan ref and identity; duplicate `START` returns the exact committed replay bytes. A plan/root/run mismatch fails closed before mutation. Release this slice as an init-only command if the drive slice is not yet enabled.

**R1-C — Mechanical `run`/`resume`.** Compose `BridgeDrivePump` for a selected run. For a fresh root, start once; for an existing root, resume from verified `CURRENT`. Stop on `WAITING`/parent boundary, `DECISION_REQUIRED`, `BLOCKED`, finality, cancellation, or max transitions. Do not loop around an UNKNOWN token except for the pump's existing one bounded `observe` attempt.

**R1-D — Projection and restart hardening.** Ensure state/steps projection is retried after a committed kernel result, never treated as authority, and never allowed to cause a second transition. Prove duplicate invocation, process restart at UNKNOWN, competing pump, stale revision, and closed barrier behavior.

**R1-E — R1 release gate.** Publish the command/result contract and operator examples only after the acceptance matrix below is green. Keep the legacy one-event/manual path exercised in the same run.

### Dependencies

R1 uses the existing bridge locks, CURRENT/revision/epoch fences, transition validation, and pump semantics. It must not wait for journal segmentation or coordinator extraction. The result shape and stop vocabulary are inputs to later coordinator/forensics work, so changes after R1 require a new compatibility decision.

### Compatibility and migration

- Existing run directories and legacy Markdown runs remain readable; no automatic mode conversion occurs.
- Existing one-event invocations produce identical canonical output and remain the documented fallback.
- A controller invocation against an already-started run reuses the committed plan digest and event identities; it never rewrites `PLAN.md`, reports, decisions, or evidence.
- There is no migration transaction in R1. If bridge metadata is stale/corrupt, report the existing closed error and require the documented repair/disable flow.

### Recovery and rollback

- A crash before `START` commit leaves a fresh root that can be retried; a crash after commit replays the durable row.
- A projection failure after commit leaves `.kernel/CURRENT` authoritative; retry projection on the next invocation.
- A claimed external effect follows existing `UNKNOWN`/observe rules; the controller never relaunches it.
- Rollback is invocation-level (use one-event/manual mode) or package redeploy. Do not delete CURRENT, journal, outbox, or effect records to recover a controller failure.

### Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Duplicate START or duplicate pump creates work | Exact identity replay, bridge lock, and pump stop-at-boundary tests; no local queue. |
| Plan/root/policy mismatch | Canonicalize and validate before transition; bind managed policy to run/plan digest and trusted root. |
| Projection failure is mistaken for transition failure | Return committed result with projection status; retry projection without a second kernel call. |
| Restart UNKNOWN is relaunched | Delegate one bounded observe only; no retry path in controller. |
| Convenience command becomes a second authority | Keep all admission/epoch/gate decisions in `RunKernel.advance`; controller stores no authority. |

### Verification, fault injection, and benchmark requirements

- End-to-end two-step drive: init, successor selection, completion/phase-ready stop, and exact replay bytes.
- Duplicate START and duplicate RESUME under competing invocations: one durable row/claim winner, no second launch.
- Restart at `CLAIMED`/`UNKNOWN`: one exact-token observe opportunity, then parent boundary; no blind relaunch.
- Invalid plan, missing/invalid driver policy, stale revision/epoch, authority drift, adoption token, closed gate/barrier, cancellation, projection failure, and max-transition bound.
- Run the existing stable surfaces [`test/orchestration.test.js`](../test/orchestration.test.js), [`test/kernel-repair.test.js`](../test/kernel-repair.test.js), and the legacy CLI/bridge tests without changing their expected bytes.
- Record before/after wall time, transition count, and projection bytes for the same fixture only as reproducibility evidence. No improvement threshold or token/provider claim is authorized by this roadmap.

### Exit criteria

R1 is releasable when the explicit contract is documented in its implementation change, all acceptance/fault cases pass, duplicate and restart traces show identical committed yields/state, the legacy one-event path is unchanged, `git diff --check` is clean, and a reviewer can identify no controller-owned authority outside the kernel/pump.

---

## 2. Versioned journal segments and checkpoints

### Current evidence

- The current format is capped at 10,000 records or 1 MiB; an over-ceiling event returns `BLOCKED/JournalCeiling` and history is never silently compacted ([`docs/DURABILITY.md`](DURABILITY.md), lines 39–46; [`src/limits.ts`](../src/limits.ts), lines 1–7; [`src/public.ts`](../src/public.ts), lines 462–467).
- Every append canonicalizes the full journal prefix ([`src/reducer.ts`](../src/reducer.ts), lines 108–116), and `KernelImpl` computes full-prefix bytes before admission ([`src/public.ts`](../src/public.ts), lines 462–467).
- A file commit stages and fsyncs complete `state.json` and `journal.ndjson`, atomically publishes `CURRENT`, then verifies by rereading/parsing/hashing ([`src/store.ts`](../src/store.ts), lines 1384–1432, 1702–1743).
- The accepted performance probe observed growth in bytes and wall time at larger histories; those are probe observations, not projected gains or a release target.

### Intended outcome

A runtime-format run can continue beyond the finite legacy history budget while retaining immutable audit/replay semantics, digest continuity, generation CAS, and crash-closed recovery. A checkpoint/segment protocol should make the amount of active history read or rewritten explicit and measurable, without promising a speedup.

### Scope and non-goals

**In scope**

- A private, versioned `ArtifactStore` format: sealed immutable journal segments, one atomically published head/checkpoint, and a bounded active suffix.
- Dual-format readers and explicit format selection/migration markers; legacy unsegmented generations remain loadable.
- Segment/head digests, revision ranges, journal-end continuity, generation/writer-fence binding, and explicit compaction/retention operations.
- Crash-safe publication, recovery, quarantine, and deferred segment garbage collection.

**Non-goals**

- No silent truncation, in-place rewrite, history deletion, or compaction during an ordinary append.
- No change to reducer/event semantics, CURRENT authority, outbox/effect records, or public API.
- No mixed legacy/segmented generation accepted without a specified manifest and verification rule.
- No claim that segments reduce latency, bytes, fsyncs, or provider/token use until measured under the required corpus.

### Architecture seam

Keep the seam at `ArtifactStore` and the existing `CURRENT` manifest. A segmented generation should publish a canonical head manifest that names format version, ordered segment descriptors (range, byte count, digest), checkpoint state/revision, and active suffix. The reducer still receives the same logical journal prefix; the store assembles/streams segments for validation and replay. The existing writer fence and generation CAS protect seal/head publication. Segment files are immutable once sealed; only a new complete head is authoritative.

### Independently releasable milestones

**R2-A — Format and crash protocol.** Specify canonical schemas, digest chaining, revision/range rules, checkpoint meaning, active-suffix bound, publication order, and quarantine names. Enumerate crash windows (before seal fsync, after seal rename, before/after head swap, during CURRENT exchange, and during GC) with the old-or-new recovery result for each.

**R2-B — Reader compatibility.** Teach `ArtifactStore.load` and verification to recognize legacy and segmented manifests without changing legacy writes. Reject unknown versions, missing descriptors, gaps/overlaps, digest mismatches, unsafe paths, and mixed generations before state/effect use. Add fixtures for both formats and malformed manifests.

**R2-C — Checkpoint/head publication.** Add an explicit operation that writes a checkpoint and seals immutable segments under the writer fence, fsyncs bottom-up, then atomically publishes the new head/CURRENT. Keep an active suffix for events after the checkpoint. A failed publication leaves the prior complete head authoritative.

**R2-D — Bounded append and explicit compaction.** Route new events through the selected format, rolling/sealing the suffix at a documented bound. Compaction is a named, operator-initiated operation with a preflight proving no active reader/writer depends on retired segments. GC unlinks only exact unreachable segment names after the successor checkpoint is verified; missing/partial cleanup is idempotent.

**R2-E — Migration and R2 release gate.** Migrate one legacy run only through an explicit, resumable transaction that preserves the old generation until the segmented head is verified. Keep a rollback marker and old reader path until acceptance completes. Release segmented writes only after the long-history oracle and fault matrix pass.

### Dependencies

R2 follows R1 so longer runs have a proven one-run boundary, but it is storage-owned and independent of R3/R4. The format/crash protocol and compatibility reader must land before any segmented writer. R3 may later reduce dispatch-side coupling, but must not alter the segment schema.

### Compatibility and migration

- Legacy `gN/state.json` + `journal.ndjson` remains the default read/write format until R2-E.
- A format marker in the verified manifest selects segmented reading; absence means legacy, never implicit conversion.
- Migration writes a complete new generation/segment namespace beside the old one, verifies logical journal equality and digest continuity, and flips one atomic pointer. It never edits old files in place.
- Rollback before pointer swap removes only exact staged names. Rollback after swap uses the recorded prior pointer/head and leaves old segments intact until a later explicit retention operation.
- Memory and File stores must expose equivalent logical history and replay results; implementation-specific segment placement is private.

### Recovery and rollback

- On restart, accept only a complete old or complete new head whose segment/checkpoint digests and revision ranges verify. A missing/partial head is not an invitation to replay or guess.
- A seal or head-swap crash quarantines unreferenced staging/debris; the previous CURRENT remains usable. A CURRENT exchange crash follows existing manifest rules.
- GC is never part of publication. If reachability proof is missing, retain the segment and surface a bounded recovery condition.
- To roll back a release, stop segmented writes, finish/abort the explicit migration transaction, restore the prior package/format marker, and replay through the unchanged legacy reader. Do not prune canonical history.

### Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Event order or digest continuity diverges | Segment descriptors include contiguous revisions/end offsets and chained digests; compare against a direct logical-prefix oracle. |
| Crash between seal/head/CURRENT steps | fsync and atomic publication protocol with fault injection at every window; restart must expose old or new complete history only. |
| Writer-fence/generation CAS race | Reuse existing store fence and expected generation; stale writers fail before publication. |
| Partial migration or mixed-format read | Explicit format marker, dual reader, complete-generation verifier, and resumable exact-name transaction. |
| Premature segment deletion | Verify checkpoint reachability under writer fence before exact-child unlink; otherwise retain/quarantine. |
| Memory/File semantic drift | Run the same synthetic corpus against both stores and compare state, journal, yields, and committed effects. |

### Verification, fault injection, and benchmark requirements

- Drive more than 10,000 synthetic transitions against an unsegmented semantic oracle; require identical logical event order, replay state, committed yields, epochs, and effect bindings.
- Fault-inject segment seal, segment rename/fsync, checkpoint write, head swap, CURRENT publication, restart, and GC. Every restart must expose either the complete old or complete new history; no mixed prefix is accepted.
- Load old fixtures, malformed/unknown versions, digest/range gaps, path/symlink violations, and interrupted migrations; verify closed errors and unchanged old data.
- Exercise concurrent writers, stale generation/fence, Memory/File parity, long active suffix, and explicit compaction retry.
- Run at least 30 paired repetitions across event counts and state sizes, including near the legacy 10,000-record/1 MiB limits. Record bytes read/written, fsync counts, and wall-clock distributions. Treat these as authorization evidence only; do not claim a speedup or token/provider saving in advance.

### Exit criteria

R2 is releasable when both formats pass logical-prefix/replay parity, all publication/GC fault points are crash-closed, migration and rollback are resumable and exact-name bounded, legacy fixtures remain loadable, no ordinary append silently prunes history, and the paired measurement corpus is archived with no unsupported performance claim.

---

## 3. Private dispatch lifecycle coordinator

### Current evidence

- `KernelImpl` currently owns active dispatch state/options, validation/replay, reducer/store commits, launch/observe, cancellation/deadline, receipt settlement, and `onYield` callbacks ([`src/public.ts`](../src/public.ts), lines 300–337, 400–469, 681–732, 861–1026).
- The public contract intentionally remains one `RunKernel.advance`; the private composition seam accepts a driver and bounded dispatcher controls without adding a public lifecycle ([`docs/API.md`](API.md), lines 27–62).
- Existing durability rules depend on claim-before-launch, writer/generation fences, token/digest-scoped late receipts, and conservative restart UNKNOWN recovery ([`docs/DURABILITY.md`](DURABILITY.md), lines 48–83).

The concentration is private implementation complexity, not a reason to widen the public API.

### Intended outcome

A single private `DispatchCoordinator` owns in-flight effect state and lifecycle races. `KernelImpl.advance` remains the validation/reducer/commit facade. Future controller and recovery work can depend on this narrow owner without repeatedly editing the kernel's authoritative path.

### Scope and non-goals

**In scope**

- Extract `activeDispatches`, dispatcher options, launch/observe orchestration, timeout/cancellation watchers, receipt classification/settlement, cleanup, and `onYield` notification wiring into one private module/class.
- Preserve existing driver receiver binding, synchronous receipt handling, real-Promise observation, token/digest/lease checks, and store-linearized dispatch boundary.
- Add focused private types/interfaces only where they clarify ownership and make differential tests possible.

**Non-goals**

- No public export, public lifecycle method, scheduler, batching, retry policy, or automatic decision/approval policy.
- No store/journal refactor, event/state encoding change, or dispatch semantic change.
- No relaunch of UNKNOWN work, weakened cancellation/deadline fences, or changed receipt/error text without a separate contract decision.

### Architecture seam

`KernelImpl.advance` continues to validate input, load verified state, apply reducer/admission, and commit the caller event. After a durable `CLAIMED` commit it passes an immutable authority snapshot and driver binding to `DispatchCoordinator`. The coordinator returns an immediate result only when the current private behavior does so; otherwise it settles asynchronously and calls the existing `onYield`. `KernelImpl` remains the sole owner of durable transitions and replay rows.

### Independently releasable milestones

**R3-A — Lifecycle ledger.** Before moving code, enumerate current traces and invariants: claim-before-launch, linearized store fence, cancellation before/after claim, deadline, sync receipt, real Promise, throw/malformed result, late receipt, observe timeout, stale lease, old continuation, and cleanup ownership. Capture exact yield/state bytes for each.

**R3-B — Coordinator extraction behind the existing facade.** Move active-task map/options and launch/observe helpers with behavior-preserving private calls. Keep a temporary internal delegation seam so reverting the extraction does not alter durable state or public exports. Do not alter function ordering or error mapping unless required to preserve ownership.

**R3-C — Race and cleanup hardening.** Make task lifetime, cancellation watcher removal, notification delivery, and successor-lease fencing explicit in coordinator-owned code. Verify that an old continuation cannot replace or erase a newer lease and that late matching receipts still reconcile by token+digest.

**R3-D — Differential release gate.** Run pre/post traces and the full package matrix. Remove only dead private forwarding code after parity evidence is frozen; no opportunistic kernel cleanup belongs in this release.

### Dependencies

Start after R1's controller/result contract is frozen; the extraction must serve a real lifecycle boundary. It can proceed independently of R2's storage format. R4's evidence adapter should target the coordinator-owned effect records after R3, but R4 can read existing records during development without changing dispatch behavior.

### Compatibility and migration

- Package exports, `composeKernel`, `RunKernel.advance`, event/state encodings, and durable files are byte-compatible.
- No on-disk migration is required; active in-process dispatch state is intentionally ephemeral and is reconstructed conservatively after restart.
- Hosts without a conforming driver still receive `HumanReceiptRequired`; no fallback is introduced.
- A prior package can read all state written by the coordinator release because the durable schema is unchanged.

### Recovery and rollback

- A failed coordinator call after claim records the same lease-scoped `UNKNOWN`; no retry is added.
- A process restart discards only ephemeral coordinator state; existing kernel restart/observe rules apply.
- Rollback is a package redeploy or internal delegation revert. Before rollback, stop new invocations and allow/observe in-flight tokens under the old proof rules; never edit outbox/effect records to make tests green.

### Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Claim-before-launch order changes | Differential trace asserts claim commit precedes driver entry under every race. |
| Sync receipt mistaken for Promise (or vice versa) | Preserve intrinsic Promise classifier and sync/async fixture coverage. |
| Timeout/cancellation window widens | Fault-inject abort/deadline around store fence and immediately before driver call; require same UNKNOWN/ no-launch result. |
| Late/stale receipt acknowledges successor | Bind every settlement to token, command digest, lease, generation, and current writer fence. |
| Cleanup removes a successor task | Identity-check task map on deletion; exercise old continuation/successor lease tests. |

### Verification, fault injection, and benchmark requirements

- Differentially run [`test/kernel-repair.test.js`](../test/kernel-repair.test.js), [`test/orchestration.test.js`](../test/orchestration.test.js), [`test/codex-exec-driver.test.js`](../test/codex-exec-driver.test.js), [`test/codex-exec-supervisor.test.js`](../test/codex-exec-supervisor.test.js), and [`test/massive-win-identity-variants-cycle-launch-fence.test.js`](../test/massive-win-identity-variants-cycle-launch-fence.test.js) before and after extraction.
- Include synchronous/asynchronous receipts, timeout/cancel, restart UNKNOWN/observe, stale lease, launch failure, late receipt, duplicate RESUME, competing pumps, malicious thenables/proxies/accessors, and writer reentrancy.
- Require exact transition/journal/yield/store parity and a full `npm test` pass; code motion alone is not acceptance.
- Capture a same-fixture before/after dispatch trace with wall time, task counts, and callback counts only for regression diagnosis. Do not report an improvement or token/provider effect without a separately authorized benchmark and evidence.

### Exit criteria

R3 is releasable when the coordinator owns all listed in-flight lifecycle state, the facade owns all durable validation/commit decisions, every differential trace is byte/identity-equivalent, the full package matrix passes, no public/private export boundary changed, and rollback to the prior package is demonstrated on an unchanged durable fixture.

---

## 4. Token-scoped, read-only recovery/effect forensics capsule

### Current evidence

- Restart converts an unproven `CLAIMED` lease to `UNKNOWN` and never blindly relaunches; the pump gives `observe()` one bounded exact-token opportunity before returning to the parent ([`src/public.ts`](../src/public.ts), lines 616–662; [`src/orchestration.ts`](../src/orchestration.ts), lines 191–203, 438–459).
- Immutable launch/terminal records already bind launch token and command digest and carry policy/authority/executable, result, report, and process evidence ([`src/codex-effect-records.ts`](../src/codex-effect-records.ts), lines 10–20, 23–68, 81–113; schemas under [`schemas/`](../schemas)).
- Workfront intentionally omits receipts, paths, and journal details, and existing bridge CLI routes are event, drive, and workfront ([`docs/WORKFRONT.md`](WORKFRONT.md), lines 18–22; [`src/bridge-cli.ts`](../src/bridge-cli.ts), lines 19–28, 145–150).

Safe failure is visible, but an operator must currently reconstruct the incident from separate artifacts.

### Intended outcome

An explicit, bounded inspection for one run and launch token returns canonical `lunacy-recovery/v1` evidence: the verified generation and remaining journal budget, outbox state/lease, token-scoped effect-record presence and digest binding, UNKNOWN cause, and lock/fence status. It may state which proof is required next (for example, `observe` or a human receipt) but never performs that action.

### Scope and non-goals

**In scope**

- A private `inspect-recovery` route requiring explicit run root, run ID, and token (with optional exact command digest to disambiguate).
- A canonical, bounded, non-sensitive capsule assembled from verified `ArtifactStore`, outbox, Workfront/state, and Codex effect-record readers.
- Stable status/error classes for absent, malformed, mismatched, stale, or unverifiable evidence.
- Redaction rules that expose proof metadata and digests without payloads, arbitrary paths, report contents, or credentials.

**Non-goals**

- No dispatch, observe call, ACK, repair, quarantine, cleanup, projection write, lock acquisition, cache write, or journal mutation.
- No Markdown/Beads authority parsing, scheduler, automatic recovery policy, or decision inbox.
- No assumption that presence of a launch/terminal file proves a valid effect; every item is verified against token, command digest, authority/policy binding, and current generation.

### Architecture seam

Load the private route only after argument selection. Reuse the store's read-only committed-state validator and existing bounded trusted-file/effect-record readers. Read one verified CURRENT generation, locate the exact outbox token in the current/recovery view, then inspect token-hashed effect paths and validate canonical launch/terminal records. Rebind filesystem identities and perform one bounded namespace check before returning. Do not call `RunKernel.advance`, `BridgeDrivePump`, driver `observe`, or any mutating cleanup path.

The capsule is a diagnostic projection, not a new authority database. Its schema should include explicit `verified: true/false` per evidence class and a `nextProof` value that is descriptive only.

### Independently releasable milestones

**R4-A — Capsule schema and redaction contract.** Define exact top-level keys, schema version, bounded arrays/strings, digest formats, status/cause vocabulary, `nextProof` semantics, and path/payload redaction. Include golden capsules for ACKED, UNKNOWN with launch evidence, UNKNOWN without evidence, malformed evidence, and absent token.

**R4-B — Pure read path.** Implement a private inspection function over a verified generation and explicit token. Ensure success and error paths perform zero writes, lock changes, quarantine, generation cleanup, or cache creation. Enforce size/UTF-8/canonical checks before allocation using existing limits.

**R4-C — Effect binding and generation fence.** Verify launch-intent/launch/terminal records by exact token hash, command digest, run/phase/step/epoch binding, policy/authority digest, and report/result digests. Rebind CURRENT/root/effect namespace identities before return; a drift or wrong token yields a stable closed result.

**R4-D — CLI route and operator semantics.** Add the private route to the managed bridge launcher with explicit arguments and bounded output. Keep suggestions visibly separate from actions. Confirm workfront remains unchanged and callers can continue using one-event/drive routes.

**R4-E — R4 release gate.** Freeze schema/golden digests and publish only after mutation-hash and fault-injection evidence below is archived.

### Dependencies

Specify the schema in parallel with R1, implement after R3 so dispatch/effect ownership is stable, and reuse R2's segmented reader when available without coupling the route to compaction. No R4 implementation may add recovery mutation to either the controller or coordinator.

### Compatibility and migration

- The route is private/opt-in and adds no package-root export or `RunKernel.advance` event.
- Existing effect records and runs need no migration; absent records are reported as evidence absence, not synthesized records.
- Capsule versioning is additive. A future field requires a schema version and bounded reader behavior; unknown versions fail closed rather than being guessed.
- Removing or disabling the route leaves `.kernel`, effect namespaces, projections, and Workfront behavior untouched.

### Recovery and rollback

- Inspection itself has no recovery side effect. Repeated calls against an unchanged run must return byte-identical canonical capsules.
- If CURRENT/effect evidence changes during inspection, return a stable integrity/manifest failure; do not quarantine or retry a dispatch.
- Rollback is route disablement or package redeploy. Any actual recovery remains the existing explicit `observe`, receipt, or parent decision path.

### Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Sensitive paths/payloads leak | Redact paths/content; expose bounded identifiers/digests and stable classes only. |
| Wrong token/lease/generation is inspected | Require explicit token, exact command digest when supplied, and current epoch/lease/fence binding. |
| Unverified evidence appears authoritative | Per-record verification status, explicit absence/mismatch causes, and no PASS inference from file presence. |
| Read path mutates during cleanup/reconciliation | Load only read-only modules after argument parsing; hash namespace before/after and prohibit write-capable calls. |
| Suggestions are mistaken for completed recovery | Name `nextProof` as informational and keep action routes separate. |

### Verification, fault injection, and benchmark requirements

- Inject spawn-after-intent, launch-publication failure, malformed/invalid-UTF8 terminal evidence, timeout/UNKNOWN, stale lease, late receipt, wrong token/digest, authority/policy drift, CURRENT replacement, and effect-directory mutation during read.
- Hash the complete state/effect namespace before and after repeated inspection; require identical hashes and zero dispatch, observe, lock, quarantine, projection, or cache mutations.
- Compare every capsule field with immutable launch/terminal records and the verified current generation; wrong-token and unverifiable inputs must fail closed with bounded stable output.
- Test output-size ceilings and deterministic canonical bytes across Memory/File stores and legacy/segmented readers.
- Capture read counts, bytes, and wall-clock distributions on a fixed corpus only to prove bounded behavior and detect regressions. No provider/token/value saving or speed claim is authorized.

### Exit criteria

R4 is releasable when the `lunacy-recovery/v1` schema and golden capsules are frozen, all evidence-binding and redaction cases pass, repeated inspection is byte-identical and mutation-free, existing routes/tests remain unchanged, and every suggested next proof is clearly non-mutating and parent-authorized.

---

## Deferred work and decision triggers

Do not fold the following into these four releases. Reconsider them only after the stated prerequisite is demonstrated:

- **Multi-run scheduler/queue:** after R1 proves one-run status/attention semantics and concurrent-root demand is explicit.
- **Digest-bound decision inbox or automatic approval:** after R1/R4 expose explicit stops/evidence and a separate authority decision authorizes policy.
- **Resumable release-operation envelope:** after in-run recovery and receipt conventions are stable.
- **Bridge projection de-duplication/no-op writes:** after a realistic paired corpus (at least 30 repetitions) demonstrates a representative issue; current observations are not a claim.
- **Cost-aware accelerator admission / ON canary:** after a frozen hit-bearing corpus proves eligible immutable hits and policy safety.
- **Pure admission planner and reuse-store extraction:** before changing admission policy or cache lifecycle, not as a prerequisite for these releases.

A deferred item becomes a new roadmap/run decision with its own owner, scope, compatibility, recovery, and proof gate; it does not alter the accepted four-direction order here.
