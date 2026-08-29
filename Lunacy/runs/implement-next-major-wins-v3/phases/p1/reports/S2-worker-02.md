# P1/S2R — simplify P1-A API and close optional-evidence binding

## Status

**FINAL — P1-A repair is implemented and terminal-verified.**

## Findings repaired

- Removed the unrequested `src/worker-proof.ts` compatibility module (and its
  generated stale alias) and all unused compatibility exports. The private
  module now exposes one exact name per operation and one direct
  `verifyWorkerProof(contract, proof, options)` shape; no object/legacy overload
  remains.
- Collapsed verifier check/evidence matching to the already canonical sorted
  order rather than repeating map/find passes. Canonical codecs still reject
  unsorted or duplicate IDs and retain fixed count/byte ceilings.
- Bound non-null `diffDigest` and every `artifactDigests` entry to a digest in
  the parent-declared `requiredEvidence` set. Undeclared optional decoration
  returns stable `ATTENTION:EVIDENCE_UNDECLARED`; focused negatives cover both
  fields. Malformed options fail closed with `ATTENTION:INVALID_TIME`.

## Owned artifacts

- `src/codex-worker-proof.ts`
- `schemas/lunacy-check-contract.schema.json`
- `schemas/lunacy-worker-proof.schema.json`
- `test/codex-worker-proof.test.js`
- `docs/WORKER_PROOF.md`
- `Lunacy/runs/implement-next-major-wins-v3/phases/p1/reports/S2-worker-02.md`

Finalized `S2-worker-01.md` and all unrelated baseline edits are untouched.

## Terminal verification

- `npm run typecheck` — PASS.
- `npm run build` — PASS; no compatibility `worker-proof` source/dist module remains.
- Focused effect/host/worker suite — PASS, 27/27:
  `node --test test/codex-worker-proof.test.js test/codex-host-policy.test.js
  test/codex-effect-records.test.js test/codex-exec-driver.test.js
  test/codex-exec-supervisor.test.js`.
- Negative/tamper corpus — PASS: closed fields, duplicate/unsorted IDs, invalid
  UTF-8/non-canonical bytes, contract/proof mismatch, failed checks, undeclared
  evidence and optional digests, size ceilings, expiry/time, and forged terminal.
- `node /tmp/check-b0-v2-evidence.mjs` — PASS: aggregate
  `e7d5e61d2e92854729c3aea37fc46f6d9f2fe9eee4b37d62af627997bec64acd`, 24
  canonical records, 33 ordinary references, zero hash-catalog keys.
- Owned-artifact `git diff --no-index --check` sweep — PASS.

## Control Block

- **Status:** FINAL — S2R source/schema/test/doc artifacts are frozen.
- **Authority:** evidence-only verifier; no kernel event, dispatch, inbox/session
  mutation, worker envelope, automatic decision, or public/default/manual change.
- **Compatibility:** existing effect/host records and B0-v2 canonical bytes remain
  unchanged; optional proof digests reuse parent evidence declarations.
- **Claims:** no unattended-safety, performance, token, provider, security,
  availability, production, release, or product-value claim.
- **Next:** parent may close S2R and authorize P1-B; this worker does not implement
  session/grant behavior.
