# P1/S3G — independent S3R4 read-only recheck

## Control Block

- **Scope:** final closed-barrier recheck of the S3R4 temporary-cleanup
  byte-binding repair only. Prior S3R2 exact check-to-syscall probes remain
  outside the accepted S3D threat model and were not reopened.
- **Authority:** read-only source/test/docs inspection and focused checks. Only
  this immutable report is written; no product, test, schema, docs, finalized
  report, or run-authority file was modified.
- **Result:** **PASS.** The former same-inode temporary-byte cleanup finding is
  closed, with no observed regression to lock cleanup or the S3D claim ceiling.

## Exact cleanup verification — PASS

`cleanupBoundFile()` now receives the canonical expected temporary bytes from
its publication caller (`src/continuation.ts:328-332,449-452`). Before unlink it
requires all of the following:

1. trusted, current parent directory and captured parent `{dev, ino}` identity
   (`src/continuation.ts:333-336`);
2. trusted temporary regular-file path and the captured temporary inode
   identity (`src/continuation.ts:336-338`);
3. no-follow open, matching current inode, exact expected byte length, bounded
   size, and byte-for-byte equality with the canonical expected bytes
   (`src/continuation.ts:338-345`); and
4. only then, lexical unlink followed by best-effort parent directory sync
   (`src/continuation.ts:346-348`).

Any absent/mismatched parent or temp, symlink/no-follow failure, read/size/byte
mismatch, or inspection/open error returns or is caught before unlink, leaving
the cleanup target untouched (`src/continuation.ts:333-348`). The caller passes
the exact `recordBytes(record)` string used for the temp write
(`src/continuation.ts:425,435,451`).

The deterministic same-inode in-place tamper test overwrites the temporary with
`TAMPERED-IN-PLACE` while retaining its inode, throws at `before-rename`, and
asserts the changed temp remains (`test/continuation.test.js:167-183`). It
passes. Replacement-inode and inspection-error no-op tests also pass
(`test/continuation.test.js:144-164,200-216`).

## Lock cleanup/regression check — PASS

Lock release remains bound to the captured parent identity and exact created
lock inode plus canonical owner bytes through `verifyBoundFile()` before
unlink; mismatch, absence, symlink, malformed/read, or inspection errors are
conservative no-ops (`src/continuation.ts:351-381`). Exclusive
`O_CREAT|O_EXCL|O_NOFOLLOW` acquisition, random nonce/PID canonical bytes,
fsync, bounded contention, and no age/mtime/liveness reclaim remain unchanged
(`src/continuation.ts:351-390`; tests `test/continuation.test.js:128-142,185-198,218-226`).

## S3D claim ceiling and focused result

The stable privately-owned namespace precondition and explicit nonclaim for
concurrent same-UID rename/replace/unlink/relink remain documented
(`docs/CONTINUATION.md:15-43`). No out-of-contract check-to-syscall mutation
probe was reopened. Node-only/no-runtime behavior and all prior S3R lease,
proof, wake, finalization-CAS, cancellation/UNKNOWN, disablement, and
authority-neutral paths remain unchanged by this narrow repair.

Checks run:

- `npm run typecheck -- --pretty false` — **PASS**.
- `node --test test/continuation.test.js test/codex-worker-proof.test.js` —
  **PASS (23/23)**, including same-inode tamper, replacement, and inspection
  no-op coverage.

**Control Block:** S3R4 **PASS**. Exact temporary parent/inode/size/byte
cleanup binding is verified; no further S3R4 work is pending.
