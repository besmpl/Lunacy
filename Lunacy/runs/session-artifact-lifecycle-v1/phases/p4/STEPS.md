# P4 Steps
Goal: implement the R4 read-only audit and one-run Git-backed Markdown pilot as one independently reversible source cell, with copy-first recovery, accepted reference clearance, receipt-bound original unlink, and no live corpus migration.
Gate: M0-M3 normative marker/recovery table; audit inertness; copy/fsync/rename/marker faults; embedded manifest-only acceptance; zero unresolved references; normal R2 receipt before source unlink; exact partial-unlink recovery; Git rollback proof on temporary fixtures; broad check; tracked-only checkout.

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S1 | Implement M0-M3 through private migration core, verified audit/migration tools and launcher/deployment, and hermetic temporary Git fixtures. Preserve R1-R3/public bytes; no real corpus mutation. | P3 | NO | DONE | `reports/S1-worker-02.md` |
