# Lunacy session-artifact lifecycle implementation roadmap

**Status:** implementation-ready roadmap; no runtime behavior is implemented by
this document.

**Architecture authority:**
[`SESSION_ARTIFACT_LIFECYCLE.md`](./SESSION_ARTIFACT_LIFECYCLE.md).

**Objective:** make the Seed/Body/Custody architecture straightforward to
implement without changing public runtime/event/state bytes, existing bridge
projections, managed report paths, or effect custody. A successful accepted run
must retain a compact Seed, prune its exact disposable Body, and leave Custody
untouched. A stopped run is pruned only through explicit abandonment authority.

This roadmap is deliberately more mechanical than aspirational. It names the
files, functions, commit order, red/green tests, release gates, canaries,
rollback actions, and conditions that stop work.

## 1. How to execute this roadmap

### One owner per accepted release, several bisect points

Execute each independently reversible release as one largest-coherent owner
cell:

1. read-only doctor (`D0`-`D2`, R1);
2. core accepted-run lifecycle (`D3`-`D9`, R2);
3. explicit abandonment (`A0`-`A2`, R3);
4. one-run legacy migration (`M0`-`M3`, R4).

The read-only/mutating boundary is a real safety and rollback boundary, not a
planning milestone. Within a release, one owner holds the product-source claim
for its modules, tools, doctrine, and focused tests. The numbered cells are
commit/review/bisection points, not Plan nodes, worker milestones, or separately
accepted outcomes. Parent acceptance happens only at the release gates in
section 3.

Use a measured context/tool-capacity split within R2 only if one owner cannot
finish safely. Split into the fewest vertical acceptance-required slices, never
into “write plan,” “add tests,” “collect proof,” or “make report” owners.
Test and review agents are read-only against the candidate; they do not take
product ownership or repair files behind the implementation owner.

### Seal authority before the first implementation dispatch

The parent records, in the existing Plan/run authority:

- user/project requirements;
- accepted observable result;
- chosen Seed/Body/Custody spine;
- compatibility corridors;
- exact release cell being implemented;
- product file ownership;
- rollout and rollback boundary.

Changed authority starts a new Plan/run authority. Do not drip-feed architecture
changes into a live implementation owner.

### Recommended Lunacy routing

- **Implementation owner:** one Sol/high owner for the current accepted release.
  In R2, lock order, acceptance identity, crash publication, recovery, doctrine,
  and deployment form one correctness surface.
- **Tester:** one independent read-only tester after the owner publishes the
  candidate; it runs the focused/fault/broad matrix and reports observations.
- **Reviewer:** one independent Sol/high reviewer sees the exact diff and check
  observations; it checks deletion authority, crash prefixes, compatibility,
  and rollback.
- **Parent:** evaluates the observable and decides PASS/FINDINGS. Worker PASS is
  not acceptance.

## 2. Fixed compatibility corridors

These surfaces are frozen throughout `D0`-`D9`:

| Corridor | Current seam | Rule |
| --- | --- | --- |
| Public event/state/yield bytes | `src/model.ts`, `src/public.ts`, `src/store.ts` | No new public event, state field, migration, or normalized replay bytes. |
| Parent gate | `PARENT_DECISION PASS` plus private acceptance capsule | PASS semantics stay unchanged; lifecycle authority is verified outside the public event schema. |
| Bridge projections | `src/bridge.ts` | Keep exact run-root `STATE.md` and `phases/<phase>/STEPS.md`. |
| Managed reports | `src/codex-host-policy.ts`, `src/codex-effect-records.ts` | Keep exact `phases/<phase>/reports/<step>-worker-<attempt>.md`. |
| Runtime custody | `.kernel`, `.codex-effects`, external `evidenceRoot` | Body traversal cannot enter or delete these paths. |
| Package exports | `src/index.ts`, `package.json` | Retention modules remain private; no package-root exports. |
| Existing runs | `Lunacy/runs/*` | No automatic move, migration, or deletion. |

Any corridor drift is parent FINDINGS. Do not “update the snapshots” unless the
user separately changes compatibility authority.

## 3. Release map

| Release | Included cells | Live mutation | Default admission | Acceptance outcome |
| --- | --- | --- | --- | --- |
| **R0 Architecture** | current architecture + this roadmap | none | legacy | reviewed implementation authority |
| **R1 Doctor** | `D0`-`D2` | none | legacy | installed read-only diagnosis with byte parity |
| **R2 Lifecycle V1** | `D3`-`D9` plus R1 | exact accepted Body only | initially OFF, then canary ON | new runs use Body and accepted runs converge to receipt + no Body |
| **R3 Abandonment** | `A0`-`A2` | explicit abandoned Body only | explicit command only | stopped/blocked Body is pruned without claiming an accepted result |
| **R4 Legacy pilot** | `M0`-`M3` | one allowlisted Git-backed run | explicit command only | legacy source duplicates removed only after accepted receipt/reference clearance |
| **R5 Runtime hygiene** | earned later | exact settled custody only | OFF | quarantine/effect growth reduced without coupling to session sealing |

R1 may deploy independently because it is read-only. R2 is one coupled release:
do not enable new Body placement without the full writer, acceptance, recovery,
and cleanup path. R3 and R4 remain independently reversible.

## 4. One private admission switch

Do not create a flag per cell. Add one installed private policy file:

`runtime/retention-policy.json`

```json
{"schema":"lunacy-retention-policy/v1","newBodyAdmission":"OFF"}
```

The only valid values are `OFF` and `ON`.

- `OFF`: do not create `.work` for a new run. Existing `.work`, finalization
  markers, tombstones, and receipts remain readable/recoverable.
- `ON`: new runs use the Body layout. Existing legacy runs remain unchanged.
- Disabling is asymmetric: it stops new admission immediately but never removes
  the doctor, validators, resume path, or exact cleanup needed by admitted runs.
- Presence of an existing `.work`/marker/receipt is the run-local admission
  fact. Do not add a runtime state field or epoch.

`tools/deploy-skill.mjs` installs the canonical policy inside its existing
managed `runtime/**` transaction and includes it in `DEPLOYMENT.json`. Its
closed option is `--retention-admission OFF|ON`; `--check` takes the same option
and rejects a different installed value. No runtime environment variable
silently overrides the installed bytes.

Policy replacement and first-Body creation share one stable installed-target
claim outside the atomically replaced runtime subtree:
`<skill-root>/.lunacy-retention-admission.lock`. Deploying `OFF` holds that
claim while it
atomically replaces and syncs the policy. The private `admitRunBody` operation
holds the same claim while it reads canonical `ON`, takes the run release and
Body-writer claims, rereads `ON`, exclusively creates `.work`, fsyncs `.work`
and the run root, and releases in reverse order. Claim order is therefore the
ON→OFF linearization point: when an OFF deployment returns, no later Body can
be admitted under the old bytes. Existing `.work` recovery never takes or
consults this policy claim.

This policy claim is **global lock rank 0**. Every policy-changing deployment
acquires it before entering `withReleaseExclusion`; admission orders policy →
run release → Body writer. Finalization does not need the policy claim and keeps
run release → Body writer → managed bridge → managed writer. No code may acquire
the policy claim while holding any run or managed claim.

`withBodyWriterAdmission` never creates `.work`. It requires an already
admitted live `.work` and refuses any final receipt, finalization marker,
tombstone, or abandonment receipt. This prevents an ordinary writer from
recreating Body after sealing.

Retire the policy switch only after two releases have shipped with admission
ON, no supported pre-V1 installation remains, and rollback no longer requires
stopping new layout creation.

## 5. Core implementation cells

The implementation dependency chain is intentionally linear:

| Cell | Consumes | Produces for the next cell | Stop condition |
| --- | --- | --- | --- |
| D0 | current public/runtime behavior | frozen byte/path/export witnesses | baseline needs product code changes |
| D1 | D0 witnesses + architecture records | one pure validator/classifier | any filesystem effect in the core |
| D2 | D1 classifier | inert doctor + installed diagnostic path | source/installed classifications differ |
| D3 | existing release claims | one writer/finalizer exclusion order | an interleaving permits a partial write |
| D4 | D3 writer admission | supported atomic Body publication | child can retain a Body descriptor |
| D5 | D1 records + current decision inbox | one capsule-and-PASS parent operation | PASS can commit without its capsule |
| D6 | D3 exclusion + D1 records | bounded inventory/quiescence/cursor | platform facts are missing or ambiguous |
| D7 | D5 acceptance + D6 plan | reversible rename-only prefixes | any Body payload unlink is reachable |
| D8 | D7 restart table | published receipt + resumable exact cleanup | first unlink can precede durable receipt |
| D9 | D0-D8 | admitted placement + verified install + canary | deploy cannot recover every admitted state |

Do not begin a row until its consumed outputs are green. A commit may be
locally bisected, but only R1 and the complete R2 candidate are deployable.

### D0 — Freeze the observable baseline

**Purpose:** make “no compatibility drift” executable before adding lifecycle
code.

**Files**

- add `test/session-lifecycle-compat.test.js`;
- add minimal tracked fixtures under `test/fixtures/session-lifecycle/`;
- do not copy mutable `Lunacy/runs` evidence into fixtures.

**Test cases**

1. Run a canonical public START → worker settlement → GATE → PASS journey and
   store canonical yield/state/event byte digests.
2. Restart from committed CURRENT and prove identical output bytes.
3. Project bridge state and assert the exact `STATE.md` and `STEPS.md` paths.
4. Create a managed Codex policy and assert the exact report path.
5. Assert `src/index.ts` exports and `package.json` exports are unchanged.
6. Assert the legacy run tree is byte-for-byte unchanged when retention
   admission is OFF.

**Commands**

```bash
npm run build
node --test test/session-lifecycle-compat.test.js
```

**Green gate:** the test passes against the unmodified runtime. If it requires a
runtime code change, the fixture is coupled to implementation and must be
redesigned.

**Commit:** `test(retention): freeze lifecycle compatibility corridors`

### D1 — Closed private records and pure classification

**Purpose:** validate bytes and classify states before any mutation exists.

**Files**

- add `src/run-retention.ts`;
- add `test/run-retention-model.test.js`.

**Internal exports** (never from `src/index.ts`)

```ts
export type RetentionDisposition = 'ACCEPTED' | 'ABANDONED';
export type RetentionRefusalCode =
  | 'ACCEPTANCE_INVALID'
  | 'AUTHORITY_OPEN'
  | 'WRITER_ACTIVE'
  | 'QUIESCENCE_UNAVAILABLE'
  | 'RESULT_DRIFT'
  | 'UNSAFE_BODY'
  | 'BODY_DRIFT'
  | 'CUSTODY_COLLISION'
  | 'FINALIZATION_CONFLICT'
  | 'LIMIT_EXCEEDED';

export type RetentionDoctorCode =
  | 'LEGACY_LAYOUT'
  | 'BODY_ACTIVE'
  | 'READY_TO_SEAL'
  | 'RESUME_PRE_RENAME'
  | 'RESUME_PRE_PUBLISH'
  | 'RESUME_CLEANUP'
  | 'SEALED_CLEAN'
  | 'ABANDONED_CLEAN'
  | 'ATTENTION_UNSAFE_PATH'
  | 'ATTENTION_IDENTITY_DRIFT'
  | 'ATTENTION_CUSTODY'
  | 'ATTENTION_UNKNOWN_COMBINATION'
  | 'INCONSISTENT_READ';

export function validateParentAcceptance(value: unknown): ParentAcceptance;
export function validateRunReceipt(value: unknown): RunReceipt;
export function validateFinalizationMarker(value: unknown): FinalizationMarker;
export function classifyRetentionSnapshot(snapshot: RetentionSnapshot): DoctorResult;
```

Keep canonical parsing, exact-key validation, safe path rules, and SHA-256
helpers consistent with `src/canonical.ts`, `src/filesystem.ts`, and existing
release validators. Do not create a second canonical JSON implementation.

**Red tests**

- unknown/missing/extra keys;
- noncanonical bytes and oversized records;
- acceptance/result/authority digest disagreement;
- accepted versus abandoned receipt confusion;
- every closed doctor table row;
- unknown filesystem combinations classify as ATTENTION, never recovery.

**Green gate:** pure tests pass; module performs zero filesystem mutation and
has no package-root export.

**Commit:** `feat(retention): add closed records and pure state classifier`

### D2 — Read-only doctor

**Purpose:** ship diagnosis before mutation and make every crash prefix
operator-readable.

**Files**

- extend `src/run-retention.ts` with bounded double-census inspection;
- add `tools/seal-run.mjs` with doctor-only behavior;
- add the manifest-verifying `runtime/retention-launcher.mjs` template with only
  the `seal-run --doctor` entrypoint enabled in R1;
- add `test/run-retention-doctor.test.js`;
- extend `tools/deploy-skill.mjs` and deployment tests for the read-only tool.

**CLI**

```bash
node runtime/retention-launcher.mjs seal-run --doctor --run-root /absolute/run/root
```

**Output**

```json
{
  "schema": "lunacy-retention-doctor/v1",
  "code": "READY_TO_SEAL",
  "nextAction": "DRY_RUN",
  "protectedPaths": ["/absolute/run/root/.kernel"],
  "observed": {"body": true, "receipt": false, "marker": false, "tombstone": false}
}
```

`nextAction` is a closed enum: `NOOP`, `DRY_RUN`, `RESUME_EXACT`,
`REINIT_FRESH_ROOT`, or `PRESERVE_AND_ESCALATE`. It never contains shell text
or arguments derived from untrusted filenames.

**Inertness tests**

- compare bytes, mode, mtime, inode, and directory entries before/after doctor;
- run doctor twice and require identical semantic output;
- mutate between census A and B and require `INCONSISTENT_READ`;
- prove protected paths include Seed, Body, Custody, marker, tombstone, foreign
  siblings, and nearest trusted ancestor;
- prove doctor output is not accepted as mutation authority.

**R1 release gate**

```bash
npm run typecheck
npm run build
node --test test/session-lifecycle-compat.test.js test/run-retention-model.test.js test/run-retention-doctor.test.js
node --test test/r2-deployment.test.js test/product-surface.test.js
npm pack --dry-run
```

Deploy R1 with retention admission OFF. Its runtime payload is the verified
launcher, doctor-only sealer wrapper, classifier modules, and canonical OFF
policy; no mutation entrypoint is allowlisted. Rollback may remove the doctor
because R1 has created no durable transaction state.

**Commit:** `feat(retention): add read-only lifecycle doctor`

### D3 — Shared writer/finalizer exclusion

**Purpose:** close the write-versus-seal race at the existing ownership seam.

**Files**

- modify `src/release-admission.ts`;
- modify `src/release-operation.ts` only to extract/reuse claim ordering;
- add `test/run-retention-admission.test.js`.

**Internal API**

```ts
export async function withBodyWriterAdmission<T>(
  runRoot: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T>;

export async function admitRunBody(
  installedRuntime: string,
  runRoot: string,
  signal?: AbortSignal,
): Promise<'ADMITTED' | 'ALREADY_ADMITTED'>;

export async function withRunFinalizationExclusion<T>(
  runRoot: string,
  signal: AbortSignal | undefined,
  operation: (ownership: RunFinalizationOwnership) => Promise<T>,
): Promise<T>;
```

**Fixed lock order**

0. installed-target `.lunacy-retention-admission.lock`, only for admission or
   policy-changing deployment and always before every run claim;
1. run-root `.lunacy-release-exclusion.lock`;
2. run-root `.lunacy-body-writer.lock`;
3. managed `.kernel/.bridge.lock`;
4. managed `.kernel/.writer.lock`.

Body writer order is: check release open → acquire Body writer claim → check
release open again → publish/close/fsync → release. Finalizer order is release
claim → Body writer claim → managed claims → validate/mutate → reverse release.

Reuse `acquireOwnedFileClaim`, exact owner bytes, stale-owner rules,
cancellation, and reverse release. Do not write a new lock-file parser.
Use fixed domain-separated owner digests derived from
`lunacy-retention-admission/v1`, the physical installed runtime, the physical
run root, and the operation (`ADMIT`, `WRITE`, or `FINALIZE`); callers do not
supply claim-owner bytes. The installed-target policy claim and an empty
Body-writer claim use the existing dead-owner reclaim rules. A claim with an
open/ambiguous owner or malformed bytes refuses rather than being replaced.

**Race tests**

- writer wins, finalizer waits, complete publication is visible;
- finalizer wins, later writer refuses before Body open;
- pause writer between first check and claim, then acquire finalizer;
- pause writer while holding claim, attempt finalizer;
- three actors: deployment holds policy then waits for run release; finalizer
  holds run release/Body then waits for managed bridge; admission waits for
  policy. Release the preexisting bridge holder and prove all converge without
  any reverse-rank acquisition;
- stale wrapper owner with no Body descriptor is reclaimable;
- unsafe/malformed owner bytes refuse;
- OFF→admit, admit→OFF, duplicate admit, and policy replacement during admit
  linearize through the installed-target claim;
- Body writer requires active `.work` and refuses every receipt/marker/tombstone
  terminal combination;
- existing bridge/store/supervisor/orchestration admission still behaves
  byte-for-byte identically without a finalizer.

**Green gate:** every interleaving resolves to complete-write-before-seal or
refusal; no partial/lost output.

**Commit:** `feat(retention): share exact writer and finalizer exclusion`

### D4 — Body writer tool

**Purpose:** make supported manual output obey D3 without giving a child an open
Body descriptor.

**Files**

- add `tools/with-body-writer.mjs`;
- add `test/run-retention-writer.test.js`;
- do not change placement doctrine yet.

**Flow**

1. Validate absolute run root and fixed relative Body destination.
2. Spawn the child without a Body pathname.
3. Capture output into a no-follow wrapper-owned OS temp outside the run root.
4. Drain and wait for the complete process group.
5. Enter `withBodyWriterAdmission`.
6. Copy into a no-follow same-filesystem sibling under Body.
7. Verify byte count/digest, normalize mode, fsync, rename, and sync parent.
8. Release claim and remove external temp in `finally`.

Body creation is a separate installed launcher route:

```bash
node runtime/retention-launcher.mjs admit-body --run-root /absolute/run/root
```

It maps directly to `admitRunBody`, accepts no destination or policy override,
and is the only callable first-Body admission surface. The Body-writer route
can publish only after this succeeds.

**Tests**

- child success/failure/signal propagation;
- stdout/stderr and large bounded output;
- wrapper death while child survives: child has no Body descriptor;
- cross-volume OS temp uses copy, never direct rename/`EXDEV` fallback;
- destination collision, symlink, special file, hardlink, and mutation refusal;
- same destination concurrency produces exactly one accepted publication;
- temp cleanup on every failure path.

**Commit:** `feat(retention): add claimed atomic Body publication tool`

### D5 — Acceptance preparation and result identity

**Purpose:** bind the product result at the parent gate without changing
`PARENT_DECISION` bytes.

**Files**

- extend `src/run-retention.ts`;
- modify `src/decision-inbox.ts` only to factor its existing immutable
  decision/event identity construction for private reuse;
- extend `tools/seal-run.mjs` with private `--accept-runtime-pass` and
  `--prepare-manual` handlers;
- add `test/run-retention-acceptance.test.js`.

**CLI**

```bash
node runtime/retention-launcher.mjs seal-run --accept-runtime-pass \
  --inbox /abs/inbox.json --plan /abs/plan.json --run-root /abs/run \
  --run-id RUN --token TOKEN --event-id EVENT \
  --result-commit COMMIT_OID
node runtime/retention-launcher.mjs seal-run --prepare-manual \
  --run-root /abs/run --acceptance /abs/acceptance.json
```

`--accept-runtime-pass` is one parent-gate operation, not a detached prepare
step. Factor one private decision-submission constructor from
`src/decision-inbox.ts`; both the capsule and `submitParentDecision` consume
the same immutable event, event id, identity, inbox cursor, plan, policy, and
PASS value. The operation writes/fsyncs the capsule, then immediately submits
that exact PASS using the inbox revision as the existing CAS fence. Preparation
failure aborts before PASS. A cursor/CAS conflict triggers a fresh CURRENT/
state/journal read; the command result's `consumed` boolean alone is never
replacement authority. A later gate may replace the candidate only when that
fresh read proves both that the bound token remains unconsumed and that the
bound event identity is absent from committed/processed history. If an
identical concurrent submitter committed or replayed the event, reconstruct the
final witness from that exact history or refuse; never overwrite its capsule.
Do not reimplement event-id, payload-digest, or identity rules in retention code
and do not add them to the package-root exports.

The runtime candidate embeds pre-PASS CURRENT generation/state/revision, exact
gate token, proposed PASS event/event identity digests, authority, Outcome, full
result identity, and `activeWorkers="NONE"`. Success requires the submission
result to consume the token at exactly the next revision. Later sealing still
reconstructs the exact committed journal record and terminal successor.

The result identity is one of:

- clean commit object with exact repository root + commit OID; or
- embedded bounded `lunacy-product-manifest/v1` roots/entries/digests excluding
  `Lunacy/**`, runtime scratch, and receipts.

The runtime parent command accepts exactly one of `--result-commit OID` or
`--result-manifest FILE`; the manual acceptance value embeds exactly one of the
same closed variants. Conflicting or missing variants fail before capsule
publication.

**Tests**

- forged `STATE.md`/Markdown cannot authorize;
- wrong/consumed token and non-next PASS record refuse;
- an intervening committed event between capsule publication and submission
  returns a non-consuming conflict; the bound PASS never commits;
- concurrent identical submitters: a misleading `consumed=false` reply cannot
  authorize capsule replacement after the exact PASS is already durable;
- PASS then product/Outcome/authority change refuses;
- clean commit dirtying after prepare refuses;
- dirty/untracked manifest survives prepare-process death and revalidates in a
  fresh process;
- manifest path escape, duplicate root, `Lunacy/**` inclusion, or digest drift
  refuses;
- FINDINGS or failed PASS candidate can be replaced only after proving its
  token was not consumed;
- public event/state/journal bytes remain exact.

**Commit:** `feat(retention): bind parent acceptance to exact result identity`

### D6 — Trusted Body inventory and platform safety

**Purpose:** compute the only deletion candidate and refuse unsafe filesystem
topology before rename.

**Files**

- add `src/run-retention-platform.ts`;
- extend `src/run-retention.ts` with inventory/planning;
- add `test/run-retention-platform.test.js`;
- add `test/run-retention-inventory.test.js`.

**Internal platform interface**

```ts
export interface RetentionPlatform {
  captureRunSealQuiescence(
    installedRuntime: TrustedIdentity,
    runRoot: TrustedIdentity,
    body: TrustedIdentity,
  ): Promise<RunSealQuiescenceSnapshot>;
  captureMountIdentity(root: TrustedIdentity): Promise<MountSnapshot>;
}
```

V1 adapters and exact seams:

- reuse the bounded process snapshot parser and ownership checks from
  `src/release-quiescence.ts`; the returned receipt witness binds inspected
  process count/digest as well as zero Body/tombstone handles;
- macOS: execute the fixed absolute `/usr/sbin/lsof` with NUL-field output for
  process/descriptor facts and `/sbin/mount` for a bounded complete mount
  census. Parse only the closed expected grammar; a newline/path ambiguity,
  truncation, nonzero exit, missing binary, or ownership/mode/digest mismatch
  is `QUIESCENCE_UNAVAILABLE`;
- Linux: read bounded `/proc/<pid>/fd` identities plus
  `/proc/self/mountinfo`, using an opened-root `/proc/self/fd/<fd>` physical
  anchor. Decode only kernel mountinfo escapes, require one deepest mount row
  for every traversed path, and reject a mount-point row at or beneath Body.
  This fd-bound mountinfo mapping is the V1 mount-id seam; do not add a native
  `statx` dependency unless characterization proves it necessary;
- `tools/deploy-skill.mjs` records the fixed helper executable identities used
  by the installed adapter. The manifest-verifying launcher rechecks them at
  invocation. Unsupported, denied, incomplete, changed, or ambiguous platform
  data fails closed.

**Inventory rules**

- fixed `.work` root only;
- bounded entry and byte count;
- no symlink, special file, hardlink, path escape, invalid UTF-8, duplicate byte
  path, or concurrent identity/content drift;
- Body/tombstone shares the trusted run-root parent mount identity;
- no mount point at or beneath Body;
- every entry stays on the root device/mount;
- `.kernel`, `.codex-effects`, managed report paths, external evidence roots,
  and unknown run-root siblings are outside traversal.

Produce aggregate tree digest plus a temporary cleanup-entry cursor containing
the exact file/directory identities needed for partial-deletion recovery.

**Tests**

- normal, empty, max-bound, and ceiling-overflow trees;
- all unsafe file kinds and path encodings;
- root-level and nested bind mounts, including same-device bind mounts;
- mount snapshot unavailable/ambiguous;
- zero/live open handles and double snapshot drift;
- live owned process group with no open Body descriptor still refuses;
- managed/custody names colliding beneath foreign siblings are never traversed;
- inventory is pure and deterministic.

**Commit:** `feat(retention): add fail-closed Body inventory and quiescence`

### D7 — Rename-only finalization engine

**Purpose:** prove every reversible crash prefix before implementing unlink.

**Files**

- extend `src/run-retention.ts` with staged transaction/recovery;
- extend `tools/seal-run.mjs` with test-internal rename-only/resume functions;
- add `test/run-retention-rename-faults.test.js`.

**Transaction prefix**

1. acquire D3 exclusion;
2. validate acceptance/state/result;
3. capture initial zero-handle quiescence;
4. inventory Body and build cleanup cursor;
5. write/fsync complete staged receipt;
6. write/fsync continuation marker;
7. rename `.work` to full-receipt-digest tombstone;
8. sync run root;
9. revalidate tombstone/Seed/result;
10. capture the second zero-handle publication gate;
11. **stop without publishing a final receipt or unlinking Body payload** only
    through a test-injected closed fault point.

The production CLI has no `stage-only` mode. The source implementation contains
no reachable unlink/rmdir of Body or tombstone payload in this cell. Add a
test-only fault callback with a closed fault-point enum; a child fixture exits
hard at each point so recovery is tested across process death, not merely thrown
exceptions. Exact claim-file release and verified orphan staged-temp cleanup
remain allowed and are excluded from the payload-unlink counter.

**Required outcomes**

- pre-rename crash: live Body remains;
- post-rename/pre-receipt crash: exact tombstone remains and resumes or restores;
- ambiguity/drift: ATTENTION, preserve bytes;
- repeated resume: same semantic result;
- zero Body/tombstone payload unlink or rmdir calls in all D7 tests;
- D0 compatibility digests unchanged.

**Commit:** `feat(retention): add reversible rename-only finalization`

### D8 — Receipt publication and exact cleanup

**Purpose:** add the first irreversible instruction only after D7 is green.

**Files**

- extend `src/run-retention.ts` with publication/cleanup;
- extend `tools/seal-run.mjs` with production `--dry-run`, `--accept`, and
  `--resume` flags;
- add `test/run-retention-cleanup-faults.test.js`;
- add `test/run-retention-e2e.test.js`.

**Irreversible suffix**

1. repeat the second zero-handle publication gate;
2. atomically publish the already-staged receipt and sync the run root;
3. delete only exact remaining cleanup entries bottom-up;
4. after each unlink, permit crash and resume using absent-as-completed semantics;
5. refuse extra/replaced/device-crossing entries;
6. remove tombstone and sync;
7. remove exact acceptance input only if receipt-bound;
8. remove continuation marker last and sync.

The staged receipt binds the initial quiescence snapshot and fixed policy
`publicationQuiescence="REQUIRED_ZERO_HANDLES"`; the second gate does not
rewrite receipt or marker bytes.

**Fault matrix**

- after staged receipt fsync;
- after marker fsync;
- after Body rename and parent fsync;
- after frozen revalidation;
- before/after receipt rename and directory fsync;
- after every file/directory unlink;
- after tombstone removal;
- after acceptance-input removal;
- after marker removal.

For each cut: restart doctor → assert expected code → resume → assert exactly one
valid receipt, no Body/tombstone, Seed intact, Custody byte-identical, and no
unknown sibling mutation.

**Commit:** `feat(retention): publish receipt before exact resumable cleanup`

### D9 — Coupled placement doctrine, deployment, and canary

**Purpose:** enable the new layout only after the complete recovery path exists.

**Files**

- `.gitignore` fixed private patterns from the architecture;
- `WORKSPACE.md` Seed/Body/Custody and immutable-while-retained doctrine;
- `SKILL.md` Body placement, parent acceptance, seal, and asymmetric disable;
- `worker/ENGINEERING.md` supported Body writer path;
- `orchestrator/PLANNING.md` no optional polish/proof/retention nodes;
- add canonical source policy `orchestrator/RETENTION-POLICY.json` and deploy it
  as `runtime/retention-policy.json`;
- `README.md`, `docs/RECOVERY.md`;
- `tools/deploy-skill.mjs` plus deployment/parity tests;
- extend the R1 closed allowlist launcher template
  `runtime/retention-launcher.mjs` with the R2 entrypoints;
- extend `test/worker-routing-policy.test.js`.

**Doctrine rules to assert literally**

- new Body only when installed admission is ON;
- new Body is created only through `admitRunBody`; the writer refuses to create
  it and post-receipt admission is impossible;
- existing Body/marker always resumes even when admission is OFF;
- raw logs/non-runtime reports go through the Body writer;
- managed report paths stay where runtime expects them;
- parent gate prepares acceptance before runtime PASS;
- final parent PASS invokes dry-run/accept and evaluates the observable;
- no durable product doc cites Body;
- no optional polish node before/after the accepted journey;
- CLAIMED/UNKNOWN Custody remains protected.

**Deployment and invocation payload**

Keep the two installation surfaces explicit:

1. The normal skill/plugin installation updates root doctrine
   (`SKILL.md`, `WORKSPACE.md`, `worker/ENGINEERING.md`,
   `orchestrator/PLANNING.md`, source policy, and docs). A source-to-installed
   parity test names every one of those paths. `tools/deploy-skill.mjs` does
   not silently start owning root doctrine.
2. The existing atomic runtime transaction installs compiled private retention
   modules, `runtime/tools/seal-run.mjs`,
   `runtime/tools/with-body-writer.mjs`, `runtime/retention-policy.json`, and
   `runtime/retention-launcher.mjs`. `DEPLOYMENT.json` binds every byte plus
   fixed platform-helper identities.

Operators and doctrine invoke retention tools only through
`runtime/retention-launcher.mjs`. It first verifies the installed runtime,
manifest, policy, selected entrypoint, Node identity, imported private modules,
and required platform helpers, then dispatches one closed entrypoint
(`admit-body`, `seal-run`, or `with-body-writer`). Direct installed tool
invocation refuses.
Deployment tamper tests flip one byte in each launcher/tool/module/policy and
require refusal before any run-root open or mutation.

The exact runtime deployment commands are:

```bash
node tools/deploy-skill.mjs --retention-admission OFF \
  --retention-run-parent /absolute/project/Lunacy/runs
node tools/deploy-skill.mjs --check --retention-admission OFF \
  --retention-run-parent /absolute/project/Lunacy/runs
# canary promotion only after the isolated-target rules in section 6
node tools/deploy-skill.mjs --retention-admission ON \
  --retention-run-parent /absolute/canary/Lunacy/runs
node tools/deploy-skill.mjs --check --retention-admission ON \
  --retention-run-parent /absolute/canary/Lunacy/runs
```

`--retention-run-parent ABSOLUTE` is repeatable and required for deploy, check,
downgrade, and removal once retention support exists. A bounded read-only
fixed-name census classifies managed and non-managed `.work`,
`.work.prune-*`, staged/final receipts, acceptance inputs, finalization markers,
and migration markers beneath only those parents. It refuses
symlink/depth/entry ambiguity and binds the sorted admitted-state/schema set
into deployment preflight. Candidate compatibility is checked for every
nonterminal admitted state, not only marker schemas. The guarantee is scoped to
those declared parents; there is no global scanner or claim about unknown
filesystem roots.

**R2 candidate gate**

```bash
npm run typecheck
npm run build
node --test \
  test/session-lifecycle-compat.test.js \
  test/run-retention-model.test.js \
  test/run-retention-doctor.test.js \
  test/run-retention-admission.test.js \
  test/run-retention-writer.test.js \
  test/run-retention-acceptance.test.js \
  test/run-retention-platform.test.js \
  test/run-retention-inventory.test.js \
  test/run-retention-rename-faults.test.js \
  test/run-retention-cleanup-faults.test.js \
  test/run-retention-e2e.test.js \
  test/r2-deployment.test.js \
  test/product-surface.test.js
npm run check
```

Tester also runs a tracked-only clean checkout to prove fixtures do not depend
on `Lunacy/runs`, installed skill state, or mutable historical evidence.

**Commit:** `feat(retention): enable coupled Body lifecycle behind admission`

## 6. Rollout sequence

### Stage 0 — Install R1 doctor, admission OFF

- Run doctor on one legacy COMPLETE, one STOPPED, and one managed run.
- Expect read-only codes; no new files in run roots.
- Compare full trees before/after.

**Advance when:** all classifications are explainable and compatibility tests
pass on source and installed payload.

### Stage 1 — R2 shadow/dry-run, admission OFF

- Use synthetic test roots and frozen copies only.
- Exercise acceptance preparation, inventory, rename-only, full cleanup, and
  crash recovery.
- Do not create Body in an ordinary live run.

**Advance when:** every closed crash prefix converges; unknown combinations
refuse; zero Custody bytes change.

### Stage 2 — One non-managed canary, admission ON only for the canary

- Use an isolated installed target and workspace in which no other run creator
  can start, or hold an operator run-creation quiescence barrier for the entire
  ON interval. The policy is global to that installed target; there is no
  implied per-run selector.
- Create one representative ordinary run using `admitRunBody`.
- Require non-empty Body; an empty-Body-only canary is a trap because it avoids
  partial payload/reference cases.
- Parent accepts, seals, restarts doctor, and verifies receipt/no Body.
- Deploy admission OFF through the shared policy claim immediately after the
  canary is admitted; the admitted run remains recoverable.

**Advance when:** accepted product output is identical, Body is gone, Seed is
bounded, and rollback rehearsal succeeds.

### Stage 3 — One managed canary

- Use a managed command/report journey with raw non-runtime evidence in Body.
- Prove managed report and effect records stay in Custody paths.
- Force one pre-publication and one post-publication crash.

**Advance when:** managed restart/replay passes and no report/effect path moved.

### Stage 4 — Default ON for new runs

- Deploy policy ON.
- Existing legacy runs stay legacy.
- Monitor doctor code distribution, Body bytes, refusal codes, cleanup time,
  and unresolved marker count.

**Stop/disable admission on:** unknown state, Custody collision, identity drift,
  repeated quiescence-unavailable failures, bridge/report drift, or any cleanup
  outside the bound tombstone.

## 7. Asymmetric rollback

| Observed state | Rollback action | Forbidden action |
| --- | --- | --- |
| No admitted Body/marker | Deploy admission OFF; old behavior resumes. | Removing unrelated run data. |
| Active `.work`, no marker | Admission OFF for new runs; keep writer/doctor/sealer installed; finish or explicitly abandon later. | Downgrading to a version that cannot read Body. |
| Continuation marker/tombstone | Admission OFF; run doctor and exact resume with compatible tool. | Uninstalling recovery binaries or deleting marker manually. |
| Published receipt + partial tombstone | Admission OFF; resume cleanup from receipt-bound cursor. | Restoring `.work` or recomputing authority. |
| Sealed clean | Old runtime may ignore receipt; keep Seed. | Reconstructing deleted Body from receipt. |

Deployment/removal must audit admitted states under every explicitly configured
trusted run parent first, including active `.work`, tombstones, receipts, and
fixed-name markers in non-managed roots. Refuse a candidate installation that
cannot validate/recover every nonterminal state and schema found in that bounded
census. Do not retain arbitrary N versions of binaries; retain the current
compatible recovery tool until its admitted states drain, and block
incompatible downgrade. Runs outside the configured parents are not claimed
audited.

## 8. Explicit abandonment cells

Implement only after R2 is accepted.

### A0 — Pure abandonment authority

- Extend closed validators with `lunacy-run-abandonment/v1` and
  `lunacy-run-abandon-receipt/v1`.
- Require `BLOCKED`/`STOPPED`, explicit reason code, `activeWorkers="NONE"`,
  authority digest, and retained Custody summary.
- Refuse ACTIVE, PENDING, CLAIMED, ambiguous, or missing authority.
- Keep UNKNOWN/malformed Custody untouched.

**Commit:** `feat(retention): validate explicit abandonment authority`

### A1 — Reuse the finalizer

- Add `seal-run --abandon --run-root ... --authority ...` through the verified
  launcher.
- Reuse D3/D6/D8 exclusion, quiescence, traversal, marker, cursor, and recovery.
- Publish `ABANDON-RECEIPT.json`. Abandonment authority and receipt contain no
  `resultIdentity` field; only the shared temporary continuation marker carries
  its specified fixed all-zero `resultIdentityDigest` so it cannot be mistaken
  for accepted authority.
- Do not implement a second deletion engine.

**Commit:** `feat(retention): prune explicitly abandoned Body`

### A2 — Gate and rollout

```bash
node --test test/run-abandonment.test.js test/run-retention-*.test.js
npm run check
```

Canary one disposable STOPPED run. Rollback disables the abandon command only;
existing abandonment receipts remain truthful.

## 9. Legacy migration cells

Implement only after R2 metrics prove new-run amplification is fixed.

### M0 — Audit only

- add private `src/run-body-migration.ts`;
- add `tools/audit-run-artifacts.mjs`;
- add `test/run-body-migration.test.js` read-only rows;
- define the fixed legacy allowlist and exact marker validator from architecture
  section 6 (`lunacy-body-migration/v1`: run/source identities, sorted source
  entries, Body identity/digest/counts, and `phase="BODY_PUBLISHED"`);
- report allowlist eligibility, references, custody, counts, bytes, exact
  refusal reasons, and each row of the architecture's closed migration recovery
  table.

Reference scanning may refuse; it never authorizes deletion.

### M1 — Copy-only pilot

- add `tools/migrate-run-body.mjs --run-root <path> --accept` through the
  verified launcher;
- copy one Git-backed Markdown-only COMPLETE run to `.work.migrate-tmp`;
- under run exclusion, verify/fsync every exact destination and aggregate
  source-to-Body digest, rename to `.work`, sync the run root, then publish the
  exact migration marker;
- keep all originals;
- crash-test every copy/fsync/rename/marker prefix.

### M2 — Accepted reference rewrite and normal seal

- rewrite all durable references before acceptance;
- require zero unresolved/unscannable references;
- require the embedded product-manifest result variant; the clean-commit
  variant is ineligible for migration;
- parent accepts and normal R2 sealing publishes receipt/prunes migrated Body;
- still keep originals.

### M3 — Exact original unlink

- reacquire exclusion;
- require migration Body digest == accepted receipt Body digest;
- rerun reference guard;
- unlink only exact marker-bound original identities, one by one;
- sync parents and delete migration marker last;
- `git restore` + digest verification is the pilot rollback.

Each crash fixture must cover the exact architecture state rows: temp-only;
Body without marker; marker+Body+sources; marker+finalization transaction;
marker+matching receipt+partial sources; completed marker; and every collision,
changed-source, or unknown-absence refusal. Recovery never recopies an absent
recorded source or removes an unbound temp tree.

Do not bulk migrate the existing corpus. Each later run requires explicit
eligibility and parent authority. Architecture section 6's marker fields,
eligibility rules, and recovery table are normative acceptance criteria, not
background rationale.

## 10. Test matrix

| Dimension | Required cases |
| --- | --- |
| Acceptance | runtime/manual, forged Markdown, stale token, non-next PASS, FINDINGS, result/Outcome/authority drift, cross-process manifest |
| Admission | writer-first, sealer-first, paused check/claim, stale owner, cancellation, managed lock order |
| Filesystem | normal/empty/max, symlink, hardlink, special, path escape, invalid UTF-8, cross-volume temp, root/nested bind mount |
| Quiescence | zero handle, live handle, wrapper death/live child, permission denial, missing adapter, drift between snapshots |
| Crash | every write/fsync/rename/publish/unlink/rmdir/marker boundary |
| Recovery | pre-rename, pre-publish tombstone, partial cleanup, marker-only, receipt-only, unknown collision |
| Custody | `.kernel`, `.codex-effects`, managed reports, external evidence, CLAIMED/UNKNOWN/malformed |
| Compatibility | public bytes, replay, bridge paths, managed report paths, package exports, disabled legacy behavior |
| Deployment | source/installed parity, manifest/tamper rejection, admission OFF/ON, incompatible downgrade refusal |
| Migration | audit inertness, copy duplicates, reference refusal, receipt-before-source-unlink, partial source cleanup |

Every destructive test starts from a fixture copy and asserts an allowlisted
tree diff. “No exception” is not enough.

## 11. Success measures

For one frozen representative non-managed run and one managed run:

- accepted product output: identical before/after;
- public runtime/event/state/bridge/report bytes: identical;
- Body bytes after accepted seal: `0`;
- repository-tracked raw Body evidence after seal: `0`;
- durable amplification: retained Seed bytes / pre-seal Body bytes `< 0.10` for
  the non-managed run;
- Custody loss: `0` files and `0` bytes;
- crash prefixes: 100% map to a closed doctor code and deterministic outcome;
- unknown/unsafe prefixes: 100% refuse without payload deletion;
- normal active-run dispatch latency: no retention traversal or global scan;
- disable behavior: no new Body admission, all admitted recovery remains usable.

Counts of commits, tests, artifacts, reports, and evidence are diagnostics—not
success metrics.

## 12. Parent release checklists

### R1 Doctor

- [ ] doctor is byte/mode/mtime/inode inert;
- [ ] every bounded state has one code/next action;
- [ ] no mutation command exists;
- [ ] installed payload parity passes;
- [ ] broad check passes.

### R2 Lifecycle V1

- [ ] D0 compatibility corridor unchanged;
- [ ] all D3 races resolve safely;
- [ ] acceptance binds exact result before PASS;
- [ ] mount/open-handle adapters fail closed;
- [ ] D7 rename-only fault suite has zero Body/tombstone payload unlink/rmdir;
- [ ] D8 every crash prefix converges;
- [ ] receipt is durable before first payload unlink;
- [ ] Custody diff is empty;
- [ ] new placement and complete sealer deploy together;
- [ ] admission OFF rollback rehearsed;
- [ ] tracked-only checkout passes `npm run check`.

### R3 Abandonment

- [ ] explicit authority only;
- [ ] no accepted result claim;
- [ ] ACTIVE/PENDING/CLAIMED refusal;
- [ ] UNKNOWN/malformed Custody preserved;
- [ ] same crash/recovery guarantees as accepted seal.

### R4 Legacy pilot

- [ ] one allowlisted Git-backed run only;
- [ ] originals retained through accepted receipt;
- [ ] references rewritten and guard clean;
- [ ] product-manifest identity used;
- [ ] exact source unlink is restartable;
- [ ] `git restore` rollback rehearsed;
- [ ] no bulk migration/deletion.

## 13. ADHD roadmap decision record

### Brief

The architecture is settled; the open question is sequencing. Reframe the
roadmap as an **irreversibility budget**: establish byte parity and diagnosis,
then writer exclusion and acceptance, then rename-only recovery, and only then
spend the first unlink.

### Wide set by implementation angle

Scores are `[novelty viability fit]`. `TRAP` marks an attractive sequencing
choice that should not become the roadmap spine.

**Evidence-backed state model**

- R1 byte-preservation witness per release cell `[N6 V8 F10]`
- R2 acceptance tuple binds Seed/Body/Custody/version/authority `[N7 V7 F9]`
- R3 monotonic Custody facts; never infer from timestamps/shape `[N6 V9 F10]`
- L3 dev/inode/digest pallet seals `[N8 V6 F7]` **TRAP** across copy/restore
- L4 parent capsule + committed PASS successor `[N7 V6 F8]` **TRAP** if coupled
  to an unrelated successor rather than the same gate record

**Atomic transfer seam**

- R4 write/flush/publish/reopen + crash certification `[N7 V7 F10]`
- S2 existing release-exclusion wrapper as the feature seam `[N5 V8 F10]`
- S4 rename-only proof before first unlink `[N7 V9 F10]` ★
- L1 one held-exclusion transfer lane `[N6 V8 F9]`
- K2 crash-gremlin at every persistence boundary `[N5 V8 F10]`
- K4 one shared writer/sealer talking stick `[N5 V8 F9]`
- K5 copy/fingerprint/accept before source unlink `[N4 V9 F10]`

**Compatibility-first migration**

- R6 legacy dual-read/divergence refusal `[N7 V7 F10]`
- S1 synthetic sealer before live placement `[N6 V9 F9]`
- S3 empty-Body real canary `[N7 V8 F8]` **TRAP** false confidence
- S5 copy-only one-artifact legacy pilot `[N5 V9 F9]`
- L2 retain original through accepted receipt/reference clearance `[N5 V9 F10]`
- K3 untouchable bridge/state/event/report corridors `[N4 V9 F10]`

**Explicit terminal-state safety**

- R5 abandonment tombstone with actor/reason/scope `[N6 V8 F9]`
- L5 distinct abandonment receipt protecting UNKNOWN Custody `[N6 V9 F10]`
- K6 signed abandonment only; never infer from age `[N5 V9 F10]`
- O4 asymmetric disable: stop admission, preserve recovery `[N8 V9 F10]` ★
- O5 block incompatible deploy/removal with unfinished markers `[N7 V8 F10]`
- O6 page only on closed unresumable states `[N7 V8 F9]` **TRAP** if ordinary
  refusal aggregation is suppressed

**Reversible rollout operations**

- S6 promote dry-run candidate bytes unchanged `[N8 V6 F8]` **TRAP** if the
  exclusion epoch is not continuous
- L6 non-managed → managed → legacy canary depots `[N6 V8 F10]`
- K1 one feature/switch/restore picture per cell `[N5 V9 F9]` **TRAP** if flags
  accumulate instead of retiring
- O1 pin tool digest/retain N/N-1 binaries `[N8 V6 F9]` **TRAP** as permanent
  obsolete-binary custody
- O2 one completion credit per forced-crash canary `[N8 V5 F8]` **TRAP** because
  it serializes rollout without replacing systematic fault injection
- O3 read-only doctor with code/next action/protected paths `[N7 V9 F9]` ★

### Converge

1. **O4 asymmetric disable (8.90).** Best rollback property: halt new exposure
   without stranding work that already owns durable bytes.
2. **S4 rename-only before unlink (8.55).** Best implementation ordering: all
   reversible crash prefixes are proven before the first destructive operation.
3. **O3 read-only doctor (8.30).** Best first shipped surface: it makes every
   later failure diagnosable without creating authority.
4. **R3/L5 monotonic Custody + distinct abandonment (8.20).** Retain as the
   safety invariant beneath the top three.

**Trap list**

- Empty-Body-only canary: skips the payload/reference failure surface.
- Promote dry-run bytes after releasing exclusion: can accept stale authority.
- Permanent dev/inode identity across copies: strands otherwise valid recovery.
- Successor-coupled acceptance: do not bind to an unrelated future workflow.
- Flag per cell: creates a compatibility matrix; keep one admission switch.
- Permanent old-binary fleet: blocks maintenance; retain compatible recovery,
  not arbitrary versions.
- One forced crash as rollout currency: systematic fault cuts are stronger.
- Suppress ordinary refusal escalation: aggregate repeated refusals.

### Focus

#### Asymmetric disable

The admission boundary is creation of the first new Body for a run. OFF rejects
only runs that have not crossed it; existing Body/marker/receipt states keep all
validation and recovery paths. Convergence is absence of nonterminal markers,
not an empty queue. The load-bearing risk is a gap between checking policy and
durably admitting Body; placement must create Body atomically only after reading
the exact installed policy, while recovery ignores later policy changes.

**First step:** characterize both sides of Body creation while toggling policy
and assert existing runtime/event/state/bridge/report bytes do not change.

**Children:** drain-status doctor view; bounded disable-and-wait operator mode;
same asymmetric gate for legacy migration; retire switch after compatibility
window.

#### Rename-only before unlink

Build the complete receipt/marker/tombstone prefix under existing exclusion but
make payload unlink unreachable. Restart reduces every prefix to live Body,
validated tombstone, or ATTENTION. After hard-exit fault tests prove those
states, add receipt publication and exact cursor cleanup as the next commit in
the same release candidate. The load-bearing risk is a hidden writer or reader
of the original Body path; D3 exclusion, D4 publication, D6 handle/mount checks,
and the second quiescence gate close it.

**First step:** add a table-driven hard-exit fault suite whose assertion is zero
unlink calls and exact restart classification.

**Children:** shadow planner before rename; recovery compatibility audit before
downgrade; fail-closed same-filesystem rule; exact doctor mapping for each
durable prefix.

#### Read-only doctor

Doctor reuses the same closed validators and classification table as mutation;
it is not a second recovery state machine. It double-censuses trusted paths,
emits one stable code/allowlisted next action/protected-path list, and changes no
bytes or metadata used as authority. Mutation later reacquires exclusion and
revalidates the expected class; doctor output itself grants nothing. The
load-bearing risk is classifier drift, so the classifier lives once in
`run-retention.ts` and every crash fixture maps to a doctor row.

**First step:** enumerate the bounded presence/validity matrix and write pure
expected-code tests before the CLI wrapper.

**Children:** support bundle containing only selected facts; pre-deploy marker
compatibility audit; migration doctor; aggregated refusal health report.

### Provocation

What if the implementation is considered incomplete until **every durable
prefix has a boring read-only diagnosis and a reversible rollback story**—even
when the happy-path feature already works? That criterion is stricter than test
green and directly targets workflow-breaking recovery failures.
