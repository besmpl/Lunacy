# Luna Maxing Workspace

Use a **small durable workspace** so the orchestrator can minimize token use, survive interruption/context replacement, and resume from compact facts instead of worker chats.

Create it in the project root unless project instructions require another location:

```text
LunaMaxing/
  PLAN.md
  STATE.md
  DECISIONS.md
  HANDOVER.md
  phases/
    <phase-id>/
      STEPS.md
      reports/
        <step-id>-worker-01.md
        <step-id>-adversary-01.md
      hard-gate-01.md
```

Do not create additional orchestration files unless they materially improve continuity or the project requires them.

## PLAN.md

This is the orchestrator's compact durable understanding of **what is being built and why**. It prevents repeated rereading of large plans/architecture docs.

Keep it concise:

```markdown
# Luna Maxing Execution Plan

## Authority
- User goal: <concise desired outcome>
- Authoritative plan/task: <path/source>
- Project instructions: <paths>
- Architecture/design authority: <paths>

## Project ethos and core principles
- <principle that should drive engineering decisions>
- <principle>

## Non-negotiable contracts
- <architecture/behavior/compatibility constraint>

## Execution
### Phase P1 — <integrated milestone>
Goal: <phase outcome>
Steps: S1, S2, S3
Hard gate: <what the orchestrator must establish at phase end>
Optional adversarial reviews: <step ids or NONE>

### Phase P2 — ...
...

## Final gate
<whole-task completion standard>
```

The ethos/principles section is **decision authority**, not decoration. Keep only durable, high-leverage principles. When the plan changes materially, update this file and record why in `DECISIONS.md`.

## STATE.md

This is the smallest current source of truth. It describes reality, not intention.

```markdown
# Luna Maxing State

Status: ACTIVE | BLOCKED | COMPLETE
Plan revision: <hash/date/version when useful>
Current phase: <id/name>
Current step: <id | NONE>

Phase status:
- COMPLETE: <ids>
- ACTIVE: <id>
- READY: <ids>

Step status:
- COMPLETE: <ids>
- ACTIVE: <id + worker/report path>
- READY: <ids>
- BLOCKED: <ids + reason>

Hard gate: NOT-DUE | DUE | PASS | FINDINGS
Latest gate: <path or NONE>
Next action: <one exact action>
Last updated: <timestamp>
```

Update before a worker launch and after every material worker result, adversarial review, hard decision, repair, hard gate, phase transition, blocker, or plan change.

Always persist **one exact `Next action`** so a fresh orchestrator need not reason about what to do merely to resume.

## phases/<phase>/STEPS.md

Keep the phase decomposition compact:

```markdown
# P1 Steps

Phase goal: <integrated outcome>
Hard gate: <phase-end review goal>

| Step | Goal | Depends on | Adversary | Status | Report |
|---|---|---|---|---|---|
| S1 | ... | - | NO | COMPLETE | reports/S1-worker-01.md |
| S2 | ... | S1 | YES | ACTIVE | reports/S2-worker-01.md |
```

Allowed step statuses: `READY`, `ACTIVE`, `NEEDS-DECISION`, `REPAIR`, `COMPLETE`, `BLOCKED`, `SUPERSEDED`.

One step normally maps to one implementation Luna/max worker. A repair caused by an adversarial review or phase gate may be a new repair step or an explicit new attempt under the affected step.

The orchestrator may revise steps when implementation facts reveal a better decomposition. Preserve the phase goal and project ethos; do not preserve a bad step breakdown merely because it was initially written.

## Worker reports

Every implementation worker writes directly to its assigned report path. This is the orchestrator's normal interface to completed step work.

Keep reports terse, normally **<=25 lines**:

```markdown
# <step-id> Worker Report
Status: PASS | NEEDS-DECISION | BLOCKED
Goal: <one sentence>

Changed:
- <paths + effect, compactly>

Verification:
- <check>: PASS|FAIL — <meaningful result>

Self-review/fixes:
- <important issue found/fixed, or NONE>

Principle/contract impact:
- <only consequential ethos/architecture effect, or NONE>

Risks/blockers: NONE
Orchestrator decision needed: NO
```

When a hard decision is truly needed:

```markdown
Orchestrator decision needed: YES
Question: <one precise question>
Evidence: <minimal paths/facts>
Options/tradeoff: <compact alternatives if useful>
```

No chain-of-thought, full logs, or long implementation narrative.

## Adversarial review reports

A fresh Luna/max adversary writes `reports/<step>-adversary-NN.md`.

Keep it similarly concise:

```markdown
# <step-id> Adversarial Review
Status: PASS | FIXED | NEEDS-DECISION | BLOCKED
Scope reviewed: <paths/effect>
Findings: NONE | <concise defects>
Fixes made: NONE | <concise fixes>
Verification: <checks/results>
Remaining risk/blocker: NONE | <item>
```

The adversary reviews actual code/effects, not the implementer's reasoning. If it finds in-scope defects it may repair and reverify them itself; broader design ambiguity is escalated to the orchestrator.

## DECISIONS.md

Use this only for consequential orchestrator decisions—not ordinary implementation choices.

```markdown
## D-003 — <title>
Context: <hard ambiguity/problem>
Principles/authority: <relevant ethos/plan/contracts>
Decision: <choice>
Basis: <key evidence/reasoning, concise>
Impact: <phases/steps/contracts affected>
```

This is where the orchestrator's expensive reasoning becomes durable and reusable.

## Phase hard-gate records

At each planned phase end, write `hard-gate-NN.md`:

```markdown
# Phase <id> Hard Gate NN
Phase goal: <goal>
Principles/contracts checked: <compact list>
Integrated diff/state reviewed: <baseline..current or paths>
Verification: <checks actually used>
Findings: NONE | <concise findings>
Disposition: PASS | REPAIR REQUIRED
Repair steps: <ids or NONE>
```

The gate judges integrated **current state and effects**, not worker confidence.

## HANDOVER.md

This is a compact resume packet, not another progress log. Update at phase boundaries, consequential decisions, blockers, plan/gate changes, and before session/context replacement.

Contain only:

- authoritative task/plan;
- compact project ethos/core principles or pointer to `PLAN.md`;
- current phase and step;
- completed/active/blocking work;
- consequential decisions/architecture facts;
- latest hard-gate disposition;
- **exact next action**;
- paths to `PLAN.md`, `STATE.md`, current `STEPS.md`, and only immediately relevant reports/decisions.

## Resume contract

A fresh orchestrator resumes in this order:

1. read applicable project-level instructions (`AGENTS.md`, etc.);
2. read `LunaMaxing/HANDOVER.md`;
3. read `LunaMaxing/STATE.md`;
4. read `LunaMaxing/PLAN.md`;
5. read current phase `STEPS.md`;
6. read only the report/decision/gate files needed for the persisted `Next action`;
7. execute that next action.

Do **not** replay worker conversations, reread all historical reports, or broadly resurvey the repository unless current evidence shows the durable state is stale or wrong.
