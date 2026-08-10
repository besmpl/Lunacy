# Lunacy Workspace

This file defines the durable run format. **Read it when creating a run or recovering a damaged/ambiguous workspace; do not reread it on every resume.**

Create in the project root unless project instructions require another location:

```text
Lunacy/
  PLAN.md
  STATE.md
  USER_NOTES.md
  DECISIONS.md
  intake.md                  # optional, large-authority scout only
  phases/
    <phase-id>/
      STEPS.md
      reports/
        <step-id>-worker-01.md
        <step-id>-adversary-01.md
      gate-pack-01.md        # optional for tiny phases; normal for nontrivial phases
      hard-gate-01.md
```

No mandatory `HANDOVER.md`: `STATE.md + PLAN.md + USER_NOTES.md + current STEPS.md` are the fresh-session resume packet. Avoid duplicate sources of truth.

## PLAN.md

Compact durable understanding of what is being built and why. Target **well under ~800 words** unless project complexity genuinely requires more.

```markdown
# Lunacy Execution Plan

## Authority
Goal: <desired outcome>
Plan/task: <path/source>
Project rules: <paths>
Architecture/design authority: <paths>

## Ethos / core principles
- <high-leverage principle> — source: <path/section>
- ...

## Non-negotiable contracts
- <architecture/behavior/compatibility constraint> — source: <path/section>

## Phases / gates
P1 — <milestone> | steps: S1,S2,S3 | gate: <what must be true>
P2 — ...
Optional adversaries: <step ids or NONE>
Final gate: <whole-task completion standard>
```

Ethos/principles are decision authority, not decoration. Keep only durable, high-leverage principles. Source pointers let the orchestrator spot-check omitted detail without rereading entire documents.

For very large plan/architecture sets, an intake Luna/max scout may draft `intake.md` with a concise cited authority map. The orchestrator reviews it, spot-checks important sources, and writes/approves `PLAN.md`. `intake.md` is not normally reread after planning.

## USER_NOTES.md

Tiny durable memory for **user-originated** project/run information that should survive context loss: constraints, preferences, corrections, additional requests, reminders, and intentionally deferred/future items.

```markdown
# Lunacy User Notes

## Current
- <concise user-originated constraint/request/preference>

## Deferred / future
- <item explicitly not part of current execution, if any>
```

Keep this file current, not chronological:

- update or replace bullets when the user changes a requirement;
- remove superseded/no-longer-relevant items rather than preserving chat history;
- move deliberately postponed items to `Deferred / future`;
- do **not** store worker progress, implementation status, evidence, orchestrator decisions, or conversation transcripts here;
- keep wording concise and faithful to the user's intent rather than expanding it into speculative requirements.

`USER_NOTES.md` is memory, **not execution authority**. When a user note affects the active goal, contracts, acceptance criteria, scope, dependencies, sequencing, or next action, immediately update `PLAN.md`, `STATE.md`, `STEPS.md`, and/or `DECISIONS.md` as appropriate. Do not leave an execution-critical requirement only in notes.

Read/evaluate it:

1. during initial run setup;
2. whenever the user adds, corrects, or defers something material;
3. on a fresh/restarted orchestrator session or known context compaction/loss;
4. at the final gate.

Do **not** reread it for every normal step/batch in uninterrupted context.

## STATE.md

Smallest current source of truth. Keep it extremely short. It must also survive interruption while several independent workers are active.

```markdown
# Lunacy State
Status: ACTIVE | BLOCKED | COMPLETE
Plan revision: <hash/date/version if useful>
Phase: <id/name>
Step(s): <comma-separated active ids | NONE>
Gate: NOT-DUE | DUE | PASS | FINDINGS
Active workers/reports: <worker-id:report-path; ... | NONE>
Blocked: <NONE | concise reason>
Latest gate: <path | NONE>
Next action: <one exact action, including relevant ids/paths>
Updated: <timestamp>
```

State describes reality, not intention. Update before worker launch and after material worker completion, decision, adversarial review, repair, gate, phase transition, blocker, or plan change.

When a concurrent batch is active, `Step(s)` and `Active workers/reports` list the whole in-flight set. `Next action` should normally be one batch-level action such as `wait for S2,S4,S5; then reconcile their Control Blocks`, not separate wakeup instructions per worker.

The exact `Next action` is the main resume primitive. If a Codex compatibility change requires restart, persist that fact and the exact worker/step to retry after restart before telling the user to relaunch.

## phases/<phase>/STEPS.md

Compact phase-local control table:

```markdown
# P1 Steps
Goal: <integrated outcome>
Gate: <phase-end standard>

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S1 | ... | - | NO | DONE | reports/S1-worker-01.md |
| S2 | ... | S1 | YES | ACTIVE | reports/S2-worker-01.md |
| S3 | ... | S1 | NO | ACTIVE | reports/S3-worker-01.md |
```

Statuses: `READY`, `ACTIVE`, `NEEDS-DECISION`, `REPAIR`, `DONE`, `BLOCKED`, `SUPERSEDED`.

`DONE` means the step worker completed its own implementation/self-review/verification loop. The phase is not accepted until its hard gate passes.

One step normally maps to one implementation Luna/max worker. Replan when real facts justify it; preserve project intent and phase goals, not a bad initial split.

## Concurrent scheduling

`STEPS.md` is the scheduling graph; do not add a separate durable batch-plan file unless the project genuinely needs one.

At each scheduling point:

1. find `READY` steps whose declared dependencies are all `DONE`;
2. from those, choose the **largest safe concurrent set** up to host worker capacity;
3. persist all selected steps/workers as active in `STATE.md` before launch;
4. launch one Luna/max owner per selected step;
5. wait at batch level when the host allows it;
6. when the batch settles, read each Control Block and reconcile state once before scheduling more work.

Steps are safe to run together only when there is no known dependency or unsafe interaction. **Serialize** if they are likely to:

- write the same files/objects/generated artifacts;
- alter the same shared abstraction, schema, protocol, API, or behavioral contract;
- consume one another's not-yet-durable output;
- mutate shared state that the environment cannot isolate safely;
- depend on the same unresolved architectural decision;
- create merge/integration work whose risk would outweigh the value of parallelism.

If independence is uncertain, serialize. The goal is maximum **safe** concurrency, not maximum agent count.

Do not make the parent perform repository-scale write-set discovery just to prove independence. Use the plan/step boundaries and known contracts for the scheduling decision. Each Luna performs deeper inventory inside its step. If that deeper inspection discovers unexpected overlap with another active step, it must stop before the conflicting edit and report the overlap so the orchestrator can serialize/replan.

No permanent `Batch` column is required. Concurrent batches are transient scheduling decisions represented by multiple `ACTIVE` rows plus `STATE.md`.

## Worker handoff

Default to a **path-based handoff**, not a rewritten task specification. Normally the parent only needs to tell the worker:

```text
Own <step-id> end-to-end.
Authority: Lunacy/PLAN.md + applicable project instructions.
Engineering doctrine: <lunacy-skill-root>/worker/ENGINEERING.md.
Step contract: Lunacy/phases/<phase>/STEPS.md (<step-id> row).
Report: <report-path>.
Inspect existing system/reuse points first; then implement → verify → self-review → fix → reverify.
If required work overlaps another active step, stop before the conflicting edit and report the overlap.
Stay silent unless blocked/decision-needed. Write the report, then finalize immediately.
```

Inline only exceptions or facts not already durable. The doctrine is read by Luna; do not paste or summarize it into every parent handoff.

Before editing, the worker itself should inventory relevant existing callers, sibling paths, objects/types/interfaces, helpers, tests, lifecycle/persistence boundaries, and potential reuse/extension points. Recheck that inventory during self-review. This discovery cost belongs to Luna rather than the orchestrator.

## Worker communication and waiting

Workers should emit **no intermediate progress/mailbox messages** unless they are blocked or require a genuine orchestrator decision. Ordinary progress belongs in their own working context, not parent context.

After the final Control Block/report is durable, the worker should **finalize immediately**. Do not send post-completion polish messages or continue narrating already-complete work.

The orchestrator should prefer event-driven/blocking worker completion waits when supported. For concurrent workers, prefer a batch-level wait/reconciliation cycle rather than repeated short per-worker polling. If the host forces timeout polling or visible heartbeats, use the coarsest practical cadence, keep unchanged heartbeats minimal, and do not inspect unchanged state solely because a timer fired.

## Worker report

Every worker writes its assigned report. Put a tiny **Control Block first** so the parent normally reads only that block.

```markdown
# S2 Worker Report
## Control
Status: PASS | NEEDS-DECISION | BLOCKED
Goal/result: <one line>
Changed: <paths/effect, one line>
Verification: <PASS/FAIL + key command/result, one line>
Self-review/fixes: <NONE or one line>
Principle/contract impact: <NONE or one line>
Decision needed: NO | <one precise question>
Risk/blocker: NONE | <one line>

## Detail
<optional concise evidence/source pointers useful to a later adversary/gate scout>
```

Keep the Control Block roughly **8–12 lines**. Keep Detail short and omit it when unnecessary. Never dump chain-of-thought, raw logs, or a chronological implementation narrative.

For an ordinary `PASS`, the orchestrator reads only the Control Block. Detail is read only when a decision, contradiction, review, or recovery needs it.

## Adversarial report

Fresh Luna/max adversaries use the same pattern:

```markdown
# S2 Adversarial Review
## Control
Status: PASS | FIXED | NEEDS-DECISION | BLOCKED
Scope/result: <one line>
Findings: NONE | <one line>
Fixes: NONE | <one line>
Verification: <one line>
Decision needed: NO | <question>
Remaining risk: NONE | <one line>

## Detail
<optional evidence pointers>
```

The adversary reviews actual code/effects, not implementer reasoning. It follows the same engineering doctrine, including searching for duplicated mechanisms, missed reuse/extension opportunities, weak abstractions, and incomplete caller/surface coverage. It may fix in-scope defects itself and reverify them.

## Gate pack

For a nontrivial phase, a fresh Luna/max gate scout writes `gate-pack-NN.md` before the parent hard gate. Its purpose is **compression and navigation, not approval**.

Keep the parent-facing section about 15–25 lines:

```markdown
# P1 Gate Pack 01
Phase goal/result: <one line>
Changed surfaces: <compact paths/modules>
Cross-step integration: <interfaces/data flows touched>
Verification: <key status/commands>
Highest risks/uncertainties:
- <risk>
Parent inspection targets:
1. <exact file:symbol/diff region> — <why>
2. <...>
Suggested gate checks:
- <command/behavior>
Scout verdict: NOT APPLICABLE — parent owns gate
```

The scout may include short detail below when useful, but it must not flood the parent with a rewritten diff. It should identify the smallest set of actual artifacts that best tests the phase's architecture, ethos, integration, and risk.

## DECISIONS.md

Append only consequential orchestrator decisions:

```markdown
## D-003 — <title>
Context: <hard ambiguity/problem>
Authority: <relevant ethos/plan/contracts>
Decision: <choice>
Basis: <key evidence, concise>
Impact: <phases/steps/contracts>
```

Do not reread this ledger on resume. `STATE.md`/`PLAN.md` should absorb active consequences; read a historical entry only when explicitly relevant.

## Hard-gate record

At each required phase end:

```markdown
# P1 Hard Gate 01
Goal/principles checked: <compact list>
Actual state inspected: <paths/diff regions/behaviors>
Verification used: <checks>
Findings: NONE | <concise findings>
Disposition: PASS | REPAIR REQUIRED
Repair steps: <ids or NONE>
```

This records the parent's judgment; it does not need to reproduce the gate scout or worker reports.

## Interrupted active step(s)

On resume, if `STATE.md`/`STEPS.md` shows one or more `ACTIVE` steps:

1. read only each active attempt's report Control Block if present;
2. reconcile attempts that already recorded PASS/decision/blocker;
3. treat each remaining attempt as interrupted—do not make the parent inspect partial implementation;
4. account for partial-write/overlap risk before deciding which interrupted steps are still safe to recover concurrently;
5. create new attempt/report paths and launch fresh Luna/max continuation workers for the same steps against the **current repository state**;
6. each continuation worker inspects existing partial changes, keeps/fixes/reworks them as appropriate, and finishes the normal full step loop.

This makes interruption recovery a worker problem, not an orchestrator context sink, while avoiding blindly recreating a batch whose partial writes may no longer be independent.

## Resume contract

A fresh/restarted orchestrator or one recovering from known context compaction/loss reads only:

1. applicable project-level instructions;
2. `Lunacy/STATE.md`;
3. `Lunacy/PLAN.md`;
4. `Lunacy/USER_NOTES.md`;
5. current phase `STEPS.md`;
6. only the artifact(s) explicitly required by `Next action`.

Then execute `Next action`.

Do not reread this `WORKSPACE.md`, old worker reports, historical decisions, previous gates, or worker conversations unless recovery/current evidence specifically requires them.
