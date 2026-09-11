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

```sh
python3 -B scripts/usage_report.py \
  --manifest /absolute/path/to/usage-manifest.json \
  --pricing standard-short \
  --price-basis assigned \
  --format text
```

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
