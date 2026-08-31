# Lunacy

A compact execution skill for using **Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator** while **explicitly routed GPT-5.6 Luna or Sol workers own repository-heavy work**.

The core idea is simple: **spend expensive parent context on judgment, not repository ingestion, worker narration, repeated verification, or orchestration paperwork.**

The parent understands project intent/architecture, plans work, resolves hard decisions, schedules safe parallelism, preserves user constraints, chooses each worker route, and owns phase gates. Workers inspect, implement, test, self-review, repair, and leave bounded durable evidence.

Both sides use a complexity budget: reuse/extend sound mechanisms first, use OOP/polymorphism where they model real variation, and reject speculative layers/frameworks/process ceremony.

## Worker routing

Lunacy uses one closed route choice:

| Route | Model | Reasoning effort | Selection |
|---|---|---|---|
| `luna` | `gpt-5.6-luna` | `max` | Default when omitted |
| `sol-high` | `gpt-5.6-sol` | `high` | Explicit only |

Only those exact case-sensitive pairs are valid. The parent resolves one route, passes both `model` and `reasoning_effort` explicitly to `agents.spawn_agent`, and uses `fork_turns:"none"` by default. It never infers from the parent model, catalog, availability, or an earlier attempt. An invalid or unavailable selection blocks with no alternate call, fallback, or downgrade.

Before every explicit Sol launch, the parent records `workerRoute: sol-high; phaseId: <id>; stepId: <id>; attemptEpoch: <n>` in the run's `DECISIONS.md`. Resume preserves that exact binding or blocks; changing routes requires a fresh attempt and new authority.

Luna is fixed at `max`; it is not an escalation tier. Consequential judgment or a named unresolved reasoning boundary after a failed Luna/max attempt uses a fresh authorized Sol/high attempt. Keeping Luna on one fixed effort avoids deliberately fragmenting that route by reasoning setting; it does not guarantee a cache hit.

### Default role policy

The simple default flow is **parent judgment/gate → Luna/max repository execution/self-verification → optional Sol/high bounded judgment → Luna implementation of decisions → parent acceptance**. Luna/max is the default for repository-heavy implementation, tests, ordinary repairs, documentation, read-only scouts, and ordinary adversarial reviews. Sol/high is opt-in only for bounded consequential judgment—an architecture/contract choice, conflicting-evidence adjudication, or a narrow named acceptance question. Sol/high is not an automatic independent verifier or a generic escalation tier; independent verification is conditional on a named risk, not automatic. When Sol advice changes code, implementation returns to Luna unless the user or project explicitly assigns Sol implementation; the parent remains the acceptance owner.

Host parent selection: GPT-5.6 Sol at `high` is the preferred parent/orchestrator when the host lets the user select it, because the parent owns consequential judgment. A current allowed non-Sol parent remains valid; never spawn a shadow/duplicate parent to simulate the preference. This host-level preference is separate from the explicit worker `sol-high` route and its attempt binding, and it does not create a Sol attempt binding.

Direct/manual workers and private managed routes are independently closed. Writable managed action remains its attested Sol/high `codex exec` policy; effect-denied adaptive Focus/Explore deliberation uses a separately attested Luna/max capability. Neither is a fallback for the other, and a direct route choice alone does not change runtime schemas, policy digests, or driver behavior.

## Adaptive deliberation

Lunacy can deterministically keep a settled decision on zero-fan-out Direct,
compare two or three isolated candidates with Focus, or run exact ADHD Explore
(five generators × six ideas, one critic, and exactly three deepeners). Reports
remain effect- and authority-free; the parent alone settles the decision and
authors/adopts a complete Plan through the same RunKernel and store.

The package/runtime has no ambient rollout and remains fail-safe disabled when
managed host composition is omitted or nonconforming. The installed operator
profile may select reviewed D3 `automatic-focus` only as one generation-1,
effect-denied Focus Wave before the acceptance pointer/Plan is sealed and
before the first implementation spawn. Automatic Focus never WIDENs or
re-enters from a gate, repair, worker completion, resume, rollout, or an
existing rollout-bearing run. An unsettled Wave returns exactly one parent
decision boundary. Direct is still zero-fan-out, user-explicit ADHD/Explore is
still available and explicit-only, and missing native isolation, transport,
route, role policy, or eligibility refuses with no fallback. See the concise [adaptive
operator contract](orchestrator/DELIBERATION.md) for the rollout corridor,
kill/revocation procedure, diagnostics, recovery, and disposable validation.

## Mechanical context controls

Lunacy does not rely only on “be concise.” It enforces boundaries:

- when supported, every worker spawn uses `fork_turns: "none"` so workers do not inherit the parent conversation by default; a reasoned inheritance exception must retain the same explicit model/effort or block;
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
 worker  worker  worker   ← safe concurrency; explicit route per step
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

A phase is an integrated milestone. A step defaults to the **largest coherent end-to-end unit** one worker can safely own. Alongside real authority, ownership, safety, and external-dependency boundaries, Lunacy permits a fifth split exception only when evidence shows a measured worker context, time, or tool-capacity boundary. It then uses the fewest acceptance-required vertical slices—never planning, reporting, proof, test-count, or milestone slices.

Before first implementation dispatch, the parent seals the existing user/project requirements, accepted observable/result, and chosen architecture spine in the existing Plan/run authority. Materially changed authority requires new Plan/run authority rather than drip-feeding a live implementation Plan. Required documentation, accessibility, quality/polish, and similar completion work stay in scope when authority includes them; only genuinely optional work is excluded.

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

When a worker encounters genuine ambiguity, it can perform deep repository research, but the parent receives a tiny decision brief: one question, authority, facts, options, recommendation, execution impact, and exact evidence pointers. Large surveys remain worker-side evidence.

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

## Direct worker examples

Default Luna:

```text
model: gpt-5.6-luna
reasoning_effort: max
fork_turns: "none"
```

Explicit Sol/high:

```text
model: gpt-5.6-sol
reasoning_effort: high
fork_turns: "none"
```

There is no silent model fallback or effort downgrade. The first real spawn on a selected route doubles as its capability check. Only Luna may use the narrow [`CODEX_LUNA_COMPAT`](references/CODEX_LUNA_COMPAT.md) procedure, followed by a fresh-process retry of the unchanged Luna pair.

## Install

```bash
mkdir -p ~/.agents/skills
git clone https://github.com/frozenpepper/Lunacy.git ~/.agents/skills/lunacy
```

## Use

```text
Use $lunacy for this task. Minimize parent context; plan phases/steps first and delegate repository-heavy work through the default Luna route.
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
orchestrator/DELIBERATION.md    Adaptive Direct/Focus/Explore operator contract and rollback.
WORKSPACE.md                     Multi-run state, immutable evidence, report/gate/decision limits.
worker/ENGINEERING.md            Worker engineering + bounded output/terminal evidence doctrine.
references/CODEX_LUNA_COMPAT.md Narrow Luna-only catalog compatibility procedure.
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
Package install and managed runtime deployment do not create an ambient
adaptive rollout. The installed operator profile's private D3 composition,
eligibility, validation, kill, and recovery procedure is the
[adaptive operator contract](orchestrator/DELIBERATION.md).

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
