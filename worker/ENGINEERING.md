# Lunacy Worker Engineering Doctrine

Read this for implementation, repair, recovery, and adversarial work. Project-specific authority (`AGENTS.md`, architecture, contracts, active run `PLAN.md`) outranks this generic doctrine.

## Core rule

**Understand and reuse the existing system before inventing another one. Prefer the simplest coherent design that fully solves the actual task and fits the project's architecture. Complexity must earn its cost.**

Prefer modifying, reusing, deleting, or extending sound mechanisms over adding layers or parallel systems.

## Before writing code

1. Inspect relevant architecture, nearby implementations, types/classes/interfaces, helpers, factories/registries, tests, and call sites.
2. Inventory affected callers, sibling paths, lifecycle/persistence boundaries, and extension points.
3. For migrations/replacements/removals, inventory is **complete-by-default**: maintained production callers, tests, fixtures, adapters, examples, and indirect/variable-mediated construction are in scope unless explicit authority excludes them.
4. A green selected test matrix is evidence, **not scope authority**. Do not label a maintained surface `legacy`/`historical` without explicit authority.
5. Search for something that can be safely reused, extended, composed, specialized, or generalized before creating a parallel mechanism.
6. Understand ownership, invariants, and data flow around the change; do not patch one visible caller while ignoring the system around it.
7. When external/library semantics are uncertain and research is available, use authoritative/primary documentation rather than guessing.

## Scope / concurrent ownership

Own the durable step contract you were assigned. Do not silently turn discovery into authorization.

If deeper inspection shows correct completion requires any of the following, stop before that edit and return `BLOCKED` or `DECISION_REQUIRED`:

- editing another active step/run's surface;
- changing a shared contract another active owner depends on;
- consuming another active worker's unfinished result;
- mutating unsafe shared state;
- making an architectural decision that invalidates another active assumption;
- **materially expanding your own step beyond its durable contract**, even if no concurrent owner is involved.

Consolidate related newly discovered scope/authority contradictions into one decision brief. Do not ask for or accumulate a sequence of tiny ad-hoc overlap amendments while continuing to broaden the same worker's write set.

Do not quietly broaden because the edit seems easy. Conversely, do not avoid required in-scope work merely because it touches many files; the issue is authorization/ownership, not size.

## Design preferences

- Preserve sound existing architecture.
- Prefer clear responsibilities, strong interfaces, encapsulation, and explicit dependencies.
- Prefer composition unless inheritance expresses genuine substitutability/lifecycle.
- Use polymorphism when real behavior varies behind a stable contract; prefer it to repeated type checks/mode branches when a clean extension point genuinely fits.
- Extend existing abstractions when semantics match; do not contort them merely to avoid a justified new one.
- Avoid god objects, duplicate subsystems, hidden global state, leaky layers, shotgun changes, and speculative abstraction.
- Keep classes/functions/modules cohesive and names precise.
- Favor testable seams/dependency injection only where they materially reduce coupling.
- Preserve public contracts unless authority intentionally changes them.

**OOP is a tool, not a quota.** Do not manufacture classes, inheritance, factories, managers, services, wrappers, adapters, registries, or interfaces where a simpler existing/functional/data-oriented design is clearer.

## Anti-overengineering

Do not introduce machinery for hypothetical future needs. New abstraction/infrastructure needs a current requirement, real existing variation/reuse problem, or authoritative architectural direction.

Avoid speculative frameworks, one-use managers/services/factories, unnecessary compatibility layers, feature flags with no current need, unrelated cleanup, premature extension points, and elaborate test harnesses when existing checks prove the contract.

Prefer the smallest coherent diff/design that preserves clarity and architecture—not the smallest line count, and not architectural ceremony.

## Implementation

Raw output for an admitted run is temporary Body, not a durable report. Publish
it only with `runtime/retention-launcher.mjs with-body-writer`; do not redirect
a child directly into `.work`, create `.work` from a writer, or copy raw output
into a managed report. The parent alone prepares acceptance and seals after
PASS. Existing Body/finalization recovery continues when admission is OFF, and
`CLAIMED` or `UNKNOWN` effect material remains Custody.

- Make the change end-to-end across the complete affected inventory.
- Reuse domain objects/utilities when correct rather than cloning logic.
- If behavior exposes a genuine hole in an existing abstraction, improve that abstraction within scope rather than bolt on a parallel path.
- Remove obsolete duplicate paths made unnecessary when safe and in scope.
- Do not broaden into unrelated cleanup/rewrite without authority.

## Verification / self-review

Before terminal PASS, inspect the final diff and ask:

- Did I satisfy full coverage, including indirect/variable-mediated uses?
- Did I exclude anything as historical without authority?
- Did I miss a caller, sibling path, lifecycle edge, persistence boundary, or integration surface?
- Did discovery reveal required work outside my durable step contract that I should have escalated instead of editing?
- Did concurrent work reveal overlap I should have escalated?
- Did I duplicate something already present or create a second way to do the same thing?
- Could this reuse/extend an existing abstraction more cleanly?
- Is repeated branching hiding a real polymorphic extension point?
- Is every new abstraction/layer justified now?
- Is there a materially simpler design with the same correctness/maintainability?
- Do tests prove behavior/integration rather than implementation trivia?
- Did I preserve project contracts and avoid regressions?

Fix every issue found, then run the **terminal verification for the final code state once**. Development checks before the final state are working evidence, not parent-facing narrative.

**Never weaken authoritative acceptance to save tokens.** If the step/plan/project requires a full matrix, repeated run, live proof, or exact verification command, perform it exactly as required as part of the terminal verification. Avoid only redundant reruns beyond that contract.

Do not rerun an unchanged expensive broad matrix merely to produce a newer count. If a later code change invalidates proof, rerun what that change makes stale.

## Output / evidence discipline

Do not send intermediate progress. Parent mailbox messages are only:

- `BLOCKED`
- `DECISION_REQUIRED`
- `FINAL`

Each message is at most three short lines and points to durable evidence/report paths; never dump logs, inventories, hashes, or implementation narrative into chat.

Long command output goes to a log/evidence file or temporary file. Your report records only check/command, exit/result, useful count, and first relevant failure/red. Cite exact log path when deeper evidence may matter.

**Do not recopy unchanged known-red, residual, root-status, caller-inventory, or acceptance-boundary lists into each report.** Cite the authoritative project/run artifact or one evidence file containing the detailed inventory. Your parent-facing report states only what changed or what is newly relevant.

Do not create per-file hash catalogs unless project authority requires them. Prefer one aggregate fingerprint when drift identity is genuinely needed.

### Terminal report size

The parent-facing Control Block is at most ~12 lines. The entire worker/adversary report should normally stay within **60 lines / ~6 KB**. If evidence is larger, put it in an evidence file and cite exact pointers from the report.

Large caller inventories, raw surveys, long test output, repeated path tables, and hash tables belong outside the parent-facing report.

If a parent decision is required, stop the conflicting work and create one concise decision brief (target ≤30 lines / ~4 KB) with: question, authority, facts, options, recommendation, execution impact, and exact evidence pointers. Consolidate related contradictions from the same bounded investigation rather than sending serial amendments.

## Terminal verification / immutability boundary

The verification in the final Control Block is the terminal snapshot for the exact repository state reported.

After `FINAL`:

- freeze code, tests, generated artifacts, report, counts, and durable evidence referenced by it;
- make no cleanup, formatting, polish, opportunistic fixes, or post-PASS reruns;
- do not edit the report to append later parent/gate findings, newer hashes, or revised counts;
- finalize immediately.

If anything material changes later, the old FINAL artifact remains immutable. Use a new attempt/repair report, perform the appropriate terminal verification for the new state, and FINAL that new artifact.

An adversary follows the same rules. Attack the new risk/delta; if you repair something, verify the impacted surface. Do not blindly replay the implementer's entire broad matrix unless your repair actually invalidates it or authoritative acceptance requires it.
