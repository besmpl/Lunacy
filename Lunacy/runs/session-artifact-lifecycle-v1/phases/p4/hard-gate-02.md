# P4 Hard Gate 02 — PASS / Final Integrated Gate

Decision: **PASS**

Parent acceptance evaluated the complete R4 observable and the integrated
R1-R4 source tree, not the worker PASS.

## R4

- The audit is read-only and reports the fixed legacy allowlist, Git/source
  eligibility, counts, custody, current/HEAD references, exact refusals, and
  every normative recovery row.
- Current and immutable-HEAD reference guards scan bounded bytes regardless of
  extension or UTF-8 validity. Missing, special, oversized, unreadable,
  unstable, or malformed candidates refuse; the reproduced binary-reference
  bypass is closed.
- Copy publication retains all originals, verifies exact identities/digests,
  fsyncs the destination, atomically publishes Body, and writes the closed
  migration marker through a digest-bound staged/file-fsync/no-clobber-link/
  parent-fsync transaction. Partial owned stages resume; foreign collisions are
  preserved and refuse.
- Normal R2 acceptance must use an embedded product manifest and publish a
  matching durable receipt before any original unlink. Reference clearance and
  exact source identity are revalidated before each unlink; the marker is last.
- Temporary Git fixtures cover copy/marker/source-unlink crash prefixes,
  normative state rows, collisions/drift/absence, and `git restore` plus exact
  digest rollback. No live corpus was migrated.

## Integrated evidence

- Worker focused gates passed: migration 31/31; integrated migration/retention/
  abandonment 85/85; retention/restore 46/46; deployment 8/8 plus census.
- Worker broad `npm run check` passed: 685 tests, 681 pass, 0 fail, 4 platform
  skips; typecheck, build, and package dry-run passed.
- Worker Git-history-preserving tracked-candidate checkout excluded `Lunacy/**`
  and passed the same broad gate.
- Parent build plus 41 focused migration, marker/reference, cleanup-fault, and
  accepted-run E2E tests passed; `git diff --check` passed.
- Public runtime/event/state bytes and `src/index.ts` export surface are
  unchanged by retention modules. R1 doctor, R2 accepted lifecycle, and R3
  explicit abandonment remain independently reversible.
- Unrelated preexisting user work was preserved. No install/deploy, live
  acceptance/abandonment/migration, commit, push, reset, or clean occurred.

R4 and the final source implementation pass. Live rollout remains blocked by
the architecture's measurement prerequisite and separate operator authority.
