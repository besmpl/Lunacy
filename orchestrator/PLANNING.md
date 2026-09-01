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
- Put only work required to reach the authority-owned accepted outcome in the current Plan. Required documentation, accessibility, quality/polish, and similar completion work remain required when authority includes them; exclude only genuinely optional work. Optional polish is not an executable node; after the parent gate accepts the outcome, it may be proposed as a separately authorized follow-up.
- Do not create optional polish, proof-only, or retention-only nodes before or after the accepted journey. Raw non-runtime material belongs in admitted Body; the parent gate prepares acceptance before PASS and seals only after evaluating the observable.
- Default to one largest-coherent end-to-end worker owner for the accepted outcome. Split only at a real authority, ownership, safety, or external-dependency boundary, or, as a fifth exception, when evidence shows that one worker would exceed a measured context, time, or tool-capacity boundary. For that capacity exception, use the fewest acceptance-required vertical slices; never create planning, reporting, proof, test-count, or milestone slices. Make each phase earn a real integration/gate boundary.
- Before the first implementation dispatch, the parent seals the existing user/project requirements, accepted observable/result, and chosen architecture spine in the existing Plan/run authority. A material authority change requires new Plan/run authority; never drip-feed a live implementation Plan.
- Acceptance occurs only at the parent gate, never at dispatch `ACK` or worker `PASS`. Already-claimed or `UNKNOWN` effects retain custody until they are reconciled; replanning does not abandon or duplicate them.

## Worker route and effort selection

Plan work with the closed route table in `SKILL.md`. Route omission preserves the Luna default (`gpt-5.6-luna` + `max`); `sol-high` is an explicit choice of exactly `gpt-5.6-sol` + `high`. Do not plan another Luna effort, an open model/effort cross-product, or a fallback route.

Keep Luna on `max` for read-only surveys/scouts, bounded implementation, migrations after the design decision, focused repairs, tests, documentation, and other repository execution. Luna/max is the fixed route, not an intermediate tier. A named consequential judgment boundary, including one left unresolved by a materially failed Luna/max attempt, requires a fresh authorized `sol-high` attempt rather than an effort switch inside the Luna route.

The orchestrator resolves the route before spawn and passes the exact model and effort explicitly. Before each `sol-high` launch it records the canonical phase/step/attempt binding required by `SKILL.md`; resume must preserve it or block. No permanent route/effort column is required unless the project benefits from one.

## Default role policy

Use this simple flow when assigning work: **parent judgment/gate → Luna/max repository execution/self-verification → optional Sol/high bounded judgment → Luna implementation of decisions → parent acceptance**. Route repository-heavy implementation, tests, ordinary repairs, documentation, read-only scouts, and ordinary adversarial reviews to Luna/max by default. Sol/high is opt-in only for bounded consequential judgment—an architecture/contract choice, conflicting-evidence adjudication, or a narrow named acceptance question. Sol/high is not an automatic independent verifier or a generic escalation tier; independent verification is conditional on a named risk, not automatic. When Sol advice changes code, implementation returns to Luna unless the user or project explicitly assigns Sol implementation; the parent owns acceptance.

Host parent selection: GPT-5.6 Sol at `high` is the preferred parent/orchestrator when the host lets the user select it, because the parent owns consequential judgment. A current allowed non-Sol parent remains valid; never spawn a shadow/duplicate parent to simulate the preference. This host-level preference is separate from the explicit worker `sol-high` route and its attempt binding, and it does not create a Sol attempt binding.

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
10. Is each explicit route valid and durable, with Luna fixed at `max` and every `sol-high` attempt bound to a named consequential judgment boundary?

If #6 is yes, choose the simpler design.

## During hard gates

Treat unnecessary complexity and unnecessary proof duplication as real findings. A functionally correct solution can still fail if it adds unjustified mechanisms/layers/maintenance burden.

Parent inspection should be exact and bounded: gate pack/Control Blocks first, then exact source symbols/diff regions. If more than three substantive deep slices are needed, delegate compression or checkpoint/freshen parent context rather than bulk-reading the repository.
