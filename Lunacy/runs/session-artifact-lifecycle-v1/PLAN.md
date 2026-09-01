# Lunacy Execution Plan

## Authority
Goal: implement the accepted Seed/Body/Custody lifecycle end to end, preserving existing public runtime/event/state bytes, bridge/report paths, effect custody, and unrelated work.
Plan/task: `docs/SESSION_ARTIFACT_ROADMAP.md`
Architecture: `docs/SESSION_ARTIFACT_LIFECYCLE.md`
Project rules: `WORKSPACE.md`; installed Lunacy `SKILL.md`, `orchestrator/PLANNING.md`, and `worker/ENGINEERING.md`

## Accepted observable
- R1: a source/installed read-only doctor classifies bounded legacy and retention states without changing run-root bytes, metadata, public exports, or runtime behavior.
- R2: new runs can atomically admit Body only under canonical ON policy; accepted runs publish a durable exact receipt before crash-resumable Body cleanup; OFF stops new admission without stranding recovery.
- R3: explicit STOPPED/BLOCKED abandonment reuses the finalizer without claiming a product result or touching unresolved Custody.
- R4: one allowlisted Git-backed legacy pilot can copy, accept, seal, and restartably remove only exact receipt-bound originals; no bulk migration.

## Architecture spine / contracts
- Seed / Body / Custody is fixed; uncertainty retains bytes.
- Parent acceptance, never worker/runtime completion, authorizes accepted cleanup.
- One exact Body namespace; no ambient GC, timer, registry, runtime schema, or package-root export.
- Existing release/owned-file/canonical/deployment mechanisms are reused; public and installed compatibility corridors remain exact.
- Each release is one largest-coherent owner cell; numbered D/A/M cells are local bisection points, not Plan nodes.
- No live install, publish, push, or real-run destructive canary without separate parent/user authority.

## Phases / gates
P1 — PASS — gate: `phases/p1/hard-gate-02.md`.
P2 — PASS — gate: `phases/p2/hard-gate-02.md`.
P3 — PASS — gate: `phases/p3/hard-gate-02.md`.
P4 — PASS — gate: `phases/p4/hard-gate-02.md`.

Final gate — PASS — `phases/p4/hard-gate-02.md`.

Optional adversaries: P2 only, after its writer finalizes, for exact deletion authority, lock ordering, and crash recovery.
