# Luna Maxing Workspace

Use a small durable workspace so the orchestrator can resume, reason from compact facts, and avoid carrying implementation detail in its own context.

Create it in the project root unless project instructions require another location:

```text
LunaMaxing/
  STATE.md
  DECISIONS.md
  HANDOVER.md
  phases/
    <phase-id>/
      TASKS.md
      reports/
        <task-id>-01.md
        <task-id>-02.md
      hard-review-01.md
```

Do not create more files unless they materially improve continuity or are required by the project/plan.

## STATE.md

This is the current source of truth. Keep it short and overwrite/update it as reality changes.

```markdown
# Luna Maxing State

Plan/task: <authoritative path or concise request>
Plan hash/revision: <when available>
Current phase: <id/name>
Status: ACTIVE | BLOCKED | COMPLETE

## Work
- ACCEPTED: <ids>
- ACTIVE: <ids + worker/report path>
- READY: <ids>
- BLOCKED: <ids + reason>

Hard review: NOT-DUE | DUE | PASS | FINDINGS
Next action: <one exact action>
Last updated: <timestamp>
```

Update it before launching work and after every material worker result, decision, hard review, phase transition, blocker, or plan change. State describes reality, not intention.

## phases/<phase>/TASKS.md

The orchestrator keeps a compact decomposition table:

```markdown
| ID | Goal | Depends on | Status | Worker/report |
|---|---|---|---|---|
| T1 | ... | - | ACCEPTED | reports/T1-01.md |
```

Use the largest coherent units that a Luna/max worker can own end-to-end. Split only when dependency, write collision, independent acceptance, or excessive scope makes that useful.

Allowed statuses: `READY`, `ACTIVE`, `NEEDS-DECISION`, `REPAIR`, `ACCEPTED`, `BLOCKED`, `SUPERSEDED`.

## Worker reports

Every worker writes its report directly to the assigned report path. The report is the orchestrator's normal interface to completed worker work; do not make the parent consume worker transcripts.

Keep reports concise, normally <=30 lines:

```markdown
# <task-id> Worker Report

Status: PASS | NEEDS-DECISION | BLOCKED
Goal: <one sentence>

Changed:
- <paths / concise effect>

Verification:
- <command/check>: PASS|FAIL — <meaningful result>

Self-review:
- <what was reviewed and fixes made after first implementation>

Decisions/assumptions:
- <only consequential items>

Risks/blockers:
- NONE

Orchestrator decision needed: NO
```

If a hard decision is needed, use:

```markdown
Orchestrator decision needed: YES
Question: <one precise question>
Evidence: <minimal paths/facts needed>
Options/tradeoff: <compact alternatives if useful>
```

Workers must not dump chain-of-thought, full logs, or long narratives into reports. Put large generated evidence elsewhere only when genuinely required, and reference its path.

## DECISIONS.md

This is for **hard orchestrator decisions only**, not ordinary implementation choices.

Append compact entries:

```markdown
## D-003 — <title>
Context: <problem/ambiguity>
Decision: <what the orchestrator chose>
Basis: <plan/project authority + key evidence>
Impact: <tasks/contracts affected>
```

Use it when the orchestrator's stronger reasoning materially resolves architectural ambiguity, conflicting evidence, plan interpretation, integration strategy, scope changes, or a hard-review disposition.

## Hard-review files

When the orchestrator performs a hard review, write a short durable record at `hard-review-NN.md`:

```markdown
# Hard Review NN
Scope: <phase/task boundary>
Goal checked: <plan/task goal>
Diff/state reviewed: <baseline..current or paths>
Verification: <checks actually used>
Findings: NONE | <concise findings>
Disposition: PASS | REPAIR REQUIRED
Repair tasks: <ids or NONE>
```

The hard review is based on the actual repository state and effects, not worker explanations.

## HANDOVER.md

Keep a compact resume packet, not a second progress log. Update it at phase boundaries, significant decisions, blockers, plan changes, and before context/session replacement.

It should contain only:

- authoritative plan/task and current revision;
- current phase and accepted work;
- active/blocking work;
- consequential decisions/architecture facts;
- latest hard-review disposition;
- exact next action;
- paths to `STATE.md`, current `TASKS.md`, and relevant reports/decisions.

On resume, read `HANDOVER.md`, `STATE.md`, current `TASKS.md`, and the authoritative plan/project instructions. Do not reconstruct history from worker chats.
