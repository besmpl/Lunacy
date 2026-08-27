# Codex Luna subagent compatibility

Read this file **only** when Codex cannot natively spawn the intended `gpt-5.6-luna` worker at Lunacy's selected `xhigh` or `max` reasoning effort.

This is a narrow compatibility override for the known catalog mismatch where Luna is otherwise valid but advertises `multi_agent_version = "v1"` while Sol and Terra use `v2`. It changes Luna's multi-agent eligibility metadata only.

This procedure belongs only to Lunacy's selected direct `luna` route. It does not apply to `sol-high`, does not change the selected worker route, and does not alter the private managed runtime's separately attested Sol `codex exec` policy. A failed `sol-high` selection blocks; it never enters this procedure.

## First: prove the override is needed

Attempt the intended real Luna worker first at the effort selected by Lunacy (`xhigh` normally, `max` when justified). If native spawning works, do nothing here.

Do not apply this procedure when the catalog shape or failure is materially different. Retry only the unchanged selected Luna model/effort after the required restart; do not downgrade or substitute another worker route.

## Invariants

- Preserve the current Codex catalog snapshot as-is except for Luna's `multi_agent_version`.
- Change **only** Luna from `"v1"` to `"v2"`.
- Do not change Luna's slug, model identifier, tool mode, context metadata, reasoning levels, or any other property.
- Luna must retain both `xhigh` and `max` reasoning support from the source snapshot.
- **Do not add `ultra` to Luna.**
- Do not change the user's primary `model` or primary `model_reasoning_effort`.
- Use an absolute path in `model_catalog_json`; TOML does not expand `~` or `$HOME` inside a quoted value.

## Install

Let:

```text
CONFIG   = ~/.codex/config.toml
OVERRIDE = ~/.codex/model_catalog.luna-v2.json
BACKUP   = ~/.codex/config.toml.pre-luna-v2-<timestamp>
```

Use the actual absolute paths on disk.

1. **Inspect existing configuration.** If `model_catalog_json` already exists, inspect it before changing anything. If it is an unrelated custom catalog, do not overwrite it silently; report the conflict.
2. **Back up `config.toml`.** Preserve the original before editing.
3. **Locate the exact current model-catalog snapshot Codex is using/caching.** Verify that it parses and contains the current Sol, Terra, and Luna entries. Do not synthesize a catalog from documentation or memory.
4. **Copy that snapshot byte-for-byte** to `model_catalog.luna-v2.json`.
5. In the copied file, change only Luna's value:

```diff
 "slug": "gpt-5.6-luna"
-"multi_agent_version": "v1"
+"multi_agent_version": "v2"
```

6. Diff the source snapshot against the override. The only semantic/textual change must be Luna's `multi_agent_version` value. If anything else moved, restore the copy and make the edit more surgically.
7. Add one top-level setting near the start of `config.toml` using the absolute override path:

```toml
# Local compatibility override: expose Luna on the same multi-agent protocol as Sol and Terra.
model_catalog_json = "/absolute/path/to/.codex/model_catalog.luna-v2.json"
```

Do not alter existing primary settings such as:

```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
```

The override changes model metadata/subagent eligibility; it does not make Luna the primary model.

## Validate before asking for restart

Perform all of these checks:

1. Parse `config.toml` successfully with Python's standard `tomllib`.
2. Parse `model_catalog.luna-v2.json` successfully with `jq` or another real JSON parser.
3. Run Codex Doctor/diagnostics and confirm the configuration is loaded.
4. From a **fresh Codex process/catalog load**, inspect the current rows for exactly Sol, Terra, and Luna and verify the compatibility assumptions:
   - Sol: multi-agent version `v2`.
   - Terra: multi-agent version `v2`.
   - Luna: multi-agent version `v2`; reasoning includes both `xhigh` and `max` exactly as in the source snapshot.
   - Luna does **not** gain `ultra` from this override.
5. Reconfirm that no catalog property other than Luna's multi-agent version changed from the source snapshot.

Configuration/catalog proof is not live-subagent proof.

## Mandatory process boundary

If you installed or changed this override during a Lunacy run, first persist the exact interrupted worker/step and set that run's `<run-root>/STATE.md` `Next action` to retry the intended Luna worker after restart. `<run-root>` is `Lunacy/runs/<run-id>`.

Then tell the user plainly:

**Close and relaunch Codex, then open a new task.**

The already-open task cannot replace its model-selection/subagent tool schema mid-task. Stop there; do not continue plan execution in the same task and do not claim Luna is available yet.

## Proof after restart

In the new task, bind back to the same Lunacy run and retry the intended real worker at the same effort the orchestrator selected, with the normal fresh-context/path-only handoff:

```text
model: gpt-5.6-luna
reasoning_effort: xhigh | max
fork_turns: "none"   # when exposed by the current spawn API
```

Do not reattach the old parent conversation merely because this is a retry. The durable run files are the worker context.

A successful real worker spawn is the live proof; a separate dummy probe is unnecessary.

If the spawn still fails, preserve the evidence and report the blocker. Do not silently fall back to Sol, Terra, or lower reasoning effort.

## Maintenance

`model_catalog_json` pins Codex to a local catalog snapshot. Upstream catalog changes will not automatically flow into that file.

Therefore:

- always try native Luna at the selected effort before installing this override;
- when upstream Codex exposes Luna with the required multi-agent protocol natively, remove `model_catalog_json` and return to the managed catalog;
- after removing the override, restart Codex and prove native Luna by starting the intended real worker again.

## Rollback

Remove the two compatibility lines from `config.toml`:

```toml
# Local compatibility override: expose Luna on the same multi-agent protocol as Sol and Terra.
model_catalog_json = "/absolute/path/to/.codex/model_catalog.luna-v2.json"
```

Or restore the pre-change backup of `config.toml`.

Restart Codex after rollback.
