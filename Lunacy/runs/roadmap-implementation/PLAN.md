# Lunacy Execution Plan

## Authority
Goal: Implement the complete accepted R1-R4 roadmap, integrate it, verify it, install it, and publish the accepted fork main.
Roadmap: `docs/ROADMAP.md`.
Architecture decision: `Lunacy/runs/next-big-wins/phases/p2/reports/S5-worker-01.md` and its PASS gate.
Project rules: `/Users/mark/Documents/Codex/2026-08-26/continuously-pursue-major-local-lunacy-architecture/AGENTS.md`, repository contracts, and current user instructions.

## Ethos / core principles
- Implement in fixed order R1 → R2 → R3 → R4; each release must be independently safe and revertible.
- Reuse the kernel, bridge, store, effect-record, and pump seams; do not create parallel authority.
- Preserve public/package compatibility, exact replay, failure visibility, manual fallback, recovery, and rollback.
- Prove semantics and faults before performance claims; make no unsupported performance or token claims.

## Non-negotiable contracts
- R1 never parses Markdown for authority, auto-approves, crosses a parent boundary, or blindly relaunches UNKNOWN work.
- R2 keeps legacy reads/writes compatible until the new reader and crash protocol pass; compaction is explicit and never silently prunes history.
- R3 changes no public API or durable encoding and preserves exact lifecycle traces.
- R4 is bounded, token-scoped, deterministic, redacted, and strictly read-only.
- Existing one-event/manual workflows remain truthful fallbacks.
- Installation and publication occur only after the integrated final gate.

## Phases / gates
P1 — R1 lifecycle controller | step: S1 | gate: end-to-end idempotence/restart/boundary/legacy proof plus full check.
P2 — R2 segmented journals/checkpoints | step: S2 | gate: old/new format parity, >10,000-transition proof, fault-injected publication/migration/rollback, full check.
P3 — R3 dispatch coordinator | step: S3 | gate: exact differential lifecycle parity and full check.
P4 — R4 recovery forensics | step: S4 | gate: schema/binding/redaction/mutation-free proof and full check.
P5 — Integrated release | step: S5 | gate: whole-roadmap compatibility, release/install checks, exact installed state, normal commit/push to fork main.
Optional adversaries: conditional only for a named gate risk or repair.
Final gate: every roadmap exit criterion is satisfied, all current user requirements are integrated, release rollback is proven, and no unsupported claim remains.

## Verification ownership
- Each implementation worker owns focused development checks and one terminal `npm run check` after its final code change.
- Parent phase gate inspects targeted diff/behavior and runs one bounded acceptance sample; it does not replay the entire worker matrix.
- P2 owns the required long-history and crash-format corpus; P3 owns lifecycle differential traces; P4 owns mutation-free namespace proof; P5 owns final install/release evidence.
