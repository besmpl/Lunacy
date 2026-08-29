# P2 S1 — digest-bound decision inbox and exact promotion

## Result

Implemented Direction 2 I2-A–I2-E as a private/additive seam.  The implementation reuses the verified `FileArtifactStore` read boundary, `MachineState.decisionTokens`/processed identities, canonical plan/digest helpers, `RunKernel.advance`, and lifecycle `initRun`; no package-root export, token minting, queue, provider, approval automation, DAG, or second decision authority was added.

### Maintained-surface inventory and changes

- `src/decision-inbox.ts`: bounded explicit-selection projection/listing; stable byte-sort; digest/cursor/epoch/plan/policy fences; redacted brief/evidence/receipt/path surface; exact `PARENT_DECISION` submit/replay and authority-adoption handling; exact predecessor/successor handoff validation and retry-safe promotion.
- `src/bridge-cli.ts`: private `inbox`, `submit-decision`, and `promote-phase` routes plus fail-closed argument/error mapping.
- `schemas/decision-inbox.schema.json`, `schemas/phase-handoff.schema.json`: closed v1 envelopes.
- `tools/deploy-skill.mjs`: managed payload/help integration; optional P2 docs/schema filtering preserves tracked-only recovery fixtures.
- `docs/DECISION_INBOX.md`, `docs/API.md`, `docs/WORKFRONT.md`: maintained contract/operational documentation.
- `test/decision-inbox.test.js`: deterministic mutation-free listing, redaction, stale binding, one-shot submit/replay, concurrent submit, exact PASS promotion, and retry/no-duplicate successor coverage.
- Existing P1 fleet/manifest surfaces and `test/r2-deployment.test.js` retained; deployment expectation updated for the additive P2 managed artifacts.

## Evidence

- Frozen P1 baseline: commit `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7`; focused baseline log `/tmp/p2-baseline-tests.log`, baseline diff `/tmp/p2-baseline-diff.txt`.
- Focused implementation matrix (typecheck/build + decision, S5, P3 suites): passed 21 tests before terminal verification.
- Terminal verification: `npm run check` exited 0; `/tmp/p2-s1-terminal-check.log`; full matrix reports 458 tests, 456 pass, 0 fail, 2 skipped, and package dry-run completed (131 files).
- Earlier P2 focused matrix including Workfront/R2: 39 tests passed; ad-hoc authority-adoption/live-old-work and promotion retry checks returned closed attention/replay as required.

## Acceptance notes

Projection performs no writes or ambient discovery and exposes only stable digests/next-proof text.  Submit validates the supplied projection against the current generation, revision, epochs, plan/policy/evidence/brief bindings before invoking the kernel; invalid bindings return attention without consuming.  Kernel conflicts rebind only to the exact processed identity, so concurrent identical submissions yield one durable `PARENT_DECISION` and a replay.  Authority adoption preserves the raw-vs-normalized plan digest alias and refuses live-old-work without token consumption.  Promotion requires exact predecessor FINAL (`COMPLETE` + gate `PASS`), matching generation/revision/plan/proof and authorization digests, no active/pending/claimed/unknown work, and an explicitly named successor; `initRun` is called only after those checks and exact START identity replay prevents duplicate successors after retry/crash.

## Control Block

- **Status:** FINAL / PASS
- **Scope:** P2 S1 only; P1 and unrelated run artifacts preserved.
- **Authority:** Direction 2 I2-A–I2-E; P1 gate PASS; kernel remains sole token/decision authority.
- **Terminal:** `npm run check` exit 0 (458 tests; 456 pass; 0 fail; 2 skipped).
- **Report:** this file; terminal log `/tmp/p2-s1-terminal-check.log`.
- **Next:** P2 S2 adversarial pass may begin; no post-PASS code edits or reruns.
