# S1 — autonomy/orchestration frontier

## Control
- Status: PASS (discovery only; no product files changed).
- Baseline: P5 READY candidate, including untracked fleet/inbox/segmented/release files.
- Verification: source/docs/tests inspected; report line/trailing-whitespace check; no product tests (discovery only).
- Decision needed: parent/Sol must choose which frontier, if any, crosses the current explicit-only boundary.

## Manual choreography still present (facts)
- `BridgeDrivePump` is ephemeral/no scheduler and stops at parent boundaries (`src/orchestration.ts:105-109,193-206`); each `LifecycleController` call is fresh (`src/orchestration.ts:796-807`), and `runRun`/`resumeRun` are one drive (`src/orchestration.ts:745-774`).
- Fleet names one entry, calls `resumeRun` once, and records attention (`src/fleet-coordinator.ts:319,375-383,447-456`); state is only cursor/leases/observations (`src/fleet-coordinator.ts:74-82`). Operator re-invokes after waits/receipts/gates.
- Managed drive wakes parent for receipts, BLOCKED/NEEDS-DECISION, gates, phase/final boundaries, cancellation (`SKILL.md:35-52`); parent schedules next batch/acceptance (`SKILL.md:152-154,183-191`).
- Gate/adoption are parent events (`src/reducer.ts:247-278,287-318`); inbox submit takes caller value/plan (`src/decision-inbox.ts:48-58,261-354`). Terminal result is only `{status,reportPath,reportDigest}` (`src/codex-host-policy.ts:26-32`), so parent reconstructs checks/reports (`src/codex-exec-supervisor.ts:1154-1195`; `SKILL.md:146-154`).

## Ranked new directions
### 1. Durable continuation session (bounded event-driven supervisor)
- **Fact/bottleneck:** current fleet/drive has no durable wake/session state (citations above); restart means caller rebinds manifest, policy/driver, and invokes `resumeRun` again.
- **Inference/payoff:** explicit lease-owned session removes repeated wake/re-entry while kernel remains authority (no speed claim).
- **First release:** private `run-session/v1` binding roots/manifest digest, owner+epoch, allow-listed wake sources, max turns/deadline/stop policy; persist marker/observations, call `resumeRun`, stop at existing boundaries (no auto-decide/relaunch/promote).
- **Order/deps:** reuse fleet lease + pump + dispatcher callbacks; prove crash/restart/competing owner before delegation.
- **Risks/proof:** avoid second scheduler/stale watcher/duplicates via parent opt-in, CAS lease, bounded wakes, expiry; kill/restart tests prove one launch, kernel-only writes, identical yields, disable-without-mutation.

### 2. Proof-carrying worker outcome (machine-verifiable gate evidence)
- **Fact/bottleneck:** terminal validation cannot establish which checks ran; only status/report digest reaches `WORKER_ENVELOPE` (`src/orchestration.ts:255-280`; supervisor citations above). Reports/Workfront omit machine evidence (`src/workfront.ts:10-18,116-136`).
- **Inference/payoff:** bounded evidence reduces parent reconstruction and enables safe future delegation; verifier cannot approve.
- **First release:** private `lunacy-worker-proof/v1` on terminal record with allow-listed checks/results, diff+report digest, phase/step/attempt and authority/policy digests; pure verifier emits `CERTIFIED`/`ATTENTION`; parent gate stays authoritative.
- **Order/deps:** supervisor/effect records first; feed verifier to session stop policy or delegation.
- **Risks/proof:** parent-signed check contract, canonical/bounded/redacted fields, no-write verifier prevent forgery/schema coupling/second authority; malformed/stale evidence must attention without token consumption, drift detected, valid proof replay-identical.

### 3. Signed bounded delegation (pre-authorized safe continuation decisions)
- **Fact/bottleneck:** managed drive stops at every approval/gate/adoption (`SKILL.md:35-50`); inbox/promotion still require explicit caller value/authorization (`src/decision-inbox.ts:48-58,377-417`). Host policy is capability-only and excludes retry/status/scheduler (`src/codex-host-policy.ts:8-13`).
- **Inference/payoff:** exact parent-signed delegation removes repetitive already-decided interventions, not ambient auto-approval.
- **First release:** private `delegation/v1` binding run/phase/plan/policy/token digests, one event template, count/epoch/expiry/revoke; submit only via inbox/kernel; UNKNOWN/FINDINGS/stale/unlisted values wake parent.
- **Order/deps:** token/epoch fences plus direction-2 verifier; session is optional.
- **Risks/proof:** canonical auth, one-event token, fail-closed mismatch/revoke, byte-equivalent manual path prevent second authority/replay; forged/expired/wrong-plan rejected without consumption, concurrent submit journals once.

## Explicit rejects (not major enough or violates current contract)
- Richer Workfront/capsule fields, CLI convenience, Beads adapters, retry knobs, or larger queues only polish existing projections and do not cross the manual-authority bottleneck (`docs/WORKFRONT.md:18-22`; `docs/NEXT_BIG_WINS_ROADMAP.md:73-78`).
- General DAG/discovery/fan-out scheduler is intentionally out of scope (`docs/NEXT_BIG_WINS_ROADMAP.md:39-45,169-174`); it would create a second authority before bounded session/proof/delegation contracts are proven.

## Control Block
Status: PASS
Goal/result: identified three ranked autonomy directions with exact evidence, bounded first releases, dependencies, risks, and decisive proofs; rejected repeats/smaller polish.
Changed: only this report.
Tests: not run (discovery-only); source/docs inspection completed.
Decision: NO (parent/Sol selection required, not a blocker).
Risk: proposals are future seams; no product behavior is changed or claimed.
