# P3 Hard Gate 02 — PASS

Decision: **PASS**

Parent acceptance evaluated the R3 observable after durable-Custody repair.

- Abandonment requires an explicit closed BLOCKED/STOPPED authority, bounded
  reason, no active workers, exact authority/state digests, and retained
  custody summary; it never claims an accepted product result.
- Current durable state is re-read at preparation, before rename, at frozen
  revalidation, and during published-receipt cleanup recovery. Actual ACTIVE,
  PENDING, or CLAIMED work refuses even when the authority claims zero.
- UNKNOWN and malformed Custody remain byte/inode/mode preserved and must be
  reflected by authority; no runtime schema/event or new ledger was added.
- The accepted R2 exclusion, inventory, quiescence, marker, receipt-before-
  unlink, tombstone, cursor, and cleanup engine are reused for ABANDONED.
- Accepted and abandoned receipts/markers/CLI policy are closed and distinct;
  abandonment defaults OFF while exact resume remains available.
- Worker broad gate passed: 653 tests, 649 pass, 0 fail, 4 platform skips.
- Worker tracked-candidate gate passed without `Lunacy/**`: 54/54 focused
  tests plus typecheck/build.
- Parent build and 34 focused authority, durable-state, fault, doctor, cleanup,
  and E2E tests passed; `git diff --check` passed.
- No live abandonment, install/deploy, real run mutation, commit, or push.

P3 is accepted. R4 remains a separate Git-backed one-run migration pilot.
