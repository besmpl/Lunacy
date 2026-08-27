# Lunacy Orchestrator Planning Doctrine

Read this when creating or materially replanning a Lunacy run. Project-specific authority (`AGENTS.md`, architecture, contracts, user intent) outranks this doctrine.

## Core rule

**Use the simplest architecture and execution plan that fully solves the actual task and fits the existing system. Complexity must earn its cost.**

Prefer modifying, reusing, deleting, or extending sound existing mechanisms over introducing new layers.

## Before defining phases/steps

- Understand relevant architecture/extension points well enough to avoid planning a parallel subsystem that already exists.
- Prefer existing domain objects, interfaces, services, registries, factories, utilities, and lifecycle boundaries when semantics fit.
- Use OOP/polymorphism for real current variation behind stable contracts; prefer composition unless inheritance expresses genuine substitutability.
- Do not force OOP where a simpler functional/data-oriented design is clearer.
- Do not redesign healthy architecture merely because another design is theoretically cleaner.
- Make each step the largest coherent worker-owned unit; make each phase earn a real integration/gate boundary.

## Worker route and effort selection

Plan work with the closed route table in `SKILL.md`. Route omission preserves the Luna default (`gpt-5.6-luna` + `xhigh`); Luna `max` needs the existing concrete justification; `sol-high` is an explicit choice of exactly `gpt-5.6-sol` + `high`. Do not plan an open model/effort cross-product or a fallback route.

Reserve Luna **`max`** for steps where extra exploration/verification has a concrete expected payoff: unresolved high-blast-radius architecture, subtle integrity/security/concurrency/replay/finality invariants, genuinely difficult cross-cutting interaction reasoning, recovery from an `xhigh` attempt that failed on the same hard reasoning boundary, a critical named adversarial risk, or explicit user/project authority.

Do not select Luna `max` merely because a step is large, touches many files, is an adversary/scout, or because higher effort sounds safer. Read-only surveys/scouts, bounded implementation, migrations after the design decision, focused repairs, tests, and documentation normally use their route's normal effort (`xhigh` for Luna, `high` for Sol). Sol does not escalate to `max`.

The orchestrator resolves the route before spawn and passes the exact model and effort explicitly. Before each `sol-high` launch it records the canonical phase/step/attempt binding required by `SKILL.md`; resume must preserve it or block. No permanent route/effort column is required unless the project benefits from one. If Luna `max` is selected for an otherwise ordinary-looking step, a one-line rationale in the handoff is enough—do not create a routing bureaucracy.

## Multi-run boundary

A run owns one coherent plan/scope. Multiple runs may coexist when repository ownership is safely independent.

When creating/replanning:

- use a short semantic run id under `Lunacy/runs/<run-id>/`;
- record concise `Workspace` and `Ownership` in run `STATE.md`;
- compare only ACTIVE run state boundaries before implementation;
- prefer isolated worktrees/branches for simultaneous runs when supported;
- serialize/replan overlapping surfaces/shared contracts or unsafe shared state.

Do not add a global registry, scheduler, lock service, or `CURRENT_RUN` merely to support this.

## Anti-overengineering

Do not add phases, abstractions, services, managers, factories, wrappers, adapters, configuration layers, migration machinery, feature flags, extension systems, generalized frameworks, persistent state, scouts, adversaries, or verification infrastructure unless the current task/risk materially requires them.

Avoid speculative future-proofing, abstractions before real variation/reuse, duplicate compatibility layers, unrelated cleanup, micro-step explosions, combining nearby unrelated work, distorting boundaries for concurrency, and elaborate proof machinery when existing checks suffice.

## Adversary selection

`Adversary` defaults to **NO**. Set it to YES only for a named risk that benefits from an independent attack: tricky invariant/identity/security behavior, broad migration, concurrency/state integrity, subtle compatibility, or another genuinely high-cost failure mode.

Do not mark every implementation step adversarial by habit. If more than one adversary is planned in a phase, each must attack a materially different risk or a later repaired state; otherwise consolidate/skip it.

## Verification ownership

Plan proof so each expensive layer has a clear owner rather than being replayed everywhere.

- Step owner: terminal verification of its final implementation state.
- Optional adversary: adversarial delta/impacted verification after any repair.
- Gate scout: read-only compression/navigation; no broad suite replay.
- Parent gate: one bounded acceptance sample chosen for integration risk.

**Authoritative acceptance requirements always win.** If project authority requires a full matrix, independent repetition, live proof, or a specific gate command, run it exactly as required—assign it to the appropriate layer rather than silently dropping it. Deduplicate only redundant proof beyond the authoritative contract.

Do not assign the same expensive/global matrix to implementer, adversary, scout, and parent merely because more repetition feels safer. A later code change that invalidates earlier evidence is the other reason to rerun it.

## Decision surfaces

When a planned step may uncover a genuine architecture/authority ambiguity, let the routed worker investigate it, but keep the parent decision surface small.

A `DECISION_REQUIRED` handoff should be one concise decision brief (≤30 lines / ~4 KB) plus exact evidence pointers. Larger surveys/logs remain worker evidence. Related contradictions from one bounded investigation should be consolidated before parent adjudication rather than producing serial amendments/messages.

Do not plan for parent repository archaeology. If a decision would require broad discovery, assign a routed-worker scout to compress it first.

## Gate-scout selection

Do **not** automatically schedule a scout for every phase. A scout is justified when it materially compresses parent integration work, e.g.:

- multiple writers changed interacting surfaces;
- an adversary repaired integration/shared contracts;
- terminal reports conflict or leave a material uncertainty;
- the phase is cross-cutting/high-risk enough that targeted navigation is valuable.

A single coherent low-risk phase normally goes directly to the parent gate.

Any scout runs only after all phase writers are FINAL and the run write barrier is CLOSED.

## Planning check

Before approving the plan, ask:

1. Can proposed new machinery be replaced by reuse/extension of something sound?
2. Is every new abstraction justified by current requirements/real variation/authority?
3. Is every phase/step necessary for ownership, dependency, risk, or a meaningful gate?
4. Are we solving the stated task rather than hypothetical future work?
5. Are established project style/contracts preserved where sound?
6. Is there a materially simpler design with the same required correctness/maintainability/extensibility?
7. Is verification owned once per layer while still satisfying every authoritative acceptance requirement?
8. Does each planned scout/adversary/decision artifact actually earn its cost?
9. Is this run safely independent of other ACTIVE run ownership?
10. Is each explicit route valid and durable, and is every Luna `max` call justified by a concrete reasoning-risk trigger rather than task size/role alone?

If #6 is yes, choose the simpler design.

## During hard gates

Treat unnecessary complexity and unnecessary proof duplication as real findings. A functionally correct solution can still fail if it adds unjustified mechanisms/layers/maintenance burden.

Parent inspection should be exact and bounded: gate pack/Control Blocks first, then exact source symbols/diff regions. If more than three substantive deep slices are needed, delegate compression or checkpoint/freshen parent context rather than bulk-reading the repository.
