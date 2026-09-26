# Offline engineering evaluation pack

This maintainer-only pack currently has nine deterministic engineering fixtures.
They map to lifecycle cancellation, cross-file pagination, behavior-preserving
refactoring, dirty user work, misleading-green tests, stale evidence after an
edit, a missing required test environment, and a shared-interface integration
repair with source-bound proof, and staged catalog replay with late evidence.
Categories can overlap, so this
is not a claim of literal 7/12 roadmap coverage or Phase 0 completion. The pack
tests code behavior, not agent honesty, instruction compliance, model obedience,
dispatch identity, custody, or workflow quality. Unknown dispatch/effect cases
remain structural guidance scenarios elsewhere.

The misleading-green evaluator independently repeats the supplied regression's
observable behavior before checking the missing requirement. It does not execute,
inspect, or require preservation of the candidate's `test_contact.py`; therefore
the pack rejects test-only non-fixes but does not prove test-file preservation.

The interface-integration fixture has two separately green slice controls but
rejects their mismatched real call. Its incomplete variant repairs the call but
reuses passing proof after a source edit; the reference binds proof to both
source files. The existing dirty-sentinel fixture checks byte preservation of
preexisting work. These are code-behavior controls, not proof of native workspace
custody, dispatch coordination, or agent compliance.

Each fixture separates `worker/` (the only materialized task packet) from
`evaluator/` (acceptance checker, known-good reference, and a plausible
incomplete solution). The runner executes only the fixed repository-owned
checker for the selected fixture. It never executes commands from JSON or runs
a model. This filesystem separation is organization, not access control.

```sh
python3 -B -m maintainer.evaluation_pack list
python3 -B -m maintainer.evaluation_pack selfcheck
python3 -B -m maintainer.evaluation_pack materialize late-cancellation /tmp/case
python3 -B -m maintainer.evaluation_pack check late-cancellation /tmp/case
```

`check` validates a trusted, quiescent candidate tree before launching isolated
Python with bytecode writes disabled. A fixed result record distinguishes a
behavioral `FAIL` from an import/syntax/runtime `ERROR`; `exitCode` is the raw
child exit. The CLI exits nonzero for `FAIL`, `ERROR`, or `TIMEOUT`, while a
successful `selfcheck` exits zero because the declared rejections matched.

Candidate validation is not safe against hostile concurrent filesystem races.
The local child and finite deadline are deliberate code execution, not a
sandbox, process supervisor, or network/filesystem confinement.
Use only an owned disposable directory, ordinary least privilege, no secrets,
and separately established authority. The selfcheck uses trusted repository
fixtures, no network, and no sleeps.

See `native-run-recipe.md` for the bounded manual experiment procedure and
`manifest-template.json` for facts that must be recorded before a native run.
No live runs or token/cost claims are part of this pack.

The [catalog-replay case](fixtures/catalog-replay/README.md) adds a staged
implementation experiment: initial acquisition/CSV defects, then late revision
and tombstone observations, checked against independent expected output. Its
final checker exercises real API/CLI behavior and preserves prior output on
invalid input. Staging/transfer observations require the separate native run;
a passing code check does not prove evidence was routed or used by an agent.

The separate [opportunity-discovery packets](fixtures/opportunity-discovery/README.md)
exercise planning from unsplit synthetic outcomes, not code behavior. Their
provisional annotations need independent review and held-out cases before any
behavioral or performance claim. They are not inputs to `evaluation_pack.py`.
