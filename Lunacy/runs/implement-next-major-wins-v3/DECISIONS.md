# Decisions

- The user authorized implementation of the entire accepted v3 roadmap, not another discovery-only pass.
- Preserve the fixed portfolio order and keep the four product boundaries distinct; shared proof/identity vocabulary may be frozen once and reused.
- P0 uses one bounded exact Sol/high judgment because cross-feature authority, persistence, transport, and rollback ownership is consequential. Repository implementation returns to Luna/xhigh.
- workerRoute: sol-high; phaseId: p0; stepId: S0; attemptEpoch: 1
- Accept S0's two v1 narrowings: P1 grants bind an already committed, unconsumed READY GATE token; P4 may skip prior bytes only within a still-valid trusted verification session, while cold start or identity drift requires full verification absent a separately authorized external trust anchor.
- Freeze the shared canonical binding/proof vocabulary once, but keep mutation authority in the existing kernel, inbox, dispatch coordinator, file store/CURRENT, and release transaction seams.
- For P1-B, remove any wake source that is only an unbound string. Keep explicit resume; keep proof only with exact current run/outbox/effect binding. Receipt/terminal/inbox wake labels remain disabled until an exact witness contract exists; P1-C may introduce inbox availability only through its exact current snapshot/grant contract.
- workerRoute: sol-high; phaseId: p1; stepId: S3D; attemptEpoch: 1
- Accept `phases/p1/reports/S3D-worker-01.md`: remove the Python helper and keep the Node 22+/no-runtime-dependency contract. P1-B guarantees identity-fenced old-or-new publication and replacement-safe cleanup only under a stable privately owned namespace; concurrent same-UID rename/replace between the final identity sample and a lexical syscall is explicitly outside contract and does not gate. Pre-boundary/observable substitution, conservative exact-identity cleanup, no stale-lock reclamation, cooperating-process exclusion, and all S3R lease/proof/CAS/wake fences remain gating. This supersedes only the impossible exact-syscall-interval wording derived in S3R2; finalized reports remain evidence.
