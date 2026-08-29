# P1/S1 — B0 comparison authorities

## Scope and authority

- **Status:** FINAL — B0 is frozen before any P1 product write.
- **Owned writes:** only `phases/p1/evidence/b0/**` and this report. No source, product, test, documentation, release, install, or git mutation was made.
- **Baseline:** HEAD `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7`; aggregate dirty-baseline identity `f43e01678ee60a8ef5b503fbc101245e50a9d909a1b1086709c9a1447e61120e` (15 tracked modifications, 297 pre-existing untracked files; B0 paths excluded). See `evidence/b0/baseline-identity.json`.

## Frozen evidence

- `evidence/b0/exact-bytes.json` contains canonical SHA-256-bound bytes for one fixed manual `START → receipt → WORKER_ENVELOPE → GATE PASS` flow, inbox projection, committed decision and exact replay, plus fixed local launch, receipt, terminal, and lifecycle records. Existing launch/terminal codecs validate the local records; no raw argv, credentials, process payload, or arbitrary worker text is recorded.
- `evidence/b0/manifest.json` records the exact test/fixture hashes, commands, environment facts, and bounded fault schedules. The fixture corpus is the existing Codex-exec and recovery fixture set; no new fixture framework was introduced.
- `evidence/b0/legacy-v1-v2-tests.log` freezes legacy, segmented/v1, segmented/v2 load/migration/rollback/replay and publication-fault observations (43/43).
- `evidence/b0/accepted-release-envelope.json` preserves the accepted repair-run deploy/check/envelope bytes; `evidence/b0/release-path-digest.json` freezes the canonical `pathDigest(value) = SHA-256(canonical(value))` rule and prepared/committed envelope bindings.

## Verification

- `node --test test/decision-inbox.test.js` — PASS, 6/6 (`manual-inbox-tests.log`).
- `node --test test/controller.test.js test/orchestration.test.js test/codex-exec-driver.test.js test/codex-exec-supervisor.test.js` — PASS, 34/34 (`local-lifecycle-tests.log`).
- `node --test test/r2-segmented.test.js test/p3-segmented-v2.test.js test/kernel-repair.test.js test/p3-committed-replay.test.js` — PASS, 43/43 (`legacy-v1-v2-tests.log`).
- `node --test test/r11e-release-envelope.test.js` — PASS, 7/7 (`release-envelope-tests.log`).
- `node /tmp/check-b0-evidence.mjs` — PASS: 24 canonical byte records, codec validation, replay equality, release path-digest checks, and reconstructed baseline aggregate (`self-check.log`).
- Owned-artifact `git diff --no-index --check` sweep — PASS (`diff-check.log`).

## Control Block

- **Status:** FINAL; evidence and report are immutable for this terminal snapshot.
- **Authority:** B0 is comparison evidence only; it authorizes no P1 behavior or decision.
- **Claims:** no performance, token, provider, security, availability, product-value, production, release, or install benefit is claimed.
- **Next:** parent may inspect this report and close the S1 gate; P1-A remains the next product-writing step.
