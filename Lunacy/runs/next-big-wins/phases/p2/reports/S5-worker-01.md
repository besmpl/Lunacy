# S5 Worker Report — ranked next major directions

## Control
- **Status:** PASS.
- **Decision:** Advance the four directions below, in rank order. They are mutually distinct: operator lifecycle, durable history, dispatch architecture, and recovery diagnosis.
- **Inputs:** The four immutable P1 reports (`S1-worker-01.md` through `S4-worker-01.md`). Repository citations below are the exact evidence recorded and checked by those scouts.
- **Scope:** Discovery only. This report is the only file created; no product, source, tests, or documentation changed.
- **Claim discipline:** Timings and byte counts are observations from the cited scout report, not projected improvements. No provider, token, native, or speedup claim is made.

## Ranking rationale
The first direction closes the largest gap between today's sound event kernel and a working low-touch single-run product. The second removes the only explicit healthy-run scale ceiling while creating a measurable I/O target. The third localizes the most change-prone lifecycle effects before broader automation. The fourth makes fail-closed recovery actionable without weakening it. A multi-run scheduler, automatic decision policy, or release wrapper should follow these foundations rather than compete with them now.

## 1. Ship an idempotent per-run lifecycle controller (`init` + `run`/`resume`)

### Current bottleneck and exact evidence
- Run creation and binding are caller work: the workspace has no registry, scheduler, lock database, or `CURRENT_RUN` (`WORKSPACE.md:8-31`), while `SKILL.md:116-127` requires the caller to choose run IDs, create plan/STATE/STEPS material, and choose runtime versus Markdown mode.
- The one-event CLI requires the operator to supply run directory, run ID, event/event ID, and plan (`src/bridge-cli.ts:145-176`).
- Admission is already deterministic in the kernel (`src/reducer.ts:211-240`), and `BridgeDrivePump` already chains authorized transitions but is deliberately ephemeral and has no scheduler state (`src/orchestration.ts:103-107,175-215,438-459`). The missing layer is lifecycle composition, not a second source of authority.

### User/product payoff
One explicit command can create or safely resume a run, perform the mechanical pump loop, and return a compact terminal or attention result. This removes repeated setup and invocation work while keeping approvals, gates, plan adoption, and irrecoverable UNKNOWN cases parent-visible. It is the shortest path from a set of correct primitives to a usable low-touch orchestration product.

### Smallest coherent first implementation slice
Add one additive controller command accepting an explicit run root, run ID, plan, and driver policy. It should:
1. scaffold only the required run metadata;
2. call the existing canonical START transition idempotently;
3. invoke the existing pump until it reaches completion or an existing parent boundary; and
4. return a bounded status/attention result.

It must not parse Markdown for authority, synthesize plans, auto-adopt drift, decide GATE/PASS/FINDINGS, bypass `HumanReceiptRequired`, discover ambient runs, or replace the one-event/manual CLI.

### Dependencies and order
- **First roadmap slice.** It uses existing bridge locks, CURRENT/revision/epoch fences, transition validation, and pump semantics; no architecture extraction is required to prove it.
- Freeze its small command/result contract before considering the multi-run scheduler or decision inbox.
- Keep the implementation compatible with direction 3 so dispatch internals can later move without changing this controller's boundary.

### Main risks
Duplicate START, mismatched plan/root identity, projection failure after a committed event, invalid or absent driver policy, restart UNKNOWN, and accidental continuation across a parent boundary. A convenience command could become a second authority if it writes around the bridge/kernel instead of composing them.

### Decisive acceptance proof
An end-to-end fixture must prove: init through a dependent two-step drive; duplicate START produces replay rather than duplicate work; restart at UNKNOWN performs the existing one bounded observe and never relaunches blindly; invalid plan/no driver fails closed; phase-ready, GATE, adoption, and human-receipt conditions stop at the parent boundary; and the legacy one-event/manual path remains behaviorally unchanged. Use the existing orchestration coverage (`test/orchestration.test.js:18-35,151-170`) as the stable surface.

## 2. Introduce versioned journal segments and checkpoints for long-lived runs

### Current bottleneck and exact evidence
- The journal has a hard ceiling of 10,000 records or 1 MiB and returns `BLOCKED/JournalCeiling`; there is no truncation, rewrite, or compaction protocol (`docs/DURABILITY.md:39-46`; `src/limits.ts:1-7`; preflight at `src/public.ts:462-466`). Thus a healthy run can consume its history budget and lose the room needed for later recovery events.
- Every append canonicalizes the existing full journal (`src/reducer.ts:108-116`), and `KernelImpl` separately computes full-prefix bytes before each event (`src/public.ts:462-467`).
- Each file-store commit rebuilds and writes complete `state.json` and `journal.ndjson`, fsyncs both, replaces CURRENT (`src/store.ts:1702-1743`), then verification rereads/parses/hashes them (`src/store.ts:1384-1432`).
- The performance scout observed a one-step local FileArtifactStore probe at 5.49 s/20 events and 23.58 s/100 events, with 143,844 state bytes plus 47,911 journal bytes at 100. Those are probe observations only; the frozen two-event benchmark does not exercise long-history growth.

### User/product payoff
Runs can continue beyond the current fixed history ceiling without sacrificing immutable audit/replay semantics. The design also creates a concrete, measurable opportunity to bound repeated history read/write work, which matters directly once the lifecycle controller makes longer unattended runs practical.

### Smallest coherent first implementation slice
Behind `ArtifactStore`, add a private, versioned format consisting of sealed immutable journal segments plus one atomically published head/checkpoint and a bounded active suffix. Continue reading existing unsegmented generations. Make compaction an explicit operation; never silently prune committed history. Keep CURRENT digests/CAS, the direct reducer, and the present journal ceiling for legacy format until the new proof gate passes.

### Dependencies and order
- Design immediately after the controller slice, but keep it storage-owned and independent of directions 3 and 4.
- Specify the segment/head crash protocol and old-format rollback before enabling writes.
- Land reader compatibility and fault tests before the new writer; enable any compaction/GC only after publication and recovery proof.

### Main risks
Digest continuity, event ordering, crash windows around segment seal/head publication, writer-fence and generation-CAS races, partial migration, quarantine/retention, Memory/File divergence, and deleting a segment before a durable checkpoint proves it unreachable.

### Decisive acceptance proof
Run more than 10,000 synthetic transitions against an unsegmented semantic oracle and require identical event order, replay result, and committed yields. Fault-inject segment seal, checkpoint/head swap, restart, and segment-GC windows; every restart must expose either the complete old or complete new history. Old fixtures must still load and rollback. For performance authorization, run at least 30 paired repetitions across event counts and state sizes (including near the current 10,000/1 MiB limits), recording bytes read/written, fsync counts, and wall-clock distributions. Accept only demonstrated bounded-history behavior and parity; infer no speedup in advance.

## 3. Extract a private dispatch lifecycle coordinator from `KernelImpl`

### Current bottleneck and exact evidence
- `KernelImpl` currently spans `src/public.ts:313-1051` and owns boundary validation/replay, reducer/store commits, active-dispatch state, timeout/cancellation, launch/observe, receipt settlement, and `onYield` callbacks.
- `advance` (`src/public.ts:400-597`) and `resumeDispatch` (`src/public.ts:599-732`) mix policy with effects, while `launchDispatch` (`src/public.ts:861-985`) and `launchObserve` (`src/public.ts:987-1026`) implement asynchronous races.
- The public API is intentionally a single `RunKernel.advance` operation (`docs/API.md`), so this concentration is private implementation complexity rather than useful public surface.

### User/product payoff
Lifecycle automation and recovery work can evolve against one narrow, testable owner of in-flight effects instead of repeatedly changing a large mutable kernel object. This is architectural simplification with a concrete purpose: lower the chance that a low-touch feature changes claim-before-launch, timeout, late-receipt, replay, or writer-fence behavior.

### Smallest coherent first implementation slice
Create a private `DispatchCoordinator` that owns `activeDispatches`, dispatcher options, launch/observe races, settlement, and callback wiring. Leave `KernelImpl.advance` as the validation/reducer/commit facade. Preserve package exports and event/state encodings exactly; do not combine this with a public API redesign, store refactor, or new scheduling policy.

### Dependencies and order
- Land after the lifecycle controller's external contract is known, so the extraction optimizes a real ownership seam rather than speculating.
- Complete before adding a multi-run scheduler, automatic decision policy, or richer recovery mutation.
- Direction 4 may initially read today's structures, but its evidence adapter should target the coordinator seam once this extraction lands.

### Main risks
Changing claim-before-launch order, confusing synchronous receipts with Promises, widening cancellation/deadline windows, accepting a late or stale receipt, violating lease/generation fences, relaunching UNKNOWN work, or changing exact committed-yield bytes in Memory versus File stores.

### Decisive acceptance proof
Run differential lifecycle traces before and after extraction across `test/kernel-repair.test.js`, `test/orchestration.test.js`, `test/codex-exec-driver.test.js`, `test/codex-exec-supervisor.test.js`, and `test/massive-win-identity-variants-cycle-launch-fence.test.js`. The corpus must include synchronous/asynchronous receipt, timeout/cancel, restart UNKNOWN/observe, stale lease, launch failure, late receipt, and duplicate RESUME. Require exact transition/yield/store parity and a full `npm test` pass; code motion alone is not acceptance.

## 4. Add a token-scoped, read-only recovery/effect forensics capsule

### Current bottleneck and exact evidence
- Restart safely converts orphaned `CLAIMED` work to `UNKNOWN` and never blindly relaunches (`src/public.ts:616-662`; `docs/DURABILITY.md:63-83`). The pump performs one bounded `observe()` and then stops at the parent boundary (`src/orchestration.ts:193-201`).
- Launch/terminal evidence is immutable and bound to token/digest (`src/codex-effect-records.ts:10-20,81-113`), but the operator must reconstruct the incident from separate artifacts.
- Workfront exposes `UNKNOWN_DISPATCH` but intentionally omits receipts, paths, and journal details (`docs/WORKFRONT.md:18-22`), and the CLI has only event, `drive`, and `workfront` routes (`src/bridge-cli.ts:19-28,145-150`). Safe failure is therefore visible but not yet self-explaining.

### User/product payoff
A single bounded diagnostic tells the operator which exact token is unknown, what verified launch/terminal evidence exists, whether digests and leases bind, and which proof is required next. This reduces recovery guesswork while preserving the critical rule that diagnosis cannot dispatch, repair, ACK, or mint authority.

### Smallest coherent first implementation slice
Add a private read-only `inspect-recovery` route that emits canonical `lunacy-recovery/v1` for one explicit run/token: verified generation and remaining journal budget, outbox state/lease, per-token effect-record presence and digest binding, UNKNOWN cause, and lock/fence status. It may suggest `observe` or a human receipt as the next proof, but performs neither action. Keep output bounded, deterministic, and non-sensitive.

### Dependencies and order
- Specify the capsule schema now, implement after direction 3 so dispatch/evidence ownership is stable.
- Reuse generation, journal, effect-record, and Workfront readers; do not create a second recovery database.
- Treat this as the prerequisite for any future resumable recovery UI or decision inbox that presents effect evidence.

### Main risks
Leaking paths or sensitive payloads, inspecting the wrong token/lease/generation, presenting unverified evidence as authoritative, reads that accidentally repair/quarantine/mutate, unstable error text, or suggestions being mistaken for completed recovery.

### Decisive acceptance proof
Inject spawn-after-intent, launch-publication failure, malformed terminal evidence, timeout/UNKNOWN, stale lease, and late receipt. After restart, compare capsule fields to the immutable effect records and current generation. Hash the complete state/effect namespace before and after repeated inspection; it must remain identical, no dispatch or second observe may occur, and wrong-token/digest inputs must fail closed with bounded stable output.

## Attractive candidates rejected or deferred

- **Multi-run scheduler/queue — defer until direction 1 proves one-run lifecycle semantics.** It is a compelling next product layer, and Workfront already supplies bounded per-run state (`docs/WORKFRONT.md:1-6,18-32`). Today it would add global ordering, starvation, duplicate-pump, stale-root, and cursor-recovery problems before the single-run controller contract is proven. The correct trigger is stable controller status/attention semantics plus demonstrated demand for concurrent roots.
- **Digest-bound decision inbox/automatic approval policy — defer.** Canonical GATE/adoption tokens exist (`src/reducer.ts:244-306`; `src/public.ts:504-531`), so the surface is attractive. But unattended decision policy changes authority, unlike mechanical lifecycle automation. First ship explicit controller stops and recovery evidence; then add a manual inbox. Any allow-list needs a separate product decision and proof.
- **Resumable release-operation envelope — defer behind in-run recovery.** Existing release primitives are robust but operator-composed (`docs/INSTALL.md:119-192`; `src/release-operation.ts:39-54,66-94`). A wrapper would reduce deployment command choreography, yet it does less to produce a working orchestration loop than directions 1 and 4. Reconsider once the runtime controller and diagnostics have stable receipt conventions that the release flow can reuse.
- **Bridge projection de-duplication/no-op writes — defer pending representative proof.** Complete step payloads and rewrites are exact current costs (`src/bridge.ts:889-904,948-995`), and the scout observed runtime projection bytes grow from 3,939 at 2 steps to 198,171 at 500 steps over three transitions. However, the current paired benchmark is explicitly `NOT_CLAIMED` and showed no authorized improvement. Build the >=30-repetition realistic corpus first; do not prioritize an optimization from three local repetitions.
- **Cost-aware accelerator admission / ON canary — defer for lack of eligible-hit evidence.** The local 500-step/20-event probe observed 20 graph/context preparations and 20 reuse bypasses with no eligible immutable cell/snapshot hits; the frozen benchmark covers OFF/SHADOW only and forbids a speed claim (`bench/run.mjs:3-5,59-79`; `docs/BENCHMARK.md:12-20`). The next action is a frozen hit-bearing corpus, not production mode complexity.
- **Pure admission planner and reuse-store extraction — defer as narrower simplifications.** Duplicated admission rules (`src/validator.ts:12-19,58-77`; `src/graph.ts:94-108`; `src/reducer.ts:65-99,211-234`) and mixed authoritative/cache storage (`src/store.ts:90-100,727-2115`) are real. They do not currently block the first controller slice, remove the journal ceiling, or make UNKNOWN recovery actionable. Revisit the planner before changing admission policy and the reuse sidecar before accelerating cache evolution.

## Self-review: simplicity and feasibility
- **Exactly four and distinct:** one user-facing controller, one durable storage protocol, one private effect-ownership refactor, and one read-only diagnostic. None is a disguised duplicate of another.
- **Smallest seams:** Each first slice composes existing transition/pump/store/effect-record boundaries. No new registry, global scheduler, ambient discovery, parallel authority, public kernel redesign, or automatic approval is included.
- **Feasible order:** Direction 1 proves the product boundary; direction 2 independently removes the scale ceiling; direction 3 stabilizes effect ownership; direction 4 then exposes verified evidence. Later scheduler, inbox, and release work can reuse those results.
- **Proof before claims:** Every direction has a decisive parity/fault/measurement gate. Observed timings and bytes motivate investigation only; adoption depends on the specified evidence.
- **Remaining uncertainty:** The reports establish structural bottlenecks, not quantified user toil or future gains. That uncertainty is handled by narrow first slices and acceptance proofs rather than forecast numbers.

## Final
**PASS — exactly four roadmap directions selected; no decision or blocker remains.**
