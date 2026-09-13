---
name: lunacy
description: Orchestrate explicitly adopted, genuinely new ordinary engineering work through Astra decisions and acceptance with coherent native workers. Use only when current project authority selects this guidance contract; do not use it to take over legacy, managed, retained, or provenance-uncertain work.
---

# Lunacy native workflow

## Ordinary delivery at a glance

Establish authority and scope -> bind one coherent owner and an exact literal
model/effort route -> let that owner deliver, check, repair, and report -> have
the parent independently accept. Use ordinary Lunacy for a known engineering
outcome. Use [Golden](orchestrator/IMPROVEMENT.md) whenever it is explicitly
selected for any outcome, including a known implementation; never silently
downgrade it to ordinary delivery.

## Supported scope and capability ceilings

Use this skill only for a genuinely new ordinary engineering outcome whose current user/project authority explicitly selects this contract. Astra owns architecture, consequential decisions, `TASK.md`, coordination, and acceptance. Each worker owns its assigned implementation, tests, ordinary repair, report, and necessary logs. A single-owner outcome uses one combined immutable [adoption-and-assignment record](orchestrator/PLANNING.md#single-owner-adoption-and-assignment); shared work keeps a common adoption and one distinct assignment/report per actual owner.

Choose one immutable binding before dispatch under [Exact native routing](orchestrator/PLANNING.md#exact-native-routing). The unchanged defaults are `bulk` (`gpt-5.6-luna` / `max`) and `judgment` (`gpt-5.6-sol` / `medium`); explicitly selected `sol-high` remains `gpt-5.6-sol` / `high`. [Worker model selection](orchestrator/WORKER-MODELS.md#two-roles-unchanged-defaults) is the canonical role/customization guide. Persist the literal model **and** effort for the worker purpose and exact transport/context; refuse unsupported or conflicting pairs without inference, probing, fallback, or changing a live or unknown-effect same-surface attempt.

This is guidance plus optional read-only evidence and worker-model-selection helpers. It ships no authority resolver, assignment schema/digest validator, model launcher, supervisor, isolation or topology runtime, retention service, hook, MCP, agent configuration, installer, updater, or managed driver. It does not preserve AUTO/EXPLORE/Focus or managed admission/recovery capabilities and does not claim OS confinement or transactional immutability. Reconsider executable machinery only under new explicit authority and justified total cost.

## Entry and reciprocal selection

Selection permits read-only identification, not execution. Before mutation, dispatch, resume, or effects, require current authority to match this exact contract and the immutable adoption in `TASK.md`; apply [Authority, entry, and coexistence](WORKSPACE.md#authority-entry-and-coexistence). Existing native, managed, retained, frozen, legacy, or provenance-uncertain work keeps its original contract, route, history, effects, and recovery owner. The presence or absence of `TASK.md`, a new ID, timeout, missing record, current repository state, or lifecycle-terminal text never migrates old work, establishes new-work eligibility, releases effects, or grants replacement or acceptance. Mixed-project use needs reciprocal authority on every affected side.

When the user explicitly selects Golden, use the optional [Golden-cycle and continuous-improvement guidance](orchestrator/IMPROVEMENT.md): each meaningful outcome requires consultation, actual ADHD, adopted Lunacy delivery, and parent acceptance. Ordinary Lunacy remains the direct low-overhead path. Ongoing improvement additionally requires current user authority and a viable material big win; neither mode permits invented work.

## Before-action reads

Read only what the next action needs. In a fresh context, read unchanged rules and contract references once; reread mutable current authority and TASK coordination whenever their boundary may have changed, plus new evidence needed for the action.

1. Read current project/user authority and [Authority, entry, and coexistence](WORKSPACE.md#authority-entry-and-coexistence).
2. Astra reads the applicable section of [parent planning](orchestrator/PLANNING.md) for adoption, material input, dispatch, acceptance, deadline, or recovery; parent-only TASK authoring uses its [Compact TASK form](orchestrator/PLANNING.md#compact-task-form). Workers do not need the whole parent guide for ordinary construction.
3. Before implementation, a worker reads its concrete combined record or assignment plus adoption, the [uniform record/report contract](WORKSPACE.md#the-uniform-record-contract), [worker engineering](worker/ENGINEERING.md), and applicable project rules. Read the route section only when route/context details need resolution. Do not wait for a post-dispatch handle write or treat authorization as proof of launch.
4. Use only the applicable established form: Astra authors/adopts TASK records; workers read and act under them and use [Worker updates and immutable report](WORKSPACE.md#worker-updates-and-immutable-report). Do not create parallel Plan/State/Steps/decision/gate records.

An unspecified resume uses the selected run's existing contract and records and asks when ambiguous. Missing records decide nothing.

## Compact examples

- **Ordinary single-owner fix:** one combined record names the bug outcome,
  owned files/effects, literal `gpt-5.6-luna` / `max` route, checks, report, and
  entitlement; that worker fixes and tests it, then the parent accepts.
- **Custom worker:** current authority selects a supported literal model and
  effort for `judgment`; the record preserves that exact pair, transport, and
  fresh context without changing any named default.
- **Material pre-FINAL failure:** the parent returns the failed criterion and
  evidence to the current owner. The worker diagnoses and repairs within scope;
  the parent does not supply replacement code or create a repair packet.

## Optional captured-command evidence index

When a relevant native JSONL capture already exists and authority permits reading it, `scripts/evidence_index.py` produces a deterministic read-only projection. Select `--source-format app-server` (the default, preserving the existing received-event lifecycle projection) or explicitly select `--source-format session-receipt` for the distinct completion-only native session projection. For a finite turn-ID-free direct-exec JSONL snapshot with one unambiguous thread header and observed turn boundary, explicitly select `--source-format direct-exec`; this format forbids turn/session arguments and groups every command occurrence by literal item ID without deduplication or lifecycle interpretation. There is no auto-detection, fallback, or cross-capture join.

All formats accept an absolute regular path, read at most 64 MiB, hash a finite snapshot, and default to an 8192-byte projection cap. Session output reveals only source/scope locators, metadata/context lines, recorded model/effort, completion lines, item IDs, and raw recorded status/exit code. Direct-exec output reveals only source/scope and boundary locators, counts, literal item IDs, event kinds, raw statuses, and exit presence/value. Both exclude command arguments, cwd, output, prompts, reasoning, encrypted content, extras, and report text. The helper neither launches nor supervises anything and never establishes authority, route/backend truth, semantic success, completeness, custody, effects, correctness, or acceptance. Missing, ambiguous, or unsupported captures are explicit refusals; they do not require an exporter or weaken required proof. See [Optional evidence-index helper](OPERATOR.md#optional-evidence-index-helper).
