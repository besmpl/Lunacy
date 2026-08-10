---
name: luna-maxing
description: Execute a concrete coding plan or task with Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a lean expert orchestrator and only GPT-5.6 Luna subagents at max reasoning. Workers own implementation, verification, self-review, and fixes; the parent preserves tokens for decomposition, hard decisions, integration judgment, and effect-based hard reviews.
---

# Luna Maxing

The parent is an **expert orchestrator, not a routine implementer**. Spend its context and reasoning only where they add leverage. Luna/max workers do the repository-heavy work.

Read `WORKSPACE.md` and use its lightweight durable state/report structure.

## Core rules

1. **Workers = Luna Max.** Every spawned technical agent MUST use `gpt-5.6-luna` with `model_reasoning_effort = "max"`. Never silently fall back.
2. **Workers own complete work units.** A worker investigates enough context, implements, verifies, reviews its own resulting code/behavior, fixes every issue it finds, reruns verification, and writes a concise durable report.
3. **Do not micromanage.** Give goals, boundaries, relevant authority, constraints, acceptance criteria, dependencies, and report path. Let Luna decide ordinary implementation details.
4. **Minimize parent token use aggressively.** Prefer `STATE.md`, `TASKS.md`, concise worker reports, diffs, and targeted evidence over broad repository reading or worker transcripts.
5. **But the parent has judgment freedom.** Token minimization is a budget principle, not a prohibition. The orchestrator MAY inspect code, diffs, tests, runtime evidence, or run targeted commands when its own expertise is needed for a difficult architectural/product/integration decision or hard review. Do not delegate a hard decision merely to save tokens.
6. **Parent reasoning is for leverage points.** Use it for decomposition, dependency/order choices, ambiguous plan interpretation, conflicting evidence, architecture/integration tradeoffs, cross-worker collisions, scope changes, blocker disposition, and hard reviews. Routine coding/debugging/testing stays with workers.
7. **No fake completion.** No stubs, hidden TODOs, test weakening, hard-coded test tricks, skipped integration, or unsupported PASS claims.

## Execution

### 1. Intake and durable state

Read the authoritative task/plan plus applicable project instructions (`AGENTS.md`, architecture/decision docs, referenced acceptance material).

Create or resume the `LunaMaxing/` workspace defined in `WORKSPACE.md`. Record the authoritative plan/task, current phase, decomposition, statuses, and one exact `next action`.

Use the largest coherent work units Luna/max can own end-to-end. Parallelize only genuinely independent units; serialize dependency chains and overlapping writes.

The orchestrator may revise the decomposition as real implementation facts emerge. Do not preserve a bad split merely because it was written earlier.

### 2. Ensure Luna/max is spawnable

Explicitly request a tiny fresh subagent with:

- model: `gpt-5.6-luna`
- reasoning effort: `max`

If it works, proceed. If Luna is rejected/ineligible because of the known Codex multi-agent catalog mismatch, **do not downgrade**. Read `references/CODEX_LUNA_COMPAT.md` and apply only that narrow procedure.

If this task changes Codex configuration/catalog metadata, validate it, then stop and tell the user to **close and relaunch Codex and open a new task**. The current task cannot refresh its model-selection schema. Do not claim Luna workers are available until a new task proves a native Luna/max spawn.

### 3. Spawn workers with ownership

Before launch, update `STATE.md` / `TASKS.md` so they describe the work actually being assigned.

Use a short task-specific handoff equivalent to:

> Own this work unit end-to-end. Follow the authoritative plan/task, project instructions, and existing architecture. Achieve the stated goal completely. Inspect whatever surrounding code is necessary to avoid regressions. Implement the work, run relevant verification, then review your own resulting diff and behavior against the goal. Fix every issue you find and rerun verification. Do not stop at analysis or suggestions. Write the concise report at `<report-path>` using the Luna Maxing report format. Escalate only a genuine decision that cannot be resolved from project authority.

Then let the worker work. Do not repeatedly steer it unless it is blocked, contradicts authority, collides with another unit, or asks for a genuine orchestrator decision.

### 4. Consume reports, not worker context

When a worker finishes, read its concise report. Update durable state immediately.

For ordinary successful work, the report plus mechanical scope/diff awareness is enough to continue. Do not routinely replay the worker's investigation, reread its entire code path, or rerun all tests.

If the report raises a genuine hard question, inspect the minimum additional project evidence needed, make the decision yourself, append it to `DECISIONS.md`, update affected tasks, and send the decision back to Luna/max for execution.

If the worker report is incomplete, contradictory, or its claimed result conflicts with observable repository state, investigate only enough to classify the problem, then route implementation/repair back to Luna/max.

### 5. Hard review gate

The orchestrator decides when accumulated work deserves a hard review. Use one at meaningful task/phase completion and earlier when changes cross important interfaces, schema/persistence boundaries, concurrency/security boundaries, public contracts, or several worker units integrate.

This is where the parent's expertise is intentionally spent.

For the hard review, judge from **effects and current code**, not worker context:

- task/phase goals and acceptance criteria;
- project/architecture authority;
- baseline versus current repository/diff;
- changed code and enough surrounding call paths to judge integration;
- actual behavior and verification needed to establish correctness.

Do **not** use worker chat history, private reasoning, transcripts, or self-justifying narrative as correctness evidence. Worker reports may identify changed scope, but their conclusions do not substitute for the hard review.

The orchestrator may directly inspect code and run targeted or full checks here. Look for substantive bugs, regressions, incomplete wiring, architectural violations, wrong assumptions, and missed task goals.

Write the concise hard-review record defined in `WORKSPACE.md`.

If findings exist, create/mark repair work and give the findings plus goal/constraints to Luna/max. The repair worker again owns implementation → verification → self-review → additional fixes → re-verification. Then re-gate the resulting state when material.

### 6. Continuity and finish

Keep `STATE.md` current. Keep `DECISIONS.md` limited to consequential orchestrator decisions. Keep `HANDOVER.md` compact and update it when resume semantics materially change.

At final completion, the orchestrator performs the final effect-based hard review and required plan verification. Finish only when the task/plan goals are satisfied and no unresolved task-relevant findings remain.

Report the delivered result, verification, consequential decisions, and genuine remaining blockers concisely.
