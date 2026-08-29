# S1 Worker Report — post-R1–R4 orchestration/autonomy scout

R1–R4 are shipped; none is re-proposed. Unmarked statements are facts; inferences are labeled.

## Ranked directions

### 1. Explicit multi-run scheduler with fair, claim-aware pump turns
- **Bottleneck (facts):** No global registry, scheduler, lock DB, or `CURRENT_RUN` (`WORKSPACE.md:29`). `BridgeDrivePump` is ephemeral/single-run (`src/orchestration.ts:103-109`); bridge lifecycle accepts one root/id/plan and explicitly does not schedule multiple roots (`docs/BRIDGE.md:52-57`). Concurrency proof covers only two pumps on one root/one launch (`test/orchestration.test.js:151-170`).
- **Payoff (inference):** Advance selected runs without hand-driving each; fair turns and claim arbitration improve scale/reliability. No throughput claim.
- **Smallest slice (inference):** Private scheduler takes canonical explicit `{runDir, runId, plan, driver/policy}` entries, round-robins bounded lifecycle turns, and emits deterministic terminal/attention records. Wrap admission (`src/admission.ts:4-12`) with in-memory `claimsConflict` reservations; no ambient discovery/durable queue.
- **Dependencies:** R1 result/stop semantics, R3 coordinator, Workfront/CURRENT readers, and explicit cross-run reservation policy. Restart rebuilds from caller roots; kernels remain durable authority.
- **Risks:** Duplicate pumps, starvation, stale roots, conflicting claims, crash-lost cursor, and non-atomic cross-process reservations. No global registry.
- **Decisive proof:** Two-plus roots receive deterministic fair order and at-most-once launches; conflicting claims fail closed; duplicate scheduler, crash/restart, stale plan/root, gates, UNKNOWN, and attention preserve replay. Extend `test/orchestration.test.js:151-170` and `test/p3-admission-ownership.test.js:138-149`; manual route unchanged.

### 2. Digest-bound decision inbox and approval workflow (manual by default)
- **Bottleneck (facts):** `Yield` has brief/token, but durable `decisionTokens` are only GATE/adoption records (`src/model.ts:84-120,139`; GATE `src/reducer.ts:247-251`). Workfront emits attention codes without token/brief/evidence refs (`src/workfront.ts:10-18,58-71`); CLI has no inbox action (`src/bridge-cli.ts:251-262`). Worker `NEEDS-DECISION` is enveloped then marks step/run `BLOCKED` without a durable token (`src/reducer.ts:156-180`; `src/orchestration.ts:274-279`).
- **Payoff (inference):** One bounded queue of actionable gates/adoptions and evidence-only approvals replaces per-run hidden-state archaeology. Parent/manual authority is default; automatic approval needs separate opt-in.
- **Smallest slice (inference):** Private `decisions` route accepts explicit run list, reads verified CURRENT/Workfront/forensics, and emits canonical `{kind, token, brief/evidence digest, revision/epochs, nextProof}`. Action submits only exact `PARENT_DECISION` for durable tokens with digest/epoch checks and replay; worker approval stays evidence-only until separately authorized token schema.
- **Dependencies:** R1 attention/result, R4 evidence capsule, token identity, and current decision path (`docs/API.md:64-71`; `src/public.ts:478-538`). Scheduler optional; Markdown is not authority.
- **Risks:** Stale/replayed tokens, unsafe auto-approval, sensitive refs, double consumption, second authority. Preserve `HumanReceiptRequired`, one-shot tokens, manual fallback.
- **Decisive proof:** Deterministic GATE/adoption aggregation; wrong token/digest/revision/epoch rejected without consume; duplicate action exact replay; approval/UNKNOWN never self-approve; read mutation-free. Cover `test/s5-adversary.test.js:67-80`, `test/p3-cross-phase-authority.test.js:88-104`, `test/orchestration.test.js:37-50`.

### 3. Parent-authorized phase-chain handoff (dependent phase orchestration)
- **Bottleneck (facts):** `Plan` has one `phaseId`/steps and no successor relation (`src/model.ts:26-32`). Pump stops at FINAL/parent boundaries (`src/orchestration.ts:193-205`); bridge does not synthesize plans/cross boundaries (`docs/BRIDGE.md:50-57,104-108`); phase-ID changes are fenced (`src/reducer.ts:287-289`; `test/p3-cross-phase-authority.test.js:88-104`). Skill closes a phase barrier and requires parent gate review (`SKILL.md:183-208`).
- **Payoff (inference):** Verified dependent phases can hand off without bespoke command choreography, while each gate/evidence remains authoritative. Not auto-approval/workflow DSL.
- **Smallest slice (inference):** Private adapter takes explicit predecessor/successor roots, canonical successor plan, predecessor FINAL/gate token, and artifact digest; verifies predecessor, requires parent handoff, then calls `initRun`/`runRun`. No ambient DAG/second authority.
- **Dependencies:** R1 lifecycle, gate tokens, immutable refs, and parent-owned handoff record/schema; scheduler/inbox optional.
- **Risks:** Gate/phase bypass, stale digest, crash handoff→START, rollback, unauthorized chain state.
- **Decisive proof:** Two-phase fixture refuses successor before exact PASS/handoff; wrong phase/digest/old-work fails closed; crash before/after successor init retries idempotently with predecessor unchanged; replay/manual single-phase bytes match.

**Explicit rejections:** Ambient discovery/global queues, dashboard-only aggregation, planner/reuse extraction, and projection no-op rewrites are smaller or deferred pending roadmap triggers (`docs/ROADMAP.md:411-418`).

## Control Block
- **Status:** PASS (read-only discovery complete).
- **Goal/result:** Ranked three post-R1–R4 orchestration/autonomy directions with evidence, slices, dependencies, risks, and proof gates.
- **Changed:** This report only; no source, tests, product, docs, or generated artifacts changed.
- **Verification:** `npm run typecheck` PASS; `npm test` PASS (444 passed, 2 skipped, 0 failed; `/tmp/s1-nextwins-npmtest.log`).
- **Claim discipline:** No provider/token/native/latency/throughput/speedup claim; structural facts and labeled inferences only.
- **Decision needed:** NO. **Blockers:** none.
