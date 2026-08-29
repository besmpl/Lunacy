# P3 Steps — R3 dispatch coordinator
Goal: Extract private in-flight dispatch lifecycle ownership without public or durable behavior change.
Gate: Roadmap R3 exact differential lifecycle parity and terminal full check pass.

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S3 | Extract coordinator, preserve races/fences/receipts, and prove differential parity | S2 | NO | DONE | reports/S3-worker-01.md |
| S3R1 | Fence late dispatch receipts by the captured lease and prove successor safety | S3 | NO | DONE | reports/S3R1-worker-01.md |
