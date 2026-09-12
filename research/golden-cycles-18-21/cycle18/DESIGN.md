# Cycle 18 source-grounded design

## Decision

Adopt one narrow, documentation-only improvement: clarify **verification
selection** and **first-broken-arrow diagnosis** at the existing guidance seam.
The clarification is viable because the shipped rules require source-checked
claims, affected verification, evidence reuse, independent acceptance, and
honest repair, but never state how to decide whether a textual assertion is a
consumer contract or merely a presentation detail. The incident is evidence
of nine attempts and six failed harness runs, not six independent incidents or
a measured cost. This is not a claim that the existing policy caused those
failures.

The selected mechanism combines the useful part of `child-2` and `child-4`:
before writing a bespoke assertion, trace its subject to a source owner and an
actual consumer, then choose exact, structural, or semantic verification. On
failure, locate the first unsupported edge in **source → behavior → report**.
Repair the existing checker when that edge is only checker/report execution;
repair the product when observed behavior contradicts source; surface a
source/roadmap conflict for parent judgment. This is a decision heuristic, not
a required form, ledger, gate, report-validation pass, new checker, retry
rule, or blanket prose exemption.

## Source reconciliation

The read-only source is the clean release checkout at commit
`1e0204fae20c02f778f4d3784553affa44b4e9b4`:
`cycle16/release/main-checkout`. Its only status item is the pre-existing
untracked `scripts/__pycache__/`, unrelated to this design.

The source demonstrates three materially different assertion owners:

* **Exact contract literals.** `scripts/usage_report.py:18,26,28` defines
  report/input schema names, field names, and the finite `PHASES` vocabulary.
  `source_spec` at lines 94–117 enforces absolute paths, `kind` and
  `native_boundary` choices, recognized phases, and nonempty route labels.
  These shapes are consumed by callers and the public CLI; exact equality is
  justified for them. `README.md:41–45` likewise makes route/model/effort
  spelling and spacing part of the user-facing selection syntax.
* **Observable behavior/structure.** `parse_cli` at lines 193–243 and
  `parse_native` at lines 246–342 decide duplicate handling, missing usage,
  counter deltas, context spans, fresh boundaries, and failed/aborted markers.
  `build_report` at lines 384–523 preserves partial/no-usage status, unknowns,
  diagnostics, source hashes, provenance, overlap refusal, and report shape.
  The tests exercise these outcomes (`tests/test_usage_report.py:74–390`), so
  assertions should inspect values, shape, counts, and status rather than
  sentence formatting.
* **Descriptive presentation.** `render_text` at `usage_report.py:531–558`
  renders a human summary from the structured report. Its sentence order and
  incidental spacing are not shown as a separate consumer contract. A prose
  claim still needs source and observable evidence when it asserts behavior;
  this category is not permission to skip substantive verification.

The current guidance already says to verify behavior, reuse applicable
evidence, improve ambiguous instructions, and keep required tests
(`orchestrator/IMPROVEMENT.md:93,96,151,263–307`). It does not provide the
small source/consumer distinction above. Conversely, the existing record
contract explicitly rejects new machine schemas, duplicated ledgers, and
mandatory report validation (`WORKSPACE.md:15–16,31–47`). The design therefore
adds one paragraph rather than implementing a typed lens, canonical report
model, failure postcard, declaration metadata, or changed-file test selector.

## Exact implementation slice after adoption

**Prospective root:**
`/Users/mark/Documents/Codex/2026-09-04/lunacy-astra-architecture/work/golden-worker-ownership-2026-09-10/cycle18/implementation-checkout`,
a clean separate checkout at `1e0204fae20c02f778f4d3784553affa44b4e9b4` created
only after parent adoption. Do not edit or use the retained dirty development
tree.

**Single maintained path:**
`/Users/mark/Documents/Codex/2026-09-04/lunacy-astra-architecture/work/golden-worker-ownership-2026-09-10/cycle18/implementation-checkout/orchestrator/IMPROVEMENT.md`.
No source helper, test, fixture, README, schema, runtime, package
manifest, configuration, installation, or release file changes are needed.
One coherent `bulk` worker (default exact `gpt-5.6-luna / max`) can apply the
bounded paragraph; use the task-selected `judgment` route (default exact
`gpt-5.6-sol / medium`) only if adoption names a genuinely difficult semantic
question. The parent must seal the literal route and fresh context in TASK;
this design does not change routing or make Sol universal.

Insert the following at the end of the existing feedback guidance near line
307, preserving all surrounding rules and links:

> Before creating a bespoke checker, trace each asserted token, shape, or
> sentence to its source owner and an actual consumer. Keep exact equality for
> a source/consumer-defined contract literal (such as a route, key, schema
> value, path grammar, or consumer-visible error); for descriptive prose or
> presentation formatting, check the claimed behavior or structure instead of
> sentence order or spacing. No semantic prose claim is exempt from executable
> or otherwise observable proof. When a check fails, identify the first
> unsupported source → behavior → report edge: repair a checker/report defect
> with its existing owner and attempt bounds; repair an observed behavior
> defect through its existing owner; and send a source/roadmap conflict to
> parent judgment. Do not add a checker, report-validation pass, retry,
> declaration, ledger, or test waiver merely to classify the failure.

“Existing owner and attempt bounds” is deliberate: ordinary pre-FINAL repair
remains permitted, while a one-attempt assignment remains consumed by a
validation failure and cannot be automatically reinvoked. The paragraph does
not authorize rerunning the six failed logs, classify all strings as exact, or
waive unchanged-source tests. It reuses the current report and command logs.

## Verification and acceptance

The implementation worker should first inspect the final diff against the
adopted paragraph and source references, then run only the repository checks
that prove this documentation/package change:

```sh
timeout 60s python3 -B ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
timeout 60s python3 -B -m unittest discover -s tests -v
timeout 60s git diff --check
```

These are integrity checks, not worker-behavior or savings measurements. The
existing unit suite is retained because the package builder and documented
recipes are public surfaces; no new prose-string harness is proposed. The
worker must preserve separate stdout/stderr/exit receipts, including any
failed, skipped, or unavailable command. Parent acceptance independently checks
the complete diff, exact paragraph, link reachability, source line claims,
unchanged maintained code/tests, and package inclusion from the builder's
canonical mapping. `quick_validate` and the suite cannot prove that a future
worker makes better choices; they only prove artifact integrity and retained
product behavior.

The meaningful negative matrix for later acceptance is:

| Case | Required interpretation | Failure that must remain visible |
|---|---|---|
| Route/model/effort, schema key/value, phase, JSON path grammar, or CLI error token is changed | Contract-literal exact check | The existing source/test or caller-facing check fails; do not normalize it as prose. |
| `empty` receipt, missing usage, aborted turn, unknown phase, counter reset, or overlap | Structural/behavior check | `no_usage`/`partial`, unknown counts, diagnostics, and refusal remain observable; do not turn missing data into zero. |
| A sentence such as a self-review label differs while source and observed behavior agree | Descriptive/report-side defect | Repair the checker or prose owner; do not add a second checker or call it a product regression. |
| JSON `Path` passed where a string is expected, malformed assertion, or wrong helper operand type | Checker execution defect | Preserve the nonzero diagnostic and repair the same owner under existing bounds; no automatic replay. |
| Observed output contradicts `usage_report.py` behavior/tests | Product defect | Existing implementation owner repairs and reruns affected proof under ordinary authority. |
| Source and adopted roadmap disagree | Authority/design conflict | `DECISION_REQUIRED`; no worker invention, waiver, or route change. |

Acceptance fails if the paragraph is read as a mandatory declaration or
spot-check, if exact model literals are normalized, if semantic prose receives
an exemption, if required tests are skipped because source is unchanged, or if
the change introduces any new runtime/ledger/gate. Acceptance also fails if the
report claims six incidents, measured savings, or successful future worker
behavior. If the source already contains an equivalent rule at implementation
time, reject the edit as redundant and record `no-worthy-opportunity` for this
slice rather than forcing a change.

## Effects, dependencies, recovery, and non-goals

Before adoption there are no product effects. After adoption, one fresh worker
may synchronously modify the one guidance file and its own report/logs; the
prospective checkout is the only product surface. No network, live model trial,
telemetry, installation, release, global setting, nested agent, or retained
development write is allowed. Parent acceptance remains the sole authority;
worker FINAL is not acceptance. Any live or unknown command keeps custody OPEN
and prevents replacement or replay. Ordinary bounded pre-FINAL repair stays
with the same owner; the existing 15-minute recovery and one 5-minute
challenge rules apply, while this design adds no automatic retry. A material
scope, interface, or source conflict requires a new adoption. Rollback, if
needed, is a new parent-authorized change to this one paragraph, not cleanup of
unrelated work.

This slice does not establish reduced turns, fewer failures, cost, cache
behavior, causal attribution, or a general “prose is safe” policy. A later
naturally occurring comparable case may test whether the clarification helps;
until then, the correct claim is a simpler, source-grounded choice rule—not a
measured win.
