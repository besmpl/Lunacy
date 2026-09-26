# Optional offline usage report

Use [`scripts/usage_report.py`](../scripts/usage_report.py) when a user asks to
inspect token use or an API-equivalent cost scenario for a finite set of
already-captured CLI or native receipts. It is a read-only, standard-library
helper: it does not scan for receipts, run a model, maintain a ledger, or
describe subscription billing.

## Guided example

Create a metadata manifest whose paths are absolute. Assignment labels express
the intended phase and route; they do not prove which route executed.

```json
{
  "schema": "lunacy-usage-input-v1",
  "sources": [{
    "path": "/absolute/path/to/events.jsonl",
    "expected_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "kind": "cli",
    "assignment": {
      "phase": "focus",
      "provider": "openai",
      "model": "gpt-5.6-luna",
      "effort": "max"
    }
  }]
}
```

Direct CLI counting is supported only when the caller has independent current
custody evidence that the selected receipt came from a fresh, one-turn
invocation that was neither resumed nor forked. Serialized flags,
`thread.started`, receipt paths or hashes, versions or models, and numeric
totals do not prove freshness. A completed total of 140 has the same observable
shape whether it records a genuinely fresh 140 tokens or restored history of
100 followed by 40 new tokens; the receipt bytes do not identify which history
occurred. Exclude a resumed, forked, or custody-unknown singleton CLI receipt
from a selected-work comparison, or mark its delta unprovable. When a supported
native pre/post flow has an independently evidenced baseline, use that flow
with the native caveats below; the helper does not subtract a baseline from a
resumed CLI singleton.

`expected_sha256` is optional. When supplied, replace the example with the exact
64-character lowercase SHA-256 of the selected receipt. The helper compares it
with the existing bounded snapshot before parsing that receipt and refuses a
mismatch; duplicate ordering cannot discard a mismatched pin. This binds the
supplied bytes only. It does not prove receipt identity, truth, custody, or
semantic acceptance, and it never rediscovers or replaces changed input.

```sh
python3 -B scripts/usage_report.py \
  --manifest /absolute/path/to/usage-manifest.json \
  --pricing standard-short \
  --price-basis assigned \
  --format text
```

Add `--require-complete` when an automated caller requires the existing usage
coverage status to be `complete`. A valid `partial` or `no_usage` report is still
emitted unchanged and exits 3. Complete reports exit 0. The default remains
non-strict and emits valid unknown/partial reports with exit 0. Malformed input,
pin mismatch, and output-cap refusal exit 2; the cap is checked before the strict
coverage exit. `complete` is the existing observed coverage heuristic; it and
`--require-complete` do not prove that every terminal or field was captured,
that a CLI counter is fresh or incremental, or that the selected bytes represent
only the chosen work. These codes concern usage coverage only, not correctness,
freshness, counter basis, or acceptance.

JSON is the stable output (`--format json`, the default). `--pricing none`
reports quantities only. `standard-short` and `standard-long` are explicit,
reproducible API-equivalent scenarios dated **2026-09-10**. Long multiplies
input, cache-read, and cache-write rates by 2 and output by 1.5; it is never
inferred from aggregate token volume.

| provider/model | input | cache read | cache write | output |
|---|---:|---:|---:|---:|
| openai/gpt-6-astra | 10 | 1 | 12.5 | 50 |
| openai/gpt-5.6-sol | 4 | .4 | 5 | 20 |
| openai/gpt-5.6-luna | .2 | .02 | .25 | 1.2 |

Rates are USD per million tokens. Cached reads and writes are subsets of input;
reasoning is included in output and is not charged twice. `--price-basis
recorded` prices only a provider/model present in the receipt. `--price-basis
assigned` explicitly prices the manifest's counterfactual route. Unknown
fields retain known token and price subtotals with unknown counts; they never
become zero or a complete price.

A selected source that contains no countable usage remains visible as an
unknown token contribution. A single such source reports `no_usage`; alongside
counted sources it makes coverage `partial` rather than contributing zeros.

Rate provenance: the dated table comes from OpenAI's official
[API pricing](https://developers.openai.com/api/docs/pricing); the long-context
rule follows the official [gpt-6-astra model documentation](https://developers.openai.com/api/docs/models/gpt-6-astra).

## Native counters and overlap

Native `total_token_usage` values are cumulative. The helper counts adjacent
deltas, not every total, and treats the first sample as a baseline. To count a
known first sample, set `"native_boundary":"fresh_session"`; this caller
assertion is accepted only with a preceding, same-file nonempty
`session_meta.payload.id`. That evidence does not prove the session was not
forked or resumed. A delta crossing a recorded context change is not attributed
to either model or effort.

For native snapshots, observed `task_started`, `task_complete`, and
`turn_aborted` markers provide a narrow boundary diagnostic: an unmatched
start or an abort makes coverage partial. This is not a full lifecycle engine
and does not prove that an arbitrary snapshot is complete.

Identical files are counted once only with identical labels and boundary.
Distinct sources sharing a known thread/session are refused. Multiple sources
with any unknown identity are also refused, because disjointness cannot be
established. This deliberately prevents a CLI receipt and its matching native
counter from being summed.

The manifest is limited to 64 sources and 1 MiB; selected receipt bytes total
at most 64 MiB and 200,000 JSONL records. Output defaults to 8192 bytes and may be raised with
`--output-cap` up to 1 MiB. Diagnostics contain hashes and line pointers, not
receipt content. `--include-observations` adds normalized identities and token
values only.

The report covers only explicitly selected receipts. It is not a complete
Golden-cycle accounting, route verification, quality comparison, savings
claim, or invoice.

<a id="ordinary-overhead-comparison"></a>
## Ordinary overhead comparison

This is an **opt-in, read-only comparison procedure**, not a runtime feature or
telemetry collector. Use it only when a user asks for a comparison and only for
finite, authorized receipts already in hand. Do not scan for receipts, start a
model, change routing, or infer missing counters. Put the complete finite source
set (parent, worker, failed attempts, repairs, and review receipts that belong
in the cohort) in one manifest and run the existing `usage_report.py` once on
that set, normally with `--pricing none`. Identity, duplicate, and overlap
checks happen before role/phase slices are interpreted. The helper refuses
multi-source input when identity cannot establish disjointness or when distinct
files share a known identity, but it cannot detect a lone resumed CLI receipt.
The caller must exclude or mark unprovable any resumed, forked, or
custody-unknown singleton unless using the independently evidenced supported
native baseline flow, with its boundary and context caveats. Never treat
`complete` or `--require-complete` as freshness or incrementality proof, and
never manually sum independent reports; partition parent/worker slices only
after the one report validates the source set. This caller check is what keeps
fork/inherited cumulative data out of a selected-work comparison.

### Diagnostic process budget

For a normal accepted outcome, compare the observed process with these targets:

* one planning/assignment batch;
* one owner dispatch;
* blocking native waits as needed, with no unexplained healthy-worker polling;
* one batched acceptance pass covering specification and code quality/security;
* at most one **default** consolidated correction cycle; and
* no unexplained duplicate discovery, implementation, full-suite validation, or
  visual check.

These are diagnostic targets, never a permission, quality, token, or universal
retry limit. Record justified exceptions rather than treating a target miss as
failure. A cheaper rejected or incomplete outcome is not a win.

### Comparison record

Keep one small caller-authored note per cohort. This template is data, not a
new mandatory record or schema:

```json
{
  "schema": "lunacy-overhead-comparison-v1",
  "cohort": {"name": "synthetic-example", "scope": "same bounded change and checks", "model_effort": "record exact literal pairs", "context": "fresh native child", "difficulty": "small known task"},
  "samples": [{
    "id": "ordinary-001",
    "usage_report_manifest": "/absolute/complete-usage-manifest.json",
    "feedback_cycles": 1,
    "checks": {"required_first_run": 1, "repeated": []},
    "elapsed_seconds": null,
    "outcome": "accepted"
  }]
}
```

`elapsed_seconds: null` is an explicit unknown, not a synthetic zero. A
`required_first_run` is not a repeat; list only additional checks in
`checks.repeated` with their reason. The one manifest is passed to
`usage_report.py` before role slices are read. Record parent and worker input,
cache-read, cache-write, output, and reasoning counters when exposed (reasoning
is part of output, not another charge), all attempts, repairs, parent feedback
passes, elapsed time, and accepted/rejected/incomplete outcome. Unknown fields
stay unknown. Include failed, incomplete, repair, and review costs in the
numerator; do not add overlapping receipts twice or turn missing usage into
zero. Compare only materially comparable scope, model/effort, context, checks,
and task difficulty, and report sample count and receipt/field limitations.

### Worked synthetic quantities (illustrative only)

All rows below are in one complete manifest; numbers are not a benchmark:

| sample/role | attempts | input | cache read | cache write | output (reasoning subset) | outcome |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `ordinary-001` parent | 1 | 1,200 | 200 | 0 | 100 (20) | accepted |
| `ordinary-001` worker, failed implementation | 1 | 4,000 | 1,000 | 0 | 350 (80) | failed |
| `ordinary-001` worker, repair | 1 | 2,500 | 500 | 0 | 260 (60) | accepted |
| **all attempts** | **3** | **7,700** | **1,700** | **0** | **710 (160)** | **accepted denominator: 1** |

Failed work remains in the numerator for any later API-equivalent scenario.
With zero accepted outcomes, cost per accepted outcome is **undefined**, not
zero. If an accepted sample is missing input or output counters, retain known
subtotals, mark coverage/price partial, and leave missing fields unknown.

Two negative cases are mandatory: (1) parent and worker receipts share a known
identity or a fork inherited cumulative counters, so one-manifest reporting
must refuse or mark the aggregate unprovable and no role totals may be added;
(2) a cohort has zero accepted outcomes or an accepted sample has missing
counters, so report an undefined denominator or partial unknown coverage rather
than a measured saving.
