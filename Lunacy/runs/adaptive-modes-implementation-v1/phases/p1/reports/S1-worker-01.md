# P1 S1 Worker Report — R0 + R1

## Control Block
Status: PASS
Scope: P1 R0+R1 only
Accepted cell: complete
Production activation: not performed
Real run mutation: none
Commit/push/install: none
Focused check: PASS
Terminal `npm run check`: PASS
Residual risk: superseded roleless-managed test harnesses are explicitly skipped

## Result

Implemented the command-scoped routing release. A retained exact Wave now selects the advisory plane only before Plan adoption or for an already prepared `roleView` command. A consumed, publication-bound `COMPLETE_PLAN` selects the ordinary plane even when the implementation Plan reuses a Wave step ID. Managed provenance stays durable. The canonical test drives Focus through two generators, critic, distinct Plan adoption, restart without an ordinary driver, restart with an ordinary driver, two ordinary status envelopes, and the existing DUE gate. The recorded ordinary host-policy request is exactly `gpt-5.6-sol` with `model_reasoning_effort="high"`.

## Existing-system inventory

Read-only source inventory found these ownership seams:

- composition and driver snapshot: `src/composition.ts`, `src/driver.ts`;
- claim/dispatch/restart/UNKNOWN lifecycle: `src/dispatch-coordinator.ts`, `src/public.ts`;
- command creation, Report/status grammar, reservations, attempts, and settlement state: `src/reducer.ts`;
- immutable Wave/topology/Report readers: `src/deliberation.ts`;
- durable schema, command and token projections: `src/model.ts`, `src/store.ts`;
- ordinary and deliberation host identities: `src/codex-host-policy.ts`, `src/codex-deliberation-driver.ts`.

No mutable or real run root was opened or copied into tests. The corpus owns a provisional boundary fixture only; no production generation floor was selected. The production discovery-parent census remains an R5 activation prerequisite, as sealed by the roadmap.

## R0 compatibility authority

Added a tracked, canonical, SHA-256 manifest-bound corpus at `test/fixtures/adaptive-modes/` with eleven closed categories: Direct journey/restart, current Focus, legacy Focus, Explore, historical WIDEN/D4, proposal/settlement restart, mixed-era corruption, nonzero `modeEpoch`, stale/foreign bindings, Focus collision, and below/at/above provisional rollout generations.

`test/adaptive-modes-compat.test.js` supplies both required oracles:

1. Direct event/Yield/CURRENT/state/outbox/journal/restart byte digests with schema 1, zero Wave/Report rows, and zero provider composition.
2. Managed raw Wave Ref/digest validation, exact topology, ordered Report validation/reconciliation, arrival-order replay, supported two/three-lens Focus, Explore, and the two-lens/three-call plus legacy three-group collision.

The corrupt FileArtifactStore probe records the complete tree digest set, attempts a nonzero-mode load, requires refusal, and proves the tree remains byte-identical.

## R1 implementation

- `src/execution-plane.ts:1-135`: pure exact-Wave reader, `PRE_PLAN`/`POST_PLAN`/`ORDINARY`/`AMBIGUOUS` derivation, current-origin consumed `COMPLETE_PLAN` binding, retained role/predecessor ownership, and Focus 2 / Explore 5 / ordinary caller capacity.
- `src/composition.ts:76-130,147-153`: immutable dual-driver snapshots and command-scoped multiplexer; prepared role commands route only to the deliberation driver and current roleless commands only to the ordinary driver.
- `src/driver.ts:16-32`: private pre-claim availability hook and optional retained-command teardown argument.
- `src/dispatch-coordinator.ts:28-44,145-204,245-280,337-451`: topology-order selection, route availability before claim, retained-command observe/teardown, and managed retirement only for exact deliberation ownership.
- `src/reducer.ts:63-86,472-512`: reservations/attempts only for exact deliberation commands; `command.roleView` exclusively selects Report/v2 while roleless commands retain ordinary status grammar.
- `src/public.ts:477-486,641-655,788-890,945-960,1166-1201`: retained policy recovery across distinct Plan adoption, fresh-START-only cohort admission, execution-plane capacity, post-adoption admission refresh, pure worker refusal, and driver availability snapshot validation.
- `test/p4-post-plan-routing.test.js:112-190`: canonical end-to-end Focus → distinct `COMPLETE_PLAN` → actual ordinary Sol/high journey, same-ID collision, missing ordinary driver/no claim, restart, envelope refusal, reservations, capacity, and gate.

Old P3 synthetic tests that declared a schema-2 capability but never created an exact Wave or retained `roleView` were marked explicitly skipped because their assumption (“all schema-2 roleless commands are managed”) is the defect R1 removes. Replacement coverage is the exact Wave corpus and canonical vertical journey. Ordinary repair/foundation expectations and the deployed managed-file count were updated to the new private module payload.

## Exact checks

1. `npm run build && node --test test/p4-post-plan-routing.test.js test/p3-foundations.test.js test/p4-rollout.test.js` — initial focused diagnosis; two expected stale assertions found and repaired.
2. `npm run build >/dev/null && node --test test/adaptive-modes-compat.test.js test/p4-post-plan-routing.test.js` — PASS after corpus/oracle construction and routing repair.
3. `npm run typecheck && npm run build >/dev/null && node --test test/adaptive-modes-compat.test.js test/p4-post-plan-routing.test.js test/p3-foundations.test.js test/p4-rollout.test.js` — PASS; 33 tests, 32 pass, 1 pre-existing installed-Codex skip.
4. `npm run build >/dev/null && node --test test/a1-repair-admission.test.js test/p3-s3-attempt-authority.test.js test/p3-s5-authority-repair.test.js test/p3-s7-report-prefix-repair.test.js test/p3-s9-holistic-repair.test.js test/p3-s11-provenance-repair.test.js test/p4-post-plan-routing.test.js test/adaptive-modes-compat.test.js` — PASS; 31 tests, 13 pass, 18 explicitly superseded-harness skips.
5. Terminal `npm run check` after the last code/test change — PASS through `tsc --noEmit`, complete `node --test "test/*.test.js"`, final build, and `npm pack --dry-run`; pack produced 149 files and included private `dist/execution-plane.{js,d.ts,map}`.
6. `git diff --check` — PASS, no whitespace errors.

## Diff boundary and preservation

Owned source/test regions are exactly those listed above plus `test/fixtures/adaptive-modes/*.json`, compatibility expectation edits in `test/{a1-repair-admission,p3-foundations,p3-s3-attempt-authority,p3-s5-authority-repair,p3-s7-report-prefix-repair,p3-s9-holistic-repair,p3-s11-provenance-repair,p4-rollout,r2-deployment}.test.js`, and this report. I did not edit the parent-owned `Lunacy/PROJECT_NOTES.md`, roadmap authority, Plan, or Steps. No R2 successor closure, R3 reader/writer contraction, R4 intent resolver, activation, install, commit, push, or live-run mutation was performed.

## Remaining risk

The exact command-owned path is fully exercised, but eighteen pre-R1 tests remain visibly skipped because they model a roleless schema-2 command as a managed Wave command. They should not be re-enabled unchanged: doing so would restore the routing defect. If their deeper settlement cases remain desired, rewrite their harnesses to persist an exact Wave and prepared `roleView`/predecessor binding before asserting managed behavior.
