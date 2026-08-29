# Plan — implement the whole next-major-wins v3 roadmap

## Goal and authority

Implement all four accepted directions in `docs/NEXT_BIG_WINS_V3_ROADMAP.md`, in the fixed order established by `Lunacy/runs/next-big-wins-v3/phases/p2/reports/S5-worker-01.md` and its PASS gate. The baseline is commit `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7` plus the complete P5 READY working candidate, detailed v3 roadmap, and the gated release-envelope `pathDigest` repair.

## Non-negotiable boundaries

- Reuse existing kernel, reducer, store, effect, inbox, fleet, bridge, recovery, and release authority seams; do not create a second scheduler, approver, event authority, or release authority.
- Every feature begins private/explicit and fail-closed, preserves legacy/manual behavior, and has a tested disablement/rollback path.
- Unknown effects never relaunch; stale/invalid evidence never authorizes work; indexes/projections remain discardable and non-authoritative.
- Preserve unrelated user work and the accepted dirty baseline. No reset, overwrite, unreviewed broad refactor, public API change, default-route change, release/install, commit, or push without the applicable phase/final gate.
- Facts, measurements, and hypotheses remain distinct. No unsupported performance, token, provider, security, or production claim.

## Phases

### P0 — implementation contract and dependency freeze
Bound Sol/high judgment converts the accepted roadmap into a minimal integration plan: exact shared contracts, phase-owned seams, sequencing, proof ownership, rollback boundaries, and named risks. No product edits.

### P1 — proof-gated durable continuation
Implement the private worker-proof/session/grant slice in bounded stages, with one exact pre-authorized `PASS`, durable lease/restart behavior, replay resistance, fail-closed attention, and manual fallback. Gate authority and uncertain-effect behavior before proceeding.

### P2 — transport-neutral attested execution plane
Implement frozen private command/receipt/terminal frames, loopback byte parity, and one explicit no-shared-filesystem reference transport. Preserve kernel claim/ack authority, local driver behavior, cancellation, and `UNKNOWN` semantics.

### P3 — portable authoritative run continuity
Implement cold export/import for one quiesced run root with closed manifest, semantic/digest validation, empty-root or explicit restore transaction, source-retirement/takeover fences, uncertain-effect preservation, and failed-import invisibility.

### P4 — authenticated incremental run-state engine
Implement a private discardable authenticated history index and lazy range verification with full-replay oracle/fallback; then an explicit writer only after parity. Context/graph consumption and any ceiling change remain separately gated by evidence.

### P5 — integrated proof, release, and recovery
Run the authoritative full matrix once on the final state, targeted cross-feature fault/adversarial proof where named risks require it, exact packaging/deployment checks, rollback proof, production install only after an explicit final gate, and commit/push only when authorized by the current user/release workflow.

## Execution model

Use exact Luna/xhigh workers for repository-heavy implementation, tests, repairs, and documentation. Use exact Sol/high only for bounded consequential contract/adjudication questions recorded in `DECISIONS.md`. Serialize overlapping authority/storage/release writes. Parent closes each phase gate from immutable reports and bounded actual-code acceptance samples.

## Completion

The goal completes only when all four roadmap directions are implemented through their stated decisive proofs, compatibility/recovery and rollback remain green, the integrated final gate passes, and the latest accepted artifact is safely installed/released as authorized. Any value/performance claim remains unclaimed unless its exact roadmap evidence gate passes.
