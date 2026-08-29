# P1/S3R — durable continuation authority/recovery recheck

## Scope and result

**FINDINGS — four named repairs pass; sidecar parent publication remains a
lexical-path TOCTOU and can publish outside the trusted parent before reporting
`SIDECAR_FAULT`.** The writer barrier was closed. This report is the only write
made by this recheck; source, tests, schemas, docs, and finalized reports were
not changed.

The recheck used the frozen P0 contract (`phases/p0/reports/S0-worker-01.md`),
P1 steps, and the S3G/S3R reports, then inspected the exact current source and
focused continuation tests. No broad suite was rerun.

## Five accepted S3G findings

### 1. Renewal cannot resurrect expired/stale ownership — PASS

`ContinuationSession.renew()` loads the sidecar under the sidecar lock and
requires owner/nonce equality (`src/continuation.ts:538-545`). Before advancing
`leaseEpoch`, it rejects an elapsed lease or non-live/unknown owner process and
publishes bounded `STALE_LIVENESS`/`LEASE_EXPIRED` attention without changing the
lease epoch (`src/continuation.ts:546-561`). The focused tests cover both an
elapsed lease and a dead owner with a future lease, asserting attention and
unchanged epoch/expiry (`test/continuation.test.js:70-92`). No implicit dead-owner
takeover is present.

### 2. Wake finalization preserves revoke/non-ACTIVE races — PASS

`finalizeWake()` performs an exact owner nonce, lease epoch, revocation
generation, sidecar generation, and `ACTIVE` state comparison before publishing
post-lifecycle attention (`src/continuation.ts:744-760`). A revoke increments
generation/revocation generation and changes state to `REVOKED` while holding the
same sidecar lock (`src/continuation.ts:525-534`), so a concurrent finalizer
returns without rewriting it. The race test confirms the final bytes remain
`REVOKED`/`REVOKED` after an in-flight lifecycle returns
(`test/continuation.test.js:94-107`).

### 3. Wake labels and proof bindings are closed — PASS (with coverage note)

The source allow-list contains only `explicit-resume` and `proof`
(`src/continuation.ts:29-32,207-215`); `receipt`, `terminal`, and `inbox` return
`UNSUPPORTED_WAKE` before any lifecycle call (`test/continuation.test.js:59-68`).
Proof wakes require proof, contract, terminal, and launch inputs; the pure
worker-proof verifier runs first (`src/continuation.ts:581-593`). Under the
checkpoint lock, `proofCurrentBinding()` requires exact phase/attempt, launch
run/phase/attempt/authority/barrier/token/digest, PASS normal-completion
terminal, an ACKED current outbox command, current mode/active step, the exact
step id, and canonical outer receipt plus byte-identical immutable launch record
(`src/continuation.ts:602-635`). The checkpoint path invokes that predicate
before incrementing `wakeCount` or calling `resumeRun`
(`src/continuation.ts:665-685`). Cancellation, malformed proof, and UNKNOWN
non-relaunch paths are covered (`test/continuation.test.js:132-164`).

There is no positive valid-proof wake integration test in the inspected
continuation file; the binding predicate and verifier are nevertheless closed
by direct source inspection and the worker-proof negative corpus. This is a
test-coverage residual, not a demonstrated acceptance bypass.

### 4. Sidecar parent identity is **NOT** fully bound at write/rename — FINDING [P1]

`publishSidecar()` captures one parent identity and rechecks the lexical parent
before opening the temp file, after writing, immediately before rename, and after
rename (`src/continuation.ts:382-413`). The temp open and `fs.rename()` still use
`temporary`/`path` strings, not a descriptor-bound parent. A parent can therefore
be moved/substituted after the final `assertParent('before-rename')` check and
before `fs.rename()`.

A deterministic focused recheck monkey-patched `fs.promises.rename` to rename
`root/.kernel` to an external temporary directory and replace the lexical path
with a symlink immediately before the real rename. `session.revoke()` returned a
filesystem-trust error (the after-rename identity check fired), **but the
`REVOKED` continuation bytes were present in the moved external directory**:
old-or-new publication had escaped the trusted parent despite the failure. The
existing test only substitutes at the injected `before-rename` callback, before
the implementation's final identity assertion, and therefore does not exercise
this race (`test/continuation.test.js:109-120`).

Repair requires a publication operation that binds/reopens a trusted parent at
the actual write/rename boundary (or an equivalent descriptor/physical-path
fence that cannot be redirected between check and syscall), plus a test that
moves/substitutes the parent in that exact interval and asserts no external
sidecar is created. The same lexical-parent race also exists for lock creation
(`src/continuation.ts:314-322`), although the accepted S3G finding specifically
concerns sidecar publication.

### 5. Lock stealing and replacement-lock unlinking — PASS

`acquireLock()` uses exclusive no-follow creation and never reclaims an existing
lock based on mtime or elapsed wall time; bounded contention returns
`SIDECAR_CONFLICT` (`src/continuation.ts:314-360`). Release compares the acquired
inode identity with a fresh no-follow descriptor and leaves a changed/disappeared
path intact (`src/continuation.ts:323-347`). The focused stale-mtime test
confirms contention preserves the existing lock bytes and returns
`SIDECAR_CONFLICT` (`test/continuation.test.js:122-130`).

## Authority expansion check

**PASS.** Continuation remains a private sidecar around the existing
`FileArtifactStore`/`CURRENT` and lifecycle seams; its module explicitly states
that it does not own kernel/journal/outbox authority (`src/continuation.ts:14-17`,
`docs/CONTINUATION.md:3-7`). The wake path calls only existing `resumeRun`/
`BridgeDrivePump` (`src/continuation.ts:637-641,694-704`); there is no
`DecisionInbox` import, parent-decision submission, direct CURRENT/journal/outbox
write, scheduler, daemon, timer, discovery, or relaunch-on-UNKNOWN path. The
package root exports only the established public kernel (`src/index.ts:1-2`),
with continuation absent from the package exports map (`package.json:12-20`).

## Checks and residual risks

- `npm run build -- --pretty false` — **PASS**.
- `npm run typecheck -- --pretty false` — **PASS**.
- `node --test test/continuation.test.js` — **PASS 14/14**.
- Focused deterministic parent-move/rename interval probe — **REPRODUCED** the
  publication escape described in finding 4; no repository artifact was written.
- No broad test suite was run, per S3R scope. Existing S3R terminal claims and
  B0-v2 evidence were treated as cited inputs, not re-run authorities.

Residual risk is bounded to the unresolved lexical parent TOCTOU: a directory
move/symlink substitution exactly between the final identity check and rename
can leave a sidecar outside the trusted `.kernel` parent even though the caller
receives bounded failure. Until repaired and rechecked, S3R/P1-C must remain
blocked. No unattended-safety, hostile same-UID, performance, token, provider,
security, availability, production, release, or product-value claim is made.

## Control Block

- **Status:** FINDINGS — hold the S3R/P1-B gate for the parent publication TOCTOU
  repair and fresh recheck.
- **Authority:** no authority expansion observed; CURRENT/kernel, dispatch,
  inbox, and release seams remain owners.
- **Writes:** only this immutable report was created; finalized reports and all
  product/source/test/schema/doc/release files remain untouched.
- **Next:** repair `publishSidecar()` parent binding and add the exact
  move/substitution-at-rename negative test, then issue a fresh read-only S3R
  check. S4 remains blocked.
