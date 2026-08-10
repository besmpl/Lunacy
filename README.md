# Luna Maxing

A compact execution skill for using **Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator** while **GPT-5.6 Luna at max reasoning owns implementation work**.

The central optimization is simple: **minimize orchestrator token usage aggressively so its expensive context and reasoning remain available for the decisions that actually need them.**

The orchestrator therefore:

- first understands the project's goal, ethos, core principles, architecture, and non-negotiable contracts;
- converts the requested work into a durable **plan → phases → steps** structure when one is not already supplied;
- assigns each implementation step to one Luna/max worker;
- reads concise worker reports rather than worker transcripts;
- normally does **not** inspect/review code after every step;
- spends its own expertise at genuine hard decisions and predefined **phase-end hard gates**;
- may schedule a **fresh Luna/max adversarial reviewer** for an unusually complex or high-risk step;
- persists enough state that execution can stop and resume without reconstructing history from chat context.

## Project ethos drives execution

Project principles are not decorative context. During intake the orchestrator extracts a concise durable authority digest containing:

- the project goal;
- ethos and core principles;
- non-negotiable architecture/behavior contracts;
- authoritative plan/task and design sources;
- important acceptance boundaries.

Those principles drive decomposition, worker instructions, ambiguity resolution, architecture/integration tradeoffs, and phase-gate reviews.

The digest is stored in `LunaMaxing/PLAN.md`, allowing both workers and a resumed orchestrator to reuse a compact authoritative summary instead of repeatedly loading large design documents.

## Plan → phases → steps

If the supplied plan already has meaningful phases, Luna Maxing preserves them and maps implementation work into steps.

If the request is vague, the orchestrator first creates the minimum useful execution plan itself. A phase is an integrated milestone; a step is the largest coherent unit one Luna/max worker can safely own end-to-end.

Each step worker must:

1. inspect the necessary repository context;
2. implement the goal completely;
3. verify it;
4. review its own resulting code and behavior;
5. fix every issue it finds;
6. reverify;
7. write a short durable report.

The orchestrator does not micromanage ordinary implementation choices.

## Review cadence

**The default orchestrator hard-review cadence is phase end, not every step.**

Step reports are progress/control inputs. Once all required steps of a phase are complete, the orchestrator reviews the integrated result against:

- project ethos/core principles;
- phase goal and authoritative plan;
- architecture/contracts;
- actual current code and integrated diff;
- surrounding integration paths;
- runtime behavior and verification needed to judge correctness.

This is an intentional use of the orchestrator's preserved context.

For a particularly risky step, the orchestrator may additionally spawn a **fresh Luna/max adversary** that did not implement the step. That agent independently attacks the resulting code/effects, can repair in-scope defects it finds, verifies the repaired result, and writes a concise report. This is optional, not a mandatory per-step ceremony.

## Durable resumable work structure

```text
LunaMaxing/
  PLAN.md
  STATE.md
  DECISIONS.md
  HANDOVER.md
  phases/
    <phase-id>/
      STEPS.md
      reports/
        <step-id>-worker-01.md
        <step-id>-adversary-01.md
      hard-gate-01.md
```

`PLAN.md` contains the authority/ethos digest plus phases, steps, and planned gates. `STATE.md` contains current reality and one exact next action. `STEPS.md` records phase-local progress and report paths. `DECISIONS.md` contains only consequential orchestrator decisions. `HANDOVER.md` is a compact restart packet.

Workers normally keep reports to roughly 25 lines. The parent should consume these durable summaries instead of full agent conversations.

On resume, the orchestrator reads only project instructions, `HANDOVER.md`, `STATE.md`, `PLAN.md`, the current phase `STEPS.md`, and whatever report/decision/gate is needed for the persisted next action. It does not replay historical worker chats.

See `WORKSPACE.md` for the exact formats.

## Worker invariant

Every technical subagent must use:

```text
model: gpt-5.6-luna
reasoning_effort: max
```

There is no silent fallback.

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
Use $luna-maxing for this task. Preserve orchestrator context; plan phases/steps first, then delegate each step to Luna/max.
```

## Codex Luna compatibility

Some Codex installations may expose Luna in the model catalog but not allow it as a subagent because Luna's cached `multi_agent_version` is still `v1` while the active multi-agent protocol is `v2`.

The skill first attempts native Luna/max spawning. Only for that known eligibility failure does it use:

```text
references/CODEX_LUNA_COMPAT.md
```

The compatibility procedure preserves the current catalog and changes **only** Luna's multi-agent version from `v1` to `v2`. Luna retains `max`; it does **not** gain Sol/Terra-only `ultra` support.

If that override is installed or changed, **close and relaunch Codex and open a new task** before testing Luna subagents. An already-open task cannot refresh its model-selection tool schema.

The local catalog override should be removed once upstream Codex exposes Luna natively with the required protocol.

## Files

```text
SKILL.md                         Core orchestration protocol.
WORKSPACE.md                     Durable plan/state/report/gate/resume contract.
references/CODEX_LUNA_COMPAT.md Narrow Codex compatibility procedure.
README.md                        Installation and execution model.
```
