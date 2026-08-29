# P4 Steps — R4 recovery forensics
Goal: Add a deterministic, bounded, token-scoped, mutation-free recovery evidence capsule.
Gate: Roadmap R4 schema/binding/redaction/fault/mutation-free proof and terminal full check pass.

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S4 | Implement R4 inspector, CLI/schema/docs/tests, and mutation-free evidence proof | S3 | NO | DONE | reports/S4-worker-01.md |
| S4R1 | Bind effect-root and entry identities in the namespace fence | S4 | NO | DONE | reports/S4R1-worker-01.md |
| S4R2 | Add explicit token alias and bind effect-root identity in namespace hash | S4R1 | NO | DONE | reports/S4R2-worker-01.md |
| S4R3 | Add explicit per-record evidence binding classification | S4R2 | NO | DONE | reports/S4R3-worker-01.md |
| S4R4 | Detect same-byte root/CURRENT inode replacement during inspection | S4R3 | NO | DONE | reports/S4R4-worker-01.md |
| S4R5 | Repair gate-pack-01 binding/golden/bounds/segmented/deployment findings | S4R4 | NO | DONE | reports/S4R5-worker-01.md |
| S4R6 | Enforce capsule schema bounds and redact unsafe/path-like identifiers | S4R5 | NO | DONE | reports/S4R6-worker-01.md |
