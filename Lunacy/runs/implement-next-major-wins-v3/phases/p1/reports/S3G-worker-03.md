# P1/S3G — independent S3R2 read-only recheck

## Control Block

- **Scope:** fresh recheck of S3R2 only, against the closed-barrier tree, the
  accepted S3G findings, `src/continuation.ts`, `test/continuation.test.js`,
  `docs/CONTINUATION.md`, `docs/INSTALL.md`, `README.md`, and `package.json`.
- **Authority:** this report is evidence only. No source, test, schema, docs,
  finalized report, install artifact, or run authority was changed.
- **Claim boundary:** the checks below exercise deterministic local
  substitutions and ordinary missing/slow helper runtimes. They do not make a
  hostile same-UID, general filesystem-security, availability, production, or
  unattended-safety claim.
- **Result:** **FINDINGS — hold the S3/P1-B gate.** The descriptor-bound helper
  closes the demonstrated *pre-helper* replacement case, but the exact
  syscall-interval and lock-cleanup boundaries remain lexical races. The
  implementation also introduces an undocumented Python runtime dependency.

## Recheck of the accepted S3G findings

### 1. Renewal cannot resurrect expired or stale ownership — PASS

`renew()` first returns the existing non-`ACTIVE` record, rejects an elapsed
deadline, then checks owner liveness and `leaseExpiresAt` before incrementing
`leaseEpoch` (`src/continuation.ts:721-745`). Expired/dead or stale owners are
published as bounded `LEASE_EXPIRED`/`STALE_LIVENESS` attention with the old
lease epoch. Focused tests cover both an expired lease and dead-owner
future-lease (`test/continuation.test.js:70-92`).

### 2. Wake finalization preserves revoke/non-`ACTIVE` races — PASS

`finalizeWake()` acquires the sidecar lock and requires an exact owner nonce,
lease epoch, revocation generation, generation, and `ACTIVE` state before
publishing attention (`src/continuation.ts:927-943`). A newer revoke or any
non-`ACTIVE` latest record therefore wins. The in-flight revoke race and final
`REVOKED` bytes pass (`test/continuation.test.js:94-107`).

### 3. No bare wake and exact proof/effect binding — PASS

The source allow-list contains only `explicit-resume` and `proof`; bare
`receipt`, `terminal`, and `inbox` labels are rejected before lifecycle entry
(`src/continuation.ts:30-33,764-776,826-844`; test lines `59-68`). Proof
checkpointing requires exact current phase/attempt, run and all epoch fields,
launch token and command digest, an `ACKED` outbox command, an active step, a
canonical receipt envelope, and byte-identical immutable launch record while
the checkpoint lock is held (`src/continuation.ts:785-817,848-867`). No
proof-only label can invoke the lifecycle without that chain.

### 4. **FINDING [P1] — exact move between helper check and rename still
  publishes into a moved external directory**

The embedded helper's rename operation checks `bound()` and then immediately
uses `os.rename(..., src_dir_fd=fd, dst_dir_fd=fd)` (`src/continuation.ts:215-219`).
The descriptor prevents a replacement lexical `.kernel` from receiving the
rename when replacement happens *before* the helper starts, but a directory
descriptor follows the original directory inode when that inode is moved.
There is no lock/fence that makes the `bound()` check and `os.rename` one
uninterruptible path-identity operation.

The added test does not cover that interval: its injector moves/substitutes the
parent at `before-boundary`, immediately before `runAtHelper(...)` is spawned
(`src/continuation.ts:572-578`; `test/continuation.test.js:122-139`). A focused
temporary `python3` shim inserted `os.rename(parent, external)` after the
helper's `bound()` check and directly before its existing `os.rename` syscall.
The call failed later at the lexical post-rename assertion, but the moved
external directory already contained a new 779-byte `REVOKED` sidecar (the old
sidecar was 773 bytes) while the lexical `.kernel` path was absent. This is the
S3R2-prohibited escaped publication, not a claim about a general hostile host.

### 5. **FINDING [P1] — lock cleanup and post-create verification are still
  lexical and can unlink/write a replacement parent**

Lock creation itself uses the helper and descriptor-bound exclusive create
(`src/continuation.ts:461-482,222-248`), and no mtime/elapsed-time stealing is
present. However, immediately after helper success the code reopens the lock
through `fs.open(path, ...)` (`src/continuation.ts:483-487`), closes the parent
descriptor, then performs an identity check followed by lexical
`fs.unlink(path)` (`src/continuation.ts:488-512`). The check and unlink are not
one bound operation; `inspectTrustedPath` failures are swallowed, and no
parent descriptor is retained by the release closure.

Two deterministic focused probes demonstrate the consequences:

1. Replacing `.kernel` in a patched `fs.promises.unlink` immediately after the
   release check caused the replacement lock to disappear while the moved
   original lock remained (the unlink received the replacement path).
2. A temporary helper shim moved the parent and copied its kernel tree to a
   replacement immediately after descriptor-bound lock fsync but before the
   lexical `fs.open` above. `revoke()` then returned `REVOKED`, the replacement
   sidecar became `REVOKED`, the moved original remained `ACTIVE`, and the
   replacement lock was removed. Thus lock creation's bound syscall does not
   bind the subsequent critical section or cleanup to the same parent.

The existing mtime test only proves that an unproven existing lock is not
reclaimed (`test/continuation.test.js:141-149`); it does not cover these
post-create/release substitutions. Cleanup must remain descriptor-bound (or
otherwise atomically identity-fenced) before this finding is closed.

### 6. No mtime-based or unproven lock stealing — PASS (apart from finding 5)

`acquireLock()` retries code 17 until the bounded wait expires and returns
`SIDECAR_CONFLICT`; it never inspects mtime or unlinks a presumed stale lock
(`src/continuation.ts:461-482`). The focused test confirms lock bytes remain
after contention (`test/continuation.test.js:141-149`). The lexical cleanup
race above is a separate remaining issue.

## Runtime and lifecycle checks

- **Descriptor/child lifecycle:** `runAtHelper()` passes the open parent fd as
  child fd 3, closes stdin on every call, handles `error`/`close`, accepts only
  0/17/71, and kills/rejects after 5 seconds without lexical fallback
  (`src/continuation.ts:253-281`).
- **Unavailable/slow helper:** with `PATH` containing no `python3`, session
  creation rejected `spawn python3 ENOENT` and left no sidecar or lock; an
  existing session wake returned `attention: SIDECAR_FAULT` with unchanged
  sidecar bytes. A `/bin/sleep 10` helper returned the same bounded attention
  after approximately 5 seconds with unchanged bytes and no lock. Thus these
  failures are fail-closed, although creation exposes a raw rejection rather
  than a typed attention result.
- **Old-or-new normal publication:** the focused publication-fault test still
  leaves the prior canonical bytes (`test/continuation.test.js:161-170`), and
  all normal continuation/proof tests pass. The escaped moved-directory case
  above is the remaining exception at the required boundary.

## Python compatibility finding

`runAtHelper()` unconditionally spawns a host executable named `python3`
(`src/continuation.ts:150-160,253-281`). The repository's install contract
states “requires Node.js 22 or newer and has no runtime dependencies”
(`docs/INSTALL.md:1-9`), the package declares only a Node engine and no Python
dependency (`package.json:6-51`), and the README repeats Node 22+/no-runtime-
dependencies for the packed consumer artifact (`README.md:215-220`). The
continuation module is private and disabled by default, but its explicit route
is still unusable on an otherwise conforming installation without `python3`;
`dir_fd` support is also platform-dependent. The observed ENOENT/timeout
fail-closed behavior prevents unsafe fallback but does not satisfy the stated
Node-only/no-runtime-dependency compatibility contract. Either a Node-native
bound primitive or an explicitly documented, platform-gated Python
prerequisite is required; this is a portability/dependency regression, not a
preference about implementation language.

## Authority boundary

The continuation module remains private (`src/continuation.ts:16-18`), stores
feature-owned metadata, and invokes only the existing `resumeRun` lifecycle
(`src/continuation.ts:877-887`). It does not import or submit decision-inbox
events, mutate `CURRENT`/journal/outbox, add a scheduler/daemon, or expand
parent/worker authority. These boundaries PASS; the findings concern only
filesystem publication/cleanup and install compatibility.

## Focused checks

- `npm run typecheck -- --pretty false` — **PASS**.
- `node --test test/continuation.test.js test/codex-worker-proof.test.js` —
  **PASS (18/18)**.
- Deterministic local helper shims/monkeypatches for the exact rename interval,
  lock post-create substitution, lock cleanup replacement, missing `python3`,
  and 5-second timeout produced the observations recorded above.
- No broad test suite was rerun.

**Control Block:** S3R2 is **not certified**. Keep S4 blocked until the
descriptor-bound rename cannot publish to a moved external inode, lock
post-create/release operations are bound to the captured parent without
lexical unlink, and the Python dependency is either removed or made an
explicitly compatible install/platform contract.
