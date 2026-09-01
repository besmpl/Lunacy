# P2 Hard Gate 01 — FINDINGS

Decision: **FINDINGS**

The R2 candidate is not yet accepted. Parent inspection confirmed one bounded
architecture mismatch in the owned Body-inventory seam:

- `src/run-retention-platform.ts` serializes file tuples by joining them with
  `\n`. The sealed architecture requires lexicographically sorted,
  NUL-delimited tuples. Body path validation permits newline characters, so the
  current representation is also not an unambiguous canonical encoding for the
  admitted path set.

Required repair:

1. Serialize the existing path/mode/size/content-digest fields with an
   unambiguous NUL delimiter between every field and tuple, without changing
   the receipt/state schemas or adding a new record.
2. Add a focused test that calculates the specified digest independently and
   includes a valid filename containing a newline, proving the digest contract
   rather than merely its determinism.
3. Re-run the focused inventory/R2 gate, typecheck/build, broad `npm run check`,
   tracked-candidate gate, and `git diff --check`.

The planned read-only adversary was attempted twice with Sol/high. Both attempts
were rejected by the host content classifier before any repository judgment;
no adversary PASS is claimed. Parent review therefore owns this gate.

No other product finding is opened by this decision. Admission, acceptance,
publication ordering, cleanup authority, doctrine, and deployment remain in the
same P2 cell and must be preserved.
