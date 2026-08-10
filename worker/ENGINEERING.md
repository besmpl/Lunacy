# Lunacy Worker Engineering Doctrine

Read this for implementation, repair, recovery, and adversarial-review work. Project-specific authority (`AGENTS.md`, architecture, contracts, `Lunacy/PLAN.md`) outranks this generic doctrine.

## Core rule

**Understand and reuse the existing system before inventing another one.** Prefer the smallest coherent design that fits the project's architecture, not merely the smallest patch.

## Before writing code

1. Inspect the relevant existing architecture, nearby implementations, types/classes/interfaces, helpers, factories/registries, tests, and call sites.
2. Build a quick mental inventory of affected callers, sibling paths, persistence/runtime boundaries, and extension points.
3. Search explicitly for something that can be **reused, extended, composed, specialized, or generalized safely** before creating a parallel mechanism.
4. Understand ownership, lifecycle, invariants, and data flow around the change; do not patch one visible caller while ignoring the system around it.
5. When external behavior/library semantics are uncertain and research is available, check authoritative/primary documentation rather than guessing.

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

**OOP is a tool, not a quota.** Do not manufacture classes, inheritance, factories, or interfaces where a simpler functional/data-oriented design is clearer and consistent with the project.

## Implementation

- Make the change end-to-end, including all affected callers/surfaces discovered during inspection.
- Reuse existing utilities and domain objects where correct instead of cloning logic.
- If new behavior makes an existing abstraction obviously incomplete, improve that abstraction within step scope rather than bolt on a parallel path.
- Remove obsolete/duplicated paths made unnecessary by the change when safe and in scope.
- Do not broaden into unrelated cleanup or architectural rewrites without authority.

## Verification and self-review

Before PASS, inspect the resulting diff and ask:

- Did I miss any caller, sibling path, lifecycle edge, persistence boundary, or integration surface?
- Did I create something the repository already had?
- Did I introduce a second way to do the same thing?
- Could this cleanly reuse/extend an existing abstraction instead?
- Is repeated branching hiding a polymorphic extension point?
- Is the new abstraction genuinely useful, or ceremony?
- Are responsibilities and dependencies clearer after the change?
- Do tests verify behavior and integration, not just implementation details?
- Did I preserve project contracts and avoid regressions?

Fix every issue found, re-run relevant verification, then write the concise Lunacy Control Block and finalize immediately.
