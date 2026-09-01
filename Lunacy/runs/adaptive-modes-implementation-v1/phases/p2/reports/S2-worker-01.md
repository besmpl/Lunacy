# P2 S2 Worker 01 — isolated-child one-shot crash lattice

## Scope

Closed the P2 FINDINGS gap without changing production code. Added a hermetic crash/restart driver and parent lattice test for the accepted R2 implementation. No R3/R4 behavior, persisted schema, controller, ledger, install/activation, or real run was added or changed.

## Artifacts

- `test/p2-one-shot-crash-child.mjs`
  - owns runtime-generated Memory/File fixtures in temporary directories;
  - uses process exit `86` as the crash cut and a separately spawned verifier as the restart process;
  - records provider-entry, teardown-custody, and exact-token observation custody outside the kernel publication being cut;
  - instruments Memory publication boundaries before and after the applicable cuts.
- `test/p2-one-shot-crash-lattice.test.js`
  - explicitly enumerates the nine roadmap cuts and both sides of every cut;
  - executes File rows at generations 21, 22, and 23 (below, at, and above the sealed floor);
  - executes the applicable Memory rows at the same three generations.

## Crash lattice covered

Every File row is prepared in one child, cut in another child, and loaded/reconciled in a fresh verifier child:

1. claim CAS;
2. provider entry;
3. teardown publication;
4. `CLAIMED -> UNKNOWN` publication;
5. exact-token observation;
6. receipt publication;
7. terminal retirement;
8. processed-Yield publication;
9. File restart load.

The matrix is 9 cuts × 2 sides × 3 generations = 54 File crash/restart rows. The applicable Memory matrix records both sides of the first eight cuts at all three generations (48 boundary observations); File restart load is intentionally File-only.

## Assertions

- each launch token enters the provider at most once; the Memory poison identity enters exactly once;
- at/above-floor terminal recovery creates no new attempt epoch, reservation, or wave-counter churn;
- every terminal repeated `RESUME` is byte/state and generation stable;
- late receipts against terminal commands reject without changing durable state;
- below-floor rows preserve historical retry behavior: epoch 1 and a fresh command/reservation path;
- claimed commands without teardown proof remain claimed and do not re-enter the provider;
- teardown and observation custody survives the appropriate after-cut crash;
- before/after processed-Yield and restart-load publications remain restart-stable.

## Production result

The crash lattice exposed no in-scope production defect, so no production repair was made in S2.

## Verification

- `node --test test/p2-one-shot-crash-lattice.test.js test/p2-one-shot-lifecycle.test.js`
  - PASS: 7 tests, 0 failures (focused log: `/tmp/p2-s2-focused.log`).
- `npm run check`
  - recorded after the terminal run below.

## Terminal check result

- `npm run check` — PASS after the final code change:
  - typecheck PASS;
  - 697 tests, 693 passed, 0 failed, 4 skipped;
  - build PASS;
  - `npm pack --dry-run` PASS, 152 files.
  - log: `/tmp/p2-s2-npm-check-final.log`.
