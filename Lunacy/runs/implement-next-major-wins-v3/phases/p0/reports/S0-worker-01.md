# S0 — cross-roadmap implementation contract and dependency freeze

Status: **FINAL — implementation contract frozen; no product or release write authorized**

## Judgment

The accepted order remains P1 continuation, P2 remote execution, P3 cold continuity, P4 incremental state. They may share closed identity and proof bytes, but they must not share a new authority. `RunKernel.advance` remains the only run-transition mutator, `DecisionInbox.submitParentDecision` remains the only P1 decision-submission seam, `DispatchCoordinator` remains the effect claim/ack/`UNKNOWN` owner, `FileArtifactStore`/`CURRENT` remains the file-run publication authority, and the existing release transaction remains the managed-tree publication authority. The release-envelope repair is accepted baseline only; neither `release-operation.ts` nor deployment transaction code is a run-backup primitive.

This judgment narrows two roadmap ambiguities that otherwise make the plan unsafe: P1 v1 grants bind a **currently committed, unconsumed READY gate token**, not a predicted token that does not yet exist; and P4 v1 may skip prior bytes only within a still-valid trusted verification session. A cold process start or changed file identity performs full verification unless a separately approved external trust anchor exists.

## Shared contract frozen once

All new records use closed, versioned canonical JSON through `canonicalString`/`parseCanonical`; content identity is SHA-256 `digest` over the canonical value. Unknown fields, versions, enum values, duplicate identities, non-canonical bytes, ceilings, or binding drift fail to a bounded `ATTENTION`/cold-miss result before mutation. A digest proves content equality, **not producer authenticity**.

The common binding is composed rather than copied selectively:

- **Run binding:** local root path plus verified filesystem `{dev, ino}` while on that host; `runId`, `phaseId`, generation, revision, plan digest, nullable managed-policy digest, authority/attempt/barrier/mode epochs, and writer fence. Root path and filesystem identity are host-local and are explicitly rebound by P3; run/event meaning is not.
- **Effect binding:** command/step identity, launch token, command digest, command lease, cancellation identity, and the complete current run binding. Existing outbox matching already requires token/digest and current epochs (`src/outbox.ts`; `src/reducer.ts:58,205-214`).
- **Operation binding:** record schema/version, operation id, owner nonce, lease/grant epoch, expiry/deadline, revocation generation, and exact payload digest. Wall-clock expiry is only a rejection fence; it is never proof that a prior owner or remote effect is dead.
- **Proof binding:** `lunacy-check-contract/v1` digest, producer/effect binding, phase/step/attempt, terminal-record digest, report/diff/artifact digests when present, one result for every parent-declared check and no others, plus bounded sensitivity/retention metadata. `lunacy-worker-proof/v1` is disposable evidence. Its pure verifier returns only `CERTIFIED` or a stable `ATTENTION:<code>`; it cannot call a driver, inbox, store commit, or kernel.
- **Grant binding:** exact current inbox snapshot and token, exact value `PASS`, deterministic event id, check-contract/proof predicate digests, plan/policy/run binding, one-use grant epoch, expiry, and revocation generation. Kernel token consumption, not a session flag, is the authority for whether the grant was used.

Do not invent parallel `run identity`, `receipt`, `proof`, or `epoch` types per feature. P2 reuses the P1 proof bytes by digest; P3 carries canonical authoritative bytes and effect evidence without reinterpreting them; P4 binds its derived summaries to the same generation/epoch/writer fields. Proof references do not multiply proof: there is one content digest and one referenced canonical record, not separately trusted copies in a frame, archive, and index.

## Ownership by existing seams

| Responsibility | Owning seam | Boundary |
| --- | --- | --- |
| P1 proof codecs and managed launch/terminal/report binding | `src/codex-effect-records.ts` and `src/codex-host-policy.ts` | Add private closed evidence production/validation beside the existing immutable records. Do not widen the worker envelope accepted by the reducer and do not let the worker choose checks. |
| P1 durable session/wake mechanics | `src/orchestration.ts` (a private continuation helper may hold codecs/storage) | Recreate `BridgeDrivePump` from verified `CURRENT`; no daemon, queue, scheduler state, or direct journal/outbox write. Fleet is a vocabulary/example only, not a callable lease authority. |
| P1 consequential action | `src/decision-inbox.ts` | Exactly one existing `submitParentDecision` call with the frozen inbox snapshot, `PASS`, plan, and deterministic event id. No adoption, promotion, `FINDINGS`, or phase transition. |
| P2 command/observation execution | `src/driver.ts`, `src/composition.ts`, `src/dispatch-coordinator.ts` | A private adapter implements `EffectDriver`; the coordinator remains the sole claim/ack/late-observation owner. An adapter cannot write a run root or call the kernel. |
| P2 host evidence | `src/codex-effect-records.ts` | Frame payloads reference the same terminal/proof records by digest. Remote paths are never evidence references. |
| P3 snapshot validation/publication | `src/store.ts` / `FileArtifactStore` | New narrow private file-store operations acquire existing writer/process fences, enumerate a closed snapshot, validate with existing readers, and publish destination `CURRENT` last. A workflow wrapper may coordinate export/import but owns no bytes. `MemoryArtifactStore` gets logical parity tests, not a pretend durable backup. |
| P3 quiescence | existing writer/effect reconciliation plus explicit operator boundary | Export rejects live `PENDING`/`CLAIMED` work and preserves `UNKNOWN`; import never observes, acknowledges, or launches. Release exclusion locks are not reused for run authority. |
| P4 authenticated index and selector | `src/store.ts` | The index is derived, removable, and selected only after the normal `CURRENT`/generation proof. Full replay remains the oracle. Context/graph modules receive nothing until later SHADOW work. |
| Acceptance and claims | phase hard gates, then final parent/release gate | Feature code may emit facts/counters only. Gates own compatibility, value, default, release, security, provider, token, performance, and production judgments. |

## Exact phase and write ordering

1. **B0, before P1 source writes:** freeze checkout/dirty-baseline identity, canonical manual inbox event/yield bytes, local receipt/terminal bytes, legacy/v1/v2 load/replay bytes, exact fixtures, environment, fault schedule, and the accepted release-envelope path-digest baseline. These are comparison authorities, not targets.
2. **P1, serialized:** (A) closed check contract, worker-proof codec, pure verifier, negative corpus; (B) managed File-root session record, atomic private sidecar, owner/epoch/expiry/revocation and proof-only restart/wake path with decision disabled; (C) current-token one-`PASS` grant adapter through `submitParentDecision`; (D) race/crash/disablement matrix and documentation. Freeze P1 canonical proof bytes before P2 starts.
3. **P2, serialized after P1 proof freeze:** frame codec/replay fixtures; current-local loopback byte parity; explicit endpoint identity/authentication lifecycle; one no-shared-filesystem adapter; then partition/race/cancellation/late-observation proof. Loopback alone cannot close P2. Do not touch P3/P4 storage formats in this phase.
4. **P3, serialized after P2 gate:** closed authoritative manifest and out-of-band expected-manifest-digest input; read-only export under quiescence; empty-root import staging and full semantic validation; destination `CURRENT` publication last; source-retirement/takeover rejection; crash/tamper/rollback proof. Do not edit release/deployment behavior.
5. **P4, serialized after P3 gate:** index derivation specification and cold full-replay oracle; reader/session-local verification cache; fault parity; explicit index writer only after reader parity; representative corpus; only then optional context/graph SHADOW integration. Default writer, managed selector, ceilings, and admission remain unchanged.
6. **P5:** one final integrated matrix on an unchanged tree, package/deploy checks, disablement/rollback proof, and only then separately authorized install/release/git actions. Any product edit after the terminal snapshot invalidates affected and final evidence.

Within every phase, write schemas/codecs and negative tests first, then pure behavior, then effectful integration, then compatibility/fault tests, then docs. Serialize all writes touching `orchestration.ts`, effect records, `store.ts`, release boundaries, and shared schemas. No later phase may opportunistically refactor an earlier authority seam.

## Smallest coherent P1 slices

### P1-A — evidence only

Implement the closed parent declaration plus proof codec/verifier. Parent declaration fixes check ids, expected result (`PASS` only for v1), producer kind/version, required evidence digests, size/count ceilings, and expiry before worker execution. A worker may report results but cannot add, remove, rename, or waive checks. Current terminal status/report digest is an input, not certification: current managed records expose a local report path/digest and the pump reduces success to `{status}` (`src/orchestration.ts:57-60,255-280`), so an immutable machine-check producer is a prerequisite. P1-A performs no run/session mutation.

### P1-B — durable observation, decision disabled

Support one explicitly selected managed `FileArtifactStore` run. Publish `lunacy-continuation/v1` as a private old-or-new sidecar, bound to the verified run and owner/lease epoch, with max wakes, deadline, revocation, and a closed wake-source set. V1 wakes are only explicit resume, matching existing receipt/terminal notification, proof publication, or current inbox availability; there is no timer poller, discovery, or background daemon. On restart, reload `CURRENT`, revalidate every binding, then recreate the existing pump. Lease loss, stale liveness, drift, cancellation, `UNKNOWN`, or malformed evidence stops at attention. This slice proves restart/lease mechanics without submitting any decision.

### P1-C — one existing-token `PASS`

The parent may create a grant only from an exact `READY`, unconsumed, current `GATE` inbox row. V1 does not predict reducer token names or reserve a future kernel token. The session stores the canonical inbox snapshot and digest-bound canonical plan material needed by the existing submit contract. On `CERTIFIED`, it calls `submitParentDecision` once with deterministic event id. If the process dies before commit, retry is the same kernel identity; if it dies after commit but before sidecar checkpoint, the existing processed replay is observed and the projection is marked consumed. Two owners racing converge through the existing inbox/kernel CAS. Any non-commit/attention result leaves the grant projection unconsumed but terminally attention until explicit parent action; it does not loop.

This restriction is necessary because the current inbox never creates tokens (`src/decision-inbox.ts:19-27,223-239`) and submission requires an exact current inbox snapshot and caller plan (`src/decision-inbox.ts:48-58,261-333`). A prospective grant for a token that does not yet exist would require a new kernel reservation protocol and is deferred.

## Compatibility and rollback contracts

- All routes are private, explicit, disabled by absence, and package-root exports/CLI/default bytes stay unchanged. Manual one-event, lifecycle, fleet, inbox, local driver, legacy/v1/v2, Memory/File logical semantics, and existing release markers remain the comparison oracles.
- Sidecars, proofs, transport frames, backup staging, and indexes never make a root fresh or authoritative. Unknown/malformed debris is ignored as a cold miss or quarantined only within the feature-owned namespace.
- P1 disablement stops evaluation and requires no kernel rewrite/token cleanup. P2 disablement stops new remote selection and leaves an exact claimed/`UNKNOWN` effect for existing observation/manual recovery—never local redispatch. P3 failed export never mutates source; failed import exposes no destination `CURRENT`. P4 disablement deletes/ignores only derived index material and full-replays existing generations.
- Rollback readers must tolerate feature absence. No old package is required to understand a generation whose validity depends on a new sidecar; therefore P4 indexes can never be necessary to validate canonical history.
- Absolute paths, credentials, argv, report contents, and arbitrary worker text do not appear in bounded status. Archive/frame sensitivity and retention are explicit. Existing host checks are not a sandbox against malicious same-UID code (`docs/BRIDGE.md:203-222`).

## Verification ownership and named adversaries

- **P1 owner tests:** proof codec/verifier and orchestration/inbox fault tests; adversaries are the self-certifying worker, forged/stale/wrong-attempt proof, predicted/nonexistent token, mutated plan, two session owners, late revocation, crash around kernel commit, wake exhaustion, and `UNKNOWN` relaunch.
- **P2 owner tests:** driver/coordinator/record tests plus no-shared-filesystem harness; adversaries are two endpoints racing one token, endpoint impersonation, replay/version confusion, partition at every receipt/terminal boundary, late conflicting evidence, oversized frame, credential/artifact leakage, and remote approval injection.
- **P3 owner tests:** store/recovery fault harness; adversaries are archive substitution (including rewriting manifest and payload together), truncation/reorder/mixed generation, path/symlink/root-identity substitution, live source plus restored destination, partial fsync/publish, and uncertain-effect laundering. Import requires the expected aggregate digest from outside the archive; a self-contained digest is not authenticity.
- **P4 owner tests:** store oracle/corpus; adversaries are stale index, gap/overlap/reorder/rollback, modified skipped segment, `CURRENT`/head drift, hard-link race, partial index/CURRENT publication, mixed reader versions, and stale context/graph admission.
- The phase parent independently samples actual code and closes each hard gate. P5 owns the unchanged-tree `npm run check`, focused cross-feature matrix, packaging/deployment/rollback proof, and all release claims. Timings, bytes, digests, fsyncs, wake counts, frame counts, and fault outcomes are observations only.

## Material contradictions and deferred decisions

1. **P1 future token:** current code has no reservation authority. V1 binds an existing READY token. Predictive/pre-gate grants, multi-event grants, `FINDINGS`, adoption, promotion, and arbitrary values require a new explicit decision.
2. **P1 evidence gap:** terminal/report digests do not prove a closed check list. P1-A is a hard prerequisite; merely parsing the worker report is insufficient.
3. **Fleet lease reuse:** fleet leases are advisory, wall-clock records for one fleet turn, not a reusable session CAS/liveness authority (`src/fleet-coordinator.ts:55-82,311-320`). Reuse conventions and attention codes, not fleet state or scheduler behavior.
4. **P2 authentication:** SHA-256 content digests are not endpoint authentication. The reference adapter must select an operator-provisioned standard authentication/trust boundary before implementation; algorithm/key lifecycle is a bounded P2 decision. Hostile same-UID/shared-host safety remains unclaimed without an OS/separate-account/vendor root.
5. **P3 source fencing:** a local process cannot prove that an independently copied or unreachable source is retired. V1 may atomically retire a reachable quiesced source under the same trusted operation; unreachable-host takeover needs an external, operator-owned authorization/fencing decision and cannot support a multi-writer/failover claim.
6. **P3/P4 ordering loop:** P3 precedes an index whose schema does not yet exist, while the roadmap says indexed roots must be covered. Resolve by making the P4 index always optional/derivable: P3 v1 carries canonical authority without it. After P4 freezes bytes, a versioned optional manifest attachment may carry the index, and omission rebuilds it. Do not speculate P4 fields in P3.
7. **P4 skipped-range impossibility:** a digest tree stored beside attacker-writable segments cannot detect that an unread leaf changed. V1 therefore full-verifies on cold start and after identity/trust drift; only a still-valid verification memo may skip unchanged ranges. Durable cross-restart skipping requires a separately approved protected trust anchor. No scale/performance/default/ceiling claim follows from the session-local path.
8. **Release vocabulary:** old-or-new marker patterns may inform tests, but the release operation is callback-scoped managed-tree authority (`src/release-operation.ts:33-69`) and must not become a second run-root transaction or be edited by P3/P4.

Deferred until their named gate: the P2 authentication backend and hostile-host trust root; unreachable-source takeover/fencing and live evacuation; any general storage backend; P4 protected cross-restart anchor, context/graph ON consumption, default writer, ceiling lift, compaction/GC change; typed artifacts as a standalone plane; public API/CLI/default changes; provider registry/discovery; performance, token, provider, security, availability, production, install, or release claims.

## Lunacy Control Block

- **Status:** FINAL — P0/S0 implementation contract is frozen with the two necessary v1 narrowings (current-token P1 grant; cold-start full verification in P4).
- **Changed:** only this report; no product, schema, roadmap, release, install, or git write.
- **Checks:** required plan/decisions/steps, accepted v3 S5 report and PASS gate, P5 READY gate, release-envelope repair gates, roadmap, and cited source/docs seams inspected; report path/format checks remain for the parent.
- **Claims:** no performance, token, provider, security, availability, production, release, or product-value benefit is claimed.
- **Next:** P1-A may begin only from the frozen B0 corpus; all deferred decisions remain closed until their explicit phase gates.
