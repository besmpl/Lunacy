# P2 Step — exact production retry

## S2 — deploy and verify the repaired latest candidate
- Status: PASS
- Build/check the candidate, use a fresh canonical production manifest and post-ownership process snapshot, deploy through the opt-in resumable release envelope, then run the exact production `--check` with its own fresh manifest/snapshot.
- Confirm installed top-level Lunacy policy files still match the source checkout because managed deployment owns only `runtime/`.
- Preserve deploy/check outputs and envelope status under `evidence/`.
