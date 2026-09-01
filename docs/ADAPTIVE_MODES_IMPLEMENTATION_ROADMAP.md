# Lunacy adaptive modes implementation roadmap

**Status:** implementation-ready roadmap; this document changes no runtime,
rollout, installation, or public API behavior.

**Architecture authority:**
[`orchestrator/DELIBERATION.md`](../orchestrator/DELIBERATION.md), refined by the
AUTO / DIRECT / explicit EXPLORE contract below.

**Objective:** deliver three useful user intents through one Lunacy pipeline:

- `AUTO` is the default and selects Direct or one bounded Focus Wave;
- `DIRECT` explicitly suppresses pre-Plan deliberation fan-out;
- `EXPLORE` explicitly requests one full ADHD Wave.

All three converge on the same parent-authored Plan, ordinary Sol/high
implementation route, gates, targeted repair, and parent acceptance. Direct
means zero **deliberation** fan-out, not zero implementation workers.

This roadmap is deliberately mechanical. It names the existing defects, fixed
compatibility corridors, file ownership, red/green tests, commit order,
release gates, activation sequence, rollback, and conditions that stop work.

## 1. Fixed product contract

### 1.1 Public intent and internal gear

| Public intent | Internal result | Advisory topology | Advisory route |
| --- | --- | --- | --- |
| `AUTO` | `DIRECT` or one `FOCUS` | zero calls, or two isolated generators followed by one critic | effect-denied Luna/max |
| `DIRECT` | `DIRECT` | zero Wave, Report, managed host, or advisory calls | none |
| `EXPLORE` | `EXPLORE` | five isolated generators, one critic, three isolated deepeners | effect-denied Luna/max |

The user-facing choice is not a runtime state machine. `FOCUS` is an internal
gear, not a fourth public mode. The rollout corridor (`disabled`, `shadow`,
canaries, `automatic-focus`, and retained compatibility values) is operator
policy, not user intent.

### 1.2 Exact canonical writers

New Focus Waves must contain:

- exactly two lenses, in order: `counterexample`, `simplify`;
- exactly two generator slots and one critic slot;
- exactly `maxModelCalls: 3`;
- generator wavefront capacity two;
- one candidate per generator;
- critic coverage of both candidates exactly once;
- one or two non-empty comparison groups that partition both candidates;
- no deepener and no successor Wave.

New Explore Waves must contain:

- exactly four code/design frames and one wild frame;
- exactly six ideas per generator, thirty total;
- one critic that scores every idea once, marks traps, and partitions the full
  pool into three to six non-empty mechanism clusters;
- exactly three deepeners for the top three non-traps;
- exactly `maxModelCalls: 9`;
- generator wavefront capacity five and deepener wavefront capacity three;
- no automatic successor Wave.

Readers continue to accept supported historical Wave/Report v2 forms,
including byte-identical two-lens/three-call Waves whose old Reports used the
legacy three-to-six-group contract, three-lens/four-call Focus, and persisted
WIDEN/D4 material. There is deliberately no new artifact discriminator:
readers accept the union of supported old and new forms, while new writers and
new public admissions produce only the exact forms above.

### 1.3 Selection and cutoff

The host resolves intent exactly once before Plan sealing and before the first
implementation dispatch:

```text
if cutoff crossed:
  late explicit Explore -> fresh Plan/run authority required
  otherwise             -> no deliberation entry
else if explicit Direct:
  Direct
else if explicit Explore:
  exact capability preflight -> Explore or visible refusal
else: # AUTO
  settled / cited witness / Plan-equivalent / contained -> Direct
  one named material unresolved discriminator          -> Focus candidate
  otherwise                                             -> NO_SETTLEMENT / parent decision
```

Direct is returned only with a complete validated parent Plan; it is never a
fallback spelling for unresolved input.

AUTO never selects Explore. Multiple material decisions do not create a loop:
one Wave may examine only the earliest named discriminator. The parent settles
all remaining questions or asks for new authority.

For an AUTO Focus candidate, exact read-only capability/host attestation occurs
before constructing/publishing a Wave and before invoking managed `START`. If
preflight cannot prove capability, the optional unadmitted optimization is
omitted and Direct remains byte-identical; any diagnostic is volatile and
non-authoritative. Explicit Explore refuses instead of downgrading.

Invocation of managed `RunKernel.advance(START)` is the irreversible cutoff.
After that invocation, the admitted Wave has no Direct/model fallback, blind
retry, replacement attempt, successor Wave, or automatic re-entry. Restart may
only reconcile the exact retained command and immutable evidence. Unproven
provider/process teardown remains `BLOCKED`.

### 1.4 Authority and context

Before implementation, the parent seals the existing requirements, accepted
observable/result, chosen architecture spine, and acceptance-required Plan.
Reports cannot write the workspace, spawn implementation work, change
requirements, adopt a Plan, pass a gate, or claim acceptance. Changed authority
after the cutoff starts a fresh Plan/run authority.

The parent passes implementation workers the sealed Plan, acceptance criteria,
and necessary evidence, not the full Wave or thirty-idea transcript. Advisory
artifacts become cold provenance after Plan adoption. Optional polish is not an
executable node in the accepted Plan and may be proposed only as a separately
authorized follow-up after acceptance.

## 2. Current defects that block activation

| Defect | Current seam | Required observable |
| --- | --- | --- |
| Managed composition replaces the ordinary driver. | `src/composition.ts` | After `COMPLETE_PLAN`, roleless commands reach the ordinary Sol/high driver; Wave commands reach only the Luna/max deliberation driver. |
| Envelope grammar is selected from the retained proposal. | `src/reducer.ts` `WORKER_ENVELOPE` | `command.roleView` selects Report/v2; a current post-Plan roleless command accepts the ordinary status envelope despite retained provenance. |
| Every schema-2 live command can receive managed reservation/attempt state. | `src/reducer.ts` `applyManagedReservations` | Only exact current-Wave commands receive managed reservations and attempts. |
| UNKNOWN managed retirement opens a fresh epoch and command. | `src/reducer.ts` `retireManagedAttempt`, `src/public.ts`, `src/dispatch-coordinator.ts` | Canonical Focus/Explore ambiguity terminalizes once without epoch increment, READY reset, fresh reservation, observation loop, or provider re-entry. |
| Parent decisions can author successor Waves. | `src/public.ts` `prepareDecisionPublication`, `src/reducer.ts` decision validation/application | Canonical Focus/Explore successor spellings refuse before lease acquisition and again at the state CAS; token remains unconsumed. |
| Selector still authors implicit Explore. | `src/deliberation.ts` `selectGear`/`proposeGear` | Only current explicit user authority authors Explore. |
| Focus writer reserves four calls for three slots. | `src/deliberation.ts` `defaultLimits` | New Focus writer, capability, reservation, topology, and diagnostics all agree on exactly three calls. |
| Focus critic inherits Explore's three-to-six cluster contract. | `src/deliberation.ts` role materialization/report validation | Canonical Focus uses one or two non-empty comparison groups; archived Focus reports retain their reader path. |
| One global `maxInFlight` can leak advisory width into implementation. | `src/public.ts`, composition/dispatch admission | Pre-Plan Focus/Explore use topology width two/five; post-Plan returns to the caller's ordinary implementation capacity. |

Do not enable D3 automatic Focus until all rows are proven by one canonical
Focus-to-implementation journey and restart/fault coverage.

## 3. Compatibility corridors

These are frozen through the implementation:

| Corridor | Rule |
| --- | --- |
| Public model/event/yield shapes | No new public event, mode enum, MachineState field, schema, controller, ledger, Plan-seal flag, or lifecycle API. |
| `modeEpoch` | Retain the field and require `modeEpoch === 0`; never increment or repurpose it. |
| Direct path | Zero managed composition inputs, zero Wave/Report artifacts, and byte-for-byte existing schema-1 behavior. |
| Durable managed history | Keep proposal, Wave, Report, attempt, reservation, settlement, rollout-origin, lease, outbox, and recovery evidence. No migration or normalization. |
| Historical readers | Continue reading supported two/three-lens Focus, WIDEN, D4, and old call ceilings. Corrupt hybrids fail closed without mutation. |
| One-shot rollout boundary | Use the existing immutable `rolloutOrigin.generation`, with a deployment-census-derived floor. New Focus/Explore admissions at or above the floor are one-shot; lower generations are historical reader/recovery only. |
| Explicit Explore authority | A loose runtime boolean is not authority. Only the trusted private pre-Plan host adapter may attest the exact current intent/Wave/run/policy tuple; no persisted field or public mode API is added. |
| Parent authority | Existing decision token, publication lease, state CAS, Plan adoption, gates, and final acceptance remain the only authority seams. |
| Implementation behavior | After Plan adoption, ordinary worker routing, repair, claims, capacity, and gates remain unchanged. |
| Package surface | Keep deliberation/composition internals private; do not add a public mode API or root export. |
| Rollback | Disable new admission; never rewrite or delete admitted history to downgrade it. |

Any corridor drift is parent FINDINGS. Do not update fixtures to bless a drift
unless the user separately changes compatibility authority.

## 4. How to execute the roadmap

### One largest-coherent owner per release

Use one Sol/high implementation owner for each release below. The numbered
cells are red/green/commit bisection points, not Plan nodes, progress
milestones, or separately accepted outcomes. Parent acceptance occurs only at
the release gate.

After an owner publishes a candidate:

1. one read-only tester runs the focused, restart, fault, and broad matrix;
2. one independent Sol/high reviewer inspects the exact diff and observations;
3. the parent evaluates the stated observable and decides PASS/FINDINGS.

Worker PASS, test count, evidence count, or file count is not acceptance.

### Release dependency chain

```text
R0 compatibility oracle
  -> R1 command-scoped execution-plane routing
  -> R2 one-shot lifecycle and successor closure
  -> R3 canonical reader/writer contracts
  -> R4 host intent resolver and doctrine
  -> R5 disabled install, canaries, D3 activation
```

Do not parallelize R1-R4. Each changes the interpretation consumed by the next
release. Within a release, tests may be written before production code, but no
worker should independently edit shared routing/reducer files.

## 5. R0 — freeze compatibility and fault authorities

**Live behavior:** none.

**Purpose:** make compatibility executable before changing readers, routing,
or writers.

### R0-A — immutable test-owned corpus

Add:

- `test/fixtures/adaptive-modes/manifest.json`;
- canonical fixture bytes under `test/fixtures/adaptive-modes/`;
- `test/adaptive-modes-compat.test.js`.

The manifest records a fixture ID, SHA-256, expected accept/refuse result, and
closed semantic projection. Fixtures must be test-owned and tracked; they may
not reference `Lunacy/runs/**`, an installed skill, or mutable session evidence.

Freeze at least:

1. Direct START -> worker -> gate -> PASS bytes and restart bytes;
2. current two-lens/four-call Focus Wave and complete Report chain;
3. legacy three-lens/four-call Focus Wave/Report chain;
4. explicit Explore 5+1+3 chain;
5. consumed historical WIDEN and D4 store state;
6. FileArtifactStore restart with retained proposal and settlement;
7. mixed-era corrupt Wave/Report/token/origin/digest combinations;
8. nonzero `modeEpoch` refusal corpus;
9. stale/foreign `roleView`, report, settlement, and authority-anchor variants.
10. the collision case: an exact two-lens/three-call Wave with a supported
    legacy three-to-six-group Report;
11. rollout-origin generations immediately below, at, and above a provisional
    one-shot boundary, including unfinished managed attempts.

Before choosing the production boundary, run a read-only census over every
retained or restorable supported schema-2 root under every release-manifest
discovery parent—not merely active roots. Record the maximum rollout
generation, modes, Wave gears, terminal/archive status, and whether an
unfinished managed attempt exists. Do not copy mutable run data into tests and
do not infer a floor from fixture data. R5 must choose a strictly newer
production generation from this census; an omitted discovery parent,
uncertainty, or an unreadable supported root stops activation.

### R0-B — two oracles

- **Direct oracle:** compare canonical event, state, Yield, outbox, journal, and
  restart bytes at the baseline commit and candidate. Require zero Wave/Report
  creation and zero deliberation provider calls.
- **Managed reader oracle:** compare accept/refuse, topology, ordered Reports,
  settlement, rollout origin, attempts, and replay. Also compare raw Ref/digest
  bindings; semantic normalization alone is insufficient.

Corrupt fixtures must leave MemoryArtifactStore/FileArtifactStore bytes exactly
unchanged after attempted load/advance.

### R0 gate

R0 passes only if it is green against the unmodified baseline. If a fixture
needs product code to become green, the fixture is coupled to the desired
implementation and must be redesigned.

**Suggested commit:**
`test(deliberation): freeze adaptive-mode compatibility and fault corpus`

## 6. R1 — command-scoped execution-plane routing

**Accepted outcome:** a complete Focus Wave may adopt a different implementation
Plan, then ordinary Sol/high work and ordinary envelopes proceed while managed
provenance remains intact.

### R1-A — canonical failing vertical journey

Add `test/p4-post-plan-routing.test.js` before source edits. Drive:

```text
managed Focus START
-> 2 generator Reports
-> critic Report
-> parent SYNTHESIS/SELECTION with a genuinely different COMPLETE_PLAN
-> implementation dispatch
-> ordinary {"status":"DONE"} envelope
-> existing gate due
```

The initial test must prove the current contradiction, not mask it by returning
the Wave Plan as `COMPLETE_PLAN` or by reusing the deliberation driver as the
ordinary driver.

### R1-B — one pure pre-/post-Plan and command-owner derivation

In `src/deliberation.ts` or one equally narrow private module, add a pure helper
that derives, without persistence:

```text
PRE_PLAN
  proposal/roleWaveRef validates
  current committed Plan equals the Plan compiled from that Wave
  command step is an exact current topology slot
  no consumed current-origin COMPLETE_PLAN decision has replaced the Wave

POST_PLAN
  proposal remains
  one current-origin decision token is consumed
  resultKind == COMPLETE_PLAN with publication/result binding
  state.planDigest == proposal.planDigest
```

For an unprepared command, only the PRE_PLAN/current-topology proof selects
managed preparation. For a prepared/retained command, `command.roleView` and
its companion predecessor binding are the durable owner. Ambiguity refuses.

Do not clear the proposal or change its closed-graph Plan digest behavior in
this release. The proposal is provenance, not active route selection.

### R1-C — private dual-driver composition

In `src/composition.ts`, replace managed driver substitution with a private
multiplexer that snapshots both existing drivers once:

- PRE_PLAN exact Wave command -> `CodexDeliberationDriver.prepare`;
- `roleView` command -> deliberation `dispatch`/`observe`/teardown;
- POST_PLAN/current roleless command -> original ordinary driver;
- no ordinary driver -> existing `HumanReceiptRequired`, without claim or
  UNKNOWN mutation;
- missing/ambiguous retained command during observe -> refuse, never guess.

If needed, extend the private `EffectDriver.observeTeardown` signature with an
optional retained command so routing is deterministic. Do not add mutable
driver tickets, maps that become authority, a command-kind field, or a public
composition API.

### R1-D — reducer/reservation ownership

In `src/reducer.ts`:

- `applyManagedReservations` admits only exact current-Wave commands;
- `WORKER_ENVELOPE` uses `command.roleView` for Report/v2 validation;
- a roleless POST_PLAN/current command uses the existing ordinary envelope
  path even when `state.schema === 2 && state.managed.proposal`;
- a `roleView` command never accepts ordinary `{status:"DONE"}`;
- an ordinary schema-2 command receives no managed reservation or attempt.

In `src/dispatch-coordinator.ts`, recheck route availability before the claim
CAS. No driver may receive a command outside its derived ownership.

### R1-E — plane-scoped capacity

Treat the caller's existing `maxInFlight` as ordinary implementation capacity.
While PRE_PLAN is derived, use only the current topology wavefront:

- Focus generators: two; Focus critic: one;
- Explore generators: five; critic: one; deepeners: three.

After `COMPLETE_PLAN`, immediately return to ordinary capacity. Do not persist a
capacity mode or allow Explore's width five to leak into implementation.

### R1 focused matrix

1. Focus -> distinct COMPLETE_PLAN -> ordinary driver -> ordinary envelope.
2. Same journey after FileArtifactStore restart.
3. No ordinary driver after adoption -> `HumanReceiptRequired`, command remains
   unclaimed, zero deliberation calls.
4. Target Plan intentionally reuses a Wave step ID -> consumed decision/current
   Plan authority prevents managed reclassification.
5. Managed command plus ordinary DONE envelope -> refusal without mutation.
6. Ordinary post-Plan command plus Report/v2 -> refusal without mutation.
7. Ordinary schema-2 command has no managed reservation/attempt.
8. Restarted managed CLAIMED/UNKNOWN uses deliberation observation from durable
   `roleView`; restarted ordinary UNKNOWN never enters managed retirement.
9. Focus and Explore advisory wavefront widths are 2/5; implementation capacity
   is unchanged after adoption.
10. Direct byte corpus remains identical.
11. The ordinary Codex host-policy/driver fixture records the actual post-Plan
    launch request and proves `gpt-5.6-sol` with reasoning effort `high`; a
    negative assertion such as "not Luna" is insufficient.

### R1 gate and rollback

Gate on the complete vertical journey plus R0 and existing routing/recovery
regressions. R1 changes no format. Rollback restores old routing code, but AUTO
and EXPLORE activation must remain disabled because the old post-Plan defect
returns.

**Suggested bisection commits:**

1. `test(deliberation): reproduce post-plan route capture`
2. `fix(deliberation): route commands by current wave and role view`

Only the combined R1 candidate is releasable.

## 7. R2 — one-shot terminal lifecycle and successor closure

**Accepted outcome:** one canonical Focus/Explore Wave either produces a
complete Plan or stops at one stable parent-facing boundary. It never creates a
replacement attempt or successor Wave.

### R2-A — census-derived one-shot generation floor

After R0's retained/restorable-root census, seal an installed-policy constant named
`ONE_SHOT_ROLLOUT_GENERATION_FLOOR` (or the repository's equivalent private
policy constant) to a generation strictly greater than every generation found
in the supported corpus. The chosen value and census observation belong in
release evidence, not a new state field.

Derive one-shot policy solely from existing immutable facts:

- the retained Wave gear is `FOCUS` or `EXPLORE`; and
- the command/proposal's captured `rolloutOrigin.generation` is greater than or
  equal to the sealed floor.

This applies to every newly admitted Focus/Explore Wave at or above the floor,
including operator canaries. Lower-generation rows, including consumed
WIDEN/D4 and any unfinished attempt discovered by the census, retain their
supported historical reader/recovery semantics. Never classify from mutable
current policy, current rollout generation, diagnostics, or a canary label.
The public and reducer guards must share this exact derivation.

### R2-B — refuse every successor spelling twice

In `src/public.ts` `prepareDecisionPublication`, before acquiring a publication
lease, reject one-shot decisions containing:

- disposition `WIDEN`;
- `successorWaveRef` or `nextWaveRef`;
- `PlanAuthorshipResult.kind === DELIBERATION_REQUIRED` under
  `SELECTION`/`SYNTHESIS`;
- equivalent successor material nested in `result.wave`.

Repeat the authoritative check in `src/reducer.ts`
`validateManagedDecisionBinding`/`applyManagedDecision` immediately before the
state mutation. Rejection is non-consuming and creates no lease, settlement,
journal row, epoch change, or state change. A valid `COMPLETE_PLAN` remains
accepted.

Keep legacy WIDEN parsing/store validation and historical restart behavior.
New canonical public flows do not author it.

### R2-C — terminal UNKNOWN branch

Split `retireManagedAttempt` by exact command/origin ownership:

- canonical one-shot command requires `roleView` and its bound managed attempt;
- set the existing attempt to terminal `TIMED_OUT`, `CANCELLED`, or `FAILED`;
- keep the command and charged reservation as immutable evidence;
- persist existing recovery/teardown evidence;
- do not increment `attemptEpoch`;
- do not reset the step to READY;
- do not call `refreshAdmission` or `applyManagedReservations`;
- persist a stable non-retryable `BLOCKED` result.

Lower-generation historical behavior retains its existing reader/recovery
semantics until separately retired. A canary at or above the floor is not
legacy and must use the one-shot branch. An ordinary schema-2 UNKNOWN command
must never enter the managed retirement function.

`src/public.ts` must commit the changed terminal state even though the returned
outcome is `BLOCKED`; the current `commitRetireManagedAttempt` early return
must not discard a real terminal mutation.

### R2-D — coordinator restart fence

In `src/dispatch-coordinator.ts`:

- unproven/invalid managed teardown remains BLOCKED and CLAIMED;
- exact retained receipt observation may settle only the same command;
- once terminal retirement is durable, repeated RESUME performs no observation,
  retirement, reservation, dispatch, or epoch change;
- a late receipt/output cannot close a terminal step or become Plan authority;
  retain it as no-effect evidence where the existing evidence seam permits,
  otherwise reject it deterministically without mutation;
- there is no provider/model substitution.

Do not freeze initial topology progression: the critic and Explore deepeners are
first attempts for already sealed topology slots, not retries. The no-retry
rule applies to successor attempts after ambiguity, not to later dependency
wavefronts in the original Wave.

### R2 fault lattice

Cut before/after:

1. claim CAS;
2. provider entry;
3. teardown publication;
4. CLAIMED -> UNKNOWN publication;
5. exact-token observation;
6. receipt publication;
7. terminal retirement;
8. processed-Yield publication;
9. FileArtifactStore restart load.

Run every cut through MemoryArtifactStore and FileArtifactStore with a fresh
kernel. Assert:

- one command identity and at most one provider dispatch;
- no new attempt/reservation/epoch after terminal ambiguity;
- repeated RESUME is byte-stable and call-stable;
- unproven teardown stays BLOCKED;
- exact matching receipt either settles before terminal retirement or remains
  inert afterward;
- automatic Focus/canonical Explore successor decisions refuse before lease;
- token remains available for a valid COMPLETE_PLAN decision;
- legacy historical WIDEN fixtures still load/replay;
- Direct and ordinary recovery behavior remains unchanged.

Run the lattice immediately below, at, and above the sealed generation floor.
Below-floor fixtures must retain exact historical behavior; at/above-floor
Focus and Explore must both be one-shot, independent of `focus-canary`,
`explore-canary`, or `automatic-focus` rollout mode.

Use a poison driver whose second provider call throws so a retry is observed at
the actual effect boundary, not inferred only from state.

### R2 gate and rollback

R2 has no format migration. Old readers accept the terminal attempt/evidence
shape. Rolling code back would re-enable successor/retry behavior, so managed
activation remains disabled until R2 is restored.

**Suggested bisection commits:**

1. `test(deliberation): freeze one-shot crash and successor lattice`
2. `fix(deliberation): terminalize canonical waves without retry`

## 8. R3 — reader-first canonical Focus/Explore contracts

**Accepted outcome:** new writers are exact and simple; supported old artifacts
remain readable without migration.

### R3-A — extend readers first

In `src/deliberation.ts`, retain current Wave v2 support for two-to-three Focus
lenses and call ceilings at least topology size. Do not invent a canonical-form
discriminator: supported old and new Reports can be attached to byte-identical
two-lens/three-call Waves.

For critic Report/v2:

- the standalone/durable Focus reader accepts the union of (a) one or two non-empty comparison
  groups that fully partition both ideas and (b) the supported historical
  three-to-six-group form, including any decorative empty groups the existing
  validator already accepted;
- current command admission performs a second context-bound check: when the
  retained command's exact Wave and immutable `rolloutOrigin.generation` place
  it at or above `ONE_SHOT_ROLLOUT_GENERATION_FLOOR`, accept only the new one-
  or two-non-empty-group form; lower-generation recovery remains union-tolerant;
- Explore retains three-to-six non-empty mechanism clusters;
- every idea remains scored exactly once and every locator remains bound.

Update `materializeRoleView` so every newly authored Focus asks the critic to
compare the two candidates and return only one/two non-empty groups, while
Explore retains the full scoring/clustering contract. The reader is tolerant;
the role prompt and writer are exact.

Keep the reusable `validateReport`-class reader union-tolerant. Add one private
contextual admission helper beside the deliberation validators and call it from
the existing reducer Report-envelope/accepted-report path, using the retained
command's exact `roleView`, Wave, and rollout origin. This is validation policy,
not a new Report field, discriminator, or schema. Unit-test the helper and prove
the production caller rejects a legacy-shaped response for a new command.

Deploy/test this reader before enabling the new canonical writer. Do not
downgrade below it while canonical three-call Focus Reports exist.

### R3-B — contract the writers

In `src/deliberation.ts`, introduce one private pure authority seam and make it
the only production pre-Plan entry:

```ts
type PrePlanResolution =
  | { kind: 'COMPLETE_PLAN'; plan: Plan; gear: 'DIRECT' }
  | { kind: 'DELIBERATION_REQUIRED'; wave: Ref; gear: 'FOCUS' | 'EXPLORE' }
  | { kind: 'NO_SETTLEMENT'; reason: Ref };

resolvePrePlan(
  input: PlanAuthorshipInput,
  predicates: GearPredicates,
  policy?: DeliberationPolicy,
): PrePlanResolution;
```

`resolvePrePlan` performs selection and authorship exactly once, in this order:

1. exact host-authorized Explore -> author Explore or `NO_SETTLEMENT`;
2. settled/witness/Plan-equivalent/contained Direct candidate -> validate and
   return the complete Plan encoded by `input.intent`, else `NO_SETTLEMENT`;
3. one named material discriminator -> author Focus or `NO_SETTLEMENT`;
4. unresolved input without that discriminator -> `NO_SETTLEMENT`.

Then:

- remove the implicit-Explore branch from `selectGear`;
- keep explicit Explore as the only Explore author;
- change Focus `defaultLimits` from four to three calls;
- retain exactly `counterexample` and `simplify` lenses;
- do not require an Explore frame catalog to author Focus;
- keep Explore writer exactly 5+1+3/nine calls;
- bind new capability call ceiling and reserved topology to the authored Wave.

Keep `selectGear`, `proposeGear`, and `authorPlan` only as compatibility/test
helpers or make them delegate to `resolvePrePlan`; production must never chain
them as separately authoritative calls or duplicate their branching logic.
The tolerant reader is not permission for the new writer to vary cardinality.

### R3-C — exactness tests

Extend:

- `test/p2-deliberation.test.js`;
- `test/l3a-wave-reader-compat.test.js`;
- `test/l3b-wave-writer-contraction.test.js`;
- `test/p4-rollout.test.js`;
- `test/p4-operator-docs.test.js`.

Required cases:

1. open/high-stakes/openly phrased without explicit Explore never selects
   Explore;
2. the same input with current explicit Explore selects Explore;
3. new Focus is exactly two lenses, three slots, three calls, capacity two;
4. current admission for an at/above-floor new Focus critic accepts only
   one/two non-empty complete groupings and rejects a legacy-shaped model
   response without consuming the command or admitting Plan authority;
5. old three-lens/four-call/legacy-cluster Focus still validates/replays;
6. a byte-identical two-lens/three-call Wave with a supported legacy
   three-to-six-group Report still validates/replays, while the new role prompt
   and writer emit only one/two non-empty groups;
7. new Explore is exactly five generators, thirty ideas, one critic, three
   deepeners, nine calls;
8. new writer call ceilings equal derived topology exactly;
9. Focus works with no Explore frame catalog;
10. the `resolvePrePlan` table covers every selection row and parses a complete
    Plan no more than once;
11. Direct fixtures and package-root exports are unchanged.

### R3 gate and rollback

Reader and writer changes are internally bisectable but deploy the widened
union reader first. Operational downgrade is forbidden while a newly emitted
one/two-group Report may be current. Disabling new admission is always safe;
retained runs continue only on a reader compatible with both supported forms.

**Suggested commits:**

1. `feat(deliberation): read canonical focus comparison reports`
2. `fix(deliberation): author exact three-call focus and explicit explore`

## 9. R4 — one host-owned intent resolver

**Accepted outcome:** the installed skill exposes AUTO/DIRECT/EXPLORE without a
mode machine or duplicated selection logic.

### R4-A — normalize current user authority

Add the missing installed pre-Plan adapter as a private `resolve-plan` route in
`src/bridge-cli.ts` (exact command name may follow the existing CLI vocabulary).
It accepts one canonical existing `PlanAuthorshipInput` document, exact
deliberation/rollout policy files, and a closed `--intent-mode
auto|direct|explore` flag chosen by the trusted Lunacy parent. It does not parse
free-form user text. Update `tools/deploy-skill.mjs` generated help/runtime docs
and `SKILL.md` so this verified bridge route—not a source-checkout import—is the
installed invocation seam.

At that adapter, normalize only:

- explicit `DIRECT` / no deliberation fan-out;
- explicit `EXPLORE`, `$adhd`, or ADHD mode;
- otherwise `AUTO`.

Do not add a public package enum. Explicit intent must be current and sealed in
the existing intent/authority Ref consumed by Wave authorship; a loose boolean,
Report text, metric, gate result, or stale prior request cannot authorize
Explore.

Inside the same `resolve-plan` invocation, the adapter calls `resolvePrePlan`
once. For Direct it returns the complete Plan and provides no managed
composition inputs; the existing ordinary init/start route remains byte
identical. For Focus/Explore it validates the authored Wave, then invokes the
existing managed START path in the same process. Do not emit a reusable
authorization file or require a second process to carry authority.

Implement explicit Explore as a private composition-only
`ExploreAuthorization` snapshot (name may follow repository convention),
minted and consumed within that invocation after the exact Wave exists. It is
ephemeral, not persisted, and binds the exact `Wave.authorship.intent`,
`authorityDigest`, Wave digest, run/phase, and rollout-policy digest.
`composeKernel` verifies all bindings before internally setting the rollout
fact that admits Explore.

`KernelOptions.managedRollout.explicitExplore` remains readable only where
needed for historical/internal compatibility; it is not sufficient authority
for a newly admitted Explore Wave. Do not export the authorization from the
package root, add it to MachineState, parse free-form user text in the kernel,
or claim a JavaScript security boundary stronger than the trusted host adapter.
Exact implementation ownership is `src/bridge-cli.ts` (mint/invoke),
`src/composition.ts` (consume/verify), and the admission evaluation in
`src/public.ts`; update `tools/deploy-skill.mjs` only for installed help/parity,
and use `src/managed-capability.ts` only if the existing pure decision fact must
be renamed or narrowed.

### R4-B — call the pure selector once

Call `resolvePrePlan` exactly once before Plan sealing:

- Direct: omit all managed composition inputs;
- AUTO Focus candidate: attest exact effect-denied Luna/max host/capability,
  then author/validate the exact Wave;
- explicit Explore: attest or visibly refuse;
- invoke managed START only after all refs, policy, topology, limits, and
  capability agree.

The host must never invoke selection from Plan adoption, implementation spawn,
gate, repair, worker completion, resume, rollout update, or an existing
rollout-bearing run. A late explicit Explore request starts fresh authority.

Focused authority tests must prove:

1. `explicitExplore: true` without the exact private authorization refuses
   before START/lease/provider entry;
2. authorization bound to another intent, Wave, run/phase, authority digest,
   or rollout policy refuses without mutation;
3. current exact user authorization admits one Explore Wave once;
4. Report text or an earlier request cannot mint/reuse authorization;
5. AUTO, DIRECT, and historical reader/recovery paths are unchanged;
6. a deployed tracked-only `runtime/bridge.mjs resolve-plan` smoke uses only the
   verified payload, admits exact Explore once, and leaves Direct with zero
   managed artifacts/calls.

### R4-C — doctrine and diagnostics parity

Update together:

- `orchestrator/DELIBERATION.md`;
- `SKILL.md`;
- `README.md`;
- `docs/API.md`;
- `docs/RECOVERY.md`;
- `docs/INSTALL.md`;
- operator/product-surface tests.

Diagnostics are non-authoritative and outside Direct state/Yield bytes. They may
report public intent, derived gear, reason code, preflight result, topology,
reserved/entered calls, advisory/implementation plane, and terminal reason.
Never persist chain-of-thought, raw hidden prompts, or a mode decision ledger.

### R4 gate

Table-test intent x cutoff x evidence x capability:

| Case | Required result |
| --- | --- |
| DIRECT under any pre-Plan uncertainty | zero managed state/calls |
| AUTO settled/witnessed | Direct |
| AUTO one named discriminator + valid preflight | one Focus Wave |
| AUTO Focus candidate + failed preflight before START | Direct with volatile diagnostic only |
| explicit Explore + valid preflight | one Explore Wave |
| explicit Explore + failed preflight | visible refusal |
| loose `explicitExplore: true` without exact host authorization | refusal before lease/START |
| stale/cross-bound authorization snapshot | refusal without mutation |
| any capability drift after START | fail closed, exact recovery only |
| late Explore after cutoff | fresh Plan/run authority required |
| gate/repair/resume/completion/rollout update | zero new Waves |

## 10. R5 — install, canary, activate, and roll back

### R5-A — disabled candidate deployment

Build/package/deploy the complete R0-R4 candidate with managed admission
disabled. Verify source-to-installed parity and capability attestation. Do not
activate AUTO Focus in the same release operation that first installs the new
reader/routing behavior.

The built candidate carries the floor selected after R0. Repeat the R0
retained/restorable-root census at deployment time inside the
existing release operation: after `verifyReleaseQuiescence` has proved the
closed discovery-parent/run-root set and while the existing target/release
exclusion and admission fences remain held, but before atomic candidate
publication. Publish only if the candidate's
`ONE_SHOT_ROLLOUT_GENERATION_FLOOR` is still strictly newer than every observed
supported generation and all roots are classifiable.
Old installed code must not be able to admit another managed run between this
census and publication. Extend the existing release manifest/quiescence/census
path in `src/release-admission.ts`, `src/release-quiescence.ts`, and
`tools/deploy-skill.mjs`; do not create a parallel deployment lock. If the
census changed, omitted a configured discovery parent, or contains an
unreadable root, stop and rebuild/review the candidate.

### R5-B — rollout corridor

Use the existing corridor only:

1. disabled package and clean restart/replay;
2. D0 shadow on frozen representative tasks;
3. Focus canary with explicit operator cohort and rollout generation at or
   above the one-shot floor;
4. explicit Explore canary with rollout generation at or above the same floor;
5. D3 automatic Focus on new runs only;
6. expand cohort only after the safety/quality observables below remain green.

`automatic-explore`/D4 remains compatibility-only and is not activated.

### R5-C — observables

Safety counters must remain exactly zero:

- post-START fallback/substitution;
- duplicate provider entry;
- successor Wave under canonical Focus/Explore;
- gate/repair/resume re-entry;
- stale advisory adoption;
- advisory command reaching Sol/high;
- ordinary command reaching Luna/max;
- post-Plan ordinary command not launching through the real Codex host policy
  as `gpt-5.6-sol` / `high`;
- managed reservation on ordinary post-Plan work;
- modeEpoch drift;
- Direct-byte drift;
- optional-polish execution before accepted outcome.

Quality/performance observations:

- Direct advisory calls: zero;
- Focus: exactly 3 calls over 2 model stages;
- Explore: exactly 9 calls over 3 model stages and 30 ideas;
- Focus/Explore parent override and all-rejected rates;
- compact settlement bytes entering implementation context;
- implementation capacity after Plan adoption;
- restart recovery and terminal-boundary stability.

Metrics are diagnostic. They do not automatically change selection policy.

### R5-D — rollback

1. stop admission for new runs;
2. set the host kill switch for immediate refusal;
3. publish a strictly newer existing rollout policy with `mode: disabled`;
4. preserve all Wave, Report, rollout-origin, attempt, receipt, settlement,
   lease, and recovery evidence;
5. restore the previous package only when no active run requires the newer
   reader;
6. resume retained managed work only with its exact compatible capability and
   policy; never rewrite it to Direct.

Existing Direct/ordinary runs continue normally throughout rollback.

## 11. Required verification commands

Run focused checks first, then the broad candidate gate:

```bash
npm run typecheck
npm run build
node --test \
  test/adaptive-modes-compat.test.js \
  test/p4-post-plan-routing.test.js \
  test/p2-deliberation.test.js \
  test/l3a-wave-reader-compat.test.js \
  test/l3b-wave-writer-contraction.test.js \
  test/p4-rollout.test.js \
  test/p4-operator-docs.test.js \
  test/p3-s3-attempt-authority.test.js \
  test/p3-s5-authority-repair.test.js \
  test/p3-s9-holistic-repair.test.js \
  test/p3-s11-provenance-repair.test.js \
  test/massive-win-identity-variants-cycle-launch-fence.test.js \
  test/product-surface.test.js
npm run check
npm pack --dry-run
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" .
TARGET="$(mktemp -d)"
node tools/deploy-skill.mjs --target "$TARGET"
node tools/deploy-skill.mjs --target "$TARGET" --check
```

Also run the R2 crash lattice as isolated child processes so in-memory driver
ownership cannot make restart tests accidentally pass.

## 12. Stop conditions

Stop the current release and return parent FINDINGS if any candidate requires:

- a new persisted mode/controller/ledger/schema/epoch;
- clearing or rewriting managed provenance after Plan adoption;
- Direct state/Yield/byte changes;
- implicit Explore or Focus re-entry;
- post-START fallback, retry, or provider substitution;
- guessing command ownership from schema/proposal alone;
- making diagnostics or Reports authoritative;
- weakening UNKNOWN/teardown custody;
- migrating historical Wave/Report/WIDEN/D4 artifacts;
- enabling new writers before compatible readers;
- choosing a one-shot generation floor without a complete supported-root
  census, or admitting a new canary below that floor;
- treating a loose `explicitExplore` boolean, stale intent, or Report text as
  current Explore authority;
- increasing implementation concurrency because Explore used width five;
- feeding the full ADHD transcript to implementation workers;
- turning test/report/proof/polish work into Plan milestones.

## 13. ADHD convergence record

The roadmap was produced through five isolated divergent frames, thirty ideas,
one scoring/clustering critic, and three independent deepeners. The surviving
mechanisms were:

1. reader-first compatibility and byte oracles;
2. terminal lifecycle closure before activation;
3. command-local ownership derived from current Wave/`roleView` facts;
4. exact fixed topology/budget writers;
5. independently reversible vertical rollout slices.

Explicitly rejected traps:

- allowing AUTO to choose Explore;
- reusing Explore machinery unchanged for Focus;
- deriving a new retry/successor route after START;
- adding an execution tape, mutable driver tickets, or mode controller;
- coercing legacy Plans/Waves into Direct;
- deleting retained managed proposal/evidence to simplify routing.

## 14. Definition of done

The architecture is implementation-complete only when a clean tracked-only
candidate proves all of the following in one frozen vertical journey and its
fault variants:

1. AUTO selects Direct or one exact Focus Wave; Explore is explicit only.
2. Direct is byte-identical and creates no managed artifacts or calls.
3. Focus is exactly 2+1/three calls; Explore is exactly 5+1+3/nine calls.
4. Parent COMPLETE_PLAN transfers new command execution to ordinary Sol/high
   without deleting managed provenance.
5. Command-local route/envelope ownership survives restart and stale output.
6. Canonical Waves cannot retry or create successor Waves after START.
7. Unproven teardown remains BLOCKED; terminal ambiguity is replay-stable.
8. Historical supported artifacts remain readable without migration.
9. Gate, repair, resume, completion, and rollout changes create zero new Waves.
10. Advisory context does not grow implementation prompts or optional work.
11. The production resolver selects/authors once, and exact private current-user
    authorization is required for every new Explore admission.
12. New canaries and D3 runs are at/above the census-derived one-shot generation
    floor; lower-generation rows retain exact historical recovery semantics.
13. The real ordinary host-policy/driver fixture proves post-Plan
    `gpt-5.6-sol` with `high` reasoning.
14. Full checks, packaging, isolated deployment, and installed parity pass.
15. Activation and rollback use only the existing rollout/kill-switch corridor.
