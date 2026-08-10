# Lunacy Workspace

This file defines the durable run format. **Read it when creating a run or recovering a damaged/ambiguous workspace; do not reread it on every resume.**

Create in the project root unless project instructions require another location:

```text
Lunacy/
  PLAN.md
  STATE.md
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

No mandatory `HANDOVER.md`: `STATE.md + PLAN.md + current STEPS.md` are the resume packet. Avoid duplicate sources of truth.

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

## STATE.md

Smallest current source of truth. Keep it extremely short.

```markdown
# Lunacy State
Status: ACTIVE | BLOCKED | COMPLETE
Plan revision: <hash/date/version if useful>
Phase: <id/name>
Step: <id | NONE>
Gate: NOT-DUE | DUE | PASS | FINDINGS
Active worker/report: <id/path | NONE>
Blocked: <NONE | concise reason>
Latest gate: <path | NONE>
Next action: <one exact action, including relevant path/id>
Updated: <timestamp>
```

State describes reality, not intention. Update before worker launch and after material worker completion, decision, adversarial review, repair, gate, phase transition, blocker, or plan change.

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
```

Statuses: `READY`, `ACTIVE`, `NEEDS-DECISION`, `REPAIR`, `DONE`, `BLOCKED`, `SUPERSEDED`.

`DONE` means the step worker completed its own implementation/self-review/verification loop. The phase is not accepted until its hard gate passes.

One step normally maps to one implementation Luna/max worker. Replan when real facts justify it; preserve project intent and phase goals, not a bad initial split.

## Worker handoff

Default to a **path-based handoff**, not a rewritten task specification. Normally the parent only needs to tell the worker:

```text
Own <step-id> end-to-end.
Authority: Lunacy/PLAN.md + applicable project instructions.
Step contract: Lunacy/phases/<phase>/STEPS.md (<step-id> row).
Report: <report-path>.
Inspect affected callers/surfaces first; then implement → verify → self-review → fix → reverify.
No intermediate progress messages unless BLOCKED or NEEDS-DECISION. Write the final Control Block/report and finalize immediately.
```

Inline only exceptions or facts not already durable. This keeps repeated parent output small even across many steps.

### Worker surface inventory

Before editing, the worker should identify the callers, sibling paths, integration surfaces, and externally observable behavior plausibly affected by the step. This inventory belongs to the **worker**, not the orchestrator. During self-review, the worker revisits it and verifies that no affected caller/surface was missed.

The inventory need not become a separate artifact. Include only consequential coverage/evidence in the report Detail when useful to a later adversary or gate scout.

### Worker communication contract

Normal workers are deliberately quiet:

- no progress narration or routine mailbox messages;
- message the orchestrator only for `BLOCKED` or `NEEDS-DECISION` conditions that cannot be resolved from project authority/evidence;
- normal completion is the durable report plus one final completion signal;
- after the final Control Block/report is written, **finalize immediately**—no post-completion polishing/status chatter unless specifically requested.

This keeps a long-running worker from repeatedly waking the expensive orchestrator for information that does not change its next action.

## Waiting for workers

Prefer host-native **event-driven or blocking completion waits** when available. Avoid short fixed-timeout polling loops merely to learn that a worker is still running.

If the host only exposes polling/timeouts, use the coarsest practical cadence consistent with host/user constraints. An unchanged timeout should not trigger repository inspection, report rereads, or status reconstruction. If the host requires periodic visible updates, emit the shortest useful heartbeat and return to waiting.

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

The adversary reviews actual code/effects, not implementer reasoning. It may fix in-scope defects itself and reverify them.

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

## Interrupted active step

On resume, if `STATE.md`/`STEPS.md` says a step is `ACTIVE`:

1. read only its report Control Block if present;
2. if it records a completed PASS/decision/blocker, reconcile state from that result;
3. otherwise treat the prior attempt as interrupted—do not make the parent inspect partial implementation;
4. create a new attempt/report path and spawn a fresh Luna/max continuation worker for the same step against the **current repository state**;
5. tell that worker to inspect existing partial changes, keep/fix/rework them as appropriate, and finish the normal full step loop.

This makes interruption recovery a worker problem, not an orchestrator context sink.

## Resume contract

A fresh orchestrator reads only:

1. applicable project-level instructions;
2. `Lunacy/STATE.md`;
3. `Lunacy/PLAN.md`;
4. current phase `STEPS.md`;
5. only the artifact explicitly required by `Next action`.

Then execute `Next action`.

Do not reread this `WORKSPACE.md`, old worker reports, historical decisions, previous gates, or worker conversations unless recovery/current evidence specifically requires them.
