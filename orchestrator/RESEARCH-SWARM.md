# Optional evidence-driven research swarm

Use research to change a decision, not to fill slots or manufacture agreement.
Existing [TASK/report authority](../WORKSPACE.md#the-uniform-record-contract),
[readiness](PLANNING.md#ready-work-parallel-delivery), and custody remain controlling.

<a id="research-activation-and-budget"></a>
## Activation and finite budget

Explicit `research: on` or a task-directed research-swarm request selects this
protocol for an authorized question. Parallelism alone does not. `research: off`
stops new probe launches; it does not cancel or rebind live assignments. Invalid or
ambiguous selectors require clarification before affected activation/dispatch.

Research is orthogonal to `normal`/`super-parallel`, the default concurrent worker
limit **22**, and exact worker routes (unchanged default `gpt-6-luna` / `max`).
Root alone dispatches using the [native recipe](../SKILL.md#native-dispatch-recipe).
Research probes are outcome work, not the at-most-one optional opportunity scout.
If Golden is also selected, its [ordering, authorship and stage
isolation](IMPROVEMENT.md#golden-cycle) govern: research neither replaces stages
nor adds breadth/focus workers; an additional campaign needs adopted bounded scope.

In existing TASK fields, record the question/decision, frozen basis, stopping
criteria, probe budget and count. Default: **8 probe assignments**.
`research budget: N probes` overrides with a positive integer. A probe is a newly
assigned bounded evidence-producing investigation/experiment, including independent
experimental verification. Count each assignment once, including failed/unavailable
attempts and evidence-producing follow-ups; retirement does not refund it. Summaries
are not probes and cannot justify unlimited extra calls. The budget is neither a
target nor a concurrency limit. Bound each probe's operations/time/resources too;
spend enough remaining effort on verification rather than exhausting it on breadth.

Stop new probes when the decision has sufficient applicable proof, no valuable
discriminator remains, the budget is exhausted, or authority ends. Report unresolved
questions honestly; do not silently replenish the budget.

<a id="bounded-probe-recipe"></a>
## Seal a decision-changing probe

Use the ordinary complete assignment, adding these facts inside its existing fields:

- **Decision and rivals:** materially distinct hypotheses/approaches and their consumer.
- **Discriminator:** concrete experiment, source check, counterexample or proof obligation;
  predicted supporting, challenging and inconclusive outcomes.
- **Basis:** exact inputs/source versions, hypothesis meanings, environment, method and
  interpretation rule, including noise/thresholds where relevant.
- **Bound and result:** permitted effects, finite operation/time limit, stop condition,
  original receipts, expected report and next decision. A proposal grants no effects.

Example: for a reproducible failure, distinguish cache reuse (`H-cache`) from
parsing (`H-parser`). Replay identical frozen input with/without cache; compare
against a separately established expected result.

| Observed outcome | Interpretation and useful next action |
| --- | --- |
| Only cached path fails | Supports cache cause, challenges parser-only cause; inspect cache-key discriminator. |
| Both fail identically; reference parser succeeds | Challenges cache-only cause, supports parser cause; minimize a parser counterexample. |
| Both pass | Negative reproduction, not proof of repair; inspect changed basis or defer. |
| Read failure/timeout | Acquisition failure, not refutation; repair a named prerequisite or stop inconclusive. |

For noisy measurements, follow the predeclared sampling/interpretation rule rather
than treating one outlier as refutation. A failed construction does not disprove
existence; no counterexample in a bounded search does not prove universality.
Seal independent useful probes before the launch wave; keep coupled methods/effects
with one owner. Fewer probes, one owner, or no further research can be correct.

<a id="evidence-transfer-and-adaptation"></a>
## Transfer evidence, then adapt

Share settled frozen reports, not half-written peer surfaces. Preserve the original
observation/source identity, exact retrievable receipt, basis, method, actual outcome,
limitations and imported evidence. Carry negative and inconclusive results forward.
Distinguish observation from interpretation. Copying or paraphrasing one finding
does not create another independent confirmation; retain its origin across transfers.

At actual completion, new evidence, changed prerequisite or relevant authority/custody
event, inspect the delta once and choose a disposition in TASK:

- **Deepen/compete:** name the new discriminator, decision it could change, and why its
  value warrants the remaining cost; merge equivalent questions instead of duplicating.
- **Verify:** freeze the candidate claim and commission a falsification/reproduction check.
- **Reconcile:** mixed support/challenge needs scope, source and method reconciliation,
  not averaging or a worker-majority vote.
- **Retire/defer/stop:** retain the reason, contrary evidence, limits and any named revisit
  prerequisite. Inconclusive/unavailable is not false, and exhaustion creates no winner.

At that same event, make one short **material-impact routing pass**: name the affected
claim/assumption, its actual current or future decision consumer, and the next decision
the finding could change. Transfer the smallest sufficient delta with its original
receipt, basis and actual outcome, including negative/inconclusive results; recording
a finding in TASK is not delivery. Use existing TASK/report fields for the route,
actual consumer receipt and disposition:

- **Queued, not launched:** refresh affected inputs and reseal the complete applicable
  assignment packet before dispatch; preserve prior immutable assignment history.
- **Live consumer:** notify the existing owner within its owned scope. At its next
  affected decision/effect boundary, the owner reports applicability and the changed
  action, or why no change is warranted. Acknowledgment means receipt, not consumption
  or application. Neither the message nor the report silently rebinds scope, interfaces
  or effects; material changes need a parent decision and appropriate new adoption
  before the affected action.
- **Post-FINAL consumer:** when changed facts affect the completed result, mark the
  dependent artifact/claim and affected proof stale pending reassessment, leaving
  frozen work intact. Substantive repair follows the
  [existing handoff](PLANNING.md#compact-post-final-repair-handoff): settled custody,
  then a new authorized owned assignment/report, not reopening the old worker.

Parent acceptance checks the finding's actual consequence in the result and applicable
evidence, or retains an explicit unresolved gap; sent/received is not a closed transfer.
Update only relevant evidence at these events, not every turn or phase. Unrelated
authorized work continues: no all-worker acknowledgment round, global transfer barrier,
routine broadcast, polling or new ledger.

No cosmetic same-basis retry, renamed hypothesis, summary, timer or idle slot earns
another probe. Prospectively bounded independent replication can be valuable on the
same basis—for example, the third sample in an adopted three-sample experiment.
Report what independence was actually achieved. New evidence may justify a materially
different test; record that reason before dispatch.

Epistemic retirement means “not worth pursuing,” not “execution stopped.” Live or
unknown attempts retain custody and occupancy until observed settlement. `research: off`,
budget exhaustion, cancellation acknowledgment and timeout do not release effects.
Use existing [event-driven waits/recovery](PLANNING.md#event-driven-parent-refill);
never replay or replace an unknown-effect attempt. Task-wide cancellation stops refill;
a dependency-local obstacle leaves demonstrably independent authorized work available.

<a id="verification-and-delivery"></a>
## Verify, then hand off to delivery

Give an independently assigned verifier the exact claim, assumptions, frozen basis,
receipts, contrary evidence and concrete falsification/reproduction obligation—not
an endorsement request. Distinguish independent authorship, method and source;
label an unblinded check, or withhold conclusions until the first result is frozen.
New experimental verification consumes a probe; record unavailable proof as a gap.

Parent inspects the actual evidence and relevant freshness, settles custody, and
records acceptance under the [existing barrier](../WORKSPACE.md#ownership-barrier-and-acceptance).
The handoff states supported decision, assumptions/limits, rejected or unresolved
rivals, original receipts, performed verification and remaining delivery obligations.
Implementation needs an existing applicable adoption or a new adoption before effects;
research acceptance grants no implementation or release authority. Recheck applicability
at execution. Material changes stale affected proof, not unrelated questions.

<a id="optional-checkpoint-helper"></a>
## Optional structural checkpoint

[research_checkpoint.py](../scripts/research_checkpoint.py) exposes pure `project(snapshot)`
and this read-only CLI. Run from the Lunacy skill root: `<plugin-root>/skills/lunacy`
for the native plugin, or the standalone/source-checkout root:

```text
python3 -B scripts/research_checkpoint.py inspect /absolute/path/checkpoint.json
python3 -B scripts/research_checkpoint.py inspect -
```

`-` bounds bytes, not elapsed time; the parent supplies EOF and owns command
timeout/cancellation. This optional artifact replaces neither TASK nor reports.
Exact input keys/types are illustrated below; no extra keys are allowed:

```json
{
  "schema": "lunacy-research-checkpoint-v1",
  "basis_revision": "failure-r1",
  "branches": ["H-cache", "H-parser"],
  "evidence": [
    {"id": "E1", "branch": "H-cache", "basis_revision": "failure-r1",
     "relation": "supports", "origin": "replay-1", "receipt": "REPORT.md#replay-1"},
    {"id": "E2", "branch": "H-parser", "basis_revision": "failure-r1",
     "relation": "challenges", "origin": "replay-1", "receipt": "REPORT.md#replay-1"}
  ],
  "checks": [
    {"id": "V1", "branch": "H-cache", "basis_revision": "failure-r1",
     "evidence_ids": ["E1"], "result": "passed", "receipt": "VERIFY.md#V1"}
  ]
}
```

Relations: `supports|challenges|inconclusive`; check results: `passed|failed|unavailable`.
Branches are nonempty unique string IDs; evidence/check arrays may be empty and their
IDs are unique within each array. References must exist; each check's unique evidence
IDs belong to its branch.
All strings are nonempty: IDs ≤128 characters; basis/origin/receipt ≤2048. Limits:
128 branches, 2048 evidence, 512 checks, 2048 evidence IDs/check. CLI accepts ≤1 MiB
UTF-8 strict JSON; duplicate keys, nonfinite constants, wrong types and special files
are rejected without coercion. Exit 0 means valid projection, even with failed checks;
malformed/acquisition errors return 2, empty stdout and non-payload stderr diagnostics.

Evidence applies only on matching basis. A check is current only with matching basis
and the exact full applicable evidence-ID set for its branch. Empty-set checks cannot
support acceptance. Caller preserves immutable evidence ID-to-complete-record binding
(including relation/origin/receipt), check records and receipt contents. Changed records
need new IDs/checks; changed facts/claims also change the basis. The helper cannot detect
historical edits under reused IDs. Removing evidence still referenced by a check is
invalid (dangling reference), not a stale-success view; retained old-basis evidence can
stale a check. One basis freezes one question's complete inputs/method environment;
changing it conservatively stales that checkpoint's old evidence, not unrelated research.

Output has exactly `schema` (`lunacy-research-checkpoint-view-v1`), `basis_revision`,
`advisory_only` (`true`), `branches`, `shared_origin_groups`, `non_claims`. Each branch
has `id`, `applicable_evidence_ids`, `stale_evidence_ids`, `supports`, `challenges`,
`inconclusive` (ID lists), `mixed_evidence` (boolean), `current_declared_checks`
(`id/result/receipt` records), `stale_check_ids`, and `gaps`.
Gaps are `no-applicable-evidence`, `no-current-declared-check`,
`declared-check-failed`, `declared-check-unavailable` where applicable—not logical
falsity or a stop for independent work. Empty gaps are not epistemic completeness:
even challenge-only or inconclusive evidence can have a current declared passed check.
Repeated origins, including stale evidence, produce `origin/evidence_ids` groups;
IDs/origins sort lexically.

The example exposes one shared origin, not two confirmations. Mixed evidence means
support and challenge coexist, not proven contradiction. These are caller declarations:
no truth, independence, authority, acceptance, execution or custody certification.
The helper does not fetch receipts, parse TASK, write, spawn, access networks, or
enforce the protocol. Changing a revision string establishes neither freshness nor proof.
