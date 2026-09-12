# cycle20 source diagnosis/design Worker Report

Adoption/assignment: `TASK.md#cycle20-adoption` and `TASK.md#cycle20-design`

Status: PASS

Goal/result: Completed the authorized source-only diagnosis, synthetic
public-CLI reproduction, full ADHD rendering, and narrow implementation
roadmap for `usage_report.py` boundary hardening. Three suspected failures are
confirmed; no source fix was applied.

Changed/effects:

- Wrote `cycle20/ADHD.md` from the preserved five raw breadth branches,
  `SCORES.json`, `SELECTED.json`, and three focus outputs; all 30 ideas,
  clusters, scores, traps, three focus branches, and the verbatim Focus-3
  wildcard are rendered.
- Wrote `cycle20/DESIGN.md` with source citations, confirmed/untriggered
  diagnosis, exact future route, one coherent minimal implementation slice,
  checks, invariants, effects, and recovery/acceptance limits.
- Wrote synthetic-only evidence under
  `cycle20/synthetic/boundary-reproduction/` and the runner
  `cycle20/synthetic/reproduce_usage_boundary.py`; no source or accepted
  `cycle18/implementation-checkout/orchestrator/IMPROVEMENT.md` content was
  changed.
- Wrote the artifact-validation receipt under
  `cycle20/design-logs/artifact-validation.{stdout,stderr,exit}`.

Verification:

- PASS — bounded reproduction command:
  `timeout 60s env PYTHONDONTWRITEBYTECODE=1 python3 -B cycle20/synthetic/reproduce_usage_boundary.py`.
  `valid-control` exited 0 with 2,769-byte stdout and empty stderr. `depth`
  exited 1 with empty stdout and a 2,297-byte traceback ending in decoder
  `RecursionError`; `huge-int` exited 1 with empty stdout and a 2,352-byte
  traceback ending in 5,000-digit `ValueError`; `surrogate` exited 1 with
  empty stdout and a 618-byte traceback ending in `UnicodeEncodeError` at the
  final UTF-8 encode. Raw exit/stdout/stderr evidence is retained per case.
- PASS — artifact validation command, bounded by `timeout 60s`, recorded in
  `design-logs/artifact-validation.*`: 30 scored ideas, five six-idea raw
  branches, three focus JSON files, selected JSON, and both design artifacts
  validated.
- PASS — source custody inspection:
  `git -C cycle18/implementation-checkout status --short` reported only the
  pre-existing accepted `orchestrator/IMPROVEMENT.md` modification (17 lines).
  No source scripts/tests/package files were edited by this assignment.
- NOT RUN by authorization — product tests, packaging tests/builds, model
  calls, telemetry/receipt collection, network, install, release, and global
  changes. The design records exact future focused, sibling, packaging
  15-second, and full-suite 60-second commands; running them now on unchanged
  read-only source would be ceremony outside the design assignment.

Evidence:

- Source diagnosis: `cycle20/DESIGN.md`, especially the confirmed-failure
  table and source citations; source files are read-only at
  `cycle18/implementation-checkout/scripts/usage_report.py` lines 46–60 and
  559–584, `scripts/evidence_index.py` lines 151–175 and 632–659,
  `scripts/worker_models.py` lines 53–64, and the named tests/docs therein.
- Reproduction receipts:
  `cycle20/synthetic/boundary-reproduction/{valid-control,depth,huge-int,surrogate}/`
  each contains `command.txt`, `exit.txt`, `stdout.bin`, `stderr.bin`, and
  `summary.json`.
- ADHD source inputs remain preserved in `cycle20/{DIVERGE-*.json,SCORES.json,
  SELECTED.json,FOCUS-*.json}`; the final wildcard attribution is explicit in
  `ADHD.md`.

Self-review/risks: PASS. I reread the final ADHD/design/report artifacts and
checked every cited reproduction path against its retained command, exit,
stdout, and stderr files. The selected roadmap deliberately avoids a custom
parser, new limits, dependencies, partial-success quarantine, or
identity-changing surrogate substitution. The confirmed depth and huge-int
failures are Python decoder exceptions omitted by `load_json`; the confirmed
surrogate failure is a final output encoding exception omitted by `main`.
Future implementation must use a fresh adoption and writable independent
checkout, preserve the accepted guidance paragraph, and stop for any contract
or lossless-identity ambiguity. This design does not establish measured
savings or authorize implementation.
