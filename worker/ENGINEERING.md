# Lunacy Worker Engineering Doctrine

Read this for implementation, repair, recovery, and adversarial-review work. Project-specific authority (`AGENTS.md`, architecture, contracts, the active Lunacy run `PLAN.md`) outranks this generic doctrine.

## Core rule

**Understand and reuse the existing system before inventing another one. Prefer the simplest coherent design that fully solves the actual task and fits the project's architecture. Complexity must earn its cost.**

Do not confuse sophistication with quality. Prefer modifying, reusing, deleting, or extending sound existing mechanisms over adding new layers or parallel systems.

## Before writing code

1. Inspect the relevant existing architecture, nearby implementations, types/classes/interfaces, helpers, factories/registries, tests, and call sites.
2. Build a quick mental inventory of affected callers, sibling paths, persistence/runtime boundaries, and extension points.
3. For migrations/replacements/removals, treat the inventory as **complete-by-default**: include maintained production callers, tests, fixtures, adapters, examples, and indirect or variable-mediated construction. Do not label something `legacy`, `historical`, or out-of-scope unless project authority explicitly supports that classification.
4. A green test matrix is verification evidence, **not scope authority**. Absence from a selected matrix does not make a maintained caller/test obsolete.
5. Search explicitly for something that can be **reused, extended, composed, specialized, or generalized safely** before creating a parallel mechanism.
6. Understand ownership, lifecycle, invariants, and data flow around the change; do not patch one visible caller while ignoring the system around it.
7. When external behavior/library semantics are uncertain and research is available, check authoritative/primary documentation rather than guessing.

## Concurrent ownership

When other Lunacy steps or runs are active concurrently, **own your assigned scope and do not race neighboring workers**.

Your initial boundary is an independence assumption made by the orchestrator. Your deeper repository inspection must validate it. If correct completion unexpectedly requires any of the following, stop before making the conflicting edit and report the overlap/blocker:

- editing a surface another active step/run owns or is likely editing;
- changing a shared schema, protocol, API, abstraction, generated artifact, or behavioral contract another active worker/run depends on;
- consuming another active worker's not-yet-durable result;
- mutating shared state that is unsafe to modify concurrently;
- making an architectural decision that invalidates another active step/run's assumptions.

Do not quietly broaden scope across another active owner just because the edit seems easy. Preserve your non-conflicting work and let the orchestrator serialize or replan the overlap.

Conversely, do not avoid required in-scope work merely because it touches many files. The issue is **conflicting active ownership**, not change size.

## Design preferences

- Preserve and strengthen the project's existing architecture when it is sound.
- Prefer clear responsibilities, strong interfaces, encapsulation, and explicit dependencies.
- Prefer composition over inheritance unless a true substitutable abstraction/lifecycle relationship exists.
- Use **polymorphism** when behavior genuinely varies behind a stable contract; prefer it to repeated type checks, mode switches, duplicated branches, or growing `if/else`/`switch` logic when an existing/new extension point cleanly fits.
- Extend an existing abstraction when semantics match; do not contort an abstraction merely to avoid adding a justified new one.
- Avoid god objects, duplicated subsystems, hidden global state, leaky layers, shotgun changes, and speculative abstraction.
- Keep classes/functions/modules cohesive and names precise. Make invalid states difficult to represent when practical.
- Favor testable seams and dependency injection where they materially improve isolation or replace hidden coupling.
- Preserve public contracts and compatibility unless the authoritative task intentionally changes them.

**OOP is a tool, not a quota.** Do not manufacture classes, inheritance, factories, managers, services, wrappers, adapters, registries, or interfaces where a simpler functional/data-oriented or existing design is clearer.

## Anti-overengineering guardrails

Do **not** introduce machinery merely because it could be useful later. New abstractions and infrastructure must be justified by the current task, a real existing variation/reuse problem, or authoritative architecture.

Avoid:

- speculative future-proofing for hypothetical requirements;
- generalized frameworks where a small direct change is sufficient;
- new managers/services/factories/wrappers/config layers for one simple behavior;
- compatibility or migration layers when a direct safe migration is the actual requirement;
- feature flags or persistent state with no present need;
- broad cleanup or architectural rewrites unrelated to the step;
- adding extension points before there is something real to extend;
- elaborate test harnesses when existing tests/checks can prove the required contract;
- preserving obsolete complexity after the new path makes it unnecessary and safe removal is in scope.

Do not optimize for the imagined next five requirements. Optimize for correctness, clarity, maintainability, and reasonable extension of the requirements that actually exist.

## Implementation

- Make the change end-to-end, including all affected callers/surfaces discovered during inspection.
- Reuse existing utilities and domain objects where correct instead of cloning logic.
- If new behavior makes an existing abstraction obviously incomplete, improve that abstraction within step scope rather than bolt on a parallel path.
- Remove obsolete/duplicated paths made unnecessary by the change when safe and in scope.
- Do not broaden into unrelated cleanup or architectural rewrites without authority.
- Prefer the smallest coherent diff/design that preserves clarity and architectural integrity; smallest line count is not the goal, but neither is architectural ceremony.

## Verification and self-review

Before PASS, inspect the resulting diff and ask:

- Did I satisfy the step's full inventory/coverage criterion, including indirect and variable-mediated uses?
- Did I exclude any caller/test as legacy or historical without explicit authority?
- Did I mistake a green selected test matrix for proof that uncovered maintained surfaces are irrelevant?
- Did I miss any caller, sibling path, lifecycle edge, persistence boundary, or integration surface?
- If other workers/runs were concurrent, did deeper inspection reveal any shared ownership/contract interaction that should have been escalated?
- Did I create something the repository already had?
- Did I introduce a second way to do the same thing?
- Could this cleanly reuse/extend an existing abstraction instead?
- Is repeated branching hiding a polymorphic extension point?
- Is every new abstraction/layer justified by a current requirement or real existing variation?
- Did I add machinery mainly for hypothetical future use?
- Is there a materially simpler design with the same correctness and maintainability?
- Is the new abstraction genuinely useful, or ceremony?
- Are responsibilities and dependencies clearer after the change?
- Do tests verify behavior and integration, not just implementation details?
- Did I preserve project contracts and avoid regressions?

If a simpler design preserves the required behavior, maintainability, and project architecture, simplify it. Fix every issue found and re-run relevant verification.

## Terminal verification/report boundary

The verification recorded in the final Control Block is the **terminal verification snapshot** for the exact repository state being reported.

After that snapshot passes and the Control Block is written:

- freeze code, tests, generated artifacts, and report counts/results;
- make no further edits, cleanup, formatting, polish, or opportunistic fixes;
- do not rerun verification merely to produce a newer count/status message;
- do not emit revised post-completion progress or verification summaries;
- finalize immediately.

If anything material changes after the supposed final snapshot, the prior PASS/report is invalid: perform the required verification again and rewrite the final Control Block once for the new terminal state.