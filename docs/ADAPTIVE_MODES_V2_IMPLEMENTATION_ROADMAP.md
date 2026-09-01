# Adaptive Modes v2 — Implementation Roadmap

**Status:** implementation-ready authority companion
**Architecture:**
`/Users/mark/Documents/Codex/2026-08-29/hoq/outputs/adhd-lunacy-adaptive-architecture-v2.md`
**Architecture SHA-256:**
`1e4aeac9c7b37f0eb501e3710345e7b7808a55a526105d3b86c6e45a243bcb1d`
**ADHD synthesis:**
`/Users/mark/Documents/Codex/2026-08-29/hoq/outputs/adhd-lunacy-v2-implementation-roadmap-synthesis.md`
**Candidate:** this working tree at baseline
`e7dd443b23a61268fb24f6b1f81ef5b065f9e94c`

**User execution authority:** in this thread the user answered “Do” to the
proposed Cells 0–5 sequence, including commit/push, atomic disabled install,
and explicit Focus/Explore/AUTO canaries, then changed only the ordering to run
ADHD and freeze this detailed roadmap first. Sol/high implementation ownership
was also explicit. Exercise those external actions only after their gates below
remain satisfied at action time; a drifted destination, new overlapping owner,
or destructive/non-fast-forward push stops for renewed authority.

This roadmap implements the architecture as one accepted vertical product
change. Cells are reversible/bisectable code boundaries for one coherent owner;
they are not separate product milestones, worker dependency nodes, or proof
projects. Preserve the dirty candidate, inspect before editing, and reconcile
existing work instead of resetting, cleaning, rebasing, or rewriting it.

## 1. Accepted observable

The implementation is complete when:

1. users can request `DIRECT`, default `AUTO`, or explicit `EXPLORE`;
2. Direct and AUTO→Direct return the exact canonical authority-bound Plan with
   zero managed reads, initialization, artifacts, locks, or advisory calls;
3. AUTO performs one pure decision and yields Direct, exactly one 2+1 Focus
   Wave, or `NO_SETTLEMENT`; it never selects Explore;
4. explicit Explore performs exactly 5×6 generation, one combined critic, and
   three deepeners on valid completion, or the specified six-call underfilled
   stop;
5. every managed role receives real sealed semantic context and restart
   reproduces exact policy-bound frame text, tags, and role bytes;
6. managed work is fully prepared and host-attested before the existing locked,
   root-bound durable START transaction;
7. a durable provider-intent fence permanently prohibits provider re-entry;
8. only the parent adopts the Plan; implementation receives the Plan and
   required proof, never raw ADHD transcripts;
9. supported historical lineage remains byte-compatible and recoverable;
10. source, clean tracked checkout, build, pack, manifest, disabled install,
    docs, assets, and installed runtime agree atomically.

Worker PASS, test count, documentation volume, and intermediate fixtures are
evidence, not acceptance. The parent must evaluate the end-to-end observable.

## 2. Non-negotiable design boundaries

- Keep RunKernel as the only durable control plane.
- Keep `PlanAuthorshipInput`, `DeliberationWave/v2`,
  `DeliberationReport/v2`, public event shapes, and `modeEpoch` shape unchanged.
- Add no public mode state machine, scheduler, decision/retry/nonce ledger,
  context capsule schema, semantic cache, or new cold-research store.
- Fresh Explore is explicit-only. Prose, replay, rollout, failure, gate, or
  worker completion cannot mint it.
- Advisory route is exactly Luna/max. Ordinary implementation remains the
  already selected Lunacy route; no model/effort fallback.
- A selected managed route may refuse, but may never downgrade to Direct or
  ordinary START.
- Do not hold the workspace lock during provider calls.
- Do not reinterpret old Waves with fresh prompts, frames, or retry rules.
- Do not patch installed `runtime/dist` piecemeal.

## 3. Ownership and execution shape

Default owner: one explicit Sol/high worker owns Cells 0–5 end-to-end because
the user explicitly authorized Sol for implementation. Split only if the owner
reports a measured context/time/tool-capacity boundary. Any split must use the
fewest vertical acceptance-required slices and preserve one integrated final
gate.

Before edits, the owner must:

1. read this roadmap, the frozen architecture, `WORKSPACE.md`,
   `/Users/mark/.codex/skills/lunacy/worker/ENGINEERING.md`, and current run
   authority;
2. inventory the dirty diff and classify every existing change as `KEEP`,
   `REWORK`, `DELETE-AS-CONTRADICTION`, or `OUT-OF-SCOPE-PRESERVE`;
3. inspect other ACTIVE run ownership and stop before overlap;
4. identify the existing implementation seams and tests before adding helpers;
5. keep long inventories and raw command output outside the parent report.

## 4. Cell sequence

### Cell 0 — Establish the compatibility floor

**Goal:** obtain a clean, hermetic baseline and freeze what must not drift.

**Primary surfaces**

- existing dirty source/tests/docs;
- `test/fixtures/adaptive-modes/**`;
- compatibility and deployment tests;
- architecture/freeze copies under tracked product docs;
- retained-root census tooling already present in the candidate.

**Implementation instructions**

1. Capture a compact dirty-tree ownership map. Do not discard or overwrite
   prior adaptive-mode or retention work.
2. Move every runtime test dependency out of `Lunacy/runs/**`, installed skill
   state, home-directory policy, or mutable historical evidence. Put immutable
   minimal inputs under tracked `test/fixtures/**`.
3. Freeze raw canonical output bytes for:
   - explicit Direct;
   - supported historical two/three-lens Focus;
   - supported historical Explore/D4 and persisted WIDEN;
   - restart/replay roots;
   - malformed/corrupt mixed-era roots;
   - nonzero `modeEpoch` rejection.
4. Run the read-only retained-root census. Derive, do not guess:
   - the supported reader corpus;
   - legacy policy digests/assets;
   - the minimum safe fresh-writer generation floor.
5. Copy the frozen v2 architecture and freeze record into tracked product docs
   without rewriting v1. Preserve their normative hash.
6. Prove the tracked-only checkout baseline before semantic edits.

**Red/green proof**

- A scratch checkout excluding untracked files and `Lunacy/runs/**` initially
  exposes every non-hermetic test, then passes after fixture ownership moves.
- Corrupt inputs refuse without changing state, CURRENT, journal, outbox, or
  fixture bytes.
- Historical fixture output is compared byte-for-byte, not normalized object
  equality.

**Cell gate**

- tracked-only baseline suite PASS;
- census is complete enough to name every supported unfinished root;
- no runtime test reads mutable run or installed-skill authority;
- architecture hash matches the freeze record.

**Rollback:** revert only Cell 0 fixture/doc changes; no runtime behavior has
changed.

### Cell 1 — Truthful resolver and physically isolated Direct

**Goal:** implement the closed `DIRECT | AUTO | EXPLORE` request boundary and
prove Direct by forbidden-effect absence.

**Primary surfaces**

- `src/bridge-cli.ts`;
- `src/deliberation.ts`;
- `test/p4-resolve-plan.test.js`;
- new production-CLI hostile child/preload harness only if existing seams cannot
  express the proof.

**Implementation instructions**

1. Parse mode and the private canonical request before any managed-policy,
   rollout, capability, host, artifact-store, or kernel preparation.
2. Replace synthetic `decisionUnsettled`/`namedDiscriminator` booleans with one
   closed parent-authored request containing:
   - the existing `PlanAuthorshipInput`;
   - sealed ordered frontier items;
   - normalized nonblank problem/impact;
   - a normalized nonblank discriminator only for a real Focus candidate;
   - explicit Explore request authority and cutoff binding.
3. Keep the union private to the bridge/host. Export no public mode enum or
   persisted state field.
4. Direct validation must:
   - parse the authority-carried Plan;
   - require schema/digest/phase validity;
   - require canonical parsed bytes to equal the validator's canonical Plan;
   - return the original parsed Plan rather than a normalized approximation;
   - otherwise return `NO_SETTLEMENT`.
5. AUTO resolution is one total ordered function:
   - complete canonical Plan + no unsettled material frontier → Direct;
   - earliest unsettled material item + real discriminator → Focus candidate;
   - otherwise → `NO_SETTLEMENT`.
6. Explicit Explore is accepted only at the trusted pre-Plan command boundary,
   may challenge a complete-but-unsealed Plan, and never requires a fake
   unsettled predicate.
7. Put managed preparation behind a private lazy branch reached only after
   Focus/Explore selection.

**Hostile Direct proof**

Run the real built CLI in a child process while making these operations fail if
reached:

- deliberation/rollout/capability/host reads;
- managed object or driver construction;
- artifact-store/Wave/Report creation;
- bridge lock or `.kernel` creation;
- Luna/provider process launch.

Exercise explicit Direct and AUTO→Direct. Require exact stdout bytes, no
filesystem mutation, no temporary publication siblings, and no managed calls.
Add a normalization-dependent Plan that must refuse.

**Cell gate**

- all three AUTO results are covered by a table;
- prose/extra booleans cannot manufacture a discriminator or Explore authority;
- Direct tripwire passes against source build and tracked-only package path;
- existing legacy replay remains unchanged.

**Rollback:** restore the old private resolver/CLI selection; no v2 managed
writer is activated yet.

### Cell 2 — One locked, attested managed admission transaction

**Goal:** prevent partial or unbound managed START and preserve ordinary
post-Plan routing.

**Primary surfaces**

- `src/bridge.ts`, `src/bridge-cli.ts`;
- `src/public.ts`, `src/composition.ts`;
- `src/orchestration.ts`, `src/decision-inbox.ts`;
- `src/codex-deliberation-driver.ts`;
- `src/execution-plane.ts`;
- `src/codex-host-policy.ts`, `src/codex-exec-supervisor.ts`;
- existing exact managed harness and post-Plan routing tests.

**Implementation instructions**

1. After the route-local Direct branch has already returned, make only the
   managed Focus/Explore `resolve-plan` operation enter
   `withBridgeOperationLock`; remove the lock-free composition/START side door.
2. Retain `lockedRootIdentity` and load CURRENT/authority once under the lock.
3. Freeze request, authorship, semantic context, policies, capability, and host
   identity under that root.
4. Compile the Wave and full cohort in memory. Publish nothing.
5. Perform real read-only host attestation before START, pinning executable
   image/version, invariant argv template, workspace/handoff roots,
   effect-denial/sandbox, model/effort, transport, capacity, and sealed base
   Refs.
6. Construct only the current command-scoped advisory driver after attestation.
   Bind the ordinary post-Plan worker lazily at its first command.
7. Reuse `makeComposedKernelForBridge`, publication lease, writer fence,
   journal/store CAS, and managed START validation to publish Wave+START as the
   existing recoverable authority transition.
8. Release the workspace lock before any provider call.
9. Immediately before each command's provider-intent fence:
   - materialize the exact predecessor-bound role view;
   - derive exact argv/output/handoff bytes;
   - match the pinned executable/template;
   - verify exact lease/frame/current-command identity and managed anchor.
10. Use one shared exact current-command predicate for PENDING, CLAIMED,
    UNKNOWN, and ACKED across pump/coordinator/driver/capacity paths.
11. Preserve `modeEpoch === 0` at state, CURRENT, supervisor, driver, and
    recovery boundaries.
12. Disabled/ineligible managed execution refuses before START. It cannot use
    ordinary START, Direct, another route, another model, or another root.
13. Thread one closed trusted managed-context carrier through the production
    bridge lifecycle/drive/decision-inbox composition seams. It supplies the
    retained policy/capability/rollout/host inputs needed to reconstruct a
    command-scoped advisory driver after process restart; do not rely on the
    initial `resolve-plan` process closure and do not add persisted mode state.
14. On RESUME/restart, derive advisory semantics from the retained Wave and
    policy asset, attest the current host at the existing command boundary, and
    bind only the exact retained advisory command. After the parent consumes
    the existing decision token through `submitParentDecision`, reconstruct the
    kernel through the same root-bound composition and lazily route the first
    roleless post-Plan command to the preselected ordinary driver.

**Crash/race proof**

- root replacement while preparing;
- concurrent START;
- delayed/failed attestation;
- missing capability/asset/closure/host;
- disabled rollout after compile;
- per-command executable/argv/lease/frame/anchor drift;
- restart from every live command disposition;
- Focus → parent chooses different Plan → ordinary implementation DONE.
- built-CLI multi-process journey:
  `managed START → process exit → RESUME/restart → Reports → parent
  submit-decision/adoption → ordinary dispatch`, proving the bridge lock is
  absent at provider entry and no test-only retained closure supplies context.

Before START failure may leave only the existing private `.kernel` namespace
and atomic-cleanup temporaries; it must leave no authoritative CURRENT,
journal, outbox, Wave, or provider call.

**Cell gate**

- valid Focus/Explore enters exactly one root-bound START;
- all refusal cases are mutation-free at the authority surface;
- the lock is absent during provider work;
- post-Plan roleless commands reach only their selected ordinary worker.

**Rollback:** disable new managed admission at the current generation; retained
started work remains recoverable on its pinned reader.

### Cell 3 — Exact ADHD semantics and context firewall

**Goal:** make advisory output genuinely useful and restart-stable without
making it implementation authority.

**Primary surfaces**

- `src/deliberation.ts`, `src/store.ts`, `src/reducer.ts`;
- `src/execution-plane.ts`, `src/public.ts`;
- policy asset packaging/build/deploy code;
- worker handoff/authority paths and launch snapshots;
- deliberation and renderer tests.

**Implementation instructions**

1. Add content-addressed canonical v2 policy assets containing only:
   - stable schema/policy identity;
   - exact Focus generator/critic contracts;
   - exact Explore generator/critic/deepener contracts;
   - multi-tag frame catalog;
   - output/resource ceilings.
2. Make filename SHA-256 equal canonical asset bytes and bind
   `policyVersion.digest` to it without self-reference.
3. Build a census-derived signed private map from supported legacy policy
   digests to retained legacy asset digests. It is reader-only.
4. Populate the existing Wave question/authorship fields with the real sealed
   problem, impact, discriminator, evidence, constraints, decision key, and
   ordinal. Reject blank placeholders and opaque intent IDs as semantic input.
5. Store the canonical evidenceSnapshot closure payload in the existing Ref and
   resolve committed evidence/reachable constraints identically in every
   reader. Never validate closure from the Wave's own allow-list.
6. Choose five Explore frames deterministically from the policy-bound multi-tag
   catalog and authorship digest. No ambient randomness.
7. Resolve every retained frame ID through the exact retained policy asset on
   initial execution and restart. Never synthesize text/tags from position, ID,
   or current defaults.
8. Enforce exact fresh role semantics:
   - Focus: 2 isolated generators × 1 candidate, then one critic; no deepener;
   - Explore generators: 5 isolated slots × 6 distinct short ideas, no
     evaluation/ranking/hedging, obvious first three banned;
   - combined critic: score all 30 once, define N/V/F, nonempty one-line trap
     reason, complete 3–6 mechanism clusters, exact weighted ranking;
   - valid result launches exactly three deepeners;
   - fewer than three non-traps stops after six calls on existing
     BLOCKED/NEEDS-DECISION behavior.
9. Repair `renderExplore` as a pure volatile parent projection: Brief, Wide,
   Converge with rationales/scores/star, dedicated Traps, `Deepened`, and a
   traceably wild Provocation. Wire it at the parent decision surface only.
10. Preserve frame provenance in critic/renderer projections using existing
    Wave/slot/policy data; add no Report field.
11. After parent adoption, pass only the accepted Plan, criteria, architecture
    spine, and acceptance-required proof/risks to ordinary implementation.
    Exclude raw Wave/Reports, sibling views, renderer prose, run Body, and
    conversation transcript from authority paths, handoff bytes, launch
    snapshots, and prompts.

**Semantic proof**

- golden exact role strings and frame catalog selection;
- initial/restart role-view byte identity;
- predecessor isolation and complete partitioning;
- real nonblank context and closure membership;
- malformed/duplicate/oversize/trap/cluster/deepener refusal;
- underfilled critic six-call stop;
- useful read-only renderer with rank-one star and selected-target labels;
- poisoned research files absent from implementation surfaces;
- historical three-lens Focus uses its retained topology-aware wording.

**Cell gate**

- Focus maximum/valid call count is exactly 3;
- Explore maximum/valid call count is exactly 9 and underfilled count is 6;
- restart reproduces identical role semantics;
- renderer cannot mutate authority;
- implementation contains no raw deliberation transcript.

**Rollback:** disable fresh v2 managed writers; keep all required policy assets
and readers for admitted/historical work.

### Cell 4 — Permanent provider-intent fence and monotone recovery

**Goal:** allow retry only when provider entry is proved impossible and prevent
all duplicate ambiguous effects.

**Primary surfaces**

- `src/codex-deliberation-driver.ts`;
- `src/dispatch-coordinator.ts`;
- `src/reducer.ts`, `src/public.ts`, `src/one-shot.ts`;
- shared immutable-create/fsync helpers;
- one-shot crash child/lattice and restart/replay tests.

**Private recovery classifier**

Inputs are retained facts, not live policy:

- committed START;
- provider-intent fence observation: `ABSENT_PROVED`, `PRESENT_VALID`, or
  fail-closed `AMBIGUOUS`;
- retained command/lease/frame/authority anchor;
- receipt, transport, teardown, terminal, ACK evidence and validity.

Outputs reuse existing control behavior:

| Evidence | Provider replacement | Required action |
| --- | --- | --- |
| no START | no current attempt | whole admission may retry |
| START + positively proved no durable fence | at most one, existing ceilings | fresh epoch + full reservation |
| durable fence present | forbidden permanently | retain custody; observe/reconcile only |
| fence unreadable/malformed/mismatched/ambiguous | forbidden | retain custody; visible blocked recovery |
| exact complete result chain | forbidden | validate retained chain and ACK/reconcile |

**Implementation instructions**

1. Move every retryable preparation and frozen-identity check before the fence.
2. Atomically create the existing provider-intent reservation, fsync the file
   and parent directory, then spawn.
3. Make the fence immutable and permanent for the attempt. Remove cleanup that
   deletes or replaces it.
4. Implement one pure monotone classifier: adding evidence may never move a
   disposition closer to provider entry.
5. Wire it into the sole production coordinator/provider recovery path before
   changing reducer retirement behavior.
6. Only the proved no-fence row may create a fresh epoch and full reservation;
   honor all existing attempt/call/token/deadline ceilings.
7. Every fenced/ambiguous row preserves the charged retained command without
   READY reset, epoch churn, replacement command, model, or provider.
8. Drivers recover transport facts only. Store/coordinator owns current
   semantic verdicts.
9. Validate historical results against retained command/evidence/policy assets,
   never live post-provider policy. Remove live re-attestation only after the
   production classifier and tests are wired.
10. Add volatile diagnostics only if existing recovery status cannot explain
    the selected row; diagnostics remain non-authoritative.

**Crash lattice**

Inject deterministic cuts:

- before/after START;
- before/after fence file creation and directory fsync;
- before/after spawn;
- provider entry/exit;
- transport, teardown, terminal, receipt, ACK;
- process restart at each retained combination;
- stale/replayed/missing/malformed evidence.

Assertions:

- every tuple selects exactly one disposition;
- any durable/ambiguous fence means zero further provider entries;
- additional evidence never re-enables entry;
- only positively proved no-fence START may use one fresh fully charged attempt;
- already completed retained chains reconcile without live-policy rejection.

**Cell gate**

- crash/property lattice PASS;
- restarted provider-entry counter never exceeds one for a fenced attempt;
- old supported roots follow census-declared compatibility behavior;
- no new durable schema, receipt, ledger, or controller exists.

**Rollback:** stop new managed admission. Never roll back to a reader that
cannot retain/recover the permanent fence or live generation.

### Cell 5 — Package, disabled deployment, canaries, and promotion

**Goal:** release the complete signed system atomically and activate only after
source/install equivalence.

**Primary surfaces**

- package/build outputs and `package.json`;
- `tools/deploy-skill.mjs`, signed manifests and compatibility map;
- README, SKILL, API/BRIDGE/INSTALL/RECOVERY and deliberation docs;
- release/deployment/install tests;
- installed `/Users/mark/.codex/skills/lunacy` only through the supported atomic
  deployment command.

**Implementation instructions**

1. Reconcile every generation/floor, route, topology, explicit-Explore,
   no-retry, and rollback statement across docs.
2. Build the full runtime and policy assets from tracked source.
3. Compare one atomic inventory across:
   - source assets;
   - build output;
   - npm pack dry-run/tarball;
   - deployment manifest;
   - sterile install;
   - final installed skill.
4. After focused green checks and parent-targeted inspection, create one scoped
   immutable candidate commit containing the accepted product/run authority
   changes while leaving genuinely out-of-scope user work unstaged. Record its
   commit/tree identity; do not amend it after verification begins.
5. From that exact committed tree, rebuild and run the terminal source matrix
   once after the last code change:
   - typecheck;
   - build;
   - focused mode/context/admission/recovery/compatibility suites;
   - complete test suite;
   - npm pack dry-run;
   - tracked-only deployment test.
6. If a terminal check requires a code fix, create a new candidate commit and
   restart the affected terminal matrix against that new identity; never claim
   the older evidence.
7. Atomically deploy the exact verified candidate package with fresh managed
   admission disabled.
   Never hand-copy dist/docs/assets.
8. Verify installed manifest, docs, runtime package, policy assets,
   compatibility map, exact help/product surface, and recovery reader floor.
9. Activation order under the recorded user authorization, each separately
   reversible and rechecked for destination/capability drift at action time:
   - shadow pure resolver/admission decisions with no provider effects;
   - explicit trusted Focus canary;
   - explicit Explore canary;
   - AUTO Focus canary;
   - default AUTO only after crash/replay/install evidence remains green.
10. Rollback drill: raise the fresh-admission generation/policy to disabled and
   prove already admitted/UNKNOWN work retains custody and recovery.
11. Push the exact accepted commit to GitHub main only after source and installed
    acceptance agree, remote main is still a safe fast-forward target, and no
    newer user/owner authority conflicts. Never force-push.

**Release gate**

- source/build/pack/sterile-install/final-install manifests agree;
- Direct tripwire passes against installed runtime;
- explicit Focus and Explore topology/context/restart canaries pass;
- AUTO reaches all three truthful results;
- disabled or revoked capability never downgrades;
- rollback stops only fresh admission;
- no supported retained root is stranded;
- working tree contains no unexplained generated/untracked product surface.

## 5. Commit/bisection plan

These commits are suggested fault-isolation boundaries, not completion claims:

1. `test(adaptive-v2): establish hermetic compatibility floor`
2. `feat(adaptive-v2): make resolver truthful and Direct isolated`
3. `fix(adaptive-v2): attest and commit managed START atomically`
4. `feat(adaptive-v2): bind exact ADHD semantics and context firewall`
5. `fix(adaptive-v2): make provider intent the permanent retry fence`
6. `release(adaptive-v2): package policy assets and disabled rollout`

The implementation owner may combine adjacent commits when existing dirty work
makes separation misleading. It may not split them into plan/test/proof-only
product milestones.

## 6. Test ownership matrix

| Observable | Primary proof owner |
| --- | --- |
| historical bytes and writer floor | compatibility fixtures/census |
| Direct physical absence | real built CLI hostile child harness |
| AUTO truth table / explicit Explore | resolver tests |
| lock/root/attestation/disabled refusal | exact managed admission harness |
| current-command route, production resume/adoption, and post-Plan worker | built-CLI multi-process vertical journey/restart tests |
| role semantics/context/frame restart | deliberation golden tests |
| research exclusion | handoff/authority/snapshot poison tests |
| provider duplicate prevention | deterministic crash/property lattice |
| pack/install parity | tracked-only deployment/manifest tests |
| whole accepted workflow | parent canonical journey at final gate |

Do not rerun the same complete matrix at every cell. The implementation owner
runs focused red/green checks while working, then one terminal full matrix after
the last change. A later repair reruns only invalidated proof plus the final
required matrix when release authority requires it.

## 7. Stop conditions

Stop before editing and return one decision brief when:

- an ACTIVE run owns overlapping source/contracts;
- a supported retained root cannot be read under any existing reader;
- exact provider-entry bracketing cannot be established with existing durable
  seams;
- completing a cell requires a new public schema/controller/ledger;
- Sol/high is unavailable;
- the candidate must be reset/rebased/cleaned to proceed;
- installation would omit a live-generation reader or required policy asset;
- remote main differs in a way that requires destructive integration.

Do not stop for ordinary failing tests, dirty-work reconciliation, difficult
crash cases, or implementation complexity that remains within this authority.

## 8. Parent final acceptance

The parent reads the terminal worker Control Block, inspects the targeted mode
resolver, admission commit, frame/policy restart, context firewall, and provider
fence code paths, then runs one bounded acceptance sample plus the exact release
gate required by this roadmap. Commit, install, canary, rollback, and push
claims must be based on observed results, not worker PASS.
