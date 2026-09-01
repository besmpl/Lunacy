# Decisions

- 2026-09-01: Execute the accepted roadmap as four independently reversible release phases. R1 is the read-only safety boundary; R2 is the coupled mutating release; R3 and R4 remain separate.
- 2026-09-01: Preserve current public/runtime bytes and dirty user documentation. Source implementation and hermetic fixtures are authorized; no live install/deploy/push or mutation of historical run artifacts is authorized.
- 2026-09-01: The roadmap and prior user direction explicitly assign consequential implementation to Sol/high.
workerRoute: sol-high; phaseId: p1; stepId: S1; attemptEpoch: 1
- 2026-09-01: P1 parent gate returned FINDINGS for three reproducible closed validator/classifier defects; repair remains within the accepted R1 authority.
workerRoute: sol-high; phaseId: p1; stepId: S1; attemptEpoch: 2
- 2026-09-01: P1 repair passed hard gate 02. R2 now owns the coupled D3-D9 mutation release; it must not deploy live or mutate historical runs.
workerRoute: sol-high; phaseId: p2; stepId: S1; attemptEpoch: 1
- 2026-09-01: P2 writer finalized. The planned adversary is justified by irreversible deletion authority, cross-lock ordering, and crash-recovery state transitions; it is read-only and does not duplicate the broad suite.
workerRoute: sol-high; phaseId: p2; stepId: S1-adversary; attemptEpoch: 1
- 2026-09-01: Adversary attempt 1 produced no repository judgment because the host safety classifier rejected the wording. Retry unchanged P2 authority as a local read-only correctness review with no security framing.
workerRoute: sol-high; phaseId: p2; stepId: S1-adversary; attemptEpoch: 2
- 2026-09-01: Adversary attempt 2 was also rejected by the host content classifier before repository judgment. Parent review found one bounded canonical tree-digest defect and returned P2 FINDINGS; repair stays inside the same coherent R2 cell.
workerRoute: sol-high; phaseId: p2; stepId: S1; attemptEpoch: 2
- 2026-09-01: P2 passed hard gate 02 after the canonical digest repair and parent-focused acceptance. R3 remains a separate release with explicit abandonment authority and no live destructive exercise.
- 2026-09-01: R3 is one largest-coherent Sol/high owner cell. It extends the accepted private R2 finalizer and may not add runtime events/state, a second cleanup engine, live destructive canary, or P4 migration.
workerRoute: sol-high; phaseId: p3; stepId: S1; attemptEpoch: 1
- 2026-09-01: P3 parent gate returned FINDINGS because caller-declared custody counts were not revalidated against durable current actionable state. Repair remains inside R3 and must preserve UNKNOWN/malformed custody.
workerRoute: sol-high; phaseId: p3; stepId: S1; attemptEpoch: 2
- 2026-09-01: P3 passed hard gate 02 after durable current-state custody revalidation. R4 is separately reversible and limited to audit plus one explicitly selected Git-backed pilot implementation tested on temporary fixtures.
- 2026-09-01: R4 source implementation is one largest-coherent Sol/high owner cell. The architecture's metric prerequisite still blocks live rollout; only temporary Git fixtures may exercise mutation.
workerRoute: sol-high; phaseId: p4; stepId: S1; attemptEpoch: 1
- 2026-09-01: P4 parent gate returned FINDINGS for a reproduced non-text reference bypass and non-atomic final migration-marker publication. Both repairs remain inside R4.
workerRoute: sol-high; phaseId: p4; stepId: S1; attemptEpoch: 2
- 2026-09-01: P4 and the final integrated source candidate passed hard gate 02. Product ownership is released. Live rollout remains blocked on measurement/canary evidence and separate operator authority; commit/install/deploy/push were not performed.
