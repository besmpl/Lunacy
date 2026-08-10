---
name: luna-maxing
description: Execute a concrete coding plan or task with Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a lean orchestrator and only GPT-5.6 Luna subagents at max reasoning. Use when workers should own implementation, verification, self-review, and fixes while the parent preserves context for decomposition, decisions, and occasional effect-based hard review gates.
---

# Luna Maxing

Keep the parent thread small. The parent orchestrates; Luna workers do the technical work.

## Non-negotiable rules

1. **Parent = orchestrator.** Understand the task/plan, dependencies, project authority, acceptance criteria, and integration risks. Decide work boundaries and when a hard review is warranted. Do not absorb routine implementation, repository exploration, testing, or worker-level review work.
2. **Workers = Luna Max.** Every spawned technical agent MUST use `gpt-5.6-luna` with `model_reasoning_effort = "max"`. Never silently fall back to another model or effort.
3. **Minimize parent tokens aggressively.** Read only what is needed to steer the work. Prefer compact worker results and targeted evidence over logs, transcripts, or broad codebase rereads. Never duplicate investigation a worker can own.
4. **Delegate ownership, not keystrokes.** Give a worker the goal, scope, constraints, project rules, acceptance criteria, and verification boundary. Do not prescribe line-by-line implementation or repeatedly steer a competent worker unless it is blocked or materially off-course.
5. **Each worker finishes its own loop.** It must inspect enough context, implement completely, run relevant verification, review its own resulting diff/behavior, fix every issue it finds, and rerun verification before returning.
6. **No fake completion.** No stubs, hidden TODOs, test weakening, hard-coded test tricks, or skipped required integration. Preserve established architecture and accepted behavior unless the task explicitly changes them.
7. **Hard review = orchestrator judgment from effects.** When the parent chooses a hard gate, it reviews the actual resulting repository state, changed code, observable behavior, verification, and task/phase goals. It MUST NOT open, import, or rely on worker chat context, reasoning, transcripts, or self-justifying implementation reports for that review.

## Execution

### 1. Intake

Read the user request or authoritative plan plus applicable project instructions (`AGENTS.md`, architecture/decision docs, and referenced acceptance material). Resolve ordinary engineering details from project authority. Escalate only genuine product/architecture ambiguity, missing authorization, or unavailable required resources.

Split work into the largest coherent units a Luna/max worker can own end-to-end. Parallelize only genuinely independent work; serialize overlapping writes and dependency chains.

### 2. Ensure Luna/max is actually spawnable

In Codex, explicitly request a tiny fresh subagent with:

- model: `gpt-5.6-luna`
- reasoning effort: `max`

If native spawning works, proceed. If Luna is rejected as a subagent or is ineligible because of its multi-agent catalog metadata, **do not downgrade**. Read `references/CODEX_LUNA_COMPAT.md` and apply that narrow compatibility procedure.

If this task changes `~/.codex/config.toml` or installs/changes the Luna catalog override, stop after validation and tell the user to **close and relaunch Codex and open a new task**. The already-open task cannot refresh its model-selection tool schema. Do not claim Luna subagents are live until a new task proves a native Luna/max spawn.

### 3. Worker handoff

Use a short ownership prompt, adapted only with task-specific facts:

> Own this work unit end-to-end. Follow the project instructions and existing architecture. Achieve the stated goal completely, inspect the surrounding code needed to avoid regressions, implement the work, run the relevant verification, then review your own resulting diff and behavior against the goal. Fix every issue you find and rerun verification. Do not stop at analysis or suggestions. Return only a compact result: outcome, changed paths, verification performed, and any genuine unresolved blocker.

Then let the worker work. Do not micromanage it.

### 4. Parent handling of worker results

Consume the worker's compact result first. Inspect deeper evidence only when needed to resolve a contradiction, blocker, scope collision, or integration decision. The parent should not routinely reread the worker's full code path or rerun its tests.

Continue dependency-ready work. Do not force a hard review after every trivial edit.

### 5. Hard review gate

The parent decides when accumulated work deserves a hard review. Use one at least for meaningful phase/task completion and earlier when changes cross important interfaces, persistence/schema boundaries, concurrency/security boundaries, or several worker units must integrate.

For the hard review, **ignore worker-thread context**. Work from:

- the task/phase goals and acceptance criteria;
- applicable project/architecture rules;
- the baseline/ref and actual current repository/diff;
- the changed code plus enough surrounding call paths to judge integration;
- observable outputs and the verification needed to judge effects.

The orchestrator directly checks for substantive bugs, regressions, incomplete wiring, architectural violations, missed requirements, and behavior that does not achieve the goal. Run targeted or full verification when needed to establish the result rather than trusting worker claims.

If the hard review finds issues, do **not** micromanage the repair. Spawn a Luna/max worker with the findings, affected goal, relevant constraints, and required verification. Make it own the repair end-to-end: fix, test, self-review, fix anything else it finds, and verify again.

Then hard-review the resulting state again when the changes are material or the gate remains unresolved. Again judge the code/effects against the goal, never the worker's internal context.

### 6. Finish

At the final boundary, the orchestrator performs a clean effect-based hard review plus the plan's required final verification. Complete only with no unresolved task-relevant findings. Report the delivered result, verification, and genuine remaining blockers concisely.
