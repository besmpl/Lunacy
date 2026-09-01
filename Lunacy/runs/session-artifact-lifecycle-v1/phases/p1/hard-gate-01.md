# P1 Hard Gate 01

Decision: FINDINGS
Candidate: `reports/S1-worker-01.md`

Parent sample reproduced three closed-contract defects in the D1 validator/classifier:

1. `.work` plus a staged receipt but no continuation marker returns `RESUME_PRE_RENAME`; architecture requires temp-only cleanup/restart, while only marker+temp+Body may resume rename.
2. `validateRunReceipt` accepts `acceptance.kind="manual-parent/v1"` with a runtime witness; kind must match the closed witness schema.
3. An ABANDONED finalization marker accepts arbitrary acceptance-input and staged-receipt paths; they must be the fixed abandonment names from the architecture.

Required repair: fix the shared closed validators/classifier, add direct red/green rows for each defect and adjacent accepted variants, terminally rerun the focused R1 gate and broad `npm run check`, and publish a new immutable report. Preserve the R1 read-only/no-public-export boundary.

Evidence: parent bounded behavior sample executed against `dist/run-retention.js`; outputs were `RESUME_PRE_RENAME`, `kind-mismatch ACCEPTED`, and `abandon-paths ACCEPTED`.
