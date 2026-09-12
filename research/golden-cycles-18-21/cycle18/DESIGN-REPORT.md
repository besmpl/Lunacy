# Cycle 18 design report

Status: COMPLETE; source-grounded design only. The full ADHD reconciliation is
`cycle18/ADHD.md`; the executable roadmap is `cycle18/DESIGN.md`.

## Result

Recommend one narrow guidance paragraph in `orchestrator/IMPROVEMENT.md`:
classify assertions by source/consumer contract shape versus observable
behavior versus descriptive presentation, then diagnose the first unsupported
source → behavior → report edge. It preserves exact literals, required tests,
ordinary owner repair, independent acceptance, and finite attempt rules while
adding no declaration, ledger, gate, runtime, retry, or prose exemption.

The source is the clean release checkout at
`1e0204fae20c02f778f4d3784553affa44b4e9b4`. Source inventory and line-local
evidence are in `design-logs/source-inventory.log`. The incident remains
9 attempts/6 failed harness runs, not 6 incidents; no savings or behavior win
is claimed. Existing source already handles schemas, route literals, JSON
paths, partial coverage, diagnostics, and required tests; the gap is only
method-selection guidance.

## Verification and limits

Artifact structure review was repaired after an overstrict local focus-shape
predicate; the passing receipt is `design-logs/artifact-self-review-repair.log`.
The first final-review wrapper also failed to propagate an inner grep failure;
the corrected, fail-fast prospective-path receipt is
`design-logs/final-review-repair3.log`.
No product tests, prose-string harness, source edit, network, live trial,
release, install, or retained-development effect was run. Parent adoption and
acceptance remain required before any implementation checkout or product write.
