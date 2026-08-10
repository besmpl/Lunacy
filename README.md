# Luna Maxing

A deliberately small plan/task execution skill for using **Codex, GPT-5.6 Sol, or GPT-5.6 Terra as the orchestrator** while **GPT-5.6 Luna at max reasoning owns the technical work**.

The design is simple:

- keep the expensive/main context clean and small;
- hand coherent work units to Luna/max agents instead of micromanaging them;
- require each worker to implement, verify, self-review, and fix its own work;
- let the orchestrator decide when a meaningful hard review is warranted;
- perform hard reviews with a **fresh Luna/max context** that judges the resulting code, behavior, diff, tests, and task goals—not the implementer's conversation or reasoning.

## Install

Clone this repository so `SKILL.md` is the root file of a Codex skill directory. For a user-scoped installation:

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/frozenpepper/Luna-Maxing.git ~/.agents/skills/luna-maxing
```

Codex normally discovers skill changes automatically. If the skill does not appear, restart Codex.

## Use

Explicit invocation is recommended for plan execution:

```text
Use $luna-maxing to execute the authoritative plan at PLAN.md.
```

or:

```text
Use $luna-maxing for this task. Keep the parent context lean and let Luna/max workers own implementation and review/fix loops.
```

## Worker invariant

Every spawned technical worker is required to use:

```text
model: gpt-5.6-luna
reasoning_effort: max
```

There is no silent fallback to a cheaper effort or another model.

## Codex compatibility note

Some Codex installations may expose Luna in the model catalog but not allow it to be selected as a subagent because Luna's cached `multi_agent_version` is still `v1` while the active multi-agent protocol is `v2`.

The skill first attempts native Luna/max spawning. Only if that fails for this known eligibility reason does it use the narrow procedure in:

```text
references/CODEX_LUNA_COMPAT.md
```

That procedure copies the current catalog and changes **only** Luna's multi-agent version from `v1` to `v2`. It does not change Luna's model identity or add unsupported reasoning levels. In particular, Luna keeps `max` and does **not** gain Sol/Terra-only `ultra` support.

If the compatibility override is installed or changed, **Codex must be closed and relaunched and a new task opened** before Luna subagents can be tested. The already-open task cannot refresh its model-selection tool schema.

The override pins Codex to a local catalog snapshot, so it should be removed once upstream Codex exposes Luna natively with the required multi-agent protocol.

## Files

```text
SKILL.md                         Core execution rules; intentionally concise.
references/CODEX_LUNA_COMPAT.md Narrow Codex compatibility setup, validation, restart, maintenance, and rollback.
README.md                        Installation and usage.
```
