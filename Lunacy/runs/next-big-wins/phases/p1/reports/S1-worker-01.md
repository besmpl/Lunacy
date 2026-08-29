# S1 Worker Report — architecture/deep-module scout

## Control
- **Status:** PASS (read-only discovery complete).
- **Goal/result:** Rank at most three major architecture/API directions with exact evidence and proof gates.
- **Changed:** This report only; no product, test, docs, or generated-source edits.
- **Verification:** `npm run typecheck` PASS; `npm test` PASS (build plus full Node test run, no failures).
- **Self-review:** Rechecked callers, optional/private seams, compatibility risks, and simplicity; recommendations remain distinct.
- **Decision needed:** NO. **Blockers:** none.

## Ranked directions

### 1. Extract dispatch lifecycle from `KernelImpl` into a private coordinator
- **Bottleneck (fact):** `src/public.ts:313-1051` puts boundary validation/replay, reducer/store commits, active-dispatch ownership, timeout/cancellation, launch/observe, receipt settlement, and `onYield` callbacks in one class. `advance` (`:400-597`) and `resumeDispatch` (`:599-732`) are policy plus effects; `launchDispatch` (`:861-985`) and `launchObserve` (`:987-1026`) own asynchronous races.
- **Why it matters:** The public contract is intentionally one `RunKernel.advance` operation (`docs/API.md`), yet every new effect/recovery rule must cross this large mutable object; lifecycle changes can accidentally alter exact replay, writer-fence, or late-receipt behavior.
- **Smallest coherent seam:** Private `DispatchCoordinator` owning `activeDispatches`, dispatcher options, launch/observe/settlement and callback wiring; leave `KernelImpl.advance` as the validator/reducer/commit façade and keep package exports unchanged.
- **Risks/recovery:** Preserve claim-before-launch ordering, lease/generation fences, synchronous receipt vs Promise classification, cancellation/deadline windows, UNKNOWN recovery, and exact committed-yield bytes for Memory and File stores.
- **Decisive proof:** Differential traces from `test/kernel-repair.test.js`, `test/orchestration.test.js`, `test/codex-exec-driver.test.js`, `test/codex-exec-supervisor.test.js`, and `test/massive-win-identity-variants-cycle-launch-fence.test.js` (1450 lines), covering sync/async receipt, timeout/cancel, restart UNKNOWN/observe, stale lease, duplicate RESUME; require `npm test` parity.

### 2. Split authoritative generation storage from optional reuse sidecar
- **Bottleneck (fact):** `src/store.ts` is 2117 lines. `ArtifactStore` exposes optional reuse hooks (`:90-100`), but `FileArtifactStore` (`:727-2115`) still combines CURRENT/generation CAS, writer locks, journal/state validation, trust/fsync/recovery, and reusable blob/index/pin/quarantine transactions (`:1755-2115`); Memory store interleaves the same policies (`:672-725`).
- **Why it matters:** Disposable acceleration data and authoritative state have different failure/retention semantics, but one module currently carries both; a cache-only change can threaten commit fences or recovery, while durability fixes require understanding cache paths.
- **Smallest coherent seam:** Private `ReuseStore` implementing existing optional hooks, passed a narrow trusted-filesystem/generation-fence capability; keep `ArtifactStore.load/commit` and the public kernel unchanged. Defer any broader state-codec extraction until this seam proves stable.
- **Risks/recovery:** Preserve stage-before-CURRENT and publish-after-CURRENT ordering, per-generation writer-fence checks, pin quarantine/GC, same-key conflict behavior, lock reclaim, and exact old-root compatibility; avoid leaking filesystem paths through the adapter.
- **Decisive proof:** `test/p5-generation-memo.test.js`, `test/storage-retention.test.js`, `test/r11e2-writer-lock-race.test.js`, `test/p3-repair.test.js`, `test/p3-committed-replay.test.js`, and `test/workfront.test.js`; inject interrupted stage/publish/cleanup and compare exact CURRENT, journal, yields, and cache trees before/after extraction.

### 3. Make admission selection one pure policy seam for direct and graph paths
- **Bottleneck (fact):** Claim overlap and maximal deterministic selection are repeated: `src/validator.ts:12-19,58-77` (`relationConflict`/`readySteps`), `src/graph.ts:94-108` (`frontier`/`selected`), and `src/reducer.ts:65-99` (`updateAdmission` rechecks aliases, path-prefix overlap, READ/WRITE rules and slots). `reduce` (`src/reducer.ts:211-234`) then compares graph candidates to a second direct selection.
- **Why it matters:** Graph mode is only an optional index (`docs/ACCELERATION.md`), but duplicated predicates/order make future claim, capacity, or alias changes a semantic-drift risk and force defensive rechecks in the hot transition path.
- **Smallest coherent seam:** Private pure `AdmissionPlanner` returning the ordered maximal step IDs from status, dependencies, claims, active claims, and capacity; validator/graph call it, while reducer only applies ACTIVE/outbox mutations and retains direct fallback.
- **Risks/recovery:** Preserve depth/phase/ID tie-breaks, dependency-terminal semantics, alias/path-prefix conflict rules, OFF/SHADOW/ON parity, and forged/stale graph fallback; do not let the planner become a second authority or alter journal bytes.
- **Decisive proof:** `test/p3-capacity-ownership.test.js`, `test/p3-admission-ownership.test.js`, `test/p3-acceleration.test.js`, `test/p6-previewreduce.test.js`, and `test/kernel.test.js`; run OFF/SHADOW/ON trace parity across conflicting claims, aliases, capacity limits, dependency cycles, and stale graph frames.
