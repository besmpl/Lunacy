# P2 S2 — adversarial token/promotion pass

## Scope and attack

Read-only review targeted the P2 S1 decision-inbox/promotion diff and named risks:
projection authority, stale/replayed token/evidence/cursor/epoch/plan/policy
bindings, invalid token consumption, concurrent submit, authority adoption during
live old work, promotion gate/phase/plan/authorization checks, crash/retry
identity, and evidence/path boundaries. Existing S1 tests were replayed before
repair; no ambient roots or projection writes were observed.

## Proven findings and repairs

1. **Phase binding bypass (P2).** `submitParentDecision` compared run root/run ID,
   token, plan, cursor, epochs, and digests but omitted `inbox.run.phaseId`.
   A caller could alter the phase field and still consume a valid gate token; the
   replay path also accepted a tampered phase. Added exact phase checks to both
   fresh and replay cursor fences. Regression: `test/decision-inbox.test.js`
   (`phase binding is exact...`) proves stale phase cannot consume or replay.
2. **Mutable structured boundary inputs (P2).** Inbox and handoff objects, plan
   declarations, and structured adoption values were retained across awaits or
   reread after snapshot, permitting caller mutation between binding and kernel/
   lifecycle calls. Added canonical snapshots before the first await; adoption
   raw-plan digest and derived event identity now use those immutable snapshots.
   Invalid snapshots fail closed without token mutation.
3. **Token control-boundary hardening.** Decision-inbox token validation now rejects
   control characters (consistent with bounded IDs), preventing line/control
   injection in private capsule values while preserving generated token spelling.

No authority contradiction or scope expansion was required; kernels remain the
only token/transition authority and promotion remains explicit predecessor-to-
successor handoff.

## Verification evidence

- Focused: `npm test -- --test-name-pattern='decision inbox|phase binding|phase promotion'` — exit 0; 61 tests discovered, 61 passed.
- Terminal: `npm run check` — exit 0; full log `/tmp/p2-s2-terminal-check.log`; 459 tests, 457 passed, 0 failed, 2 skipped; package dry-run completed (131 files).
- Final source/test surfaces: `src/decision-inbox.ts`, `test/decision-inbox.test.js`; no P1/P3/P4 edits.

## Control Block

- **Status:** FINAL / PASS
- **Scope:** P2 S2 adversarial pass; only proven P2 repairs.
- **Authority:** P2 Direction 2; kernel remains sole transition/token authority.
- **Repairs:** exact phase fence; immutable inbox/handoff/plan/value snapshots; token control-boundary validation.
- **Terminal:** `npm run check` exit 0 (459 tests; 457 pass; 0 fail; 2 skipped).
- **Evidence:** `/tmp/p2-s2-terminal-check.log`.
- **Report:** `Lunacy/runs/implement-next-big-wins-v2/phases/p2/reports/S2-worker-01.md`.
- **Parent gate:** inspect P2 S1+S2 diffs; run hard gate at `phases/p2/hard-gate-01.md`; keep P3 blocked until PASS.
