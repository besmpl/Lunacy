# S3 — measured performance/context/cache/scale frontier

## Baseline and claim discipline
- **Fact:** P5 is READY; lifecycle, fleet/inbox/promotion, segmented v1/v2, dispatch, forensics, and release-envelope work is already in the candidate (`Lunacy/runs/next-big-wins-v3/PLAN.md:7-17`). Those are excluded.
- **Evidence boundary:** `npm run benchmark` is a two-event local fixture (SHADOW `graphPrepare=1`, `contextPrepare=2`, `contextMiss=2`, `valueDecision` absent); `bench/README.md:12-17` forbids provider/token/speed claims. `segmented-v2-paired.mjs` ran 30 repetitions, but reports `valueDecision:UNCLAIMED` (`bench/README.md:34-43`, `/tmp/s3-v3-segmented.json`).

## Ranked directions
### 1. Lazy, indexed authenticated history/replay (extension beyond segmented/v2)
- **Fact/bottleneck:** The v2 reader parses every descriptor line, rebuilds the entire journal, validates/re-digests state+journal, and recomputes the checkpoint digest on every load (`src/store.ts:1588-1627`). Each v2 commit first fully reads the predecessor, compares every old journal entry, and re-reads/re-digests each hard-linked segment (`src/store.ts:1991-2037`; tests `test/p3-segmented-v2.test.js:23-38,75-95`). The finite legacy ceiling remains 10,000 events/1 MiB (`src/limits.ts:6-14`; `docs/DURABILITY.md:39-55`).
- **Measured fact / inference:** On the paired 30-repetition corpus (96 and ~2,049 events), v2 long `.kernel` bytes median 2,058,346 vs legacy 4,097,996; wall medians 959.17 vs 1,043.07 ms (p95 delta 380.71 ms), yet the harness deliberately leaves value **UNCLAIMED**. This exposes residual full-history work, not speedup.
- **Smallest release:** private authenticated segment index/summary with cumulative digest checkpoints and bounded lazy range verification; retain an explicit full-replay/recovery path, v1/legacy reader, and existing CURRENT/CAS/fault fences. Not another segmented writer.
- **Order, risks, proof:** Freeze digest/index format, then reader fallback, then writer use; no reducer/effect authority change. Guard against gaps, rollback, stale summaries, and tamper by fail-closed range proofs. Decisive proof: >=30 runs at 2k/10k events measuring segments read, bytes, fsyncs, wall distributions plus crash/tamper/recovery and byte-exact replay parity.

### 2. Large-plan projection index and bounded delta/page publication
- **Fact/bottleneck:** Every projection builds a sorted record for **all** steps (`src/bridge.ts:889-900`), reads and validates both STATE.md and STEPS.md, renders the same full payload twice, then rewrites each file when changed (`src/bridge.ts:966-990`; no-op/race coverage `test/bridge.test.js:67-82,156-182`).
- **Measured fact / inference:** The checked bridge pair is only a 2-step/3-repetition fixture and `NOT_CLAIMED` (`/tmp/s3-v3-bridge.json`). An exploratory local probe (`/tmp/s3-bridge-scale.mjs`, 5 transitions, no provider) with 1,000 steps counted 1,064,584 projection bytes read and 665,365 written across 10 writes; diagnostic O(steps × transitions), not acceptance/latency.
- **Smallest release:** versioned compact summary plus immutable step metadata/index and authenticated bounded deltas/pages; preserve machine markers, unmanaged text, no-op identity, atomic writes, and CLAIMED STEPS deferral. Reader fallback precedes writer; kernel remains authority.
- **Order, risks, proof:** Establish schema/retention and mixed-version fallback first. Prevent omitted/stale steps, marker loss, and user-text clobbering with whole-payload parity and fail-closed fences. Gate on >=30 representative 100/500/1k/10k-step plans, recording bytes/reads/writes and exact projection parity under tamper/crash.

### 3. Incremental context/graph freshness and proof preparation (SHADOW-first)
- **Fact/bottleneck:** Each enabled call re-digests the plan/state and maps every plan step into sources (`src/public.ts:345-374`); graph preparation verifies the graph, scans frontier/overlay, and digests the full journal (`src/graph.ts:121-156`; context/graph parity `test/p3-acceleration.test.js:15-44`), with another journal digest at commit (`src/public.ts:757-767`).
- **Measured fact / inference:** A diagnostic `MemoryArtifactStore` probe (`/tmp/s3-accel-scale.mjs`) with one-step plan showed OFF 484.7 ms/100 events and 9,063.1 ms/500; SHADOW 672.6 and 13,331.6 ms, with 100/500 graph+context prepares and zero hits. Repeated proof work only; no ON/speed claim.
- **Smallest release:** immutable per-plan source/frontier index plus append-only journal-digest accumulator and generation/epoch invalidation; verify changed slices and retain full recomputation fallback. Keep SHADOW compare-only/OFF default until admission proof.
- **Order, risks, proof:** Share freshness fields with #1 only after its index contract. Stale proofs must become cold misses, never authority; bind generation, epochs, writer fence, and complete-frontier digest. Require >=30 plans/events at 100/500/1k/10k with counter/wall/byte parity, corruption/tamper, cancellation, and restart tests before ON.

## Explicit rejects / trigger conditions
- Monolithic persistent reuse index reads/validates the whole JSON and rewrites it for one row (`src/store.ts:2538-2557,2778-2805,2840-2869`); no current benchmark has >1 cache entry, so sharding is not ranked until a 100/1k/10k-entry fault/restart corpus proves a ceiling.
- Fleet cross-run admission serially loads every conflicting peer root (`src/fleet-coordinator.ts:427-440`; manifest max 256), but no fleet stress evidence exists; defer indexed admission until measured. Reject Workfront/dispatch micro-tuning: Workfront’s 40-checkpoint gate passes (cold p95 14.4 ms, warm p95 19.8 ms) and no major bottleneck is demonstrated (`/tmp/s3-v3-workfront.log`).

## Control Block
- **Status:** FINAL — discovery only; no product edits.
- **Changed:** this report only.
- **Checks:** source/docs/tests inspected; `npm run benchmark`, `npm run benchmark:workfront`, and paired segmented/bridge probes completed; no product tests changed or needed.
- **Decision:** parent/Sol must select/merge; measurements are local diagnostics and make no provider/token/performance claim.
