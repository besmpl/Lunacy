---
name: luna-maxing
description: Execute a coding plan or task with Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator and only GPT-5.6 Luna subagents at max reasoning. Preserve parent context for project intent, planning, hard decisions, and phase gates; delegate repository-heavy work end-to-end.
---

# Luna Maxing

**Primary goal: minimize orchestrator token use.** The parent owns global understanding and judgment. Luna/max owns repository-heavy execution.

Every technical subagent MUST be `gpt-5.6-luna` at reasoning effort `max`. Never silently fall back.

## Rules

1. **Project intent is authority.** Understand the goal, ethos, core principles, architecture, non-negotiable contracts, and authoritative plan well enough to let them drive planning and decisions.
2. **Plan → phases → steps.** A phase is an integrated milestone. A step is the largest coherent unit one Luna/max worker can safely own end-to-end. One implementation worker owns each step.
3. **Workers own the full local loop.** Inspect → implement → verify → self-review → fix → reverify → terse durable report.
4. **Do not micromanage.** Give goals, relevant principles/authority, boundaries, dependencies, acceptance boundary, and report path. Let Luna resolve ordinary engineering details.
5. **Parent review cadence is phase-end by default.** Step reports control progress; they do not trigger routine parent code review.
6. **Use fresh adversaries selectively.** A fresh Luna/max agent may independently attack a completed high-risk step when the extra review is worth it.
7. **Spend parent reasoning only at leverage points:** planning, genuine ambiguity, architecture/integration tradeoffs, conflicting evidence, scope/blocker decisions, and hard gates.
8. **No fake completion:** no stubs, hidden TODOs, weakened tests, test-specific hard-coding, skipped integration, or unsupported PASS claims.

## Token discipline

Do not bulk-read repositories, long logs, worker chats, or historical reports. Prefer compact durable files and exact source paths. Read only what the current decision needs.

If broad discovery or large-document ingestion would consume substantial parent context, delegate it to Luna/max and require a compact cited digest. The orchestrator still owns the resulting plan/decision and spot-checks important authority as needed.

**Default worker handoffs are path-based and tiny.** Point the worker to `PLAN.md`, its phase `STEPS.md` row, project instructions, and its report path; inline only exceptions or facts not already durable. Do not restate the authority digest or plan in every spawn.

At hard gates, worker summaries are navigation aids, not correctness authority. The parent reviews **actual effects/current code**, but this is global integrated judgment—not duplicate line-by-line implementation review. Inspect the smallest actual code/diff/behavior surface that can test architecture, ethos, integration, and risk; expand only when evidence warrants it.

## 1. Plan before implementation

Read the user request and high-value project authority. For large authority sets, use a Luna/max intake scout to produce a cited digest, then review/adjust it yourself.

Use the companion `WORKSPACE.md` located beside this `SKILL.md` for durable file formats:

- **new run:** read that companion once and create `LunaMaxing/PLAN.md`, `STATE.md`, and phase `STEPS.md`;
- **resume:** do not reread the companion unless recovering ambiguous/damaged state.

`PLAN.md` is the compact durable authority/execution digest. Preserve a structured source plan's meaningful hierarchy. For vague work, create the minimum useful phases/steps yourself; small work may be one phase.

Before implementation define phase goals, step dependencies, phase-end hard gates, any exceptional extra gates, selected adversarial reviews, and the final gate. Replan when real facts justify it; persist consequential decisions.

## 2. Execute steps with Luna/max

The first **real** Luna/max worker spawn doubles as the capability check; do not spend an extra agent call on a dummy probe.

For each dependency-ready step, persist current state and launch one Luna/max owner. The normal handoff can be only a few lines: identify the step, point to durable authority/step/report paths, require the full implementation→verification→self-review→fix→reverify loop, and tell it to escalate only genuine orchestrator decisions.

After an ordinary PASS, read only the report's Control Block, update `STATE.md`/`STEPS.md`, and continue. Read deeper only for a decision request, contradiction, blocker, planned adversary, recovery, or gate.

If Codex rejects Luna/max because of the known multi-agent catalog mismatch, do not downgrade. Read the skill companion `references/CODEX_LUNA_COMPAT.md`, apply only that procedure, validate it, persist restart/resume state, then tell the user to **close and relaunch Codex and open a new task**. Stop execution in the current task; its model-selection schema cannot refresh mid-task.

## 3. Optional fresh-Luna adversary

For a selected risky step, use a fresh Luna/max agent that did not implement it. Point it to the durable principles/step contract plus actual code/diff and verification entry points; do not give it implementer chat/reasoning.

It independently attacks correctness, integration, assumptions, regressions, and principle compliance. It may repair in-scope findings and reverify. Broader design questions return to the orchestrator.

## 4. Hard decisions

Resolve genuine hard questions in this order:

1. explicit user intent;
2. project ethos/core principles and goal;
3. authoritative plan/architecture/contracts;
4. established project evidence/accepted behavior;
5. conservative engineering judgment preserving intent.

Read the minimum evidence needed, record consequential decisions, and delegate implementation consequences back to Luna/max.

## 5. Phase hard gate

When all required phase steps are done, stop normal step execution.

For a nontrivial phase, first spawn a fresh Luna/max **gate scout** to compress the integrated change into a small gate pack: changed surfaces, cross-step interfaces, verification status, highest risks/uncertainties, and exact actual artifacts/checks most worth parent inspection. The scout **does not approve the phase**.

The orchestrator then performs the hard gate: use the gate pack as an index, inspect targeted actual code/diff/behavior, and judge the integrated phase against project ethos, architecture/contracts, phase goal, regressions, and cross-step integration. Broaden only when risk or contradictory evidence requires it.

Persist the terse gate result. Findings become Luna/max repair steps; repeat the gate after material repair. A tiny obvious phase may skip the scout.

## 6. Resume and finish

`STATE.md` always describes reality and contains one exact `next_action`.

Resume by reading only project-level instructions, `STATE.md`, `PLAN.md`, current phase `STEPS.md`, and the one artifact required by `next_action`. Read historical decisions/reports only when explicitly relevant. Never reconstruct history from worker chats.

If interruption left a step `ACTIVE`, do not investigate its partial implementation yourself. Check only whether its report/control block completed. If not, mark the attempt interrupted and launch a fresh Luna/max continuation/recovery worker for the same step against the **current repository state**; it must inspect/adopt/fix partial changes and finish the normal step loop.

At the final gate, judge the integrated result against the whole goal, project ethos/core principles, authoritative plan, architecture/contracts, and required verification. Finish only with no unresolved task-relevant findings.
