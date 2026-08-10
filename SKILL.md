---
name: luna-maxing
description: Execute a coding plan or task with Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator and only GPT-5.6 Luna subagents at max reasoning. Preserve parent context for project intent, planning, hard decisions, and phase gates; delegate repository-heavy work end-to-end.
---

# Luna Maxing

**Primary optimization: minimize orchestrator token use.** The parent owns global understanding and judgment. Luna/max owns repository-scale execution.

Every technical subagent MUST be `gpt-5.6-luna` with reasoning effort `max`. Never silently fall back.

## Core model

1. **Understand intent before implementation.** The orchestrator must understand the project goal, ethos, core principles, non-negotiable contracts, and authoritative plan well enough to let them drive decisions.
2. **Plan → phases → steps.** A phase is an integrated milestone. A step is the largest coherent unit one Luna/max worker can safely own end-to-end. One implementation worker owns each step.
3. **Workers finish their own loop.** Inspect context → implement → verify → self-review → fix findings → reverify → write a terse durable report.
4. **Do not micromanage.** Supply goal, relevant principles/authority, boundaries, dependencies, acceptance boundary, and report path. Let Luna resolve ordinary engineering details.
5. **Default parent review cadence = phase end, not step end.** Step reports control progress. The parent does not normally reread each implementation.
6. **Optional adversary for risky steps.** A fresh Luna/max agent may independently attack a completed high-risk step. This is selective, not mandatory.
7. **Parent reasoning is reserved for leverage.** Use it for planning, architecture/integration tradeoffs, genuine ambiguity, conflicting evidence, scope changes, blocker disposition, and hard gates.
8. **No fake completion.** No stubs, hidden TODOs, test weakening, test-specific hard-coding, skipped integration, or unsupported PASS claims.

## Token-economy rules

- Do not bulk-read the repository, long logs, worker transcripts, or all historical reports.
- Prefer compact durable control files and exact paths over pasted context.
- Read only the source sections needed for the current decision.
- If broad discovery or document ingestion would consume substantial parent context, delegate it to Luna/max and require a compact cited digest. The orchestrator still makes the plan/decision and spot-checks source authority as needed.
- Worker reports and gate packs are locators/evidence summaries, not substitutes for parent judgment at a hard gate.
- A hard gate is **global integrated judgment, not routine line-by-line review**. Inspect actual code/diff/behavior selectively where it best tests architecture, ethos, integration, and risk. Expand only when evidence warrants it.

## 1. Intake and planning

Read the user request and high-value project authority (`AGENTS.md`, authoritative plan, key architecture/decision sources). For large authority sets, use a Luna/max intake scout to draft a compact digest with source pointers; review/adjust that digest yourself rather than loading everything blindly.

Create or resume `LunaMaxing/` using `WORKSPACE.md`.

- **New run:** read `WORKSPACE.md` once, then create `PLAN.md`, `STATE.md`, and phase `STEPS.md` files.
- **Existing run:** do **not** reread `WORKSPACE.md` unless recovery or format ambiguity requires it. Resume from `STATE.md`, `PLAN.md`, current `STEPS.md`, and only the artifact named by `next_action`.

`PLAN.md` is the compact authority/execution digest. Keep durable project principles there so the parent and workers do not repeatedly reload large source documents.

If the source plan is structured, preserve its meaningful hierarchy. If the request is vague, define the minimum useful phases and steps yourself. Small work may be one phase.

Before implementation, define:

- phase goals;
- steps and dependencies;
- phase-end hard gates;
- any additional true hard gates;
- optional adversarial reviews for unusually risky steps;
- final completion gate.

The orchestrator may replan when implementation facts justify it. Persist consequential changes in `DECISIONS.md`.

## 2. Execute steps

The **first real Luna/max worker spawn** also proves Luna is usable; do not spend an extra agent call on a dummy probe.

If Codex rejects Luna/max because of the known multi-agent catalog mismatch, do not downgrade. Read `references/CODEX_LUNA_COMPAT.md`, apply only that narrow procedure, validate it, then tell the user to **close and relaunch Codex and open a new task**. Stop execution in the current task because its model-selection schema cannot refresh mid-task.

For each dependency-ready step, update state and launch one Luna/max owner with a compact instruction equivalent to:

> Own this step end-to-end. Follow the supplied project ethos/core principles, authoritative goal, project rules, and existing architecture. Implement the step completely; inspect enough surrounding code to avoid regressions; run relevant verification; review your own resulting diff/behavior; fix every issue you find; reverify; and write the Luna Maxing report at `<report-path>`. Resolve ordinary engineering choices yourself from project authority. Escalate only a genuine decision requiring orchestrator judgment.

Pass minimum-sufficient facts and paths. Do not paste large documents when a digest/path suffices.

After a normal PASS, read only the report's compact control block, update `STATE.md`/`STEPS.md`, and continue. Inspect deeper only for a decision request, contradiction, blocker, planned adversary, or gate.

## 3. Optional fresh-Luna adversary

For a step marked high-risk/complex, spawn a fresh Luna/max agent that did not implement it. Give it the relevant principles, step goal, actual code/diff, verification entry points, and its own report path—not the implementer's reasoning or chat.

It independently searches for substantive bugs, regressions, incomplete integration, principle violations, and missed requirements. It may fix in-scope findings, verify, self-review the repair, and reverify. Broader design questions go to the orchestrator.

## 4. Hard decisions

Resolve genuine hard questions using, in order:

1. explicit user intent;
2. project ethos/core principles and goal;
3. authoritative plan/architecture/contracts;
4. established project evidence and accepted behavior;
5. conservative engineering judgment preserving intent.

Read only the minimum evidence needed. Record consequential decisions in `DECISIONS.md`; delegate resulting implementation back to Luna/max.

## 5. Phase gate

When all required phase steps are done, stop normal step execution.

For a nontrivial phase, first spawn a fresh Luna/max **gate scout**. It reads the phase reports, integrated diff/current state, relevant tests, and project principles and writes a very small gate pack containing:

- phase outcome and changed surfaces;
- cross-step interfaces/integration points;
- verification status;
- highest-risk areas/uncertainties;
- exact files/symbols/diff regions and commands the parent should inspect.

The gate scout does not approve the phase. It compresses discovery so the parent knows where to spend tokens.

Then the orchestrator performs the hard gate from actual current state. Read the compact gate pack, inspect the most decision-relevant actual code/diff/behavior, and judge the integrated phase against project ethos, architecture/contracts, phase goal, regressions, and cross-step integration. Broaden inspection only when risk or contradictory evidence justifies it.

Write the terse gate record. If findings exist, create Luna/max repair step(s), then repeat the gate after material repair. Do not advance past a failed required gate.

For a tiny phase whose changed surface is already obvious, skip the gate scout and review directly.

## 6. Resume and finish

`STATE.md` must always describe reality and contain one exact `next_action`.

Resume by reading only:

1. applicable project-level instructions;
2. `LunaMaxing/STATE.md`;
3. `LunaMaxing/PLAN.md`;
4. current phase `STEPS.md`;
5. only the report, decision, or gate artifact required by `next_action`.

Do not reconstruct history from chats or old reports. Read `DECISIONS.md` only by relevant referenced entry when needed.

At the final gate, judge the integrated result against the whole task goal, project ethos/core principles, authoritative plan, architecture/contracts, and required verification. Finish only with no unresolved task-relevant findings.
