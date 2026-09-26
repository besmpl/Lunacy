# Bind check evidence to the current artifact bytes

## User request

Fix `classify_check` so successful check evidence is applicable only when its
SHA-256 digest matches the exact current `artifact.py` bytes. A digest mismatch
is `stale`; absent evidence is `unknown`. With a matching digest, an absent or
null `exitCode` is also `unknown`, not failed. A match means only that this check
record applies—it is not semantic acceptance or environment/custody proof.

The finite valid-input domain for this fixture is an existing regular local
artifact path plus either `None` or a mapping containing `artifactSha256` and an
integer, null, or absent `exitCode`. No general input validator is requested.

## Observable acceptance

- Old passing evidence is stale after the artifact changes.
- Missing evidence remains unknown.
- Matching evidence with a missing or null result remains unknown.
- Matching successful evidence is applicable; matching failed evidence is failed.

## Forbidden effects

Do not claim acceptance, infer environment or custody, add dependencies, access
the network, sleep, or write outside this task root.
