---
name: lunacy
description: Execute a coding plan or task with Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator and only GPT-5.6 Luna subagents at max reasoning. Preserve parent context for project intent, planning, hard decisions, and phase gates; delegate repository-heavy work end-to-end.
---

# Lunacy

**Primary goal: minimize orchestrator token use.** The parent owns global understanding and judgment. Luna/max owns repository-heavy execution.

Every technical subagent MUST be `gpt-5.6-luna` at reasoning effort `max`. Never silently fall back.

## Rules

1. **Project intent is authority.** Understand the goal, ethos, core principles, architecture, non-negotiable contracts, and authoritative plan well enough to let them drive planning and decisions.
2. **Prefer the simplest sound design.** Complexity must earn its cost. Do not confuse sophistication, hierarchy, or abstraction count with quality.
3. **Plan → phases → steps.** A phase is an integrated milestone. A step is the largest coherent unit one Luna/max worker can safely own end-to-end. Do not over-decompose merely to create more agent work.
4. **The orchestrator follows the planning doctrine.** Read `orchestrator/PLANNING.md` when creating or materially replanning a run; use existing architecture/reuse points, OOP/polymorphism where they genuinely fit, and explicit anti-overengineering/YAGNI guardrails.
5. **Preserve user intent durably.** Keep `Lunacy/USER_NOTES.md` as a tiny current record of user-originated project/run constraints, requests, corrections, preferences, and intentionally deferred items. Update it when the user adds or changes something material; immediately evaluate whether authoritative execution files also need changing.
6. **Workers own the full local loop.** Inspect → implement → verify → self-review → fix → reverify → terse durable report.
7. **Workers follow the companion engineering doctrine.** Point implementation/repair/recovery/adversary workers to `worker/ENGINEERING.md`; project-specific authority outranks the generic doctrine.
8. **Do not micromanage.** Give goals, relevant principles/authority, boundaries, dependencies, acceptance boundary, doctrine path, and report path. Let Luna resolve ordinary engineering details.
9. **Parallelize safe independent work.** At each scheduling point, launch the largest safe set of dependency-ready steps concurrently, up to host capacity. Serialize when steps overlap likely write surfaces, change a shared contract/abstraction, consume one another's output, share unsafe mutable state, or need the same unresolved architecture decision. If independence is uncertain, serialize. Never distort architecture or step boundaries merely to manufacture concurrency.
10. **Parent review cadence is phase-end by default.** Step reports control progress; they do not trigger routine parent code review.
11. **Use fresh adversaries selectively.** A fresh Luna/max agent may independently attack a completed high-risk step when the extra review is worth it.
12. **Spend parent reasoning only at leverage points:** planning, genuine ambiguity, architecture/integration tradeoffs, conflicting evidence, scope/blocker decisions, and hard gates.
13. **No fake completion:** no stubs, hidden TODOs, weakened tests, test-specific hard-coding, skipped integration, or unsupported PASS claims.

## Token discipline

Do not bulk-read repositories, long logs, worker chats, or historical reports. Prefer compact durable files and exact source paths. Read only what the current decision needs.

If broad discovery or large-document ingestion would consume substantial parent context, delegate it to Luna/max and require a compact cited digest. The orchestrator still owns the resulting plan/decision and spot-checks important authority as needed.

**Default worker handoffs are path-based and tiny.** Point the worker to `PLAN.md`, its phase `STEPS.md` row, applicable project instructions, the companion `worker/ENGINEERING.md`, and its report path; inline only exceptions or facts not already durable. Do not restate the authority digest, doctrine, or plan in every spawn.

**Workers stay quiet while working.** They emit no intermediate progress/mailbox messages unless blocked or a genuine orchestrator decision is required. After writing the final durable Control Block/report, they finalize immediately instead of sending post-completion polish/status chatter.

**Minimize orchestrator wakeups.** Where the host supports event-driven or blocking completion waits, use them instead of repeated short timeout polling. For a concurrent batch, prefer one batch-level wait/reconciliation cycle over repeatedly waking for each worker. If polling or visible heartbeats are forced by the host, use the coarsest practical cadence, keep unchanged updates minimal, and do not reread unchanged worker/repository state merely because a timer fired.

**Minimize process ceremony too.** Do not add phases, micro-steps, scouts, adversaries, durable files, compatibility layers, or verification machinery unless they materially improve ownership, risk control, correctness, or resumability for this task.

At hard gates, worker summaries are navigation aids, not correctness authority. The parent reviews **actual effects/current code**, but this is global integrated judgment—not duplicate line-by-line implementation review. Inspect the smallest actual code/diff/behavior surface that can test architecture, ethos, integration, risk, and unnecessary complexity; expand only when evidence warrants it.

## 1. Plan before implementation

Read the user request and high-value project authority. For large authority sets, use a Luna/max intake scout to produce a cited digest, then review/adjust it yourself.

Read the companion `orchestrator/PLANNING.md` when creating the plan or materially changing its architecture/decomposition. Use the companion `WORKSPACE.md` located beside this `SKILL.md` for durable file formats:

- **new run:** read both companions once and create `Lunacy/PLAN.md`, `STATE.md`, `USER_NOTES.md`, and phase `STEPS.md`;
- **normal uninterrupted execution:** do not reread either companion or `USER_NOTES.md` merely because another step starts;
- **fresh/restarted orchestrator or known context compaction/loss:** reread the tiny `USER_NOTES.md` with the normal resume packet.

Capture durable user-specific constraints/requests in `USER_NOTES.md` during setup. `PLAN.md` remains the compact durable authority/execution digest: anything from the notes that changes current goals, contracts, acceptance, scope, or sequencing must be reflected in the authoritative plan/state/step files rather than existing only as a note.

Preserve a structured source plan's meaningful hierarchy. For vague work, create the minimum useful phases/steps yourself; small work may be one phase.

Before implementation define phase goals, step dependencies, phase-end hard gates, any exceptional extra gates, selected adversarial reviews, and the final gate. Design steps so genuinely independent work can run concurrently without competing ownership, but do not reshape a clean architecture merely to expose parallelism. Each phase and step must earn its existence through ownership, dependency, risk, or a meaningful integration boundary.

Prefer reuse or extension of sound existing mechanisms before planning new abstractions or subsystems. Use OOP/polymorphism when they express real current domain variation behind stable contracts; do not invent class hierarchies, services, managers, factories, adapters, feature flags, or generalized frameworks for hypothetical future needs. Choose a materially simpler design when it provides the same required correctness, maintainability, and reasonable extensibility.

For any **migration, replacement, compatibility cleanup, or removal** step, the step contract must make coverage unambiguous. Default coverage is every maintained affected caller/surface in the repository—including production code, tests, fixtures, adapters, examples, and indirect or variable-mediated construction—unless authoritative project material explicitly excludes something. Do not let workers infer that an uncovered surface is `legacy`/`historical` merely because a selected test matrix is green or does not include it.

Replan when real facts justify it; persist consequential decisions. Do not replan merely to make the plan look more elegant.

## 2. Execute steps with Luna/max

The first **real** Luna/max worker spawn doubles as the capability check; do not spend an extra agent call on a dummy probe.

At each scheduling point, inspect only the phase dependency/status table and known step contracts. Form the **maximal safe concurrent batch** of `READY` steps whose dependencies are satisfied. Concurrent steps must have independent outcomes and no known conflicting write/contract/state ownership. Launch one Luna/max owner per step, up to host capacity. Do not parallelize merely for speed when merge/integration risk would shift expensive work back to the parent.

For each launched step, persist current state first. The normal handoff can be only a few lines: identify the step, point to durable authority/step/doctrine/report paths, require the full implementation→verification→self-review→fix→reverify loop, require silence unless blocked/decision-needed, and tell it to finalize immediately after its durable report.

The worker must inspect the existing system before editing: identify relevant callers, sibling paths, objects/types/interfaces, helpers, tests, lifecycle/persistence boundaries, and safe reuse/extension points. For migration/replacement/removal work it must prove the full contract coverage, including indirect/variable-mediated uses; this repository-scale inventory belongs to Luna, not the parent.

A worker in a concurrent batch owns only its step. If discovery shows that correct completion requires editing a surface owned by another active worker, consuming an uncommitted sibling result, or changing a shared contract in a way that invalidates the independence assumption, it must **stop before the conflicting edit and escalate the overlap**. The orchestrator then serializes/replans the affected work instead of allowing a race.

When the user adds, corrects, or defers a material requirement during execution, update `USER_NOTES.md` immediately and evaluate impact before the next affected scheduling/decision point. If it changes current execution, update `PLAN.md`, `STATE.md`, `STEPS.md`, and/or `DECISIONS.md` as appropriate. User notes preserve intent across context loss; they do not replace execution authority.

After a batch completes, read only each report's Control Block, reconcile `STATE.md`/`STEPS.md` once, then schedule the next safe batch. Read deeper only for a decision request, contradiction, blocker, planned adversary, recovery, or gate.

If Codex rejects Luna/max because of the known multi-agent catalog mismatch, do not downgrade. Read the skill companion `references/CODEX_LUNA_COMPAT.md`, apply only that procedure, validate it, persist restart/resume state, then tell the user to **close and relaunch Codex and open a new task**. Stop execution in the current task; its model-selection schema cannot refresh mid-task.

## 3. Optional fresh-Luna adversary

For a selected risky step, use a fresh Luna/max agent that did not implement it. Point it to the durable principles/step contract, `worker/ENGINEERING.md`, actual code/diff, and verification entry points; do not give it implementer chat/reasoning.

It independently attacks correctness, integration, assumptions, regressions, principle compliance, missed reuse opportunities, duplicated mechanisms, poor abstractions, incomplete caller/surface coverage, and unjustified complexity. It may repair in-scope findings and reverify. Broader design questions return to the orchestrator.

## 4. Hard decisions

Resolve genuine hard questions in this order:

1. explicit user intent;
2. project ethos/core principles and goal;
3. authoritative plan/architecture/contracts;
4. established project evidence/accepted behavior;
5. conservative engineering judgment preserving intent.

During execution-time decisions, keep the same design bias: **reuse or extend sound existing abstractions first; use OOP/polymorphism only when they simplify real current variation or repeated branching; otherwise prefer the simpler direct design and reject speculative machinery.** When several designs satisfy the authority equally, prefer the one with less new machinery and lower maintenance burden. Read the minimum evidence needed, record consequential decisions, and delegate implementation consequences back to Luna/max.

## 5. Phase hard gate

When all required phase steps are done, stop normal step execution.

For a nontrivial phase, first spawn a fresh Luna/max **gate scout** to compress the integrated change into a small gate pack: changed surfaces, cross-step interfaces, verification status, highest risks/uncertainties, and exact actual artifacts/checks most worth parent inspection. The scout **does not approve the phase**.

The orchestrator then performs the hard gate: use the gate pack as an index, inspect targeted actual code/diff/behavior, and judge the integrated phase against project ethos, architecture/contracts, phase goal, regressions, cross-step integration, and **complexity proportionality**. Functional correctness does not excuse unjustified parallel mechanisms, speculative abstractions, excessive layers, or maintenance burden.

Persist the terse gate result. Concrete complexity/simplification findings become Luna/max repair steps just like correctness findings; repeat the gate after material repair. A tiny obvious phase may skip the scout.

## 6. Resume and finish

`STATE.md` always describes reality and contains one exact `next_action`. It may name multiple active steps/workers when a safe batch is in flight.

A fresh/restarted orchestrator, or one recovering after known context compaction/loss, reads only project-level instructions, `STATE.md`, `PLAN.md`, the tiny `USER_NOTES.md`, current phase `STEPS.md`, and the artifact(s) explicitly required by `next_action`. Read historical decisions/reports only when explicitly relevant. Never reconstruct history from worker chats.

If interruption leaves one or more steps `ACTIVE`, do not investigate their partial implementations yourself. Check only whether each active attempt's report/control block completed. Reconcile completed attempts. For each incomplete attempt, mark it interrupted and launch a fresh Luna/max continuation/recovery worker for that same step against the **current repository state**. Re-form a safe batch only after accounting for any surviving partial writes/overlap risk.

At the final gate, reread `USER_NOTES.md` and ensure every current run-relevant user request/constraint is satisfied, deliberately deferred with user authority, or explicitly superseded. Then judge the integrated result against the whole goal, project ethos/core principles, authoritative plan, architecture/contracts, required verification, and proportional complexity. Finish only with no unresolved task-relevant findings.
