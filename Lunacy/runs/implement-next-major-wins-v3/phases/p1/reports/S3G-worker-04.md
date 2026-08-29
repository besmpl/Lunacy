# P1/S3G — independent S3R3 read-only recheck

## Control Block

- **Scope:** closed-barrier recheck of the accepted Sol/high S3D option-A
  invariant and `S3-worker-04`; S3R2 exact check-to-syscall attacks are
  explicitly out of contract and were not used as a gate.
- **Authority:** read-only inspection plus focused checks. Only this immutable
  report was written; source, tests, schemas, docs, finalized reports, and run
  authority were not edited.
- **Claim ceiling:** the namespace must remain stable, privately owned,
  non-shared, and free of concurrent same-UID rename/replace/unlink/relink
  during one operation. No stronger hostile same-UID or general filesystem
  guarantee is inferred.
- **Result:** **FINDING — one cleanup byte-binding gap remains.** All other
  S3R3/S3D requirements checked below pass.

## S3R3 filesystem contract

### Node-only runtime and stable namespace — PASS

`src/continuation.ts` contains no `python3`, child-process `spawn`, `AT_HELPER`,
`dir_fd`, or external-runtime fallback. The structural test asserts this
directly (`test/continuation.test.js:123-126`). The install contract remains
Node 22+ with no runtime dependencies (`docs/INSTALL.md:1-9`,
`package.json:6-51`, `README.md:215-220`). The continuation docs now state the
stable privately-owned namespace precondition and explicitly exclude concurrent
same-UID namespace mutation (`docs/CONTINUATION.md:13-31`).

### Publication sequence and old-or-new behavior — PASS

`publishSidecar()` samples the recorded run-root identity and current parent
identity before mutation and around each lexical boundary
(`src/continuation.ts:409-419,421-439`). It creates one same-parent random temp
with `O_CREAT|O_EXCL|O_NOFOLLOW`, captures its inode, writes canonical
`recordBytes`, fsyncs and closes it, verifies temp inode/bytes and parent/root
identity, then performs same-directory `fs.rename` and parent-directory fsync
(`src/continuation.ts:420-443`). The pre-boundary parent substitution fails
before rename and leaves the prior sidecar unchanged
(`test/continuation.test.js:110-121`); the injected publication fault preserves
valid old bytes (`test/continuation.test.js:220-230`). Exact check-to-syscall
same-UID mutation probes from S3G-worker-03 are not applicable under S3D and
were deliberately not rerun or treated as findings.

### Lock acquisition and cooperating-process exclusion — PASS

The fixed lock name is acquired by Node `O_CREAT|O_EXCL|O_NOFOLLOW`; one random
per-acquisition owner nonce, PID, and canonical timestamp are written and
fsynced. Parent identity, created lock inode, and exact owner bytes are
revalidated before returning the release closure (`src/continuation.ts:346-377`).
`EEXIST` only waits up to the bounded caller deadline; no age, mtime, lease, or
liveness reclamation is present (`src/continuation.ts:378-385`). The focused
contention/non-reclamation test confirms the existing lock remains intact
(`test/continuation.test.js:200-208`), and concurrent wake tests show one
cooperating owner proceeds while the other receives bounded conflict
(`test/continuation.test.js:40-58`).

### Conservative cleanup — **FINDING [P1]**

Lock release correctly checks current parent identity and
`verifyBoundFile()`'s exact lock inode and owner bytes before unlink; absence,
mismatch, symlink, or inspection error is caught as a no-op
(`src/continuation.ts:366-376`; tests `128-142`, `167-180`). Temporary cleanup
uses the same parent and inode checks and conservatively leaves the path on
inspection/mismatch errors (`src/continuation.ts:328-344`; tests `144-164`,
`182-198`).

However, `cleanupBoundFile()` does **not** compare the temporary's bytes to the
canonical bytes written by this publication. Its signature accepts only
`parentIdentity` and temporary inode (`src/continuation.ts:328-336`), and the
publish catch invokes it without expected bytes (`src/continuation.ts:444-447`).
A deterministic focused fault injector at `before-rename` overwrote the temp
file in place (preserving its inode) with `TAMPERED-IN-PLACE`, then threw a
publication fault. Cleanup removed that same-inode, changed-byte temp instead
of leaving it untouched. This violates S3D's required “exact parent/inode/bytes”
cleanup rule even though replacement-inode and inspection-error cases pass.

The repair must carry expected temp bytes (or an equivalent exact byte digest)
into cleanup and make any byte mismatch a no-op, matching the lock's existing
`verifyBoundFile()` behavior.

## Preserved S3R authority/recovery behavior — PASS

- Lease renewal refuses elapsed/dead ownership and does not advance
  `leaseEpoch` (`src/continuation.ts:574-600`; tests `71-93`).
- Final wake publication is exact owner/lease/revocation/generation CAS and
  preserves a newer `REVOKED`/non-`ACTIVE` record
  (`src/continuation.ts:780-796`; tests `95-108`).
- Wake labels remain closed to `explicit-resume` and proof; bare receipt,
  terminal, and inbox labels are rejected. Proofs bind exact current phase,
  attempt, run epochs, launch token/command digest, `ACKED` outbox receipt, and
  immutable launch bytes under the checkpoint lock
  (`src/continuation.ts:617-671,679-729`; tests `60-69,232-242`).
- Cancellation, `UNKNOWN`, deadline, binding drift, malformed proof, and
  absent-sidecar disablement remain bounded attention/no-relaunch paths
  (`src/continuation.ts:730-778,799-809`; tests `210-218,232-242`).
- The module remains private, sidecar-only, and authority-neutral; lifecycle
  wake calls only existing `resumeRun` and does not submit decisions or mutate
  CURRENT/journal/outbox (`src/continuation.ts:14-17,673-677,730-740`).

## Focused checks

- `npm run typecheck -- --pretty false` — **PASS**.
- `node --test test/continuation.test.js test/codex-worker-proof.test.js` —
  **PASS (22/22)**, including structural no-runtime, parent substitution,
  lock/temp replacement, inspection-error, non-reclamation, lease, CAS, wake,
  cancellation, and old-or-new cases.
- `git diff --no-index --check /dev/null Lunacy/runs/implement-next-major-wins-v3/phases/p1/reports/S3G-worker-04.md` — **PASS**.
- No broad suite and no out-of-contract exact syscall-interval mutation probe
  was run.

**Control Block:** S3R3 is **not yet certified** solely because temp cleanup
does not enforce exact bytes. Add the expected-byte (or digest) check to
`cleanupBoundFile()` and its call site, retain the S3D stable-namespace claim
ceiling, then rerun the focused continuation/proof checks.
