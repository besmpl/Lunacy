# P3 Steps — incremental bounded-prefix segmented history

## S1 — implement and verify H3-A through H3-E

- Status: COMPLETE — FINAL; writer remains opt-in/value-unclaimed pending gate.
- Owner/route: one exact Luna/xhigh implementation worker.
- Authority: run `PLAN.md`, `docs/NEXT_BIG_WINS_ROADMAP.md` Direction 3, existing R2 segmented durability/migration/rollback contracts, P2 PASS baseline.
- Semantic ownership: versioned v2 head/checkpoint/segment protocol, reader-first compatibility, opt-in suffix writer/seal, explicit migration/retention/rollback/GC only where the roadmap authorizes it, Memory/File parity, fault tests, representative paired value corpus/bench, required private CLI/schema/docs/maintained callers. Inventory exact paths before editing.
- Required loop: freeze P2 semantic and measurement baseline → reuse inventory → land compatible reader/oracle and crash protocol → opt-in writer only behind exact format marker → migration/rollback/retention → focused semantic/fault matrix → at least 30 short/long paired repetitions with operations/bytes/fsync/wall observations → full `npm run check` → self-review/fix → terminal reverify.
- Must prove: legacy/v1/v2 exact logical replay; authenticated immutable prefix + bounded active suffix; no ordinary append pruning; old-or-new seal/head/state/CURRENT publication; stale fence/tamper/gap/overlap/mixed generation fail closed; exact rollback/retention; Memory/File parity.
- Value boundary: make no improvement claim in advance. If the paired corpus does not demonstrate bounded-prefix value, do not enable/ship the v2 writer; retain only safe reader/oracle work and return DECISION_REQUIRED with exact evidence.
- Scope expansion/architecture contradiction: stop and write one decision brief before out-of-contract edits.
- Report: `phases/p3/reports/S1-worker-01.md`.

## S2 — adversarial durability/migration/value pass

- Status: COMPLETE — FINAL with authorized repairs/addenda.
- Route: exact Luna/xhigh.
- Read-only attack first; repair only proven P3 defects after scheduling.
- Named risk: digest/range/checkpoint errors, partial seal/publication, mixed history, stale writer/fence, tamper/path drift, migration/rollback/GC deletion, Memory/File semantic drift, or unsupported value claims.
- Parent-authorized root-cause scope: apply the v2 hard-link source rebind/fail-closed parity fix to the maintained segmented/v1 writer and add exact regression proof; preserve healthy v1 behavior/read compatibility.
- Parent-authorized maintained-caller scope: update recovery-forensics v2 budget/format classification and regression without enabling v2 writes.
- Value disposition: reader/oracle accepted; v2 writer is private explicit experimental opt-in only, with zero default/managed selection and no value claim.
- Report: `phases/p3/reports/S2-worker-01.md`.

## Gate

PASS at `hard-gate-01.md`; reader/oracle accepted, no default/managed writer enablement or value claim; write barrier CLOSED.
