# S4R6 repair report — capsule schema bounds and identifier redaction

## Result

Closed the remaining R4 capsule-boundary gap without widening any public
package route. Recovery request, committed run, and phase identities are
bounded to the frozen 256-character contract and reject control characters
with stable `Recovery:` errors. Opaque step keys remain internally exact for
binding, while path/control-bearing or overlong keys are emitted only as the
deterministic bounded `sha256:<hex>` representation in `outbox.stepId`; report
path derivation uses the same representation for those keys.

Added dependency-free validation of the complete nested capsule (closed keys,
required fields, enums, digest patterns, redaction pattern, and ceilings) at
the inspector return boundary. The frozen schema now declares the bounded
redacted step representation and its digest manifest was updated. Added
P4-SCHEMA-BOUNDS coverage for overlong request identities, overlong phase
capsules, path/control-bearing step IDs, schema validation, and byte-safe
redaction while retaining all prior R4 samples and goldens. Operator docs now
document the identity contract.

## Verification

- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `node --test test/recovery-forensics.test.js` — PASS (8 tests).
- Focused recovery/deployment/legacy suites — PASS.
- `git diff --check` — PASS.
- Terminal `npm run check` — PASS; 446 tests, 444 passed, 0 failed, 2 skipped;
  npm pack dry-run completed and includes the managed private recovery modules
  (final log: `/tmp/r6-terminal-check-final.log`).
