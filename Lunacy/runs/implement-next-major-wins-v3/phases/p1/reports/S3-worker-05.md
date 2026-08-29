# P1/S3R4 — exact temporary-byte cleanup binding

## Status

**FINAL — the S3G-worker-04 cleanup byte-binding finding is repaired.**
Temporary cleanup now unlinks only when all three current facts match the
publication that created it: trusted parent identity, captured temporary inode,
and exact canonical expected temporary bytes. Any mismatch, absence, symlink,
read/parse, or inspection error is a conservative no-op. Lock release retains
its prior exact parent/inode/owner-byte checks and no-reclamation policy.

## Exact changed files

- `src/continuation.ts`
  - Extended `cleanupBoundFile()` to receive the canonical bytes expected for
    the temporary and require exact size/byte equality in addition to parent and
    captured inode identity before unlink.
  - Kept all Node-only S3D publication, lock, lease, proof, CAS, wake, and
    authority-neutral behavior unchanged.
- `test/continuation.test.js`
  - Added deterministic same-inode in-place temp tamper at `before-rename`; the
    changed temp remains intact after cleanup instead of being unlinked.
  - Preserved replacement-inode and inspection-error cleanup tests, structural
    no-runtime assertion, old-or-new fault matrix, and prior S3R coverage.
- `docs/CONTINUATION.md`
  - Clarified that temporary cleanup also requires exact expected canonical
    bytes (in addition to parent/inode identity).
- `schemas/lunacy-continuation.schema.json`
  - Reviewed; no schema field/shape change was required for this filesystem-only
    repair.
- `Lunacy/runs/implement-next-major-wins-v3/phases/p1/reports/S3-worker-05.md`
  - This immutable report only.

No finalized report, run authority file, or unrelated worker change was edited.

## Checks and results

- `npm run typecheck -- --pretty false` — **PASS**.
- `npm run build -- --pretty false` — **PASS**.
- `node --test test/continuation.test.js test/codex-worker-proof.test.js` —
  **PASS (23/23)**, including same-inode byte tamper, replacement inode, and
  inspection-error no-op tests.
- `node --test test/orchestration.test.js` — **PASS (7/7)**.
- `node --test test/decision-inbox.test.js` — **PASS (6/6)**.
- `node --test test/r11d7-exact-legacy-deploy.test.js` — **PASS (6/6)**.
- `node --test test/r11e-release-envelope.test.js` — first run had one known
  unrelated release snapshot race; immediate rerun **PASS (7/7)**. The
  continuation changes do not touch release files.
- `node /tmp/check-b0-v2-evidence.mjs` — **PASS** (`aggregateBaselineFingerprint`
  `e7d5e61d2e92854729c3aea37fc46f6d9f2fe9eee4b37d62af627997bec64acd`, 33
  ordinary references, 24 canonical records, manual/release true).
- Owned-file `git diff --no-index --check` and structural no-external-runtime
  assertion — **PASS**.

## Control Block and residual risks

- **Result:** S3R4 complete; exact temporary parent/inode/byte cleanup gate is
  closed under the accepted S3D stable privately-owned namespace invariant.
- **Safety:** The same-inode `TAMPERED-IN-PLACE` case now leaves the temp path
  untouched, preserving evidence for operator recovery. Exact matching canonical
  bytes are the only cleanup authorization.
- **Claim ceiling:** Concurrent same-UID rename/replace/unlink/relink between a
  final identity/byte sample and a lexical unlink remains outside contract, as
  frozen by S3D; no hostile same-UID or general filesystem guarantee is made.
- **Authority:** Continuation remains a private sidecar/coordination seam;
  CURRENT, kernel/journal/outbox, lifecycle, inbox, and release retain ownership.

**Control Block:** FINAL. No S3R4 work remains pending; later P1 gates may consume
this report.
