# P2 Steps
Goal: implement and integrate the complete R2 accepted-run Body lifecycle behind asymmetric admission, with exact acceptance, exclusion, filesystem safety, receipt publication, crash-resumable cleanup, doctrine, and verified deployment.
Gate: every item in the roadmap R2 checklist; focused race/fault/E2E/deployment matrix; `npm run check`; tracked-only checkout; zero Custody diff; admission-OFF rollback proof.

| Step | Goal | Depends | Adversary | Status | Report |
|---|---|---|---|---|---|
| S1 | Implement D3-D9 as one coherent release candidate. Reuse existing claims, decision identity, filesystem trust, process quiescence, and deployment transaction. Preserve every compatibility corridor. No live install/deploy or real-run deletion. | P1 | YES: exact deletion authority, lock ordering, crash recovery | DONE | `reports/S1-worker-02.md` |
