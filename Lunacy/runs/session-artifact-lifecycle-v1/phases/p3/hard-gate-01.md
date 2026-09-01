# P3 Hard Gate 01 — FINDINGS

Decision: **FINDINGS**

R3 is not accepted. Parent review confirmed one deletion-authority gap in the
new abandonment preflight.

`prepareRunAbandonment` and `abandonmentPreflight` validate only the
caller-supplied custody summary. They do not inspect the retained durable
runtime/Custody state before admitting or publishing abandonment. Therefore an
authority file can claim `pending=0, claimed=0` while the retained run actually
contains a current PENDING or CLAIMED command, and the existing code can still
reach Body deletion. This contradicts the accepted R3 observable: actual
ACTIVE/PENDING/CLAIMED work must refuse, while UNKNOWN/malformed Custody remains
untouched.

Required repair, within the existing R3 cell:

1. At both authority preparation and finalization/recovery revalidation, use
   the existing durable runtime/store seams to derive the current actionable
   state when it is valid. Refuse an ACTIVE step or PENDING/CLAIMED outbox entry
   even if the parent summary claims zero.
2. Compare the closed authority summary to the observed custody classification
   rather than treating its zero counts as proof. Fail closed on a disagreement
   that could hide actionable work. Preserve UNKNOWN and malformed custody
   files byte-for-byte; do not reinterpret or delete them.
3. Add direct red/green coverage using durable current state where authority
   falsely reports zero for ACTIVE, PENDING, and CLAIMED, plus UNKNOWN and
   malformed retention. Re-run the complete R3 gate, broad check, and
   tracked-candidate gate.

Do not add a new ledger, runtime schema/event, cleanup engine, or public export.
All accepted R1/R2 behavior and the rest of R3 must remain unchanged.
