# P2 Steps — R2 segmented journals/checkpoints
Goal: Implement compatible, versioned, crash-safe journal segmentation/checkpointing and explicit migration/compaction.
Gate: Roadmap R2 exit criteria, legacy/new parity, long-history and fault matrix, and terminal full check pass.

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S2 | Implement R2 reader, writer, migration/rollback, compaction/retention, tests, and docs | S1 | NO | DONE | reports/S2-worker-01.md |
| S2R1 | Repair gate-pack-01 crash/read-only/authority/GC/API/fault-matrix findings | S2 | NO | DONE | reports/S2R1-worker-01.md |
| S2R2 | Bind all segmented CURRENT epochs/fence/count fields to verified state/head | S2R1 | NO | DONE | reports/S2R2-worker-01.md |
