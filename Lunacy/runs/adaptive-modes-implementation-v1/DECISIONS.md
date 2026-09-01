# Decisions

- Plan revision 1 seals the complete roadmap, accepted observable, architecture spine, compatibility corridors, source-only authority, and P1→P5 ordering before the first implementation dispatch.
- R0 compatibility proof is folded into the P1 R1 routing cell; it is not a proof-only Plan milestone.
- No independent adversary is scheduled initially. P1's command ownership/restart risk is handled by its canonical vertical journey and existing exact recovery suites; a separate attack is earned only by a concrete residual at the gate.

workerRoute: sol-high; phaseId: p1; stepId: S1; attemptEpoch: 0

- P1 parent FINDINGS: replacing obsolete managed harness assumptions is valid, but marking 18 contract/recovery tests skipped weakens verification and violates the sealed no-fake-completion rule. Repair must convert or consolidate them onto exact persisted Wave/`roleView` fixtures, preserve their deeper semantics, and leave no new skip.

workerRoute: sol-high; phaseId: p1; stepId: S2; attemptEpoch: 0

- P1 parent gate PASS after S2 restored all skipped coverage and the parent acceptance sample proved the vertical routing journey.

workerRoute: sol-high; phaseId: p2; stepId: S1; attemptEpoch: 0

- P2 parent FINDINGS: the source behavior and boundary tests pass, but the sealed P2 gate and roadmap require the R2 crash lattice as isolated child processes. The candidate only restarted kernels inside one test process and did not execute the named before/after cut lattice, so acceptance evidence is incomplete.

workerRoute: sol-high; phaseId: p2; stepId: S2; attemptEpoch: 0

- P2 parent gate PASS after the isolated-child nine-cut crash lattice closed the evidence gap. Candidate floor remains disabled and is revalidated under the P5 release fence.

workerRoute: sol-high; phaseId: p3; stepId: S1; attemptEpoch: 0
workerRoute: sol-high; phaseId: p4; stepId: S1; attemptEpoch: 0
workerRoute: sol-high; phaseId: p5; stepId: S1; attemptEpoch: 0
