---
name: luna-maxing
description: Execute a coding plan or task with Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator and GPT-5.6 Luna max-reasoning workers. The orchestrator understands project ethos, structures work into phases and steps, delegates each step end-to-end, and spends its own reasoning mainly at hard decisions and predefined phase gates.
---

# Luna Maxing

**Minimize orchestrator token use as a primary design goal.** Preserve its context for understanding project intent, planning, hard decisions, integration judgment, and hard gates. Luna/max workers do repository-heavy work.

Read `WORKSPACE.md`. Persist enough state that a fresh orchestrator can resume without reconstructing worker chats.

## Invariants

1. **Workers = Luna Max.** Every technical subagent MUST use `gpt-5.6-luna` with reasoning effort `max`. Never silently fall back.
2. **Project ethos is authority.** The orchestrator must understand the project's goals, ethos, non-negotiable principles, architecture, and accepted behavioral contracts before planning. These principles drive decomposition, ambiguity resolution, tradeoffs, worker instructions, and reviews.
3. **Plan → phases → steps.** Before implementation, normalize the work into coherent phases and bounded steps. Each step has one Luna/max owner.
4. **One worker owns a step end-to-end.** It investigates, implements, verifies, self-reviews, fixes every issue it finds, reverifies, and writes a concise durable report.
5. **Do not micromanage.** Give the step goal, relevant authority/ethos, constraints, dependencies, acceptance boundary, and report path. Let Luna choose ordinary engineering details.
6. **Default orchestrator review cadence = phase end.** Step reports are control/progress inputs, not triggers for parent code review. The parent normally reviews the integrated result only at predefined hard gates.
7. **Optional fresh adversary.** For a complex or high-risk step, the orchestrator may schedule a fresh Luna/max agent to independently attack/review that step's result before the phase gate.
8. **The orchestrator may spend tokens where judgment matters.** It may inspect code, diffs, tests, runtime evidence, or run targeted checks for genuinely difficult decisions and hard gates. Token minimization is not an excuse to avoid expert judgment.
9. **Durable state over chat history.** Plan, authority digest, progress, decisions, reports, gates, and exact next action live in `LunaMaxing/`.
10. **No fake completion.** No stubs, hidden TODOs, test weakening, test-specific hard-coding, skipped integration, or unsupported PASS claims.

## 1. Understand authority and plan the work

Read the authoritative user request/plan plus applicable project instructions (`AGENTS.md`, architecture/decision docs, schemas, accepted design principles, referenced acceptance material).

Extract a **compact authority digest** into `LunaMaxing/PLAN.md`:

- project goal / desired outcome;
- ethos and core principles;
- non-negotiable architecture/behavior constraints;
- authoritative plan/task source;
- important acceptance boundaries.

Do this once and keep it concise. Reuse the digest in worker handoffs instead of repeatedly loading large authority documents. If a later decision depends on detail omitted from the digest, inspect only the relevant source section and update the digest if the fact is broadly reusable.

Then define the execution structure before implementation.

### Structured source plan

If the supplied plan already has phases/tasks, preserve its intent and meaningful hierarchy. Map implementation-sized work into **steps** under coherent **phases**. Do not rewrite an authoritative plan for cosmetic consistency.

### Vague or unstructured task

Create the minimum-sufficient plan yourself:

- phases in dependency order;
- steps within each phase;
- step dependencies and boundaries;
- expected phase outcome;
- **hard gate at each phase end**;
- any additional hard gates genuinely required;
- optional adversarial-review steps for unusually risky/complex work;
- final completion gate.

A small task may be one phase. Do not manufacture phases or reviews solely for ceremony.

If broad repository discovery is needed to plan implementation details, make discovery a Luna/max step. The parent should learn repository-scale facts from a concise durable worker report rather than consuming a large exploration itself.

### Definitions

A **phase** produces an integrated milestone meaningful enough for the orchestrator to review against project principles and the phase goal.

A **step** is the largest coherent unit one Luna/max worker can safely own end-to-end. Split when dependency order, overlapping writes, independently meaningful outcomes, or excessive scope require it.

A **hard gate** is an explicit point where the orchestrator spends its own expertise reviewing actual effects/current code against the project ethos, plan, and gate goal. Phase ends are hard gates by default.

Persist the plan, gates, and exact next action before implementation. The orchestrator may revise the plan when real implementation facts justify it; record consequential changes in `DECISIONS.md`.

## 2. Ensure Luna/max is spawnable

Explicitly request a tiny fresh subagent with:

- model: `gpt-5.6-luna`
- reasoning effort: `max`

If it works, proceed. If Luna is rejected/ineligible because of the known Codex multi-agent catalog mismatch, **do not downgrade**. Read `references/CODEX_LUNA_COMPAT.md` and apply only that narrow procedure.

If this task changes Codex configuration/catalog metadata, validate it, then stop and tell the user to **close and relaunch Codex and open a new task**. The current task cannot refresh its model-selection schema. Do not claim Luna workers are available until a new task proves a Luna/max spawn.

## 3. Execute steps through Luna/max

Before each launch, update `STATE.md` and the phase `STEPS.md` so they describe reality and the assigned report path.

Use a compact handoff equivalent to:

> Own this step end-to-end. Follow the supplied project ethos/core principles, authoritative plan, project instructions, and existing architecture. Achieve the step goal completely. Inspect whatever surrounding code is necessary to avoid regressions. Implement, run relevant verification, review your own resulting diff and behavior, fix every issue you find, and reverify. Do not stop at analysis or suggestions. Write the concise Luna Maxing report at `<report-path>`. Escalate only a genuine decision not resolvable from the supplied authority or project evidence.

Include only minimum-sufficient task facts plus exact paths to durable plan/authority material. Do not paste large documents when a path/digest suffices.

Then let the worker work. Do not repeatedly steer it unless it is blocked, contradicts authority, collides with another step, or requests a genuine orchestrator decision.

When it finishes, read the concise report and update durable state. **Do not routinely inspect that step's implementation.** Continue to the next dependency-ready step unless:

- the report requests a hard decision;
- observable state contradicts the report;
- the planned adversarial-review policy applies;
- the next action is a hard gate.

## 4. Optional fresh-Luna adversarial review

During planning, mark unusually complex/risky steps for adversarial review when the extra independent context is worth the cost. The orchestrator may also add one later if risk emerges.

Spawn a **fresh Luna/max agent that did not implement the step**. Give it:

- relevant ethos/core principles;
- step goal and acceptance boundary;
- baseline/current repository or diff;
- relevant project authority and verification entry points;
- its own report path.

Do not give it the implementer's chat, reasoning, or self-justifying narrative. The implementation report may be used only as a terse scope locator, not correctness evidence.

Instruction equivalent to:

> Adversarially review this completed step from the actual code and effects. Look for substantive bugs, regressions, incomplete integration, violated project principles, wrong assumptions, and missed requirements. Run targeted verification as needed. If defects are within the step's intended scope, fix them completely, verify, self-review the repaired result, and reverify. Escalate only findings that require a true orchestrator decision or broader replanning. Write a concise durable report.

This is **optional**, not the default after every step. The phase hard gate remains the orchestrator's integrated review point.

## 5. Hard decisions

When a worker raises a genuine ambiguity or conflicting facts emerge, the orchestrator uses its expertise.

Read the minimum additional evidence needed. Resolve the issue in this order:

1. explicit user intent;
2. project ethos/core principles and goals;
3. authoritative plan and architecture/contracts;
4. established project evidence and accepted behavior;
5. conservative engineering judgment preserving intent.

Record consequential decisions in `DECISIONS.md`, update the plan/state if needed, and delegate implementation consequences back to Luna/max.

Do not spend parent tokens deciding ordinary implementation details a Luna worker can resolve from project authority.

## 6. Phase hard gate

When every required step in a phase is complete, **stop step execution and perform the planned phase gate**.

This is the normal point where the orchestrator deliberately spends meaningful reasoning/context.

Review from **actual effects and current repository state**, not worker confidence:

- project goal, ethos, and core principles;
- phase goal and acceptance boundary;
- authoritative architecture/contracts;
- baseline versus current diff/state;
- changed code and enough surrounding integration paths to judge the phase as a whole;
- actual behavior and verification needed to establish correctness.

Worker reports help locate work and summarize verification, but their conclusions are not correctness proof for the gate. Do not load worker conversations or private reasoning.

Look specifically for cross-step integration problems, architectural drift, missed phase requirements, regressions, wrong abstractions, and behavior inconsistent with project ethos even if individual steps look locally correct.

Write the concise hard-gate record defined in `WORKSPACE.md`.

If findings exist, create repair step(s), delegate them to Luna/max, and repeat the gate after material repair. Do not begin the next phase until the current gate passes unless the authoritative plan explicitly permits overlap.

## 7. Resume and finish

Keep `STATE.md` current and always persist one exact `next action`. Keep `HANDOVER.md` compact and update it at phase transitions, consequential decisions, blockers, plan/gate changes, and before session/context replacement.

On resume, read only:

1. applicable project instructions;
2. `LunaMaxing/HANDOVER.md`;
3. `LunaMaxing/STATE.md`;
4. `LunaMaxing/PLAN.md`;
5. current phase `STEPS.md` and only the reports/decisions needed for the exact next action.

Do not reconstruct history from old worker chats or reread every prior report.

At the final gate, review the integrated result against the **whole project/task goal, ethos/core principles, authoritative plan, and required verification**. Complete only when no task-relevant findings remain.
