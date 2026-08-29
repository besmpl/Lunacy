# P4 Steps — resumable outer release-operation envelope

## S1 — implement and verify O4-A through O4-E

- Status: COMPLETE — FINAL; terminal full matrix green.
- Owner/route: one exact Luna/xhigh implementation worker.
- Authority: run `PLAN.md`, `docs/NEXT_BIG_WINS_ROADMAP.md` Direction 4, existing release admission/exclusion/quiescence/target-lock/inner transaction contracts, P3 PASS baseline.
- Semantic ownership: closed v2 outer envelope/phase marker, mutation-free status, resumable admission/revalidation, subordinate delegation to existing deploy/restore/check/exact transaction, rollback/compatibility/recovery, required private CLI/schema/docs/tests/fixtures and maintained release callers. Inventory exact paths before editing.
- Required loop: freeze P3 release/legacy baseline → reuse existing release marker/locks/exclusion/quiescence/transaction → implement smallest subordinate outer phase machine → fault every outer/inner boundary and identity drift → verify legacy/exact bytes/unowned preservation/residue → full `npm run check` and required deploy/check fixtures → self-review/fix → terminal reverify.
- Must prove: exact operation/manifest/target/owner/snapshot identities; deterministic mutation-free status; established lock order/liveness; resume revalidates before delegation; outer committed derives only from verified inner aggregate; crash convergence to exact prior/candidate; stale/tampered bindings no mutation; no unowned loss/residue; no legacy/public behavior drift.
- Scope expansion/architecture contradiction: stop and write one decision brief before out-of-contract edits.
- Report: `phases/p4/reports/S1-worker-01.md`.

## S2 — adversarial outer/inner recovery pass

- Status: COMPLETE — FINAL; repairs accepted.
- Route: exact Luna/xhigh.
- Read-only attack first; repair only proven P4 defects after scheduling.
- Named risk: outer marker becoming release authority, stale owner/snapshot/target adoption, outer/inner phase disagreement, duplicate publication, liveness/reclaim error, cross-fence rollback, unowned-file loss, mutation from status, or legacy/exact output drift.
- Report: `phases/p4/reports/S2-worker-01.md`.

## Gate

PASS at `hard-gate-01.md`; write barrier CLOSED.
