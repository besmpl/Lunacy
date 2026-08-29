# Lunacy Runtime: next-big-wins implementation roadmap

**Status:** planning-only roadmap (post-R1–R4)

**Authority:** the accepted ranking in [`S5-worker-01.md`](../Lunacy/runs/next-big-wins-v2/phases/p2/reports/S5-worker-01.md) and the PASS hard gate in [`hard-gate-01.md`](../Lunacy/runs/next-big-wins-v2/phases/p2/hard-gate-01.md). This document describes implementation and release work; it does not authorize source, test, schema, runtime, release, install, or public-API changes.

**Order is fixed:**

1. Explicit multi-run fleet coordinator with cross-run admission.
2. Digest-bound decision inbox, then exact parent-authorized phase promotion.
3. Incremental bounded-prefix segmented history.
4. Resumable outer release-operation envelope.

R1–R4 are shipped baseline dependencies, not proposals. The plan keeps kernels and existing release transactions as the only authorities. A coordinator, inbox, history format, or outer envelope may carry a bounded projection or lease, but none may invent a transition, approval, phase, effect, or release result.

## Reading and claim boundaries

- The native kernel remains the authority for event identity, reducer outcomes, journal/state commits, outbox claims, epochs, and exact replay. The existing managed pump is an ephemeral one-run loop; it is not a scheduler.
- Parent intent, adoption, approval, gate, redirect, cancellation, and final-result decisions remain explicit. Markdown, Beads, ambient filesystem discovery, and queue contents are never executable authority.
- `UNKNOWN` or otherwise uncertain external effects remain fail-closed and are never blindly relaunched.
- Facts below are labelled **Fact** and point to current code, tests, or documentation. Expected benefits are labelled **Inference**; they are hypotheses to prove, not guarantees. No section makes a provider, token, native, throughput, latency, or speedup claim.

## Overall sequencing and release strategy

### Baseline and release gates

**N0 — baseline capture (no product change).** For every implementation run, freeze the current checkout revision, direct `RunKernel.advance` traces, bridge/pump traces, release-transaction traces, and the exact fixture/test command. Keep the one-event/manual bridge route and package-root exports as comparison or fallback surfaces. Measurements are evidence only; do not turn a local sample into a target.

**N1 — fleet coordinator.** Ship only an additive, explicit coordinator command/manifest. A selected entry is leased with CAS, revalidated against the kernel, advanced through `resumeRun`, and released/marked for attention. Existing one-run commands and per-run admission remain unchanged. Disablement is invocation-level or package rollback; no run state is rewritten.

**N2 — inbox and promotion.** Ship the read-only inbox first. Only after token/digest/epoch handling is proven may a separate parent-authorized handoff promote one exact predecessor to one exact successor. Inbox submission and promotion are independently gated; neither creates automatic approval or a general DAG.

**N3 — segmented history.** Treat the current segmented reader/writer as the semantic baseline. Land a compatibility reader and crash protocol before an opt-in `segmented/v2` writer. N3 is not releasable on a forecast: Direction 3 remains **value-unclaimed** until the representative paired corpus and recovery/fault parity below demonstrate bounded-prefix value.

**N4 — outer release envelope.** Add a resumable identity/phase wrapper around the existing release admission, quiescence, target lock, and deployment transaction. The wrapper remains subordinate and opt-in; it must not replace or reinterpret inner transaction recovery.

Each release is independently releasable after its own gate. Later work may consume an earlier release's immutable manifest/receipt shape, but cannot retroactively widen that release's authority. A red gate disables the new route and leaves the prior complete generation/transaction authoritative.

### Invariants and forbidden expansions

- **Kernel/transaction authority:** all durable run decisions still pass through `RunKernel.advance`; all managed-tree publication and rollback still pass through the existing release transaction.
- **No ambient discovery:** every run, root, plan, policy, claim set, predecessor, successor, and target is named by a caller-supplied, digest-bound manifest. Discovery-parent scans already required by a release manifest remain an existing admission check, not a new fleet registry.
- **No automatic approval:** a queue item, inbox record, `nextProof`, lease, or status capsule can suggest the next explicit action but cannot submit parent decisions, receipts, gates, or phase promotion by itself.
- **No general DAG:** promotion is one exact predecessor-to-successor handoff with a parent decision and digest fence; arbitrary graph scheduling is out of scope.
- **No second authority:** coordination metadata, checkpoint heads, inbox rows, and outer markers are projections/fences. They must be ignored when the kernel/transaction authority is missing, stale, malformed, or conflicting.
- **Measurement discipline:** record operations, bytes, fsyncs, wall-clock distributions, leases, retries, and fault outcomes where required. Report observations and parity; do not claim savings or speed without the specified corpus and an authorized decision.

---

## 1. Explicit multi-run fleet coordinator with cross-run admission

### Current evidence

- **Fact — no fleet owner exists.** The workspace contract says there is no global run registry, lock database, scheduler, or `CURRENT_RUN`; callers select run directories explicitly ([`WORKSPACE.md`](../WORKSPACE.md), lines 5–31).
- **Fact — the managed pump owns one root only.** `BridgeDrivePump` is documented as an ephemeral mechanical loop whose command, token, epoch, and successor come from one run's verified `CURRENT`; lifecycle options and `runRun`/`resumeRun` each accept one `runDir`/`runId` and delegate to that pump ([`src/orchestration.ts`](../src/orchestration.ts), lines 105–109, 529–545, 745–774).
- **Fact — admission is per-run.** `proveAdmission` receives one `runId` and that run's canonical claims; `claimsConflict` compares two claim arrays but there is no cross-run owner ([`src/admission.ts`](../src/admission.ts), lines 4–12).
- **Fact — existing concurrency proof is single-root.** The competing-pumps test starts two pumps for the same root and proves one launch/token and parent-boundary convergence; it does not arbitrate multiple roots ([`test/orchestration.test.js`](../test/orchestration.test.js), lines 151–170).

### Intended outcome

**Inference:** an explicit coordinator should fairly advance caller-authorized roots and prevent overlapping claim admission without per-root polling. The first release proves lease/CAS correctness, fairness under restarts, and no duplicate launch; it makes no throughput or utilization claim.

### Scope and non-goals

**In scope**

- A private, versioned coordinator manifest whose entries explicitly name `runRoot`, `runId`, canonical plan/policy digests, claims digest, and a bounded round-robin cursor/epoch. The manifest is supplied by the parent/operator; the coordinator does not discover roots.
- A single-process durable lease record per entry (owner nonce, lease epoch, expiry, manifest digest, and observed kernel cursor). Lease acquisition is CAS-protected and advisory: it cannot commit run state or authorize work.
- Cross-run claim revalidation immediately before advancing a leased entry. The coordinator reads verified kernel state for every candidate, rejects stale root/plan/policy/claim bindings, and asks the kernel's existing admission path to decide the run transition.
- One mechanical turn: lease one entry, call `resumeRun` with the exact parent-supplied plan/policy/driver, record the returned attention/terminal view, and release or renew the lease. `UNKNOWN`, parent boundaries, and conflicts are returned, not retried by a local queue.
- Bounded status/attention and crash-recovery records sufficient for an operator to retry the explicit command.

**Non-goals**

- No ambient run discovery, global registry, automatic enrollment, background daemon, unbounded queue, or general scheduler/DAG.
- No replacement of `RunKernel.advance`, `BridgeDrivePump`, per-run `proveAdmission`, writer fences, or release locks; the coordinator cannot mutate a run without a kernel call.
- No automatic approval, receipt synthesis, UNKNOWN relaunch, claim override, starvation guarantee beyond the measured round-robin contract, or provider/token/throughput claim.
- No new public package export or change to one-event/manual bridge behavior.

### Architecture seam

The seam is a private coordinator around existing lifecycle and admission APIs:

1. Validate the explicit manifest, canonicalize each plan/policy/claim declaration, and bind every entry to a trusted root identity before acquiring a lease.
2. Acquire one entry lease using a deterministic lock order and CAS on coordinator generation. A stale or conflicting lease is an attention result, not permission to steal a run's kernel state.
3. Re-read the selected root's verified `CURRENT`, outbox, epochs, and claim projection. Compare the manifest digests and revalidate cross-run conflicts against the other explicitly listed entries. The coordinator may decline a candidate; the kernel remains the final per-run admission authority.
4. Invoke `resumeRun` for exactly that entry. All transition identity, claim, effect, parent-boundary, and `UNKNOWN` behavior comes from the existing kernel/pump path.
5. Persist only coordinator observation (lease owner/epoch, cursor, outcome digest, and attention reason), then release the lease. Releasing coordinator metadata never changes run state.

The coordinator may keep a bounded advisory queue, but queue order is not authority and queue contents are never treated as proof of a runnable step.

### Independently releasable milestones

**F1-A — explicit manifest and identity contract.** Specify canonical entry/claims/policy digests, coordinator generation, cursor ordering, lease owner/expiry, status/attention vocabulary, size limits, and redaction. Add fixtures for one root, two non-conflicting roots, conflicting claims, stale root, and malformed entry.

**F1-B — CAS lease and round-robin turn.** Implement one-process durable lease acquisition/release with a deterministic byte order and crash-safe old-or-new record. Repeated invocation with the same manifest/cursor is idempotent; a lost lease stops before `resumeRun`.

**F1-C — cross-run revalidation and lifecycle delegation.** Rebind root identities, load verified kernel state for every candidate, reject stale plan/policy/claim digests, and delegate one selected turn to `resumeRun`. Record attention without converting it to a kernel event.

**F1-D — restart/fairness hardening.** Exercise competing coordinators, process crash at each lease/turn/release boundary, stale roots, claim overlap, writer-fence conflicts, and `UNKNOWN`/parent stops. Prove no stale worker can release or overwrite a successor lease.

**F1-E — fleet release gate.** Freeze the manifest schema and golden status bytes only after the decisive proof below is archived. Existing per-run and manual routes remain in the same matrix.

### Dependencies

Reuse the shipped lifecycle contract (`runRun`/`resumeRun` and `BridgeDrivePump`), per-run admission (`canonicalClaims`, `claimsConflict`, `proveAdmission`), writer/bridge locks, epochs, and effect/receipt rules. The coordinator can consume the existing release-forensics status when available, but it must not depend on a new inbox or segmented history. Direction 2 may rely on the fleet manifest's explicit identity; Direction 1 does not wait for Direction 2.

### Compatibility and migration

- Existing run roots, `.kernel` generations, plans, outboxes, effect records, one-event calls, and manual bridge routes are unchanged and require no migration.
- Enrollment is opt-in by an explicit manifest. There is no scan that turns existing roots into entries; absent, malformed, or mismatched entries fail closed.
- Coordinator records are versioned and disposable. A prior package ignores them and continues using per-run locks/`CURRENT`; a newer package can disable the coordinator without rewriting those records.
- A manifest revision or claims/policy digest change starts a new explicit coordinator generation. It never silently edits a leased entry.

### Recovery and rollback

- A crash before lease publication leaves the prior coordinator generation authoritative; a crash after publication leaves one recoverable lease record with an owner/epoch and bounded expiry.
- On restart, a coordinator may reclaim only a definitively stale coordinator lease after identity/CAS checks. It must revalidate the run's current kernel generation before any call and stop if the lease was lost.
- A crash after `resumeRun` has the existing kernel semantics: committed events replay exactly; claimed uncertain effects stay `UNKNOWN` and receive at most the existing bounded observation path. The coordinator does not relaunch.
- Rollback is to stop invoking the coordinator or redeploy the prior package. Leave kernel generations, outboxes, effects, and manual routes untouched; quarantine only coordinator-owned debris proven by its exact marker.

### Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Coordinator becomes a second authority | Store only manifest/lease/observation; require a fresh verified kernel read and delegate every transition to `resumeRun`. |
| Duplicate launch from competing coordinators | CAS lease, one deterministic lock order, root identity rebind, and exact kernel token/epoch proof before delegation. |
| Stale root or changed plan/policy/claims | Digest-bound entries, trusted-path identity checks, current-generation revalidation, and fail-closed attention. |
| Starvation or unfair cursor after crash | Persist cursor/lease epoch atomically, use deterministic round-robin order, and measure restart traces; do not promise fairness beyond the tested contract. |
| Lease loss during a turn | Check owner/epoch before delegation and before recording; a lost lease returns attention and cannot release a successor lease. |
| Cross-run claim overlap or `UNKNOWN` | Recompute conflicts from explicit entries, defer the candidate, and preserve kernel `UNKNOWN`/parent-boundary behavior. |

### Verification, fault injection, and measurement requirements

- Run two or more coordinators over two or more explicit roots with conflicting and disjoint claims. Require restart-stable round-robin order, exactly one coordinator turn/launch token, no claim overlap, and no duplicate durable event.
- Fault-inject before/after manifest CAS, lease acquire, root rebind, kernel read, `resumeRun`, result record, and lease release. Restart must converge to one valid lease outcome or a bounded attention result; no stale lease may mutate a run.
- Include stale/missing roots, plan/policy/claims drift, writer/bridge lock conflict, closed gate/barrier, cancellation, `UNKNOWN`, delayed receipt, duplicate invocation, and process termination at every boundary. Existing one-root tests and parent/UNKNOWN semantics must remain byte/identity-equivalent.
- Record turn order, lease epochs, conflict decisions, kernel generations, launch tokens, retries, and fault outcomes for a frozen fixture. These are diagnostic measurements only; no throughput, latency, provider, or token value claim is authorized.

### Exit criteria

F1 is releasable when the explicit manifest/lease schema is frozen, competing coordinators produce one launch/token with no cross-run claim overlap, restart and stale-root traces converge without mutation outside the selected kernel call, fairness is demonstrated for the bounded tested contract, parent/`UNKNOWN` paths are unchanged, and coordinator disablement leaves all prior run artifacts usable.

---

## 2. Digest-bound decision inbox, then exact parent-authorized phase promotion

### Current evidence

- **Fact — kernel tokens are one-shot and bound to state.** Yields expose a `DECISION_REQUIRED` token and cursor; private `DecisionToken` records carry `consumed`, identity, and optional expected/observed/target digests ([`src/model.ts`](../src/model.ts), lines 84–88, 107–120).
- **Fact — reducer consumption is conservative.** Gate decisions reject unsupported values without consuming the token, then journal one accepted `PARENT_DECISION`; authority adoption checks phase and target/observed digest fences before changing epochs ([`src/reducer.ts`](../src/reducer.ts), lines 256–318).
- **Fact — Workfront exposes codes, not receipts.** The read-only capsule returns bounded attention codes and run/plan summary while omitting receipts and journal details; its public input/output shape is explicit and selected-run only ([`src/workfront.ts`](../src/workfront.ts), lines 10–22, 58–71).
- **Fact — phase adoption is fenced.** Plans carry one `phaseId`; orchestration stops at parent boundaries, and cross-phase adoption is rejected before mutation (`phase fence mismatch`) ([`src/model.ts`](../src/model.ts), lines 26–32; [`src/orchestration.ts`](../src/orchestration.ts), lines 193–205; [`src/reducer.ts`](../src/reducer.ts), lines 287–289).
- **Fact — adversarial tests cover the boundary.** Invalid decisions do not consume a gate token, while cross-phase adoption remains a `Conflict` before and after old-work reconciliation ([`test/s5-adversary.test.js`](../test/s5-adversary.test.js), lines 67–80; [`test/p3-cross-phase-authority.test.js`](../test/p3-cross-phase-authority.test.js), lines 88–104).

### Intended outcome

**Inference:** an auditable cross-run inbox can make explicit stops actionable without polling or hidden approval. After inbox proof is accepted, one exact predecessor-to-successor handoff can remove manual choreography while retaining parent authority. The inbox and promotion are dependent but separately releasable; neither becomes a scheduler or auto-approval service.

### Scope and non-goals

**In scope**

- A read-only, digest-bound inbox manifest for one selected run/entry containing the exact token, brief/evidence digest, `nextProof` metadata (if available), cursor/revision, authority/attempt/barrier epochs, plan/policy digests, and bounded redacted attention. The inbox stores a projection, not a new decision token.
- One idempotent submit operation that rebinds the inbox token, evidence digest, epochs, and current kernel generation, then calls the existing `PARENT_DECISION` path. Bad bindings fail without consuming the kernel token; successful replay returns the existing canonical event/yield.
- Only after the inbox proof is complete: an explicit parent-owned handoff envelope naming predecessor run/phase, predecessor FINAL/gate evidence, successor run/phase, successor plan digest, and a single parent decision/authorization digest. `initRun` may be called only after exact checks pass.
- A bounded promotion status showing predecessor proof, successor initialization, and any parent attention; no promotion result is inferred from a queue or file presence.

**Non-goals**

- No automatic approval, receipt fabrication, token minting, token reuse, or mutation of a decision token outside `RunKernel.advance`.
- No ambient discovery of predecessor/successor roots, no Markdown/Beads authority parsing, no global decision database, and no general DAG or fan-out scheduler.
- No promotion before predecessor FINAL/gate proof, before explicit parent authorization, or when epochs/digests/phase differ. No bypass of the existing cross-phase fence.
- No public event/API change unless a future authority explicitly approves one; this roadmap only defines private/additive seams.

### Architecture seam

The inbox is a read-only projection over verified kernel state and (where present) the release-forensics `nextProof`; it does not own tokens. A submitter must provide the exact selected run root and token, then:

1. Re-read `CURRENT`, state, token record, cursor/epochs, plan/policy digest, and brief/evidence digest under the existing store fence.
2. Compare the inbox envelope and current state byte-for-byte at the digest/epoch boundaries. If any binding is stale, mismatched, malformed, or already consumed, return a closed attention/error without mutation.
3. Submit one canonical `PARENT_DECISION` through `RunKernel.advance`; kernel reducer/commit/replay rules decide whether it is accepted. Concurrent identical submits converge to one committed event.
4. For promotion, verify the predecessor's committed FINAL/gate result and exact phase/plan digest, verify the parent handoff authorization and successor plan digest, then invoke `initRun` for that explicitly named successor. The successor's first transition remains kernel-owned; a failed or retried init replays its event identity.

The handoff envelope may be stored for audit, but it is not an alternate phase graph. A predecessor that is merely `WAITING`, `DECISION_REQUIRED`, `BLOCKED`, `UNKNOWN`, or pre-PASS cannot authorize promotion.

### Independently releasable milestones

**I2-A — inbox schema and redaction.** Define canonical envelope fields, digest/epoch binding, `nextProof` vocabulary, bounded arrays/strings, status/error classes, and redaction. Add golden capsules for gate decision, UNKNOWN/attention, absent token, stale epoch, wrong digest, and consumed token.

**I2-B — read-only listing.** Enumerate only caller-selected entries and emit deterministic inbox bytes. Prove no writes, locks, queue discovery, token consumption, or hidden approval occur on repeated reads.

**I2-C — parent decision submit.** Rebind token/evidence/cursor/epochs and call the kernel once. Invalid bindings do not consume; concurrent identical submits commit/replay one `PARENT_DECISION`. Preserve existing Workfront codes and one-event/manual routes.

**I2-D — exact promotion handoff.** Add a parent-authored, digest-bound predecessor/successor envelope. Require predecessor FINAL/gate proof, exact predecessor and successor plan/phase digests, explicit parent authorization, and no live old work before `initRun`. Keep cross-phase and stale-handoff conflicts unchanged.

**I2-E — promotion crash/retry gate.** Fault before handoff commit, after predecessor proof, before/after successor `START`, and after successor projection. Require old-or-new complete authority and exact replay on retry; no duplicate successor run or hidden approval.

### Dependencies

Direction 1's explicit manifest identity is the minimum cross-run selection seam. Reuse the kernel decision-token/reducer rules, Workfront's bounded attention, lifecycle `initRun`, current writer/epoch fences, and the existing release-forensics `nextProof` when available. Promotion is not attempted until inbox submit and token/digest/epoch proof pass; no general DAG is a dependency or deliverable.

### Compatibility and migration

- Existing `DECISION_REQUIRED`, `PARENT_DECISION`, Workfront, one-event, and lifecycle outputs remain byte-compatible. The inbox is private/opt-in and does not reinterpret existing code-only attention.
- Existing decision-token records need no migration. A missing or old inbox projection is an absent view, not permission to recreate or consume a token.
- Handoff envelopes are versioned and exact-name/digest bound. Legacy runs can continue manually; no automatic predecessor discovery or phase conversion occurs.
- Disabling the inbox or promotion leaves kernel generations, decision tokens, plans, reports, and phase files untouched.

### Recovery and rollback

- A read or submit crash before kernel commit leaves the token unconsumed; retry with the same envelope either commits once or returns the exact replay. A bad binding never consumes.
- A crash after a `PARENT_DECISION` commit but before inbox acknowledgment is reconciled from the verified kernel generation; no duplicate event is emitted.
- A promotion crash before successor `START` leaves the predecessor authoritative and the exact handoff retryable. After `START` commit, retry replays the successor identity; an incomplete successor or stale handoff fails closed rather than guessing.
- Rollback disables inbox/promotion and returns to explicit parent decisions/manual `initRun`. Never edit token maps, phase files, or reports to make a promotion appear complete.

### Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Inbox becomes a second decision authority | Projection-only rows; kernel token/reducer/commit is the sole consumer and authority. |
| Replay or stale submission consumes the wrong token | Exact token, evidence digest, cursor, epoch, plan/policy, generation, and event identity; CAS/idempotency; invalid bindings do not consume. |
| Evidence leakage | Bounded redaction of briefs, receipts, payloads, paths, and credentials; expose digests and stable classes only. |
| Gate/phase bypass | Require predecessor FINAL/gate/PASS proof, explicit parent handoff, exact phase/plan digests, and no live old work; preserve cross-phase fence. |
| Concurrent promotion races | One parent authorization digest and successor identity under existing writer/generation fences; loser observes committed replay or closed conflict. |

### Verification, fault injection, and measurement requirements

- Sort two explicitly listed runs by deterministic cursor and inspect repeated inbox reads for byte identity and zero mutation. Submit the same token concurrently; require one committed/replayed event and unchanged token on bad bindings ([`test/s5-adversary.test.js`](../test/s5-adversary.test.js), lines 67–80, is the regression boundary for non-consuming invalid decisions).
- Exercise wrong token, brief/evidence digest, command digest, plan/policy digest, run ID, phase, revision, authority/attempt/barrier epoch, consumed token, malformed envelope, and authority drift. All fail closed before mutation.
- Attempt promotion before predecessor FINAL/gate/PASS, with stale handoff/epoch, wrong successor digest, live old work, crash before/after predecessor proof, and crash-retry `initRun`. Require the existing cross-phase conflict behavior and exact old-or-new successor authority ([`test/p3-cross-phase-authority.test.js`](../test/p3-cross-phase-authority.test.js), lines 88–104).
- Record inbox entries, submit/replay counts, digest/epoch rejection classes, and promotion outcomes on a frozen fixture. These are audit measurements only; no approval, speed, provider, or token-saving claim is implied.

### Exit criteria

I2 is releasable when read-only inbox bytes and redaction are frozen, concurrent valid submit commits/replays exactly one kernel event, every invalid binding leaves the token/state untouched, promotion requires one exact parent handoff plus predecessor FINAL/gate/PASS and successor-plan proof, crash retries converge without duplicate runs, and existing Workfront/kernel/cross-phase paths remain unchanged.

---

## 3. Incremental bounded-prefix segmented history

### Current evidence

- **Fact — current reads verify the full segmented prefix.** The segmented `ArtifactStore` reader validates every descriptor, range, chained digest, checkpoint digest, state digest, and logical journal continuity before exposing state ([`src/store.ts`](../src/store.ts), lines 1535–1573).
- **Fact — current commits walk and rewrite every journal entry.** `commitSegmented` slices `state.journal` from offset zero, writes/fsyncs each segment, recomputes the checkpoint digest, then writes complete state/head and swaps `CURRENT` ([`src/store.ts`](../src/store.ts), lines 1919–1969).
- **Fact — existing long-history tests prove semantics, not bounded work.** The R2 tests drive 10,001 events, compare a semantic oracle, exercise migration/rollback, and inject publication faults; they do not establish a bounded-prefix operation/byte/fsync budget ([`test/r2-segmented.test.js`](../test/r2-segmented.test.js), lines 23–83, 205–276).
- **Fact — existing durability rules are conservative.** Legacy history has a finite ceiling and segmented publication is old-or-new with explicit retention; ordinary append does not silently prune history ([`docs/DURABILITY.md`](../docs/DURABILITY.md), lines 39–71).

### Intended outcome

**Inference:** an authenticated immutable prefix/checkpoint plus a bounded active suffix could limit repeated read/write work for long runs while retaining full logical replay and audit semantics. The benefit is deliberately **unclaimed** until representative paired measurement and recovery/fault parity demonstrate it; no speed, byte, fsync, or token saving is promised in advance.

### Scope and non-goals

**In scope**

- A private `segmented/v2` format with a sealed immutable prefix/checkpoint, authenticated contiguous segment descriptors, and a bounded mutable suffix/head. Prefix and suffix identities are tied to one complete generation and `CURRENT` CAS.
- Reader-first support that validates the sealed prefix/checkpoint once, streams/reconstructs the full logical journal for reducer replay/compatibility, and rejects unknown/mixed/malformed generations before state/effect use.
- An opt-in writer that appends only to the active suffix, seals it through an explicit crash-safe operation, and publishes changed state/head/CURRENT without rewriting unchanged sealed bytes. Ordinary append still cannot prune canonical history.
- Explicit migration, rollback, retention, and GC operations that preserve old generations until a verified successor and reachability proof exist. Memory and File stores expose the same logical history.

**Non-goals**

- No silent truncation, in-place rewrite, lazy history that changes replay semantics, or deletion during ordinary append.
- No change to reducer/event identities, outbox/effect records, writer/generation fences, public APIs, or legacy/`segmented/v1` behavior.
- No mixed-format generation accepted without an explicit marker and complete verification; no compaction or retention inferred from a checkpoint alone.
- No performance, latency, byte, fsync, provider, or token claim until the required paired corpus and fault proof authorize a value decision.

### Architecture seam

Keep authority at `ArtifactStore` and the existing `CURRENT` pointer. A v2 head should canonically name format/version, run/phase, writer fence, checkpoint revision/digest, sealed-prefix aggregate and ordered ranges, active suffix range/digest, logical journal end, and state digest. Readers validate the head, all referenced immutable segments, and suffix continuity, then provide the same logical journal to the reducer. Writers use the existing writer fence/generation CAS: stage new suffix/head/state, fsync bottom-up, atomically publish one complete generation, and leave the prior head usable on any fault. A checkpoint or memo is a storage optimization, never a second state authority.

### Independently releasable milestones

**H3-A — format and crash protocol.** Define canonical v2 head/checkpoint/segment schemas, digest chaining, revision/range rules, suffix bound, publication order, format marker, quarantine names, and every crash window (seal fsync/rename, head/state write, generation rename, `CURRENT` exchange, and GC).

**H3-B — reader compatibility and oracle.** Read legacy, `segmented/v1`, and v2 markers without changing writes. Reject unknown versions, gaps/overlaps, digest/range/identity mismatch, unsafe paths, mixed generations, and partial heads. Compare the reconstructed logical journal/state with a direct unsegmented oracle and Memory/File parity.

**H3-C — opt-in suffix writer.** Add explicit v2 append/seal publication under the writer fence. Reuse unchanged sealed segments by verified identity/linking; any missing or mismatched prefix fails closed. Keep a complete active suffix and state/head copy until the successor is verified.

**H3-D — migration, retention, and rollback.** Migrate one legacy/v1 run through a resumable exact-name transaction that retains the old pointer/generation. Make compaction/GC an explicit operator action with reachability proof; preserve old generations on interrupted seal, migration, or rollback.

**H3-E — value and release gate.** Freeze a representative paired corpus and fault matrix. Release v2 only if bounded-prefix work is demonstrated without semantic or recovery regressions; otherwise retain the reader-only capability and mark value unclaimed.

### Dependencies

Direction 3 is independent of inbox/promotion logic, but long-run demand must be measured before committing to a writer. Land the compatibility reader, oracle, and fault protocol before enabling v2 writes. Reuse existing CAS, writer fences, quarantine, migration, rollback, and R2 semantic tests; do not couple correctness to a coordinator queue or an inbox projection.

### Compatibility and migration

- Legacy and `segmented/v1` generations remain loadable and selectable by their existing markers. Absence of `segmented/v2` means no conversion; unknown markers fail closed.
- A v2 migration writes a complete new namespace beside the old one, verifies logical journal/state/digest equality, and atomically changes one pointer/format marker. It never edits legacy/v1 files in place.
- Before pointer swap, rollback removes only exact staged names and leaves the old generation authoritative. After swap, rollback restores the recorded prior pointer and retains v2 segments until explicit retention proves them unreachable.
- Memory and File stores must return identical logical state, journal order, replay results, yields, and effect bindings; segment placement and sealing are private.

### Recovery and rollback

- On restart, accept only one complete old or complete v2 head whose segment/checkpoint/range/state digests verify. A missing/partial head is corruption, not permission to replay or guess.
- A crash during seal/head/CURRENT publication quarantines only unreferenced exact staging/debris; the previous complete `CURRENT` remains usable. GC is never part of publication and is retried idempotently.
- A writer-fence/generation race aborts before publication. A failed prefix identity/reachability check retains the segment and surfaces a bounded recovery condition.
- To roll back the v2 release, stop v2 writes, complete/abort the explicit migration transaction, restore the prior format marker/pointer, and use the unchanged legacy/v1 reader. Do not prune canonical history to hide a failed migration.

### Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Prefix digest/range continuity diverges | Canonical contiguous ranges, chained segment/checkpoint digests, and comparison with the direct logical-prefix oracle. |
| Sealing/head/CURRENT crash exposes mixed history | Bottom-up fsync, atomic complete-generation publication, old-or-new restart proof, and fault injection at every window. |
| Stale writer or prefix identity reuses wrong bytes | Existing writer fence/generation CAS, root/segment identity rebind, and fail-closed mismatch before state use. |
| Lazy/partial history changes replay or leaks unverified data | Reconstruct and verify the full logical prefix before reducer/effect use; expose no unverified state. |
| Migration/rollback/GC deletes recoverable history | Exact-name transaction markers, old pointer retention, reachability proof, and idempotent quarantine/cleanup. |
| Memory/File semantics drift | Run identical synthetic corpora and compare journal/state/yields/effects byte-for-byte. |

### Verification, fault injection, and measurement requirements

- Drive more than 10,000 transitions against an unsegmented semantic oracle. Require identical logical event order, replay state, epochs, committed yields, and effect bindings for legacy, v1, and v2 readers/writers.
- Fault-inject seal write/fsync/rename, checkpoint/head/state write, generation publication, `CURRENT` fsync/rename, restart, migration, rollback, GC, stale CAS/fence, malformed segment, tamper, symlink/path drift, and partial suffix. Every restart exposes either the complete old or complete new authority; no mixed prefix is accepted.
- Exercise concurrent writers, long active suffix, migration retry, explicit compaction retry, unknown/malformed versions, and Memory/File parity. Preserve all existing R2 fault and semantic cases.
- Use a frozen representative paired corpus of **at least 30 short/long repetitions** spanning event counts and state sizes (including near legacy ceilings). Record prefix operations, bytes read/written, fsync counts, and wall-clock distributions with the same fixture and environment. These measurements authorize only a value/no-value decision; Direction 3 remains **value-unclaimed** until both paired evidence and recovery/fault parity pass.

### Exit criteria

H3 is releasable only when legacy/v1/v2 logical replay and digest parity are demonstrated, every seal/publication/GC/migration fault is old-or-new and retry-safe, no ordinary append prunes history, rollback is exact-name and resumable, and the archived paired corpus shows bounded-prefix value without an unsupported performance/token claim. If the corpus does not demonstrate value, ship no v2 writer and retain the reader/oracle as an explicitly unclaimed experiment.

---

## 4. Resumable outer release-operation envelope

### Current evidence

- **Fact — current exclusion is callback-scoped.** `withReleaseExclusion` validates a release manifest, acquires release/bridge/writer claims, invokes one callback, and releases claims in reverse order; its ownership is not a durable outer operation phase ([`src/release-operation.ts`](../src/release-operation.ts), lines 39–94).
- **Fact — deploy composes the outer steps in one invocation.** The managed deploy path reads a process snapshot, enters release exclusion, acquires the target lock, verifies quiescence, and calls `executeOperation` in one callback ([`tools/deploy-skill.mjs`](../tools/deploy-skill.mjs), lines 1493–1562).
- **Fact — inner transaction recovery is already durable.** The deployment marker records stage/backup/failed names and phases; `recoverTransaction` and `publishManagedTree` converge to exact old/candidate trees across crashes ([`tools/deploy-skill.mjs`](../tools/deploy-skill.mjs), lines 830–915, 1007–1084). The exact-legacy deployment test verifies restart convergence and no residue ([`test/r11d7-exact-legacy-deploy.test.js`](../test/r11d7-exact-legacy-deploy.test.js), lines 135–145).
- **Fact — the missing seam is outside the transaction.** The outer owner, manifest/target identity, process snapshot, quiescence, and operation phase are currently reconstructed by each invocation; no resumable outer identity envelope binds those steps as one durable operation.

### Intended outcome

**Inference:** a resumable outer envelope can resume a release after timeout, crash, or handoff from exact operation/manifest/target/owner/snapshot identities and produce an auditable phase result. This is a reliability and audit hypothesis, not a speed or deployment-throughput claim.

### Scope and non-goals

**In scope**

- A private `lunacy-release-operation/v2` envelope binding operation kind, release-manifest digest, installed-target identity, discovery-parent/run-root manifest digest, release-owner identity/epoch, process-snapshot digest, target-lock identity, outer phase, and bounded recovery status.
- Read-only status that reports a verified envelope and the next required explicit proof; it does not acquire locks, run quiescence, publish files, or clean residue.
- `resume` that revalidates current release admission, owner liveness, target identity, process snapshot, quiescence, and inner transaction marker before delegating to the existing deployment/restore/check operation. Each phase transition is CAS/marker-backed and idempotent.
- Explicit parent/operator approval and process snapshot capture remain prerequisites. Existing release receipts/evidence stay subordinate to the inner transaction and are referenced by digest.

**Non-goals**

- No replacement of `withReleaseExclusion`, target locks, quiescence checks, `publishManagedTree`, `recoverTransaction`, or release manifest validation.
- No ambient discovery beyond the exact discovery-parent/run-root set already named by the release manifest; no new release scheduler, queue, or auto-approval.
- No relaunch of an uncertain process/deploy effect, owner takeover without the existing liveness/reclaim proof, or mutation from a status/read path.
- No public CLI byte change or legacy transaction-marker reinterpretation without a separate compatibility decision.

### Architecture seam

Persist the envelope beside the existing release marker under an exact transaction name, before taking lower-order claims. Its phase machine is deliberately small: `prepared` (identities captured), `admitted` (release exclusion/owner claims verified), `quiesced` (target/process snapshot proof verified), `delegated` (inner operation invoked), `committed` (inner result and aggregate verified), and `failed`/`attention` (closed reason with retry guidance). The envelope stores digests and identities, not payloads.

A status call verifies the envelope and current manifest/target identities without mutation. A resume call reacquires the existing claims in their established order, revalidates owner/snapshot/quiescence and exact inner marker, then delegates to the existing transaction. The inner transaction remains the only authority for managed-tree bytes and rollback; the outer envelope cannot mark `committed` unless the inner aggregate/marker proves it.

### Independently releasable milestones

**O4-A — envelope schema and phase/crash matrix.** Define canonical keys, operation/manifest/target/owner/snapshot digests, phase transitions, owner-liveness rules, marker names, redaction, bounded status, and old-or-new outcomes for every crash window.

**O4-B — read-only status.** Implement exact-name envelope inspection with no lock acquisition, discovery, quiescence, cleanup, projection, or file mutation. Repeated reads are byte-identical and distinguish absent, stale, malformed, conflicting, and committed envelopes.

**O4-C — resumable admission and revalidation.** Add CAS phase updates around existing release exclusion, target lock, process snapshot, and quiescence checks. Reject stale/tampered owner/manifest/target/snapshot identities before delegating; preserve existing lock order and liveness/reclaim protocol.

**O4-D — inner transaction delegation and rollback.** Resume/delegate one exact operation and adopt the existing marker recovery only when its owner/manifest/target binding matches. Verify candidate/previous aggregate before outer commit; preserve unowned files and exact residue cleanup.

**O4-E — release gate and compatibility proof.** Fault every outer phase, compare CLI/legacy bytes and transaction aggregates with the prior package, and demonstrate disablement/rollback without touching an unowned file or leaving a marker residue.

### Dependencies

This is fourth. Reuse the fleet's explicit run/manifest identity where release manifests already list run roots, the existing release admission/exclusion and quiescence protocols, target locks, transaction marker/recovery, rollback, and the token/evidence conventions established by R1–R4. Do not make the outer envelope a dependency of in-run recovery, inbox promotion, or segmented history; it remains subordinate to each.

### Compatibility and migration

- Existing release manifests, deploy/restore/check/exact-legacy CLI invocations, transaction markers, managed-tree bytes, and legacy output remain unchanged when the envelope is disabled.
- Enablement is opt-in by a versioned envelope marker. Existing v1 markers are handled only by their existing recovery path; a v2 envelope never guesses ownership from a similarly named file.
- A migration/upgrade writes the envelope beside the exact existing marker, binds the current owner/manifest/target/snapshot, and verifies the inner transaction before any phase promotion. No managed tree is rewritten merely to create the envelope.
- Disabling or rolling back removes only exact envelope material proven to be owned after the inner transaction is complete; otherwise it leaves the marker and requires the documented recovery path.

### Recovery and rollback

- A crash before `prepared` publication leaves no authoritative envelope. A crash after publication is resumed only when the exact owner/manifest/target/snapshot identities and marker are verified.
- A stale or live foreign owner is never adopted. Reclaim uses the existing definitive liveness and lock protocol; uncertainty returns attention.
- A crash between outer phase updates and inner transaction calls re-reads both authorities. If the inner marker is complete, resume records the matching outer phase; if it is partial or conflicting, fail closed and preserve exact old/candidate recovery options.
- Rollback is package/route disablement or restoration through the existing explicit transaction. Never edit aggregate files, unowned content, owner markers, or inner evidence to force a green outer status.

### Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Outer marker becomes a second release authority | Require existing release manifest, claims, quiescence, target lock, and inner marker proofs; outer `committed` is a derived status only. |
| Stale owner/process snapshot or target identity | Bind owner/manifest/target/snapshot digests and inode identities; revalidate immediately before each phase and fail closed on drift. |
| Replay or duplicate publication | CAS phase/operation identity, delegate to idempotent inner transaction, and compare exact previous/candidate aggregates before accepting a result. |
| Outer/inner phase disagreement | Read both markers under established lock order; permit only known old-or-new combinations and surface all other combinations as attention. |
| Cross-fence rollback or unowned-file loss | Reuse release exclusion, target lock, quiescence, preserved-file fence, and exact residue cleanup; test concurrent operator edits. |
| Evidence/path leakage | Store bounded digests/status classes; redact payloads, arbitrary paths, process arguments, and credentials from status. |

### Verification, fault injection, and measurement requirements

- Inject crashes/timeouts at envelope prepare/admit/quiesce/delegate/inner publish/inner commit/cleanup and at every existing transaction recovery point. On resume, require convergence to the exact prior or candidate aggregate, no duplicate publication, and no marker residue after success.
- Tamper operation, manifest, target inode, owner/liveness, process snapshot, quiescence, inner marker, or aggregate between phases. Resume/status must reject without mutation and preserve unowned files byte-for-byte.
- Exercise foreign/live owner, stale owner, target lock contention, discovery-parent/run-root drift, process snapshot mismatch, exact-legacy route, legacy v1 route, rollback, retry, and concurrent release attempts. Existing CLI output and transaction aggregate bytes remain unchanged.
- Record phase transitions, claim/release attempts, recovery retries, aggregate identities, residue count, and wall-clock distributions on a fixed fixture for diagnosis only. No deployment speed, provider, or token claim is authorized.

### Exit criteria

O4 is releasable when the envelope schema/phase matrix is frozen, status is deterministic and mutation-free, every resume path revalidates exact authorities and converges through the existing transaction, stale/tampered bindings fail closed, unowned files and legacy CLI/transaction bytes remain unchanged, all outer/inner crash windows are covered, and disablement/rollback is demonstrated without residue.

The four directions above are the complete accepted scope for this roadmap. Any scheduler/discovery/automatic approval, general DAG, projection optimization, accelerator, or other candidate is a new decision with its own authority, owner, compatibility, recovery, and proof gate; it must not be folded into these releases.
