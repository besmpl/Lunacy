# Catalog replay: staged executable fixture

This fixed offline fixture tests a real exporter repair under new evidence. It
is a ninth engineering fixture, not another report-only research-swarm case.
The trusted checker executes candidate Python; it is **not a sandbox**, a worker
compliance audit, or proof that unobserved effects did not occur.

## Release allowlists

1. **Initial release:** materialize only `worker/`: `TASK.md`, `CONTRACT.md`,
   `catalog_export.py`, `test_catalog_export.py`, and `inputs/initial.json`.
   Preserve the original smoke test; it intentionally is not a full oracle.
2. **Late release:** after freezing the initial candidate and phase report,
   copy only `evaluator/stage2/late.json`, `late-bad.json`, and `EVENT.md` into
   that candidate's `inputs/` directory. Preserve bytes and record their hashes
   and release receipt. The event does not change the public contract.
3. **Acceptance:** freeze the final tree after writers settle. Run the fixed
   checker on both the final candidate and the retained initial snapshot.
   Neither `check.py`, `case.json`, `reference/`, `incomplete/`, nor this
   maintainer README is worker-visible. Do not expose final diagnostics before
   the controlled late release. Directory separation is not access isolation.

The actual phase handoff and any native agent brokerage remain parent-owned;
this fixture adds no launcher, generic command runner, or recurring task.

## Checker and controls

From the repository root:

```sh
python3 -B -m maintainer.evaluation_pack materialize catalog-replay /tmp/catalog-candidate
python3 -B -m maintainer.evaluation_pack check catalog-replay /tmp/catalog-candidate
```

The checker interface remains `check.py CANDIDATE` and emits exactly one
`LUNACY_EVALUATOR_RESULT_V1` record. It supplies evaluator-owned capture files
and temporary outputs; candidate-owned tests and inputs are not its authority.
It compares literal expected bytes **and** independently stated decoded rows,
then checks boundary/invalid cases and the actual CLI. Expected bytes are not
computed by importing the reference. The public contract explicitly defines
canonical minimal quoting so exact bytes are an output contract, not a source
layout constraint. Extra metadata does not change defined row payloads.

| Control | Expected status | Exact detail |
| --- | --- | --- |
| Starter | FAIL | `initial archive export mismatch` |
| Incomplete overlay | FAIL | `late revision replay mismatch` |
| Reference overlay | PASS | `PASS` |

The incomplete overlay repairs pagination and CSV escaping but wrongly drops
tombstones before reconciliation. It remains green on the narrow worker test.
The reference validates/reconciles in a private value-only function, renders
CSV before opening the destination, and keeps filesystem/CLI effects in the
shell. Conflicts at a lower revision can be superseded; malformed lower rows
cannot. Missing reachable pages and cycles fail; unreachable data is ignored.

Each of the two fixed CLI subprocess calls has a two-second timeout within the
existing five-second outer evaluator default. There are no network calls,
sleeps, third-party dependencies, configurable commands, or retries. Raw
checker stderr retains CLI return codes/stdout/stderr; the existing runner's
normal result protocol remains unchanged. The outer bound also covers API
execution, and candidate Python is trusted local code rather than confined.
Failure preservation covers parsing, acquisition and validation, not disk
failure or crash durability. A passing fixture establishes these observable
export behaviors, not general policy improvement or native cancellation.
