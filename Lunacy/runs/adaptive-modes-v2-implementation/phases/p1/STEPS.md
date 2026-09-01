# P1 Steps

Goal: implement and release the complete accepted adaptive-v2 observable through the fewest coherent ownership boundaries.
Gate: roadmap §8 plus architecture §16, evaluated against the exact committed and installed candidate.

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S1 | Own roadmap Cells 0–5 end-to-end: reconcile dirty work, implement, verify, self-review/fix, create immutable candidate, atomically install disabled, run authorized canaries/rollback, and safely push only after every gate | - | CONDITIONAL — provider-fence or production-restart risk only if unresolved | ACTIVE | `reports/S1-worker-01.md` |
