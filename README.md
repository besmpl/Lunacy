# Lunacy

A compact execution skill for using **Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator** while **GPT-5.6 Luna at max reasoning owns repository-heavy work**.

The core idea is simple: **spend expensive parent context on judgment, not repository ingestion, worker narration, repeated verification, or orchestration paperwork.**

The parent understands project intent/architecture, plans work, resolves hard decisions, schedules safe parallelism, preserves user constraints, and owns phase gates. Luna/max workers inspect, implement, test, self-review, repair, and leave bounded durable evidence.

Both sides use a complexity budget: reuse/extend sound mechanisms first, use OOP/polymorphism where they model real variation, and reject speculative layers/frameworks/process ceremony.

## Mechanical context controls

Lunacy does not rely only on “be concise.” It enforces boundaries:

- when supported, every Luna spawn uses `fork_turns: "none"` so workers do not inherit the parent conversation by default;
- worker mailbox messages are only `BLOCKED`, `DECISION_REQUIRED`, or `FINAL`, at most three short lines;
- workers write one immutable terminal report, normally ≤60 lines / ~6 KB;
- parent decision briefs are ≤30 lines / ~4 KB;
- gate packs are ≤30 lines / ~4 KB;
- long command output, broad surveys, inventories, and raw evidence stay in evidence/log files rather than parent context;
- per-file hash catalogs are avoided unless project authority requires them;
- finalized reports/gate packs/gates are immutable—repairs create new numbered evidence instead of reopening old artifacts;
- the parent normally reads Control Blocks, tiny decision briefs, gate packs, and exact named code/report slices only;
- if one parent decision/gate needs more than three substantive deep slices, Lunacy delegates compression or checkpoints into fresh parent context;
- token usage is never guessed: exact host counters only, otherwise `unavailable`.

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
 immutable terminal Control Blocks
        ↓
optional adversary if a named risk earns it
        ↓
optional read-only gate scout if integration earns it
        ↓
orchestrator hard gate
```

A phase is an integrated milestone. A step is the **largest coherent unit** one Luna/max worker can safely own end-to-end. Lunacy avoids micro-decomposition merely to create more agents.

## Verification without proof multiplication

Each layer has a different job:

1. **Implementer:** terminal verification after its final code change.
2. **Adversary, when justified:** attack new risks/assumptions and verify the impacted delta after repairs unless broader proof became stale.
3. **Gate scout, when justified:** read-only compression/navigation; no broad suite rerun.
4. **Parent gate:** inspect actual targeted code/diff/behavior and perform the authoritative required gate proof plus only the additional bounded acceptance sample useful for integration judgment.

Project/plan acceptance authority always wins: required full matrices, independent repetitions, live proof, or exact gate commands still run exactly as required. Lunacy removes only redundant proof beyond that contract.

Adversary defaults to NO rather than being stamped onto every step. Multiple adversaries in one phase should attack distinct risks or a newly repaired state.

## Immutable evidence / gate write barrier

A worker's FINAL report describes one exact terminal state. It is never reopened to append later findings, newer hashes, overlap amendments, or revised counts. Later repairs use a new attempt/report.

Before a gate scout or hard gate, all phase writers must be FINAL and the run records a **CLOSED write barrier**. Any later phase-owned change reopens the barrier and invalidates a scout produced against the previous state.

This prevents gate scouts from racing moving artifacts and prevents “final” worker reports from becoming mutable shared notebooks.

## Small parent decision surface

When Luna encounters genuine ambiguity, it can perform deep repository research, but the parent receives a tiny decision brief: one question, authority, facts, options, recommendation, execution impact, and exact evidence pointers. Large surveys remain worker-side evidence.

Related contradictions discovered in one bounded investigation are consolidated before parent adjudication instead of accumulating serial amendments and chat wakeups.

## Multiple plans / sessions in one project

```text
Lunacy/
  PROJECT_NOTES.md
  runs/
    auth-refactor/
      PLAN.md
      STATE.md
      USER_NOTES.md
      DECISIONS.md
      phases/...
    generation-pipeline/
      PLAN.md
      STATE.md
      USER_NOTES.md
      DECISIONS.md
      phases/...
```

Each session binds to one run. Run state records concise `Workspace` and `Ownership`; ACTIVE runs cheaply compare those boundaries before simultaneous implementation. Worktrees/branches are preferred where available, but semantic overlap/shared contracts still serialize or replan.

There is intentionally no global scheduler/database/`CURRENT_RUN`.

## Durable user memory

`PROJECT_NOTES.md` stores project-wide user requirements. Each run may have `USER_NOTES.md` for run-specific notes. They are tiny current-memory files, not chat logs.

New user input is evaluated immediately; if it changes execution, plan/state/steps/decisions change too. Notes are reread on fresh/restarted contexts, known compaction/loss, and the final gate—not on every worker cycle.

## Engineering discipline

Workers follow `worker/ENGINEERING.md`: understand before writing, search for reuse/extension, prove complete maintained-surface coverage, prefer clean cohesive abstractions/polymorphism where appropriate, and reject ceremonial OOP/overengineering.

The orchestrator follows `orchestrator/PLANNING.md` when planning/replanning and keeps the same simplicity bias during execution decisions.

A green selected test matrix is evidence, **not scope authority**. Maintained callers/tests cannot be dismissed as historical without explicit authority.

## Phase gates

Parent review normally happens at phase boundaries, not after every step. Gate scouts are conditional: use one when multiple writers changed interacting surfaces, an adversary repaired integration, evidence conflicts, or the phase is genuinely high-risk/cross-cutting. A single coherent low-risk phase can go directly to the parent gate.

The parent inspects targeted actual code/diff/behavior and judges correctness, architecture, project ethos, integration risk, user constraints, and complexity proportionality.

## Worker invariant

Every technical subagent must use:

```text
model: gpt-5.6-luna
reasoning_effort: max
```

There is no silent fallback. The first real worker spawn doubles as the Luna capability check.

## Install

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/frozenpepper/Lunacy.git ~/.agents/skills/lunacy
```

## Use

```text
Use $lunacy for this task. Minimize parent context; plan phases/steps first and delegate repository-heavy work to Luna/max.
```

Resume a named run when useful:

```text
Use $lunacy to resume the auth-refactor run.
```

## Files

```text
SKILL.md                         Always-loaded orchestration protocol.
orchestrator/PLANNING.md        Parent planning/reuse/OOP/YAGNI/verification doctrine.
WORKSPACE.md                     Multi-run state, immutable evidence, report/gate/decision limits.
worker/ENGINEERING.md            Luna engineering + bounded output/terminal evidence doctrine.
references/CODEX_LUNA_COMPAT.md Conditional Luna compatibility procedure.
README.md                        Human-facing overview.
```