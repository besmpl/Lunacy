# P1/S3D — filesystem continuation resolution

## Decision

**PASS — select option A.** Remove the Python helper and restore a Node-only
publication/lock implementation with explicit, best-effort filesystem identity
fences. Scope concurrent same-UID namespace mutation of the run root, `.kernel`,
or continuation-owned child names outside the P1-B contract. This PASS selects
the repair direction; it does **not** certify the current S3R2 tree, which still
contains the helper and overclaims its syscall boundary.

Option B is not justified. A native `openat`/`renameat` wrapper can bind an
operation to an opened directory inode, but on POSIX/macOS it cannot also prove,
atomically with that rename, that the inode is still reachable at the original
lexical pathname. It therefore does not satisfy the disputed exact-interval
claim and would add a platform-specific native surface for no in-contract gain.
Option C is unnecessary because P0 froze an atomic private sidecar and explicitly
did not claim a sandbox against same-UID code; it did not require containment
against a concurrent actor moving the protected directory between a check and a
syscall.

## Exact achievable invariant

P1-B shall state and test this invariant, and no stronger one:

1. The selected run root and `.kernel` are existing, current-user-owned,
   non-shared, no-symlink surfaces. During one continuation filesystem operation,
   no other same-UID actor may rename, replace, unlink, or relink those surfaces,
   their ancestors, or the continuation sidecar/lock/temp names. This excludes
   accidental as well as hostile concurrent namespace mutation; it does not
   exclude crashes, I/O failures, pre-existing substitutions, or two cooperating
   continuation processes.
2. At entry and immediately before/after each lexical mutation, the implementation
   revalidates the canonical run binding and the captured `{dev, ino}` identity
   of the run root and sidecar parent with no-follow opens/checks. An already
   completed or observable move, replacement, or symlink substitution returns
   `SIDECAR_FAULT` before the next mutation. No fallback pathname is used.
3. With that stable namespace, publication creates one unpredictable same-parent
   temp using `O_CREAT|O_EXCL|O_NOFOLLOW`, records and rechecks its identity,
   writes canonical bytes, fsyncs the file, renames it over the sidecar, and
   fsyncs the parent. A crash exposes either the prior complete sidecar or the
   complete next sidecar. The sidecar remains a discardable projection and is
   never run authority.
4. Lock acquisition uses Node `O_CREAT|O_EXCL|O_NOFOLLOW` at the fixed lock name,
   writes/fsyncs a canonical owner nonce/PID record, and verifies parent, inode,
   and exact owner bytes. An existing lock is never reclaimed from age, lease
   time, or presumed liveness; contention returns `SIDECAR_CONFLICT`.
5. Normal lock release (and temp cleanup) attempts unlink only after the current
   parent, file inode, and exact owner/temp identity still match the object this
   operation created. Any absence, mismatch, symlink, parse/read error, or
   identity-check error leaves the path untouched. Under item 1 this means the
   lifecycle never unlinks a replacement path. No guarantee is claimed for a
   same-UID replacement injected after the final identity sample and before the
   lexical unlink; that is the same explicitly excluded namespace race, not a
   hidden exception.

Cooperating processes are still fenced: `O_EXCL` selects one owner and the loser
returns bounded conflict; a crashed owner leaves a lock and requires explicit
operator resolution rather than unsafe stealing. The exact owner/lease/
generation/revocation CAS and all wake/proof/CURRENT checks accepted in S3R stay
unchanged.

## Test judgment

The S3G-worker-03 helper shim that moves `.kernel` after `bound()` and before
`renameat`, and the monkeypatch that replaces a lock after its last identity
check but before `unlink`, **exceed the frozen threat model as refined above**.
Both require a same-UID namespace mutator deliberately scheduled inside the one
interval POSIX does not make conditional/atomic. They are useful demonstrations
of the claim ceiling, but must not gate P1-B.

The following remain ordinary, deterministic, gating faults:

- a parent/ancestor or sidecar already substituted before an operation;
- substitution injected before a declared revalidation/mutation boundary, which
  must fail before that mutation and must not write through the replacement;
- temp-write, fsync, rename, and directory-fsync failure, preserving valid
  old-or-new bytes;
- a pre-existing or replaced lock observed before cleanup, which must remain
  byte-identical and must not be reclaimed/unlinked;
- lock contention regardless of mtime, process pause, or elapsed lease;
- missing/slow Python on an otherwise conforming Node installation. This last
  case is an ordinary install-contract failure, not an adversarial test, and is
  resolved only by removing Python rather than documenting it as optional.

Tests must not use a helper shim or a hook whose asserted contract is “move after
the final identity check but before the syscall and still contain the write.” A
test may retain a pre-mutation substitution hook to prove the achievable
revalidation fence, but its name and assertions must not imply syscall-interval
atomicity.

## Required implementation changes

### Code

- In `src/continuation.ts`, remove `node:child_process`, `AT_HELPER`,
  `runAtHelper`, its timeout/error protocol, inherited-fd plumbing, and all
  Python/`dir_fd` paths.
- Implement publication only with Node `fs` primitives and the sequence in the
  invariant: trusted parent capture/revalidation; exclusive no-follow temp open;
  temp identity capture; write/sync/close; final parent/temp validation; same-
  directory rename; parent revalidation and directory sync. On failure, cleanup
  only an identity-matching temp and otherwise leave it.
- Implement lock create/write/sync/verification only with Node `fs`. Keep one
  per-acquisition random owner nonce in canonical lock bytes and capture the lock
  inode. Do not add stale-lock reclamation. Release only after parent, inode, and
  exact bytes match; mismatch or uncertainty is a no-op. Preserve bounded wait
  and `SIDECAR_CONFLICT` behavior.
- Retain the S3R lease-expiry, owner-liveness, revoke/finalize exact CAS, closed
  wake labels, proof/effect binding, cancellation, `UNKNOWN`, and disabled-by-
  absence logic unchanged. No schema field is needed for this filesystem repair.

### Tests

- Replace the descriptor/helper-specific exact-interval test with a Node-only
  parent-substitution-before-final-revalidation test and assert unchanged old
  sidecar bytes plus no write through the replacement path.
- Keep the old-or-new publication fault matrix and mtime/non-reclamation test.
- Add focused lock cleanup coverage: replace the acquired lock before release
  validation and prove the replacement inode/bytes remain; make every inspection
  failure leave the path intact. Add equivalent temp-cleanup identity coverage.
- Remove Python availability, timeout, shim, and helper-internal interval tests.
  Add a structural assertion (or review check) that continuation code contains no
  `python3`, `spawn`, `AT_HELPER`, or external-runtime fallback.
- Rerun the focused continuation/worker-proof tests, relevant build/typecheck,
  B0-v2 comparison, and the already required manual/lifecycle/inbox/legacy/
  release compatibility checks. No broad claim follows from those results.

### Documentation and contract

- Rewrite `docs/CONTINUATION.md:13-21` to remove “descriptor-bound,” POSIX `*at`,
  and exact-syscall fail-closed claims. Document the stable privately-owned
  namespace precondition, sampled identity fences, crash old-or-new semantics,
  conservative matching cleanup, no lock reclamation, and the explicit
  concurrent same-UID move/replace nonclaim.
- Keep `docs/INSTALL.md:3`, `README.md:215-220`, and `package.json` unchanged:
  Node 22+ and no runtime dependencies remain authoritative. Do not add a Python
  prerequisite or a native executable/addon.
- Parent acceptance must record that this decision supersedes only the derived
  S3R2 exact-interval requirement in `phases/p1/STEPS.md:62-64` and the matching
  S3G-worker-03 gate condition. Finalized reports remain immutable. The P0
  old-or-new sidecar, authority, compatibility, and no-hostile-same-UID boundaries
  are not weakened.

## Compatibility and authority impact

- Canonical `lunacy-continuation/v1` bytes/schema, package-root exports, CLI and
  defaults, manual lifecycle/inbox/fleet behavior, CURRENT/journal/outbox bytes,
  and disablement-by-absence remain unchanged.
- Removing Python restores the frozen Node-only/no-runtime-dependency install
  contract. It removes a private implementation detail and false portability
  dependency; it creates no public API change.
- The only contract change is explicit scoping of concurrent same-UID namespace
  mutation. If future requirements demand containment against that actor, P1-B
  must be disabled (option C) until an operator-owned exclusion/trust primitive
  outside the mutable namespace is separately authorized; another check-plus-
  syscall helper is not sufficient.
- FileArtifactStore/CURRENT, kernel, dispatch, inbox, and release seams retain
  authority. The continuation record and its lock remain private coordination
  metadata and cannot authorize a transition or decision.

## Control Block

- **Result:** PASS — option A is the simplest correct resolution; current code
  requires the bounded changes above before the P1-B gate can pass.
- **Evidence inspected:** frozen P0 decision/report/gate; P1 STEPS; S3/S3R/S3R2
  implementation and all three read-only rechecks; exact continuation source and
  focused tests; continuation/install docs, README, package manifest, and shared
  filesystem helpers.
- **Writes:** this immutable report only.
- **Checks:** read-only source/contract comparison; no product tests or broad
  suites were run for this design judgment.
- **Claims:** no security, performance, availability, production, release, or
  product-value claim is made.
