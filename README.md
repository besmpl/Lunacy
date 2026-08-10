# Luna Maxing

A compact plan/task execution skill for using **Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a lean expert orchestrator** while **GPT-5.6 Luna at max reasoning owns implementation work**.

The orchestrator deliberately minimizes its own token use, but it is not reduced to a dumb router. Its expensive reasoning is reserved for the places where it has leverage: decomposition, dependency/order choices, difficult plan interpretation, architecture/integration tradeoffs, conflicting evidence, blocker disposition, and hard reviews.

Luna/max workers own the rest end-to-end:

- inspect the necessary repository context;
- implement the assigned work;
- verify it;
- review their own resulting code and behavior;
- fix every issue they find;
- rerun verification;
- write a concise durable report for the orchestrator.

The orchestrator does not micromanage those implementation choices.

## Durable work structure

Luna Maxing borrows the useful continuity pattern from DeepSeek and Destroy, but intentionally removes most of its heavier review/proof bureaucracy.

Each project run gets a small workspace:

```text
LunaMaxing/
  STATE.md
  DECISIONS.md
  HANDOVER.md
  phases/
    <phase-id>/
      TASKS.md
      reports/
        <task-id>-01.md
      hard-review-01.md
```

`STATE.md` records current reality and one exact next action. `TASKS.md` records the current decomposition and worker/report paths. Workers write concise reports instead of making the parent consume their full context. `DECISIONS.md` contains only consequential decisions where the orchestrator actually used its expertise. `HANDOVER.md` is a compact resume packet, not a second execution log.

See `WORKSPACE.md` for the exact lightweight contract and report format.

## Hard reviews

The orchestrator decides when a meaningful hard review is warranted. This is where it is expected to spend its own reasoning and tokens.

The review is based on:

- the actual task or phase goals;
- project/architecture authority;
- the real repository diff/current code;
- enough surrounding integration code to judge effects;
- actual behavior and verification.

It does **not** judge correctness from worker chat history, private reasoning, or self-justifying narratives. A worker report may tell it what changed, but the hard review evaluates the resulting state directly.

If the orchestrator finds problems, it sends the findings back to Luna/max. The worker owns the full repair, verification, self-review, additional fixes, and re-verification loop; the orchestrator then re-gates the result when needed.

## Install

Clone this repository so `SKILL.md` is the root file of a Codex skill directory:

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/frozenpepper/Luna-Maxing.git ~/.agents/skills/luna-maxing
```

If the skill does not appear, restart Codex.

## Use

```text
Use $luna-maxing to execute the authoritative plan at PLAN.md.
```

or:

```text
Use $luna-maxing for this task. Keep the parent context lean and let Luna/max workers own implementation and self-review/fix loops.
```

## Worker invariant

Every spawned technical worker must use:

```text
model: gpt-5.6-luna
reasoning_effort: max
```

There is no silent fallback to another model or reasoning effort.

## Codex compatibility note

Some Codex installations may expose Luna in the model catalog but not allow it to be selected as a subagent because Luna's cached `multi_agent_version` is still `v1` while the active multi-agent protocol is `v2`.

The skill first attempts native Luna/max spawning. Only if that fails for this known eligibility reason does it use:

```text
references/CODEX_LUNA_COMPAT.md
```

That procedure copies the current catalog and changes **only** Luna's multi-agent version from `v1` to `v2`. It does not change Luna's model identity or add unsupported reasoning levels. Luna retains `max` and does **not** gain Sol/Terra-only `ultra` support.

If the compatibility override is installed or changed, **Codex must be closed and relaunched and a new task opened** before Luna subagents can be tested. The already-open task cannot refresh its model-selection tool schema.

The override pins Codex to a local catalog snapshot and should be removed once upstream Codex exposes Luna natively with the required multi-agent protocol.

## Files

```text
SKILL.md                         Core orchestration protocol.
WORKSPACE.md                     Lightweight durable run state and worker-report contract.
references/CODEX_LUNA_COMPAT.md Narrow Codex compatibility setup, validation, restart, maintenance, and rollback.
README.md                        Installation and usage.
```
