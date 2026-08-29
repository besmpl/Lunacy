# P1/S2 — closed check contract and worker-proof verifier

## Status

**FINAL — P1-A evidence-only contract is implemented and terminal-verified.**

## Scope and authority

- Added private `lunacy-check-contract/v1` and `lunacy-worker-proof/v1` codecs beside the existing Codex effect records; package-root exports, reducer worker envelope, session/run/inbox state, CLI/default/manual behavior, and release/install/git surfaces were not changed.
- The parent declaration freezes phase/step/attempt, expected result `PASS`, producer kind/version, sorted closed check IDs, required digest-bound evidence, sensitivity/retention, expiry, and count/byte ceilings. Proof validation requires exactly those checks/results and evidence; worker data cannot add, remove, rename, or waive a check.
- Proofs bind the declaration digest, launch token/command digest, immutable terminal digest and report digest, optional diff/artifact digests, producer identity, timestamps, and bounded redacted evidence references. Existing launch/terminal validators are reused; no filesystem or kernel mutation is performed.
- `verifyWorkerProof` is pure and returns only `CERTIFIED` or stable `ATTENTION:<code>`. It requires an explicit evaluation time and immutable terminal witness, optionally launch witness; malformed, stale, forged, mismatched, undeclared, oversized, expired, or non-PASS evidence cannot certify.

## Owned artifacts

- `src/codex-worker-proof.ts` (implementation and codecs)
- `src/worker-proof.ts` (private compatibility spelling)
- `schemas/lunacy-check-contract.schema.json`
- `schemas/lunacy-worker-proof.schema.json`
- `test/codex-worker-proof.test.js` (canonical round-trip and negative/tamper corpus)
- `docs/WORKER_PROOF.md`

## Terminal verification

- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `node --test test/codex-worker-proof.test.js test/codex-host-policy.test.js test/codex-exec-driver.test.js test/codex-exec-supervisor.test.js` — PASS, 27/27.
- Negative/tamper corpus covers unknown fields, duplicate IDs, non-canonical/invalid UTF-8 bytes, wrong contract digest/bindings, failed or omitted checks, undeclared/oversized evidence, expiry/time, and forged terminal report digest — PASS.
- `node /tmp/check-b0-v2-evidence.mjs` — PASS: 24 canonical byte records, replay equality, release path digests, 33 ordinary references, zero hash-catalog keys; baseline HEAD/diff compatibility unchanged.
- Owned-artifact `git diff --no-index --check` sweep — PASS.

## Control Block

- **Status:** FINAL — P1-A source/schema/test/doc artifacts are frozen for this terminal snapshot.
- **Authority preserved:** verifier is evidence-only; no kernel event, dispatch, inbox/session mutation, or automatic decision path exists.
- **Compatibility:** existing effect/host records and B0-v2 canonical bytes remain unchanged; package root and worker envelope remain status-only.
- **Claims:** no unattended-safety, performance, token, provider, security, availability, production, release, or product-value claim.
- **Next:** parent may close S2 gate and authorize P1-B; this worker does not implement session/grant behavior.
