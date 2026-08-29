# P1/S1R — aggregate-only B0 comparison authorities

## Scope and authority

- **Status:** FINAL — S1R supersedes S1-worker-01 as the authoritative S1 result; the original report and `evidence/b0/**` remain untouched historical evidence.
- **Owned writes:** only `phases/p1/evidence/b0-v2/**` and this report. No product, source, test, documentation, release, install, or git mutation was made.
- **Frozen baseline:** HEAD `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7`; recorded dirty-baseline aggregate `f43e01678ee60a8ef5b503fbc101245e50a9d909a1b1086709c9a1447e61120e` (15 tracked modifications, 297 pre-existing untracked files; B0 paths excluded).

## Replacement evidence

- `evidence/b0-v2/manifest.json` publishes ordinary test/fixture/evidence path references and one replacement aggregate baseline fingerprint: `e7d5e61d2e92854729c3aea37fc46f6d9f2fe9eee4b37d62af627997bec64acd`. Its aggregate method binds the frozen baseline identity, path references, byte lengths, and content digests without publishing a per-file test/fixture hash catalog.
- `exact-bytes.json` is the unchanged 24-record canonical corpus for the fixed manual inbox flow (START, receipt, WORKER_ENVELOPE, GATE PASS, commit/replay) and local launch/receipt/terminal/lifecycle bytes. Existing launch/terminal codecs validate the local records; no raw argv, credentials, process payload, or arbitrary worker text is recorded.
- `legacy-v1-v2-tests.log`, `local-lifecycle-tests.log`, `manual-inbox-tests.log`, and `release-envelope-tests.log` reuse S1's deterministic results. `faultSchedules` and environment facts are preserved in the replacement manifest.
- `accepted-release-envelope.json` preserves the accepted repair-run deploy/check/envelope bytes; `release-path-digest.json` preserves the canonical `pathDigest(value) = SHA-256(canonical(value))` rule and prepared/committed envelope bindings.

## Verification

- Reused deterministic command summaries: manual inbox **PASS 6/6**; local lifecycle/effects **PASS 34/34**; legacy/v1/v2 load/replay **PASS 43/43**; release-envelope **PASS 7/7**.
- `node /tmp/check-b0-v2-evidence.mjs` — **PASS** (`self-check.log`): aggregate fingerprint, 33 ordinary path references, zero hash-catalog keys, 24 canonical byte records, codec validation, replay equality, release path-digest assertions, accepted items, and frozen baseline metadata.
- The baseline record is checked as a frozen pre-evidence snapshot (HEAD, tracked digest, and recorded counts); later S1R instructions remain outside that historical identity.
- Owned-artifact `git diff --no-index --check` sweep — **PASS** (`diff-check.log`), including this report and every `b0-v2` artifact.

## Control Block

- **Status:** FINAL — aggregate-only B0 replacement is complete and immutable for this terminal snapshot.
- **Authority:** comparison evidence only; it authorizes no P1 behavior or decision.
- **Claims:** no performance, token, provider, security, availability, product-value, production, release, or install benefit is claimed.
- **Next:** parent may close S1R and authorize the next gated P1 step; S1-worker-01 and `evidence/b0/**` remain historical, not edited.
