# Lunacy

A compact execution skill for using **Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator** while **GPT-5.6 Luna at max reasoning owns repository-heavy work**.

The main design rule is: **spend orchestrator tokens only where global judgment has leverage.**

The orchestrator understands project intent and ethos, plans work, resolves hard decisions, schedules safe parallelism, tracks user constraints, and owns phase-end hard gates. Luna/max workers inspect, implement, test, self-review, repair, and prepare concise evidence.

Both sides operate under a **complexity budget**: prefer the simplest sound design that fully satisfies the real task and existing architecture. Reuse/extend sound mechanisms before inventing new ones; use OOP/polymorphism when they model real variation; do not manufacture layers, frameworks, factories, managers, micro-steps, or future-proofing merely because they look sophisticated.

## Execution model

```text
project intent / notes
        ↓
independent Lunacy run
        ↓
compact PLAN.md
        ↓
      phases
        ↓
dependency-ready steps
   ↙       ↓       ↘
 Luna     Luna     Luna    ← concurrent when safely independent
   ↘       ↓       ↙
 terminal Control Blocks
        ↓
optional fresh Luna adversary
        ↓
fresh Luna gate scout for nontrivial phase
        ↓
orchestrator hard gate
```

A phase is an integrated milestone. A step is the **largest coherent unit** one Luna/max worker can safely own end-to-end. Lunacy deliberately avoids micro-decomposition just to create more agents.

At each scheduling point, Lunacy launches the largest safe set of dependency-ready steps up to host capacity. Work stays serialized when workers are likely to overlap writes, shared contracts, mutable state, dependencies, or unresolved architectural decisions.

Workers inspect the existing system before writing, search for safe reuse/extension points, inventory affected callers/surfaces, and own the full loop: implement → verify → self-review → fix → reverify → concise report.

## Multiple plans / sessions in one project

Lunacy supports multiple independent plans in the same repository without a global scheduler or run database:

```text
Lunacy/
  PROJECT_NOTES.md                 # project-wide user constraints/preferences
  runs/
    auth-refactor/
      PLAN.md
      STATE.md
      USER_NOTES.md
      DECISIONS.md
      phases/
        ...
    generation-pipeline/
      PLAN.md
      STATE.md
      USER_NOTES.md
      DECISIONS.md
      phases/
        ...
```

Each session binds to one `run-id`. New tasks get a short semantic slug; named resumes bind directly to the requested run. There is intentionally no `CURRENT_RUN` pointer or registry database—the run directories and their tiny state files are enough.

Each run records a concise `Workspace` and `Ownership` boundary. Before simultaneous implementation, the orchestrator compares only the tiny state files of other ACTIVE runs. Independent runs can proceed concurrently; overlapping surfaces/shared contracts or unsafe shared checkout state are serialized or isolated/replanned. Separate worktrees/branches are preferred for simultaneous runs when available.

Isolation prevents direct write races; it does not magically make overlapping architectural work independent.

Older single-run `Lunacy/PLAN.md` / `STATE.md` layouts are migrated once into a `runs/<run-id>/` directory rather than maintained as duplicate authority.

## Durable user memory

`Lunacy/PROJECT_NOTES.md` stores **project-wide** user-originated constraints/preferences/requests. Each run may also have `USER_NOTES.md` for **run-specific** notes.

These are deliberately tiny current-memory files, not chat logs. New user input is evaluated immediately; if it changes execution, the authoritative plan/state is updated too. Relevant notes are reread on fresh/restarted sessions, after context loss/compaction, and at the final gate—not on every worker cycle.

## Quiet workers and terminal reports

Workers emit no intermediate mailbox/progress messages unless blocked or requesting a real orchestrator decision.

The verification written in a PASS Control Block is the **terminal verification snapshot for the exact repository state being reported**. After writing it, the worker freezes changes and finalizes immediately: no post-PASS cleanup, polish, reruns just to update counts, or revised completion messages. If anything material changes, the prior PASS is invalid and must be reverified once for the new final state.

The orchestrator normally reads only those small Control Blocks and reconciles concurrent workers at batch level.

## Engineering discipline

Luna workers follow `worker/ENGINEERING.md`: understand before writing, search for reuse/extension, prefer clean cohesive abstractions, use polymorphism where it removes real variation/branching, prove complete migration/caller coverage, and reject ceremonial OOP or speculative machinery.

The orchestrator follows `orchestrator/PLANNING.md` when planning/materially replanning and keeps the same simplicity/reuse/OOP bias alive during execution-time decisions.

A green selected test matrix is verification evidence, **not scope authority**. Maintained callers/tests cannot be dismissed as “historical” without explicit authority.

## Phase hard gates

The parent normally reviews at phase boundaries, not after every step. A fresh Luna gate scout may compress a nontrivial phase into changed surfaces, cross-step integration, verification, risks, and exact inspection targets; the scout cannot approve the phase.

The parent then inspects targeted **actual code/diff/behavior** and judges correctness, architecture, project ethos, integration risk, user constraints, and complexity proportionality. A functionally correct phase can still fail if it introduces unjustified duplicate mechanisms, speculative abstractions, unnecessary layers, or maintenance burden.

## Durable structure

```text
Lunacy/
  PROJECT_NOTES.md                 # optional project-wide user memory
  runs/
    <run-id>/
      PLAN.md
      STATE.md
      USER_NOTES.md                # optional run-specific user memory
      DECISIONS.md
      intake.md                    # optional
      phases/
        <phase-id>/
          STEPS.md
          reports/
            <step>-worker-01.md
            <step>-adversary-01.md
          gate-pack-01.md
          hard-gate-01.md
```

There is intentionally no mandatory `HANDOVER.md`. A resumed orchestrator reads project instructions, project/run user notes, the selected run's `STATE.md`, `PLAN.md`, current `STEPS.md`, and only the artifact(s) named by `Next action`. It does not replay chats or reread all history.

## Worker invariant

Every technical subagent must use:

```text
model: gpt-5.6-luna
reasoning_effort: max
```

There is no silent fallback. The **first real worker spawn** doubles as the Luna capability check.

## Install

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/frozenpepper/Lunacy.git ~/.agents/skills/lunacy
```

## Use

```text
Use $lunacy to execute the authoritative plan at PLAN.md.
```

or:

```text
Use $lunacy for this task. Minimize parent tokens; plan phases/steps first and delegate repository-heavy work to Luna/max.
```

For an existing run, name it explicitly when useful:

```text
Use $lunacy to resume the auth-refactor run.
```

## Codex Luna compatibility

If Codex rejects Luna as a subagent because of the known cached multi-agent catalog mismatch, Lunacy reads `references/CODEX_LUNA_COMPAT.md` and applies only that narrow compatibility procedure. It never silently downgrades.

If the override is installed or changed, persist the current run/worker resume point, then **close and relaunch Codex and open a new task**. The already-open task cannot refresh its model-selection schema.

## Files

```text
SKILL.md                         Always-loaded core orchestration protocol.
orchestrator/PLANNING.md        Parent-side planning/reuse/OOP/polymorphism/YAGNI/multi-run doctrine.
WORKSPACE.md                     Durable multi-run workspace and resume contract.
worker/ENGINEERING.md            Luna-side clean-code/reuse/OOP/polymorphism/concurrency/YAGNI/terminal-report doctrine.
references/CODEX_LUNA_COMPAT.md Conditional compatibility procedure.
README.md                        Human-facing overview.
```