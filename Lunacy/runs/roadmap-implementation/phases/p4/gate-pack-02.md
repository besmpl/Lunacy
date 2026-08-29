# P4 Gate Pack — fresh post-repair scout 02

## Decision

**FINDINGS — do not accept P4 yet.** The eight gate-pack-01 findings are
closed in the repaired implementation and the focused behavior/deployment
samples pass. One remaining R4-A/R4 exit-criteria gap is reproducible at the
capsule boundary: the inspector does not enforce the frozen schema's bounded
identity/redaction contract before returning state-derived strings.

## Prior finding closure

- **Wrong command-digest effect fence:** `commandDigestRequested` is passed
  through `bindCommon()` and `bindTerminal()`. A valid token whose supplied
  digest differs now yields outbox/effect `MISMATCH`/non-verified evidence
  (`src/recovery-forensics.ts:216-234`). A direct valid-record probe confirms
  no effect remains authoritative under a conflicting digest.
- **Terminal semantic parity:** `terminalSemanticsValid()` enforces the
  production outcome/status/result/report combinations before terminal bytes
  can be used (`src/recovery-forensics.ts:149-160`). A `PASS` plus
  `process-failure` record is classified `MISMATCH` in the direct probe.
- **Golden corpus/manifest:** the five required canonical capsules (ACKED,
  UNKNOWN with launch, UNKNOWN without evidence, malformed evidence, absent
  token) and the schema are frozen by `golden-manifest.json`; the focused test
  checks canonical bytes/top-level closure and every manifest digest
  (`test/fixtures/recovery/golden-manifest.json`,
  `test/recovery-forensics.test.js:46-59`).
- **Policy-free deterministic report path:** normal completion derives
  `phases/{phaseId}/reports/{stepId}-worker-{attemptEpoch}.md` from the
  command/run identity regardless of optional policy, and verifies result and
  report bytes (`src/recovery-forensics.ts:145-147, 321-339`).
- **Conflicting aliases:** API and CLI reject contradictory `runRoot`/
  `kernelRoot`, `runId`/`expectedRunId`, and `launchToken`/`token` values
  (`src/recovery-forensics.ts:64-89`, `src/bridge-cli.ts:104-133`).
- **Per-record symlink/oversize/unreadable evidence:** the namespace fence
  tolerates only the four exact token record paths and maps those target
  failures to bounded `UNVERIFIABLE` evidence; unrelated namespace trust
  failures still fail closed (`src/recovery-forensics.ts:167-212`). Focused
  oversized and symlink probes return a capsule without mutation.
- **Descriptor/chunk reads and bounded directory iteration:** effect files
  use `O_NOFOLLOW`, descriptor identity checks, 64 KiB chunks and a hard
  ceiling; namespace traversal uses bounded `opendir()` iteration and a
  512-entry ceiling (`src/codex-effect-records.ts:133-184`,
  `src/recovery-forensics.ts:167-212`).
- **Truthful segmented ceiling:** segmented `CURRENT`/head carries and
  verifies `activeCeiling`; the inspector reads that persisted value rather
  than guessing 1000 (`src/store.ts:642-660, 1518-1572`,
  `src/recovery-forensics.ts:219-232`). A segmented run with 1,002 active
  events and ceiling 2,000 inspected successfully and reported
  `used:1002, ceiling:2000, remaining:998`.
- **Managed wrapper packaging:** deployment now carries the private recovery
  modules in the signed inventory (`tools/deploy-skill.mjs:1414-1422`). The
  managed wrapper resolved both `inspect-recovery --help` and an actual
  token-scoped inspection; `npm pack --dry-run` includes `dist/recovery*`.

## Exact finding

1. **[P2] Capsule identity strings are not bounded/validated against the
   frozen schema and can expose path-like step IDs.** The schema freezes
   `request.runId`, `run.runId`, and `run.phaseId` at `maxLength: 256`
   (`schemas/recovery-forensics.schema.json:45-55`), but `requestRunId()` only
   rejects empty/NUL values and `validateStateShape()` imposes no corresponding
   bound (`src/recovery-forensics.ts:70-74`, `src/store.ts:471-478`). The
   inspector then copies both the requested and committed IDs directly into
   the capsule (`src/recovery-forensics.ts:352`). A valid runtime with
   `runId = 'x'.repeat(257)` is accepted and returns both IDs at length 257
   (JSON output ~1.8 KiB), violating the frozen schema instead of failing
   closed. Separately, plan/store validation permits slash-bearing step IDs and
   `outbox.stepId` is copied verbatim; a valid `stepId: '/tmp/secret'` appears
   in the capsule, contrary to R4-A's “no arbitrary paths” redaction contract.
   Add one bounded identity gate before capsule assembly (reject overlong or
   unsafe run/phase/step identifiers with a stable recovery error, or emit a
   separately specified digest/redaction) and assert actual inspector output
   against the JSON schema, including adversarial identity samples.

## R4 exit-criteria assessment

- **Strict nested schema:** **RED** for the bounded identity case above;
  output object keys are closed, but the route does not enforce its declared
  max-length/redaction constraints.
- **Canonical deterministic redacted bounded capsule:** canonical ordering,
  digest-only evidence, fixed output ceiling, and repeated byte identity pass;
  the identity exception above violates strict bounds/path redaction.
- **State-aware lease/lock and verified UNKNOWN cause:** PASS. Lease and lock
  statuses are classified without mutation; UNKNOWN cause is derived only from
  a verified matching unresolved terminal or matching token+command-digest
  recovery proof (`src/recovery-forensics.ts:236-250`).
- **Full binding:** PASS for supplied token/command digest, run/phase/step,
  epochs, optional policy/authority digests, deterministic report path, and
  result/report bytes in the repaired paths.
- **Root/CURRENT/effect identity races:** PASS. Root and CURRENT identities,
  complete bounded effects namespace, and committed generation are rebound
  before return (`src/recovery-forensics.ts:300-350`).
- **Zero side effects:** PASS in source review and tree-hash probes: no
  dispatch, observe, ACK, repair, quarantine, lock acquisition, cache, or
  projection operation is reachable from `inspectRecovery`; errors also leave
  the tree unchanged.
- **Legacy/segmented parity and compatibility:** PASS for focused legacy and
  non-default segmented samples; Workfront, R1-R3 routes, and package-root
  exports remain unchanged. Managed deployment integration passes.

## Named parent acceptance samples

- **P4-SCHEMA-BOUNDS:** build a valid run with `runId = 'x'.repeat(257)` (and
  separately a 257-character phase ID), call `inspectRecovery()`, and validate
  the returned capsule with `schemas/recovery-forensics.schema.json`. It must
  fail closed before returning an invalid capsule, or use a documented bounded
  representation. Repeat with a path/control-bearing step ID and assert no raw
  path is returned.
- **P4-PRIOR-EIGHT:** retain the gate-pack-01 wrong-digest, terminal
  status/outcome, report-path, alias, oversize/symlink, descriptor-bound,
  segmented-ceiling, and managed-wrapper samples; all pass in the current
  checkout as summarized above.

## Bounded verification

- `npm run build` — PASS.
- `node --test test/recovery-forensics.test.js test/workfront.test.js` — **19/19
  PASS**.
- `node --test test/r2-deployment.test.js` — **5/5 PASS**.
- Direct segmented probe — PASS (`activeSuffix used 1002 / ceiling 2000`).
- Direct wrong-digest and terminal status/outcome probes — PASS (all affected
  evidence non-verified).
- Direct schema-bound probe — **FAIL as expected for this finding**:
  `runId='x'.repeat(257)` returns `request.runId.length ===
  run.runId.length === 257` despite schema maxLength 256; path-bearing step
  probe returns `outbox.stepId: '/tmp/secret'`.
- No broad suites or mutating commands were run; no source/package files were
  changed. This gate pack is the only repository write in this scout.

## Gate condition

Repair the bounded identity/redaction finding, add a real schema-validation
sample for the route output, and rerun `P4-SCHEMA-BOUNDS` plus the prior eight
parent samples. P4 can be accepted only when those samples pass while the
capsule remains canonical, deterministic, token-scoped, mutation-free, and
strictly bounded.
