# S2 Worker Report — orchestration/operator experience

## Control
- **Status:** PASS (read-only scout; no product/source/test/docs edits).
- **Goal/result:** Trace manual lifecycle seams and rank three automation directions that reuse the current kernel/bridge authority.
- **Changed:** This immutable report only.
- **Verification:** Evidence slices were re-read; report is 38 lines / within the worker size limit.
- **Self-review/fixes:** Removed unsupported claims; recommendations label inference and name proof.
- **Principle/contract impact:** NONE; discovery only. **Decision needed:** NO. **Risk/blocker:** NONE.

## Facts: where the operator is still manual
1. **Create/bind run:** The layout is filesystem-only; there is no registry, lock DB, scheduler, or `CURRENT_RUN` (WORKSPACE.md:8-31). New run IDs, plan/STATE/STEPS scaffolding, and explicit runtime-vs-markdown mode are caller/parent work (SKILL.md:116-127; docs/BRIDGE.md:12-31). One-event CLI requires run-dir, run-id, event/event-id, and plan (src/bridge-cli.ts:145-176).
2. **Schedule/admit/spawn:** The parent forms maximal safe batches, resolves exact Luna/Sol routes, records Sol bindings, calls `agents.spawn_agent`, then reconciles reports and schedules the next batch (SKILL.md:54-84,133-152). Kernel admission is deterministic (`reduce`/`updateAdmission`, src/reducer.ts:211-240), but it does not call host agents.
3. **Wait/dispatch:** `BridgeDrivePump` is an ephemeral mechanical loop with no scheduler state (src/orchestration.ts:103-107); it waits one-token notifications/terminals and performs one bounded UNKNOWN observation after restart (src/orchestration.ts:175-215,438-459). Parent quiescent wait remains explicit (`wait_agent`, SKILL.md:96-104).
4. **Decide/gate/adopt/complete:** Finished work closes the barrier and issues a one-shot GATE token (src/reducer.ts:235-240); only parent `PASS`/`FINDINGS` decisions complete or reopen an attempt (src/reducer.ts:244-266). Live-plan drift emits a digest-bound `DECISION_REQUIRED`; adoption requires old work quiescence and parent acknowledgement (src/public.ts:469-531; docs/API.md:64-71). The bridge removes only repetitive looping; approval, stop/redirect, gate, adoption, and final result stay parent-authoritative (docs/INSTALL.md:194-207).
5. **Inference:** Toil is invocation/coordination around a sound event kernel, not missing authority. Automation must preserve manual mode, one-shot tokens, epoch/digest fences, and fail-closed recovery.

## Ranked directions (at most three)
### 1. Per-run lifecycle controller (`init` + `run`/`resume`)
- **Evidence/fit (fact):** Existing `transition` validates/canonicalizes START and owns CURRENT/revision/epoch fences (src/public.ts:400-426,451-468); `drive` already chains kernel calls and stops at parent boundaries (docs/BRIDGE.md:50-81; test/orchestration.test.js:18-35).
- **Smallest coherent outcome (inference):** One explicit run-root/run-id/plan/policy command scaffolds metadata, performs idempotent START/resume, invokes the pump, and returns compact status/attention.
- **Safety boundary:** Reuse bridge lock/CURRENT and driver policy; never parse Markdown, synthesize plans, auto-adopt, close gates, or bypass `HumanReceiptRequired`.
- **Compatibility/recovery risk:** Keep one-event/manual CLI; digest/root mismatch, restart UNKNOWN, or projection failure returns existing conflict/parent-boundary (no retry). 
- **Decisive proof:** Test init→dependent two-step drive, duplicate START replay, restart UNKNOWN observe/no relaunch, invalid-plan/no-driver fail-closed, and phase-ready stop.

### 2. Explicit multi-run scheduler/queue over per-run pumps
- **Evidence/fit (fact):** No global scheduler/registry exists by contract (WORKSPACE.md:29); Workfront already gives a bounded, read-only active/eligible/blocked/attention capsule (docs/WORKFRONT.md:1-6,18-32; src/workfront.ts:116-150), while each pump is independently restartable (src/orchestration.ts:103-107).
- **Smallest coherent outcome (inference):** Host queue accepts explicit run roots, orders one pump turn per run deterministically, and emits deduplicated attention/terminal events; queue is ephemeral.
- **Safety boundary:** No ambient discovery or authority; each turn revalidates CURRENT/lock, dispatches kernel-authorized commands, and stops at parent boundaries.
- **Compatibility/recovery risk:** Lock ordering, starvation, duplicate pumps, renamed roots, or crashes can strand cursors; restart discards cursors and rebuilds from Workfront/CURRENT, with no global file.
- **Decisive proof:** Test 2+ roots for deterministic ordering/at-most-once launch (test/orchestration.test.js:151-170), crash/restart attention recovery, no inspection writes, and stale-root races fail closed.

### 3. Digest-bound decision inbox/approval surface
- **Evidence/fit (fact):** Kernel already emits structured `DECISION_REQUIRED`/GATE yields and one-shot token records; reducer validates PASS/FINDINGS and adoption digest/epochs (src/reducer.ts:244-306; src/public.ts:504-531). Workfront intentionally exposes stable attention signals without sensitive refs/paths (docs/WORKFRONT.md:18-48).
- **Smallest coherent outcome (inference):** `decisions` renders canonical briefs for gate/findings/adoption tokens, validates revision/epochs, and submits only explicit parent choices; any allow-list is opt-in.
- **Safety boundary:** Require exact token/digest/epoch and old-work quiescence; append only supported `PARENT_DECISION`; never infer Markdown/prose or mutate immutable reports.
- **Compatibility/recovery risk:** Preserve manual decision API; stale/malformed tokens remain `DECISION_REQUIRED`; crash/replay by identity must not double-consume.
- **Decisive proof:** Test PASS/FINDINGS and ADOPT round trips, wrong-token/digest/revision rejection without consumption, crash/replay idempotence, and unchanged immutable snapshots.
