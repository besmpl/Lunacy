# P2 Steps — digest-bound decision inbox and exact promotion

## S1 — implement and verify I2-A through I2-E

- Status: COMPLETE — FINAL; terminal full matrix green.
- Owner/route: one exact Luna/xhigh implementation worker.
- Authority: run `PLAN.md`, `docs/NEXT_BIG_WINS_ROADMAP.md` Direction 2, P1 explicit manifest identity, existing decision-token/Workfront/lifecycle contracts.
- Semantic ownership: inbox projection/redaction and selected-entry listing, exact decision submission, explicit predecessor/successor handoff/promotion, necessary private CLI/runtime integration, schemas, maintained callers, tests/fixtures, and docs. Inventory exact paths before editing.
- Required loop: freeze P1 PASS baseline → reuse inventory → implement inbox as projection and promotion as explicit parent handoff → focused token/digest/epoch/concurrency/crash tests → full `npm run check` → self-review/fix → terminal reverify.
- Must prove: deterministic mutation-free listing; kernel-owned one-shot token; invalid binding never consumes; concurrent identical submit commits/replays one event; no auto-approval; promotion only after exact predecessor FINAL/gate/PASS + parent authorization + successor digest; retry identity/no duplicate successor; unchanged Workfront/manual/cross-phase behavior.
- Scope expansion/architecture contradiction: stop and write one decision brief before out-of-contract edits.
- Report: `phases/p2/reports/S1-worker-01.md`.

## S2 — adversarial token/promotion pass

- Status: COMPLETE — FINAL; repairs accepted.
- Route: exact Luna/xhigh.
- Read-only attack first; repair only proven P2 defects after the parent schedules the step.
- Named risk: stale/replayed token/evidence/cursor/epoch bindings, concurrent submit, evidence leakage, pre-PASS/gate bypass, live-old-work, promotion races, or retry creating a duplicate successor/second authority.
- Report: `phases/p2/reports/S2-worker-01.md`.

## Gate

PASS at `hard-gate-01.md`; write barrier CLOSED.
