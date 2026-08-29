# P1 Steps — explicit multi-run fleet coordinator

## S1 — implement and verify F1-A through F1-E

- Status: COMPLETE — implementation FINAL; full check has one documented baseline-known R2 mode-value red.
- Owner/route: one exact Luna/xhigh implementation worker.
- Authority: run `PLAN.md`, `docs/NEXT_BIG_WINS_ROADMAP.md` Direction 1, existing project contracts.
- Semantic ownership: fleet coordinator manifest/lease/status implementation, private CLI/runtime integration, schemas if required, focused tests/fixtures, operator/API documentation, and necessary maintained callers. Inventory exact paths before editing.
- Required loop: freeze baseline → inventory/reuse → implement simplest coherent additive coordinator → focused fault/concurrency tests → full `npm run check` → self-review/fix → terminal reverify.
- Must prove: explicit-only roots; CAS lease/round-robin; cross-run conflicts; lifecycle delegation; no duplicate launch; restart/stale-root/lease-loss/UNKNOWN/parent-boundary behavior; one-run/manual compatibility; no second authority.
- Scope expansion/architecture contradiction: stop and write one decision brief before out-of-contract edits.
- Report: `phases/p1/reports/S1-worker-01.md`.

## S2 — adversarial fleet authority/concurrency pass

- Status: COMPLETE — FINAL; repairs accepted.
- Route: exact Luna/xhigh.
- Read-only attack first; may repair only proven defects after parent schedules the step.
- Named risk: competing coordinators, stale/lost leases, root/claim drift, crash convergence, UNKNOWN, or queue metadata becoming transition authority.
- Parent-authorized scope: update the exact maintained deployment managed-file count/fixture for the four reachable fleet runtime artifacts, then verify R2 and the full matrix; no R2 semantic change.
- Report: `phases/p1/reports/S2-worker-01.md`.

## Gate

PASS at `hard-gate-01.md`; write barrier CLOSED.
