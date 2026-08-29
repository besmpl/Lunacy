# P4 Hard Gate 01 — R4 recovery forensics

Status: PASS

## Accepted implementation
- Additive private managed `inspect-recovery`/`recovery` route emitting canonical `lunacy-recovery/v1` for one explicit run/token.
- Verified generation/journal budgets, outbox/lease, token-scoped launch/terminal evidence binding, UNKNOWN cause, lock/fence status, and informational nextProof.
- Strictly read-only, bounded, deterministic, schema-validated, redacted, and packaged in the managed deployment inventory without package-root export changes.

## Gate history and repairs
- S4R1-R4 added effect/root/CURRENT identity fences, explicit token alias, per-record bindings, and same-byte inode replacement detection.
- Gate pack 01 found eight material gaps: wrong-digest effect authority, terminal semantics, missing goldens, report binding, alias ambiguity, targeted record failure behavior, unbounded read/directory and segmented ceiling behavior, and a broken managed deployment boundary. S4R5 repaired all eight.
- Gate pack 02 independently confirmed all eight closures, then found emitted identity strings could violate the frozen schema or leak path-like step IDs. S4R6 added bounded identity gates, deterministic step redaction, and boundary schema validation.
- Parent inspected the final validator/redaction path and focused schema-bound tests.

## Verification
- S4R6 terminal `npm run check`: PASS — 446 tests, 444 pass, 0 fail, 2 platform skips; typecheck/build/pack included.
- Fresh scout focused recovery+Workfront: PASS — 19/19; managed deployment: 5/5; direct non-default segmented ceiling and wrong-digest/terminal probes passed before S4R6.
- Parent bounded acceptance: `node --test test/recovery-forensics.test.js` PASS — 8/8, including goldens, malformed/oversize/symlink, alias conflicts, schema bounds, and path/control redaction.
- `git diff --check`: PASS.

## Compatibility / recovery / rollback
- Workfront, one-event, drive, R1 controller, R2 stores, R3 coordinator, and package-root exports remain unchanged.
- Inspection calls no dispatch, observe, ACK, repair, quarantine, cleanup, projection, cache, or lock-acquisition path; root/CURRENT/effect namespace is rebound before return.
- Managed deployment carries the private recovery modules; disabling/removing the additive route leaves durable runtime/effect state untouched.

## Decision
R4 satisfies its roadmap exit criteria. Integrated P5 release work may begin.
