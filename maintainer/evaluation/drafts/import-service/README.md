> **INACTIVE DRAFT — work stopped by user on 2026-09-26.**
> This snapshot is NOT registered in `evaluation_pack.py` or included in plugin
> artifacts. Commands below describe the intended integration and do not yet
> work through that runner. See [STOPPED.md](STOPPED.md) before continuing.

# Import service: multi-file, changing-evidence fixture

This maintainer-only fixture makes the existing broad import-service planning
scenario executable. A shared parser/store, import service, CLI, and WSGI adapter
must preserve one complete public contract (v2). It is an unsplit product outcome,
not a ready queue or a required worker count. The supplied parser and store are
complete; the starter passes its narrow successful-input smoke tests.

The trusted checker executes candidate Python in disposable local directories.
It is not a sandbox, a native orchestration test, or a release certificate.
Runtime PASS covers the observed parser/service/adapter behavior. It checks only
that migration guidance exists and is nonempty; an independent reviewer must
assess the prose against CONTRACT.md before accepting a native deliverable.

## Fixed checker and controls

```sh
python3 -B -m maintainer.evaluation_pack materialize import-service /tmp/import-candidate
python3 -B -m maintainer.evaluation_pack check import-service /tmp/import-candidate
```

The checker reads evaluator-owned raw captures and independently frozen literal
expectations. It does not derive expectations from a reference implementation or
candidate-owned tests. It exercises the actual CLI subprocess and WSGI callable,
including persistence preservation, exact row errors, UTF-8/newline fidelity,
bounded short reads, declared-byte framing, statuses, headers and I/O errors.
Each CLI child has a two-second deadline within the existing five-second outer
default; no sockets, sleeps, network, dependencies or model calls are needed.
Unexpected import/runtime errors remain ERROR rather than behavioral FAIL.

| Control | Expected status | Exact detail |
| --- | --- | --- |
| Starter | FAIL | `invalid batch was partially committed` |
| Incomplete overlay | FAIL | `CLI rewrote preserved CSV display_name` |
| Reference overlay | PASS | `PASS` |

The incomplete variant repairs shared atomic validation but retains a plausible
CLI newline-translation bug. Parser preview records do not authorize partial
commits. Successful single-line samples cannot establish preservation of
multiline CSV or correct HTTP body framing.

## Optional manual observation releases

Use the bounded native-run recipe and a sealed manifest before any native run.
The fixture itself dispatches nobody and grants no additional execution scope.

1. **Initial packet:** materialize `worker/` only. The complete CONTRACT.md,
   unsplit TASK.md, starter source, migration placeholder, initial inputs and
   smoke tests are public. Do not disclose this maintainer README, oracle,
   expectations, reference or incomplete overlay as task input.
2. **Validation observation:** after freezing an initial candidate, its report
   and actual check results, release only `evaluator/captures/late-mixed.json`
   into the candidate's inputs. Record the exact bytes/hash and native delivery
   receipt. This input exercises already-public validation and atomicity rules.
3. **Adapter observation:** after the next settled report/snapshot, release only
   `evaluator/captures/late.csv` and `late.json`. Also report the ordinary WSGI
   condition that a declared body can arrive in short reads while trailing bytes
   belong to a later request. Use actual bounded-stream checks; do not fabricate
   a reported failure. These observations add no acceptance requirement.
4. **Acceptance:** after writers settle, run the fixed checker against frozen
   earlier and final candidates and obtain semantic migration review. Preserve
   all failures and raw statuses. An unchanged correct candidate is a valid
   outcome: do not insert a defect or require a repair to make a story work.

A late counterexample under unchanged source does not erase a historical narrow
PASS or change its hash. It can defeat a broader adequacy claim. An actual source
edit makes affected old checks stale; unrelated evidence may remain applicable.
Native delivery, adoption, changed/no-change action and subsequent proof require
separate observed evidence. Filesystem separation is organization, not access
control; document uncontrolled evaluator access rather than claiming blindness.
No single run establishes useful-discovery recall, speedup, cost reduction,
quality-preserving scale or model obedience.

## Prospective contract revision

Before any native run, independent review reproduced a v1 mismatch: Python's
CSV reader rejects a 131073-character field although v1 stated no ceiling.
Version 2 explicitly bounds CSV fields to the unchanged standard-library
131072-character runtime limit, with JSON unchanged. It also publishes the
existing SQLite schema/constraint compatibility needed for a real late-write
rollback probe. The v1 mismatch is retained in task evidence, not called fixed
under the old contract. Larger-CSV/arbitrary-runtime support is a replacement
trigger, not a capability of this fixture. Environment prerequisite failure is
ERROR, not candidate FAIL.
