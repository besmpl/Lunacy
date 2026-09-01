# ADHD + Lunacy Adaptive Architecture v2

**Status:** final architecture for implementation  
**Version:** 2.0.0  
**Date:** 2026-09-01  
**Scope:** pre-Plan deliberation, mode selection, managed admission, advisory
recovery, Plan adoption, and the boundary to ordinary Lunacy implementation  
**Source candidate:**
`/Users/mark/Documents/Codex/2026-08-31/lunacy-clean-adaptive-baseline`

This version supersedes v1 only where section 14 says so. Everything else in
the v1 freeze remains binding. Historical bytes are never reinterpreted or
migrated merely because fresh admission follows v2.

## 1. Executive decision

Lunacy remains the only control plane. ADHD becomes a bounded, effect-denied
**advisory kernel inside pre-Plan authorship**, not a second orchestrator,
scheduler, planner, or memory system.

Expose exactly three user intents:

1. **DIRECT** — skip advisory cognition and use an already complete,
   authority-bound Plan.
2. **AUTO** — the default; deterministically choose DIRECT, exactly one small
   Focus Wave, or `NO_SETTLEMENT` from trusted typed facts.
3. **EXPLORE** — an explicit request for one full ADHD-shaped Wave.

`FOCUS` is an internal AUTO result, not a fourth user mode. Rollout states such
as disabled, shadow, and canary are operator policy, not user modes. AUTO never
selects EXPLORE.

After the parent adopts a complete Plan, every mode converges on the same
ordinary Lunacy path: one largest-coherent implementation owner on the
preselected worker route, existing gates, targeted repair, and parent
acceptance. The current Lunacy worker default remains Luna/max; Sol/high remains
explicit-only authority. Direct means zero **deliberation** fan-out, not zero
implementation work.

## 2. Design laws

1. **One authority:** only the parent can seal requirements, adopt a Plan,
   pass a gate, or accept the result.
2. **One durable kernel:** RunKernel owns sequencing, attempts, tokens,
   outbox state, recovery, and repair. No cognition scheduler or ledger.
3. **AUTO is a pure choice, not a lifecycle:** it runs once before Plan sealing
   and returns one terminal result.
4. **Explore is explicit capability:** prose, heuristics, replay, gate failure,
   worker completion, and rollout policy cannot manufacture Explore authority.
5. **Direct is behavioral isolation:** the Direct branch performs no managed
   policy/capability/host read, initialization, artifact creation, or advisory
   call. Side-effect-free shared module loading is not itself a violation.
6. **Managed START is an admission commit:** prepare and attest first; publish
   authority only through the existing locked/root-bound START path.
7. **Advice is not authority:** all Luna calls are effect-denied and their
   Reports are proposals until the parent adopts a Plan.
8. **Retry follows evidence:** only proof of no provider entry permits another
   provider invocation. Ambiguity never does.
9. **Context is filtered, not accumulated:** advisors receive one sealed
   decision projection; implementation receives the adopted Plan and necessary
   proof, not the divergent transcript.
10. **New writers are strict; old readers are tolerant:** fresh v2 behavior is
    exact, while supported historical lineage remains recoverable byte-for-byte.

## 3. Product surface and exact behavior

| User intent | Resolver result | Advisory topology | Model route | Failure behavior |
| --- | --- | --- | --- | --- |
| `DIRECT` | complete Plan or `NO_SETTLEMENT` | none | none | never loads managed dependencies |
| `AUTO` | DIRECT, one FOCUS, or `NO_SETTLEMENT` | 0 calls or 2 parallel generators + 1 critic | Luna/max, effect-denied | a selected but unavailable Focus refuses/returns parent decision; it never silently downgrades |
| `EXPLORE` | one EXPLORE Wave or visible refusal | 5 parallel generators + 1 critic + 3 parallel deepeners | Luna/max, effect-denied | never downgrades to AUTO or DIRECT |

The ordinary implementation route is independently selected by the existing
Lunacy worker contract: Luna/max by default, or explicitly authorized Sol/high.
Adaptive advisory calls are always Luna/max. No advisory result changes the
implementation route, and no automatic model or effort fallback is allowed.

### 3.1 DIRECT

DIRECT succeeds only when the authority-carried `intent` Ref contains canonical
bytes for a digest-valid, schema-valid, phase-matching complete Plan. It returns
the parsed input Plan, not `validatePlan`'s normalized approximation. Admission
requires `canonicalString(parsed) === canonicalString(validatePlan(parsed).plan)`;
otherwise the candidate is not canonically complete. Missing, malformed,
normalization-dependent, stale, or cross-phase bytes produce `NO_SETTLEMENT`
through the existing result surface.

The Direct code path must prove all of the following:

- zero Wave or Report construction;
- zero cognition-budget or managed-driver initialization;
- zero managed policy/capability/host file reads;
- zero Luna calls;
- the exact canonical Plan value supplied by current authority.

### 3.2 AUTO

AUTO consumes a closed parent-supplied Plan candidate plus sealed decision
frontier once. It does not accept independent semantic booleans and does not
parse user prose to infer settlement, importance, or breadth.

Resolution is total and ordered:

```text
if complete authority-bound Plan exists and the sealed frontier has no
   unsettled material decision:
  DIRECT
else if the earliest unsettled material decision has a non-empty discriminator:
  FOCUS_CANDIDATE
else:
  NO_SETTLEMENT
```

For a Focus candidate, exact managed admission must succeed before START. If it
does not, AUTO reports the existing refusal/parent-decision outcome. It may
return DIRECT only if DIRECT was independently justified by the complete Plan
rule above. Capability failure is not authority to invent a Plan.

The one Focus Wave examines only that earliest decision. Later unsettled
decisions remain parent-owned; they do not cause a second automatic Wave.

AUTO runs at most once per fresh Plan-authorship attempt, before the acceptance
pointer/Plan is sealed and before the first implementation spawn. It never
widens, re-enters from a gate, re-enters after repair, or starts another Wave
after worker completion.

### 3.3 FOCUS (private AUTO gear)

Focus resolves one named discriminator, not an open research space:

- generator 0 uses the `counterexample` lens;
- generator 1 uses the `simplify` lens;
- both run in parallel and return exactly one candidate;
- one critic compares both, scores both exactly once, and partitions them into
  one or two non-empty comparison groups;
- maximum calls: 3; maximum generator concurrency: 2;
- no deepeners, successor Wave, WIDEN, or automatic re-entry.

The parent may select, synthesize, or reject the advice. A Report cannot author
the Plan.

### 3.4 EXPLORE (explicit ADHD gear)

Explore preserves ADHD's valuable semantics with Lunacy's stronger runtime:

1. Choose exactly five isolated frames from a trusted version-bound catalog
   whose entries may carry `code`, `design`, `general`, and `wild` tags. For a
   code-shaped task, choose four distinct code/design frames plus one distinct
   wild frame. For product/strategy work, choose a mixed five containing a wild
   frame and at least two tag families. Rotate deterministically from the
   authorship digest so equivalent retries are stable but every run does not
   always take the catalog's first five.
2. Run five generators in parallel. Each returns exactly six distinct short
   `{text, rationale}` ideas. Generation forbids evaluation, ranking, hedging,
   and the first three obvious answers.
3. After all 30 ideas exist, run one critic. It scores every idea exactly once
   on novelty, viability, and fit (integers 0–10), gives attractive traps a
   non-empty one-line reason, and partitions the complete pool into 3–6
   non-empty clusters by underlying mechanism.
4. Rank non-traps by `0.35N + 0.40V + 0.25F` and take exactly three. Low
   viability lowers the score; it is not a second hard filter absent explicit
   policy authority.
5. Run exactly three deepeners in parallel. Each produces a 4–8 sentence
   implementation sketch, one load-bearing risk, the first concrete coder
   step, and 3–5 child ideas spanning variations, hybrids, or unlocks.
6. Render a volatile parent view in this order: Brief, Wide set, Converge,
   Traps, Deepened branches, Provocation.

This is nine provider calls on a valid complete Explore because scoring and
clustering are two fields of one critic result. Generator/critic separation
remains strict; no critic instruction reaches a generator. The combined critic
is the deliberate performance difference from the standalone ADHD skill's two
critic calls. A critic with fewer than three non-traps violates the fresh
critic contract; it is not permission to fabricate viability. The critic
command follows the existing invalid-Report `BLOCKED`/`NEEDS-DECISION` path, no
deepener launches, and total calls are six. The admitted topology still
contains exactly three deepeners for every valid completion; no new terminal
state or successor is introduced.

`renderExplore` is a pure read-only projection over a completely reconciled
Wave. It is not a public authority artifact. The renderer must show shortlist
rationales, keep traps separate, show normalized score chips, identify the
selected target for each deepener, allow rank one to receive the star, and make
the provocation traceably wild. Call its last substantive section `Deepened`,
not `Focus`, to avoid confusing ADHD Phase 2 with Lunacy's Focus gear.

## 4. Closed typed request and decision context

Keep persisted `PlanAuthorshipInput`, `DeliberationWave/v2`, and
`DeliberationReport/v2` unchanged. Add no public mode enum, state field,
artifact, or digest. Normalize the overloaded persisted `intent` Ref once at
the private adapter as either `planCandidateRef` or `decisionIntentRef`; do not
spread that overload into new core code.

The trusted pre-Plan host constructs one private discriminated input:

```ts
type DecisionContext = Readonly<{
  problem: string;
  decisionImpact: string;
  evidence: readonly Ref[];
  constraints: readonly Ref[];
}>;

type FrontierItem = Readonly<{
  key: string;
  prospectiveEffectFrontierOrdinal: number;
  status: 'SETTLED' | 'UNSETTLED';
  discriminator?: string;
  context: DecisionContext;
}>;

type PrePlanRequest =
  | Readonly<{ mode: 'DIRECT'; authorship: PlanAuthorshipInput }>
  | Readonly<{
      mode: 'AUTO';
      authorship: PlanAuthorshipInput;
      frontier: readonly FrontierItem[];
    }>
  | Readonly<{
      mode: 'EXPLORE';
      authorship: PlanAuthorshipInput;
      decisionKey: string;
      prospectiveEffectFrontierOrdinal: number;
      context: DecisionContext;
      taskProfile: 'CODE' | 'PRODUCT';
      requestAuthority: ExploreRequestAuthority;
    }>;
```

This is carried as one canonical **private** request document on the existing
`resolve-plan --input` bridge seam and decoded into the union above. It is not
exported from the npm package, persisted in MachineState, or accepted by any
worker. The trusted parent is the sole writer. The adapter computes the existing
authorship digest itself; it does not trust a redundant caller-supplied digest
or settlement boolean. Its constructor:

- validates exact keys, primitive types, canonical ordinal ordering, unique
  frontier keys, and one context per frontier item;
- requires normalized, non-blank `problem` and `decisionImpact` text for every
  managed request and a normalized, non-blank discriminator for Focus; opaque
  IDs and placeholder prose do not satisfy this contract;
- binds the request to the existing `PlanAuthorshipInput` and current root;
- derives the earliest unsettled decision from the complete sealed frontier;
- rejects a discriminator that is blank or attached to a different decision;
- accepts initial Explore request authority only from the current trusted
  pre-Plan command boundary and binds it to intent, authority, run, phase,
  policy, decision key/ordinal, and open cutoff—never a not-yet-authored Wave;
- admits only evidence in the committed evidence-snapshot closure;
- admits only constraints reachable from current authority;
- canonicalizes Ref order, requires canonical bytes for role inputs, and
  rejects duplicates/foreign aliases;
- freezes caller-owned values before any asynchronous work.

The trusted parent maps explicit `/adhd`, “ADHD mode,” “run ADHD,” or explicit
“explore this” authority to `mode: 'EXPLORE'`; the runtime never infers Explore
from merely open-ended prose. Before Plan sealing, explicit Explore overrides a
complete-but-unsealed Plan and does not require `decisionUnsettled`. After the
cutoff it requires fresh Plan/run authority.

After deterministic Explore authorship, the host uses the existing
process-local `authorizeExplore` seam to mint and immediately consume the exact
Wave-bound capability for intent/authority/Wave/run/phase/policy/rollout. Thus
request authority is non-circular and Wave authority remains one-use.

For Focus/Explore, copy the semantic fields into the existing
`DeliberationWave.question`, and use the frontier item's real key and ordinal in
`wave.authorship`. The Wave Ref already binds those bytes. Do not add a second
context digest or capsule. A shared restart-safe closure resolver derives
`committedEvidence` and `reachableConstraints` from the retained
`evidenceSnapshot` and current authority for **every** Wave reader
(`store`, `reducer`, `execution-plane`, rollout evaluation, and driver). A
reader may never prove closure tautologically by copying the Wave's own Refs
into its allow-set.

For a fresh non-empty closure, `authorship.evidenceSnapshot.bytes` is the
canonical JSON value `{evidence:[ProjectedRef...],constraints:[ProjectedRef...]}`
with exact sorted unique projected Refs and no schema/discriminator field. Its
existing Ref digest authenticates those bytes; this is a private payload of the
existing `evidenceSnapshot` field, not a new artifact or state schema. The
shared resolver parses those retained bytes, verifies each role-input Ref and
its canonical bytes against membership, and supplies the two allow-sets to all
readers. Historical empty-list Waves do not require this private payload.

Supported historical Waves with empty semantic Ref lists retain their current
reader path. A fresh Wave with non-empty evidence/constraints is admitted only
when the closure and every required canonical byte can be reconstructed after
restart. `policyVersion` binds the exact role contract and frame catalog used
to materialize every role view.

## 5. One managed admission transaction

`resolve-plan` must be a private operation of the existing bridge transaction,
not a lock-free CLI side door.

### 5.1 Direct fast path

Parse the requested user intent first. If it resolves to DIRECT, execute the
route-local Direct validation and return without loading any managed file or
constructing a managed object.

### 5.2 Managed path

Focus and Explore use this exact order:

1. **Static parse:** validate exact CLI/request shape and discover only the
   paths needed for the selected managed route. This may fail without a lock.
2. **Lock:** enter `withBridgeOperationLock` and retain its
   `lockedRootIdentity`; load CURRENT/authority once.
3. **Freeze authority:** copy and validate `PlanAuthorshipInput`, the private
   decision projection, rollout policy, deliberation policy, capability, and
   host policy while still bound to that root.
4. **Compile in memory:** author the exact Wave, derive topology and resource
   requirements, validate policy binding, evidence/constraint closure, fresh
   Explore authority, rollout generation/floor, and complete cohort admission.
   Do not publish a Wave yet.
5. **Admission attestation:** call the real read-only Codex host attestation and
   pin the executable image/version, invariant argv template, workspace and
   handoff roots, sandbox/effect denial, model/effort, transport policy,
   resource cohort, and availability of all sealed base Ref bytes. Critic and
   deepener argv cannot yet be exact because their role views depend on
   predecessor Reports.
6. **Prepare advisory driver:** construct only the current command-scoped
   managed driver after attestation succeeds, bound to the frozen inputs and
   root identity. Do not require or attest the future writable implementation
   route; bind that lazily at the first post-Plan command.
7. **Commit:** through `makeComposedKernelForBridge`, the existing publication
   lease, writer fence, journal, store CAS, and managed START validation,
   publish the Wave Ref and START as one recoverable authority transition.
8. **Unlock before cognition:** release the bridge/workspace lock before any
   Luna provider call. v2 never holds the workspace lock through a Wave.
9. **Per-command entry fence:** after a command is claimed and its predecessor
   Reports produce the exact role view, derive exact argv/output/handoff bytes,
   verify them against the pinned admission template and current command frame,
   verify the executable still equals the pinned image, durably reserve the
   provider intent, and only then spawn.

Any failure before durable START produces no authoritative RunKernel state,
CURRENT, journal entry, outbox command, Wave publication, or provider call.
Acquiring the existing bridge lock may create and retain the private `.kernel`
namespace; that namespace is not authority and is excluded from the “no
mutation” assertion. Temporary publication siblings may exist only inside the
existing atomic cleanup contract. Any failure after
START stays on that exact admitted route and follows recovery; it cannot fall
back to ordinary START, DIRECT, another model, another Wave, or another root.

The operator rollout value `disabled` is a managed refusal. It may not cause a
compiled Wave Plan to enter the ordinary implementation driver. Retained
compatibility values such as automatic Explore may be read for history, but no
fresh admission may use them to authorize Explore.

## 6. Command-scoped execution composition

Composition must select a driver from the **current command**, never from a
retained proposal or run-wide mode:

- a current command with an exact current-Wave role view uses only the
  Luna/max deliberation driver;
- a current post-Plan roleless command lazily binds and uses only its
  preselected ordinary Lunacy worker route;
- PENDING, CLAIMED, UNKNOWN, and ACKED observations use one shared exact
  current-frame predicate;
- managed commands require exact lease/frame identity and their retained
  authority anchor;
- `modeEpoch` remains present and must equal zero at every state, CURRENT,
  supervisor, driver, and recovery boundary.

Advisory concurrency is local to the Wave and cannot leak into implementation
capacity. Focus width is 2. Explore width is 5 for generators and 3 for
deepeners. After Plan adoption, the caller's ordinary implementation capacity
is restored.

## 7. Parent adoption and the context firewall

The complete workflow is:

```text
user/project authority
  -> typed pre-Plan projection
  -> DIRECT | one FOCUS | explicit EXPLORE | NO_SETTLEMENT
  -> authority-free Reports
  -> deterministic reconciliation + volatile rendering
  -> parent selection/synthesis/rejection
  -> complete accepted Plan
  -> ordinary preselected Lunacy implementation route
  -> existing gate
  -> targeted repair if needed
  -> parent acceptance
```

Before first implementation dispatch, the parent seals the existing
requirements, accepted observable/result, architecture spine, acceptance
criteria, and acceptance-required Plan. Changed authority requires a fresh
Plan/run authority; it is not drip-fed into a live Plan.

The Plan defaults to one largest-coherent end-to-end owner cell. Split only for
real authority, ownership, safety, external-dependency, or measured
context/time/tool-capacity boundaries, and then into the fewest vertical
acceptance-required slices. Never split into plan/report/test/proof milestones.
Required documentation, accessibility, or polish remains required when the
authority says so. Genuinely optional work is excluded from this Plan and may
be proposed only after acceptance as separately authorized work.

The implementation owner receives:

- the sealed Plan and observable acceptance criteria;
- the chosen architecture spine;
- only the evidence/proof references needed to implement and verify it;
- every compact acceptance-required constraint, risk, or tripwire adopted by
  the parent, by Ref; optional alternatives remain excluded.

It does **not** receive the 30-idea pool, sibling role views, raw critic output,
renderer prose, or full conversation transcript. Those remain cold provenance.
This keeps research useful without letting session memory become workflow
trash. “Cold” means excluded from parent/worker prompt projection, not deleted
from durable recovery state. Existing seal/retention machinery may compact or
exclude terminal run material only under its own verified contract; v2 adds no
new storage tier or state shape.

## 8. Deterministic reconciliation and authority

Existing Report receipts, predecessor closure, Wave binding, role-view binding,
attempt epoch, and result digest remain the only report-admission evidence.
Reconciliation is pure and arrival-order independent.

- missing slots remain missing;
- identical duplicate receipts are idempotent;
- conflicting duplicates produce conflict;
- stale, late, foreign, malformed, or wrong-generation outputs never become
  authority;
- complete reconciliation still yields advice, not acceptance;
- only the current parent token/publication lease/state CAS may adopt a Plan;
- already claimed or UNKNOWN effects retain custody through repair and rollout.

No cached semantic answer, renderer output, dissent note, or ADHD result may
advance the RunKernel.

## 9. Evidence-sensitive provider recovery

Use one private pure decision derived from the managed driver's existing
command, provider-intent reservation, receipt, transport, and teardown evidence.
The ordinary `codex-effect-records` launch chain does not currently bracket
managed advisory calls and must not be cited as if it did. Do not add a retry
ledger, classification field, receipt schema, or state key.

| Existing evidence | Meaning | Allowed action |
| --- | --- | --- |
| no committed managed START | no admitted provider work exists | caller may retry the whole admission |
| committed START, but failure occurred before the durable provider-intent reservation was created | provider entry is proved impossible | one fresh attempt only when existing sealed ceilings allow it; fresh epoch and full reservation |
| durable provider-intent reservation exists, with or without later receipt/transport/teardown | provider entry may have occurred | keep custody, charge the full attempt, reconcile/observe retained evidence, and never invoke a provider again |
| retained valid receipt + transport + teardown | settled transport fact | reconcile it; never relaunch |

Move all retryable preparation—directory setup, auth snapshot, transport setup,
role materialization, and exact pre-entry identity checks—before the existing
durable provider-intent reservation where possible. The reservation is the
conservative any-intent-means-no-retry fence and must be fsynced before the
spawn call. A crash between that fence and actual provider entry deliberately
sacrifices a retry to prevent duplication; no terminal record may reopen it.
The intent fence is immutable and retained permanently with the attempt. The
current driver's `finally` cleanup must stop deleting it. Receipt, transport,
and teardown files supplement rather than replace it; partial combinations are
classified only as “intent exists, no re-entry” until the exact complete set can
be reconciled.

The store/coordinator owns the current semantic verdict. A driver may recover
transport facts only. Already settled history is validated against retained
command/evidence bytes, never a newly constructed live policy. An unentered
current command still must verify the executable and per-command launch values
against its frozen admission attestation immediately before creating the
provider-intent fence. Do not perform a post-provider live re-attestation that
can invalidate an otherwise retained historical result.

Crash-injection tests must cover every cut before and after reservation fsync,
spawn, provider exit, transport persistence, teardown, receipt, ACK, and
restart. Only a cut with no durable provider-intent fence is retryable. Every
ambiguous cut fails closed to no re-entry.

## 10. ADHD semantic contract ownership

Lunacy packages a versioned copy of the ADHD semantic contract. It does not
read the mutable installed ADHD `SKILL.md` at runtime and does not invoke ADHD
as a second router.

Source owns content-addressed canonical policy assets under
`assets/deliberation-policy/<sha256>.json`; the build emits the same closed files
under `runtime/assets/deliberation-policy/`, and the signed deployment manifest
binds their names and bytes. The filename is SHA-256 of the canonical asset
bytes. `policyVersion` is a Ref whose digest equals that filename; the asset
does not contain its own Ref/digest and therefore has no self-reference. Each
asset contains only:

```text
schema, stable policy id, exact Focus contracts, exact Explore generator /
critic / deepener contracts, multi-tag frame catalog, output ceilings
```

The Explore generator contract is the ADHD divergent instruction: six short
distinct ideas, `{text,rationale}`, no evaluation/ranking/hedging, first three
obvious answers banned, awkward middle required. The critic contract defines
the three axes, exact 0–10 score range, one-line trap reason, 3–6 underlying-
mechanism clusters, complete partitions, `35/40/25` ranking, and the underfilled
non-trap outcome. The deepener contract requires 4–8 sentences, one
load-bearing risk, first coder step, and 3–5 variations/hybrids/unlocks.

Every fresh and restarted role materialization resolves the retained
`frameId` through the exact catalog selected by `policyVersion`. Readers reject
missing or duplicate frame IDs and never reconstruct frame text or tags from
array position, the ID string, or current global defaults. Initial and
post-restart role-view bytes for the same retained Wave must therefore be
identical; the Wave keeps only the existing IDs because the retained
content-addressed policy asset is their immutable semantic owner.

For fresh v2 Waves, `policyVersion.digest` selects the exact asset; Ref equality
alone is not sufficient. Legacy `policyVersion` digests may bind smaller old
documents and cannot be redefined as rich asset hashes. The deployment census
therefore produces a signed private compatibility map from each supported
legacy digest to the exact retained legacy asset digest. The map is reader-only
and may not authorize fresh writers. A missing asset or mapping for a supported
unfinished root blocks build/deployment/activation—it may not turn restart into
a refusal. Corrupt or explicitly unsupported unknown versions fail closed. A
global prompt edit may never reinterpret old Wave bytes. Package/deployment
tests compare source, packed, and installed assets and compatibility map
atomically.

The standalone ADHD skill remains useful for explicit architecture research
outside a Run. Lunacy's EXPLORE is the production-safe equivalent inside a Run:
same cognitive semantics, fewer critic calls, bounded refs/bytes/tokens,
effect denial, deterministic receipts, restart safety, and parent authority.

## 11. Failure matrix

| Condition | Required result |
| --- | --- |
| malformed or extra request field | refuse before authoritative mutation; private lock namespace may exist |
| explicit DIRECT with valid complete Plan | return exact Plan; zero managed reads/calls/artifacts |
| explicit DIRECT without valid Plan | `NO_SETTLEMENT` |
| AUTO with canonically complete Plan and no unsettled frontier item | exact DIRECT |
| AUTO whose earliest unsettled frontier item has a real named discriminator | one Focus candidate |
| AUTO without complete Plan or discriminator | `NO_SETTLEMENT` / one parent decision |
| AUTO Focus selected but policy/capability/host unavailable | visible managed refusal; no Direct fabrication |
| explicit EXPLORE unavailable or unauthorized | visible refusal; no fallback |
| explicit EXPLORE before cutoff with complete-but-unsealed Plan | Explore, when authority/capability admits it |
| fresh input merely looks open-ended/high-stakes | never Explore |
| rollout disabled after a managed Wave is compiled | refuse; never ordinary START |
| root/policy/pinned executable changes between prepare and commit | refuse before START |
| crash before START | no admitted run; safe whole-admission retry |
| post-START failure before provider-intent reservation fsync | bounded full-reservation retry under section 9 |
| provider-intent reservation exists | custody-bound recovery; no provider re-entry |
| Explore critic returns fewer than 3 non-traps | invalid-Report `BLOCKED`/`NEEDS-DECISION` after six calls; no deepeners and no adoption token |
| report is late/stale/foreign/conflicting | reject from authority |
| parent rejects all Reports | token remains parent-owned; no fresh successor Wave/WIDEN |
| old supported Wave/Report/recovery root | exact historical reader/recovery path |
| fresh generation below the writer floor | refuse new managed admission |

## 12. Performance and reliability budget

| Property | DIRECT | FOCUS | EXPLORE |
| --- | --- | --- | --- |
| advisory calls | 0 | maximum 3; exactly 3 on valid completion | maximum 9; 6 on underfilled critic; exactly 9 on valid completion |
| fan-out wavefront | 0 | 2 then 1 | 5 then 1 then 3 |
| Waves | 0 | 1 | 1 |
| successor/re-entry | none | none | none |
| workspace lock during model calls | none | none | none |
| model/effort | none | Luna/max | Luna/max |

Admission reserves calls, input/output tokens, Report bytes, Ref occurrences,
persisted bytes, deadline, and concurrency before provider entry. Over-budget
work refuses; unused capacity does not authorize WIDEN or post-Plan research.

Initial production byte ceilings are deliberately small and role-specific:

- problem 8 KiB, decision impact 4 KiB, discriminator 2 KiB;
- each idea text 512 bytes and rationale 1 KiB;
- each Focus Report 16 KiB; aggregate Focus Reports 48 KiB;
- each Explore generator Report 16 KiB, critic Report 48 KiB, deepener Report
  24 KiB, and aggregate Explore Reports 256 KiB;
- each materialized role view 192 KiB and Wave bytes 96 KiB.

Admission computes aggregate role-input and persisted-byte demand in addition
to per-role limits. These ceilings are product constants in the bound policy
asset, not caller-controlled ambient values. Raising one requires fixture and
memory evidence plus a policy-version change; readers may retain higher
historical ceilings found by the compatibility census.

Performance acceptance is structural first: Direct has zero managed reads,
initialization, artifacts, calls, or model-runtime startup; side-effect-free
shared imports are allowed. Managed call ceilings and widths are exact.
Benchmarks then compare Direct median and p95 to the tracked baseline and record
the delta, but no timing-only result can waive a structural violation.

## 13. Compatibility, rollout, and rollback

### 13.1 Historical compatibility

- Keep Wave/Report v2 and all public event/model/yield shapes.
- Keep `modeEpoch` and freeze it at zero.
- Keep old proposal, Wave, Report, attempt, reservation, settlement,
  rollout-origin, lease, outbox, and recovery bytes.
- Continue reading only census-declared supported old two/three-lens Focus,
  call ceilings, persisted WIDEN, D4 lineage, and deliberately published
  compatibility fixtures. Synthetic history is not permanent production
  authority merely because a test once created it.
- Materialize each supported historical role with its retained topology-aware
  legacy policy asset; never apply the fresh two-candidate Focus wording to a
  retained three-lens role or infer old frame semantics from current defaults.
- Retain the content-addressed policy asset for every supported unfinished
  Wave; missing required assets block release rather than strand restart.
- Never normalize, migrate, or replay old artifacts through fresh mode
  selection.
- Guard fresh admission by recorded `rolloutOrigin.generation` and the
  deployment-census-derived writer floor.

### 13.2 Activation corridor

1. **Disabled deploy:** atomically install the complete signed package with
   fresh managed admission disabled; verify source/install manifest parity.
2. **Shadow:** exercise pure resolver/context/admission decisions without
   provider effects or authority.
3. **Explicit Focus canary:** trusted test/host authority requests bounded
   Focus; prove restart and implementation handoff.
4. **Explicit Explore canary:** prove exact 5×6/critic/3 topology and rendering.
5. **AUTO Focus canary:** enable the truthful AUTO decision table for fresh
   generations only.
6. **Default AUTO:** expand only after crash lattice, replay corpus, and
   source-to-installed checks stay green.

There is no fresh automatic-Explore stage. Retain any old
`automatic-explore` value only as a historical reader/rollback compatibility
spelling; fresh admissions fail closed.

Rollback disables **new** managed admission at a higher generation. It never
rewrites CURRENT, adopted Plans, receipts, or retained Wave lineage. Runs with
admitted/UNKNOWN effects keep custody and recover with the installed reader
floor; therefore operators may not deploy a runtime older than any live
persisted generation it must read and dispatch.

## 14. v2 amendment to the v1 freeze

The following changes are intentional and exhaustive:

| v1 rule | v2 rule | Reason |
| --- | --- | --- |
| automatic implicit Explore allowed for open-ended + high-stakes + openly phrased input | Explore is explicit-only for every fresh run; historical D4 remains readable | prose heuristics cannot carry authority and made AUTO unpredictable |
| advisory route Luna/xhigh | advisory route Luna/max | current user authority and candidate contract; exact route remains fail-closed |
| Focus permits 2–3 generators | fresh Focus uses exactly 2 generators + 1 critic | lower latency, one-decision scope, exact testable topology |
| one fixed code-shaped Explore frame rule | fresh frame selection is task-profile aware, multi-tagged, and deterministically rotated while keeping five isolated generators | preserves ADHD fidelity for both code and product decisions without nondeterminism |
| an ambiguous fully charged attempt may retry with a fresh epoch/reservation | a durable provider-intent fence permanently forbids re-entry; only failure before that fence may retry with fresh epoch/full reservation under existing ceilings | avoids duplicate effects while allowing safe preparation glitches to recover |
| successor Wave and canonical WIDEN writers exist | fresh v2 Focus/Explore writes neither successor Waves nor WIDEN; supported historical forms remain readable with their leases | automatic cognition is one pre-Plan wave, never a run-wide loop |

All other v1 invariants remain: one kernel, Direct bypass, parent authority,
two existing deliberation schemas, exact resource reservation, deterministic
reconciliation, publication/GC safety, action-adoption freshness, and
fail-closed managed capability.

## 15. Implementation map (fewest reversible cells)

These are bisection/commit cells inside one acceptance-required release, not a
worker dependency DAG or separate product milestones. One largest-coherent
owner on the user-authorized Lunacy worker route should implement them unless a
measured capacity boundary forces the fewest vertical split.

### Cell 0 — own the baseline

- track the hermetic compatibility corpus and fixtures;
- remove every test dependency on `Lunacy/runs` or installed skill state;
- record current Direct/replay bytes and generation census;
- add this v2 architecture and freeze record without rewriting v1.

Gate: tracked-only clean checkout passes the baseline suite.

### Cell 1 — truthful resolver and route-local Direct

Primary seams: `src/bridge-cli.ts`, `src/deliberation.ts`.

- delete synthetic AUTO booleans;
- add the private discriminated request/frontier constructor and trusted host
  carrier for problem/impact/context/authorization;
- make the Direct branch occur before managed file reads or initialization;
- reject a normalization-dependent Plan and return the parsed canonical input;
- implement the exact DIRECT/FOCUS/NO_SETTLEMENT table;
- admit explicit Explore before cutoff without a fake unsettled boolean;
- reject fresh implicit Explore.

Focused proof: `test/p4-resolve-plan.test.js`,
`test/p2-deliberation.test.js`, compatibility corpus.

### Cell 2 — locked prepare→attest→commit

Primary seams: `src/bridge.ts`, `src/public.ts`, `src/bridge-cli.ts`,
`src/composition.ts`, `src/codex-deliberation-driver.ts`.

- route `resolve-plan` through the existing operation lock;
- reuse the root-bound composed-kernel constructor;
- compile the Wave purely, perform admission/template attestation, and only then
  commit START;
- perform per-command exact argv/role/executable fencing immediately before the
  durable provider-intent reservation and spawn;
- refuse disabled/ineligible managed execution;
- lazily bind the ordinary post-Plan route and preserve routing by current
  command.

Focused proof: root replacement, concurrent START, failed/delayed attestation,
no CURRENT/journal/outbox/Wave authority on refusal (private lock namespace is
allowed), valid Focus/Explore handoff, per-command drift refusal, lazy ordinary
route binding, and disabled-policy non-downgrade tests.

### Cell 3 — ADHD semantics and context firewall

Primary seams: `src/deliberation.ts`, `src/store.ts`, `src/reducer.ts`,
`src/execution-plane.ts`, `src/public.ts`, role-policy asset packaging, pure
renderer, `src/codex-host-policy.ts:commandAuthorityPaths` /
`buildWorkerHandoff`, and `src/codex-exec-supervisor.ts` launch snapshots.

- bind exact role strings and frame catalog to policy version;
- resolve every retained `frameId` from that exact asset on initial execution
  and restart; delete positional/ID-as-text reconstruction;
- populate real question/impact/discriminator/evidence/constraints;
- use one restart-safe evidence/constraint closure resolver at every reader;
- add multi-tag, task-profile-aware, digest-rotated frame selection;
- strengthen only narrow semantic validators: distinct non-empty ideas,
  bounded text, non-empty trap reason, exact scoring/clustering/deepening
  contracts, and the underfilled-critic stop path;
- repair the pure renderer and expose it only as volatile parent projection;
- prove poisoned/raw research files are absent from command authority paths,
  handoff bytes, launch snapshots, and implementation prompts.

Focused proof: golden role views, predecessor isolation, closure validation,
ADHD semantic fixtures, renderer fixtures, and no transcript leakage.

### Cell 4 — evidence-sensitive recovery

Primary seams: `src/codex-deliberation-driver.ts`,
`src/dispatch-coordinator.ts`, `src/reducer.ts`, `src/one-shot.ts`, and shared
immutable-create/fsync helpers; reuse ordinary effect-record helpers only where
their exact semantics fit.

- move retryable preparation before the existing durable reservation;
- fsync and permanently retain that reservation as the provider-intent/no-retry
  fence; never delete or replace it during cleanup;
- implement one pure retry disposition over managed reservation, receipt,
  transport, and teardown evidence;
- wire it into the sole production coordinator/provider path;
- change reducer/one-shot retirement only for the proved no-fence disposition
  so a fresh epoch/full reservation can be persisted; every fenced attempt
  remains terminal and custody-bound;
- keep pre-spawn equality with frozen admission identity, but remove only the
  post-provider live-policy verdict after wiring tests pass;
- retain any-intent-means-no-blind-retry and managed anchor fencing.

Focused proof: crash cuts before/after START, reservation fsync, spawn, provider
exit, transport, teardown, receipt, ACK, restart observation, stale/replayed
evidence, and ambiguous non-duplication.

### Cell 5 — release and install

- reconcile floor documentation with the census-derived constant;
- run typecheck, build, focused suites, complete test suite, pack dry-run, and
  tracked-only deployment test;
- atomically deploy disabled;
- verify installed manifest, docs, role assets, runtime package, and
  `resolve-plan --help` parity;
- activate canaries only under separate rollout authorization.

## 16. Acceptance matrix

Implementation is accepted only when all observables hold:

1. explicit DIRECT and AUTO→DIRECT perform zero managed reads, artifacts, or
   advisory calls and retain exact Plan bytes;
2. AUTO reaches all three outcomes from a sealed frontier and prose or
   contradictory booleans cannot mint a predicate;
3. fresh Explore is possible only with exact current explicit authority;
4. explicit ADHD language maps at the parent boundary to Explore even when a
   complete Plan is still unsealed;
5. Focus is at most 2+1; successful Explore is exactly 5+1+3, underfilled
   Explore stops after 5+1, and both semantically match section 3;
6. every advisory role receives the same byte-identical sealed **base** semantic
   context within resource ceilings, plus only its role-specific predecessor
   projection, and no forbidden authority fields;
7. all Wave readers prove semantic Ref closure from retained authority, not from
   the Wave's own allow-list;
8. admission/template attestation and full cohort admission happen before
   durable START, and exact command fencing happens before provider intent;
9. root, policy, executable, or capability drift refuses without authority
   publication;
10. disabled managed rollout cannot ordinary-START a Wave Plan;
11. post-Plan ordinary commands reach their preselected Lunacy route and never
   inherit advisory capacity or driver selection;
12. crash/restart tests prove no retry after provider-intent reservation and no
   duplicate ambiguous provider effect;
13. every census-supported historical fixture replays byte-for-byte with its
    retained policy asset and no migration or new
    generation;
14. initial and restarted materialization of a retained role produces identical
    bytes, tags, and frame text from its policy asset; no reader synthesizes
    frame semantics from position or ID;
15. renderer output is useful but cannot affect state or authority;
16. implementation authority paths, handoff, launch snapshot, and prompt contain
    the Plan and all adopted acceptance-required proof, not raw ADHD
    research;
17. source, tracked-only checkout, packed artifact, and installed skill are
    manifest-consistent.

Worker PASS, test count, artifact count, or evidence volume is not acceptance.
The parent evaluates the canonical end-to-end observable at the existing gate.

## 17. Rejected traps

- embedding the standalone ADHD skill as a runtime router;
- reading mutable installed `SKILL.md` as production protocol authority;
- a public mode state machine, decision ledger, retry ledger, nonce ledger,
  context capsule schema, or second scheduler;
- implicit Explore from open-ended/high-stakes prose;
- silent Direct fallback after a managed route was selected;
- holding the workspace lock through model calls;
- blanket provider retry or blanket terminal failure;
- a legacy virtual machine instead of generation-aware readers;
- a shadow observatory or semantic cache before a measured need exists;
- putting raw research into implementation/session memory;
- optional polish nodes in the acceptance-required Plan;
- piecemeal patching of signed installed runtime files.

## 18. Final architecture in one sentence

**AUTO is a one-shot typed pre-Plan decision, DIRECT is a physically isolated
bypass, EXPLORE is explicit ADHD-shaped advice, managed work enters through one
locked attested START, only the parent adopts a Plan, and the preselected
ordinary Lunacy route receives the compact accepted result—not the research
mess.**
