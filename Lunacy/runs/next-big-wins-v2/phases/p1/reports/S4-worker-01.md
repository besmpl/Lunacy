# S4 — Recovery / observability / release / fleet (post-R1-R4)

Baseline: released `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7`; R1 lifecycle, R2 segments/checkpoints, R3 dispatch, R4 forensics shipped.

## 1. Explicit multi-run scheduler / queue / fleet coordinator

- **Fact/bottleneck:** `BridgeDrivePump` owns “no scheduler state”; `maxTransitions` is not a durable queue/cursor (`src/orchestration.ts:26-33,105-109`). `runRun`/`resumeRun` select one root (`:745-775`); admission/`maxInFlight` are one state/kernel (`src/reducer.ts:60-108`, `src/public.ts:34-76`). Workspace has no global registry/scheduler/lock DB (`WORKSPACE.md:29`). Same-root duplicates are covered (`test/orchestration.test.js:151-171`, `test/controller.test.js:82-94`), but no cross-root lease/order/fairness/restart proof.
- **Inference/payoff:** Fleet-scale autonomy when several authorized roots need progress: leases/fairness replace host polling while preserving per-run authority (no throughput claim).
- **Smallest slice:** Private coordinator consumes explicit digest-bound manifest (root, plan/policy digest, priority); persists only queue lease/reconcile state; deterministic selection; revalidates bridge/writer claims then invokes current pump. No ambient discovery, plan synthesis, approval/gate override, or direct state mutation.
- **Dependencies/risks:** Uses R1 status/attention, R4 evidence, `CURRENT`, `inspectWorkfront`, locks. Risks: second authority, stale root/plan, duplicate workers, starvation, UNKNOWN; queue advisory/digest-bound and fail closed.
- **Decisive proof:** Two roots get restart-stable order; crash after lease does not duplicate launch; stale roots/workers fail closed; UNKNOWN/parent boundaries and run state unchanged; no ambient discovery.

## 2. Resumable release-operation envelope

- **Fact/bottleneck:** `withReleaseExclusion` scopes claims to one callback (`src/release-operation.ts:39-94`). Production composes manifest, external snapshot (30 s), quiescence, target lock, tree transaction in one invocation (`tools/deploy-skill.mjs:1493-1511,1513-1562`). Marker has only tree phases (`:19-38`); restore is separate and needs later redeploy (`docs/INSTALL.md:150-192`). Quiescence is one-shot `QUIESCENT` (`src/release-quiescence.ts:43-46`); tests prove strict closed-set/recovery, not outer receipt (`test/r11a-schema-quiescence.test.js:182-255`, `test/r5b-recovery-restore.test.js:225-253`).
- **Inference/payoff:** Outer state enables audited resume after binder timeout/crash/handoff without rebuilding paths/digests (reliability claim only).
- **Smallest slice:** Private canonical `lunacy-release-operation/v2`: operation ID, manifest/owner/snapshot/quiescence digests, `prepared → snapshot-bound/quiescent → publishing → verified/committed` plus rollback/failure. Add `status`/`resume` reusing exclusion, lock, quiescence, tree transaction; host supplies snapshot. No kill/signal, ambient discovery, or legacy changes.
- **Dependencies/risks:** Release manifest/admission, quiescence, target transaction, R1/R4 receipts. Risks: second authority, stale owner/snapshot, partial transaction, manifest drift; each phase revalidates identity/owner/aggregate and fails closed.
- **Decisive proof:** Crash at binder, ownership, quiescence, tree phases, restore; same envelope resumes to exact aggregate/red, leaves no residue, preserves unowned files, rejects stale evidence, keeps legacy output byte-compatible.

## 3. Digest-bound operator decision inbox (manual authority; no auto-approval)

- **Fact/bottleneck:** `DECISION_REQUIRED` token/brief appears only in one `Yield` (`src/public.ts:94-108`); Workfront attention is code/step and omits refs/receipts/journal (`src/workfront.ts:10-18`, `docs/WORKFRONT.md:18-22`). Parent submits one exact `PARENT_DECISION` (`docs/API.md:11-25,64-71`; `src/public.ts:151-166`); tests cover manual gate/adoption but no durable cross-run listing (`test/p3-cross-phase-authority.test.js:83-99`).
- **Inference/payoff:** Inbox makes fail-closed stops auditable/low-touch: humans discover/claim/resolve without polling every run; digest/epoch fencing blocks stale choices. Automatic approval excluded.
- **Smallest slice:** Private read-only `decisions` projection over explicit run/manifest lists unconsumed GATE/AUTHORITY_ADOPTION tokens (token, brief digest, expected plan/authority/attempt/barrier epochs, R4 `nextProof`). `submit-decision` validates token/digest/revision/epochs then emits one kernel `PARENT_DECISION`; no policy engine, Markdown authority, or dispatch.
- **Dependencies/risks:** R1 attention, R4 evidence, reducer token semantics (`src/reducer.ts:244-317`), parent boundary (`src/orchestration.ts:75-79`). Risks replay/forgery, stale epochs, brief leakage, second authority; exact binding, redaction/limits, idempotent replay, kernel-only mutation.
- **Decisive proof:** Gate PASS/FINDINGS and ADOPT roundtrips; wrong token/digest/revision/epoch fails without consume; duplicate exact replay; restart preserves token; UNKNOWN remains parent boundary; inbox never dispatches.

## Explicitly rejected smaller ideas

- Durable `AccelerationMetrics`/`BridgeCounters` are in-process/per-call and intentionally lost on restart (`docs/ACCELERATION.md:46-47`; `src/metrics.ts:1-5`; `src/bridge.ts:68-80,142-149`). Telemetry supports the above but lacks fleet demand/retention/redaction contract.
- Projection de-duplication, accelerator canary, planner/reuse extraction remain deferred on corpus/hit/policy triggers (`docs/ROADMAP.md:416-418`); optimization-only, not recovery/fleet direction.

## Control Block

- **Status:** PASS — three post-R1–R4 candidates; discovery only.
- **Scope:** This report; no product/source/test/docs changes.
- **Evidence:** Cited source/docs/tests; run authority `Lunacy/runs/next-big-wins-v2/{PLAN.md,phases/p1/STEPS.md}`.
- **Rejected:** R1–R4 repeats, automatic approval, ambient discovery, telemetry/optimization-only work.
- **Verification:** Python check confirmed ≤60 lines/6 KiB; `git status --short` showed only pre-existing untracked `Lunacy/` artifacts.
- **Terminal snapshot:** immutable after FINAL.
