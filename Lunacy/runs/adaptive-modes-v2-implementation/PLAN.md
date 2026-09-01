# Adaptive Modes v2 Implementation Plan

## Authority
Goal: implement, verify, package, atomically install, canary, commit, and safely push the accepted adaptive v2 architecture.
Roadmap: `docs/ADAPTIVE_MODES_V2_IMPLEMENTATION_ROADMAP.md`.
Architecture: `/Users/mark/Documents/Codex/2026-08-29/hoq/outputs/adhd-lunacy-adaptive-architecture-v2.md` at SHA-256 `1e4aeac9c7b37f0eb501e3710345e7b7808a55a526105d3b86c6e45a243bcb1d`.
Project rules: `WORKSPACE.md`, `Lunacy/PROJECT_NOTES.md`, `/Users/mark/.codex/skills/lunacy/SKILL.md`, `/Users/mark/.codex/skills/lunacy/worker/ENGINEERING.md`.

## Architecture spine
- One RunKernel control plane; Direct is physically isolated.
- AUTO is one typed pre-Plan decision; Explore is explicit-only.
- Managed START is locked/root-bound and host-attested before publication.
- Policy assets own exact restart semantics; parent alone adopts the Plan.
- Permanent provider-intent fence forbids ambiguous re-entry.
- Strict fresh writers, census-supported byte-compatible historical readers.

## Execution
P1 — one largest-coherent vertical owner implements roadmap Cells 0–5, preserving the dirty candidate. Internal cells are bisection boundaries, not product milestones. Route: explicit Sol/high.

## Verification and gate
Owner: focused red/green work, terminal typecheck/build/focused suites/full test/pack/tracked-only deployment against an immutable candidate, self-review, install/canary/rollback/push only at exact roadmap gates.
Independent adversary: only if a named unresolved risk remains after owner self-review.
Parent final gate: inspect resolver, managed admission/restart/adoption, policy/frame recovery, context firewall, provider fence, exact committed/installed identity, canary rollback, and remote fast-forward safety; run bounded acceptance samples required by the roadmap.

## Acceptance
All 17 architecture acceptance observables and roadmap §1/§8 hold. Worker PASS, counts, or artifacts alone are insufficient.
