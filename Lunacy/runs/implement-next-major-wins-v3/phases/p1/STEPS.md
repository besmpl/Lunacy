# P1 Steps — proof-gated durable continuation

All product-writing steps are serialized. S2-S4 remain blocked until their predecessor gate evidence is accepted.

## S1 — freeze B0 comparison authorities
- Status: FINDINGS — terminal evidence is otherwise green, but its manifest contains unnecessary per-file test/fixture hash catalogs contrary to Lunacy evidence policy; supersede via S1R before use.
- Read-only repository/evidence work. Freeze one aggregate working-baseline identity and bounded exact comparison evidence for: manual inbox decision event/yield bytes; local launch/receipt/terminal and lifecycle bytes; legacy/v1/v2 load/replay behavior; accepted release-envelope path-digest behavior; exact fixtures, commands, environment, and fault schedules.
- Reuse existing deterministic tests/fixtures where possible; do not invent a second fixture framework or record raw secrets/argv/process payloads.
- Make no product/source/test/doc/release/install/git changes. Own only `evidence/b0/**` and `reports/S1-worker-01.md`.
- Verification: evidence self-checks, canonical/aggregate validation, command result summaries, and `git diff --check` for owned artifacts.
- Report: `reports/S1-worker-01.md`.

## S1R — supersede B0 with an aggregate-only authority manifest
- Status: PASS
- Leave finalized S1 report/evidence untouched. Create `evidence/b0-v2/**` and `reports/S1-worker-02.md` as the sole authoritative replacement.
- Preserve required exact canonical comparison bytes, command/result summaries, environment, fault schedules, and accepted release evidence, but replace per-file test/fixture hash catalogs with one aggregate baseline fingerprint and ordinary path references.
- Reuse S1's valid captured logs/results where their integrity is covered by the aggregate replacement; rerun only the bounded self-check/diff check needed to prove b0-v2 is complete and contains no hash catalog.
- No product/source/test/doc/release/install/git changes.

## S2 — P1-A closed check contract and worker-proof verifier
- Status: FINDINGS — core contract/tests are green, but parent review found unrequested compatibility aliases/overloaded verifier shapes and optional diff/artifact digests that can certify without being declared in the parent evidence set.
- Add private closed canonical `lunacy-check-contract/v1` and `lunacy-worker-proof/v1` codecs, ceilings, negative corpus, and pure `CERTIFIED`/stable `ATTENTION:<code>` verifier beside existing effect/host records.
- Parent declaration fixes check ids/results/evidence before launch; worker cannot add, remove, rename, waive, or self-certify checks. No session/run/inbox mutation.
- Preserve existing terminal/worker envelope, package root, CLI/default bytes, and all manual paths.
- Terminal verification: focused codec/host/effect tests, negative/tamper corpus, relevant typecheck/build, compatibility bytes, and diff check.
- Report: `reports/S2-worker-01.md`.

## S2R — simplify P1-A API and close optional-evidence binding
- Status: PASS
- Remove the unrequested `src/worker-proof.ts` compatibility spelling and unused alias exports; retain one exact private API name per operation and one exact `verifyWorkerProof(contract, proof, options)` call shape.
- Remove redundant validation passes/branches where one sorted-unique check already proves the invariant.
- Ensure every optional diff/artifact digest that remains in a proof is bound to the parent-declared required-evidence set and cannot certify as undeclared decoration; add focused negative proof. Prefer reuse of required evidence rather than another parallel contract field.
- Preserve P1-A schemas/bytes only where still authoritative; update schemas/docs/tests coherently. No session/run/inbox/public/default/release changes.
- Full focused terminal verification, B0-v2 compatibility, relevant build/typecheck, diff check, and self-review.
- Report: `reports/S2-worker-02.md`.

## S3 — P1-B durable observation with decisions disabled
- Status: FINAL — pending S3G/parent gate
- Implement private explicit File-root continuation session/sidecar with verified run binding, atomic old-or-new publication, owner/lease epoch, deadline, max wakes, revocation, and closed wake sources.
- Restart revalidates CURRENT and bindings then recreates the existing pump. Drift, lease loss, cancellation, malformed proof, or `UNKNOWN` stops at bounded attention. No daemon/timer/discovery/scheduler and no inbox submission.
- Preserve manual/lifecycle/fleet behavior; absence disables the route without run rewrite.
- Terminal verification: restart/race/crash/sidecar fault matrix, manual compatibility, cancellation/UNKNOWN proof, relevant build/typecheck, and diff check.
- Report: `reports/S3-worker-01.md`.

## S3G — read-only P1-B authority/recovery gate scout
- Status: FINDINGS — expired lease renewal, revoke/finalize race, unbound wake labels/proof binding, sidecar parent TOCTOU, and mtime-only lock stealing.
- Read only the exact S3 diff/source/tests and P0/P1-B contracts. Compress whether session/path/lock/publication/restart/cancellation/UNKNOWN/disablement behavior matches the frozen authority boundary and simplest design.
- Named risks: a sidecar becoming authority, unbound wake sources, unsafe lock/owner recovery, relaunch after UNKNOWN, path escape/symlink substitution, post-lifecycle checkpoint ambiguity, and avoidable duplicate machinery.
- Do not rerun broad suites and do not change product code. Write only `reports/S3G-worker-01.md` with exact source/test pointers and PASS/FINDINGS.

## S3R — repair P1-B authority and recovery findings
- Status: FINAL — recheck found one remaining parent-publication TOCTOU
- Require a currently valid lease for renewal; expired/stale ownership returns bounded attention unless a separately explicit proven-dead recovery exists.
- Preserve non-ACTIVE/revoked latest state and require exact generation/lease CAS when finalizing a wake; add revoke-vs-lifecycle race proof.
- Remove bare receipt/terminal/inbox wake labels. Support explicit-resume and, only if exact current run/outbox/effect/phase/attempt bindings are proven under the checkpoint fence, proof publication. Otherwise return bounded attention.
- Bind and revalidate the sidecar parent identity at write/rename boundaries; fail closed on substitution. Remove mtime-only lock reclamation and never steal an unproven live/stale lock.
- Keep no same-UID hostile-host claim; nevertheless close deterministic path/lock substitution faults. Update schema/docs/tests, run impacted and compatibility checks, B0-v2, build/typecheck, diff check.
- Report: `reports/S3-worker-02.md`.

## S3R2 — repair syscall-interval parent publication TOCTOU
- Status: HISTORICAL — S3G-worker-03 found remaining races and Python install-contract regression; S3D supersedes its impossible exact-interval requirement
- Replace lexical temp/open/rename publication with the simplest local primitive that remains bound to the captured trusted parent at the actual publication boundary. A moved/substituted lexical `.kernel` path must not receive or redirect sidecar publication, and no external moved directory may receive new sidecar bytes before failure.
- Apply the same actual-boundary rule to lock creation if it shares the demonstrated lexical-parent race; do not add hostile same-UID or general filesystem-security claims.
- Add a deterministic test that moves/substitutes the parent exactly inside the rename/publication interval and proves zero escaped sidecar publication, while preserving old-or-new crash semantics and all prior S3R behavior.
- Run focused continuation/proof checks, relevant typecheck/build, B0-v2, and owned diff/self-review only. Report: `reports/S3-worker-03.md`.

## S3D — consequential filesystem invariant decision
- Status: PASS
- Exact Sol/high decision `reports/S3D-worker-01.md` selects Node-only option A: stable privately owned namespace precondition, sampled identity fences, conservative identity-matching cleanup, no stale-lock reclaim, and explicit no concurrent same-UID mutation claim. Exact check-to-syscall adversarial mutation no longer gates because POSIX/macOS cannot atomically prove lexical reachability with the mutation and P0 excluded that actor.

## S3R3 — implement accepted Node-only stable-namespace invariant
- Status: FINAL — recheck found one exact temp-byte cleanup gap
- Remove all Python/child-process/helper/descriptor plumbing and restore the documented Node 22+/no-runtime-dependency contract.
- Publication: capture/revalidate root/parent identity, exclusive no-follow unpredictable same-parent temp, bind exact temp identity, canonical write/fsync/close, final parent/temp validation, same-directory rename, parent validation/fsync; identity-matching temp cleanup only.
- Lock: exclusive no-follow create, canonical exact owner nonce/PID bytes, fsync and exact parent/inode/bytes verification; no age/liveness reclaim. Release only after parent/inode/exact-byte match; mismatch/absence/inspection error is a no-op.
- Replace exact-interval/helper tests with pre-boundary substitution, replacement lock/temp cleanup, inspection-error no-op, structural no-external-runtime check. Preserve all S3R lease/proof/CAS/wake behavior.
- Update docs to the exact stable-namespace precondition and claim ceiling. Focused continuation/proof, typecheck/build, B0-v2, compatibility checks, owned diff/self-review. Report: `reports/S3-worker-04.md`.

## S3R4 — exact temp-byte cleanup binding
- Status: PASS — exact read-only recheck `reports/S3G-worker-05.md`; accepted by `hard-gate-p1b-handoff-01.md`
- Carry the exact canonical temp bytes written by this publication into conservative cleanup and unlink only when parent identity, inode identity, and exact bytes all still match. Any mismatch/absence/inspection error is a no-op.
- Add the deterministic same-inode in-place temp tamper negative test. Run only focused continuation/proof, typecheck/build, B0-v2, relevant compatibility, and owned diff/self-review. Report: `reports/S3-worker-05.md`.

## S4 — P1-C one existing-token PASS grant
- Status: NOT STARTED — intentionally held for coordination handoff after accepted P1-B gate
- Add one explicit parent grant bound to an exact current READY unconsumed GATE inbox snapshot, exact PASS, deterministic event id, proof predicate, plan/policy/run binding, one-use epoch, expiry, and revocation.
- On CERTIFIED call existing `submitParentDecision` exactly once. Commit/replay/owner races converge through existing inbox/kernel CAS. Every other value/token/state/result is terminal attention; no FINDINGS/adoption/promotion/prediction/relaunch/loop.
- Terminal verification: forged/stale/wrong-attempt proofs, mutated plan, nonexistent/consumed token, two owners, revocation, crash before/after commit, processed replay, disablement, wake exhaustion, and `UNKNOWN` non-relaunch.
- Report: `reports/S4-worker-01.md`.

## S5 — P1 named adversary and phase gate pack
- Status: BLOCKED on S4 terminal barrier
- Read-only adversary attacks the self-certifying-worker, stale/replayed proof/grant, duplicate owner, commit-uncertainty, and authority-expansion hypotheses against the integrated P1 implementation.
- It may write only `reports/S5-worker-01.md`; findings become a fresh repair step rather than editing finalized reports.
