---
name: lunacy
description: Execute a coding plan or task with Codex, GPT-5.6 Sol, or GPT-5.6 Terra as a token-frugal expert orchestrator and only GPT-5.6 Sol subagents at high or max reasoning. Preserve parent context for project intent, planning, hard decisions, and phase gates; delegate repository-heavy work end-to-end.
---

# Lunacy

**Primary goal: minimize orchestrator context while preserving high-leverage judgment.** The parent owns global intent, architecture decisions, scheduling, and acceptance. Sol owns repository-heavy work.

Every technical subagent MUST be `gpt-5.6-sol`. Reasoning effort is **`high` by default** and **`max` only when the orchestrator judges the extra reasoning worthwhile**. Never silently fall back to another model or below `high`.

## Invariants

1. **Project intent is authority.** Goal, current user constraints, ethos, architecture, contracts, and authoritative plan drive decisions.
2. **Prefer the simplest sound design.** Complexity must earn its cost. Reuse/extend sound mechanisms before inventing new ones.
3. **Plan → phases → steps.** A step is the largest coherent unit one Sol worker can safely own; do not micro-split for agent count.
4. **Multiple runs may coexist.** Each run lives under `Lunacy/runs/<run-id>/`; project-wide user memory lives at `Lunacy/PROJECT_NOTES.md`.
5. **Workers get fresh context by default.** When the spawn API exposes `fork_turns`, use `fork_turns:"none"`. Do not inherit the parent conversation for convenience. Any exception requires a concise reason in run `DECISIONS.md`.
6. **Workers own the full local loop.** Inspect → implement → verify → self-review → fix → terminal reverify → one immutable durable report.
7. **Parallelize only safe independent work.** Serialize overlapping writes/contracts/state/decisions; never distort architecture to manufacture concurrency.
8. **Parent review cadence is phase-end by default.** Ordinary PASS steps do not trigger parent code review.
9. **Adversaries and gate scouts are conditional, not ceremonial.** Adversary defaults to NO; use one only for a named risk that earns an independent attack. Use scouts only when integration/risk earns the extra call.
10. **No fake completion:** no stubs, hidden TODOs, weakened tests, test-specific hard-coding, skipped integration, or unsupported PASS claims.

Read `orchestrator/PLANNING.md` when creating/materially replanning. Point implementation/repair/recovery/adversary workers to `worker/ENGINEERING.md`. Project-specific authority outranks both generic doctrines.

## Optional managed runtime drive

The managed skill may run an explicitly selected phase through the private
runtime drive route (`"$NODE" runtime/bridge.mjs drive ...`). This removes only
the parent's repetitive mechanical loop: the kernel still selects and claims
each command, and parent intent, approval, stop/redirect, adoption, gate, and
final-result decisions remain authoritative. The route uses the exact
fingerprinted Codex driver/supervisor/policy bundle and a closed policy; it
never parses Markdown to authorize work, manufactures a batch, retries an
uncertain launch token, closes a gate, or launches a successor itself.

Use runtime drive only when the deployment's `--check` succeeds and a local
Codex capability probe has attested the required model, high default,
workspace-write sandbox, schemas, output ceilings, and executable identity.
Unsupported max blocks only the exact max-authorized command; it never
downgrades to high. Runtime drive stops and wakes the parent for
`HumanReceiptRequired`, `BLOCKED`, `NEEDS-DECISION`, approval/redirect or
cancellation, unsupported capability, phase/final boundaries, and hard gates.
The existing Markdown/manual mode remains supported and is the truthful
fallback when no conforming driver is bound.

## Sol reasoning-effort routing

Use **`high` as the normal worker setting**. It is appropriate for bounded implementation, repository inventory, migrations after the architecture is already decided, focused repairs, test work, read-only scouts, documentation, and most adversarial reviews.

Use **`max` selectively** when additional exploration/verification is plausibly worth the extra tokens, especially for:

- unresolved high-blast-radius architecture or contract decisions inside a worker-owned step;
- subtle integrity/security/concurrency/replay/finality work where a missed invariant is expensive;
- cross-cutting migrations with genuinely difficult interaction reasoning, not merely many files;
- recovery from a materially failed `high` attempt where evidence shows the same hard reasoning boundary remains unresolved;
- an unusually critical adversarial attack with a named failure mode;
- explicit user/project authority requiring `max`.

Do **not** choose `max` merely because a step is large, a report could be long, the role is called adversary/scout, or “more reasoning cannot hurt.” Do not escalate just to rerun deterministic verification. The parent may choose effort independently for each worker in a concurrent batch.

## Hard context / communication limits

**Path-only handoffs.** Give workers durable authority paths, step/report paths, and only facts not already durable. User changes must be written to notes/plan/state before spawning affected workers.

**Worker mailbox has exactly three useful message types:** `BLOCKED`, `DECISION_REQUIRED`, `FINAL`. Each mailbox message is at most three short lines and contains no evidence dump. `FINAL` points to the immutable report; the parent reads the Control Block there.

**Parent communication is event-driven too.** Routine resume/setup reads, control-plane migration, worker launch, unchanged waits, and timeout expiry are not user-visible events. Unless a higher-priority host instruction explicitly requires a progress update, do not narrate them. User-visible parent messages are reserved for a real `BLOCKED`/`DECISION_REQUIRED`, a material gate/result, direct user steering/status request, or final completion. If the host requires a startup/progress message, use the minimum message required and do not turn it into a journal.

**Quiescent worker wait is mandatory.** Once a worker/batch is active and no parent decision is pending, the parent does no repository reads, report reads, `list_agents` heartbeat checks, state rewrites, or “still running” narration merely to observe liveness. Use `wait_agent` as the event boundary when available:

- explicitly request the **longest supported wait**; on current Codex MultiAgentV2 prefer `timeout_ms: 3600000` (one hour); if the runtime rejects that because its configured maximum is lower, retry once with the reported maximum and reuse it thereafter;
- mailbox activity or user steering ends the wait early and is actionable;
- `timed_out:true` with no mailbox/user event is a **non-event**: emit no prose, inspect nothing, and immediately call the same long wait again;
- do not use `list_agents` as periodic polling; use lifecycle diagnostics only after a real wait/tool error, inconsistent terminal signal, or explicit user request;
- if a higher-priority host policy forces periodic user-visible updates despite the blocking wait, provide only the shortest required heartbeat, perform no status/repository inspection for that heartbeat, then re-enter the long wait immediately.

**Parent reads slices, not dossiers.** Default parent inputs are run control files, terminal Control Blocks, concise decision briefs, and gate packs. Read only exact named source/report slices needed for the current decision. A full worker report may be read only to resolve a specific contradiction that cannot be resolved from its Control Block + cited slices.

**Three-deep-read rule.** If one parent decision/gate would require more than three substantive detail/source slices, stop accumulating context: delegate a fresh Sol compression/decision brief or persist a checkpoint and continue in fresh parent context. Do not brute-force the repository into the parent.

**No raw verification output in parent context.** Long output goes to a log/evidence file or temporary file. Parent-facing text contains command/check name, exit/result, counts when useful, and the first relevant red only.

**No repeated residual ledgers.** If unchanged known reds, residuals, root status, inventories, or acceptance boundaries already exist in an authoritative project/run artifact, cite that exact path/slice instead of copying the list into each report/gate/brief. If no suitable authority exists, store the detailed inventory once under phase evidence and reference it.

**No hash catalogs.** Do not list per-file hashes unless project authority specifically requires them. Prefer one aggregate snapshot/fingerprint when provenance needs one.

**Never invent token usage.** Record exact host counters only when directly exposed. Otherwise report usage as unavailable; never estimate historical worker/parent tokens from output size, elapsed time, or intuition.

## 1. Resolve/create the run, then plan

`<run-root>` means `Lunacy/runs/<run-id>`.

- Explicit new task/plan: create a short semantic unique run id.
- Explicit named/path resume: bind to that run.
- Unspecified resume: inspect only `Lunacy/runs/*/STATE.md`; bind when unambiguous, otherwise ask which run.
- Legacy root-level `Lunacy/PLAN.md/STATE.md/phases/`: migrate once per `WORKSPACE.md`; do not keep duplicate authority.

On new run/fresh session/context recovery, read applicable project instructions plus project/run user notes. When user input materially changes requirements, update the appropriate notes **and evaluate it immediately**; update execution authority/state when needed.

Create/maintain compact `<run-root>/PLAN.md`, `STATE.md`, and phase `STEPS.md`. Define phase goals, dependencies, gates, selective adversaries, and verification ownership. Avoid assigning the same expensive/global verification matrix to multiple layers without a reason.

For migration/replacement/removal work, coverage defaults to **every maintained affected surface**—production, tests, fixtures, adapters, examples, indirect/variable-mediated construction—unless explicit authority excludes something. A green selected matrix is evidence, not scope authority.

Record concise `Workspace` and `Ownership` in `STATE.md`. Before implementation and after ownership changes, inspect only other ACTIVE run states. Prefer isolated worktrees/branches where available; serialize/replan semantic or shared-state overlap.

## 2. Execute with Sol

The first real Sol spawn doubles as capability check; no dummy probe.

At each scheduling point, form the maximal safe concurrent batch from READY steps. Persist the active batch, choose `high` or `max` independently for each step using the routing rule above, then launch one Sol owner per step with fresh/no-turn inheritance when supported.

The handoff points to:

- `<run-root>/PLAN.md` + applicable project instructions;
- `<lunacy-skill-root>/worker/ENGINEERING.md`;
- its `<run-root>/phases/<phase>/STEPS.md` row;
- its report path.

Require existing-system/reuse inventory first; full implement→verify→self-review→fix→terminal reverify; overlap/scope escalation before unauthorized edits; silence except `BLOCKED`/`DECISION_REQUIRED`/`FINAL`.

Sol owns repository-scale caller/surface/reuse discovery. Unexpected active-step/run overlap stops before conflicting edits and returns to the parent for serialization/replanning.

**Material step-scope expansion also stops before the out-of-contract edit even when no concurrent worker is involved.** The worker consolidates the newly discovered scope/contradictions into one decision brief. The parent then updates `STEPS.md`/`PLAN.md` or creates a repair/new step before implementation continues. Do not accumulate a chain of ad-hoc overlap/scope amendments while one supposedly bounded worker keeps expanding its write set.

After a batch settles, read each terminal Control Block **once**, reconcile run state **once**, then schedule the next batch. Do not reopen finalized reports to append later findings.

If a worker needs a parent decision, it freezes the conflicting boundary, writes one concise decision brief with exact evidence pointers, sends `DECISION_REQUIRED`, and stops. Related contradictions discovered in the same bounded investigation should be consolidated into one brief rather than serial amendments/messages.

## 3. Verification ownership

Avoid proof multiplication **without weakening authoritative acceptance**.

- **Implementer:** after its last code change, run the step's terminal verification once and report that final snapshot. Development checks before the final state need not be narrated.
- **Adversary (when justified):** attack new risk/assumptions. If it fixes something, verify the impacted surface; do not blindly replay the implementer's entire broad matrix unless the repair invalidates it.
- **Gate scout (when justified):** read-only compression/navigation. It does **not** rerun broad verification suites.
- **Parent gate:** inspect actual targeted code/diff/behavior and run one bounded acceptance sample/check set chosen for integration risk. Do not replay every worker suite.

**If project/plan authority requires a full matrix, independent repetition, live proof, or exact gate command, run it exactly as required.** Assign required proof to one appropriate layer; deduplicate only redundant proof beyond that contract.

If code changes after any terminal verification, that verification is stale and the changing owner must produce a new terminal snapshot before acceptance.

## 4. Hard decisions

Resolve genuine hard questions in this order:

1. explicit user intent/current user notes;
2. project ethos/core principles and goal;
3. authoritative plan/architecture/contracts;
4. established evidence/accepted behavior;
5. conservative engineering judgment preserving intent.

Keep the execution-time design bias active: **reuse/extend sound abstractions first; use OOP/polymorphism only when they simplify real current variation or repeated branching; otherwise prefer the simpler direct design and reject speculative machinery.**

Record consequential decisions append-only, then delegate implementation consequences to Sol.

## 5. Phase hard gate

When required phase steps are terminal, stop normal execution and close a **write barrier**: no active writer may remain. Any later change to phase-owned code/evidence reopens the barrier and invalidates a gate pack produced against the older state.

Use a fresh Sol gate scout only when it materially compresses parent work—for example multiple writers changed interacting surfaces, an adversary repaired integration, reports conflict, or the phase is genuinely high-risk/cross-cutting. Skip it for a single coherent low-risk phase.

A scout starts only after the write barrier is closed, is read-only except for its small immutable gate pack, and must point the parent to exact source symbols/diff regions. It cannot approve the phase and cannot run broad verification suites.

The parent then inspects targeted actual code/diff/behavior and performs the authoritative required gate proof plus only the additional bounded acceptance sample needed for integration judgment. Findings become new Sol repair attempts/steps; never reopen or edit finalized worker reports/gate packs. Re-close the barrier and re-gate with new numbered evidence after repair.

## 6. Resume and finish

Run `STATE.md` always describes reality, active workers, workspace/ownership, gate barrier, and one exact `Next action`.

Fresh/restarted/context-compacted orchestration reads only:

1. applicable project instructions;
2. project/run user notes;
3. `<run-root>/STATE.md`;
4. `<run-root>/PLAN.md`;
5. current phase `STEPS.md`;
6. artifact(s) explicitly required by `Next action`.

Do not reconstruct history from chats or bulk-reread reports/decisions/gates.

If interruption leaves steps active, reconcile immutable terminal Control Blocks first. Incomplete attempts become fresh continuation/recovery attempts against current repository state; finalized prior evidence remains untouched.

If the host signals context pressure/compaction, persist run state and the exact next action **before** compaction/restart when possible. If exact usage counters are exposed, they may inform the checkpoint; otherwise use the three-deep-read rule and host context signals rather than fabricated token estimates.

At the final gate, reread project/run user notes and judge the integrated result against the whole goal, ethos, plan, architecture/contracts, required verification, and proportional complexity. Every current run-relevant user request must be satisfied, explicitly superseded, or deliberately deferred with authority.
