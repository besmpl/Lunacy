# S3 Worker Report — scale/performance/context/cache scout

## Control
- Status: PASS (discovery only; no product/source/test changes).
- Scope: post-R1–R4 opportunities in durable I/O, projection scale, and accelerator overhead.
- Evidence: current source/docs; npm run benchmark, npm run benchmark:workfront, and node bench/bridge-paired.mjs all exit 0.

## Ranked directions

### 1. Bounded-write and incremental verification for segmented history (post-R2)
- **Fact:** R2's segmented/v1 layout exists, but FileArtifactStore.commitSegmented still loops over every journal entry, serializes/hashes every chunk, computes a prefix checkpoint digest, and writes full state.json/head each commit (src/store.ts:1926-1959). The reader parses every descriptor, rebuilds complete journal text, and revalidates full state/journal digests (src/store.ts:1539-1573). Legacy preflight also maps the entire journal (src/public.ts:467-472; src/reducer.ts:120-126).
- **Inference / materiality:** Segmentation bounds file size, but append/load work remains proportional to the full history prefix. This is a durability/read-amplification ceiling for long runs, not a cosmetic optimization.
- **Smallest coherent slice:** Extend the existing protocol with immutable-prefix descriptors and an append-only active suffix: reuse verified prefix metadata, accumulate checkpoint/journal digests without reparsing unchanged ranges, and write only changed state/head/active material. Keep replay, CURRENT CAS, crash fencing, legacy loading, and explicit compaction unchanged.
- **Dependencies / risks:** R2 schema compatibility, migration/rollback, and existing fault matrix. Digest/range/order/crash mistakes must fail closed and preserve exact stateDigest/journalDigest.
- **Decisive proof:** Fixed paired corpus (at least 30 repetitions; short and long histories) measuring bytes, fsyncs, and wall distributions before/after, plus restart/tamper/fault parity and logical replay oracle. No gain target is assumed.

### 2. Bounded/delta bridge projections for large plans
- **Fact:** projectionPayload embeds every step and dependency on every transition (src/bridge.ts:889-899). project reads both full Markdown files, validates sections, renders the same payload twice, then does confirmation reads or atomic writes (src/bridge.ts:948-979). Current paired benchmark is a synthetic three-transition case and is NOT_CLAIMED; docs/ROADMAP.md:416 requires a realistic corpus (at least 30 repetitions).
- **Inference / materiality:** With hundreds/thousands of steps, repeated two-file materialization can dominate local I/O and context surface even when only status/counts changed, limiting usable plan size.
- **Smallest coherent slice:** Keep markers/ownership while splitting compact run summary from a bounded step-status/dependency index (or immutable step details plus a small delta). Retain no-op linearization, unmanaged-text preservation, atomic publication, and CLAIMED STEPS deferral.
- **Dependencies / risks:** Representative corpus and projection compatibility/version decision. Guard against stale/partial STATE/STEPS views, user edits, and larger recovery surface; output remains deterministic/crash-safe.
- **Decisive proof:** At least 30 repetitions on representative large plans, reporting per-file reads/writes/fsyncs, bytes, and wall distributions; verify projection parity, markers, concurrent CLAIMED behavior, restart, and fault injection. Current synthetic data is behavior evidence only.

### 3. Hit-bearing, cost-aware accelerator admission and ON canary
- **Fact:** Non-OFF context preparation hashes every plan step for source descriptors (src/public.ts:#prepareContext, around lines 340-378). GraphAcceleration.prepare validates/digests the plan, scans frontier/claims, and computes journal/state freshness digests (src/graph.ts:121-156). ContextCompiler.prepare validates/freeze-sources and reuses immutable BASE only (src/compiler.ts:69-145). Frozen npm run benchmark (two events) observed SHADOW contextPrepare=2, contextMiss=2, reuseBypass=2, graphPrepare=1, graphCandidates=1, no hit; docs defer ON until a hit-bearing corpus proves policy safety (docs/ROADMAP.md:417).
- **Inference / materiality:** On the shipped fixture accelerator work is diagnostic/bypass-heavy. A deterministic admission/canary seam could avoid repeated preparation when no reusable BASE exists and make reuse explicit where immutable hits are real. No latency/token/provider claim is made.
- **Smallest coherent slice:** Add pure eligibility/cost decision from existing proofs, memoize immutable plan/source facts, and run bounded ON with hit/miss telemetry and OFF fallback. Keep VIEW/state-derived material cold and retain privacy/authority fences.
- **Dependencies / risks:** Corpus with repeated immutable BASEs plus mutable VIEWs, reuse publication, and ON policy decision. False hits, stale epochs, privacy leakage, poisoning, or semantic drift must degrade to cold execution.
- **Decisive proof:** At least 30 paired OFF/SHADOW/ON runs with hit/miss cells; compare exact bytes/semantics, counters, read/write cost and wall distributions, then restart/deletion/sensitivity/fault cases.

## Explicit rejects / defer
- **Workfront micro-optimization:** npm run benchmark:workfront passed local gate (40 checkpoints; cold p95 16.440833 ms, warm p95 13.176625 ms; NOT_CLAIMED); no demonstrated major bottleneck.
- **Pure admission-planner/reuse-store extraction:** docs/ROADMAP.md:418 labels these preparatory refactors, not standalone scale wins.
- **Generic multi-run scheduler/queue or release wrappers:** deferred to lifecycle/authority decisions (docs/ROADMAP.md:413-415), outside this lane and not re-proposed.

## Control Block
- Status: PASS
- Changed: only Lunacy/runs/next-big-wins-v2/phases/p1/reports/S3-worker-01.md
- Checks: npm run benchmark (0); npm run benchmark:workfront (0); node bench/bridge-paired.mjs (0)
- Decision needed: parent rank/merge among three directions; no blocker.
- Remaining risk: quantitative gains remain unclaimed until stated paired corpora and fault/recovery proofs run.
