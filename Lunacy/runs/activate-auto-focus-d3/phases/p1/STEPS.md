# P1 Steps
Goal: make AUTO the truthful persistent installed Lunacy default without weakening the existing safety and rollback boundaries.
Gate: focused red/green product-surface proof, broad required checks, disposable deploy/check, and parent verification of source/install/remote identity.

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S1 | Inspect the existing operator seam; implement the smallest durable D3-default activation in source doctrine/product surface and focused tests; verify end to end. Do not add runtime state/schema/controller or perform production install, commit, or push. | - | NO | DONE | reports/S1-worker-01.md |
| S1R1 | Remove the remaining permissive installed-profile wording and add a regression guard so the persistent AUTO default is unambiguous. | S1 | NO | DONE | reports/S1R1-worker-01.md |
| S1R1 | Remove the remaining contradictory permissive operator wording and reverify the exact activation surface. | S1 | NO | ACTIVE | reports/S1R1-worker-01.md |
