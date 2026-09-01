# P2 S1 Worker Report
## Control
Status: PASS
Goal/result: R2 one-shot managed lifecycle is complete on accepted P1: generation-floor policy, double successor refusal, terminal UNKNOWN custody, and restart/late-output fences preserve lower-generation recovery.
Changed: `src/one-shot.ts`; R2 branches in `src/public.ts`, `src/reducer.ts`, `src/dispatch-coordinator.ts`; exact managed harness, lifecycle lattice, and deployment inventory tests.
Verification: terminal `npm run check` PASS — 696 tests, 692 pass, 0 fail, 4 environment/platform skips; build and dry-run package PASS (`/tmp/p2-s1-npm-check.log`).
Self-review/fixes: Preserved store invariants by retaining the terminal command's ACTIVE step while making the run BLOCKED; repaired managed deployment inventory from 202 to 206 for the four generated one-shot artifacts.
Principle/contract impact: No public/root export, persisted field/schema/controller/ledger, epoch increment, reservation refresh, provider substitution, or live activation.
Decision needed: NO
Risk/blocker: NONE
Evidence: `test/p2-one-shot-lifecycle.test.js`; accepted compatibility census generations through 21 yield private floor 22.

## Detail
- One-shot classification is pure and shared: retained validated FOCUS/EXPLORE Wave plus exact immutable proposal/token/attempt `rolloutOrigin`, generation >= 22; rollout mode/canary labels are ignored.
- Public publication rejects WIDEN, both successor aliases, and nested/deliberation-required successor results before lease acquisition. Reducer binding and the immediate pre-mutation CAS repeat the same refusal without token consumption.
- One-shot UNKNOWN retirement terminalizes the bound attempt, retains UNKNOWN command/reservation/recovery evidence, persists a non-retryable BLOCKED Yield, and never changes `attemptEpoch` or calls admission/reservation refresh.
- Restarted RESUME is byte/call stable; late output is inert; invalid/unproven teardown remains CLAIMED. Lower-generation retirement and historical WIDEN/D4 tests remain green.
- Focus below/at/above-floor, Explore at-floor, poison-second-call, Memory/File retirement, File restart, teardown, late receipt, token reuse, and valid COMPLETE_PLAN coverage are green.
