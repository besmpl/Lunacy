# S2 — architecture / product-platform frontier

**Baseline (Fact):** P5 is `READY`; untracked fleet, inbox/promotion, v2, and outer-envelope files are treated as delivered. `PLAN.md:7-17` excludes them and requires evidence-gated proposals.

## Ranked directions

### 1. Versioned host/effect interchange protocol (execution plane)
- **Bottleneck — Fact:** Stable lifecycle is only `RunKernel.advance`; driver composition is a private object hook (`docs/API.md:3-9,27-62`; `src/composition.ts:1-88`; `src/driver.ts:19-21`). Managed binding is pinned to one Codex version/model/sandbox (`src/codex-host-policy.ts:8-15`; `docs/CODEX_EXEC.md:8-39`), and `CodexExecDriver` receives only an already-claimed command (`src/codex-exec-driver.ts:15-18`). Package tests hide private host modules (`test/product-surface.test.js:47-63`).
- **Why major — Inference:** A canonical transport-neutral contract lets approved local/remote/CI executors bind without becoming a selector or second authority.
- **Smallest first release — Inference:** Freeze private schemas for command frame, capability attestation, receipt, terminal/reconciliation, and cancellation/UNKNOWN; add a loopback adapter over `EffectDriver`. No registry, scheduler, retry, or public lifecycle.
- **Dependencies/order:** Freeze token/command-digest and Codex-record parity; then loopback/replay fixtures; remote transport only afterward. Policy stays caller-supplied.
- **Risks/mitigation:** Retries/drift could mint authority; require one-shot intents, exact echoes, bounded canonical bytes, fail-closed UNKNOWN, and byte-compatible old routes.
- **Decisive proof:** Loopback receipt/terminal bytes match; stale/forged tokens reject without mutation; timeout/crash/cancel never relaunch; drift fails closed; existing tests stay unchanged.

### 2. First-class typed worker outputs and artifact attestations (data plane)
- **Bottleneck — Fact:** `WORKER_ENVELOPE` bytes are restricted to `{status}` (`src/model.ts:8,34-40`; `src/public.ts:168-176`); the pump drops report metadata (`src/orchestration.ts:57-61,271-278`). Private results already carry `status`, `reportPath`, `reportDigest` (`src/codex-host-policy.ts:26-30,97-103`), with report-byte verification tested (`test/codex-exec-supervisor.test.js:69-93`).
- **Why major — Inference:** Digest-bound outputs turn status-only phases into handoffable pipeline results without changing reducer/gate authority.
- **Smallest first release — Inference:** Opt-in envelope with status, bounded content-addressed refs, and producer identity; verify before journaling and surface via existing `FINAL.artifacts`/read-only projections. Keep v1 status-only; no auto-approval/input injection.
- **Dependencies/order:** Reuse terminal/report evidence; define retention/sensitivity/redaction; then add parent-authorized successor input binding. Independent of, but compatible with, direction 1.
- **Risks/mitigation:** Bound bytes/counts, verify digests, label sensitivity, quarantine mismatch/orphans, and prevent metadata from becoming authority.
- **Decisive proof:** 0/1/many refs round-trip identically; wrong digest/binding rejects without mutation; replay exact; crash leaves quarantined orphan only; old routes and Memory/File parity hold.

### 3. Storage-neutral authoritative backend seam (state plane)
- **Bottleneck — Fact:** `ArtifactStore` is internal load/commit/CAS plus private hooks (`src/store.ts:94-107`), while `storeForRoot` hard-selects File for roots or Memory (`src/store.ts:801-815,873-914,2893`; `src/public.ts:783-807`). Durability assumes local POSIX `.kernel`, fsync/rename, no-follow descriptors, and current-user ownership (`docs/DURABILITY.md:3-25`; `docs/BRIDGE.md:203-219`).
- **Why major — Inference:** A conformance-bound seam supports selected container/CI/shared-workspace stores without weakening `CURRENT` authority or scraping paths.
- **Smallest first release — Inference:** Allow a private composition-time store and conformance harness for load/commit CAS, linearized dispatch, immutable generations, quarantine, and reuse hooks. Prove one non-POSIX host backend; File remains default; no discovery.
- **Dependencies/order:** Freeze generation/fence/recovery first; direction 2 retention precedes remote bytes. Require an external trust root/identity for multi-user hosts; same-UID replacement stays out of scope (`docs/BRIDGE.md:214-219`).
- **Risks/mitigation:** Consistency/split-brain/leakage could create authority; require linearizable CAS, immutable digest generations, explicit quarantine, bounded reads, fail-closed capabilities.
- **Decisive proof:** Fault matrix (CAS crash, stale writer, partial generation, replay) converges to one `CURRENT` equivalent; byte replay/no duplicate dispatch hold; foreign identity rejects; local routes unchanged.

## Explicit rejections
- Do not repeat shipped fleet coordination, decision inbox/promotion, segmented history/v2 experiment, or resumable release envelope (`PLAN.md:9-11`; `docs/NEXT_BIG_WINS_ROADMAP.md:7-15`).
- Reject dashboard/telemetry-only work, projection de-duplication, accelerator ON/canary, generic plugin/provider registries, ambient discovery, automatic approval, and general DAGs; they are explicitly non-major/deferred (`PLAN.md:13-17`; `docs/ROADMAP.md:409-420`).

## Control Block
- **Status:** FINAL — discovery only; no product/source/test/docs edits beyond this report.
- **Scope:** Architecture/product-platform seams; three ranked candidates, facts/inferences labelled, no provider/performance/token claims.
- **Checks:** Read-only inspection; `git diff --check` and report line/byte limits run after writing.
- **Remaining risk:** Directions 1 and 3 may converge during P2 as execution-vs-state transport; merge rather than duplicate if the exact Sol ranking finds shared authority.
