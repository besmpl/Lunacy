# Lunacy Workspace

Read this when creating a run or recovering damaged/ambiguous state; do not reread it on every normal resume.

## Project / run layout

```text
Lunacy/
  PROJECT_NOTES.md                 # optional project-wide user memory
  runs/
    <run-id>/
      PLAN.md
      STATE.md
      USER_NOTES.md                # optional run-local user memory
      DECISIONS.md                 # append-only parent decisions
      intake.md                    # optional large-authority digest
      phases/
        <phase-id>/
          STEPS.md
          reports/
            <step-id>-worker-01.md
            <step-id>-adversary-01.md
          evidence/                # optional; logs/surveys parent does not normally read
          decision-briefs/         # optional; tiny parent-facing blocker/decision briefs
          gate-pack-01.md           # optional, conditional
          hard-gate-01.md
```

`<run-id>` is a short semantic unique slug. There is no global run registry, lock database, scheduler, or `CURRENT_RUN`; run directories and tiny `STATE.md` files are enough.

Legacy root-level `Lunacy/PLAN.md`, `STATE.md`, `phases/`, etc. migrate once into one run. Do not keep old/new authority copies in parallel.

## Artifact mutability contract

This distinction is critical.

**Mutable current-control files:**

- `PLAN.md`
- `STATE.md`
- phase `STEPS.md`
- `PROJECT_NOTES.md`
- run `USER_NOTES.md`

**Append-only:** `DECISIONS.md`. Supersede a prior decision with a new entry; do not rewrite history.

**Immutable once finalized:** worker/adversary reports, decision briefs, gate packs, hard-gate records, and durable evidence snapshots/logs referenced by a FINAL artifact.

Never reopen a FINAL worker report to append gate findings, newer hashes, revised test counts, overlap amendments, or parent adjudication. If code/evidence changes after FINAL:

- implementation/repair uses a new attempt/report (`worker-02`, repair step, etc.);
- a corrected decision uses a new decision brief/version;
- a re-scout uses `gate-pack-02.md`;
- a re-gate uses `hard-gate-02.md`.

The old artifact remains truthful evidence of the state it originally described.

## User notes

`PROJECT_NOTES.md` stores project-wide user-originated constraints/preferences/requests. Run `USER_NOTES.md` stores run-specific ones.

Keep both tiny and current:

```markdown
# Project Notes   # or: # Run User Notes

## Current
- <active user requirement>

## Deferred / future
- <explicitly deferred request>
```

Do not put worker progress, logs, or parent decisions here. Evaluate new user input immediately and update plan/state/steps/decisions when execution authority changes.

Read relevant notes on run creation, fresh/restarted parent context, known compaction/loss, when the user changes requirements, and the final gate—not every worker cycle.

## PLAN.md

Compact authority/execution digest. Target well under ~800 words unless genuinely necessary.

```markdown
# Lunacy Execution Plan

## Authority
Goal: <outcome>
Plan/task: <path/source>
Project rules: <paths>
Architecture/design authority: <paths>

## Ethos / core principles
- <principle> — source: <path/section>

## Non-negotiable contracts
- <constraint> — source: <path/section>

## Phases / gates
P1 — <milestone> | steps: S1,S2 | gate: <standard>
P2 — ...
Optional adversaries: <ids or NONE>
Final gate: <whole-run standard>
```

For large authority sets an intake Luna may create `intake.md`; the parent spot-checks it and owns the final plan.

Plan verification ownership too: do not make every step/adversary/scout/parent rerun the same expensive global suite unless a later change genuinely invalidates earlier evidence.

## STATE.md

Tiny current source of truth:

```markdown
# Lunacy State
Run: <run-id>
Status: ACTIVE | BLOCKED | COMPLETE
Plan revision: <version if useful>
Workspace: <checkout/worktree/branch>
Ownership: <concise subsystem/surfaces/shared contracts>
Phase: <id/name>
Step(s): <active ids | NONE>
Gate: NOT-DUE | DUE | PASS | FINDINGS
Gate barrier: OPEN | CLOSED <optional cheap snapshot/fingerprint>
Active workers/reports: <worker-id:report; ... | NONE>
Blocked: <NONE | concise reason>
Latest gate: <path | NONE>
Next action: <one exact action with ids/paths>
Updated: <timestamp>
```

`Gate barrier` is OPEN whenever a phase-owned writer/change is active or occurs after a prior barrier. Close it only when every required writer has finalized and no parent/worker intends further phase-owned edits before scouting/gating. Any post-barrier change reopens it and invalidates a gate pack created against the older state.

When a concurrent batch is active, list the whole set and use one batch-level `Next action`.

## Multiple active runs

Before implementation of a new run, and after material ownership changes, inspect only other ACTIVE run `STATE.md` files. Compare `Workspace` and `Ownership`.

Prefer concurrency only for genuinely independent outcomes/surfaces/contracts. Prefer isolated worktrees/branches where available. Serialize/replan overlapping shared contracts, generated artifacts, unsafe mutable state, same-checkout races, or likely merge/integration cost that outweighs parallelism.

Do not make the parent perform repository-scale conflict discovery. Luna validates deeper assumptions and escalates unexpected overlap before conflicting edits.

## STEPS.md

```markdown
# P1 Steps
Goal: <integrated outcome>
Gate: <phase standard>

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S1 | ... | - | NO | DONE | reports/S1-worker-01.md |
| S2 | ... | S1 | YES | ACTIVE | reports/S2-worker-01.md |
```

Statuses: `READY`, `ACTIVE`, `NEEDS-DECISION`, `REPAIR`, `DONE`, `BLOCKED`, `SUPERSEDED`.

A step is the largest coherent unit one Luna can safely own. `DONE` means terminal local completion; phase acceptance still needs its gate.

## Worker spawn / handoff

Use a fresh child context by default. When supported by the spawn API:

```text
fork_turns: "none"
```

Any inheritance exception must have a specific reason recorded in run `DECISIONS.md`.

Default handoff:

```text
Own <step-id> end-to-end.
Authority: <run-root>/PLAN.md + applicable project instructions.
Engineering: <lunacy-skill-root>/worker/ENGINEERING.md.
Step: <run-root>/phases/<phase>/STEPS.md (<step-id> row).
Report: <report-path>.
Inspect/reuse first; implement → verify → self-review → fix → terminal reverify.
If active step/run ownership overlaps, stop before conflicting edits.
Mailbox only BLOCKED / DECISION_REQUIRED / FINAL.
```

Do not paste parent conversation/history into the handoff. Durable files carry the required context.

## Worker mailbox

Only these messages should wake the parent:

```text
BLOCKED
<report/evidence path>
<one-line blocker>
```

```text
DECISION_REQUIRED
<decision-brief path>
<one precise question>
```

```text
FINAL <PASS|FIXED|BLOCKED>
<terminal report path>
<optional one-line result>
```

Maximum three short lines. No logs, path inventories, test matrices, hashes, or implementation narrative in mailbox messages.

## Worker report

Parent-facing Control Block is fixed and small:

```markdown
# S2 Worker Report
## Control
Status: PASS | NEEDS-DECISION | BLOCKED
Goal/result: <one line>
Changed: <compact path groups/effect; no hash catalog>
Verification: <terminal command/check + result/count, one line>
Self-review/fixes: <NONE or one line>
Principle/contract impact: <NONE or one line>
Decision needed: NO | <one precise question + brief path>
Risk/blocker: NONE | <one line>
Evidence: <optional exact evidence/log/source pointers>

## Detail
<optional worker/later-review detail>
```

Control is at most ~12 lines. The **whole report should normally stay within 60 lines / ~6 KB**. If evidence would exceed that, move it to `evidence/` (or an existing project evidence/log location) and cite exact pointers. Large caller inventories, raw surveys, long test output, and hash tables do not belong in the parent report.

The parent reads the Control Block by default; Detail is not part of normal progress control.

### Terminal boundary

The `Verification` line is the final verification snapshot for the exact state being reported. After FINAL:

- code/tests/generated artifacts/report are frozen;
- no cleanup/polish/opportunistic fixes;
- no reruns solely for a newer count/status;
- no post-completion report edits/messages.

Material changes require a new terminal verification and a **new attempt/report**, never rewriting the prior FINAL artifact.

## Evidence / logs

Long command output must not enter parent chat or normal reports. Redirect it to a file when useful. Parent-facing evidence says only:

- command/check name;
- exit/result;
- useful count/summary;
- first relevant failure/red when failing;
- exact log/evidence path if deeper inspection is needed.

Do not preserve huge PASS logs merely because they exist. Use durable logs when they are acceptance evidence or useful for recovery; otherwise temporary logs are fine.

Do not emit per-file SHA catalogs unless the project itself requires that provenance. If Lunacy needs drift/freeze identity, prefer one aggregate phase/worktree fingerprint where cheaply available.

## Decision brief

A worker that genuinely needs parent adjudication stops the conflicting work and writes one small brief:

```markdown
# Decision Brief <id>
Question: <one sentence>
Authority: <exact paths/sections>
Facts:
- <fact>
Options:
- A — <tradeoff>
- B — <tradeoff>
Recommendation: <one choice + why>
Execution impact: <what changes/unblocks>
Evidence pointers: <exact files:symbols/line ranges or worker evidence paths>
```

Target **≤30 lines / ~4 KB**. Do not turn a decision brief into a repository survey. Larger research belongs in `evidence/`; the parent receives only the compressed decision surface.

Consolidate related contradictions discovered in the same bounded investigation into one brief before asking the parent. Do not accumulate serial overlap amendments in a finalized worker report.

## Adversary

Use a fresh Luna/max adversary only for unusually risky work, not by default for every step. Give it durable authority, engineering doctrine, actual code/diff, and verification entry points—not implementer chat.

It attacks new assumptions/risks. If it repairs something, it verifies the impacted surface. It should not replay the entire implementer matrix unless its repair makes that broad evidence stale.

Its report follows the same size, mailbox, immutability, and terminal-snapshot rules.

## Verification layers

1. **Implementer owns terminal step verification** after its final code change.
2. **Adversary, if used, owns adversarial delta verification** and impacted rechecks after its fixes.
3. **Gate scout does not run broad suites.** It is a read-only compression/navigation role.
4. **Parent gate runs one bounded acceptance sample/check set** selected for integration risk; it does not replay every worker suite.

Do not rerun an unchanged expensive global matrix merely to create another evidence count. A later code change invalidating previous proof is the reason to rerun, not a new orchestration layer.

## Gate write barrier / scout

A scout is optional and justified when multiple writers changed interacting surfaces, an adversary repaired integration, reports conflict, or the phase is high-risk/cross-cutting. Skip it for one coherent low-risk phase.

Before scout launch:

1. every required writer has sent FINAL;
2. `Active workers/reports` has no writer still capable of changing phase-owned artifacts;
3. `Gate barrier` is CLOSED;
4. if cheap/reliable in the environment, record one aggregate snapshot/fingerprint.

The scout is read-only except for its new gate pack. Any phase-owned edit after barrier closure invalidates that pack.

Gate pack hard limit: **≤30 lines / ~4 KB**.

```markdown
# P1 Gate Pack 01
Phase goal/result: <one line>
Changed surfaces: <compact modules>
Cross-step integration: <one-three interfaces/data flows>
Terminal verification: <worker/adversary final status; no raw logs>
Highest risks/uncertainties:
- <risk>
Parent inspection targets:
1. <exact file:symbol/diff region> — <why>
2. <...>
Suggested acceptance sample:
- <one-three bounded checks>
Snapshot/barrier: <identifier if available>
Scout verdict: NOT APPLICABLE — parent owns gate
```

No per-file hash table. No rewritten diff. No broad test rerun. No instruction to “read reports S1–S4”; point to exact source/report slices only.

## Parent read discipline

For ordinary progress, read Control Blocks only. For a decision, read its decision brief and exact evidence slices. For a gate, read the gate pack and inspect its exact actual-code targets.

A full report read requires a named unresolved contradiction that cannot be settled from Control + brief + cited slices.

If a single decision/gate needs more than **three substantive deep slices**, delegate fresh Luna compression or persist `STATE.md`/`Next action` and continue in fresh parent context. This is the mechanical context ceiling when exact token counters are unavailable.

Never estimate token usage. If the host exposes exact counters, record exact values when useful; otherwise `unavailable`.

## DECISIONS.md

Append only consequential parent decisions:

```markdown
## D-003 — <title>
Context: <ambiguity/problem>
Authority: <paths/sections>
Decision: <choice>
Basis: <key evidence>
Impact: <steps/contracts>
```

Do not reread the ledger on normal resume. Active consequences belong in PLAN/STATE.

## Hard-gate record

Hard-gate artifacts are immutable and numbered:

```markdown
# P1 Hard Gate 01
Goal/principles checked: <compact list>
Actual state inspected: <exact paths/symbols/diff regions>
Acceptance sample: <bounded checks>
Findings: NONE | <concise findings>
Disposition: PASS | REPAIR REQUIRED
Repair steps: <ids or NONE>
Barrier/snapshot: <identifier if available>
```

After repair, create `hard-gate-02.md`; do not edit gate 01 into a different historical result.

## Resume

Resolve the run first. Then read only:

1. applicable project instructions;
2. project/run user notes;
3. run `STATE.md`;
4. run `PLAN.md`;
5. current phase `STEPS.md`;
6. artifact(s) explicitly required by `Next action`.

Do not replay worker chat, reread all reports, old decisions/gates, WORKSPACE, or planning doctrine unless current recovery/replanning specifically needs them.

For interrupted ACTIVE attempts, reconcile immutable FINAL Control Blocks first. Incomplete attempts get new attempt/report paths and fresh Luna continuation workers against current state. Never turn the parent into a partial-change archaeologist.

Before known context compaction/restart, persist reality and one exact `Next action`. If the host exposes exact context/token counters, use them; otherwise rely on host pressure signals and the three-deep-read rule, never guessed usage.