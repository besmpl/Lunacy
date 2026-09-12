# Cycle 18 design revision

**Status: design-only, not an implementation authorization.** This revision
reconciles the findings on `cycle18/DESIGN.md` without changing the frozen
design, the shipped checkout, or parent-owned `TASK.md`.

## Decision and smallest useful change

Retain one documentation-only clarification at the existing feedback seam in
the canonical shipped file
`/Users/mark/Documents/Codex/2026-09-04/lunacy-astra-architecture/work/golden-worker-ownership-2026-09-10/cycle18/implementation-checkout/orchestrator/IMPROVEMENT.md`.
Do not edit `WORKSPACE.md`, `worker/ENGINEERING.md`, the packaged Golden card,
README, tests, scripts, or the builder: their existing rules and package
mapping already provide the needed ownership, repair, source, and packaging
contracts. The builder copies `orchestrator/` through the native tree, and its
packaging suite checks that parity. Keeping one canonical paragraph avoids a
second policy and avoids turning a design observation into a runtime mechanism.

The paragraph to add after the existing feedback guidance (currently the
paragraph ending “Cost claims require trustworthy billing evidence.”) is:

> Before adding a bespoke assertion, identify the claim, its source owner, and
> its actual consumer. Use exact equality only when that owner/consumer
> contract requires a literal token or shape, such as a report schema, an
> accepted phase value, or a parser-recognized option; a README example and
> incidental prose spacing or order are descriptive unless a consumer contract
> makes them significant. For a behavior claim, inspect the structured outcome
> and use the applicable existing behavior or integration evidence. For a
> source-only roadmap claim, direct source, interface, and evidence review is
> sufficient when no execution is being claimed. If evidence fails, preserve
> the actual result and use the existing repair and decision rules: the same
> owner may make ordinary pre-FINAL repair within the sealed attempt; a settled
> contract/test mismatch stays with that owner, while a genuine contract or
> source/roadmap conflict is `DECISION_REQUIRED`. After FINAL, the worker is
> frozen; substantive correction requires a new parent assignment and report
> with affected proof. Do not add a checker, report-validation pass, ledger,
> runtime, retry, or test waiver merely to choose among these evidence types.

This is a method-selection reminder, not a “first-broken-arrow” framework. It
uses the existing repair rule when diagnosis is needed and does not require a
witness, declaration, matrix, new report field, or live effect for every prose
sentence. It also does not exempt semantic prose: a prose sentence that makes a
behavior claim still needs evidence appropriate to that claim. Conversely, a
future unexecuted proposal is not a claim that its behavior has occurred, and
source inspection remains legitimate evidence for a source-only claim.

## Source-grounded reconciliation

The prospective baseline is the separate checkout at commit
`1e0204fae20c02f778f4d3784553affa44b4e9b4`:
`/Users/mark/Documents/Codex/2026-09-04/lunacy-astra-architecture/work/golden-worker-ownership-2026-09-10/cycle16/release/main-checkout`.
Its relevant contracts are already explicit:

* `WORKSPACE.md:16–20` makes `TASK.md`, one immutable worker report, and only
  necessary logs the coordination contract; `:50–62` requires actual command
  results, evidence applicability, one worker self-review, and the immutable
  FINAL/new-attempt boundary. Parent acceptance at `:62` remains independent.
* `orchestrator/IMPROVEMENT.md:93–99` defines the Golden stages and
  `:96–97` already says that Luna self-reviews source-dependent design claims,
  that existing tests are not waived, and that post-FINAL repair is a new
  assignment. The final feedback paragraph is the one natural insertion point.
* `worker/ENGINEERING.md:5–11` already directs tracing callers and tests,
  ordinary same-owner repair, and `DECISION_REQUIRED` for genuine conflicts;
  `:36–49` requires real exit/timeout settlement and truthful unknowns; `:55`
  requires final diff, affected checks, and honest failed/skipped/unavailable
  receipts. No recovery framework is missing that this paragraph should
  duplicate.
* `scripts/usage_report.py:19–35,94–117` establishes actual source-owned
  schema, manifest schema, field vocabulary, `PHASES`, path/kind/boundary
  choices, and parser-recognized assignment values. These are examples where
  exact equality can be justified by the implementation and its consumers;
  exactness must not be inferred from a nearby example alone.
* `scripts/usage_report.py:384–523` (the release version) exposes structured
  observations, diagnostics, `source_without_usage`, `no_usage`/`partial`
  coverage, and limitations. `:531–556` renders a human summary from that
  report. The structured status and diagnostics are behavior evidence; sentence
  order and incidental rendering whitespace are not shown as contracts.
* `README.md:13–45` displays selector examples, including model/effort spelling,
  but the examples alone do not establish that every whitespace choice is a
  parser contract. The README is therefore left unchanged.
* `packaging/build_plugin.py:13–18,76–95` defines the canonical copied trees,
  and `packaging/test_build_plugin.py:130–188` builds an external temporary
  package, checks byte parity and links, and exercises the public package
  surface. This is why a real packaging-suite run is required even though the
  source change is documentation-only.

The prior observed vector is reported honestly: the cycle-17 design assignment
made **nine self-review harness attempts, six failed and three passed**. The
failures are visible in `cycle17/design-logs/artifact-self-review.log`,
`artifact-self-review-repair.log`, `final-review.log`,
`final-review-repair.log`, `final-review-repair2.log`, and
`final-review-repair4.log`; the passing repairs are `artifact-self-review-
repair2.log`, `final-review-repair3.log`, and `final-review-repair5.log`.
Cycle-17's independent packaging receipt reports 15 tests passed, but neither
that result nor the harness count measures savings, reliability, model quality,
or a causal product improvement. The six failures are not six product
incidents. No new prose-string harness is proposed here; the prior receipts
remain evidence, not a required replay.

## Adoptable implementation slice

Only after a new parent adoption, create or select the clean prospective
checkout
`/Users/mark/Documents/Codex/2026-09-04/lunacy-astra-architecture/work/golden-worker-ownership-2026-09-10/cycle18/implementation-checkout`
from `1e0204fae20c02f778f4d3784553affa44b4e9b4`. The parent must verify that
the checkout is independent of retained dirty development before dispatch.
One fresh coherent native worker owns the single paragraph and the immutable
report
`/Users/mark/Documents/Codex/2026-09-04/lunacy-astra-architecture/work/golden-worker-ownership-2026-09-10/cycle18/implementation/REPORT.md`;
the parent binds that path in the Authorized Assignment before dispatch. The
default coding route is exact `gpt-5.6-luna / max`, fresh context, with no
automatic fallback. A task-selected exact `gpt-5.6-sol / medium` judgment
route may be used only if the parent adopts a separately named difficult
semantic question; this clarification does not create or require that route
and never overrides an explicitly adopted Sol implementation assignment.

The worker reads the adopted paragraph, the source references above, current
project rules, and the relevant report/packaging contracts. It edits only
`orchestrator/IMPROVEMENT.md` and its own report/logs. It does not touch README,
the package card, tests, scripts, manifests, configuration, release files,
installation, or parent records. If the paragraph is already present with the
same meaning, the worker reports `no-worthy-opportunity` and makes no
redundant edit. If source and adopted wording disagree materially, stop with
`DECISION_REQUIRED`; do not invent a new predicate.

### Bounded verification sequence

After the edit, the same worker performs one direct diff/source review and the
following checks, in this order, after any ordinary pre-FINAL repair:

1. Validate the skill from the prospective checkout:
   `python3 -B ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .`.
2. Run the real package suite (not the source-only suite substituted for it):
   `python3 -B -m unittest discover -s packaging -p 'test_*.py' -v`.
   Its 15-test builder exercise must complete, including external temporary
   output, byte parity, links, and refusal cases. The worker additionally
   records a direct external build and `cmp` of the edited canonical document
   with `skills/lunacy/orchestrator/IMPROVEMENT.md`; the temporary destination
   is outside the checkout and is removed only after settlement.
3. Run retained behavior coverage:
   `python3 -B -m unittest discover -s tests -v`.
4. Run `git diff --check` and inspect the complete final diff, including
   unchanged package-test identity and package inclusion.

Every command has an actual 60-second subprocess deadline. Do not assume a
GNU `timeout` executable: use Python's standard-library mechanism for each
bounded invocation, e.g. a one-off wrapper that calls
`subprocess.run(command, capture_output=True, text=True, timeout=60)`, writes
captured stdout and stderr to separate worker-owned receipts, and returns the
child's exact exit code (124 only for the wrapper's observed timeout). This is
command plumbing, not a product helper or a prose checker. Record the wrapper
version, command, start/end, timeout result, stdout, stderr, and exit code;
inspect the native result rather than trusting wrapper text. If the platform
already provides an equivalent verified mechanism, record its actual path and
semantics instead of claiming portability by name.

The report must list every result, including unavailable/skipped/nonzero
checks, and distinguish a process timeout from a failed assertion. A command
that returns a running handle or has unknown settlement leaves custody OPEN;
the worker stops consequential work and reports `BLOCKED` or
`DECISION_REQUIRED` under the existing rules. It does not replay automatically.

## Negative cases and acceptance

The worker and parent use these discriminators without adding a matrix artifact:

| Situation | Required handling |
| --- | --- |
| A schema/phase/parser token is changed and an actual consumer/test requires it | Preserve exact comparison; report the real failing test and repair the same owner within the current pre-FINAL entitlement. |
| A README example, prose sentence, spacing, or ordering changes while source and consumer behavior are unchanged | Treat it as descriptive evidence; do not invent a literal contract or product regression. |
| A behavior assertion disagrees with structured output or an existing behavior test | Preserve the nonzero result, diagnose with the existing owner, repair and rerun only within the sealed pre-FINAL rules. |
| A source-only roadmap claim has no execution effect | Use direct source/interface/evidence review; do not demand a live trial or future behavioral declaration. |
| Source and adopted roadmap have genuinely competing interpretations, or a material owner/effect is unknown | Send `DECISION_REQUIRED`; no worker predicate change, waiver, route change, or replay. |
| Package build/link/parity check fails | Keep the failure visible, repair the paragraph/package owner if allowed, and rerun the affected real check; do not replace it with grep or a bespoke prose harness. |
| The worker has already sent FINAL | Freeze its artifacts. Any substantive correction needs a new parent adoption/assignment and immutable report; a clerical report correction follows the existing parent-only rule. |

Parent acceptance is the sole acceptance. After FINAL it independently checks
the one-file diff against the adopted paragraph, source references, public
contracts, package-builder inclusion, links, all command receipts, report
accuracy, and whole-outcome custody. Acceptance must reject any extra source,
test, runtime, ledger, gate, retry, release, or installation effect; any claim
that the six failures were six incidents; and any claim of measured savings or
successful future worker behavior. A redundant pre-existing paragraph is
accepted only as a truthful `no-worthy-opportunity` disposition, not forced
into a new edit.

This revision proves only that the proposed clarification is narrower and
source-grounded. It does not establish fewer attempts, fewer failures, lower
cost, cache behavior, better model quality, or causal benefit. Standard
15-minute no-action recovery and one 5-minute challenge remain the existing
workflow limits; ordinary pre-FINAL repair remains with the owner, and no
post-FINAL retry entitlement is added. Any material change in source scope,
authority, route, or effects requires a new parent adoption.
