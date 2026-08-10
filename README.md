# Lunacy

A compact execution skill for using **Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator** while **GPT-5.6 Luna at max reasoning owns repository-heavy work**.

The main design rule is: **spend orchestrator tokens only where global judgment has leverage.**

The orchestrator understands project intent and ethos, plans the work, resolves genuinely difficult decisions, and owns phase-end hard gates. Luna/max workers investigate, implement, verify, self-review, repair, adversarially review when selected, and prepare phase evidence.

## Execution model

```text
project intent / ethos
        ↓
compact PLAN.md
        ↓
      phases
        ↓
       steps ── one Luna/max owner each
        ↓
optional fresh Luna adversary on selected risky steps
        ↓
fresh Luna gate scout compresses nontrivial phase evidence
        ↓
orchestrator phase hard gate
```

A phase is an integrated milestone. A step is the largest coherent unit one Luna/max worker can safely own end-to-end.

For vague requests, the orchestrator first creates the minimum useful phase/step plan. For already-structured plans, it preserves the meaningful hierarchy.

Each step owner performs the full local loop: inspect affected callers/surfaces → implement → verify → self-review → fix → reverify → concise report. The orchestrator normally reads only the report's tiny Control Block and moves on; it does **not** review code after every step.

Workers are intentionally quiet: no routine progress narration, only blocker/decision messages plus final completion. Once the durable report is written, the worker finalizes immediately. Where the host supports it, Lunacy prefers event-driven/blocking completion over short timeout polling so long-running workers do not repeatedly wake the expensive orchestrator.

For unusually risky steps, the plan may add a fresh Luna/max adversary that independently attacks the resulting code/effects.

At the end of a nontrivial phase, a fresh Luna/max **gate scout** reads the integrated change and phase evidence and produces a small navigation/risk pack. The scout does not approve the phase. It tells the orchestrator where its expensive attention is most useful. The orchestrator then inspects targeted **actual code/diff/behavior** and makes the hard-gate decision against the phase goal, architecture, project ethos, and integration risk.

This makes the parent gate a global architecture/integration judgment rather than a duplicate line-by-line implementation review.

## Project ethos is authority

`Lunacy/PLAN.md` contains a compact digest of:

- project goal;
- ethos and core principles;
- non-negotiable contracts;
- authoritative sources;
- phase/gate map.

Large plans or architecture sets can first be read by a Luna/max intake scout. The orchestrator reviews and spot-checks the cited digest and still owns the final plan and decisions. This avoids loading large document sets into parent context merely to extract durable facts once.

## Durable structure

```text
Lunacy/
  PLAN.md
  STATE.md
  DECISIONS.md
  intake.md                  # optional
  phases/
    <phase-id>/
      STEPS.md
      reports/
        <step>-worker-01.md
        <step>-adversary-01.md
      gate-pack-01.md
      hard-gate-01.md
```

There is intentionally no mandatory `HANDOVER.md`. `STATE.md + PLAN.md + current STEPS.md` already contain everything needed to resume, and duplicate handover prose costs tokens and can drift.

`STATE.md` stays tiny and always contains one exact `Next action`. Worker reports put an 8–12-line Control Block first; deeper evidence is optional and read only when needed.

A resumed orchestrator reads project-level instructions, `STATE.md`, `PLAN.md`, current `STEPS.md`, and only the artifact named by `Next action`. It does not replay chats, reread all reports, or reload `WORKSPACE.md` during normal resume.

## Worker invariant

Every technical subagent must use:

```text
model: gpt-5.6-luna
reasoning_effort: max
```

There is no silent fallback.

The **first real worker spawn** doubles as the Luna capability check; Lunacy does not spend a separate agent call on a dummy probe.

## Install

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/frozenpepper/Lunacy.git ~/.agents/skills/lunacy
```

## Use

```text
Use $lunacy to execute the authoritative plan at PLAN.md.
```

or:

```text
Use $lunacy for this task. Minimize parent tokens; plan phases/steps first and delegate repository-heavy work to Luna/max.
```

## Codex Luna compatibility

If Codex rejects Luna as a subagent because of the known cached multi-agent catalog mismatch, the skill reads `references/CODEX_LUNA_COMPAT.md` and applies only that narrow compatibility procedure. It never silently downgrades.

If the override is installed or changed, **close and relaunch Codex and open a new task**. The already-open task cannot refresh its model-selection schema.

## Files

```text
SKILL.md                         Always-loaded core orchestration protocol.
WORKSPACE.md                     Read on new-run setup or recovery, not every resume.
references/CODEX_LUNA_COMPAT.md Conditional compatibility procedure.
README.md                        Human-facing overview.
```
