# P2 Steps
Goal: implement roadmap R2 as one one-shot terminal-lifecycle release on top of accepted P1.
Gate: a retained/restorable-corpus-derived private generation floor; shared immutable one-shot derivation; double successor refusal before lease and at CAS; at/above-floor UNKNOWN terminalization with no retry/epoch/reservation/provider re-entry; lower-generation exact historical recovery; Memory/File isolated-process crash lattice; terminal focused checks and `npm run check`. No R3/R4 or live activation.

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S1 | Inventory current rollout origin, retirement, decision publication, and release-census seams; implement the full R2 floor/successor/terminal/restart contract with exact boundary and poison-driver tests. Preserve P1, ordinary recovery, historical WIDEN/D4, and all unrelated work. | P1 PASS | NO | FINDINGS | `reports/S1-worker-01.md` |
| S2 | Add the missing hermetic isolated-child R2 crash lattice for the roadmap's named before/after claim, provider entry, teardown publication, UNKNOWN publication, observation, receipt, retirement, processed-Yield, and File restart cuts across the applicable Memory/File surfaces. Prove exact one-shot and lower-generation outcomes without weakening S1 assertions; repair production only if the lattice exposes an in-scope defect. | S1 | NO — the required lattice itself is the bounded attack | ACTIVE | `reports/S2-worker-01.md` |
