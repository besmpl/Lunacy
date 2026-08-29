# P1/S3R — durable continuation authority/recovery repairs

## Status

**FINAL — all five S3G findings are repaired and terminal-verified.**

## Findings repaired

- Lease renewal now advances `leaseEpoch` only while the existing lease is
  currently valid and its owner process is live. An elapsed or stale lease is
  converted to bounded `STALE_LIVENESS` or `LEASE_EXPIRED` attention without
  resurrecting the owner or changing the lease epoch; no implicit takeover or
  dead-owner claim was added.
- Wake finalization is an exact owner/lease/revocation/generation CAS. A revoke
  or other non-`ACTIVE` latest record wins the race and is preserved; lifecycle
  completion cannot rewrite it to `ATTENTION`. The revoke-vs-lifecycle race is
  covered by the continuation test matrix.
- Wake labels are closed to `explicit-resume` and proof-only wakes. Proof wakes
  require a certified terminal/launch witness, then (under the checkpoint lock)
  exact current run/phase/attempt/epoch, `ACKED` outbox, canonical receipt
  envelope, and byte-identical immutable launch binding. Bare receipt,
  terminal, and inbox labels return bounded attention and never invoke the
  lifecycle.
- Sidecar publication binds the trusted `.kernel` parent and rechecks its
  identity at every write/rename boundary. Parent substitution fails closed;
  lock release also rechecks lock inode identity and never unlinks a
  replacement lock.
- Lock acquisition no longer reclaims an existing lock from mtime or elapsed
  wall time. Contention returns bounded `SIDECAR_CONFLICT` attention while the
  unproven lock remains intact.

## Owned artifacts

- `src/continuation.ts`
- `schemas/lunacy-continuation.schema.json`
- `docs/CONTINUATION.md`
- `test/continuation.test.js`
- `Lunacy/runs/implement-next-major-wins-v3/phases/p1/reports/S3-worker-02.md`

Finalized S3-worker-01/S3G-worker-01 reports and all unrelated baseline edits
remain untouched.

## Verification

- `npm run typecheck -- --pretty false` — **PASS**.
- `npm run build -- --pretty false` — **PASS**.
- `node --test test/continuation.test.js test/codex-worker-proof.test.js` —
  **PASS 17/17** (including lease expiry/stale-owner liveness, revoke race, closed wake labels,
  parent substitution, lock non-reclamation, cancellation/UNKNOWN, and proof
  tamper paths).
- Relevant compatibility checks — **PASS**: lifecycle/orchestration 7/7,
  decision inbox 6/6, legacy v1/v2 2/2, release-envelope 7/7.
- `node /tmp/check-b0-v2-evidence.mjs` — **PASS**: aggregate fingerprint
  `e7d5e61d2e92854729c3aea37fc46f6d9f2fe9eee4b37d62af627997bec64acd`, 33
  ordinary references, 24 canonical records, zero hash-catalog keys,
  manual replay and release path-digest assertions true.
- `git diff --no-index --check` sweep over all owned source/schema/doc/test/report
  artifacts — **PASS**.
- Full `npm test` reached the complete 496-test matrix; **493 passed, 2
  skipped, 1 unrelated pre-existing R2 deployment count failure** at
  `test/r2-deployment.test.js:48` (`183 !== 175`). No continuation/proof or
  compatibility test failed.

## Control Block

- **Status:** FINAL — S3R product repairs are complete for parent recheck.
- **Authority:** continuation remains a private, explicit, observation-only
  sidecar around FileArtifactStore/CURRENT/kernel and the existing lifecycle;
  it owns no CURRENT/journal/outbox mutation, scheduler, daemon, discovery,
  inbox submission, decision, or relaunch authority.
- **Compatibility:** absent sidecar remains `DISABLED`; manual, lifecycle,
  fleet, inbox, legacy, and release paths retain their existing contracts and
  bytes.
- **Claims:** no unattended-safety, hostile same-UID, performance, token,
  provider, security, availability, production, release, or product-value
  claim is made. Filesystem identity and lock checks close deterministic
  substitution faults only.
- **Residual risks:** a crash after a wake checkpoint or an unproven live lock
  intentionally remains bounded attention/contended until an explicit operator
  action; proof wakes also require a complete existing effect chain and never
  create recovery evidence.
- **Next:** parent may perform the independent S3R recheck and decide the P1-C
  gate; this worker does not implement grants or decision submission.
