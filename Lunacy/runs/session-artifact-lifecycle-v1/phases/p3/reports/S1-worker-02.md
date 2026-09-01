# P3 / S1 — R3 Durable-Custody Repair

## Control
Status: PASS
Goal/result: Abandonment now proves actual durable CURRENT custody at preparation and every destructive finalization/recovery boundary instead of trusting caller zeroes.
Product delta: `src/run-retention.ts`
Test delta: `test/run-abandonment.test.js`
Verification: PASS — typecheck/build; abandonment + all retention 54/54; `npm run check` 653 tests / 649 pass / 0 fail / 4 skip; isolated tracked candidate without `Lunacy/**` 54/54; diff check.
Self-review/fixes: Strict read-only CURRENT observation refuses any ACTIVE step or PENDING/CLAIMED command, binds run identity, and requires observed UNKNOWN/malformed classifications to be reflected without mutating Custody.
Principle/contract impact: No schema/event/state/ledger/export/deletion-engine change; the existing R2 finalizer remains the sole Body cleanup path.
Decision needed: NO
Risk/blocker: NONE
Live effects: No install/deploy, live abandonment/canary, real or historical run mutation, commit, push, or P4 work.

## Detail
- Added one private custody observation at the established `FileArtifactStore.loadReadOnly()` seam. Valid CURRENT state is inspected across all steps and outbox rows; false authority zeroes cannot hide current or historical actionable work.
- A valid CURRENT belonging to another run refuses. A malformed CURRENT is allowed only when the closed authority declares malformed custody; its bytes are never repaired, reclassified, or deleted. Observed UNKNOWN rows must be covered by the declared retained count.
- Preparation checks before publishing the fixed authority. Finalization checks under the existing exclusion before Body rename and again at the existing frozen-seed point. Receipt-published crash recovery checks the receipt-embedded authority before tombstone cleanup, including recovery after the fixed authority was already removed.
- Added direct durable-store fixtures for ACTIVE-only, PENDING, CLAIMED, historical UNKNOWN, idle-to-actionable drift, marker-cut recovery drift, unreflected UNKNOWN/malformed refusal, and inode/mode/byte preservation.

## Terminal verification
- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `node --test test/run-abandonment.test.js test/run-retention-*.test.js` (explicit maintained list) — PASS, 54/54.
- `npm run check` — PASS, 653 total / 649 pass / 0 fail / 4 skip; typecheck, full suite, build, and package dry-run completed.
- Isolated candidate built from `git ls-files --cached --others --exclude-standard`, excluding `Lunacy/**`, with typecheck/build and the same focused retention gate — PASS, 54/54; candidate contained no `Lunacy` path.
- `git diff --check` — PASS.
