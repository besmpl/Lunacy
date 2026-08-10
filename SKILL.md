---
name: lunacy
description: Execute a coding plan or task with Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator and only GPT-5.6 Luna subagents at max reasoning. Preserve parent context for project intent, planning, hard decisions, and phase gates; delegate repository-heavy work end-to-end.
---

# Lunacy

**Primary goal: minimize orchestrator context while preserving high-leverage judgment.** The parent owns global intent, architecture decisions, scheduling, and acceptance. Luna/max owns repository-heavy work.

Every technical subagent MUST be `gpt-5.6-luna` at reasoning effort `max`. Never silently fall back.

## Invariants

1. **Project intent is authority.** Goal, current user constraints, ethos, architecture, contracts, and authoritative plan drive decisions.
2. **Prefer the simplest sound design.** Complexity must earn its cost. Reuse/extend sound mechanisms before inventing new ones.
3. **Plan → phases → steps.** A step is the largest coherent unit one Luna/max worker can safely own; do not micro-split for agent count.
4. **Multiple runs may coexist.** Each run lives under `Lunacy/runs/<run-id>/`; project-wide user memory lives at `Lunacy/PROJECT_NOTES.md`.
5. **Workers get fresh context by default.** When the spawn API exposes `fork_turns`, use `fork_turns:"none"`. Do not inherit the parent conversation for convenience. Any exception requires a concise reason in run `DECISIONS.md`.
6. **Workers own the full local loop.** Inspect → implement → verify → self-review → fix → terminal reverify → one immutable durable report.
7. **Parallelize only safe independent work.** Serialize overlapping writes/contracts/state/decisions; never distort architecture to manufacture concurrency.
8. **Parent review cadence is phase-end by default.** Ordinary PASS steps do not trigger parent code review.
9. **Adversaries and gate scouts are conditional, not ceremonial.** Use them only when risk/integration complexity earns the extra call.
10. **No fake completion:** no stubs, hidden TODOs, weakened tests, test-specific hard-coding, skipped integration, or unsupported PASS claims.

Read `orchestrator/PLANNING.md` when creating/materially replanning. Point implementation/repair/recovery/adversary workers to `worker/ENGINEERING.md`. Project-specific authority outranks both generic doctrines.

## Hard context / communication limits

**Path-only handoffs.** Give workers durable authority paths, step/report paths, and only facts not already durable. User changes must be written to notes/plan/state before spawning affected workers.

**Worker mailbox has exactly three useful message types:** `BLOCKED`, `DECISION_REQUIRED`, `FINAL`. Each mailbox message is at most three short lines and contains no evidence dump. `FINAL` points to the immutable report; the parent reads the Control Block there.

**Parent reads slices, not dossiers.** Default parent inputs are run control files, terminal Control Blocks, concise decision briefs, and gate packs. Read only exact named source/report slices needed for the current decision. A full worker report may be read only to resolve a specific contradiction that cannot be resolved from its Control Block + cited slices.

**Three-deep-read rule.** If one parent decision/gate would require more than three substantive detail/source slices, stop accumulating context: delegate a fresh Luna compression/decision brief or persist a checkpoint and continue in fresh parent context. Do not brute-force the repository into the parent.

**No raw verification output in parent context.** Long output goes to a log/evidence file or temporary file. Parent-facing text contains command/check name, exit/result, counts when useful, and the first relevant red only.

**No hash catalogs.** Do not list per-file hashes unless project authority specifically requires them. Prefer one aggregate snapshot/fingerprint when provenance needs one.

**Never invent token usage.** Record exact host counters only when directly exposed. Otherwise report usage as unavailable; never estimate historical worker/parent tokens from output size, elapsed time, or intuition.

Prefer event-driven/blocking waits. For concurrent workers, wait/reconcile at batch level. If the host forces polling/visible updates, use the coarsest practical cadence and never reread unchanged state because a timer fired.

## 1. Resolve/create the run, then plan

`<run-root>` means `Lunacy/runs/<run-id>`.

- Explicit new task/plan: create a short semantic unique run id.
- Explicit named/path resume: bind to that run.
- Unspecified resume: inspect only `Lunacy/runs/*/STATE.md`; bind when unambiguous, otherwise ask which run.
- Legacy root-level `Lunacy/PLAN.md/STATE.md/phases/`: migrate once per `WORKSPACE.md`; do not keep duplicate authority.

On new run/fresh session/context recovery, read applicable project instructions plus project/run user notes. When user input materially changes requirements, update the appropriate notes **and evaluate it immediately**; update execution authority/state when needed.

Create/maintain compact `<run-root>/PLAN.md`, `STATE.md`, and phase `STEPS.md`. Define phase goals, dependencies, gates, selective adversaries, and verification ownership. Avoid assigning the same expensive/global verification matrix to multiple layers without a reason.

For migration/replacement/removal work, coverage defaults to **every maintained affected surface**—production, tests, fixtures, adapters, examples, indirect/variable-mediated construction—unless explicit authority excludes something. A green selected matrix is evidence, not scope authority.

Record concise `Workspace` and `Ownership` in `STATE.md`. Before implementation and after ownership changes, inspect only other ACTIVE run states. Prefer isolated worktrees/branches where available; serialize/replan semantic or shared-state overlap.

## 2. Execute with Luna/max

The first real Luna/max spawn doubles as capability check; no dummy probe.

At each scheduling point, form the maximal safe concurrent batch from READY steps. Persist the active batch, then launch one Luna/max owner per step with fresh/no-turn inheritance when supported.

The handoff points to:

- `<run-root>/PLAN.md` + applicable project instructions;
- `<lunacy-skill-root>/worker/ENGINEERING.md`;
- its `<run-root>/phases/<phase>/STEPS.md` row;
- its report path.

Require existing-system/reuse inventory first; full implement→verify→self-review→fix→terminal reverify; overlap escalation before conflicting edits; silence except `BLOCKED`/`DECISION_REQUIRED`/`FINAL`.

Luna owns repository-scale caller/surface/reuse discovery. Unexpected active-step/run overlap stops before conflicting edits and returns to the parent for serialization/replanning.

After a batch settles, read each terminal Control Block **once**, reconcile run state **once**, then schedule the next batch. Do not reopen finalized reports to append later findings.

If a worker needs a parent decision, it freezes the conflicting boundary, writes one concise decision brief with exact evidence pointers, sends `DECISION_REQUIRED`, and stops. Related contradictions discovered in the same bounded investigation should be consolidated into one brief rather than serial amendments/messages.

If Codex rejects Luna/max because of the known multi-agent catalog mismatch, never downgrade. Follow `references/CODEX_LUNA_COMPAT.md`, persist exact restart/resume state, then require a fresh Codex task.

## 3. Verification ownership

Avoid proof multiplication.

- **Implementer:** after its last code change, run the step's terminal verification once and report that final snapshot. Development checks before the final state need not be narrated.
- **Adversary (when justified):** attack new risk/assumptions. If it fixes something, verify the impacted surface; do not blindly replay the implementer's entire broad matrix unless the repair invalidates it.
- **Gate scout (when justified):** read-only compression/navigation. It does **not** rerun broad verification suites.
- **Parent gate:** inspect actual targeted code/diff/behavior and run one bounded acceptance sample/check set chosen for integration risk. Do not replay every worker suite.

If code changes after any terminal verification, that verification is stale and the changing owner must produce a new terminal snapshot before acceptance.

## 4. Hard decisions

Resolve genuine hard questions in this order:

1. explicit user intent/current user notes;
2. project ethos/core principles and goal;
3. authoritative plan/architecture/contracts;
4. established evidence/accepted behavior;
5. conservative engineering judgment preserving intent.

Keep the execution-time design bias active: **reuse/extend sound abstractions first; use OOP/polymorphism only when they simplify real current variation or repeated branching; otherwise prefer the simpler direct design and reject speculative machinery.**

Record consequential decisions append-only, then delegate implementation consequences to Luna/max.

## 5. Phase hard gate

When required phase steps are terminal, stop normal execution and close a **write barrier**: no active writer may remain. Any later change to phase-owned code/evidence reopens the barrier and invalidates a gate pack produced against the older state.

Use a fresh Luna/max gate scout only when it materially compresses parent work—for example multiple writers changed interacting surfaces, an adversary repaired integration, reports conflict, or the phase is genuinely high-risk/cross-cutting. Skip it for a single coherent low-risk phase.

A scout starts only after the write barrier is closed, is read-only except for its small immutable gate pack, and must point the parent to exact source symbols/diff regions. It cannot approve the phase and cannot run broad verification suites.

The parent then inspects targeted actual code/diff/behavior and performs one bounded acceptance sample. Judge goal, user notes, architecture/contracts, regressions, integration, and complexity proportionality. Findings become new Luna repair attempts/steps; never reopen or edit finalized worker reports/gate packs. Re-close the barrier and re-gate with new numbered evidence after repair.

## 6. Resume and finish

Run `STATE.md` always describes reality, active workers, workspace/ownership, gate barrier, and one exact `Next action`.

Fresh/restarted/context-compacted orchestration reads only:

1. applicable project instructions;
2. project/run user notes;
3. `<run-root>/STATE.md`;
4. `<run-root>/PLAN.md`;
5. current phase `STEPS.md`;
6. artifact(s) explicitly required by `Next action`.

Do not reconstruct history from chats or bulk-reread reports/decisions/gates.

If interruption leaves steps active, reconcile immutable terminal Control Blocks first. Incomplete attempts become fresh continuation/recovery attempts against current repository state; finalized prior evidence remains untouched.

If the host signals context pressure/compaction, persist run state and the exact next action **before** compaction/restart when possible. If exact usage counters are exposed, they may inform the checkpoint; otherwise use the three-deep-read rule and host context signals rather than fabricated token estimates.

At the final gate, reread project/run user notes and judge the integrated result against the whole goal, ethos, plan, architecture/contracts, required verification, and proportional complexity. Every current run-relevant user request must be satisfied, explicitly superseded, or deliberately deferred with authority.