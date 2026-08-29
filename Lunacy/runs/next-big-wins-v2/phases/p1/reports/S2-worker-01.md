# S2 — architecture / product-platform discovery

## Ranked directions (after R1–R4)

### 1. Multi-run scheduler/queue with cross-run admission
- **Bottleneck (fact):** `WORKSPACE.md:29` and `docs/ROADMAP.md:18-23,54-60` state there is no global registry, lock DB, scheduler, or `CURRENT_RUN`. `RunKernel.advance` accepts one `AdvanceInput` (`src/model.ts:54-59`); `KernelOptions.maxInFlight` and `proveAdmission` are per kernel/run (`src/public.ts:68-83,541-547`; `src/admission.ts:1-12`). `BridgeDrivePump` is explicitly ephemeral and owns no scheduler state (`src/orchestration.ts:105-109`); `LifecycleOptions` names one `runDir`/`runId` (`src/orchestration.ts:517-545`). Tests cover same-run contention only (`test/orchestration.test.js`: “competing pumps settle one launch…”).
- **Why major (inference):** A durable workspace queue would coordinate many roots and enforce global fairness, changing scale/autonomy. Scheduler selects only; per-run kernel remains authority.
- **Smallest coherent slice:** explicit operator-created registry/queue (no ambient discovery) with run-root identity, plan digest, claims, priority, lease; atomically claim one candidate, call lifecycle `resume`, then record/release. No automatic plan/decision adoption.
- **Dependencies:** R1 lifecycle; R4 Workfront/recovery; workspace registry/lock and root/plan fences.
- **Risks:** duplicate launches, stale root swaps, starvation/deadlock, or divergence from `CURRENT`; use CAS identity/lease, deterministic ordering, queue as intent only.
- **Decisive proof:** two roots with overlapping and disjoint claims; concurrent schedulers produce one launch per kernel, deterministic fair order, stale/deleted roots fail closed, parent boundaries remain queued, restart replay is exact, and no files outside registry/locks/runs change.

### 2. Digest-bound decision inbox (approval routing; policy later)
- **Bottleneck (fact):** `Yield.DECISION_REQUIRED` and `PARENT_DECISION` are explicit (`src/model.ts:34-40,84-88`), but durable `decisionTokens` live inside one `MachineState` (`src/model.ts:107-143`). Authority drift creates a token in `src/public.ts:511-538`; `applyParentDecision` consumes it once (`src/public.ts:478-508`). Workfront derives attention for one root only (`src/workfront.ts:10-22,58-71`; `docs/WORKFRONT.md:3-6,44-52`). Tests prove manual acknowledgement/one-shot behavior (`test/beads.test.js`: “active Beads adoption requires acknowledgement…”; `test/kernel-repair.test.js`: “authority drift yields a decision…”).
- **Why major (inference):** A durable, cross-run inbox prevents dropped/duplicate approvals and enables unattended routing while preserving parent authority; this is materially more autonomous than requiring a caller to poll each root and hand-build exact events.
- **Smallest coherent slice:** additive workspace inbox records immutable request `{run root/id, token, plan/authority digest, cursor, brief/evidence digest, allowed values}`. Ack atomically claims request and submits exact `PARENT_DECISION` with CAS; listing is read-only. No auto-approval yet.
- **Dependencies:** R1 stop + R4 evidence/Workfront; canonical schemas/locking; parent authorization. Kernel token remains authority.
- **Risks:** stale digest/epoch, replay, crash between inbox update and kernel commit, leakage, or inbox becoming authority. Use digest binding, idempotent ack, immutable/redacted records, fail-closed CAS.
- **Decisive proof:** two runs’ gate/adoption requests sort deterministically; concurrent ack of one token commits one event and exact replay; wrong digest/epoch/tamper fails closed; crash before/after ack converges; inspection never mutates `CURRENT`.

### 3. Resumable release-operation envelope (first-class production lifecycle)
- **Bottleneck (fact):** deployment already has exact transaction phases/recovery (`tools/deploy-skill.mjs:27,835-905,1007-1079`), and release exclusion is robust (`src/release-operation.ts:39-94`; tests `test/r11a2-release-exclusion.test.js`, `test/r11d7-exact-legacy-deploy.test.js`). Yet check/restore/deploy remain CLI transactions; no operation status is visible to `RunKernel`/Lifecycle/Workfront. `docs/BRIDGE.md:145-179` documents recovery but requires explicit shell orchestration.
- **Why major (inference):** An envelope makes rollout resumable/observable and binds approvals/receipts to exact manifest/snapshot identities, without redoing the proven transaction.
- **Smallest coherent slice:** private `lunacy-release-operation/v2` request/result (operation ID, manifest/target/snapshot digests, phase/status) plus read-only `resume-release` projection and idempotent start record. Keep marker/locks authoritative; deployment still requires explicit parent decision.
- **Dependencies:** existing `withReleaseExclusion`, `recoverTransaction`, quiescence/snapshot binder; R4 receipt/recovery; schema/bridge route.
- **Risks:** second authority, stale snapshots, lock races, replayed deploy, rollback crossing run fences; store refs/digests, CAS operation ID, explicit decision, marker authority.
- **Decisive proof:** crash at every existing phase then `resume-release` converges to exact prior/candidate tree; duplicate ID is byte-identical; stale manifest/snapshot/target fails closed; existing CLI/tests remain green and release claims still exclude writers/drives.

## Explicit rejections
Bridge projection de-dup/no-op writes (ROADMAP:416) awaits a >=30-pair corpus; cost-aware accelerator admission/ON canary (417) is a narrower, evidence-gated optimization; pure admission-planner/reuse-store extraction (418) is refactoring. R1–R4 are shipped.

## Control Block
- Scope: discovery only; no product/source changes.
- Evidence: `WORKSPACE.md`, `docs/API.md`, `docs/ROADMAP.md`, `docs/WORKFRONT.md`, `docs/BRIDGE.md`, `src/model.ts`, `src/public.ts`, `src/orchestration.ts`, `src/admission.ts`, `src/workfront.ts`, `src/release-operation.ts`, deploy/relevant tests.
- Checks: read-only `git status --short`; no test run (no code changed).
- Result: FINAL; report is immutable after this message.
