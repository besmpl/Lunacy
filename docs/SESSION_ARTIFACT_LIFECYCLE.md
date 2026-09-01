# Lunacy session-artifact lifecycle architecture

**Status:** implementation-ready architecture; not yet runtime behavior.

**Implementation sequence:**
[`SESSION_ARTIFACT_ROADMAP.md`](./SESSION_ARTIFACT_ROADMAP.md).

**Decision:** stop treating every orchestration artifact as permanent. Keep a
small durable control/receipt plane, put bulky session witnesses in one
structurally disposable body, and leave effect-recovery evidence in a separate
runtime-owned custody plane. Parent acceptance seals the run body; age, disk
pressure, worker `FINAL`, and runtime finality do not.

This design addresses orchestration/session residue. It does not replace
`RunKernel`, change event or state bytes, infer acceptance from Markdown, or
weaken `CLAIMED`/`UNKNOWN` effect custody.

## 1. Why Lunacy grows trash

The problem is not primarily `PROJECT_NOTES.md` or `USER_NOTES.md`; those are
already specified as tiny current-memory projections. The growth mechanism is
the interaction of four current rules:

1. A worker must leave an immutable durable terminal report.
2. Repairs, re-gates, and re-reviews create new numbered immutable artifacts.
3. Raw verification output is moved out of parent context into durable
   `evidence/` files.
4. A completed run has no seal, archive, promotion, or reclamation transition.

Immutability therefore became immortality. The current resume discipline keeps
old bytes out of the normal parent read set, but the bytes still remain in the
repository, searches, commits, handoffs, backups, and future source trees.
Control and payload also share `Lunacy/runs/<run-id>/`, so there is no safe
whole-directory cleanup boundary.

The checked-in corpus makes the mechanism visible before it is a disk crisis:

| Class | Files | Bytes | Share |
| --- | ---: | ---: | ---: |
| evidence/log payload | 168 | 3,208,519 | 87.8% |
| worker reports | 67 | 294,084 | 8.0% |
| run control | 32 | 40,479 | 1.1% |
| hard gates | 23 | 38,942 | 1.1% |
| step control | 23 | 36,413 | 1.0% |
| gate packs | 5 | 28,507 | 0.8% |
| decision briefs | 4 | 6,713 | 0.2% |

That is 322 tracked files / 3,653,657 bytes across nine `COMPLETE` runs and
one `STOPPED` run, with no `ACTIVE` run. The raw size is still modest; the
unbounded retention rule and cognitive surface are the defect.

There are two additional, separate engine-level residue sources:

- `FileArtifactStore` bounds ordinary legacy generations and has explicit
  segmented compaction, but orphan material is moved into `.kernel/quarantine`
  and no terminal quarantine reclamation contract is currently visible.
- managed deliberation removes per-attempt scratch, but durable launch,
  receipt, teardown, and transport records remain in `evidenceRoot`; Codex exec
  terminal validation also binds the exact worker report path. Those bytes are
  recovery custody until a separate proof establishes that they are settled.

Trying to solve all three planes with one garbage collector would make the
collector a new authority and risk deleting the only duplicate-effect fence.

## 2. Golden architecture: Seed, Body, Custody

Every artifact belongs to exactly one plane when it is created. Nothing is
classified by a later heuristic.

```text
Lunacy/runs/<run-id>/
  PLAN.md                         durable current authority
  STATE.md                        durable current control / terminal tombstone
  USER_NOTES.md                   optional tiny user memory
  DECISIONS.md                    consequential decisions only
  OUTCOME.md                      compact accepted result, created at final gate
  RUN-RECEIPT.json                immutable seal receipt
  phases/<phase-id>/STEPS.md      bridge-compatible current step projection

  .work/                          session Body; ignored by Git and normal search
    phases/<phase-id>/
      reports/                    manual/human reports not runtime-bound
      evidence/                   raw logs, surveys, test output, copied proof
      decision-briefs/
      gate-packs/
      hard-gates/

  .kernel/                        runtime Custody; never touched by Body cleanup
  .codex-effects/                 runtime Custody; never touched by Body cleanup
  phases/<phase-id>/reports/      current managed Codex report compatibility
```

### Seed

The Seed is the small durable lineage needed to understand what was requested,
what was accepted, and where the product result lives. During an active run it
is current control. After acceptance it is a terminal tombstone plus
`OUTCOME.md` and `RUN-RECEIPT.json`.

`OUTCOME.md` contains only:

- accepted observable/result;
- changed product surfaces;
- final verification and parent acceptance;
- source/workspace identity;
- remaining risks and explicit retained custody.

It is not a compressed chat transcript or a list of every attempt.

### Body

The Body is recoverable working memory: raw evidence, temporary research,
decision briefs, gate navigation, and human reports that are not referenced by
runtime effect records. It may be immutable while a run is active, but it is
not permanent. V1 deletes it as one namespace after parent acceptance. If
authority requires a full audit archive, V1 refuses and that retention/export
contract is a separately authorized later release.

V1 moves the 87.8% evidence/log class and other non-runtime witnesses. Existing
managed worker reports remain at their current paths because
`src/codex-effect-records.ts` and `src/codex-host-policy.ts` bind them exactly.
Their later compaction is a separate earned release, not a shortcut in V1.

### Custody

Custody contains state or evidence whose loss could relaunch, strand, or make an
external effect unverifiable. The session sealer has no delete permission for
`.kernel`, `.codex-effects`, managed report paths, deployment state, or
external evidence roots. `PENDING`, `CLAIMED`, `UNKNOWN`, malformed, or
ambiguously bound effects are non-expiring roots.

This structural exclusion is the key simplification: the session sealer never
needs to understand the kernel DAG, report prose, launch protocol, or effect
reachability.

## 3. Lifecycle

```text
CREATE -> ACTIVE -> GATE-DUE -> PARENT-ACCEPTED -> SEALED -> BODY-PRUNED
             |
             +-> BLOCKED/STOPPED -> EXPLICIT-ABANDONED -> BODY-PRUNED
```

`FINAL` is only a worker terminal fact. `COMPLETE` from runtime is only a
runtime fact. The transition to `PARENT-ACCEPTED` remains the existing parent
gate.

### Creation and active work

1. Create Seed files and admit `.work/` before the first implementation
   dispatch.
2. Put raw output under `.work`; do not copy it into reports or parent context.
3. Keep `PLAN.md`, `STATE.md`, notes, decisions, and `STEPS.md` within their
   existing size/currentness rules.
4. Put a report at the managed compatibility path only when the command/effect
   protocol requires that exact path. Otherwise use `.work`.
5. Never cite Body paths from durable product documentation. Durable docs cite
   source, accepted behavior, an ADR, `OUTCOME.md`, or `RUN-RECEIPT.json`.
6. `.work` is local recovery state, not Git authority. Before a cross-host
   handoff or worktree deletion, explicitly transfer the active Body as a
   digest-verified bundle. If an active Body is missing, treat its unfinished
   attempts as incomplete and create fresh reports; never infer PASS from Seed.

New-run Body admission is controlled by one canonical installed private policy,
`runtime/retention-policy.json`, with `newBodyAdmission` exactly `OFF` or `ON`.
One private `admitRunBody` operation shares an installed-target policy claim
with policy deployment, verifies canonical `ON`, takes the run release and
Body-writer claims, rechecks `ON`, creates `.work` exclusively, and fsyncs it
and the run root. Policy OFF blocks only that first creation; an existing
`.work`, marker, tombstone, or receipt remains readable and recoverable. Body
writers never create `.work` and cannot recreate it after a receipt. This is a
private installed policy, not a runtime event/state field or ambient registry.

### Parent acceptance and sealing

Sealing has two closed acceptance inputs. It never treats Markdown as runtime
authority and it does not change the public `PARENT_DECISION` schema:

- **Runtime run:** one parent-gate wrapper, immediately before submitting
  `PARENT_DECISION PASS`, constructs the decision once, writes/fsyncs one closed
  `lunacy-runtime-acceptance-candidate/v1` capsule at
  `<run-root>/.lunacy-parent-acceptance.json`. It binds the verified pre-PASS
  CURRENT generation/state digest/revision, gate token, exact proposed PASS
  event identity and event digest, authority digest, accepted Outcome digest,
  the complete accepted result identity plus its digest, and
  `activeWorkers="NONE"`, then submits that exact decision/event id through the
  existing decision-inbox CAS fence. It does not separately reimplement event
  identity. A conflict returns without consuming the token. After PASS, the
  sealer verifies that exact event is the next committed journal record and its
  successor is `status=COMPLETE`, `gate=PASS`, `barrier=CLOSED`, with no
  current-frame `ACTIVE`, `PENDING`, `CLAIMED`, or `UNKNOWN` work. It then
  constructs the final runtime witness from the candidate, committed record,
  and terminal CURRENT/state digest. A candidate without that exact committed
  transition never authorizes sealing.
- **Manual run:** at the existing parent gate, the parent invocation writes the
  same fixed path with a closed canonical `lunacy-parent-acceptance/v1` value
  binding run id, accepted Outcome digest, disposition, authority digest,
  terminal-state digest, the complete result identity plus its digest, and
  `activeWorkers="NONE"`. Final
  `STATE.md` is checked for consistency, but it cannot authorize deletion by
  itself.

`acceptanceDigest` is SHA-256 of the exact canonical final-witness bytes. The
runtime capsule is written before PASS precisely because the existing PASS
record binds no product identity: PASS followed by any product/Outcome/
authority change fails result revalidation rather than silently accepting the
new bytes. A failed or FINDINGS gate leaves a harmless bounded candidate that
the next parent gate must replace only after proving its bound PASS token was
not consumed.

Before creating either acceptance value, the parent writes `OUTCOME.md` and
verifies the result identity. The runtime bridge publishes final `STATE.md` as
part of/after the bound PASS transition; a manual parent publishes it before
its witness. Once the final gate passes and the barrier is closed, the parent
runs `seal-run --dry-run`. Dry-run validates and reports Seed/Body/Custody
counts and bytes without mutation or cross-run scanning. `seal-run --accept`
then enters the **existing maintained-writer exclusion protocol**. MVP-B
extracts a private
`withRunFinalizationExclusion` from the claim/order helpers
already used by `withReleaseExclusion`; it does not invent a parallel lock:

1. exclusively claim `<run-root>/.lunacy-release-exclusion.lock`;
2. claim `<run-root>/.lunacy-body-writer.lock`;
3. for a managed run, claim `<run-root>/.kernel/.bridge.lock` and then
   `<run-root>/.kernel/.writer.lock` in that order; and
4. hold all applicable claims until receipt publication and Body deletion
   finish.

`FileArtifactStore`, `BridgeDrivePump`, orchestration admission, and
`CodexExecSupervisor` already call `assertReleaseAdmissionOpen`; the extracted
operation must retain those checks and the exact owned-file/stale-owner rules.
MVP-A adds one private `withBodyWriterAdmission` wrapper using the same
`acquireOwnedFileClaim` implementation, not predicate-only checks. A Body
writer checks `assertReleaseAdmissionOpen`, acquires
`.lunacy-body-writer.lock`, checks release admission again, then holds the
claim from before opening any Body destination through atomic rename/fsync and
terminal publication. The sealer's release claim prevents later admission;
the Body-writer claim makes the sealer wait for an earlier publication.
Owned-file identity, stale-owner recovery, cancellation, and reverse release
are the existing rules.

`tools/with-body-writer.mjs` is itself the only Body writer. It runs a child
without a Body pathname and captures output to a no-follow private temporary
file outside the run root, waits for the complete child process group to exit,
then acquires `withBodyWriterAdmission` and atomically publishes that closed
file into Body. Publication copies into a no-follow same-filesystem Body
temporary sibling, verifies/fsyncs it, and renames that sibling; it never
assumes an OS temp can be renamed across volumes. A crash may leave an external
temp for ordinary OS-temp cleanup, but a surviving child has no Body descriptor
and cannot race sealing. Direct shell redirection or a child-supplied path into
Body is not a supported writer path.

An already-open unsupported shell descriptor cannot be fenced retroactively,
so `activeWorkers="NONE"` is necessary but not sufficient. After all claims are
held, the sealer uses a private `captureRunSealQuiescence` adapter to enumerate
live process groups and open descriptors whose target identity is Body or its
tombstone. The adapter returns a closed `lunacy-run-quiescence/v1` snapshot
binding platform, run/Body `dev`+`ino`, inspected process count, open-handle
count (which must be zero), and capture digest. The existing release process
snapshot logic is reused; platform-specific handle enumeration is a private
boundary (bounded NUL-safe `lsof` records on macOS and `/proc/*/fd` identities
on Linux). Windows is fail-closed until it has a tested equivalent adapter.
Unsupported platforms, missing tools, permission denial, an incomplete
snapshot, or any open handle refuse with `QUIESCENCE_UNAVAILABLE` or
`WRITER_ACTIVE`. The snapshot is captured again immediately before receipt
publication as a zero-handle gate. The **initial** post-claim snapshot digest
is stored in the staged receipt; the second capture does not mutate that
receipt or its marker binding. Instead the staged receipt contains the fixed
policy `publicationQuiescence="REQUIRED_ZERO_HANDLES"`, and atomic publication
is permitted only in the same held-claim critical section after the second
gate succeeds. A crash before that point leaves no published receipt. New
maintained writers remain blocked by the claims throughout. This is a
workflow-safety boundary, not protection against a malicious same-user process
that deliberately opens the private path after inspection.

While those claims are held:

1. The sealer revalidates the acceptance witness, terminal state, closed
   barrier, captures the initial quiescence snapshot, and validates
   `OUTCOME.md`, final `STATE.md`, and result identity.
   `STATE.md` may name the future receipt path but must not embed its digest.
2. It computes the candidate Body, Seed, result, and
   acceptance digests and writes/fsyncs the complete candidate receipt to a
   fixed `<run-root>/.RUN-RECEIPT.json.tmp` file using exclusive creation.
3. It atomically creates and fsyncs the durable continuation marker
   `<run-root>/.lunacy-run-finalization.json`, binding the candidate receipt
   digest, staged receipt filesystem identity, original Body identity, and the
   full tombstone name. The live release-exclusion claim rejects writers; this
   marker only makes a crash resumable and is never itself treated as a lock.
4. It atomically renames `.work` to
   `.work.prune-<full-receipt-digest>` and fsyncs the run directory. No bytes
   have been deleted. It revalidates the frozen tombstone identity and full
   Body digest; mismatch restores `.work` and fails before receipt publication.
5. It revalidates Seed, acceptance, result identity, and the zero-handle
   publication gate, atomically publishes `RUN-RECEIPT.json`, fsyncs the run
   directory, then
   removes only the exact receipt-bound tombstone.
6. After tombstone removal and directory fsync, it removes the exact parent
   acceptance file only when its digest equals the witness embedded in the
   published receipt, then deletes the continuation marker last. A crash after
   tombstone removal therefore still has a valid receipt and marker and
   converges by deleting only those exact private inputs.

No file outside the exact Body/tombstone root is a candidate. Unknown sibling
files are preserved. A crash before receipt publication may move the Body but
deletes no bytes and can deterministically restore or continue it; a crash
after publication resumes the same bounded deletion recipe. Finalization
markers are durable continuation records, not time-based locks: a new
invocation first reacquires the normal exclusion, then validates and resumes
the exact candidate rather than guessing that it is stale. Any Body identity,
metadata, or digest drift observed after exclusion or after the rename fails
closed before receipt publication.

The normal Lunacy finalization invokes this explicit operation after parent
acceptance. There is no timer, daemon, boot scan, global registry, or ambient
garbage collection.

### Retention and explicit abandonment

- V1 has one accepted-run action: `PRUNE`.
- Export, `RETAIN`, and seal-without-prune are deferred until a real authority
  requires them and their receipt/recovery variants are specified.
- `ACTIVE` and `BLOCKED` never seal automatically.
- Stopping a worker or handing off a run is not abandonment. MVP-C adds a
  separate foreground `seal-run --abandon` operation for `BLOCKED`/`STOPPED`
  runs only. It requires an explicit closed `lunacy-run-abandonment/v1` parent
  value copied canonically to fixed
  `<run-root>/.lunacy-parent-abandonment.json`, with run id,
  `disposition="ABANDONED"`, authority digest, bounded reason code,
  `activeWorkers="NONE"`, and custody summary. It also requires the same
  claims and mechanical quiescence as accepted sealing, no `ACTIVE`, `PENDING`,
  or `CLAIMED` work, and preserves every `UNKNOWN`/malformed custody path.
- Abandonment writes compact `ABANDON-RECEIPT.json` (authority, final Seed,
  Body digest/counts, reason, and retained-custody counts) and reuses the exact
  marker/cleanup transaction. It does not claim a product result or create an
  accepted Outcome. No timeout, age, disk pressure, audit, or runtime status
  can synthesize this authority.

## 4. Receipt contract

The V1 receipt is private orchestration metadata, not a public runtime schema:

```json
{
  "schema": "lunacy-run-receipt/v1",
  "runId": "example",
  "disposition": "ACCEPTED",
  "authorityDigest": "<sha256>",
  "seedDigest": "<sha256>",
  "terminalStateDigest": "<sha256>",
  "quiescence": {"schema": "lunacy-run-quiescence/v1", "digest": "<sha256>", "openHandles": 0, "publicationGate": "REQUIRED_ZERO_HANDLES"},
  "outcome": {"path": "OUTCOME.md", "digest": "<sha256>"},
  "acceptance": {
    "kind": "manual-parent/v1",
    "digest": "<sha256>",
    "witness": {
      "schema": "lunacy-parent-acceptance/v1",
      "runId": "example",
      "disposition": "ACCEPTED",
      "activeWorkers": "NONE",
      "authorityDigest": "<sha256>",
      "outcomeDigest": "<sha256>",
      "terminalStateDigest": "<sha256>",
      "resultIdentity": {"kind": "commit", "oid": "<40-or-64-hex-oid>"},
      "resultIdentityDigest": "<sha256>"
    }
  },
  "resultIdentity": {"kind": "commit", "oid": "<40-or-64-hex-oid>"},
  "body": {
    "root": ".work",
    "treeDigest": "<sha256>",
    "files": 168,
    "bytes": 3208519,
    "action": "PRUNE"
  }
}
```

The actual validator is closed and bounded. `acceptance.kind` is exactly
`runtime-pass/v1` or `manual-parent/v1`. `resultIdentity` is either a closed
clean-commit object or a closed final-gate `lunacy-product-manifest/v1` object
plus its canonical SHA-256. That manifest
contains the explicit product-surface roots and sorted NUL-delimited relative
path/content-digest entries, using the same path rules below; it excludes
`Lunacy/**`, runtime scratch, and the receipt. Dirty/untracked candidates are
therefore representable without a digest cycle. The complete bounded manifest,
not merely its digest, is embedded in `resultIdentity` in the acceptance input,
final witness, and receipt; no process-local root list or unnamed sidecar is
needed to revalidate after prepare/crash/restart. Relative paths are canonical
and the Body root is fixed by the implementation, not caller-selectable. A
receipt stores aggregate digests and useful counts, not a permanent per-file
catalog. Wall-clock time is diagnostic only and is excluded from identity.

The manual witness has exactly the nine fields shown above. The pre-PASS
runtime candidate has exactly `schema`, `runId`, `prePass` (`generation`,
`revision`, `stateDigest`), `gate` (`token`, `eventDigest`,
`eventIdentityDigest`), `activeWorkers`, `authorityDigest`, `outcomeDigest`, and
the complete `resultIdentity` plus `resultIdentityDigest`. The final runtime
witness has exactly `schema`
(`lunacy-runtime-acceptance/v1`), `runId`, that complete `candidate`,
`passRecord` (`revision`, committed event digest, and committed event-identity
digest), and `terminal` (`generation`, `stateDigest`).
`acceptance.digest` must equal the SHA-256 of canonical `witness` bytes, and
authority/outcome/result/terminal digests must equal the sibling receipt
values, and each result digest must be recomputed from its embedded closed
identity. The runtime `passRecord` and `terminal` are reconstructed from
verified CURRENT/state/journal; only the parent candidate is supplied, before
PASS.

The Body tree digest is SHA-256 over lexicographically sorted, NUL-delimited
tuples encoded as UTF-8 relative-path bytes, ASCII octal permission bits masked
to `0777`, ASCII decimal size, and lowercase content SHA-256. Directories do
not get tuples; empty directories are irrelevant. Paths must be normalized
UTF-8 without NUL, `.`/`..`, backslash, absolute spelling, or duplicate byte
encoding. Symlinks, special files, hard-linked files (`nlink != 1`), ceiling
overflow, and identity/content drift refuse before the Body rename. Every
traversed file and directory must have the Body root's exact `st_dev`; a nested
mount/bind mount or device change refuses before traversal crosses it. Because
same-filesystem bind mounts can share `st_dev`, a private mount-boundary
adapter also requires `.work`/tombstone to have the trusted run-root parent's
mount identity and rejects every mount point at or beneath Body (Linux: an
opened-root `/proc/self/fd/<fd>` physical anchor plus bounded
`/proc/self/mountinfo`; macOS fixed absolute `lsof` and `mount` adapters with a
closed bounded parser). A future Linux `statx(STX_MNT_ID)` cross-check may be
added only if characterization proves the fd-bound mountinfo mapping
insufficient; it is not an implicit native dependency.
Missing/ambiguous platform data fails closed rather than falling back to device
equality. The
continuation marker, live exclusion claim, and temporary receipt are outside
Body and never participate in its digest.

The authority digest uses the same encoding over `PLAN.md`, optional user
notes, `DECISIONS.md`, and `phases/*/STEPS.md`; it deliberately excludes the
state projection that the PASS transition changes. `seedDigest` covers those
files plus final `STATE.md` and `OUTCOME.md`, but excludes the receipt and all
private transaction files to avoid a digest cycle. No signature/key system is
added; existing filesystem trust and the accepted result identity remain the
boundary.

The continuation marker is also closed. It has schema
`lunacy-run-finalization/v1` and exactly: `runId`, `receiptDigest`,
`disposition` (`ACCEPTED` or `ABANDONED`), `receiptPath` (respectively fixed
`RUN-RECEIPT.json` or `ABANDON-RECEIPT.json`), `acceptanceDigest`,
`authorityDigest`, `resultIdentityDigest`, `quiescenceDigest`,
`acceptanceInput` (`path`, `dev`, `ino`, `digest`), `stagedReceipt` (`path`,
`dev`, `ino`, `digest`), `body` (`sourcePath`, `dev`, `ino`, `treeDigest`), and
`tombstonePath`, plus a bounded `cleanupEntries` array. The array is the
pre-rename traversal reused—not recomputed prose—and contains sorted records
for every file (`relativePath`, `dev`, `ino`, `mode`, `size`, `digest`) and
directory (`relativePath`, `dev`, `ino`, `mode`) including root device. It is a
temporary crash cursor, not a retained per-file receipt, and is deleted with
the marker. All paths are fixed basename-relative values; callers cannot choose
them. The abandonment variant uses its abandonment-authority digest in
`acceptanceDigest` and a fixed all-zero `resultIdentityDigest`; it cannot be
misread as accepted. Resume after partial deletion accepts absent bound entries
as completed, requires every remaining entry to match exactly, refuses extras/device
crossings, and deletes remaining entries bottom-up. The published receipt plus
exact tombstone identity authorizes that bounded remainder; the original
aggregate need not be reconstructible after progress.

Crash recovery is a closed state table:

| Observed exact state after exclusion is reacquired | Recovery |
| --- | --- |
| temp receipt only; `.work` unchanged | verify temp identity/digest, unlink it, restart preflight |
| marker + temp receipt + `.work` | verify all bound identities, continue the rename |
| marker + temp receipt + intact tombstone | verify receipt and frozen tree, publish, then begin exact deletion |
| marker + final receipt + partial tombstone | verify every remaining cleanup entry and continue bottom-up deletion |
| marker + final receipt; no Body/tombstone | verify receipt, unlink its exact acceptance input, then marker |
| receipt only; no Body/tombstone | clean an exact redundant acceptance input if present; return receipt |
| any other combination, digest drift, or unknown collision | refuse without deletion |

The implementation exposes stable private refusal codes rather than parsing
error prose: `ACCEPTANCE_INVALID`, `AUTHORITY_OPEN`, `WRITER_ACTIVE`,
`QUIESCENCE_UNAVAILABLE`, `RESULT_DRIFT`, `UNSAFE_BODY`, `BODY_DRIFT`, `CUSTODY_COLLISION`,
`FINALIZATION_CONFLICT`, and `LIMIT_EXCEEDED`. Every refusal occurs before the
first unlink except a validated restart that is already in receipt-published
cleanup.

## 5. Non-negotiable invariants

1. **Acceptance owns promotion.** Worker `FINAL`, a green test, runtime
   finality, elapsed time, and disk pressure cannot authorize sealing.
   Explicit abandonment may authorize Body disposal but can never claim an
   accepted result.
2. **Immutability is not immortality.** An active-run artifact is never edited;
   a terminal receipt may supersede its retention need.
3. **Custody is untouchable.** The Body sealer cannot delete or traverse
   runtime state/effect namespaces or managed report compatibility paths.
4. **Uncertainty retains bytes.** `CLAIMED`, `UNKNOWN`, malformed evidence,
   open writers, ambiguous state, or changed filesystem identity fail closed.
5. **Exclusion precedes publication; publication precedes deletion.** The
   existing release exclusion and managed bridge/writer claims are held before
   Body inspection. The continuation marker and staged receipt are durable
   before the Body namespace moves; no byte is deleted until the frozen Body
   revalidates and the receipt is published. The marker is removed only after
   the tombstone is absent and its parent is synced.
6. **One exact payload namespace.** V1 deletes payload only from `.work` or its
   receipt-bound tombstone. The only other unlinks are fixed-path private
   transaction inputs/claims whose exact bytes are validated against the
   receipt. It never infers disposable files from Markdown, timestamps,
   extensions, or missing references.
7. **No global controller.** Mutation always names one run explicitly. Audits
   may enumerate states read-only; no background sweeper exists.
8. **No context resurrection.** Future runs cite Outcome/receipt/ADR, not old
   reports or raw evidence.
9. **Required product artifacts are product.** Documentation, accessibility,
   fixtures, and proof required by project authority remain in normal source;
   only orchestration working memory is disposable.
10. **Exact old behavior when disabled.** Legacy layout, runtime bytes, public
    exports, bridge paths, and resume behavior stay unchanged until a run opts
    into the new Body layout.

## 6. Implementation roadmap

### MVP-A - Stop new amplification (doctrine and placement)

First internally bisectable step, no runtime changes:

- `.gitignore`: add the fixed private patterns
  `Lunacy/runs/*/.work/`, `Lunacy/runs/*/.work.prune-*`,
  `Lunacy/runs/*/.RUN-RECEIPT.json.tmp`,
  `Lunacy/runs/*/.ABANDON-RECEIPT.json.tmp`,
  `Lunacy/runs/*/.lunacy-run-finalization.json`, and
  the bounded private files `Lunacy/runs/*/.lunacy-parent-acceptance.json`,
  `Lunacy/runs/*/.lunacy-parent-abandonment.json`,
  `Lunacy/runs/*/.lunacy-release-exclusion.lock`, and
  `Lunacy/runs/*/.lunacy-body-writer.lock`; L2 separately adds
  `Lunacy/runs/*/.work.migrate-tmp/` and
  `Lunacy/runs/*/.lunacy-body-migration.json` when migration ships.
- `WORKSPACE.md`: define Seed/Body/Custody, future run layout, and terminal
  lifecycle; change “immutable” to “immutable while retained.”
- `SKILL.md`: route raw evidence and non-runtime gate/report material to Body;
  require outcome/seal after final parent acceptance.
- `worker/ENGINEERING.md`: make temporary output the default; a worker may
  promote only its bounded terminal control surface. Manual Body writers use
  `withBodyWriterAdmission` for the full open/write/fsync/publish lifetime.
- `orchestrator/PLANNING.md`: forbid durable product docs from depending on
  Body paths and forbid retention/report/proof nodes in the Plan.
- `test/worker-routing-policy.test.js`: assert the new doctrine and ensure
  `CLAIMED`/`UNKNOWN` custody language remains exact.

MVP acceptance:

- a new ordinary run writes all raw logs/evidence under `.work`;
- managed report and bridge paths remain byte-compatible;
- no existing run is moved or deleted;
- package-root exports and runtime schemas do not change.

This step is not deployed by itself: without the sealer it would exchange Git
growth for ignored disk growth. Rollback before the combined MVP gate is a
documentation/layout revert; existing `.work` remains harmless local data.

### MVP-B - Private per-run sealer

- `src/release-admission.ts` and `src/release-operation.ts`: extract the exact
  single-run exclusion described above from existing owned-file claims; do not
  duplicate acquisition, stale-owner, release-order, or admission logic. Add
  the mutually exclusive `withBodyWriterAdmission` wrapper in the same module.
- `src/run-retention.ts`: private closed receipt/marker validators, bounded
  no-follow traversal, deterministic aggregate digests, pure preflight, and the
  crash-idempotent receipt/rename/prune transaction. Do not export it from
  `src/index.ts`.
- `tools/seal-run.mjs`: private implementation behind the verified runtime
  launcher. The launcher exposes explicit `admit-body --run-root`, atomic
  `seal-run --accept-runtime-pass` (capsule plus exact PASS submission),
  `seal-run --prepare-manual`, `seal-run --dry-run`, `seal-run --accept`, and
  `seal-run --resume`, with the closed manual/runtime acceptance variants and
  stable refusal codes. There is no detached runtime-prepare command.
- `tools/with-body-writer.mjs`: take the Body writer claim around one bounded
  atomic artifact publication after a child has exited; the child writes only
  an external wrapper-owned temp. Propagate exit/cancellation, drain the child
  process group, and release only after Body rename/fsync.
- `test/run-retention.test.js`: focused behavioral, race, and fault-injection
  suite.
- `README.md`, `docs/RECOVERY.md`: operation, irreversibility, and recovery.
- `tools/deploy-skill.mjs` and deployment tests: include the private tool only
  if installed Lunacy invokes it.

Preflight refuses before mutation for wrong run identity, invalid or missing
acceptance witness, missing Outcome, nonterminal authority, open
barrier/workers, unresolved current-frame work, unsafe roots, symlinks, path
escape, hardlinks, entry/byte ceiling, existing conflicting receipt/marker, or
concurrent change. A same-path nested mount/device boundary is unsafe. It
preserves unknown run-root siblings.

Fault cuts to test: staged receipt write/fsync; continuation marker write/fsync;
Body rename; frozen digest recheck; receipt rename/fsync; every cleanup step;
tombstone rmdir/fsync; continuation marker unlink. Restart exposes the Body, a
reversible pre-publication tombstone, or one valid receipt/marker recipe and
converges idempotently.

Exclusion tests hold a real bridge/store/managed-launch entrant, prove the
sealer waits, then prove a held sealer makes new bridge, store, orchestration,
supervisor, and manual Body admissions refuse. A crash-resume test proves a
continuation marker without a live claim never authorizes deletion: the new
process must reacquire all applicable claims and revalidate the tombstone.
Deterministic barriers pause a Body writer between its first admission check
and claim, and again during an open write while the sealer reaches frozen
recheck; in both schedules either the complete write precedes sealing or
admission refuses, with no accepted partial/lost output.
Kill the wrapper while its child is still alive and prove the child can write
only the external temp; stale claim recovery plus sealing must never expose a
live Body descriptor.
Platform fixtures exercise zero/open-handle snapshots, missing/denied
inspectors, a nested device mismatch, and a same-device bind mount/mount-point
identity mismatch both at Body root and nested beneath it (using a synthetic
filesystem adapter only when the test host cannot create the mount).

MVP-A and MVP-B may be separate commits for review, but they share one release
gate and rollout flag. Deployment never admits the new Body layout without the
matching sealer/recovery path.

Required compatibility tests are behavioral, not doctrine-only:

- `test/bridge.test.js` preserves the exact run-root `STATE.md` and
  `phases/<phase>/STEPS.md` projection paths from `src/bridge.ts`.
- existing Codex host/effect tests preserve the managed report path from
  `src/codex-host-policy.ts` and restart report verification from
  `src/codex-effect-records.ts`.
- a new sealer integration fixture proves `.kernel`, `.codex-effects`, managed
  `phases/*/reports`, and an external deliberation `evidenceRoot` cannot be
  traversed or deleted even when names collide with Body entries.
- product-surface tests prove `src/index.ts`, event/state/yield schemas, legacy
  run bytes, and disabled behavior are unchanged.
- deployment tests add both `seal-run.mjs`, `with-body-writer.mjs`, and their
  compiled private modules to the exact `tools/deploy-skill.mjs` payload and
  preserve tamper rejection.
- acceptance/result fixtures prove: forged Markdown cannot replace the closed
  manual witness; a runtime witness is reconstructed from verified
  candidate/CURRENT/state/journal; PASS followed by a product change refuses;
  a clean commit that drifts after preflight refuses;
  dirty and untracked product surfaces use the explicit manifest while
  excluding `Lunacy/**`; and outcome/result digest disagreement refuses before
  mutation.
- a cross-process dirty-tree fixture prepares acceptance, kills that process,
  then proves a fresh sealer reconstructs the embedded roots/entries and either
  seals the identical product tree or refuses exact drift.
- a table-driven fixture reaches every stable refusal code and asserts the
  filesystem tree is byte-for-byte unchanged; fault tests assert only the
  closed crash table above is resumable.

### MVP-C - Explicit abandoned-run disposal

This is independently reversible but required before claiming interrupted-run
storage is bounded:

- extend the private sealer core—not runtime events/state—with the exact
  abandonment input and `ABANDON-RECEIPT.json` contract above;
- add `seal-run --abandon --authority <canonical-file>`; never infer authority
  from `STATE.md`, mtime, disk pressure, or a stopped worker;
- reuse release/Body-writer exclusion, mechanical quiescence, no-follow/device
  traversal, cleanup cursor, and crash table without a second deletion engine;
- add `test/run-abandonment.test.js` for explicit authority, ACTIVE/PENDING/
  CLAIMED refusal, UNKNOWN custody preservation, stale worker/handle refusal,
  crash cuts, and exact ACCEPTED-versus-ABANDONED receipt separation;
- make `audit-run-artifacts.mjs` list abandonment candidates read-only, with no
  automatic action.

Rollout is off by default. Rollback disables the CLI mode; existing abandonment
receipts remain truthful terminal Seed records and retained Custody remains
untouched.

### L2 - Legacy audit and one-run migration

Concrete seams are private `src/run-body-migration.ts`, read-only
`tools/audit-run-artifacts.mjs`, explicit `tools/migrate-run-body.mjs
--run-root <path> --accept`, and `test/run-body-migration.test.js`. None are
package-root exports.

Ship read-only audit first. For each explicitly selected legacy run report:

- terminal status and barrier truth;
- advisory inbound textual references from outside the run;
- evidence/report/gate counts and bytes;
- runtime-bound report/effect paths;
- proposed Seed, Body, Custody, and refusal reasons.

Reference scanning can refuse migration but can never authorize a file as
disposable. Eligibility comes from a fixed legacy allowlist, explicit custody
discovery, and refusal of every ambiguous report/path. Every detected durable
inbound reference must be rewritten to Outcome/receipt before acceptance; any
unscannable or unresolved reference refuses the pilot.

Pilot one small Git-backed, Markdown-only `COMPLETE` run:

1. Under the same run exclusion, copy each exact allowlisted legacy file to
   fixed `<run-root>/.work.migrate-tmp`, verify/fsync every destination and the
   aggregate source-to-Body digest, rename the temporary tree to `.work`, and
   fsync the run root.
2. Publish `<run-root>/.lunacy-body-migration.json` with the ordered source
   identities and destination tree digest. Release exclusion. **Do not unlink
   a legacy source yet.**
3. Rewrite durable references, run the zero-unresolved-reference audit, and
   include those changed product surfaces in the required
   `lunacy-product-manifest/v1` result identity (the clean-commit variant is not
   eligible for L2). The parent then accepts the migration result and normal
   sealing publishes `RUN-RECEIPT.json` and prunes `.work`.
4. Reacquire exclusion. Require the accepted receipt's Body tree digest to
   equal the migration marker and require the reference audit to remain clean.
   Only then unlink exact marker-bound legacy sources one by one, sync their
   parents, remove empty allowlisted directories, and delete the migration
   marker last.

The receipt is therefore durable before the first legacy-source unlink. A
crash before receipt publication leaves all original sources; a crash after it
has the accepted migration map needed to continue. Unknown or changed source
entries refuse and remain in place. Fault tests cut every copy, fsync, rename,
marker, reference-rewrite, receipt, and source-unlink boundary. Do not bulk
migrate the current nine completed runs, the stopped run, or any managed run
with ambiguous custody.

The migration marker schema is `lunacy-body-migration/v1` and has exactly
`runId`, `sourceRoot` (`dev`, `ino`), `entries` (sorted records of
`relativePath`, `dev`, `ino`, `mode`, `size`, `digest`), `body` (`dev`, `ino`,
`treeDigest`, `files`, `bytes`), and `phase="BODY_PUBLISHED"`. It rejects the
same unsafe path/file kinds and ceilings as the sealer. Its closed recovery
table is:

| Exact state under run exclusion | Recovery |
| --- | --- |
| temp tree only; all sources present | remove the verified temp or recopy and publish `.work` |
| `.work` without marker; all sources present | verify it against sources, then publish the marker |
| marker + `.work` + all sources; no receipt | preserve sources; complete references, acceptance, and normal sealing |
| marker + finalization tombstone/marker | defer entirely to normal sealer recovery |
| marker + matching receipt; no Body + any exact source subset | verify reference audit; continue exact source unlinks |
| marker + matching receipt; no Body/sources | unlink marker; migration is complete |
| `.work`/marker collision, changed source, or unknown absence | refuse without further unlink |

No recovery path recopies a source already recorded absent, guesses from a
partial directory, or removes an unbound temp tree. A read-only audit reports
abandoned temp/marker states so they do not become a second silent residue
class.

Because the pilot's legacy artifacts are tracked, post-prune rollback is `git
restore` followed by aggregate-digest verification. The receipt alone
deliberately cannot reconstruct deleted bytes; export is outside V1.

### L3 - Bounded runtime hygiene, independently reversible

Only after the MVP measurements show session growth is fixed:

1. Characterize `.kernel/quarantine`: entry shapes, byte growth, forensic
   value, crash windows, and whether any recovery path ever reads it.
2. Add a private, explicit foreground diagnostic compactor under the existing
   store fence. It may delete only exact trusted quarantine identities proven
   unreachable from verified `CURRENT` and retention pins; malformed material
   stays quarantined. No startup cleanup.
3. Characterize managed evidence and report-path reachability after `ACKED`
   and final acceptance. Only if the committed state contains a sufficient
   exact settlement witness, add a compact scar receipt and delete the exact
   settled token capsule. `CLAIMED`, `UNKNOWN`, missing, malformed, or
   conflicting chains remain forever protected.

Likely seams are `src/store.ts`, `src/codex-effect-records.ts`,
`src/codex-deliberation-driver.ts`, `src/release-quiescence.ts`,
`docs/DURABILITY.md`, `docs/CODEX_EXEC.md`, `test/storage-retention.test.js`,
and the existing supervisor/recovery tests. Do not couple this release to the
session receipt schema or overload `ArtifactStore.compact()` with human-run
lifecycle policy.

## 7. Verification and success measures

Correctness gates for the V1 sealer:

- no deletion before parent acceptance and durable receipt publication;
- zero payload deletion outside exact Body/tombstone identities; L2 is a later
  separately accepted migration and may unlink only receipt- and marker-bound
  legacy duplicates after the reference guard passes;
- zero deletion of unresolved or malformed effect evidence;
- old-or-new crash recovery at every publication boundary;
- exact repeated seal result and idempotent partial-cleanup continuation;
- legacy bridge, public runtime, replay bytes, and installed deployment checks
  unchanged.

Outcome measures for a frozen representative run:

- **durable amplification:** retained orchestration bytes after acceptance /
  Body bytes before acceptance; target below 0.10 for a non-managed run;
- **raw-evidence retention:** V1 target 0 Body bytes in the repository after
  seal;
- **interrupted-run retention:** 0 Body bytes after an explicit MVP-C
  abandonment; unreviewed ACTIVE/BLOCKED runs remain visible candidates rather
  than silently expiring;
- **resume surface:** same bounded Seed read set as today, with no Body read;
- **custody loss:** 0 files and 0 bytes from unresolved effect closures;
- **seal cost:** one foreground O(Body files + bytes) pass and no work on normal
  resume/dispatch.

File count, evidence count, and report count are diagnostics, not product
success. Accepted product behavior and exact recovery remain the gate.

## 8. Explicit non-goals and traps

Do not implement in the MVP:

- a global CAS/blob pool, refcount database, or persistence MMU;
- reader epochs or renewable leases for correctness evidence;
- timer/age/size eviction, background GC, or boot-time sweep;
- cryptographic signatures and key custody where hashes suffice;
- universal replay recipes for nondeterministic tools/external services;
- a schema/event that lets runtime accept, abandon, archive, or resolve a run;
- per-file retention receipts or a classifier that guesses from report prose;
- quarantine as the final cleanup answer;
- hard budgets that divert or drop required evidence.

Those mechanisms add more durable metadata—the exact failure mode being fixed.

## 9. ADHD decision record

### Brief

Reframe: Lunacy does not have a generic “memory leak”; it has retention by
default, control/payload co-location, and no terminal promotion boundary.

### Wide set by mechanism

Scores are `[novelty viability fit]`; `TRAP` means the attractive form is
unsafe or overbuilt for this problem.

**Transactional workspace / selective promotion**

- H1 write-once run segment + tiny promotion record `[N7 V8 F9]`
- H2 persistence MMU over physical generations `[N8 V5 F6]` **TRAP**
- R5 expendable capsule -> manifest-selected result `[N5 V9 F10]`
- S1 anonymous temp run + tiny promoted manifest `[N5 V9 F10]`
- S5 disposable invocation home + allowlisted export `[N6 V8 F9]`
- B1 germline/Seed + disposable body `[N8 V8 F9]`
- B5 active write/seal rhythm + sweep unlisted Body `[N7 V9 F10]`
- O1 disposable workspace + typed export `[N4 V10 F10]`
- O4 complete-next-generation pointer swap `[N5 V8 F8]` **TRAP** when
  generalized to immutable evidence

**Manifest-rooted liveness / collection**

- H3 manifest-derived CAS cache `[N6 V7 F7]`
- H5 boot-time root mark/sweep `[N5 V7 F8]` **TRAP**
- H6 reader-pinned reclamation epochs `[N7 V5 F6]` **TRAP**
- R3 custody graph rooted in accepted outcomes `[N7 V8 F9]`
- S3 one CAS pool rooted by durable manifests `[N5 V8 F8]`
- S4 renewable artifact leases `[N5 V6 F7]` **TRAP** for custody
- B2 trophic leases + grace deletion `[N8 V7 F8]` **TRAP** for uncertainty
- O2 signed-manifest/lease CAS `[N6 V8 F9]`
- O6 startup invariant checker/quarantine `[N5 V8 F8]` **TRAP** without
  terminal reclamation

**Semantic compression / reconstructible witnesses**

- H4 control and payload lanes `[N5 V9 F10]`
- R2 compact checkpoints + input hashes `[N6 V6 F8]` **TRAP** if universal
- R4 operation-specific proof schemas `[N6 V7 F8]`
- S2 fold replay stream then truncate `[N7 V6 F7]` **TRAP** if generalized
- B3 open wound -> compact scar after accepted repair `[N8 V8 F9]` ★
- B4 promote only validated, decision-cited facts `[N8 V7 F8]`
- O3 replay recipes instead of proof bundles `[N6 V6 F7]` **TRAP** if
  nondeterministic

**Retention governance / accountable disposal**

- R1 durable-write admission receipt `[N6 V9 F10]`
- R6 compact disposal certificate `[N7 V8 F9]`
- S6 retention by reconstruction cost `[N6 V7 F7]` **TRAP** as authority
- B6 class carrying capacities `[N6 V6 F7]` **TRAP** for required evidence
- O5 persistence-budget capability tokens `[N7 V5 F6]` **TRAP**

### Converge

1. **B5 - sealed Body:** highest weighted score (8.55); supplies the atomic
   lifecycle missing today.
2. **B1 - Seed/Body split:** weighted 8.25; makes deletion structural and keeps
   normal resume small.
3. **B3 - wound/scar:** weighted 8.25 and ★ non-obvious-but-viable; preserves
   failure knowledge without retaining every repair payload.
4. **R1/R6 - admission + disposal receipt:** weighted 8.20/7.90; useful as a
   narrow receipt boundary, but not as per-file bureaucracy.

The architecture combines the first two immediately. It reserves wound/scar
for settled runtime evidence in L3, where its extra machinery is actually
earned.

**Trap list**

- H2 persistence MMU - adds indirection/generation authority before any need
  for stable logical artifact identities.
- H5 boot sweep - an incomplete root set can erase unresolved evidence during
  startup, the worst possible recovery time.
- H6 reader epochs - mostly single-writer run storage does not justify an epoch
  reclamation protocol.
- R2/S2/O3 universal checkpoint or replay - external tools, services, mutable
  inputs, and nondeterminism are not reconstructible from hashes alone.
- S4/B2 leases - process death or delayed renewal must not expire the only
  `CLAIMED`/`UNKNOWN` witness.
- S6 reconstruction-cost retention - estimated cost cannot decide semantic or
  legal necessity.
- B6/O5 capacities and write budgets - pressure must not evict or divert
  correctness evidence at the worst moment.
- O4 delete-prior-generation generalization - correct for replaceable control
  generations, unsafe for immutable referenced evidence.
- O6 quarantine-only cleanup - renaming residue without an adjudication and
  deletion seam merely moves the leak.

### Focus

**Sealed Body.** Work happens in a declared disposable namespace. The parent
takes the existing run exclusion, freezes the Body by exact namespace rename,
revalidates it, publishes the minimal accepted receipt before the first unlink,
and removes the continuation marker last. The load-bearing risk is
misclassifying recovery evidence; structural Custody exclusion removes that
classifier from L1. First build the pure receipt/marker validator and a red
test showing no mutation before accepted authority.

**Seed/Body.** Current authority and accepted outcome survive; logs, surveys,
gate navigation, and non-runtime reports are active-run tissue. The
load-bearing risk is a hidden runtime path reference, which is why V1 preserves
managed report compatibility paths and never sweeps `phases/` wholesale.
First build a read-only inventory that proves the 87.8% evidence class can move
without changing bridge/effect paths.

**Wound/scar.** An unresolved failure/effect remains an open, non-expiring
root. An explicit accepted successor may publish a compact cause/fix/identity
scar before exact evidence cleanup. The load-bearing risk is an incomplete
protected-root closure; first build a pure planner whose default for
`CLAIMED`, `UNKNOWN`, malformed, or foreign refs is refusal. Do not put this
mechanism in the session sealer.

### Provocation

What if a “run” were considered failed to finish until its accepted outcome was
small enough to hand to a new parent without opening any worker report? That
makes memory quality—not artifact production—the final workflow invariant.
