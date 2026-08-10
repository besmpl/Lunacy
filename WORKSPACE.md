# Lunacy Workspace

This file defines the durable run format. **Read it when creating a run or recovering damaged/ambiguous state; do not reread it on every normal resume.**

## Project / run layout

A project may contain multiple independent Lunacy plans/runs:

```text
Lunacy/
  PROJECT_NOTES.md                 # optional project-wide user notes
  runs/
    <run-id>/
      PLAN.md
      STATE.md
      USER_NOTES.md                # optional run-specific user notes
      DECISIONS.md
      intake.md                    # optional, large-authority scout only
      phases/
        <phase-id>/
          STEPS.md
          reports/
            <step-id>-worker-01.md
            <step-id>-adversary-01.md
          gate-pack-01.md
          hard-gate-01.md
```

`<run-id>` is a short semantic slug such as `auth-refactor` or `generation-pipeline`. If the user supplies a useful name, preserve it; otherwise generate a concise unique slug.

There is intentionally **no global run registry, scheduler, lock database, or `CURRENT_RUN` pointer**. The `runs/` directories and their tiny `STATE.md` files are the registry.

No mandatory `HANDOVER.md`: the active run's `STATE.md + PLAN.md + current STEPS.md`, plus user notes when required, are the resume packet.

### Legacy single-run layout

If an older workspace has `Lunacy/PLAN.md`, `STATE.md`, `phases/`, etc. directly under `Lunacy/`, treat it as one legacy run. On the first setup/material write under the new format, move those run-specific durable files into one `Lunacy/runs/<run-id>/` directory and stop using the root copies as authority. An existing root `USER_NOTES.md` belongs to that legacy run unless its content is explicitly project-wide.

Do not maintain old and new copies in parallel.

## PROJECT_NOTES.md and USER_NOTES.md

These files preserve **user-originated memory**, not workflow history.

- `Lunacy/PROJECT_NOTES.md`: constraints, preferences, corrections, or future requests that apply across Lunacy runs in this project.
- `Lunacy/runs/<run-id>/USER_NOTES.md`: user notes that apply only to that run/plan.

Keep both tiny and current:

```markdown
# Project Notes   # or: # Run User Notes

## Current
- <active user requirement/preference>

## Deferred / future
- <explicitly deferred user request>
```

Do not store worker progress, report history, implementation logs, or orchestrator decisions here. Replace/remove superseded notes rather than accumulating chronology.

When the user adds or changes a material requirement, **evaluate it immediately**. Update project/run notes at the appropriate scope, then update `PLAN.md`, `STATE.md`, `STEPS.md`, or `DECISIONS.md` too when execution authority/state actually changed. Notes are durable memory, not a second source of execution truth.

Read relevant notes:

- when creating a run;
- on a fresh/restarted orchestrator session;
- after known context compaction/loss;
- immediately when the user adds/changes a requirement;
- at the final gate.

Do not reread them on every ordinary worker/batch cycle.

If concurrent sessions update `PROJECT_NOTES.md`, refresh/merge the current file before writing so one session does not silently erase another user's project-wide note.

## PLAN.md

Compact durable understanding of what this run is building and why. Target **well under ~800 words** unless complexity genuinely requires more.

```markdown
# Lunacy Execution Plan

## Authority
Goal: <desired outcome>
Plan/task: <path/source>
Project rules: <paths>
Architecture/design authority: <paths>

## Ethos / core principles
- <high-leverage principle> — source: <path/section>

## Non-negotiable contracts
- <constraint> — source: <path/section>

## Phases / gates
P1 — <milestone> | steps: S1,S2,S3 | gate: <standard>
P2 — ...
Optional adversaries: <step ids or NONE>
Final gate: <whole-run completion standard>
```

Project principles are decision authority, not decoration. Source pointers let the orchestrator spot-check omitted detail without rereading large documents.

For very large authority sets, a Luna/max intake scout may draft `intake.md`; the orchestrator reviews/spot-checks it and still owns `PLAN.md`.

## STATE.md

Smallest current source of truth for one run. It must survive concurrent workers and distinguish this run from other active runs.

```markdown
# Lunacy State
Run: <run-id>
Status: ACTIVE | BLOCKED | COMPLETE
Plan revision: <hash/date/version if useful>
Workspace: <checkout/worktree/branch identifier>
Ownership: <concise subsystem/surfaces/shared contracts this run may change>
Phase: <id/name>
Step(s): <comma-separated active ids | NONE>
Gate: NOT-DUE | DUE | PASS | FINDINGS
Active workers/reports: <worker-id:report-path; ... | NONE>
Blocked: <NONE | concise reason>
Latest gate: <path | NONE>
Next action: <one exact action, with ids/paths>
Updated: <timestamp>
```

`Ownership` is intentionally concise. It is a scheduling/conflict signal, not a full file manifest. Update it when material replanning changes the run boundary.

When a worker batch is active, list the whole in-flight set. `Next action` should normally be batch-level, e.g. `wait for S2,S4,S5; then reconcile their Control Blocks`.

## Multiple active runs

Separate metadata directories prevent Lunacy-state collisions, but they do **not** by themselves make repository writes safe.

Before implementation of a new run, and after material replanning changes its ownership, inspect only the tiny `STATE.md` files of other `ACTIVE` runs. Compare `Workspace` and `Ownership`.

Prefer concurrent runs when their outcomes/surfaces/contracts are genuinely independent. Prefer isolated worktrees/branches when the host supports them.

Serialize or explicitly coordinate/replan when active runs:

- own overlapping repository surfaces;
- change the same schema/protocol/API/abstraction/shared contract;
- depend on one another's not-yet-integrated output;
- share generated artifacts or mutable state that cannot be isolated safely;
- use the same checkout in a way that risks write/index/branch races;
- create likely merge/integration cost larger than the concurrency benefit.

Isolation removes direct write races; it does **not** make semantically overlapping architecture changes independent.

Do not make the parent perform repository-scale conflict discovery. Use run ownership/plan boundaries for the cheap preflight; Luna workers validate deeper assumptions during their own inspection and escalate unexpected overlap before conflicting edits.

## phases/<phase>/STEPS.md

Compact phase-local dependency/control table:

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

`DONE` means the worker finished its local loop; the phase is not accepted until the hard gate passes.

A step is the largest coherent unit one Luna/max worker can safely own. Replan when facts justify it; do not micro-split merely to create more agents.

## Concurrent step scheduling

`STEPS.md` is the dependency graph; do not add a separate durable batch registry.

At each scheduling point:

1. find `READY` steps whose dependencies are `DONE`;
2. choose the largest **safe** concurrent set up to host capacity;
3. persist all selected workers/steps in this run's `STATE.md` before launch;
4. launch one Luna/max owner per step;
5. wait/reconcile at batch level when possible;
6. read each terminal Control Block once and reconcile state once.

Serialize steps likely to overlap write surfaces/shared contracts, consume sibling output, mutate unsafe shared state, depend on the same unresolved architecture decision, or create excessive integration risk.

If independence is uncertain, serialize. Maximum **safe** concurrency is the goal, not maximum agent count.

## Worker handoff

Default to a tiny path-based handoff:

```text
Own <step-id> end-to-end.
Authority: <run-root>/PLAN.md + applicable project instructions.
Engineering doctrine: <lunacy-skill-root>/worker/ENGINEERING.md.
Step contract: <run-root>/phases/<phase>/STEPS.md (<step-id> row).
Report: <report-path>.
Inspect existing system/reuse points first; then implement → verify → self-review → fix → reverify.
If required work overlaps another active step/run, stop before the conflicting edit and report it.
Stay silent unless blocked/decision-needed. Write one terminal Control Block, freeze changes, then finalize immediately.
```

`<run-root>` means `Lunacy/runs/<run-id>`.

Before editing, Luna inventories callers, sibling paths, objects/types/interfaces, helpers, tests, lifecycle/persistence boundaries, and reuse/extension points. This discovery cost belongs to Luna.

## Worker communication / terminal report

Workers emit **no intermediate mailbox/progress messages** unless blocked or needing a genuine orchestrator decision.

The Control Block's `Verification` line is the **final verification snapshot** for the exact repository state being reported:

```markdown
# S2 Worker Report
## Control
Status: PASS | NEEDS-DECISION | BLOCKED
Goal/result: <one line>
Changed: <paths/effect, one line>
Verification: <terminal PASS/FAIL command/result snapshot, one line>
Self-review/fixes: <NONE or one line>
Principle/contract impact: <NONE or one line>
Decision needed: NO | <one precise question>
Risk/blocker: NONE | <one line>

## Detail
<optional concise evidence/source pointers>
```

After writing a PASS Control Block, the worker freezes changes and finalizes immediately: no cleanup edits, polish, reruns solely to update counts, or revised post-completion summaries. If anything material changes, the prior PASS is invalid and must be reverified/reported once for the new terminal state.

The orchestrator normally reads only Control Blocks. Detail is read only for decisions, contradictions, review, recovery, or gates.

Prefer event-driven/blocking completion waits. If the host forces polling/visible heartbeats, use the coarsest practical cadence and do not reread unchanged state just because a timer fired.

## Adversarial report

Fresh Luna/max adversaries use the same terminal-report pattern:

```markdown
# S2 Adversarial Review
## Control
Status: PASS | FIXED | NEEDS-DECISION | BLOCKED
Scope/result: <one line>
Findings: NONE | <one line>
Fixes: NONE | <one line>
Verification: <terminal snapshot>
Decision needed: NO | <question>
Remaining risk: NONE | <one line>
```

They review actual code/effects, follow the engineering doctrine, may fix in-scope findings, and then reverify once for their terminal state.

## Gate pack

For a nontrivial phase, a fresh Luna/max gate scout writes `gate-pack-NN.md` as a compression/navigation aid, not an approval:

```markdown
# P1 Gate Pack 01
Phase goal/result: <one line>
Changed surfaces: <compact paths/modules>
Cross-step integration: <interfaces/data flows touched>
Verification: <key status/commands>
Highest risks/uncertainties:
- <risk>
Parent inspection targets:
1. <file:symbol/diff region> — <why>
Suggested gate checks:
- <command/behavior>
Scout verdict: NOT APPLICABLE — parent owns gate
```

## DECISIONS.md

Append only consequential orchestrator decisions:

```markdown
## D-003 — <title>
Context: <hard ambiguity/problem>
Authority: <relevant ethos/plan/contracts>
Decision: <choice>
Basis: <key evidence>
Impact: <phases/steps/contracts>
```

Do not reread the ledger on normal resume. Active consequences belong in `PLAN.md`/`STATE.md`.

## Hard-gate record

```markdown
# P1 Hard Gate 01
Goal/principles checked: <compact list>
Actual state inspected: <paths/diff regions/behaviors>
Verification used: <checks>
Findings: NONE | <concise findings>
Disposition: PASS | REPAIR REQUIRED
Repair steps: <ids or NONE>
```

## Interrupted active step(s)

On resume:

1. read only each active attempt's Control Block if present;
2. reconcile already-terminal PASS/decision/blocker attempts;
3. treat remaining attempts as interrupted rather than making the parent inspect partial implementation;
4. account for partial-write and cross-step/cross-run overlap risk;
5. create new attempt/report paths and launch fresh Luna/max continuation workers where safe;
6. each continuation worker owns inspect/adopt/fix/rework → verify → self-review → terminal report.

## Resume contract

A fresh orchestrator first resolves the run:

- if the user names a run/path, bind to it;
- for an explicitly new task/plan, create a new semantic run id rather than attaching to another active run;
- for an unspecified resume, inspect only `Lunacy/runs/*/STATE.md` and bind when the intended active run is unambiguous; if genuinely ambiguous, ask which run.

Then read only:

1. applicable project-level instructions;
2. `Lunacy/PROJECT_NOTES.md` if present;
3. `<run-root>/USER_NOTES.md` if present;
4. `<run-root>/STATE.md`;
5. `<run-root>/PLAN.md`;
6. current phase `STEPS.md`;
7. only artifact(s) required by `Next action`.

Then execute `Next action`.

Do not replay worker chats or reread old reports, historical decisions, previous gates, `WORKSPACE.md`, or `orchestrator/PLANNING.md` unless recovery/current evidence/material replanning specifically requires them.

At the final gate, reread project/run user notes and ensure each current run-relevant request is satisfied, explicitly superseded, or deliberately deferred with authority.