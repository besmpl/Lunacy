---
name: lunacy
description: Execute a coding plan or task with Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator and only GPT-5.6 Luna subagents at max reasoning. Preserve parent context for project intent, planning, hard decisions, and phase gates; delegate repository-heavy work end-to-end.
---

# Lunacy

**Primary goal: minimize orchestrator token use.** The parent owns global understanding and judgment. Luna/max owns repository-heavy execution.

Every technical subagent MUST be `gpt-5.6-luna` at reasoning effort `max`. Never silently fall back.

## Rules

1. **Project intent is authority.** Goal, user constraints, ethos, principles, architecture, contracts, and authoritative plan drive decisions.
2. **Prefer the simplest sound design.** Complexity must earn its cost. Reuse/extend sound mechanisms before inventing new ones; sophistication is not quality.
3. **Plan → phases → steps.** A phase is an integrated milestone. A step is the largest coherent unit one Luna/max worker can safely own. Do not over-decompose for agent count.
4. **The orchestrator follows `orchestrator/PLANNING.md`** when creating/materially replanning a run: reuse/OOP/polymorphism where they genuinely fit, explicit YAGNI/anti-overengineering, and cross-run ownership discipline.
5. **Workers own the full local loop.** Inspect → implement → verify → self-review → fix → reverify → one terminal durable report.
6. **Workers follow `worker/ENGINEERING.md`.** Project-specific authority outranks the generic doctrine.
7. **Do not micromanage.** Give goals, authority, boundaries, dependencies, acceptance boundary, doctrine path, and report path.
8. **Parallelize safe independent work.** Launch the largest safe dependency-ready set up to host capacity. Serialize overlapping writes/contracts/state/decisions. Never distort architecture to manufacture concurrency.
9. **Multiple runs may coexist.** Each run lives under `Lunacy/runs/<run-id>/`; project-wide user memory lives at `Lunacy/PROJECT_NOTES.md`. No global run registry or current-run pointer.
10. **Parent review cadence is phase-end by default.** Step reports control progress; they do not trigger routine parent code review.
11. **Use fresh adversaries selectively** for unusually risky steps.
12. **Spend parent reasoning only at leverage points:** planning, ambiguity, architecture/integration tradeoffs, conflicting evidence, scope/blocker decisions, and hard gates.
13. **No fake completion:** no stubs, hidden TODOs, weakened tests, test-specific hard-coding, skipped integration, or unsupported PASS claims.

## Token / process discipline

Do not bulk-read repositories, long logs, worker chats, or historical reports. Prefer compact durable files and exact source paths. Delegate broad discovery/large-document ingestion to Luna/max with a compact cited digest; the parent still owns the resulting decision.

Default worker handoffs are tiny and path-based. Workers stay silent unless blocked/decision-needed. After their **terminal verification snapshot** and final Control Block, they freeze changes and finalize immediately: no post-PASS polish, reruns just to update counts, or revised completion chatter.

Prefer event-driven/blocking waits. For concurrent workers, prefer one batch-level wait/reconciliation cycle. If the host forces polling/visible heartbeats, use the coarsest practical cadence and do not reread unchanged state because a timer fired.

Do not add phases, micro-steps, scouts, adversaries, durable files, compatibility layers, or verification machinery unless they materially improve correctness, ownership, risk control, or resumability.

At hard gates, summaries are navigation aids, not correctness authority. Inspect the smallest **actual code/diff/behavior** surface that tests architecture, ethos, integration, risk, and complexity proportionality; broaden only when evidence warrants it.

## 1. Resolve/create the run, then plan

`<run-root>` means `Lunacy/runs/<run-id>`.

- Explicit new task/plan: create a short semantic unique run id.
- Explicit named/path resume: bind to that run.
- Unspecified resume: inspect only `Lunacy/runs/*/STATE.md`; bind when unambiguous, otherwise ask which run.
- Legacy root-level `Lunacy/PLAN.md/STATE.md/phases/`: follow `WORKSPACE.md` and migrate once into a run; do not keep duplicate authority.

On new run/fresh session/context recovery, read applicable project instructions plus `Lunacy/PROJECT_NOTES.md` and run-local `USER_NOTES.md` if present. User-originated notes are memory, not workflow state. When the user adds/changes a material requirement, update the appropriate note scope **and evaluate it immediately**; change `PLAN.md`/`STATE.md`/`STEPS.md`/`DECISIONS.md` when execution authority actually changes.

Read `orchestrator/PLANNING.md` when creating or materially changing architecture/decomposition. Read `WORKSPACE.md` on new-run setup or damaged/ambiguous recovery, not every resume.

Create/maintain `<run-root>/PLAN.md`, `STATE.md`, and phase `STEPS.md`. Keep `PLAN.md` compact. Preserve a structured source plan's meaningful hierarchy; vague work gets the minimum useful phases/steps.

Define phase goals, dependencies, phase-end gates, exceptional extra gates, selective adversaries, and final gate. For migration/replacement/removal work, coverage defaults to **every maintained affected surface**—production, tests, fixtures, adapters, examples, indirect/variable-mediated construction—unless explicit authority excludes something. A green selected matrix is evidence, not scope authority.

Record concise `Workspace` and `Ownership` fields in `STATE.md`. Before implementation and after material ownership changes, inspect only other `ACTIVE` run `STATE.md` files. Prefer isolated worktrees/branches for simultaneous runs when available. Serialize/replan overlapping surfaces/shared contracts or unsafe shared checkout/state. Isolation does not make semantically overlapping architecture independent.

## 2. Execute with Luna/max

The first **real** Luna/max worker spawn doubles as capability check; no dummy probe.

At each scheduling point, use the current phase dependency table and known contracts to form the **maximal safe concurrent batch** of ready steps. Persist the whole active batch in run `STATE.md`, then launch one Luna/max owner per step.

Worker handoff points to:

- `<run-root>/PLAN.md` + applicable project instructions;
- `<lunacy-skill-root>/worker/ENGINEERING.md`;
- its `<run-root>/phases/<phase>/STEPS.md` row;
- its report path.

Require inspect/reuse inventory first, full implement→verify→self-review→fix→reverify loop, silence unless blocked/decision-needed, overlap escalation before conflicting edits, and one terminal Control Block followed by immediate finalization.

Luna owns repository-scale caller/surface/reuse discovery. If deeper inspection reveals conflict with another active step/run or a shared contract that invalidates independence, it stops before the conflicting edit and escalates; the parent serializes/replans.

After a batch settles, read each **terminal Control Block once**, reconcile `STATE.md`/`STEPS.md` once, then schedule the next batch. Read detail only for a decision, contradiction, blocker, planned adversary, recovery, or gate.

If Codex rejects Luna/max because of the known multi-agent catalog mismatch, never downgrade. Follow `references/CODEX_LUNA_COMPAT.md`, persist exact restart/resume state, then tell the user to close/relaunch Codex and open a new task.

## 3. Optional fresh-Luna adversary

For selected risky work, use a fresh Luna/max agent that did not implement it. Give durable principles/step contract, `worker/ENGINEERING.md`, actual code/diff, and verification entry points—not implementer chat/reasoning.

It attacks correctness, integration, assumptions, regressions, coverage, reuse, abstractions, and unjustified complexity. It may repair in-scope findings and reverify; broader design questions return to the parent. Its final report uses the same terminal snapshot rule.

## 4. Hard decisions

Resolve genuine hard questions in this order:

1. explicit user intent/current user notes;
2. project ethos/core principles and goal;
3. authoritative plan/architecture/contracts;
4. established evidence/accepted behavior;
5. conservative engineering judgment preserving intent.

Keep the design bias active during execution: **reuse/extend sound abstractions first; use OOP/polymorphism only when they simplify real current variation or repeated branching; otherwise prefer the simpler direct design and reject speculative machinery.**

Record consequential decisions, then delegate implementation consequences to Luna/max.

## 5. Phase hard gate

When required phase steps are done, stop normal execution.

For a nontrivial phase, a fresh Luna/max gate scout may compress integrated changes, cross-step interfaces, verification, risks, and exact parent inspection targets into a small gate pack. The scout cannot approve the phase.

The parent inspects targeted actual code/diff/behavior and judges the integrated phase against goal, user notes, ethos, architecture/contracts, regressions, cross-step integration, and **complexity proportionality**. Functional correctness does not excuse duplicate mechanisms, speculative abstractions, excessive layers, or maintenance burden.

Findings become Luna/max repair steps; re-gate after material repair. Tiny obvious phases may skip the scout.

## 6. Resume and finish

Run `STATE.md` always describes reality, including active workers, workspace/ownership, and one exact `Next action`.

Fresh/restarted/context-compacted orchestration reads only:

1. applicable project instructions;
2. `Lunacy/PROJECT_NOTES.md` if present;
3. `<run-root>/USER_NOTES.md` if present;
4. `<run-root>/STATE.md`;
5. `<run-root>/PLAN.md`;
6. current phase `STEPS.md`;
7. artifact(s) required by `Next action`.

Do not reconstruct history from worker chats or reread old reports/decisions/gates unless specifically required.

If interruption leaves steps active, reconcile terminal Control Blocks first. Incomplete attempts become fresh Luna continuation/recovery attempts against current repository state; account for partial-write and cross-run overlap before re-forming concurrency.

At the final gate, reread project/run user notes and judge the integrated result against the whole goal, ethos, plan, architecture/contracts, required verification, and proportional complexity. Every current run-relevant user request must be satisfied, explicitly superseded, or deliberately deferred with authority.