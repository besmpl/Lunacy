# S4 — post-P5 operations / recovery / release / ecosystem scouts

**Baseline:** P5 READY (`Lunacy/runs/implement-next-big-wins-v2/phases/p5/hard-gate-01.md`) already ships local lifecycle, fleet/inbox/promotion, segmented experiments, forensics, and resumable release envelope. The directions below cross new boundaries.

## 1. Portable run continuity (cold backup/restore, then explicit failover)
- **Facts:** `.kernel/CURRENT`, generations, journal, and quarantine form one local-root authority (`docs/DURABILITY.md:3-25`); retention is CURRENT plus immediate predecessor (`docs/DURABILITY.md:27-37`; `test/storage-retention.test.js:28-38`). `FileArtifactStore` binds root/filesystem identity (`src/store.ts:873-914,1057-1062,1876-1903`); forensics is read-only for one run/token (`docs/RECOVERY.md:3-17,29-48`). Store APIs have no export/import (`src/store.ts:801-849`).
- **Inference / bottleneck:** host/volume loss and handoff have no verified off-host continuation. A digest-bound portable checkpoint improves continuity and auditability (reliability inference, not a performance claim).
- **Smallest coherent release:** private `lunacy-run-backup/v1`; under writer exclusion/quiescence stream a source manifest (run/plan/policy, format/head, generation/state/journal, outbox/effect evidence) to an operator destination; fsync then publish aggregate. Import only an empty trusted root through an old-or-new marker; verify digests, rebind root/writer identity; `CLAIMED`/`UNKNOWN` remain attention/no relaunch. Live replication/failover is later.
- **Dependencies / risks:** reuse store validators, segmented proofs, effect schemas, writer fence, and P5 transaction patterns; independent of scheduler/inbox. Risks are dual advancing roots, stale/tampered/partial backup, secret/effect leakage, and format drift; cold-first, identity/generation fence, bounded/redacted manifest, fail closed.
- **Decisive proof:** fault every stream/stage/fsync/publish/resume point; tamper/truncate/replay; restore to a different root and compare yields/journal/state/effect bindings byte-for-byte; prove no duplicate launch, source mutation, unowned deletion, or `UNKNOWN` relaunch.

## 2. Attested remote/heterogeneous worker fabric
- **Facts:** private `EffectDriver` only dispatches/observes and receipts must echo token+command digest (`src/driver.ts:19-22`); RESUME requires a composed driver or returns `HumanReceiptRequired` (`docs/API.md:45-62`). Managed Codex is local, absolute-path, fixed-model/sandbox (`src/codex-host-policy.ts:213-234,267-280`; `src/codex-exec-driver.ts:15-57`); docs explicitly disclaim remote exactly-once guarantees (`docs/DURABILITY.md:120-139`).
- **Inference / bottleneck:** fleet coordinates roots, not worker hosts; no safe machine/provider handoff and evidence paths assume shared FS. A verified remote boundary broadens host/ecosystem reach and evacuation options (no throughput/provider claim).
- **Smallest coherent release:** private `lunacy-effect-remote/v1` plus operator transport binding endpoint/worker identity, token/digest, run/plan/policy/lease epochs, bounded launch/terminal evidence, and signed receipt. One remote lease; kernel sole claim/ACK; partition/timeout = `UNKNOWN`, never local retry. Ship loopback/reference adapter plus adversarial harness first; disabled by default, no public export/network dependency.
- **Dependencies / risks:** outbox/effect records, `EffectDriver`, host-policy digests, release trust, eventually portable identity; preserve local/manual/fleet/release bytes. Risks are duplicate execution, impersonation/replay, stale lease, partition, payload leakage, and remote writes; mitigate nonce/certificate and exact fences, bounded evidence, fail-closed.
- **Decisive proof:** race two endpoints on one token and show only one signed ACK; reject stale/forged/old receipts; crash/partition/restart converges to `UNKNOWN`/explicit observe without relaunch; local matrices remain unchanged.

## 3. OS/vendor trust-root boundary for unattended/shared hosts
- **Facts:** a same-UID attacker can replace launcher/manifest/bundle, trace/signal/mutate; OS sandbox, separate account, and vendor trust root are out of scope (`docs/BRIDGE.md:203-222`; `docs/API.md:111-121`). Deployment relies on mutable local fingerprints/digests (`docs/BRIDGE.md:140-167`); Codex uses local executable/workspace-write (`docs/CODEX_EXEC.md:21-39`).
- **Inference / bottleneck:** digest consistency is not an independent trust root, blocking defensible unattended/shared CI and third-party host adoption. A verifiable OS/vendor boundary is a major security/reliability gate.
- **Smallest coherent release:** opt-in `lunacy-trust/v1`: signed inventory/launcher provenance plus operator-provisioned sandbox/separate-account helper attestation bound to policy, workspace/run-root, token, and executable digest. Refuse drive without valid trust root/helper; digest-only local mode unchanged. Store bounded attestation digests; key rotation/revocation/backends later.
- **Dependencies / risks:** release envelope, host-policy/effect records, deployment inventory, remote identity; kernel authority unchanged. Risks are key compromise/rotation, helper absence/false attestation, platform/TOCTOU, and lockout; use explicit config, nonce binding, fail-closed, one backend/manual fallback.
- **Decisive proof:** supported-host fixture shows same-UID replacement/trace cannot alter verified bytes; bad signature/nonce/helper drift/absent backend fail pre-dispatch; signed and legacy modes preserve prior artifacts/CLI bytes.

## Explicitly rejected below the major-win bar
Durable counters/telemetry, dashboards, projection no-op writes, accelerator-ON tuning, planner/reuse extraction, extra CLI polish, and a generic plugin framework without concrete demand are supporting/speculative (`docs/ROADMAP.md:409-420`; `docs/ACCELERATION.md:46-47`); defer until an authorized corpus or demand trigger.

## Lunacy Control Block
- **Status:** PASS — three distinct post-P5 directions; discovery only.
- **Files changed:** this report path only.
- **Tests/checks:** read-only evidence inspection; no product tests run/needed; cited ranges checked.
- **Top recommendation:** #1 portable run continuity (cold backup/restore), then #2 remote worker fabric; #3 trust-root boundary for unattended/shared-host deployment.
