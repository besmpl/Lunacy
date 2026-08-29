# S3 Worker Report — performance/context/cache scout

## Control
- **Status:** PASS (read-only discovery complete).
- **Goal/result:** Rank at most three measurable runtime, I/O, replay, scheduling, or acceleration directions with exact evidence and proof gates.
- **Changed:** This report only; no product, source, tests, docs, or benchmark fixtures changed.
- **Self-review:** Rechecked authority boundaries, cold fallbacks, durability/replay requirements, and benchmark caveats; no token/provider/native/speedup claim is made.
- **Decision needed:** NO. **Blockers:** none.

## Ranked directions

### 1. Incremental durable history for long-lived runs (journal/state write amplification)
- **Bottleneck (fact):** src/reducer.ts:108-116 canonicalizes the complete existing journal on every append. src/public.ts:462-467 repeats a full-prefix byte calculation before each event. File commits rebuild and write complete state.json and journal.ndjson, fsync both, and replace CURRENT (src/store.ts:1702-1743); verification rereads/parses/hashes both files (src/store.ts:1384-1432).
- **Observed:** Local FileArtifactStore probe (one-step plan, START + HOST observations) measured 5.49 s at 20 events and 23.58 s at 100; final 143,844-byte state + 47,911-byte journal at 100. The current smoke fixture is only two events/9,048 committed bytes (npm run benchmark, harness bench/run.mjs:34-68), so it does not exercise this growth path. This is an I/O/canonicalization observation, not a speedup claim.
- **Smallest coherent outcome:** Add an append-only journal segment/offset (or periodic immutable snapshot plus bounded suffix) while preserving CURRENT digests/CAS, replay order, and old-format read compatibility. Keep the existing journal ceiling and direct reducer authoritative.
- **Risks/recovery:** Crash ordering/fsync, digest continuity, writer-fence/CAS races, quarantine/retention, migration/rollback, and immutable-history semantics; compaction must not silently rewrite history.
- **Authorization proof:** 30+ paired repetitions across event counts and state sizes (including near 10,000/1 MiB limits), recording read/write bytes, fsyncs, wallNs; crash/restart/replay equivalence, old-format compatibility, and JournalCeiling behavior. docs/DURABILITY.md:39-46 explicitly requires a separately designed segment/compaction schema.

### 2. De-duplicate and bound bridge projection I/O
- **Bottleneck (fact):** src/bridge.ts:889-904 puts the complete step list in each generated payload. project reads both markdown files and merges/writes both (src/bridge.ts:966-995); changed files are fully rewritten through atomic writeRegular (src/bridge.ts:948-964).
- **Observed:** node bench/bridge-paired.mjs (3 reps) preserved parity but measured markdown 436 bytes versus runtime projection 9,625 bytes (byteReduction -21.0757), with runtime 8 reads/6 writes/3 wakeups versus markdown 9/6/3. A local 3-transition scaling probe grew projection bytes from 3,939 (2 steps) to 198,171 (500 steps), still six writes. The benchmark is explicitly NOT_CLAIMED (bench/bridge-paired.mjs:40-47).
- **Smallest coherent outcome:** Keep machine-owned markers and atomic/fsync publication, but emit one canonical step payload (summary in STATE, detail in STEPS) and skip no-op rewrites; preserve CLAIMED launch-window deferral.
- **Risks/recovery:** Markdown compatibility/marker validation, unmanaged text preservation, launch inode/supervisor authority fence, and partial projection failure after a committed kernel event.
- **Authorization proof:** Expand the paired corpus to realistic step counts and long transitions (>=30 paired reps); measure projection read/write bytes, fsyncs, and wallNs, then require byte-for-byte semantic parity and crash/recovery/CLAIMED deferral traces.

### 3. Cost-aware accelerator admission with an authorized ON canary
- **Bottleneck (fact):** Graph preparation verifies/recomputes frontier and scans state/outbox each call (src/graph.ts:121-156). Context preparation digests every plan step and builds a stable source set (src/public.ts:340-369; src/compiler.ts:69-145). Reducer still hashes and directly reselects admission before accepting candidates (src/reducer.ts:211-234), so a proposal cannot bypass authoritative work.
- **Observed:** Frozen npm run benchmark compares only OFF/SHADOW (2 events): OFF 197,423,625 ns vs SHADOW 152,639,000 ns, semanticParity true; harness/documentation forbids a speed claim (bench/run.mjs:3-5,59-79; docs/BENCHMARK.md:12-20). A local 500-step/20-event MemoryStore probe had OFF 125 ms, SHADOW 312 ms, ON 354 ms, with 20 graph prepares, 20 context prepares/misses, and 20 reuse bypasses in SHADOW/ON—no eligible immutable cell/snapshot hits. This is setup-overhead evidence only.
- **Smallest coherent outcome:** Add cost-aware eligibility (hit history/estimated bytes) and an authorized ON-canary harness; enable reuse only where immutable proof and measured hit amortization exist, retaining OFF fallback.
- **Risks/recovery:** Cache staleness/privacy, replay/deletion parity, forged proposal fallback, in-process metrics loss on restart, and mode/rollback complexity. docs/ACCELERATION.md:21-47 and docs/MIGRATION.md:7-17 keep reducer/CURRENT authoritative and require paired proof.
- **Authorization proof:** Frozen realistic immutable-cell/snapshot corpus with >=30 paired OFF-vs-ON reps; record hit/miss, candidate/context bytes, p50/p95 wallNs, and semantic/deletion/recovery/privacy parity. No provider/token/native inference.

## Checks
- npm run benchmark: PASS; semanticParity true, capabilities provider/token/native false.
- node bench/bridge-paired.mjs: parity true; result NOT_CLAIMED.
- npm run benchmark:workfront: local gate PASS (40 checkpoints; cold p95 16.294 ms, warm p95 13.350 ms), so read-only inspector is not a current bottleneck.

