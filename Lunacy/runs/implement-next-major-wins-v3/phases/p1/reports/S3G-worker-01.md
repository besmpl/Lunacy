# P1/S3G — durable continuation authority/recovery gate scout

## Result

**FINDINGS — S3 is not ready for the P1-B gate.** Existing kernel/CURRENT
authority and bounded sidecar publication are preserved, but five named recovery
or wake-binding risks violate the frozen S0 contract.

## Passing boundaries

- `src/continuation.ts:371-394,429-437` revalidates CURRENT, plan/policy/run,
  root identity, generation, and epochs; `327-345` uses no-follow descriptor
  identity checks.
- `535-539,541-639` invokes only `resumeRun`/the existing pump, has no
  decision-inbox path, maps UNKNOWN/cancellation/boundaries to attention, and
  never relaunches UNKNOWN. Missing sidecar is disabled (`453-460,654-665`);
  package-root export is unchanged.
- `347-369` gives temp fsync/rename/directory-fsync old-or-new publication.

## Actionable findings

1. **[P1] Expired lease resurrection.** `renew()` checks only the deadline; it
   never rejects an already elapsed `leaseExpiresAt` or applies stale-owner
   liveness fencing (`src/continuation.ts:494-506`). An old owner/nonce can
   extend a lease after expiry while a prior process may still run. Require a
   currently valid lease (or definitive dead-owner/generation recovery) before
   incrementing `leaseEpoch`; add a future-deadline/expired-lease negative test.

2. **[P1] Revocation lost after lifecycle.** A revoke during an in-flight wake
   publishes higher-generation `REVOKED`, then `finalizeWake()` accepts any
   `latest.generation >= checkpoint.generation` and rewrites it to `ATTENTION`
   (`src/continuation.ts:641-651`; revoke at `481-491`). Preserve any non-ACTIVE
   latest record and require exact generation/lease CAS; add a revoke-vs-
   lifecycle race (absent from `test/continuation.test.js:21-97`).

3. **[P1] Wake claims are unbound.** `receipt`, `terminal`, and `inbox` are bare
   allow-listed strings; `proof` verifies its own contract/terminal but does not
   compare phase/attempt/launch/command/terminal to this session's CURRENT/outbox
   (`src/continuation.ts:525-558,574-585`). A stale valid proof or fabricated
   `source: 'receipt'` can trigger `resumeRun` and dispatch current work. Require
   source-specific witnesses and exact current token/digest/epoch checks under
   the checkpoint lock (or narrow S3 to explicit-resume); add cross-run/stale
   source negatives.

4. **[P1] Sidecar parent TOCTOU.** `publishSidecar()` validates/creates its
   parent once, then opens/renames via the lexical path (`src/continuation.ts:
   347-369`). Swapping `.kernel`/a custom parent to a symlink after that check can
   redirect temp write/rename outside the run root. Bind/reopen the trusted
   parent or use physical-path plus identity fencing immediately before publish;
   add rename-to-symlink coverage.

5. **[P1] Unsafe lock stealing.** `acquireLock()` unlinks locks older than 60s
   (or `waitMs*4`) using mtime only, with no PID liveness, owner nonce, or
   generation CAS (`src/continuation.ts:309-323`). A paused owner/fsync can race
   a second writer and lose metadata updates. Do not reclaim a live lock; require
   lock identity plus definitive dead-owner/generation fencing or return bounded
   attention.

## Accepted limitations / nonclaims

Observation-only behavior, no scheduler/daemon/decision submission, bounded wakes,
UNKNOWN non-relaunch, and absent-sidecar disablement match `PLAN.md`, S0
(`Lunacy/runs/implement-next-major-wins-v3/phases/p0/reports/S0-worker-01.md:56-70`),
and `docs/CONTINUATION.md:1-23`. No value, availability, or hostile same-UID
security claim is made. The five findings are not covered by S3's reported 11/11
focused matrix.

## Control Block

- **Status:** FINDINGS — hold S3 and route one bounded repair.
- **Authority:** FileArtifactStore/CURRENT/kernel/pump remain authorities; this
  scout made no product/source/test/doc/release/git changes.
- **Evidence:** `src/continuation.ts` pointers above; tests at
  `test/continuation.test.js:21-97`; schema at `schemas/lunacy-continuation.schema.json`.
- **Claims:** no performance, token, provider, security, availability, production,
  release, or product-value benefit is claimed.
- **Next:** repair findings, rerun impacted focused checks, issue fresh S3G; S4 is
  blocked pending parent acceptance.
