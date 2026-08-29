# P4 Gate Pack — fresh post-write-barrier scout

## Decision

**FINDINGS — do not accept P4 yet.** The focused recovery/workfront tests pass,
but the recovery-forensics route still has fail-open binding cases and the
required frozen golden corpus/deployment boundary is incomplete. These are
gate findings, not source changes.

## Exact findings (prioritized)

1. **[P1] A supplied wrong `commandDigest` does not fence effect evidence.**
   `inspectRecovery()` reports the outbox command as `MISMATCH` when the
   requested digest differs (`src/recovery-forensics.ts:220-249`), but
   `bindCommon()`/`bindTerminal()` (`:121-132`) bind effect records only to
   token/run/state/generation/namespace. A valid terminal record carrying the
   command's real digest is consequently returned `VALID`, `verified: true`,
   `binding: MATCH` while the requested digest is wrong. P4 requires an exact
   supplied digest and fail-closed evidence. Thread the requested digest through
   every evidence binder, or suppress verification unless command binding is
   `MATCH`.

2. **[P1] Terminal `status`/`outcome` semantic consistency is not validated.**
   `validateTerminalRecord()` checks enum/value shape only
   (`src/codex-effect-records.ts:210-226`); the forensic inspector does not
   enforce the supervisor's outcome mapping or result/report requirements
   (`src/recovery-forensics.ts:274-284`). A forged `status: PASS`,
   `outcome: process-failure`, `exitCode: 1` terminal with no result/report is
   accepted as `VALID`/verified when token and digest match. Reuse the
   `verifyTerminalEvidence()` invariants (`src/supervisor.ts:405-427`) or
   equivalent explicit checks and classify the record `MISMATCH`/
   `UNVERIFIABLE`.

3. **[P1] Required frozen golden capsule corpus is absent.**
   R4-A/R4-E in `docs/ROADMAP.md` require goldens for ACKED, UNKNOWN-with-
   launch, UNKNOWN-without-evidence, malformed evidence, and absent token, with
   frozen schema/golden digests. The checkout contains only
   `test/fixtures/recovery/absent.json`; no tests reference it, and it is not a
   valid committed-state capsule (generation/digests are zero, while the
   inspector rejects absent committed state). Add the corpus, manifest digests,
   and parity tests before certification.

4. **[P2] Normal terminal report path is not deterministic without policy.**
   `expectedReport` is only constructed when `policy` is supplied
   (`src/recovery-forensics.ts:266-270`). Without policy, any absolute path
   inside the run root is accepted. A normal-completion terminal whose result
   points at `root/wrong-report.md` is therefore `VALID`/verified, although
   production derives `root/phases/{phase}/{step}-worker-{attempt}.md` via
   `expectedReportPath()`. Derive and bind the expected report path from the
   command/run identity regardless of optional policy.

5. **[P2] Conflicting selector aliases are silently resolved by precedence.**
   `runRoot ?? kernelRoot`, `runId ?? expectedRunId`, and
   `launchToken ?? token` (`src/recovery-forensics.ts:220-224`; CLI parsing has
   the same overwrite behavior) accept contradictory explicit selectors. Reject
   conflicting aliases rather than silently choosing the first value; this is
   required for explicit run/root/token/digest selection.

6. **[P2] Oversized or symlink effect entries abort globally instead of yielding
   bounded per-record evidence.** `namespaceDigest()` throws on an untrusted
   symlink or oversized entry (`src/recovery-forensics.ts:145-168`) before the
   capsule is returned. Thus a symlinked `terminal.json` and a >256 KiB record
   produce a raw `FilesystemTrust`/ceiling exception, not stable
   `MATCH`/`MISMATCH`/`ABSENT`/`UNVERIFIABLE` evidence. Preserve the read-only
   fence, but map these target-entry failures to deterministic bounded evidence
   (and a stable route error where the namespace fence itself is invalid).

7. **[P2] Bounded-read and segmented-budget ceilings are not robust.**
   `readBoundedUtf8File()` stats, then performs unbounded `fs.readFile()`
   (`src/codex-effect-records.ts:137-157`), leaving a growth TOCTOU allocation
   window. `namespaceDigest()` materializes all names with `readdir()` before
   enforcing `MAX_NAMESPACE_ENTRIES`. Also, the inspector constructs the
   default 1000-event segmented store (`src/recovery-forensics.ts:239`), so a
   valid run committed with a 2000-event active ceiling throws “active suffix
   exceeds store bound”; `journalBudget.activeCeiling` is always reported as
   1000. Use descriptor/chunk-bounded reads, bounded directory iteration, and
   persist/read the actual segmented ceiling.

8. **[P2/integration] Managed deployment excludes the private route's module.**
   `tools/deploy-skill.mjs` filters `dist/recovery*` from managed inventory
   (around line 1416), while `dist/bridge-cli.js` dynamically imports
   `./recovery-forensics.js` for `inspect-recovery` (`src/bridge-cli.ts:238-239`).
   The installed managed wrapper therefore cannot resolve the route. Either
   deploy the private modules and update the inventory/golden, or explicitly
   keep the route checkout-local and remove/disable the managed launcher path;
   the current half-boundary is not a certifiable deployment contract.

## Named parent acceptance samples

- **P4-WRONG-DIGEST-EFFECT-FENCE:** valid terminal evidence plus a conflicting
  requested command digest; assert outbox and every effect are non-verified.
- **P4-TERMINAL-OUTCOME-STATUS:** `PASS + process-failure` (and approval /
  unresolved variants); assert mismatch/unverifiable, never authoritative.
- **P4-REPORT-PATH:** normal completion pointing to an in-root wrong report;
  assert deterministic expected path mismatch with policy omitted and supplied.
- **P4-GOLDEN-CORPUS:** freeze the five required capsules and schema/digest
  manifest; canonical encode/decode parity must be byte-identical.
- **P4-BOUNDED-ADVERSARIAL:** same-byte inode replacement, effect add/remove/
  replace, malformed/invalid UTF-8/oversize/symlink, CURRENT mutation during
  read, and segmented read-only; assert stable bounded output and zero writes.
- **P4-SEGMENTED-CEILING:** commit a valid segmented run with a non-default
  active ceiling; inspect read-only and assert no false budget rejection and
  truthful budget fields.
- **P4-MANAGED-BOUNDARY:** run the installed managed wrapper and either prove
  the private route is packaged or prove it is intentionally unavailable while
  package exports, Workfront, managed inventory, R1-R3, and operator fallback
  remain unchanged.

## Bounded verification

- `node --test test/recovery-forensics.test.js test/workfront.test.js` —
  **16/16 PASS**.
- Direct deterministic probes reproduced findings 1, 2, 4, 6, and 7 (wrong
  digest/effect accepted; invalid status/outcome accepted; wrong in-root report
  accepted; symlink/oversize throw; custom segmented ceiling rejected).
- No broad suites or mutating commands were run. No source/package/inventory
  files were changed; this immutable gate pack is the sole write.

## Gate condition

Repair findings 1–3 at minimum, then re-run the named parent samples and freeze
their output/schema digests. P4 can only be accepted after the deployment
boundary is made explicit and the complete read-only, race/ceiling, and
canonical-golden checks pass without mutation or dispatch/observe/ACK/repair/
quarantine/lock/cache/projection side effects.
