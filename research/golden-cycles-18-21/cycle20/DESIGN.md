# Cycle20 source diagnosis and implementation design

## Outcome and boundary

The requested outcome is a narrow hardening of the offline `scripts/usage_report.py`
public CLI: malformed or unencodable selected input must end in a bounded,
actionable refusal, never an interpreter traceback or a second encoding failure.
This is not a usage-accounting redesign and does not claim user incidence, token
savings, exploitability, or a new policy. The source checkout
`cycle18/implementation-checkout` is read-only for this assignment; this file is
a source-backed roadmap only. The accepted 17-line `orchestrator/IMPROVEMENT.md`
addition remains untouched.

The public contract to preserve is the documented manifest/CLI in
`orchestrator/USAGE-METRICS.md:3-59,86-94`: selected absolute receipts, optional
pricing, stable JSON/text output, explicit unknowns, and no ledger/model/network
effects. In particular, existing duplicate-file and overlap behavior
(`USAGE-METRICS.md:80-84`), identity, unknown counts, dated pricing, and valid
Unicode must remain unchanged. A receipt that carries a lone surrogate is not
silently rewritten: if lossless UTF-8 output is impossible, controlled refusal
is the only acceptable behavior for this slice.

## Diagnosis (confirmed versus untriggered)

### Confirmed public-CLI failures

The owned synthetic runner is
`cycle20/synthetic/reproduce_usage_boundary.py`. It invokes the actual source
CLI as a child with `PYTHONDONTWRITEBYTECODE=1`, `python3 -B`, captured byte
stdout/stderr, and a real five-second child timeout. The complete producer was
bounded by the required `timeout 60s` command. Each case retains its receipt,
manifest, exact command, raw stdout/stderr bytes, exit record, and normalized
summary under `cycle20/synthetic/boundary-reproduction/`.

| Case | Fixture and observed result | Root seam |
|---|---|---|
| `valid-control` | Exit `0`; stdout `2769` bytes; stderr empty; one CLI observation with input `17080`, cache-read `5888`, uncached `11192`, output `2522`, reasoning `1960`, identity `control`. | Baseline proves the source path and ordinary JSON/report encoding work. |
| `depth` | Exit `1`; stdout empty; stderr `2297` bytes containing a Python traceback ending `RecursionError: Stack overflow ... while decoding a JSON object`. Receipt is a linear-depth 200,000-object fixture (`1,200,185` bytes), within the 64 MiB receipt cap. | `load_json` line 57 calls stdlib `json.loads`, while its line-59 handler omits `RecursionError`. `rows` line 125 calls it without another boundary. |
| `huge-int` | Exit `1`; stdout empty; stderr `2352` bytes containing a traceback ending `ValueError: Exceeds the limit (4300 digits) ... value has 5000 digits`. | Python raises `ValueError` during `json.loads`; `load_json` catches `JSONDecodeError` (a narrower subclass) but not this `ValueError`. |
| `surrogate` | Exit `1`; stdout empty; stderr `618` bytes containing a traceback ending `UnicodeEncodeError` at `usage_report.py:576`, `output.encode("utf-8")`. | `json.loads` accepts the escaped lone surrogate; report construction succeeds; final `ensure_ascii=False` encoding fails outside the line-581 `(UsageError, OSError)` handler. |

The exact evidence is retrievable from:

- `boundary-reproduction/valid-control/{command.txt,exit.txt,stdout.bin,stderr.bin,summary.json}`
- `boundary-reproduction/depth/{command.txt,exit.txt,stdout.bin,stderr.bin,summary.json}`
- `boundary-reproduction/huge-int/{command.txt,exit.txt,stdout.bin,stderr.bin,summary.json}`
- `boundary-reproduction/surrogate/{command.txt,exit.txt,stdout.bin,stderr.bin,summary.json}`

The summaries are convenience projections; the `.bin` files and `exit.txt` are
the baseline records. No source, model, receipt, telemetry, or network effect
was used.

### Hypotheses not triggered and scope exclusions

The depth fixture initially used 2,200 nested arrays and completed successfully;
the reproducer was corrected to a linear 200,000-object depth after direct
stdlib probing established the reachable threshold on the installed Python
3.14. This is evidence for the exception path, not a reason to add an
interpreter-dependent depth limit. No custom scanner, integer hook, parser
replacement, per-value limit, incremental decoder, quarantine ledger, or new
dependency is justified. Byte acquisition and output-cap races are not new
defects: `read_snapshot` in `scripts/evidence_index.py:72-137` already performs
bounded descriptor acquisition and stability checks, and `usage_report.py:574-579`
encodes the complete report before cap checking/writing.

The synthetic runner does not combine malformed cases into one accepted report:
each malformed boundary is independently refused, while the valid control is
independently checked. This avoids turning refusal into partial-success or
changing duplicate/overlap semantics. Combinations and threshold claims remain
future test detail, not current evidence.

## Existing safeguards and sibling comparison

1. `usage_report.py:46-60` already centralizes UTF-8 decode, duplicate-key
   rejection, and nonstandard-constant rejection, but only wraps
   `UnicodeDecodeError`, `JSONDecodeError`, and its own `UsageError`.
2. `parse_manifest` bounds the manifest (`:71-91`), and `build_report` reuses
   one bounded snapshot per canonical path, enforces 64-source/64 MiB/200,000
   record limits, and preserves duplicate-source/identity rules (`:384-445`).
3. Token validation deliberately preserves unknowns rather than converting them
   to zero (`:132-167`, `:345-381`); report grouping, slices, diagnostics, and
   pricing are downstream of the decode seam (`:443-528`).
4. `main` encodes before `sys.stdout.buffer.write` and checks the output cap
   (`:559-580`), so the surrogate failure has empty stdout and needs a refusal,
   not a replacement renderer.
5. The nearby hardened sibling `scripts/evidence_index.py:151-175` catches
   `ValueError`, `RecursionError`, and `MemoryError` around `json.loads`, while
   `:632-659` emits bounded UTF-8-safe diagnostics. `scripts/worker_models.py:53-64`
   likewise converts `JSONDecodeError`, `RecursionError`, and `ValueError` into
   its domain error. These are comparison evidence for the missing boundary,
   not permission to copy their schemas or output representation.
6. Existing public tests establish the accounting and refusal contracts in
   `tests/test_usage_report.py:74-101,103-150,152-232,270-387`; sibling tests
   establish bounded parser diagnostics and deliberate surrogate handling in
   `tests/test_parser_bounds.py:77-90`, `tests/test_diagnostic_utf8.py:60-71`,
   and `tests/test_surrogate_output.py:125-214`.

## Exact future route

The implementation slice is bounded, decisively checkable work for the coding
`bulk` role: **gpt-5.6-luna / max** (literal pair, fresh native context). Use
`gpt-5.6-sol / medium` only for a separately needed judgment/diagnosis or
discriminating test-design decision; it is not required by the current evidence.
No model probe, fallback, route substitution, or global setting change is
authorized by this design.

## One coherent implementation slice (future authorized attempt)

### 1. Add public-CLI regressions first

In a new writable implementation attempt, extend the existing
`tests/test_usage_report.py` (or a narrowly named adjacent usage-report test)
with subprocess cases using temporary files and `capture_output=True,
timeout=5`. Generate each fixture as bytes so escaped surrogates and the
5,000-digit integer are deterministic. Assert for `depth` and `huge-int`:
exit `2`, empty stdout, one bounded UTF-8 stderr line, no `Traceback`, and the
existing `usage report refused:` prefix. Assert for `surrogate`: the same
controlled refusal and empty stdout, with no identity-substituting success
JSON. Keep `valid-control` exact totals/identity and retain the existing tests
for unknowns, duplicate observations, overlap refusal, standard-short/long
pricing, CLI choices, and output caps.

These tests are deterministic boundary regressions, not a prose-check harness.
They must not assert a particular Python stack message or hard-code a parser
limit; they assert the stable refusal class and preserved valid behavior.

### 2. Repair only the two demonstrated seams

In `scripts/usage_report.py`:

- Keep `load_json` as the existing ownership seam. Around only the
  `json.loads(...)` call, add handlers for the observed `RecursionError` and
  `ValueError` cases. Convert them to `UsageError` with stable, bounded
  messages (for example, “JSON nesting is too deep” and “JSON value could not
  be decoded”) while retaining the current `invalid <label>:` prefix and line
  context. Do not catch broad exceptions around `rows`, `build_report`, or
  aggregation; unrelated programming defects must still surface during
  development. Do not report the giant integer or raw exception text.
- Extend the final `main` refusal boundary with a dedicated
  `UnicodeEncodeError` branch for the complete-report UTF-8 encode. Emit one
  constant ASCII diagnostic using the existing `usage report refused:` prefix
  and return `2`. Leave successful `ensure_ascii=False` report generation
  untouched. The exception branch must run before any stdout write (already
  guaranteed by the existing encode-then-write order), so refusal is atomic
  with empty stdout.
- Keep ordinary `UsageError`/`OSError` behavior and output-cap semantics intact.
  Do not backslash-replace or otherwise sanitize a successful report: that
  would change decoded identity and violate the lossless-output requirement.
  Keep any new diagnostic static or explicitly bounded/redacted; never include
  receipt payloads or raw exception content.

A shared new parser, scanner, numeric policy, incident schema, or fallback-write
machinery is deliberately out of this slice. A tiny failure-only emitter is
acceptable only if it is mechanically no broader than the current `main`
branch and its byte-level ASCII behavior is covered; otherwise direct static
branches are simpler and preferred.

### 3. Focused verification, then repository checks

Run every command with `PYTHONDONTWRITEBYTECODE=1` and a real outer deadline;
child test subprocesses retain the five-second timeout. The implementation
worker must preserve each native result and inspect stdout, stderr, and exit
separately:

```sh
# focused usage-report contract
PYTHONDONTWRITEBYTECODE=1 timeout 60s python3 -B -m unittest \
  discover -s tests -p 'test_usage_report.py' -v

# affected sibling boundary tests
PYTHONDONTWRITEBYTECODE=1 timeout 60s python3 -B -m unittest \
  discover -s tests -p 'test_parser_bounds.py' -v
PYTHONDONTWRITEBYTECODE=1 timeout 60s python3 -B -m unittest \
  discover -s tests -p 'test_diagnostic_utf8.py' -v
PYTHONDONTWRITEBYTECODE=1 timeout 60s python3 -B -m unittest \
  discover -s tests -p 'test_surrogate_output.py' -v

# packaging contract, required 15-second stage bound
PYTHONDONTWRITEBYTECODE=1 timeout 15s python3 -B -m unittest \
  discover -s packaging -p 'test_*.py' -v

# complete offline suite, required 60-second bound
PYTHONDONTWRITEBYTECODE=1 timeout 60s python3 -B -m unittest \
  discover -s tests -p 'test_*.py' -v
```

The focused acceptance assertions are: valid non-ASCII output remains valid
UTF-8 and decodes to the same totals/identity; valid unknown fields retain
unknown counts; duplicate and overlap/refusal rules remain unchanged; dated
pricing and CLI/schema fields remain unchanged; malformed UTF-8/JSON continues
to refuse; depth and huge integers refuse with no traceback; surrogate-bearing
success reports refuse rather than substitute; all refusal stdout is empty; all
new diagnostics are bounded, UTF-8/ASCII-safe, contain no receipt payload,
and do not reveal a traceback. Packaging must remain install-free and
model/network-free. No source test/build was run in this design-only attempt;
those commands belong to the future writable implementation assignment.

## Ownership, effects, recovery, and acceptance

The future implementation worker owns only `scripts/usage_report.py` and the
focused usage-report tests, with its immutable report and command logs. It must
stop before changing `evidence_index.py`, worker-model routing, packaging
behavior, public schemas, or output identity semantics. Effects are limited to
new test temporary directories and local test output; no receipt writes,
telemetry, model calls, network, installation, release, or global settings.

If a regression exposes a valid-input behavior change, an output identity
ambiguity, or a need for a new limit/representation, stop with
`DECISION_REQUIRED`; do not broaden the slice. If the same failure recurs after
an informed repair, stop rather than blindly retrying. A 15-minute no-action
recovery may reconcile the current child/report once, followed by at most one
five-minute challenge; it does not authorize replay or a new route. Acceptance
requires the parent to inspect the final diff, all focused and shared command
receipts, source/package scope, and the no-traceback/empty-stdout/privacy
assertions before recording a new adoption/acceptance. This design itself
authorizes no source edit, test run, release, or install.

## Recommendation

Proceed with the one-slice exception conversion plus output refusal only after a
new adoption on an independent writable checkout. The three crashes are real
and share a narrow ownership boundary; the existing accounting and acquisition
machinery is already sufficient. Do not claim this small robustness repair is a
material orchestration/token win until independent evidence measures one.
