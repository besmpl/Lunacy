# Uniform native workspace contract

## Authority, entry, and coexistence

Current user/project authority must authorize the complete genuinely new outcome and explicitly select this contract. Proposal authority permits only named proposal documents and independently authorized notes, not implementation, probes, dispatch, reservations, effects, or foreign-state edits. A saved draft remains a proposal. The authorized parent begins execution only by appending an immutable adoption to `TASK.md`; writing a record cannot itself create authority.

The outcome need not involve a repository. Task-directed skill invocation selects this workflow for the stated new task, not blanket permission for actions on an existing device, account, or filesystem. Before an effectful assignment, establish its actual target and identity, permitted action, exclusions, relevant shared/live use, preserved state, and task-appropriate evidence; a storage-root pointer is a location, not recursive authority. An inspection-only request permits inspection, not deletion. A cleanup request may authorize bounded cleanup of verified safe targets without an invented universal confirmation gate, but targets not clearly included in current authority need a focused user decision before deletion. Keep TASK, reports, and logs in an authorized coordination location; their location grants no authority over nearby data. Existing artifacts may be inputs or targets of a new task, while an existing managed task and uncertain live effects retain their prior ownership and contract.

Before adoption, judge inherited obligations, restrictions, available capabilities, required proof, and permitted effects together so each mandatory action has a feasible evidence path. Material requirement, scope, architecture, route, effects, or acceptance changes require a new immutable parent adoption before affected work continues; stale the relevant proof. Evaluate material user input promptly and continue unrelated work only when its authority and independence are established.

Before dispatch or re-entry, compare same-root ACTIVE tasks and BLOCKED tasks with retained or ambiguous ownership/custody under all known workflows. Compare actual workspaces, surfaces, writers, and effects; unknown release is not independence. Existing or provenance-uncertain work stays under its original contract and owner. No filename, hash, missing record, fresh ID, timeout, current tree, or terminal prose proves authority, eligibility, quiescence, released effects, or acceptance.

## The uniform record contract

For a run selected prospectively under this contract, the only mandatory coordination/authority record is parent-owned `TASK.md`. Each worker has one distinct immutable report and only necessary durable logs. Do not require separate `PLAN.md`, `STATE.md`, `STEPS.md`, `DECISIONS.md`, routine gate files, duplicated handoff inventories, or future validation pointers. Existing runs retain their original records and are never retrospectively migrated.

For one coherent single-owner result, one combined adoption-and-assignment record
is the supported compact form: both lookup anchors resolve to that same complete
immutable record, so no second adjacent block is required. It contains authority,
outcome, scope/non-goals, applicable project contracts/non-negotiables, owned
surfaces/effects, literal model and literal effort, purpose/transport/context,
checks and acceptance evidence, report, and applicable attempt/recovery
entitlement exactly once. It contains no future
owner/handle or launch claim. Genuinely shared work keeps a common adoption and
one distinct assignment/report per actual owner; route, context, scope/effects,
report, and limits never inherit between workers. Existing tasks retain the
record contract under which they were adopted.

For parallel work, apply the single canonical [ready-work policy](orchestrator/PLANNING.md#ready-work-parallel-delivery). Extend the same assignment/current-coordination facts, not a second ledger: stable assignment ID and actual returned handle (UNKNOWN until observed), absolute workspace root and reproducible baseline including relevant dirty/untracked inputs, owned paths **and** exclusive effects, dependency/interface revision, optional team/integration destination, required checks, and current barrier/next safe action. A storage root or file list alone does not convey the inputs or lockfile, port, database, formatter, generated-output or heavy-test ownership. Unchanged complete facts may use the immutable-plan reference rule below. A lead's membership and artifact rights must be explicit; its title grants no teammate write access or TASK authority.

A record may replace unchanged detail with one exact immutable complete-plan
reference only when that reference is retrievable and contains every required
field. Missing facts remain explicit and stop the affected action; there is no
mutable default inheritance. `TASK.md` is ordinary Markdown evidence, not a
machine schema or transaction manager. Named anchors make entries retrievable;
no digest or parser is required. The parent alone creates or changes TASK,
including coordination, adoptions, assignments, recovery facts, and acceptance.
Workers send actual updates and write only their owned artifacts, report, and
logs. Unknown required facts remain explicit; omitted optional fields prove
nothing.

### Compact TASK form

Parent-only authoring guidance: use the [Compact TASK form](orchestrator/PLANNING.md#compact-task-form).

Current coordination is mutable observation, not an automatic substantive product change. It may point tersely to immutable history and reports. Keep the bound assignment, actual owner/handle, settled and unsettled effects, accepted decisions, evidence applicability, and next safe action current through precise pointers; follow the canonical [compact resume procedure](orchestrator/PLANNING.md#compact-resume-procedure). Refresh it only at meaningful boundaries, not every turn or poll. A material authority change belongs in a new adoption; a consequential conclusion belongs in a decision. Do not use “coordination only” to hide an actual artifact or effect writer. The parent records actual handles after creation, never placeholders masquerading as custody.

Before dispatch on every route, the parent appends either the combined
single-owner record or, for shared/compatible work, an Authorized Assignment
that references its adoption. The chosen record immutably binds the literal
model and effort under [Exact native routing](orchestrator/PLANNING.md#exact-native-routing),
context, worker purpose and scope/effects, report, and applicable entitlement.
The worker receives those same facts. The record authorizes work; it does not
prove dispatch and contains no future handle or `LAUNCHED` declaration. After
dispatch returns, the parent records the actual owner/handle and launch
observation in mutable coordination. A missing or ambiguous return is UNKNOWN
with an OPEN barrier and retained possible custody; it never grants replay,
replacement, or fresh entitlement. Changing a live or unknown-effect
same-surface attempt's pair is forbidden: settle ownership/effects, then obtain
a new adoption and assignment/attempt. Unrelated old OPEN work does not block
demonstrably independent work on different established-independent surfaces.
Fresh child context is default; an adopted exception changes only inheritance,
never model or effort.

### Worker updates and immutable report

Unsolicited worker messages are concise:

```text
BLOCKED | DECISION_REQUIRED | FINAL <PASS|FIXED|BLOCKED>
<exact report/evidence path>
<blocker, precise question, or result>
```

A solicited checkpoint names a changed owned artifact/symbol or running bounded command with evidence, the unresolved uncertainty, and next safe boundary. It is not acceptance.

For logical teams, worker reports and direct decision/blocker messages retain their own provenance. Leads send bounded consolidated deltas with exact original evidence pointers, changed interfaces, failing checks and dissent; they cannot turn them into PASS or delay a material direct escalation. Parent updates coordination on meaningful events, not each healthy-worker poll. A missing lead is a coordination problem, not loss of already settled worker reports.

The assigned report path is bound before dispatch to its immutable Authorized Assignment. Use this form:

```markdown
# <assignment/attempt> Worker Report
Adoption/assignment: <TASK path#exact anchors>
Status: PASS | NEEDS-DECISION | BLOCKED
Goal/result: <one line>
Changed/effects: <exact paths and effects>
Verification: <each required command/result, including failed/skipped/unavailable checks>
Evidence: <exact retrievable completed receipt pointers>
Self-review/risks: <material findings, fixes, limits, or NONE when established>
```

Within `Verification` and `Evidence`, the worker may use the optional
[acceptance evidence view](orchestrator/PLANNING.md#acceptance-evidence-view):

```markdown
| Criterion | Observed behavior/counterexample | Completed check: actual result; receipt | Applicable inputs/limits |
```

This is part of the existing report, not a second ledger. Preserve the
difference between an actual result and the worker's interpretation. Mark a
missing receipt, unrelated green check, source change after testing, or
failed/skipped check as a gap with its consequence. A hash identifies content;
it does not prove the environment, execution, custody, or quiescence.

The worker finishes its authorized result, performs required outcome-appropriate verification (including all required software tests for code work), and reports each actual result. It then inspects the final report and every cited pointer against completed receipts as part of one self-review; there is no separate mandatory report-validation pass or future acceptance pointer. Long output stays in logs. A zero exit is necessary for process success but not sufficient for correctness or acceptance; never mask an earlier failure with later stdout or an aggregate `PASS`.

Completed evidence may be reused only when the artifact, dependencies, configuration, environment relevant to the claim, and required scope still match. Changed inputs invalidate the affected proof. Evidence reuse never waives an explicit independent requirement or permits invented, stale, missing, or contradictory evidence.

A parallel handoff identifies exact produced artifacts, state changes, and effects against its named baseline; for code, include tracked changes plus additions, deletions, and relevant untracked outputs. Include the existing report's check applicability and remaining effects; a diff/hash alone is not custody or acceptance. One owner at a time mutates a shared integration surface, and the parent reviews the combined result after dependencies assemble. Individually green slices or a review on an earlier snapshot cannot substitute for applicable combined-state checks; recheck only affected evidence when integration changes inputs.

FINAL freezes that worker's artifacts, report, and cited evidence, not parent coordination. For a clerical report-only error, the parent may append a narrowly attributed correction to the existing TASK decision/history using already-completed receipts; name the original statement or pointer and its correction. Do not dispatch a worker, create an assignment or report, rerun product tests, rewrite the frozen report, claim the worker authored the correction, launder a failure, invent evidence, or change scope, authority, or effects for that correction. Insufficient evidence requires necessary clarification or proof under existing authority, or a newly authorized attempt where required. A product defect or other substantive change requires a new attempt and affected checks. A material finding after acceptance requires a new parent decision and acceptance while the old acceptance remains intact. FINAL does not accept the task, release custody, or authorize cleanup/replay.

## Ownership, barrier, and acceptance

One owner controls each surface/effect at a time. Shared work uses only necessary rows for actual owners, dependencies, surfaces, and barriers, plus one frozen report per worker. Workers discover deeper affected surfaces and stop before overlap, unsafe shared state, contract change, unknown effects, or material expansion. Contract disagreement is a defect to decide, not fabricated custody uncertainty.

Isolate colliding writer workspaces with assigned owned roots; native spawn does not itself set cwd or enforce isolation. Preserve the dirty/untracked task baseline when staging and do not copy secrets or follow untrusted symlinks into worker trees. A separate checkout path is not OS confinement. Share immutable caches deliberately, not mutable build outputs by accident. Count finite local heavy-test resources separately from native agent slots. A late completion or cancellation acknowledgment leaves possible writes/effects to reconcile; a same-surface replacement cannot begin on status text alone.

Keep the barrier OPEN while any relevant writer, command, session, or effect can mutate owned surfaces, or its settlement is unknown. PASS and FINDINGS require every relevant writer/effect settled and an explicit CLOSED whole-outcome custody judgment recorded in the immutable acceptance; BLOCKED keeps it OPEN and names the retained owner, uncertainty, and bounded next action. Lifecycle terminality, timeout, report text, hashes, or a process-list snapshot alone do not establish quiescence. A later substantive change reopens the barrier and stales affected proof.

Only the parent accepts. After FINAL, the parent independently inspects the actual result and changed artifacts/state (the exact diff for code), evidence applicability, required coverage, current authority, and every relevant effect; reconciles report custody with its TASK assignment and current handle observation; then appends an immutable acceptance. For cleanup, verify target identity, exclusions, actual before/after state and observed recovered space rather than equating nominal deleted size with reclaimed space. Parent execution is required for an explicit requirement, stale, missing, or contradictory evidence, an integration boundary not covered by applicable evidence, or a named consequential risk. The normal acceptance pass covers specification compliance and task-appropriate quality/safety (including code quality/security for code) together; known actionable findings are batched into one correction request by default. Do not add an unconditional integration sample or automatically rerun proof merely because the verifier differs. One feedback cycle is a target, not a hard cap on new material evidence or risk. FINDINGS authorize nothing by themselves; substantive result repair needs a new attempt, while a receipt-supported clerical report correction follows the report-only rule above. BLOCKED acceptance snapshots may record uncertainty without releasing ownership. No worker writes parent adoption or acceptance.

For nontrivial code behavior, acceptance inspects the one to three plausible wrong
implementations and discriminating evidence already recorded under the
canonical [counterexample-first evidence rules](orchestrator/PLANNING.md#counterexample-first-evidence).
For non-code work, inspect plausible wrong outcomes and relevant evidence under
task-appropriate acceptance, without fabricating code tests. This evidence lens
adds no ledger or ceremony and does not replace required checks, custody, or acceptance barriers.

## Refusal and truthful limits

Unknown authority, overlap, prior effects, custody, or exact-route availability stops only affected consequential work. Keep ownership and bounded reconciliation duties visible. Do not replay, replace, accept, or infer cleanup. Guidance cannot enforce OS confinement, prevent privileged races, or make Markdown transactionally immutable.
