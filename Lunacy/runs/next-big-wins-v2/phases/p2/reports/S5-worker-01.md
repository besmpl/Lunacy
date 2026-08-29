# S5 — ranked post-R1–R4 directions

Baseline: `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7`; R1–R4 are dependencies, not proposals.

## 1. Explicit multi-run fleet coordinator with cross-run admission
- **Evidence (fact):** No registry/scheduler exists (`WORKSPACE.md:29`); pump/lifecycle own one root, not scheduler state (`src/orchestration.ts:105-109,529-545,745-774`); admission is per-run (`src/admission.ts:4-12`). Concurrency tests cover one root (`test/orchestration.test.js:151-170`).
- **Payoff (inference):** Fairly advance authorized roots and prevent claim overlap without per-root polling; no throughput claim.
- **Smallest coherent first slice:** On an explicit digest-bound root/plan/policy/claims manifest, CAS-lease one round-robin entry, revalidate conflicts, call `resumeRun`, record attention/release. Queue is advisory; kernels stay authoritative.
- **Ordering/dependencies:** First; reuse R1 lifecycle, R3 effects, R4 inspection, and fences. Start single-process with durable leases.
- **Risks:** Second authority, duplicates, stale roots, starvation, lease loss, conflicts, UNKNOWN; require digest/CAS, one lock order, fail-closed reconciliation.
- **Decisive proof:** Competing coordinators show restart-stable fairness, one launch/token, no claim overlap, crash convergence, stale-root rejection, and unchanged parent/UNKNOWN paths.

## 2. Digest-bound decision inbox, then exact parent-authorized phase promotion
- **Evidence (fact):** Tokens are per-state, one-shot/digest-bound (`src/model.ts:84-88,107-143`; `src/reducer.ts:247-278`; `src/public.ts:478-538`), but Workfront exposes only codes (`src/workfront.ts:10-22,58-71`). Plans are single-phase and cross-phase adoption is fenced (`src/model.ts:26-32`; `src/orchestration.ts:193-205`; `src/reducer.ts:287-289`).
- **Payoff (inference):** An auditable cross-run queue makes stops actionable; exact successor handoff removes choreography without auto-approval.
- **Smallest coherent first slice:** Read-only manifest inbox of token, evidence digest, cursor/epochs, and R4 `nextProof`; submit one rebound `PARENT_DECISION`. Next require explicit handoff plus predecessor FINAL/gate and successor-plan digest before `initRun`.
- **Ordering/dependencies:** After #1 manifest identity; promotion follows inbox proof. No general DAG.
- **Risks:** Second authority, replay, stale epochs, leakage, gate bypass; keep redaction, kernel mutation, CAS/idempotency, digest/epoch fences.
- **Decisive proof:** Two runs sort; concurrent submit commits/replays one event; bad bindings do not consume (`test/s5-adversary.test.js:67-80`). Two phases refuse pre-PASS/stale handoff and crash-retry init (`test/p3-cross-phase-authority.test.js:88-104`).

## 3. Incremental bounded-prefix segmented history
- **Evidence (fact):** R2 read still parses/digests every segment and full history (`src/store.ts:1535-1573`); commit walks the full journal, fsyncs reused segments, recomputes prefix digest, and writes full state/head (`src/store.ts:1926-1959`). >10k/fault tests prove semantics, not bounded work (`test/r2-segmented.test.js:23-83,205-276`).
- **Payoff (inference):** Full-prefix work can limit long runs; immutable-prefix reuse could bound it. Benefit is unclaimed until measured.
- **Smallest coherent first slice:** Reader-first `segmented/v2`: journal-free state, authenticated sealed prefix/checkpoint, and active-suffix plus changed state/head publication; reconstruct full history for replay/compatibility. Preserve v1/legacy, CAS, semantics, rollback.
- **Ordering/dependencies:** Independent of #2; after long-run demand. Land compatibility/fault reader before opt-in writer; memory memo is not authority.
- **Risks:** Digest/range or sealed-segment errors, state/journal drift, lazy-history leakage, seal crash, rollback/GC mistakes.
- **Decisive proof:** Frozen short/long >=30 pairs prove bounded-prefix work and report operations/bytes/fsyncs/wall; replay, tamper, migration/rollback, CAS, and R2 faults stay equivalent.

## 4. Resumable outer release-operation envelope
- **Evidence (fact):** Exclusion owns claims for one callback (`src/release-operation.ts:39-94`); deploy composes snapshot wait, exclusion, target lock, quiescence, and operation in one invocation (`tools/deploy-skill.mjs:1493-1562`). Inner tree recovery is already durable (`tools/deploy-skill.mjs:830-915,1007-1084`; `test/r11d7-exact-legacy-deploy.test.js:135-145`); outer phase/identity is not.
- **Payoff (inference):** Resume after timeout/crash/handoff from exact identities: a reliability/audit gain, not speed.
- **Smallest coherent first slice:** `lunacy-release-operation/v2` binds operation, manifest/target/owner/snapshot digests, and outer phase; status is read-only, resume revalidates current authorities then delegates to the transaction. Parent approval/snapshot stay explicit.
- **Ordering/dependencies:** Fourth; reuse release admission, quiescence, marker, R4 receipts, rollback; remain subordinate.
- **Risks:** Second authority, stale owner/snapshot, replay, outer/inner disagreement, cross-fence rollback, evidence leakage.
- **Decisive proof:** Fault every phase; resume converges to exact prior/candidate aggregate, rejects stale/tampered bindings without mutation, preserves unowned files/no residue, and keeps CLI/legacy bytes.

## Important deferrals
- Delta projections await >=30 representative pairs (`src/bridge.ts:889-899,966-990`; `docs/ROADMAP.md:416`); accelerator ON awaits a hit-bearing privacy/recovery corpus (`docs/ROADMAP.md:417`). Neither has an authorized value claim.
- DAG/discovery/auto-approval adds authority beyond #2. Admission/reuse extraction and telemetry are supporting refactors (`docs/ROADMAP.md:418`).

## Control Block
- **Status:** PASS — exactly four directions ranked.
- **Changed:** Report only; no product/source/test/docs changes.
- **Evidence:** HEAD, S1–S4, and cited source/tests/docs.
- **Verification:** Format/size/status PASS; no product tests for read-only discovery.
- **Claims:** Facts/inferences labeled; no performance/token/provider claim.
- **Decision/blocker:** None; payoffs require decisive proof.
