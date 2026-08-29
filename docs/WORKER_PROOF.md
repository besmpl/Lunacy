# Private worker proof (v1)

`lunacy-check-contract/v1` is a parent-owned, closed declaration. It freezes
the phase/step/attempt, producer kind/version, sorted check IDs (each expecting
`PASS`), required content digests, bounded evidence/record ceilings, and an
expiry before a worker is started. A worker cannot add, remove, rename, or
waive a check.

`lunacy-worker-proof/v1` is disposable evidence bound to the declaration
digest, the existing immutable launch/terminal identities, report/diff/artifact
digests declared in `requiredEvidence`, and one result for every declared check.
Optional diff/artifact fields cannot carry a digest outside that parent-owned
allow-list. The codec uses canonical JSON,
rejects unknown fields/duplicates/unsorted arrays, and applies fixed count and
byte ceilings. Each declaration also freezes evidence sensitivity and retention
(`ephemeral` or `run`). Evidence entries contain only a content digest and byte count;
payloads are not copied into the proof.

`verifyWorkerProof` is pure: callers provide an evaluation time and the
immutable terminal (and, when available, launch) witness. It returns exactly
`CERTIFIED` or `ATTENTION:<stable-code>` and cannot submit an event, dispatch a
command, or mutate a run. Missing, stale, forged, oversized, undeclared, or
non-`PASS` evidence is attention. The package root and existing manual/host
routes do not export or require this private marker.
