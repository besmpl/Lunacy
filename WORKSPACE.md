# Luna Maxing Workspace

This file defines the durable run format. **Read it when creating a run or recovering a damaged/ambiguous workspace; do not reread it on every resume.**

Create in the project root unless project instructions require another location:

```text
LunaMaxing/
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
# Luna Maxing Execution Plan

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
# Luna Maxing State
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

The exact `Next action` is the main resume primitive.

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

## Resume contract

A fresh orchestrator reads only:

1. applicable project-level instructions;
2. `LunaMaxing/STATE.md`;
3. `LunaMaxing/PLAN.md`;
4. current phase `STEPS.md`;
5. only the artifact explicitly required by `Next action`.

Then execute `Next action`.

Do not reread this `WORKSPACE.md`, old worker reports, historical decisions, previous gates, or worker conversations unless recovery/current evidence specifically requires them.
