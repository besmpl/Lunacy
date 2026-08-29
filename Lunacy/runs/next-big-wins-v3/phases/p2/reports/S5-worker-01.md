# S5 — consequential portfolio ranking

## Portfolio judgment

The four directions below are ranked by the size of the new boundary they cross, the strength of current evidence, and whether a bounded first release can preserve the existing kernel/release authorities. They merge the P1 overlaps rather than assigning one slot per scout. The P5 fleet, decision inbox/promotion, segmented/v2 experiment, and outer release envelope remain delivered baseline, not proposals (`Lunacy/runs/implement-next-big-wins-v2/phases/p5/hard-gate-01.md`).

## Rank 1 — Proof-gated durable continuation

### Exact current evidence

- **Fact:** `BridgeDrivePump` explicitly owns no scheduler state, stops at the first parent boundary, and is recreated after restart (`src/orchestration.ts:105-109,193-206`). `runRun`, `resumeRun`, and every `LifecycleController` call construct a fresh drive (`src/orchestration.ts:745-774,796-807`).
- **Fact:** The managed route wakes the parent for receipts, blocked/decision states, cancellation, phase/final boundaries, and hard gates; parent intent, approval, adoption, gate, and final-result decisions remain authoritative (`SKILL.md:35-52`). The parent also reconciles a settled batch and schedules the next one (`SKILL.md:146-154`).
- **Fact:** The delivered fleet coordinator stores only cursor, leases, and observations and delegates one selected entry once to `resumeRun` (`src/fleet-coordinator.ts:74-82,319-320,375-383,447-456`). It is not a durable run session.
- **Fact:** A managed worker result contains only `status`, `reportPath`, and `reportDigest` (`src/codex-host-policy.ts:15,26-30,97-103`), while the kernel worker envelope is reduced to `{status}` (`src/orchestration.ts:57-60,255-280`). Current terminal evidence therefore does not prove an allow-listed check contract.
- **Fact:** The delivered inbox still requires the caller to supply the value and plan for one exact submission (`src/decision-inbox.ts:48-58,261-354`); the reducer keeps gate and adoption as one-shot parent events (`src/reducer.ts:247-278,287-318`).

### Fact versus inference

- **Established fact:** Lunacy can mechanically drive and coordinate explicit runs, but durable wake ownership, machine-verifiable acceptance evidence, and prospective bounded authorization do not exist as one contract.
- **Inference to prove:** A parent-issued, one-event continuation grant evaluated against machine-verifiable evidence can safely eliminate repeated re-entry for already-decided conditions. It must not be treated as ambient auto-approval or as proof that unattended operation is generally safe.

### Why this is a major win

This crosses the central autonomy boundary: from an operator-reinvoked mechanical loop to a restartable session that may perform one previously authorized consequential action when an exact proof predicate becomes true. The kernel still owns events and the parent still defines the predicate and value; the new value is durable continuation of that intent, not a new planner or approver.

### Smallest coherent first release

Ship a private, explicit `lunacy-continuation/v1` end-to-end slice:

1. A session record binds run-root identity, run/phase/plan/policy digests, owner and lease epoch, expiry, maximum wakes, and allowed wake sources.
2. A bounded `lunacy-worker-proof/v1` binds phase/step/attempt, launch token and command digest, report and diff/artifact digests, and results for a parent-declared allow-list of checks. A pure verifier returns only `CERTIFIED` or `ATTENTION`; it cannot emit a kernel event.
3. One parent-issued grant names one future inbox token, the exact value `PASS`, the proof predicate, one event identity template, expiry, and one-use epoch. On a certified proof, the session may call the existing `submitParentDecision` exactly once. `FINDINGS`, adoption, promotion, arbitrary values, `UNKNOWN`, and relaunch remain parent boundaries.
4. Disablement stops the session and leaves all kernel, fleet, inbox, and manual-drive state usable.

This is materially beyond the delivered inbox because authorization is prospective and conditional, not a caller supplying the value at submission time.

### Ordering and dependencies

Freeze the worker-proof/check contract first; then prove the durable session lease and restart behavior without any delegated decision; finally enable the single pre-authorized `PASS` template. Reuse fleet lease fencing, terminal/effect bindings, the decision inbox, and `RunKernel.advance`. Direction 2 should reuse the same proof vocabulary, but Rank 1 does not require remote execution.

### Principal risks

- A session or verifier becomes a second scheduler/approver.
- Stale proof, plan drift, replay, or two owners consumes a live decision incorrectly.
- Check names or artifact paths leak data or let workers self-define acceptance.
- Wake loops create unbounded work, or an uncertain effect is relaunched.

Mitigation must be structural: parent-declared closed checks, canonical bounded/redacted evidence, one-event grants, CAS owner/epoch/expiry fences, maximum wakes/deadline, kernel-only mutation, and fail-closed attention for every mismatch.

### Decisive proof

Fault before and after proof publication, wake observation, lease transfer, inbox submit, kernel commit, and session checkpoint; race two session owners; restart repeatedly. A valid proof must produce exactly the same committed event/yield bytes as manual inbox submission and consume the grant once. Missing, forged, stale, expired, wrong-plan, wrong-attempt, or unlisted evidence must not consume the token or mutate the run. Cancellation and `UNKNOWN` must never relaunch. Turning the route off must require no run-state rewrite.

## Rank 2 — Transport-neutral, attested execution plane

### Exact current evidence

- **Fact:** The only driver interface is the private in-process `EffectDriver.dispatch/observe` seam (`src/driver.ts:19-22`); private composition accepts a driver object and still returns only `RunKernel` (`src/composition.ts:1-5,71-88`).
- **Fact:** `CodexExecDriver` receives only a command already selected and claimed by the kernel, but supervises it through an in-memory local object and local durable records (`src/codex-exec-driver.ts:15-21,32-56`).
- **Fact:** The managed host policy is closed over one Codex version/model/sandbox and absolute local run/workspace/effects paths (`src/codex-host-policy.ts:8-15,205-234`). Worker results contain a local report path rather than a transport-neutral artifact reference (`src/codex-host-policy.ts:26-30`).
- **Fact:** Current durability documentation explicitly says dispatch ordering is not a general exactly-once or remote-effect guarantee (`docs/DURABILITY.md:120-139`).
- **Fact:** Private bridge/host modules are deliberately absent from the public package surface (`test/product-surface.test.js:47-63`).

### Fact versus inference

- **Established fact:** Lunacy has exact local token/digest/effect fences, but no versioned wire contract, remote executor identity, or no-shared-filesystem result plane.
- **Inference to prove:** A closed transport protocol can allow an explicitly named non-local or isolated executor without allowing that executor to select work, write the run root, retry an uncertain token, or approve its own result. No provider, throughput, or availability benefit is claimed in advance.

### Why this is a major win

This crosses the single-host/shared-filesystem execution boundary. It would make the kernel usable with isolated, remote, or heterogeneous worker hosts while preserving the same claimed-command and receipt semantics. That changes Lunacy from a local Codex binding into a verifiable execution platform seam, without creating a provider registry.

### Smallest coherent first release

Ship private `lunacy-effect-remote/v1` frames plus one operator-named reference executor that has no run-root write access:

- command frame: protocol/capability versions, endpoint identity, run/plan/policy/lease epochs, claimed command, launch token, command digest, limits, and cancellation identity;
- response frames: authenticated receipt, observation, terminal status, and bounded content-addressed proof/artifact references using the Rank 1 evidence vocabulary;
- kernel host: the only claimant and acknowledger; timeout, partition, malformed identity, or conflicting evidence becomes `UNKNOWN`/attention and never a local retry;
- explicit configuration only: no discovery, provider registry, scheduler, automatic fallback, public export, or ambient credentials.

Include a loopback adapter for byte parity, but the release is coherent only when the second adapter crosses the no-shared-filesystem boundary.

### Ordering and dependencies

First freeze command/receipt/terminal bytes against the current local driver and add replay fixtures. Then define operator-provisioned endpoint identity and rotation/revocation, followed by one reference transport and adversarial partition tests. Typed artifact/proof frames are a shared prerequisite with Rank 1. Rank 3 is not required for dispatch, although portable identity/state becomes useful for later host evacuation. An OS/vendor trust root is required before claiming safety on hostile same-UID or shared hosts.

### Principal risks

- Duplicate external execution across timeout, partition, or competing endpoints.
- Endpoint impersonation, stale lease/replay, protocol drift, or confused run/policy binding.
- Command, report, credential, or artifact leakage across the transport.
- Remote evidence accidentally becoming approval authority.

The contract must use one-shot intents, exact token/digest/epoch echoes, bounded authenticated frames, explicit sensitivity/retention, no remote run-root mutation, and fail-closed version/capability handling.

### Decisive proof

Race two endpoints for one token; only evidence for the exact claimed identity may be acknowledged. Reject forged, stale, wrong-run, wrong-policy, duplicate, oversized, and version-drift frames without kernel mutation. Crash or partition at every send/receipt/terminal boundary must converge to exact observation or `UNKNOWN`, never relaunch. Wrong artifact digests must be quarantined/attention only. Loopback and current local routes must retain byte-equivalent receipt, terminal, replay, cancellation, and parent-boundary behavior.

## Rank 3 — Portable authoritative run continuity

### Exact current evidence

- **Fact:** `ArtifactStore` exposes load/commit and private reuse hooks, but no export/import or transfer operation (`src/store.ts:94-107`). Store selection is Memory or a root-bound `FileArtifactStore` (`src/store.ts:801-914`).
- **Fact:** `FileArtifactStore` binds absolute root, `.kernel`, generation paths, and filesystem identities and rejects root identity changes (`src/store.ts:873-914,1056-1068,1876-1908`).
- **Fact:** Durability is organized around local `.kernel/CURRENT`, immutable generations, journal, and quarantine, with retention of CURRENT plus its immediate predecessor (`docs/DURABILITY.md:3-37`).
- **Fact:** Delivered recovery forensics is a read-only capsule for one explicit run/token; it never repairs, moves, or imports authority (`docs/RECOVERY.md:3-17,29-49`).

### Fact versus inference

- **Established fact:** Current recovery can verify one local root, but there is no product contract for an off-root checkpoint, cold restore, or host/volume handoff.
- **Inference to prove:** A quiesced, digest-bound export/import can provide verifiable cold continuity and auditable transfer. It does not by itself prove live failover, multi-writer safety, or backup durability.

### Why this is a major win

This crosses the local-root durability boundary. A run could survive an operator-directed root/volume/host replacement with its authoritative state and uncertain-effect evidence intact, instead of treating the original filesystem identity as the only continuation location.

### Smallest coherent first release

Ship private `lunacy-run-backup/v1` cold export/import:

1. Under writer/effect exclusion, export one exact CURRENT generation, required predecessor/recovery data, format/head/segments, state/journal/outbox, managed identity/policy digests, and bounded launch/terminal evidence to an operator-selected destination. Publish an aggregate manifest only after all bytes are durable.
2. Import only into an empty trusted root or through an explicit old-or-new restore transaction. Verify every digest and semantic binding before publishing destination CURRENT; rebind root-specific metadata without changing run/event meaning.
3. Preserve `CLAIMED`/`UNKNOWN` as attention requiring exact observation; never synthesize a receipt or launch. Require explicit source retirement/takeover evidence when the source still exists.
4. Keep live replication, automatic failover, shared multi-writer state, and generalized backend discovery out of the first release.

### Ordering and dependencies

Define the portable manifest and sensitivity/retention contract; reuse current store validators, writer fence, segmented proofs, effect records, and release transaction stages; then implement export, empty-root import, and takeover fencing. A storage-neutral backend conformance seam follows only after cold continuity proves the required state/CAS contract. Rank 4's future index must be covered by the manifest before indexed generations are portable.

### Principal risks

- Two restored copies advance as authorities.
- Partial, stale, replayed, tampered, or version-incompatible backups are accepted.
- Absolute paths/root identities are rebound inconsistently.
- Reports, instructions, credentials, or effect evidence leak through an overbroad archive.

Cold-first operation, explicit quiescence and source-retirement rules, generation/identity epochs, closed inventory, bounded/redacted content, and fail-closed format compatibility are required. The design must state that it cannot fence an independently copied source without an external trust/coordinator boundary.

### Decisive proof

Fault every enumerate/read/write/fsync/manifest/publish/import step; tamper, truncate, replay, reorder, and mix formats; restore to a different root and compare canonical state, journal, processed yields, outbox/effect bindings, and next kernel yield. Prove failed export does not mutate the source, failed import exposes no CURRENT, uncertain effects do not relaunch, and a live source without explicit takeover evidence is rejected. Existing local roots and rollback readers must remain usable when the feature is disabled.

## Rank 4 — Authenticated incremental run-state engine

### Exact current evidence

- **Fact:** The delivered segmented/v2 reader still reads every descriptor, reads and digests every segment, parses every journal line, rebuilds the full journal, re-digests state/journal, and recomputes the checkpoint prefix digest on each load (`src/store.ts:1588-1627`).
- **Fact:** Each segmented/v2 commit first fully verifies its predecessor, compares every prior journal entry, and re-reads/re-digests sealed segments before linking them (`src/store.ts:1991-2037`).
- **Fact:** The legacy semantic ceilings remain 10,000 events and 1 MiB (`src/limits.ts:1-14`). P5 leaves the v2 writer private/explicit and its value unclaimed; no default or managed route selects it (`Lunacy/runs/implement-next-big-wins-v2/phases/p5/hard-gate-01.md`).
- **Fact:** Context preparation digests the plan/state and maps every plan step to a source on enabled calls (`src/public.ts:345-375`); graph preparation verifies/scans graph/frontier and digests the full journal (`src/graph.ts:121-156`), followed by another journal digest at the commit freshness fence (`src/public.ts:757-767`).
- **Fact:** The settled scale scout's 30-repetition v2 corpus explicitly reported `valueDecision: UNCLAIMED`; its measurements expose work to investigate, not a speed claim (`phases/p1/reports/S3-worker-01.md`, “Baseline and claim discipline” and candidate 1).

### Fact versus inference

- **Established fact:** Segmentation reduces physical duplication in the experimental format but has not made load/commit/context proof preparation incremental; authoritative paths still perform full-history or full-plan work.
- **Inference to prove:** An authenticated segment index with cumulative summaries can bound ordinary verification to changed ranges, and the same freshness primitives can later support cold-miss-safe incremental context/graph preparation. No latency, token, throughput, or default-writer value is claimed yet.

### Why this is a major win

This is the strongest evidenced path to a materially larger run/plan scale boundary. It targets authoritative replay and proof preparation rather than projection polish, and it creates the prerequisite for considering any future lift of the finite journal ceiling.

### Smallest coherent first release

Add a private, explicit authenticated history index above the delivered segmented/v2 experiment:

- a versioned segment table with cumulative digest/checkpoint summaries and exact generation/writer/epoch bindings;
- bounded lazy range verification for ordinary loads, with a mandatory full-replay/recovery path and mixed-version fallback;
- an opt-in index-producing writer extension only after the reader/fallback is proven; legacy, v1, and current v2 readers remain supported and no default/managed selector changes;
- counters for segments/ranges/bytes read, digests, writes, and fsyncs.

Only after this release passes should context/graph freshness consume the same append-only accumulator and per-plan source/frontier index. A ceiling increase is a later, separately authorized result, not part of the first release.

### Ordering and dependencies

Freeze digest/index semantics and tamper behavior; build compatibility reader plus full-replay oracle; add the explicit writer; run the representative corpus; then share proven freshness fields with context/graph SHADOW mode. Rank 3 must include the new index in portable manifests. Projection indexing and reuse-index sharding remain independent followers.

### Principal risks

- A summary/index becomes a second authority or hides a gap, rollback, reorder, or corrupt untouched segment.
- Mixed-version recovery loses the only complete replay path.
- Stale context/graph proofs alter admission rather than becoming cold misses.
- More formats increase recovery and rollback complexity without demonstrated value.

Every index must be derivable, digest-bound, and discardable; mismatch must trigger full verification or fail closed, never authorize a transition. Existing CURRENT/CAS, reducer, effect, and recovery authority remains unchanged.

### Decisive proof

Against frozen 2k and 10k-event corpora, run at least 30 repetitions per format and record segments/ranges/bytes read, digest work, writes/fsyncs, and wall distributions while keeping the value decision explicit. Inject gap, reorder, rollback, stale-summary, segment tamper, CURRENT/head drift, hard-link race, cancellation, and crash faults. Lazy and full replay must produce identical canonical state/journal/yields, and corruption must never pass only because an untouched range was skipped. Context/graph adoption remains SHADOW until cold-miss parity and restart/tamper tests show no admission change.

## Deferred alternatives

- **Typed worker artifacts as a standalone direction:** major enabling work, but not a distinct portfolio boundary. Its proof/check subset belongs to Rank 1 and its transport-neutral artifact references belong to Rank 2. A generic artifact plane without those consumers risks schema work without control impact.
- **General storage-neutral authoritative backend:** potentially major, but cold export/import is the smaller concrete continuity boundary and reveals the actual CAS/identity/retention contract first. No settled scout proved demand or conformance for a particular non-POSIX backend. Reconsider after Rank 3.
- **OS/vendor trust root as a standalone product:** required before claiming unattended safety against same-UID/shared-host attackers (`docs/BRIDGE.md:203-222`), but a generic cross-platform trust product is not yet a bounded first release. Make one explicit backend a dependency of Rank 2's shared/unattended deployment stage; do not claim the current digest checks provide this protection.
- **Large-plan Markdown projection index:** projections currently build and publish a full all-step payload (`src/bridge.ts:889-900,966-990`), but this is an authority-neutral copy and the scale evidence is diagnostic only. Reconsider after Rank 4 proves representative authoritative-state value.
- **Reuse-index sharding and fleet admission indexing:** both have plausible full-scan seams, but the settled scout found no representative 100/1k/10k-entry reuse corpus or fleet stress evidence. They do not yet clear the major-win evidence bar.
- **General DAG/planner, ambient discovery, automatic approval, provider/plugin registry, dashboards, telemetry-only work, and CLI polish:** these either violate the existing authority boundary or do not independently change autonomy, scale, reliability, or platform reach. They remain below the requested bar.

## Lunacy Control Block

- **Status:** PASS — exactly four mutually distinct major directions ranked from the settled P1 evidence.
- **Changed:** only `Lunacy/runs/next-big-wins-v3/phases/p2/reports/S5-worker-01.md`.
- **Checks:** read-only source/docs/test spot-checks completed; report path, four-rank count, final newline, and trailing whitespace verified; no product tests run because this phase is discovery-only.
- **Authority:** discovery judgment only; no product, release, install, commit, push, provider, performance, token, security, or production claim is authorized.
- **Residual risk:** every direction remains an inference until its stated decisive proof passes; Rank 1 has the highest authority risk and Rank 2 the highest external-boundary risk.
