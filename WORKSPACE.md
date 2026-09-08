# Uniform native workspace contract

## Authority, entry, and coexistence

Current user/project authority must authorize the complete genuinely new outcome and explicitly select this contract. Proposal authority permits only named proposal documents and independently authorized notes, not implementation, probes, dispatch, reservations, effects, or foreign-state edits. A saved draft remains a proposal. The authorized parent begins execution only by appending an immutable adoption to `TASK.md`; writing a record cannot itself create authority.

Before adoption, judge inherited obligations, restrictions, available capabilities, required proof, and permitted effects together so each mandatory action has a feasible evidence path. Material requirement, scope, architecture, route, effects, or acceptance changes require a new immutable parent adoption before affected work continues; stale the relevant proof. Evaluate material user input promptly and continue unrelated work only when its authority and independence are established.

Before dispatch or re-entry, compare same-root ACTIVE tasks and BLOCKED tasks with retained or ambiguous ownership/custody under all known workflows. Compare actual workspaces, surfaces, writers, and effects; unknown release is not independence. Existing or provenance-uncertain work stays under its original contract and owner. No filename, hash, missing record, fresh ID, timeout, current tree, or terminal prose proves authority, eligibility, quiescence, released effects, or acceptance.

## The uniform record contract

For a run selected prospectively under this contract, the only mandatory coordination/authority record is parent-owned `TASK.md`. Each worker has one distinct immutable report and only necessary durable logs. Do not require separate `PLAN.md`, `STATE.md`, `STEPS.md`, `DECISIONS.md`, routine gate files, duplicated handoff inventories, or future validation pointers. Existing runs retain their original records and are never retrospectively migrated.

The adoption may replace its repeated detail with one exact immutable plan reference only when that reference contains every required field. `TASK.md` is ordinary Markdown evidence, not a machine schema or transaction manager. Named anchors make entries retrievable; no digest or parser is required. The parent alone creates or changes TASK, including coordination, adoptions, authorized assignments, recovery facts, and acceptance. Workers send actual updates and write only their owned artifacts, report, and logs. Unknown required facts remain explicit; omitted optional fields prove nothing.

### Compact TASK form

Parent-only authoring guidance: use the [Compact TASK form](orchestrator/PLANNING.md#compact-task-form).

Current coordination is mutable observation, not an automatic substantive product change. It may point tersely to immutable history and reports. A material authority change belongs in a new adoption; a consequential conclusion belongs in a decision. Do not use “coordination only” to hide an actual artifact or effect writer. The parent records actual handles after creation, never placeholders masquerading as custody.

Before dispatch on every route, the parent appends one Authorized Assignment that references the existing adoption and immutably binds the literal model and effort selected under the canonical [Exact native routing](orchestrator/PLANNING.md#exact-native-routing) rule, the context rule, worker purpose and slice/effects, report path, and applicable attempt/recovery entitlement. The worker must receive that same literal pair, context, scope/report, and entitlement binding. The assignment is authorization for the worker to act, not evidence that dispatch occurred; it contains no future handle or `LAUNCHED` declaration. After dispatch returns, the parent records the actual returned owner/handle and launch observation in current coordination, not by rewriting immutable history. A missing or ambiguous return is recorded as UNKNOWN with an OPEN barrier and retained possible custody; it never grants replay, replacement, or a fresh entitlement. Changing a live or unknown-effect same-surface attempt's pair is forbidden: settle its ownership/effects, then obtain a new adoption and fresh authorized assignment/attempt. Unrelated old OPEN work does not prohibit demonstrably independent new work on different established-independent surfaces. Fresh child context is default; an inheritance exception must be justified in the adoption/decision and changes only inheritance, never model or effort.

### Worker updates and immutable report

Unsolicited worker messages are concise:

```text
BLOCKED | DECISION_REQUIRED | FINAL <PASS|FIXED|BLOCKED>
<exact report/evidence path>
<blocker, precise question, or result>
```

A solicited checkpoint names a changed owned artifact/symbol or running bounded command with evidence, the unresolved uncertainty, and next safe boundary. It is not acceptance.

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

The worker finishes substantive artifacts, runs the required final-artifact tests, and reports each actual result. It then inspects the final report and every cited pointer against completed receipts as part of one self-review; there is no separate mandatory report-validation pass or future acceptance pointer. Long output stays in logs. A zero exit is necessary for process success but not sufficient for correctness or acceptance; never mask an earlier failure with later stdout or an aggregate `PASS`.

Completed evidence may be reused only when the artifact, dependencies, configuration, environment relevant to the claim, and required scope still match. Changed inputs invalidate the affected proof. Evidence reuse never waives an explicit independent requirement or permits invented, stale, missing, or contradictory evidence.

FINAL freezes that worker's artifacts, report, and cited evidence, not parent coordination. For a clerical report-only error, the parent may append a narrowly attributed correction to the existing TASK decision/history using already-completed receipts; name the original statement or pointer and its correction. Do not dispatch a worker, create an assignment or report, rerun product tests, rewrite the frozen report, claim the worker authored the correction, launder a failure, invent evidence, or change scope, authority, or effects for that correction. Insufficient evidence requires necessary clarification or proof under existing authority, or a newly authorized attempt where required. A product defect or other substantive change requires a new attempt and affected checks. A material finding after acceptance requires a new parent decision and acceptance while the old acceptance remains intact. FINAL does not accept the task, release custody, or authorize cleanup/replay.

## Ownership, barrier, and acceptance

One owner controls each surface/effect at a time. Shared work uses only necessary rows for actual owners, dependencies, surfaces, and barriers, plus one frozen report per worker. Workers discover deeper affected surfaces and stop before overlap, unsafe shared state, contract change, unknown effects, or material expansion. Contract disagreement is a defect to decide, not fabricated custody uncertainty.

Keep the barrier OPEN while any relevant writer, command, session, or effect can mutate owned surfaces, or its settlement is unknown. PASS and FINDINGS require every relevant writer/effect settled and an explicit CLOSED whole-outcome custody judgment recorded in the immutable acceptance; BLOCKED keeps it OPEN and names the retained owner, uncertainty, and bounded next action. Lifecycle terminality, timeout, report text, hashes, or a process-list snapshot alone do not establish quiescence. A later substantive change reopens the barrier and stales affected proof.

Only the parent accepts. After FINAL, the parent independently inspects the actual diff, affected behavior, evidence applicability, required coverage, current authority, and every relevant effect; reconciles report custody with its TASK assignment and current handle observation; then appends an immutable acceptance. Parent execution is required for an explicit requirement, stale, missing, or contradictory evidence, an integration boundary not covered by applicable evidence, or a named consequential risk. Do not add an unconditional integration sample or automatically rerun proof merely because the verifier differs. FINDINGS authorize nothing by themselves; substantive product repair needs a new attempt, while a receipt-supported clerical report correction follows the report-only rule above. BLOCKED acceptance snapshots may record uncertainty without releasing ownership. No worker writes parent adoption or acceptance.

## Refusal and truthful limits

Unknown authority, overlap, prior effects, custody, or exact-route availability stops only affected consequential work. Keep ownership and bounded reconciliation duties visible. Do not replay, replace, accept, or infer cleanup. Guidance cannot enforce OS confinement, prevent privileged races, or make Markdown transactionally immutable.
