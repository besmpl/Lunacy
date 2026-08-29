# P1/S3R3 — Node-only stable-namespace continuation repair

## Status

**FINAL — accepted S3D option A is implemented.** All Python, child-process,
`*at`, inherited-descriptor, helper, and timeout plumbing from S3R2 has been
removed. Continuation now uses Node 22+ filesystem primitives only and keeps
its documented install contract with no runtime dependency.

The achievable invariant is explicit: continuation requires a stable,
privately-owned, non-shared, no-symlink run-root/`.kernel` namespace for the
operation. Within that precondition, sampled root/parent identity fences are
checked at entry and around each lexical mutation. Concurrent same-UID
rename/replace/unlink/relink between a final sample and a lexical syscall is
outside contract; no hostile same-UID containment claim is made.

## Exact changes

- `src/continuation.ts`
  - Removed `node:child_process`, Python/AT helper, inherited-FD plumbing,
    and all external-runtime fallback behavior.
  - Added Node-only `verifyBoundFile()` and conservative identity-matching
    `cleanupBoundFile()`; inspection, mismatch, absence, symlink, or read error
    leaves cleanup targets untouched.
  - Reworked `publishSidecar()` to sample run-root/parent identity, create one
    random same-parent `O_CREAT|O_EXCL|O_NOFOLLOW` temp, capture/recheck its
    inode and canonical bytes after fsync/close, perform same-directory rename,
    then parent validation and directory fsync. Existing old-or-new semantics
    remain intact under the stable namespace contract.
  - Reworked lock acquisition to exclusive no-follow create, canonical
    per-acquisition owner nonce/PID bytes, fsync, exact parent/inode/byte
    verification, and no age/liveness reclamation. Release is a no-op on any
    parent/inode/byte mismatch, absence, or inspection uncertainty.
  - Preserved all S3R lease-expiry/liveness, proof/effect binding, wake-label,
    revoke/finalize CAS, cancellation, UNKNOWN, and disabled-by-absence logic.
- `test/continuation.test.js`
  - Replaced S3R2 helper/interval test with a structural Node-only assertion and
    a pre-boundary parent-substitution test.
  - Added deterministic replacement-lock inode/bytes, replacement-temp
    identity-cleanup, lock inspection-error no-op, and temp inspection-error
    no-op coverage; retained mtime/non-reclamation and old-or-new fault tests.
- `docs/CONTINUATION.md`
  - Documents the stable privately-owned namespace precondition, sampled
    identity fences, Node temp/fsync/rename/parent-fsync sequence, conservative
    cleanup, no lock reclamation, and explicit same-UID claim ceiling.
- `schemas/lunacy-continuation.schema.json`
  - Reviewed; no schema field/shape change is needed for this filesystem-only
    repair.
- `Lunacy/runs/implement-next-major-wins-v3/phases/p1/reports/S3-worker-04.md`
  - This immutable report only.

Finalized S3/S3R/S3R2/S3D reports and run authority files were not edited;
unrelated accepted dirty work was preserved.

## Checks and results

- `npm run typecheck -- --pretty false` — **PASS**.
- `npm run build -- --pretty false` — **PASS**.
- `node --test test/continuation.test.js test/codex-worker-proof.test.js` —
  **PASS (22/22)**.
- `node --test test/orchestration.test.js` — **PASS (7/7)**.
- `node --test test/decision-inbox.test.js` — **PASS (6/6)**.
- `node --test test/r11d7-exact-legacy-deploy.test.js` — **PASS (6/6)**.
- `node --test test/r11e-release-envelope.test.js` — **PASS (7/7)**.
- `node /tmp/check-b0-v2-evidence.mjs` — **PASS** (`aggregateBaselineFingerprint`
  `e7d5e61d2e92854729c3aea37fc46f6d9f2fe9eee4b37d62af627997bec64acd`, 33
  ordinary references, 24 canonical records, manual/release true).
- Owned-file `git diff --no-index --check` plus structural no-external-runtime
  assertion — **PASS**.

## Control Block and residual risks

- **Result:** S3R3 complete for owned P1-B surfaces; the S3D stable-namespace
  invariant is the only filesystem claim made.
- **Authority:** continuation remains a private sidecar/coordination seam;
  CURRENT, kernel/journal/outbox, lifecycle, inbox, and release seams retain
  ownership. No public API or schema change.
- **Claim ceiling:** a same-UID namespace mutation deliberately scheduled
  after the last identity sample and before a lexical syscall is excluded by
  contract (the POSIX/macOS check-plus-syscall interval is not atomically
  conditional). If future requirements demand containment against that actor,
  disable this route pending a separately authorized operator-owned primitive;
  do not add another helper shim.
- **No stale takeover:** crashes leave lock files for explicit operator
  resolution; no mtime/lease/liveness stealing is attempted.

**Control Block:** FINAL. S4/S5 may consume this report after their own gates;
no S3R3 work remains pending.
