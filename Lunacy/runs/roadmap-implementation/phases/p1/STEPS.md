# P1 Steps — R1 lifecycle controller
Goal: Ship an additive idempotent one-run `init` + `run`/`resume` controller by composing existing transition and pump authority.
Gate: Roadmap R1 exit criteria, fault matrix, legacy compatibility, and terminal full check pass.

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S1 | Implement R1 contract, init/run/resume composition, tests, and operator documentation | - | NO | DONE | reports/S1-worker-01.md |
| S1R1 | Repair parent-gate finding: add truthful operator documentation and re-audit R1 acceptance/simplicity | S1 | NO | DONE | reports/S1R1-worker-01.md |
