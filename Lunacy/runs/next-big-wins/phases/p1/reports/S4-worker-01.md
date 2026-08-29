# S4 Worker Report — recovery/release/deployment/observability scout

## Control
- **Status:** PASS (read-only discovery complete).
- **Goal/result:** Rank at most three major directions with exact evidence and proof gates.
- **Changed:** This report only; no product/source/test/docs/generated-source edits.
- **Verification:** `npm test` PASS (full matrix: 416 tests, 414 pass, 0 fail, 2 skipped).
- **Self-review:** Traced restart/UNKNOWN, effect records, writer/release fences, quiescence, deploy/restore, and diagnostics; recommendations are distinct.
- **Decision needed:** NO. **Blockers:** none.

## Ranked directions

### 1. Journal segments/checkpoints for genuinely long-lived runs
- **Bottleneck (fact):** Journal is finite at 10,000 records or 1 MiB; crossing either returns `BLOCKED/JournalCeiling`, with no truncation, rewrite, or compaction (`docs/DURABILITY.md:39-46`; `src/limits.ts:1-7`). `KernelImpl` preflights this (`src/public.ts:462-466`) and reserves the claim→UNKNOWN recovery shape before launch (`src/public.ts:686-700`).
- **Why it matters (inference):** A healthy run can stop solely because history consumed its prefix; recovery safety itself needs more records. This is the clearest scale ceiling.
- **Smallest coherent outcome:** Private versioned segment/checkpoint protocol behind `ArtifactStore`: sealed immutable segments plus one atomically published head/checkpoint, while old unsegmented readers remain supported. Compaction is explicit, never silent pruning.
- **Invariants/risks:** Preserve event order/digests, replay and exact yields, CURRENT/generation and writer-fence CAS, crash-idempotent head publication, Memory/File parity, and rollback to pre-segment generations. Do not delete a segment before durable checkpoint/head proof.
- **Decisive proof:** Fault-inject seal, head swap, restart, and segment-GC windows; run >10,000 synthetic transitions against an unsegmented oracle; require old fixtures to load and interrupted compaction to leave either complete old or new history.

### 2. Token-scoped recovery/effect forensics capsule
- **Bottleneck (fact):** Restart converts orphaned `CLAIMED` to `UNKNOWN` and never blindly relaunches (`src/public.ts:616-662`; `docs/DURABILITY.md:63-83`). Pump gets one bounded `observe()`, then stops at parent boundary (`src/orchestration.ts:193-201`); absent observer/driver yields non-retryable `UnknownDispatch`/`HumanReceiptRequired`. Immutable launch/terminal evidence is token/digest-bound (`src/codex-effect-records.ts:10-20,81-113`), but Workfront exposes only `UNKNOWN_DISPATCH` and omits receipts, paths, and journal (`docs/WORKFRONT.md:18-22`); CLI has only event, `drive`, and `workfront` routes (`src/bridge-cli.ts:19-28,145-150`).
- **Why it matters (inference):** Safe recovery is correct but forensic work is fragmented across hidden files and terse blocks; incidents remain manual and cannot proceed without exact-token evidence.
- **Smallest coherent outcome:** Private read-only `inspect-recovery` route emitting bounded canonical `lunacy-recovery/v1`: verified generation/journal budget, outbox state/lease, per-token evidence presence and digest binding, UNKNOWN cause, and lock/fence status. Suggest next proof (observe or human receipt) but perform no repair/dispatch.
- **Invariants/risks:** Exact token + command-digest + lease scoping; no writes, successor token, or ACK minting; deterministic bounded output/stable non-sensitive errors. Keep Workfront omissions and one-shot semantics.
- **Decisive proof:** Inject spawn-after-intent, launch-publication failure, malformed terminal, timeout/UNKNOWN, and late receipt; restart and compare capsule to effect records. Hash state/effect namespace before/after; repeated inspection must not alter outcomes or trigger a second observe.

### 3. Resumable release-operation envelope (preserve external snapshot authority)
- **Bottleneck (fact):** Production deploy/check/restore requires canonical manifest, exact root set, owner-held exclusion, then a separately timed external process snapshot and binder command (`docs/INSTALL.md:119-148`). Deploy waits for the bound response before quiescence/mutation (`tools/deploy-skill.mjs:1522-1556`); restore is a separate attested 0.2.12 command and later 0.3.0 redeploy before ordinary `--check` (`docs/INSTALL.md:150-192`). Existing primitives are robust—ordered claims (`src/release-operation.ts:39-54,66-94`) and complete-tree recovery (`docs/BRIDGE.md:102-143`)—but operators compose several exact invocations.
- **Why it matters (inference):** Multi-step handoff creates timeout/order/manifest-path mistakes despite fail-closed primitives; diagnostics return only `QUIESCENT` counts or `NOT_QUIESCENT` plus an error (`src/release-quiescence.ts:43-46,362-398`; `tools/verify-release-quiescence.mjs:55-70`).
- **Smallest coherent outcome:** One private resumable release command validating manifest, acquiring existing exclusion, accepting/binding a fresh host process snapshot, running quiescence, invoking existing deploy/restore transaction, and emitting a canonical receipt with phase, owner, aggregate, and next safe retry. Snapshot remains host-supplied; no signal/kill or auto-discovery.
- **Invariants/risks:** Reuse lock order and complete-tree transaction; owner-bound freshness, exact inventories/aggregates, and release/run fences remain authoritative. Receipt publication crash-idempotent and outside payload; rollback preserves unowned files and rejects foreign residue. Additive private CLI; legacy commands unchanged.
- **Decisive proof:** Fault-inject binder timeout, owner replacement, every deploy phase, and restore crash windows; retry same receipt and require one exact tree/no residue. Keep a live managed process in supplied snapshot and require red quiescence without killing; verify no writes outside declared target/response paths.
