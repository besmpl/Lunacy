# P4 Hard Gate 01 — FINDINGS

Decision: **FINDINGS**

R4 is not accepted. Parent review and an isolated reproduction confirmed two
bounded gaps in the new migration authority/recovery seams.

## 1. Reference guard silently skips durable non-text files

`scanCurrentReferences` and `scanBaselineReferences` skip every path whose
extension is outside a text allowlist. The architecture says unscannable
durable references refuse; they cannot silently authorize deletion. A tracked
`asset.bin` containing the exact migrated source path produced
`eligible=true`, empty references, and no refusal. That permits source unlink
while a durable inbound reference remains.

Repair by scanning bounded candidate bytes for the UTF-8 reference tokens
regardless of filename extension/UTF-8 validity, or classify a candidate as
unscannable. Oversized, missing, special, unstable, or unreadable current or
baseline candidates must refuse. Add current and HEAD-baseline binary fixtures,
plus the existing large/unstable refusal cases.

## 2. The final migration marker is published in place

`publishMarker` creates the final fixed pathname and writes bytes into it before
fsync. A real process crash can therefore leave a truncated fixed marker. The
current recovery then sees a marker collision and cannot reach the normative
`Body without marker; all sources present` recovery row. The existing
`MARKER_WRITE` fault fires only after a complete in-process write and does not
exercise partial publication.

Publish the marker through a verified same-directory staged write, file fsync,
atomic no-clobber publication, and parent fsync (or an equally strong existing
repository primitive). Recovery/deployment/doctor handling must recognize only
the exact owned staged prefix and never remove an unbound collision. Add a
genuine partial-staged-marker restart case and assert the final pathname is
always absent or fully canonical after every crash prefix.

Keep both repairs inside the existing R4 cell. Do not add a runtime schema,
ambient cleanup, bulk migration, live corpus mutation, or weaken the fixed
marker/source/receipt bindings.
