# P3 S2 addendum 01 — recovery-forensics v2 budget binding

Status: FINAL

## Authorized repair
- Parent recorded the P3 value and maintained-caller decisions and authorized this narrow compatibility repair. `src/recovery-forensics.ts:306` now recognizes both `segmented/v1` and `segmented/v2` when deriving the capsule journal budget. Verified v2 capsules therefore report `format: segmented`, unbounded full-journal event/byte ceilings, and the persisted bounded active suffix instead of legacy ceilings.
- Added `test/recovery-forensics.test.js` coverage for a migrated v2 capsule (`events.ceiling === null`, `bytes.ceiling === null`, `activeSuffix.ceiling === 1000`, exact used count). Added a managed-transition default guard proving the existing route does not select v2 writes (`CURRENT` has no format marker).

## Verification
- Focused `node --test test/recovery-forensics.test.js test/p3-segmented-v2.test.js test/r2-segmented.test.js`: **31/31 pass** (`evidence/S2-adversary-focused-recovery-v2-final.log`).
- Terminal `npm run check`: **471 tests, 469 pass, 0 fail, 2 skipped**; typecheck/build/package dry-run pass (`evidence/S2-adversary-terminal-check-recovery-v2-final.log`).
- v2 writer remains private explicit opt-in; no managed/default route selects it, no default or public API behavior changed, and no value claim is made. Existing paired corpus meaning/recommendation and fault/migration proofs remain those cited by the parent S2 report.

## Control Block / gate navigation
- Recovery budget reporting is now v1/v2 correct; semantic/recovery/fault parity remains PASS for this adversarial sample. Value remains **UNCLAIMED** because the corpus records final namespace stat-size and injected fsync points rather than prefix operations/bytes read-written, with mixed wall samples.
- Follow `PLAN.md` P3 Gate and `STEPS.md` Gate: keep reader/oracle plus explicit opt-in writer, do not enable defaults, and keep P4 blocked until the parent records the explicit reader-only/no-value decision or accepts new bounded-work instrumentation evidence.
