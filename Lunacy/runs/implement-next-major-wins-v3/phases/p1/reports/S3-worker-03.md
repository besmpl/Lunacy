# P1/S3R2 — syscall-interval parent publication repair

## Status

**FINAL — the S3R2 lexical-parent publication TOCTOU is repaired for sidecar
publication and lock creation.** The implementation keeps one trusted `.kernel`
directory descriptor open across each child-file operation and uses a small
POSIX `*at` helper (`os.open(..., dir_fd=3)`, `os.rename(...,
src_dir_fd=3, dst_dir_fd=3)`, and `os.unlink(..., dir_fd=3)`). The helper checks
both the inherited descriptor identity and a no-follow lexical parent identity
immediately before the relevant syscall. A moved or substituted lexical parent
therefore returns bounded `SIDECAR_FAULT` before the destination sidecar is
published through the replacement path. Lock creation uses the same descriptor
boundary and retains the existing no-steal/unlink identity fence.

No hostile same-UID, general filesystem-security, availability, or production
claim is made. The helper is intentionally private to the continuation seam;
no authority owner or lifecycle path changed.

## Exact changed files

- `src/continuation.ts`
  - Added bounded descriptor-bound child operation helper and parent descriptor
    binding.
  - Replaced lexical temp creation/rename/unlink in `publishSidecar()` with
    parent-descriptor `*at` operations and an exact `before-boundary` fault hook.
  - Replaced lexical lock creation with descriptor-bound exclusive creation;
    existing lock identity-safe release and no-mtime-reclaim behavior remains.
- `test/continuation.test.js`
  - Added deterministic exact-publication-interval move/symlink substitution
    test; external moved `continuation.json` remains byte-identical to the old
    record and no replacement record is created.
- `docs/CONTINUATION.md`
  - Documented descriptor-bound publication/lock boundaries and fail-closed
    parent substitution behavior.
- `schemas/lunacy-continuation.schema.json`
  - Reviewed for S3R2; no schema shape change was required (S3R constraints
    remain in force).
- `Lunacy/runs/implement-next-major-wins-v3/phases/p1/reports/S3-worker-03.md`
  - This immutable report only.

Finalized reports, plan/decision/state/steps authority files, and unrelated
worker changes were not edited.

## Checks and results

- `npm run typecheck -- --pretty false` — **PASS**.
- `npm run build -- --pretty false` — **PASS**.
- `node --test test/continuation.test.js test/codex-worker-proof.test.js` —
  **PASS (18/18)**, including the exact-interval negative test.
- `node --test test/orchestration.test.js` — **PASS (7/7)**.
- `node --test test/decision-inbox.test.js` — **PASS (6/6)**.
- `node --test test/r11d7-exact-legacy-deploy.test.js` — **PASS (6/6)**.
- `node --test test/r11e-release-envelope.test.js` — **PASS (7/7)**.
- `node /tmp/check-b0-v2-evidence.mjs` — **PASS** (`aggregateBaselineFingerprint`
  `e7d5e61d2e92854729c3aea37fc46f6d9f2fe9eee4b37d62af627997bec64acd`, 33
  ordinary references, 24 canonical records, manual/release true).
- Owned-file `git diff --no-index --check` sweep — **PASS**.

## Boundary proof

The new test arms the fault injector at `before-boundary`, then renames the
trusted `.kernel` away and substitutes a symlink immediately before the
helper's descriptor-bound rename. The helper's no-follow lexical check returns
code 71; cleanup removes only the temp through the still-bound descriptor;
`continuation.json` in the moved directory remains the old ACTIVE bytes. The
same helper path is used for lock creation, so lock acquisition cannot create a
new lock through a substituted lexical parent. Normal publication remains
write/fsync, rename, directory-fsync and therefore preserves old-or-new crash
semantics.

## Residual risks / control block

- The descriptor-bound primitive is implemented through the host `python3`
runtime because Node 22 does not expose portable `openat`/`renameat` APIs on
macOS. If that runtime is unavailable, continuation publication fails closed as
bounded sidecar attention rather than falling back to lexical writes.
- As with POSIX directory operations generally, a move-and-restore completed
before the helper's final identity sample cannot be historically detected; no
hostile same-UID claim is made.
- The helper has a 5-second bounded timeout; timeout/failure never falls back to
an unbound pathname operation.

**Control Block:** S3R2 is complete for the owned P1-B surfaces. The route
remains disabled-by-default, sidecar-only, and authority-neutral. S4/S5 may
consume this result after their own gates; no further S3R2 work is pending.
