# Lunacy Runtime: next major wins v3 roadmap

**Status:** planning-only implementation roadmap (post-P5 READY candidate)

**Authority:** the accepted ranking in [`S5-worker-01.md`](../Lunacy/runs/next-big-wins-v3/phases/p2/reports/S5-worker-01.md) and the PASS gate in [`hard-gate-01.md`](../Lunacy/runs/next-big-wins-v3/phases/p2/hard-gate-01.md). This document expands that judgment into implementation work; it does not authorize source, test, schema, release, install, public-API, or production-policy changes.

**Accepted order is fixed:**

1. Proof-gated durable continuation.
2. Transport-neutral, attested execution plane.
3. Portable authoritative run continuity.
4. Authenticated incremental run-state engine.

The four boundaries are separate. The delivered P5 fleet coordinator, decision inbox/phase handoff, segmented/v2 experiment, recovery forensics, and outer release envelope are baseline capabilities or dependencies, not proposals to repeat. A later direction may consume a frozen contract from an earlier one, but may not widen its authority.

## Reading and claim discipline

- **Fact** means observed in the current checkout or an accepted run artifact; each fact cites a local file and line range.
- **Hypothesis** means an intended boundary or expected benefit. It is not a product, performance, token, provider, security, or production claim.
- **Required proof** is the evidence that must be collected before the corresponding implementation or enablement gate can pass. Measurements are diagnostic until an explicit value decision is recorded.
- The kernel remains the authority for event identity, reducer outcomes, journal/state generations, outbox/effect claims, epochs, and committed yields. Parent intent, adoption, approval, gates, cancellation, and final-result decisions remain explicit parent boundaries.
- `UNKNOWN`, uncertain effects, stale ownership, malformed evidence, and capability/version drift fail closed. No route may infer authority from Markdown, a queue, an index, a lease, a projection, or a status capsule.

## Existing-system and reuse inventory

| Existing surface | Current fact and boundary | Reuse/ownership seam for this roadmap |
| --- | --- | --- |
| Kernel/reducer | **Fact:** `RunKernel.advance` and reducer paths own event identity, state transitions, decision-token consumption, phase/adoption fences, and replay. See [`docs/API.md`](API.md), [`src/reducer.ts`](../src/reducer.ts):247-318. | Every new route validates inputs then delegates one explicit kernel operation; no new component mints events, approvals, receipts, epochs, or yields. |
| Bridge/pump | **Fact:** `BridgeDrivePump` is an ephemeral mechanical loop with no scheduler state, stops at parent boundaries, and is recreated from verified `CURRENT` after restart ([`src/orchestration.ts`](../src/orchestration.ts):105-109,193-206). `runRun`, `resumeRun`, and `LifecycleController` construct a fresh pump ([`src/orchestration.ts`](../src/orchestration.ts):745-807). | Rank 1 wraps this loop with a durable, bounded wake/grant record; Rank 2 keeps the same claimed-command/receipt semantics; neither replaces the pump. |
| Effect/host boundary | **Fact:** the private `EffectDriver.dispatch/observe` seam accepts already-claimed work ([`src/driver.ts`](../src/driver.ts):19-22). `CodexExecDriver` is a local supervisor ([`src/codex-exec-driver.ts`](../src/codex-exec-driver.ts):15-56), and managed policy is tied to one local Codex version/model/sandbox and absolute paths ([`src/codex-host-policy.ts`](../src/codex-host-policy.ts):8-15,205-234). | Rank 2 defines a private wire adapter around this seam; the kernel remains claimant/acknowledger and remote hosts never write the run root. |
| Run/effect evidence | **Fact:** managed worker results currently expose `status`, `reportPath`, and `reportDigest`, while the kernel envelope is reduced to `{status}` ([`src/codex-host-policy.ts`](../src/codex-host-policy.ts):26-30,97-103; [`src/orchestration.ts`](../src/orchestration.ts):57-60,255-280). | Rank 1 freezes a parent-declared proof/check subset; Rank 2 carries bounded content-addressed evidence references. A typed artifact plane is not a standalone direction. |
| Artifact store/durability | **Fact:** `ArtifactStore` has load/commit and private reuse hooks but no export/import ([`src/store.ts`](../src/store.ts):94-107). `FileArtifactStore` binds absolute root and filesystem identity ([`src/store.ts`](../src/store.ts):873-914,1056-1068). `.kernel/CURRENT`, immutable generations, journal, and quarantine are normative ([`docs/DURABILITY.md`](DURABILITY.md):3-37). | Rank 3 adds a cold export/import transaction above these validators and fences. Rank 4 adds a discardable authenticated index above the same `CURRENT` authority. |
| Segmented experiment | **Fact:** the private segmented/v2 reader still reads descriptors, segments, journal, state, and checkpoint digest on each load; commits verify predecessor history and re-read sealed ranges ([`src/store.ts`](../src/store.ts):1588-1627,1991-2037). P5 leaves v2 writer value `UNCLAIMED` ([`docs/DURABILITY.md`](DURABILITY.md):68-81; [`Lunacy/runs/implement-next-big-wins-v2/phases/p5/hard-gate-01.md`](../Lunacy/runs/implement-next-big-wins-v2/phases/p5/hard-gate-01.md)). | Rank 4 targets residual full-history work. It must retain the full-replay oracle and legacy/v1/v2 fallback; no ceiling increase is implied. |
| Fleet/inbox/release baseline | **Fact:** fleet state stores cursor, leases, and observations and delegates one selected entry to `resumeRun` ([`src/fleet-coordinator.ts`](../src/fleet-coordinator.ts):74-82,319-320,375-383,447-456). Inbox submission still receives the caller's exact value ([`src/decision-inbox.ts`](../src/decision-inbox.ts):48-58,261-354). The outer release envelope is subordinate to the existing transaction ([`src/release-operation.ts`](../src/release-operation.ts):33-69). | Reuse their lease/epoch, token, redaction, and transaction-marker vocabulary; do not turn any into a scheduler, approval authority, or remote coordinator. |
| Release transaction | **Fact:** inner deployment marker/recovery already converges old-or-candidate trees ([`tools/deploy-skill.mjs`](../tools/deploy-skill.mjs):830-915,1007-1084); outer exclusion is callback-scoped ([`src/release-operation.ts`](../src/release-operation.ts):39-94). | Rank 3/4 do not edit release behavior. Any future release-operation changes remain the already delivered envelope's boundary. |
| Verification surfaces | **Fact:** current durability, bridge, host, and recovery contracts are documented in [`docs/DURABILITY.md`](DURABILITY.md), [`docs/BRIDGE.md`](BRIDGE.md), and [`docs/RECOVERY.md`](RECOVERY.md). The paired v2 corpus explicitly reports `valueDecision: UNCLAIMED` ([`Lunacy/runs/next-big-wins-v3/phases/p1/reports/S3-worker-01.md`](../Lunacy/runs/next-big-wins-v3/phases/p1/reports/S3-worker-01.md)). | Every release keeps these as comparison oracles, records exact fixtures/commands, and treats timings/bytes/fsyncs as observations only. |

## Portfolio sequencing and shared gates

### Baseline B0 — freeze comparison authorities (no product change)

Record the checkout identity, direct kernel/reducer/store traces, bridge/pump traces, effect launch/terminal evidence, and release-transaction traces used by each implementation run. Freeze canonical bytes and the existing one-event/manual route as fallback. Capture the exact fixture, command, environment, fault schedule, and result digest. B0 authorizes no target latency, throughput, token, provider, security, or production claim.

### Ordered releases

| Release | Direction and boundary | Prerequisite and enablement | Rollback/fallback |
| --- | --- | --- | --- |
| R1 | **Proof-gated durable continuation:** one parent-issued grant may submit one exact pre-authorized `PASS` only after a certified proof. | Freeze proof/check vocabulary, then session lease/restart behavior with no automatic decision; enable one event only after the proof matrix passes. | Disable the session route; use the existing manual inbox/pump. Never rewrite kernel, inbox, fleet, or manual state. |
| R2 | **Transport-neutral, attested execution plane:** one explicitly named isolated/remote executor exchanges authenticated command/receipt frames without run-root authority. | Reuse R1 proof/artifact references; prove loopback byte parity before a second adapter crosses the no-shared-filesystem boundary. | Stop remote dispatch and return to the local driver/manual observation path. Keep outbox/effect records and local routes unchanged. |
| R3 | **Portable authoritative run continuity:** operator-directed cold export/import of one quiesced run root. | Freeze manifest, sensitivity, retention, and source-retirement contract; consume R4's index only if it exists and is covered by the manifest. | Stop export/import and retain the source `CURRENT`; an unverified destination exposes no `CURRENT`. |
| R4 | **Authenticated incremental run-state engine:** discardable index/range proofs that can bound ordinary verification while preserving full replay. | Start with a compatibility reader and oracle; opt-in writer and any context/graph use require paired corpus and fault parity. | Disable index/writer and fall back to legacy/v1/v2 full verification. A value-red gate leaves the experiment unclaimed. |

### Shared invariants and proof vocabulary

1. **Authority:** `RunKernel.advance` and the existing release transaction remain the only mutators of their respective state/tree authorities.
2. **Identity:** bind run, phase, plan, policy, attempt, generation, writer fence, lease epoch, launch token, command digest, artifact digest, and operation identity where applicable. Canonical bytes are versioned and closed.
3. **Single-use effects:** a claimed effect is acknowledged only by a matching token/digest/epoch receipt. A timeout, partition, cancellation uncertainty, or malformed result is `UNKNOWN`; no blind relaunch.
4. **Durability:** publication is old-or-new under existing writer/lock/CAS fences. Sidecars, manifests, indexes, leases, and envelopes are projections/fences and are discardable or quarantineable.
5. **Boundedness:** wakes, evidence, frames, ranges, archive contents, retries, and status output have explicit size/deadline/count limits. Redact payloads, credentials, arbitrary paths, and process arguments.
6. **Compatibility:** legacy generations, one-event/manual calls, Memory/File logical behavior, existing CLI bytes, and release markers remain usable when a new route is absent or disabled.
7. **Proof posture:** a check can certify only a parent-declared allow-list. No worker, transport, index, queue, or projection can define acceptance or make an unapproved transition.

Each implementation stage must attach its facts, hypotheses, required proof, exact checks, red-gate behavior, and exit evidence to the run that authorizes it. The following sections are the complete accepted scope.

## 1. Proof-gated durable continuation

### Current bottleneck and evidence (facts)

- **Fact:** `BridgeDrivePump` owns no scheduler state, stops at the first parent boundary, and is recreated after restart ([`src/orchestration.ts`](../src/orchestration.ts):105-109,193-206). `runRun`, `resumeRun`, and every `LifecycleController` call create a fresh drive ([`src/orchestration.ts`](../src/orchestration.ts):745-807).
- **Fact:** the managed route wakes the parent for receipts, blocked/decision states, cancellation, phase/final boundaries, and hard gates; parent intent, approval, adoption, gate, and final-result decisions remain authoritative ([`SKILL.md`](../SKILL.md):35-52,146-154).
- **Fact:** the delivered fleet coordinator persists cursor, leases, and observations, then delegates one selected entry once to `resumeRun`; it is not a durable run session ([`src/fleet-coordinator.ts`](../src/fleet-coordinator.ts):74-82,319-320,447-456).
- **Fact:** managed results currently carry only `status`, `reportPath`, and `reportDigest`, while the kernel worker envelope is `{status}` ([`src/codex-host-policy.ts`](../src/codex-host-policy.ts):26-30,97-103; [`src/orchestration.ts`](../src/orchestration.ts):57-60,255-280). Current terminal evidence does not prove a closed allow-listed check contract.

### Target boundary (hypothesis and required proof)

- **Hypothesis:** a parent-issued, one-use continuation grant evaluated against machine-verifiable evidence can remove repeated manual re-entry for one exact condition while remaining subordinate to the kernel. This is not ambient auto-approval and does not show that unattended operation is generally safe.
- **Required proof:** show that only a grant bound to the exact run/phase/plan/policy/attempt and inbox token can consume one `PASS`; every mismatch, expiry, revocation, `FINDINGS`, adoption, arbitrary value, `UNKNOWN`, or relaunch path wakes the parent instead.

### Non-goals

- No scheduler, daemon, general continuation service, automatic approval, plan synthesis, parent-decision inference, or queue authority.
- No worker-defined check list, arbitrary result values, `FINDINGS` submission, adoption/promotion, phase transition, receipt synthesis, or `UNKNOWN` relaunch.
- No change to `RunKernel.advance`, reducer semantics, fleet admission, inbox value contract, public package exports, or manual bridge behavior.
- No unattended-safety, provider, token, latency, throughput, or production claim.

### Smallest coherent first release (R1-A to R1-C)

1. **Session record:** private `lunacy-continuation/v1` record with run-root identity; run/phase/plan/policy digests; owner nonce; lease epoch; expiry/deadline; maximum wakes; allowed wake-source set; generation and revocation state. The record is a bounded fence, never a kernel event.
2. **Proof record:** private `lunacy-worker-proof/v1` binds phase/step/attempt, launch token, command digest, report/diff/artifact digests, producer identity, and a parent-declared closed allow-list of check names/results. Canonical redacted evidence is content-addressed and size-limited. A pure verifier returns only `CERTIFIED` or `ATTENTION` and cannot emit a kernel event.
3. **One-event grant:** the parent grant names one future inbox token, exact value `PASS`, proof predicate, event-identity template, expiry, and one-use epoch. On `CERTIFIED`, the session calls existing `submitParentDecision` exactly once. `FINDINGS`, adoption, promotion, arbitrary values, `UNKNOWN`, and relaunch remain parent boundaries.
4. **Disablement:** stopping the session leaves kernel, fleet, inbox, manual-drive, and projection state usable. No migration is needed for roots that never opt in.

### Later stages (separately gated)

- **R1-D — lease/restart hardening:** CAS owner/epoch/expiry, bounded wake/deadline, crash checkpoint, and deterministic attention codes. A stale owner cannot reclaim without definitive liveness and generation checks.
- **R1-E — proof producer adapters:** derive evidence from existing launch/terminal/report records and, only after proof parity, add bounded artifact references. The parent remains the check-list owner.
- **R1-F — rollout gate:** enable the one `PASS` template only after adversarial race/restart evidence below; keep all other values manual. Any future grant shape, multi-event continuation, or unattended deployment is a new decision.

### Ownership and reuse seams

- Session persistence is private to the continuation owner and uses existing lease/CAS and quarantine conventions; it must not write `.kernel/CURRENT`, journal, outbox, or projections directly.
- Reuse fleet lease fencing, terminal/effect bindings, `DecisionInbox.submitParentDecision`, `RunKernel.advance`, and `BridgeDrivePump` stop/notification semantics. The continuation verifier is pure and has no driver, filesystem mutation, or kernel dependency.
- Use existing managed launch/terminal records as evidence inputs. Any new proof artifact is producer-scoped, digest-bound, redacted, and disposable; worker output cannot become authority.

### Compatibility and recovery invariants

- Existing one-shot inbox submission, manual bridge calls, fleet turns, and `UNKNOWN` recovery produce identical event/yield bytes whether or not a session record exists.
- Session records are versioned and disposable. A prior package ignores them; a newer package treats unknown/malformed records as `ATTENTION` and never guesses.
- A crash before session publication leaves no session authority. A crash after publication resumes only with matching owner/epoch/expiry and a fresh verified kernel generation.
- A crash after proof publication but before submit leaves the grant unconsumed; retrying the same event identity is idempotent. A crash after kernel commit is observed through the existing committed yield; the grant is then consumed exactly once.
- Revocation, cancellation, plan/policy drift, lease loss, stale attempt, missing/forged evidence, and uncertain effects stop at `ATTENTION`; none launches or mutates the run.

### Verification, fault, and benchmark gates

**Required proof matrix:**

- Fault before/after proof publication, wake observation, lease transfer, inbox submit, kernel commit, and session checkpoint; restart repeatedly and require one committed event or one bounded attention result.
- Race two session owners and two parent submissions. Require one token consumption, one journal entry, and exactly the same canonical event/yield bytes as manual inbox submission.
- Supply missing, forged, stale, expired, wrong-plan, wrong-attempt, wrong-token, unlisted-check, oversized, duplicate, and redacted-invalid evidence. Each must leave the token unconsumed and the run unchanged.
- Exercise cancellation, `UNKNOWN`, closed gates/barriers, projection failure, late matching receipts, owner revocation, and max-wake/deadline exhaustion. Verify no relaunch and no second scheduler path.
- Record wake count, lease epochs, proof/check counts, evidence bytes, event identity, and fault outcome for a frozen fixture. These counters are diagnostic; no speed/token/provider value is inferred.

### Rollout and rollback

Roll out as an explicit private route behind a versioned session/grant marker. Start in proof-only/attention mode, then enable the single exact `PASS` template after R1-E. Keep manual inbox and one-event bridge as the operator fallback. On any red gate, disable session evaluation and quarantine only exact continuation-owned debris; do not rewrite run state or consume a token to clean up. Package rollback is safe because old code ignores the marker and uses existing kernel/inbox behavior.

### Dependencies, risks, and mitigations

- **Dependencies:** frozen proof/check schema; existing terminal/report evidence; fleet lease/CAS conventions; decision inbox token/epoch fences; kernel and pump semantics. Rank 2 can reuse the proof vocabulary but does not block R1.
- **Risk — second scheduler/approver:** keep session state bounded and observational; only the kernel call can mutate and only the parent declares the predicate/value.
- **Risk — replay or stale proof:** bind all identities, owner epoch, grant epoch, and exact event template; fail closed on any drift.
- **Risk — unbounded wake loop or evidence leakage:** enforce max wakes/deadline, closed check names, bounded canonical/redacted payloads, and attention on overflow.
- **Risk — uncertain effect relaunch:** preserve existing `UNKNOWN`/observe rules and never invoke dispatch from verifier or recovery.

### Exit criteria

R1 is releasable only when the session/proof/grant schemas and canonical bytes are frozen; valid evidence yields one byte-equivalent `PASS` submission; every race, restart, drift, forged/missing proof, cancellation, and `UNKNOWN` case fails closed without mutation or relaunch; manual/fleet/inbox routes remain unchanged; disablement requires no run-state rewrite; and the archived report contains the complete required-proof matrix.

## 2. Transport-neutral, attested execution plane

### Current bottleneck and evidence (facts)

- **Fact:** the only effect-driver interface is private `EffectDriver.dispatch/observe`; private composition accepts a driver object and returns a `RunKernel` ([`src/driver.ts`](../src/driver.ts):19-22; [`src/composition.ts`](../src/composition.ts):1-5,71-88).
- **Fact:** `CodexExecDriver` supervises an already-claimed command through an in-memory local object and local durable records ([`src/codex-exec-driver.ts`](../src/codex-exec-driver.ts):15-21,32-56).
- **Fact:** managed host policy is closed over one Codex version/model/sandbox and absolute local run/workspace/effects paths; worker results carry local report paths ([`src/codex-host-policy.ts`](../src/codex-host-policy.ts):8-15,205-234,26-30).
- **Fact:** dispatch documentation explicitly says ordering is not a general exactly-once or remote-effect guarantee ([`docs/DURABILITY.md`](DURABILITY.md):120-139). Private bridge/host modules remain hidden from the package surface ([`test/product-surface.test.js`](../test/product-surface.test.js):47-63).

### Target boundary (hypothesis and required proof)

- **Hypothesis:** a closed transport protocol can let an explicitly named isolated/non-local executor run one claimed command without selecting work, writing the run root, retrying an uncertain token, or approving its own result. No provider, availability, throughput, or performance benefit is claimed.
- **Required proof:** prove endpoint identity/capability, exact command/token/digest/epoch echo, bounded authenticated frames, and old-or-new reconciliation across timeout, partition, crash, replay, and protocol drift. An OS/vendor trust root is required before any claim about hostile same-UID/shared-host safety.

### Non-goals

- No provider/plugin registry, discovery, scheduler, automatic fallback/retry, ambient credentials, public effect API, or remote plan selection.
- No remote mutation of run roots, `CURRENT`, journals, inboxes, projections, release trees, or approval state.
- No exactly-once claim for an effect that cannot be observed after partition; uncertainty remains `UNKNOWN`/attention.
- No claim that a loopback or one reference adapter proves all providers, transports, operating systems, or production deployments.

### Smallest coherent first release (R2-A to R2-C)

1. **Command frame:** private `lunacy-effect-remote/v1` frame with protocol/capability versions; endpoint identity; run/phase/plan/policy digests; lease/generation epochs; claimed command; launch token; command digest; deadline/limits; cancellation identity; sensitivity/retention class.
2. **Response frames:** authenticated receipt, observation, terminal status, and bounded content-addressed proof/artifact references using R1's vocabulary. The frame echoes the complete binding and carries no authority-bearing decision value.
3. **Kernel host:** remains the sole claimant and acknowledger. It validates frames before recording existing effect/receipt events. Timeout, partition, malformed identity, duplicate, or conflicting evidence becomes `UNKNOWN`/attention and never triggers a local retry.
4. **Adapters:** implement a loopback adapter for byte parity with the current local driver, then one operator-named reference adapter that crosses the no-shared-filesystem boundary. Both are private and explicit; no endpoint discovery or automatic selection.

### Later stages (separately gated)

- **R2-D — capability and identity lifecycle:** explicit endpoint provisioning, key/identity rotation, revocation, and bounded capability negotiation. Unsupported versions fail closed; trust roots remain operator-provided.
- **R2-E — artifact transfer:** add content-addressed, sensitivity-aware artifact fetch/retention only after receipt/terminal parity. Remote paths remain opaque references; a missing artifact is attention, not permission to rerun.
- **R2-F — host evacuation:** combine with Rank 3 continuity only after explicit takeover/fencing proof. This does not create a fleet scheduler or provider registry.

### Ownership and reuse seams

- The kernel-owned outbox/effect record and private `EffectDriver` remain the mutation seam. A transport adapter serializes/deserializes frames and returns bounded observations; it cannot call `RunKernel.advance` or write a run root.
- Reuse launch/terminal records, command/token/digest validators, cancellation/`UNKNOWN` rules, and R1 proof/artifact references. Keep host-policy digest and executable identity in the frame, but do not expose private host modules through package exports.
- Keep endpoint credentials, transport sockets, and temporary payloads outside authoritative state with explicit lifetime, cancellation, timeout, and cleanup. Status reports expose only bounded identifiers/codes.

### Compatibility and recovery invariants

- Local `CodexExecDriver`, manual receipt requests, bridge/pump stop reasons, outbox bytes, terminal bytes, cancellation behavior, and replay remain unchanged when transport is disabled.
- A version marker selects the transport only for one explicit effect. Unknown/mixed versions, missing capability, endpoint identity drift, wrong run/plan/policy, stale epoch, token reuse, or digest mismatch fail closed before kernel mutation.
- A crash before send leaves the claimed effect unchanged. A crash/timeout after send but before receipt records `UNKNOWN` and permits only the existing bounded `observe` path; no relaunch. A matching late receipt may reconcile that exact token, never mint a successor.
- Endpoint loss or owner revocation does not transfer authority implicitly. Any takeover is an explicit parent/operator action with a new lease/identity fence.

### Verification, fault, and benchmark gates

**Required proof matrix:**

- Race two endpoints for one launch token; only the exact identity/epoch winner may be acknowledged. Duplicate, stale, forged, wrong-run, wrong-policy, oversized, malformed, and version-drift frames must be rejected without kernel mutation.
- Inject crash/timeout/partition before send, after send, before receipt fsync, after receipt, before terminal, and during cancellation. Restart must converge to exact receipt/terminal or `UNKNOWN`, never relaunch.
- Tamper command, report/artifact digest, endpoint identity, capability, lease epoch, sensitivity class, or cancellation identity. Wrong artifacts are quarantined/attention only.
- Compare loopback and current local routes for receipt, terminal, replay, cancellation, parent-boundary, and `UNKNOWN` bytes/identities. Exercise the second adapter with no shared filesystem and bounded payload limits.
- Record frame counts/bytes, retries (expected zero automatic retries), receipt identities, observation attempts, and fault outcomes on a frozen fixture. These are diagnostic; no latency, throughput, provider, token, or availability claim is authorized.

### Rollout and rollback

Roll out first as a loopback/replay fixture, then an explicitly configured reference endpoint in disabled-by-default mode. Require operator-supplied endpoint identity and trust material; reject absent or stale material before dispatch. On any red gate, stop selecting the transport, leave claimed/`UNKNOWN` effects for the local/manual observation path, quarantine exact transport debris, and retain all kernel records. Package rollback is safe because local driver composition and old frames remain available.

### Dependencies, risks, and mitigations

- **Dependencies:** R1 proof/artifact vocabulary; existing outbox/effect/receipt records; private `EffectDriver`; host-policy/executable identity; explicit operator trust root before hostile-host claims. Rank 3 portable identity is useful for evacuation but not required for first dispatch.
- **Risk — duplicate external execution:** one-shot intent, exact token/digest/epoch echo, endpoint lease, and no automatic retry; uncertainty is `UNKNOWN`.
- **Risk — impersonation/replay/protocol confusion:** authenticated endpoint identity, nonce/epoch binding, closed version/capability fields, rotation/revocation, and fail-closed decode.
- **Risk — leakage or remote authority:** bounded/redacted frames, sensitivity/retention labels, no run-root write access, and kernel-only acknowledgement.
- **Risk — false security confidence:** document the OS/vendor trust-root dependency and do not generalize one adapter's proof to other hosts/providers.

### Exit criteria

R2 is releasable only when command/receipt/terminal/cancellation schemas are frozen; loopback bytes match local behavior; the reference adapter crosses the no-shared-filesystem boundary; races, partitions, crashes, tampering, and version drift converge to one exact acknowledgement or `UNKNOWN`; no remote path mutates kernel/release authority; local/manual routes and package surface are unchanged; and the archived proof contains no unsupported provider, security, availability, or performance claim.

## 3. Portable authoritative run continuity

### Current bottleneck and evidence (facts)

- **Fact:** `ArtifactStore` exposes load/commit and private reuse hooks but no export/import or transfer operation ([`src/store.ts`](../src/store.ts):94-107). Store selection is Memory or a root-bound `FileArtifactStore` ([`src/store.ts`](../src/store.ts):801-914).
- **Fact:** `FileArtifactStore` binds absolute root, `.kernel`, generation paths, and filesystem identities and rejects root identity changes ([`src/store.ts`](../src/store.ts):873-914,1056-1068,1876-1908).
- **Fact:** durability is organized around `.kernel/CURRENT`, immutable generations, journal, quarantine, and retention of CURRENT plus its immediate predecessor ([`docs/DURABILITY.md`](DURABILITY.md):3-37).
- **Fact:** recovery forensics is a read-only capsule for one explicit run/token; it never repairs, moves, or imports authority ([`docs/RECOVERY.md`](RECOVERY.md):3-17,29-49).

### Target boundary (hypothesis and required proof)

- **Hypothesis:** a quiesced, digest-bound export/import can provide verifiable cold continuity and auditable transfer across a root, volume, or host replacement. It does not prove live failover, backup durability, multi-writer safety, or independent source fencing.
- **Required proof:** demonstrate complete inventory, digest/identity verification, old-or-new publication, explicit source-retirement/takeover rules, and byte-equivalent canonical state/journal/yields/effect bindings after restore to a different trusted root.

### Non-goals

- No live replication, automatic failover, shared multi-writer state, backend discovery, backup scheduler, or cloud/provider integration.
- No repair by synthesizing receipts, changing event meaning, relaunching `CLAIMED`/`UNKNOWN`, or guessing from a partial archive.
- No weakening of root ownership, writer fence, generation CAS, quarantine, retention, effect, or recovery rules.
- No claim that a cold copy is durable, available, secure against an independently advancing source, or equivalent to a tested backup service.

### Smallest coherent first release (R3-A to R3-C)

1. **Export manifest:** private `lunacy-run-backup/v1` manifest names one run/phase/plan/policy identity, format/head, generation and immediate predecessor/recovery data, state/journal/outbox/effect evidence, managed identity/policy digests, sensitivity/retention classes, source root identity, and aggregate digest. Inventory is closed and bounded.
2. **Quiesced export:** under writer/effect exclusion and explicit quiescence, stream exact immutable bytes to an operator-selected destination, fsync files/directories, and publish the aggregate manifest only after all bytes are durable. Failed export cannot mutate source `CURRENT`.
3. **Import:** import only into an empty trusted root or an explicit old-or-new restore transaction. Verify every digest, range, format, semantic binding, and root-specific identity before publishing destination `CURRENT`; rebind root metadata without changing run/event meaning.
4. **Uncertain effects/source ownership:** preserve `CLAIMED`/`UNKNOWN` as attention requiring exact observation. If source still exists, import requires explicit source-retirement/takeover evidence; no independent copy may advance silently.

### Later stages (separately gated)

- **R3-D — resumable transfer:** checkpoint manifest chunks, bounded retries of immutable bytes, and exact-name quarantine/cleanup. A resumed transfer must be idempotent and cannot publish a partial head.
- **R3-E — explicit takeover:** add an operator-mediated source retirement/lease epoch and audit record. Without an external trust/coordinator boundary, the product must state that it cannot fence a copied source.
- **R3-F — storage conformance:** only after cold continuity proves the required CAS/identity/retention contract, evaluate one selected non-POSIX backend. General backend discovery and live replication remain new decisions.

### Ownership and reuse seams

- Keep `ArtifactStore` and `FileArtifactStore` as authority owners. Reuse their canonical validators, writer lock/fence, generation CAS, quarantine, retention, segmented head/segment checks, effect records, and release-style old-or-new transaction stages.
- Backup code owns only manifest/archive staging and destination publication. It may read immutable source generations under exclusion but cannot call reducer transitions or write source authority.
- Rebind only root-specific metadata (absolute paths, inode identity, writer nonce); preserve run/event/plan/policy/generation meaning. Include any future Rank 4 index only as digest-bound, discardable material covered by the manifest.

### Compatibility and recovery invariants

- Existing roots continue to load and commit without a backup marker. A prior package ignores backup material; a newer package rejects unknown/malformed manifests without exposing a destination `CURRENT`.
- Export is source read-only until a complete manifest is published; partial archives are quarantined and retryable by exact name. Import stages beside an empty destination and publishes one complete generation; a failed import leaves no authoritative `CURRENT`.
- Restore accepts only complete old or complete new authority. Missing/partial/tampered generations, wrong root identity, format drift, stale predecessor, mixed versions, or aggregate mismatch fail closed.
- Existing `CLAIMED`/`UNKNOWN` records and pending outbox/effect evidence remain unchanged. No receipt, journal event, or observation is synthesized during copy.
- Rollback to source or prior destination pointer is explicit and retains old generations until verified reachability/retention; GC is never part of publication.

### Verification, fault, and benchmark gates

**Required proof matrix:**

- Fault every enumerate/read/write/fsync/manifest/publish/import/cleanup step; restart at each boundary and require source unchanged on export failure, no destination `CURRENT` on import failure, and one complete old-or-new authority on success.
- Tamper, truncate, reorder, replay, mix formats, alter root/plan/policy/writer/epoch identities, and replace paths with symlinks. Reject before state/effect use and quarantine only exact untrusted material.
- Restore to a different root and compare canonical state, journal order, processed yields, outbox/effect bindings, generation metadata, and next kernel yield byte-for-byte with the source. Verify no `UNKNOWN` relaunch.
- Exercise source-live/no-takeover, explicit retirement/takeover, concurrent writer/effect, retention, migration retry, cancellation, and rollback. Preserve existing local roots and recovery-forensics read-only behavior.
- Record archive bytes/files, fsyncs, manifest stages, retries, generations, and fault outcomes on a frozen fixture. These measurements are operational evidence only; no backup speed, capacity, provider, security, or availability claim follows.

### Rollout and rollback

Roll out as an explicit operator command against one selected run/root, initially export-only and import-to-empty-root. Require a verified manifest and quiescence before transfer; do not auto-enroll roots. If any gate is red, stop new imports/exports, retain the source `CURRENT`, quarantine exact archive debris, and use the existing root. Rollback restores the recorded prior pointer/format or simply disables the route; it never deletes canonical source history or unowned destination files.

### Dependencies, risks, and mitigations

- **Dependencies:** store validators and writer/effect fences; current durability/retention/quarantine rules; segmented head semantics if present; R2 artifact references for portable evidence; explicit operator trust and source-retirement evidence. Rank 4's index must be included in any later manifest but is not needed for the first cold copy.
- **Risk — dual authorities:** empty-root import, quiescence, generation/identity epochs, explicit source retirement, and fail-closed live-source checks.
- **Risk — partial/stale/tampered archive:** closed inventory, aggregate and per-byte digests, old-or-new markers, format/version checks, exact quarantine, and no `CURRENT` until verification.
- **Risk — path/root rebinding drift:** separate root-specific identity fields from semantic fields; revalidate absolute paths, inode/ownership/mode, writer fence, and symlink constraints.
- **Risk — secret/effect leakage:** sensitivity/retention labels, bounded/redacted manifests, explicit destination trust, and no arbitrary process arguments or credentials in status.

### Exit criteria

R3 is releasable only when the manifest/inventory and sensitivity rules are frozen; export/import are quiesced, old-or-new, and retry-safe; every tamper, truncation, format, identity, live-source, and crash case fails closed without source mutation or `UNKNOWN` relaunch; restored canonical bytes/yields/effect bindings match; rollback leaves prior roots and unowned files intact; and no live-failover or backup-durability claim is made beyond the recorded proof.

## 4. Authenticated incremental run-state engine

### Current bottleneck and evidence (facts)

- **Fact:** the segmented/v2 reader still reads every descriptor, reads and digests every segment, parses the full journal, re-digests state/journal, and recomputes the checkpoint prefix digest on each load ([`src/store.ts`](../src/store.ts):1588-1627).
- **Fact:** each segmented/v2 commit fully verifies its predecessor, compares every prior journal entry, and re-reads/re-digests sealed segments before linking ([`src/store.ts`](../src/store.ts):1991-2037).
- **Fact:** legacy semantic ceilings remain 10,000 events and 1 MiB ([`src/limits.ts`](../src/limits.ts):1-14). The v2 writer is private/explicit and its value remains unclaimed ([`docs/DURABILITY.md`](DURABILITY.md):68-81; [`Lunacy/runs/implement-next-big-wins-v2/phases/p5/hard-gate-01.md`](../Lunacy/runs/implement-next-big-wins-v2/phases/p5/hard-gate-01.md)).
- **Fact:** context preparation digests plan/state and maps every plan step to a source ([`src/public.ts`](../src/public.ts):345-375); graph preparation verifies/scans graph/frontier and digests the full journal ([`src/graph.ts`](../src/graph.ts):121-156), followed by another journal digest at the commit freshness fence ([`src/public.ts`](../src/public.ts):757-767).
- **Fact:** the settled 30-repetition v2 corpus reports `valueDecision: UNCLAIMED`; its measurements expose work to investigate, not a speed or token claim ([`Lunacy/runs/next-big-wins-v3/phases/p1/reports/S3-worker-01.md`](../Lunacy/runs/next-big-wins-v3/phases/p1/reports/S3-worker-01.md)).

### Target boundary (hypothesis and required proof)

- **Hypothesis:** an authenticated segment index with cumulative summaries can bound ordinary verification to changed ranges while retaining a complete replay/recovery path. The same freshness primitives may later support cold-miss-safe context/graph preparation. No latency, token, throughput, or default-writer value is claimed.
- **Required proof:** prove index derivability, digest/range continuity, fallback parity, and corruption detection. A skipped range may never authorize a transition unless its summary is verified against the complete authority.

### Non-goals

- No silent history truncation, in-place rewrite, lazy replay that changes semantics, ceiling increase, default writer, public format/API, or migration of all existing roots.
- No replacement of `CURRENT`, reducer/event identities, generation CAS, writer fences, effect records, or recovery oracle.
- No use of stale index/context/graph proof for admission, approval, dispatch, promotion, or release. A stale index is a cold miss or attention.
- No projection index, reuse-index sharding, fleet admission index, provider, token, latency, throughput, or security claim from this direction.

### Smallest coherent first release (R4-A to R4-C)

1. **Authenticated index:** private versioned segment table with contiguous ranges, cumulative digest/checkpoint summaries, exact generation/writer/epoch bindings, logical journal end, and bounded size/count limits. Every entry is derivable from canonical history and discardable.
2. **Reader-first path:** ordinary load may use a verified index to select changed ranges, but retains a mandatory full-replay/recovery path. Legacy, v1, and current v2 readers remain supported; unknown/mixed/malformed index state falls back or fails closed before state/effect use.
3. **Opt-in writer:** only after reader/oracle parity, stage index updates with existing writer fence and `CURRENT` CAS. Legacy/v1/v2 writes and default/managed selectors remain unchanged. Add counters for ranges/segments/bytes read, digests, writes, and fsyncs.
4. **No admission coupling:** context/graph consumers remain OFF/SHADOW until a later gate proves freshness and cold-miss parity. A ceiling increase is a separately authorized result, not part of R4.

### Later stages (separately gated)

- **R4-D — writer and migration:** add explicit index-producing writer and resumable migration that retains prior heads/generations. Failed migration leaves the prior format authoritative.
- **R4-E — freshness reuse:** after index proof, share append-only accumulator and per-plan source/frontier index with context/graph in SHADOW compare-only mode. Stale/corrupt summaries become full recomputation, never changed admission.
- **R4-F — value decision:** only a representative paired corpus and fault/recovery parity can authorize an explicit value decision or any future ceiling proposal. Projection indexing and reuse/fleet sharding remain independent decisions.

### Ownership and reuse seams

- Keep `ArtifactStore`/`CURRENT` and full logical journal as authority. The index owner writes only authenticated summaries and range metadata under existing writer/generation fences.
- Reuse segmented/v2 head descriptors, checkpoint/digest validators, quarantine, migration/rollback, and direct unsegmented replay oracle. Reuse the same generation/epoch invalidation fields for context/graph only after R4-E.
- Expose counters through test/evidence hooks rather than public telemetry; a sidecar is removable without affecting state, journal, yields, or effects.

### Compatibility and recovery invariants

- A missing, deleted, unknown, stale, or malformed index is equivalent to a cold miss/full replay. Existing legacy/v1/v2 readers and writers remain loadable and selectable by their markers.
- Index entries must bind to exact generation, writer fence, epoch, head/checkpoint digest, contiguous ranges, and logical end. Gap, overlap, rollback, reorder, stale summary, head drift, or segment tamper triggers full verification or attention; it never passes because an untouched range was skipped.
- On crash during index write/head/CURRENT publication, restart sees one complete prior or successor generation. Unreferenced index bytes are quarantined; GC/compaction is explicit and never part of commit.
- Memory and File stores expose identical logical state, journal order, replay, yields, and effect bindings; index placement/work is private.
- Disablement removes only index selection/writes. It does not rewrite or prune canonical history and leaves existing rollback/recovery readers usable.

### Verification, fault, and benchmark gates

**Required proof matrix:**

- Against frozen 2,000-event and near-10,000-event corpora (plus state-size variants), run at least 30 repetitions per format. Record segments/ranges/bytes read, digest work, writes, fsyncs, and wall distributions; keep the value decision explicit and unclaimed until authorized.
- Inject gap, reorder, rollback, stale-summary, segment tamper, `CURRENT`/head drift, hard-link race, cancellation, crash, partial suffix, malformed/unknown version, migration, rollback, and GC faults. Lazy and full replay must yield identical canonical state/journal/yields/effect bindings.
- Exercise concurrent writers, long active suffix, legacy/v1/v2 mixed roots, Memory/File parity, restart, and corruption. Verify a corrupted untouched range cannot be skipped into admission.
- In SHADOW context/graph mode compare incremental and full preparation, including cold misses, plan/source/frontier drift, cancellation, restart, and tamper. Adoption remains OFF until parity and fault evidence pass.
- Record observations in the exact run artifact; no latency, byte, fsync, token, provider, or scale claim is accepted from the corpus alone.

### Rollout and rollback

Roll out reader-only compatibility first, then an explicit index-producing writer for selected test roots, and finally SHADOW freshness consumers. Keep default writer/managed routes on the existing format until the value gate passes. On a red gate, disable index selection/writes, retain the complete prior head/generation, quarantine exact index debris, and use full replay. Rollback never prunes history or changes reducer/effect semantics.

### Dependencies, risks, and mitigations

- **Dependencies:** frozen digest/index semantics; segmented/v2 reader/oracle; existing `CURRENT`/CAS/writer/quarantine; representative corpus and fault harness. Rank 3 manifests must carry any enabled index, but R4 does not require portable continuity.
- **Risk — index becomes second authority:** derive every summary from canonical history, bind to generation/epoch, and treat mismatch as cold miss/attention.
- **Risk — mixed-version recovery loses full replay:** retain legacy/v1/v2 readers and a direct full-replay oracle before writer enablement; unknown formats fail closed.
- **Risk — stale freshness changes admission:** SHADOW compare-only mode, complete-frontier/source digest, generation/epoch invalidation, and no ON selector until parity.
- **Risk — format complexity without value:** reader-first, opt-in writer, explicit value decision, and no ceiling/default claim without evidence.

### Exit criteria

R4 is releasable only when the index schema and derivation rules are frozen; reader/full-replay parity, tamper detection, old-or-new restart, migration/rollback/GC, and Memory/File equivalence pass; the required paired corpus records bounded work without an unsupported value claim; context/graph remain SHADOW until cold-miss parity; and disabling the feature leaves every existing generation, reader, effect, and recovery path usable.

## Deferred alternatives and decision triggers

These are not hidden fifth directions. Reconsider them only through a new scoped decision with its own authority, owner, compatibility, recovery, and proof gate:

- Typed worker artifacts as a standalone product (the proof subset belongs to R1 and transport references to R2).
- A general storage-neutral backend (evaluate only after R3 cold continuity proves the actual CAS/identity contract).
- An OS/vendor trust-root product (a dependency for any hostile/shared-host claim in R2, not a claim supplied by current digests).
- Large-plan Markdown projection indexing, reuse-index sharding, fleet admission indexing, dashboards, telemetry-only work, CLI polish, generic provider/plugin registries, ambient discovery, automatic approval, and general DAG/planner work.

## Roadmap Control Block

- **Status:** FINAL — implementation-ready documentation for exactly the four accepted directions in fixed rank order.
- **Changed:** `docs/NEXT_BIG_WINS_V3_ROADMAP.md` only for the roadmap artifact.
- **Authority:** planning guidance; no product, test, release, install, public API, provider, token, performance, security, or production claim is authorized.
- **Evidence posture:** facts cite local source/docs or accepted run reports; hypotheses and required proof are labelled in every direction.
- **Compatibility:** kernel/reducer, existing pump/driver, local store/recovery, manual inbox, fleet, and release transaction remain authoritative/fallback surfaces.
- **Residual risk:** all four directions remain proposals until their own fault, parity, and bounded-evidence gates pass; Rank 1 authority and Rank 2 external-boundary risks are highest.
- **Immutable boundary:** after this FINAL report, do not append later parent/gate findings; material changes require a new attempt/report.
