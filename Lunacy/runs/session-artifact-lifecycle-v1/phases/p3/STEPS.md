# P3 Steps
Goal: implement R3 explicit abandoned-run disposal as one independently reversible release by extending the accepted R2 finalizer, never runtime semantics or a second deletion engine.
Gate: roadmap R3 checklist; explicit closed authority only; BLOCKED/STOPPED and no active work; UNKNOWN/malformed Custody preserved; accepted/abandoned records cannot be confused; every crash prefix recovers; broad check; tracked-only checkout; zero live run mutation.

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S1 | Implement A0-A2 through the private retention validator/finalizer, verified launcher/deployment surface, doctor compatibility, and focused tests. Preserve R1/R2 and public bytes. No live abandonment or P4 migration. | P2 | NO | DONE | `reports/S1-worker-02.md` |
