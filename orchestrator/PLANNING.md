# Lunacy Orchestrator Planning Doctrine

Read this when creating or materially replanning a Lunacy execution plan. Project-specific authority (`AGENTS.md`, architecture, contracts, user intent) outranks this generic doctrine.

## Core rule

**Use the simplest architecture and execution plan that fully solves the actual task and fits the existing system. Complexity must earn its cost.**

Do not confuse sophistication with quality. Prefer modifying, reusing, deleting, or extending sound existing mechanisms over introducing new layers.

## Before defining phases/steps

- Understand the relevant existing architecture and extension points well enough to avoid planning a parallel subsystem that already exists.
- Prefer existing domain objects, interfaces, services, registries, factories, utilities, and lifecycle boundaries when their semantics fit.
- Use OOP and polymorphism when they model real current variation behind a stable contract; prefer composition unless inheritance expresses a genuine substitutable relationship.
- Do not force OOP onto a project or problem where a simpler functional/data-oriented design is clearer.
- Do not redesign healthy architecture merely because another design is theoretically cleaner.

## Multi-run boundary

A Lunacy run should own one coherent plan/scope. Multiple runs may exist in the same project and may execute concurrently when their repository ownership is safely independent.

When creating or materially replanning a run:

- give it a short semantic run id;
- keep its durable execution state under `Lunacy/runs/<run-id>/`;
- record a concise `Ownership` boundary in that run's `STATE.md` describing the subsystem/surfaces/shared contracts it expects to change;
- compare that boundary with the tiny `STATE.md` files of other `ACTIVE` runs before implementation;
- prefer isolated worktrees/branches for simultaneous runs when the host supports them;
- serialize or explicitly replan if another active run owns overlapping surfaces/shared contracts or if isolation is insufficient.

Do not add a global run registry, scheduler, lock service, or `CURRENT_RUN` pointer merely to support this. The `runs/` directories and their tiny state files are the registry.

## Anti-overengineering guardrails

Do **not** add phases, abstractions, services, managers, factories, wrappers, adapters, configuration layers, migration machinery, feature flags, extension systems, generalized frameworks, or new persistent state unless the current task or authoritative architecture materially requires them.

Avoid:

- speculative future-proofing for hypothetical requirements;
- abstractions created before there is a real variation/reuse problem or explicit architectural need;
- duplicate compatibility layers when a direct migration is safe;
- broad cleanup/refactoring unrelated to the requested outcome;
- splitting one coherent change into many tiny steps merely to create more agent work;
- combining unrelated cleanup into a step because it is nearby;
- distorting step boundaries or architecture just to manufacture concurrency;
- elaborate verification infrastructure when existing tests/checks can prove the contract adequately.

A step should be the **largest coherent unit one Luna can safely own**, not the smallest imaginable task. A phase should exist because it creates a meaningful integration/gate boundary, not because more hierarchy looks rigorous.

## Planning check

Before approving the plan, ask:

1. Can any proposed new mechanism be replaced by reuse/extension of something sound that already exists?
2. Is every new abstraction justified by a current requirement, real variation, repeated behavior, or authoritative architectural direction?
3. Is every phase/step necessary for ownership, dependency, risk, or a meaningful gate?
4. Are we solving the stated task rather than hypothetical future tasks?
5. Are we preserving the project's established style and contracts where they remain sound?
6. Is there a materially simpler design with the same correctness, maintainability, and extensibility for the requirements actually in scope?
7. Does this run's ownership boundary stay independent of other active runs, or do we need isolation/serialization/replanning?

If yes to #6, choose the simpler design.

## During hard gates

Treat unnecessary complexity as a real finding. A solution can be functionally correct and still fail the gate if it introduces unjustified parallel mechanisms, abstractions, layers, or maintenance burden. Send concrete simplification findings back to Luna rather than refactoring them in the parent.