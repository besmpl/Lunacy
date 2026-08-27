# Lunacy

A compact execution skill for using **Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator** while **GPT-5.6 Sol owns repository-heavy work at dynamically selected `high` or `max` reasoning**.

The core idea is simple: **spend expensive parent context on judgment, not repository ingestion, worker narration, repeated verification, or orchestration paperwork.**

The parent understands project intent/architecture, plans work, resolves hard decisions, schedules safe parallelism, preserves user constraints, chooses worker effort, and owns phase gates. Sol workers inspect, implement, test, self-review, repair, and leave bounded durable evidence.

Both sides use a complexity budget: reuse/extend sound mechanisms first, use OOP/polymorphism where they model real variation, and reject speculative layers/frameworks/process ceremony.

## Sol effort routing

Lunacy uses **`high` by default**. `max` is an escalation, not the standard tax on every worker.

Typical `high` work includes bounded implementation, repository surveys/inventory, migrations after design is settled, focused repairs, tests, documentation, read-only scouts, and most adversarial reviews.

The parent selects `max` when extra exploration has a concrete expected payoff: high-blast-radius architecture ambiguity, subtle integrity/security/concurrency/replay/finality invariants, genuinely difficult cross-cutting interaction reasoning, a failed `high` attempt stuck on the same hard reasoning boundary, a critical named adversarial risk, or explicit project/user authority.

Step size or role name alone never justifies `max`. Different workers in the same concurrent batch may use different efforts.

## Mechanical context controls

Lunacy does not rely only on “be concise.” It enforces boundaries:

- when supported, every Sol spawn uses `fork_turns: "none"` so workers do not inherit the parent conversation by default;
- worker mailbox messages are only `BLOCKED`, `DECISION_REQUIRED`, or `FINAL`, at most three short lines;
- **the parent is event-driven too:** routine resume reads, migrations, worker launches, quiet waits, and timeout expiry are not user-facing status events;
- while workers run, the parent enters a **quiescent wait**: use the longest supported `wait_agent` timeout, let mailbox/user activity wake it early, and treat a plain timeout as a non-event that immediately re-enters the wait;
- no periodic `list_agents`, report/file reads, state rewrites, or “still running” prose merely to prove liveness;
- if a higher-priority host policy requires a progress heartbeat, it is the shortest required heartbeat with no accompanying status/repository inspection;
- workers write one immutable terminal report, normally ≤60 lines / ~6 KB;
- parent decision briefs are ≤30 lines / ~4 KB;
- gate packs are ≤30 lines / ~4 KB;
- long command output, broad surveys, inventories, and raw evidence stay in evidence/log files rather than parent context;
- unchanged residual/root-status/inventory lists are referenced from one authority/evidence location instead of recopied into every artifact;
- per-file hash catalogs are avoided unless project authority requires them;
- finalized reports/gate packs/gates are immutable—repairs create new numbered evidence instead of reopening old artifacts;
- the parent normally reads Control Blocks, tiny decision briefs, gate packs, and exact named code/report slices only;
- if one parent decision/gate needs more than three substantive deep slices, Lunacy delegates compression or checkpoints into fresh parent context;
- token usage is never guessed: exact host counters only, otherwise `unavailable`.

## Execution model

```text
project intent / notes
        ↓
independent Lunacy run
        ↓
compact PLAN.md
        ↓
      phases
        ↓
dependency-ready steps
   ↙       ↓       ↘
  Sol      Sol      Sol    ← safe concurrency; high/max per step
   ↘       ↓       ↙
 quiescent parent wait ← wakes only on mailbox/user event
        ↓
 immutable terminal Control Blocks
        ↓
optional adversary if a named risk earns it
        ↓
optional read-only gate scout if integration earns it
        ↓
orchestrator hard gate
```

A phase is an integrated milestone. A step is the **largest coherent unit** one Sol worker can safely own end-to-end. Lunacy avoids micro-decomposition merely to create more agents.

If deeper inspection discovers material work outside the durable step contract, the worker stops before the out-of-contract edit and sends one consolidated decision brief. The parent updates the durable scope or creates a repair/new step before implementation continues. Lunacy does not accumulate chains of ad-hoc “overlap” amendments while one worker keeps expanding its write set.

## Verification without proof multiplication

Each layer has a different job:

1. **Implementer:** terminal verification after its final code change.
2. **Adversary, when justified:** attack new risks/assumptions and verify the impacted delta after repairs unless broader proof became stale.
3. **Gate scout, when justified:** read-only compression/navigation; no broad suite rerun.
4. **Parent gate:** inspect actual targeted code/diff/behavior and perform the authoritative required gate proof plus only the additional bounded acceptance sample useful for integration judgment.

Project/plan acceptance authority always wins: required full matrices, independent repetitions, live proof, or exact gate commands still run exactly as required. Lunacy removes only redundant proof beyond that contract.

Adversary defaults to NO rather than being stamped onto every step. Multiple adversaries in one phase should attack distinct risks or a newly repaired state.

## Immutable evidence / gate write barrier

A worker's FINAL report describes one exact terminal state. It is never reopened to append later findings, newer hashes, overlap amendments, or revised counts. Later repairs use a new attempt/report.

Before a gate scout or hard gate, all phase writers must be FINAL and the run records a **CLOSED write barrier**. Any later phase-owned change reopens the barrier and invalidates a scout produced against the previous state.

This prevents gate scouts from racing moving artifacts and prevents “final” worker reports from becoming mutable shared notebooks.

## Small parent decision surface

When Sol encounters genuine ambiguity, it can perform deep repository research, but the parent receives a tiny decision brief: one question, authority, facts, options, recommendation, execution impact, and exact evidence pointers. Large surveys remain worker-side evidence.

Related contradictions discovered in one bounded investigation are consolidated before parent adjudication instead of accumulating serial amendments and chat wakeups.

## Multiple plans / sessions in one project

```text
Lunacy/
  PROJECT_NOTES.md
  runs/
    auth-refactor/
      PLAN.md
      STATE.md
      USER_NOTES.md
      DECISIONS.md
      phases/...
    generation-pipeline/
      PLAN.md
      STATE.md
      USER_NOTES.md
      DECISIONS.md
      phases/...
```

Each session binds to one run. Run state records concise `Workspace` and `Ownership`; ACTIVE runs cheaply compare those boundaries before simultaneous implementation. Worktrees/branches are preferred where available, but semantic overlap/shared contracts still serialize or replan.

There is intentionally no global scheduler/database/`CURRENT_RUN`.

## Durable user memory

`PROJECT_NOTES.md` stores project-wide user requirements. Each run may have `USER_NOTES.md` for run-specific notes. They are tiny current-memory files, not chat logs.

New user input is evaluated immediately; if it changes execution, plan/state/steps/decisions change too. Notes are reread on fresh/restarted contexts, known compaction/loss, and the final gate—not on every worker cycle.

## Engineering discipline

Workers follow `worker/ENGINEERING.md`: understand before writing, search for reuse/extension, prove complete maintained-surface coverage, prefer clean cohesive abstractions/polymorphism where appropriate, and reject ceremonial OOP/overengineering.

The orchestrator follows `orchestrator/PLANNING.md` when planning/replanning and keeps the same simplicity bias during execution decisions.

A green selected test matrix is evidence, **not scope authority**. Maintained callers/tests cannot be dismissed as historical without explicit authority.

## Phase gates

Parent review normally happens at phase boundaries, not after every step. Gate scouts are conditional: use one when multiple writers changed interacting surfaces, an adversary repaired integration, evidence conflicts, or the phase is genuinely high-risk/cross-cutting. A single coherent low-risk phase can go directly to the parent gate.

The parent inspects targeted actual code/diff/behavior and judges correctness, architecture, project ethos, integration risk, user constraints, and complexity proportionality.

## Worker invariant

Every technical subagent uses:

```text
model: gpt-5.6-sol
reasoning_effort: high   # default
# or max when the orchestrator's routing rule justifies escalation
```

There is no silent model fallback and no effort below `high`. The first real Sol worker spawn doubles as the capability check.

## Install

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/frozenpepper/Lunacy.git ~/.agents/skills/lunacy
```

## Use

```text
Use $lunacy for this task. Minimize parent context; plan phases/steps first and delegate repository-heavy work to Sol.
```

Resume a named run when useful:

```text
Use $lunacy to resume the auth-refactor run.
```

## License

Lunacy is open source under the **Apache License 2.0**. See [`LICENSE`](LICENSE) for the complete license terms.

SPDX-License-Identifier: `Apache-2.0`

## Files

```text
LICENSE                          Apache License 2.0 terms.
SKILL.md                         Always-loaded orchestration protocol.
orchestrator/PLANNING.md        Parent planning/reuse/OOP/YAGNI/effort/verification doctrine.
WORKSPACE.md                     Multi-run state, immutable evidence, report/gate/decision limits.
worker/ENGINEERING.md            Sol engineering + bounded output/terminal evidence doctrine.
README.md                        Human-facing overview.
```

## Runtime package

This repository also ships the installable `lunacy-runtime` package: a durable
per-run execution kernel with one public lifecycle operation,
`RunKernel.advance(input)`. Install with `npm ci` (Node.js 22+), or use the
packed artifact's `lunacy-runtime` executable with the canonical fixtures in
[`examples/`](examples/). The package has no runtime dependencies and makes no
implicit provider, token, or native-host calls. See the [installation](docs/INSTALL.md),
[API](docs/API.md), [durability](docs/DURABILITY.md), [migration](docs/MIGRATION.md),
and [benchmark](docs/BENCHMARK.md) contracts.

The private managed skill deployment also carries the event-driven Codex drive
adapter, its one-token supervisor, closed schemas, and capability probe. Run
`npm run deploy:skill -- --target /absolute/skill-root` and then
`"$NODE" tools/deploy-skill.mjs --target /absolute/skill-root --check` (with
`NODE` set to the absolute, attested Node executable) before using
the installed `runtime/bridge.mjs drive` route. Deployment publishes a fully
verified complete managed tree through a recoverable atomic directory exchange,
removing stale owned files while preserving unrelated skill-root files. Drive
mode removes only the parent's mechanical resume/wait/reconcile loop; the
kernel remains the sole
authority and Markdown/manual mode with truthful `HumanReceiptRequired`
fallback remains available. An audited exact-inventory 0.2.12 restore command
and crash-recovery matrix are documented in [install](docs/INSTALL.md). See
[bridge](docs/BRIDGE.md),
[Codex exec](docs/CODEX_EXEC.md), and [install](docs/INSTALL.md).
