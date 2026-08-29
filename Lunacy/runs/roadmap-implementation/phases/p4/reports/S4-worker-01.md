# S4 worker report — R4 recovery forensics

## Result

Implemented the additive private `lunacy-recovery/v1` inspector and managed
`inspect-recovery`/`recovery` CLI aliases. The route requires an explicit run
root, run ID, and launch token, reuses `FileArtifactStore.loadReadOnly` and the
bounded effect readers, and never invokes dispatch/observe/ACK/repair,
projection, quarantine, lock acquisition, or cache mutation.

The capsule reports verified generation/epochs and redacted fence identities,
legacy/segmented journal budgets, exact token-scoped outbox state/lease status,
launch-intent/launch/terminal presence and binding, stable UNKNOWN causes, and
informational-only `nextProof`. Effect namespace and committed generation are
rebound before return; evidence is bounded, canonical, deterministic, and
payload/path/token redacted. Policy/authority/run/phase/step/epoch/digest and
result/report bindings fail closed.

Added `schemas/recovery-forensics.schema.json`, operator documentation in
`docs/RECOVERY.md`, a private compatibility module `src/recovery.ts`, golden
absent capsule fixture, and deterministic baseline tests in
`test/recovery-forensics.test.js`. Deployment collection excludes private R4
compiled modules, preserving existing managed inventory and package exports.

## Verification

- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `node --test test/recovery-forensics.test.js test/workfront.test.js` — 16/16 PASS.
- Terminal `npm run check` — PASS; 440 tests, 438 passed, 0 failed, 2 skipped; pack dry-run completed (log: `/tmp/r4-terminal-check-final2.log`).
- `git diff --check` — PASS.
