# P3 / S1 — R3 Explicit Abandonment

## Control
Status: PASS
Goal/result: Explicit BLOCKED/STOPPED abandonment is closed, policy-gated, crash-resumable, custody-preserving, and distinct from accepted sealing.
Changed: `src/run-retention.ts`, `src/release-admission.ts`, retention/deploy tools, focused tests, and minimal operator doctrine.
Verification: PASS — typecheck/build; abandonment + all retention 51/51; `npm run check` 650 tests / 646 pass / 0 fail / 4 skip; tracked candidate 51/51; diff check.
Self-review/fixes: Preserved the R2 exclusion/inventory/finalizer; added no second cleanup engine, public export, runtime schema/state/event, product result, timer, or GC.
Principle/contract impact: Private deployment policy now carries independently reversible abandonment `OFF|ON`, default `OFF`; resume remains enabled.
Decision needed: NO
Risk/blocker: NONE
Live effects: No install/deploy outside temporary tests, live abandonment/canary, real/historical run mutation, commit, push, or P4 work.

## Detail
- Added closed `lunacy-run-abandonment/v1` and
  `lunacy-run-abandon-receipt/v1` validators. Authority binds exact run,
  BLOCKED/STOPPED status, reason code, `activeWorkers="NONE"`, authority and
  terminal-state digests, and a closed Custody summary that refuses nonzero
  PENDING/CLAIMED while retaining UNKNOWN/malformed counts.
- `prepareRunAbandonment` copies canonical authority to the fixed private
  pathname, revalidates exact Seed/STATE, and is idempotent against a matching
  published abandonment receipt.
- Generalized the accepted R2 finalizer by disposition only: the same
  exclusion, Body inventory, quiescence, rename, marker, tombstone, cleanup
  cursor, receipt-before-unlink ordering, and recovery table publish
  `ABANDON-RECEIPT.json`. The abandonment marker binds the canonical
  authority digest as `acceptanceDigest` and fixes
  `resultIdentityDigest` to 64 zeroes.
- Doctor and deployment census admit valid abandoned authority/temp/marker/
  receipt states and reject accepted/abandoned collisions. Installed
  `--abandon --authority` is direct-invocation-proof, deployment-fingerprinted,
  policy-locked, and default OFF; rollback does not disable `--resume`.
- Focused tests cover closedness, both allowed statuses, missing/drifted/
  ambiguous authority, ACTIVE/PENDING/CLAIMED and active-worker/handle refusal,
  UNKNOWN/malformed Custody preservation, every finalizer fault cut, marker
  bindings, idempotence, accepted/abandoned separation, doctor state, and
  deployment OFF/ON compatibility.
