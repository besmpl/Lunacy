# ADHD — cycle20 usage-report boundary hardening

## Brief

Problem: make the offline `usage_report.py` public CLI refuse malformed or
unencodable boundary inputs instead of leaking a traceback, while preserving
valid accounting, identity, overlap, pricing, and output semantics. Reframe:
attack the parser/output edges first; do not invent a scanner, limits, ledger,
or policy change before a real reproduction.

## Wide set — full 30

The five isolated Luna/max breadth outputs are represented exactly by their
stable IDs. Scores are the prescribed weighted scores (`N .35 + V .40 + F
.25`); `TRAP` records the score-stage trap, not a new judgment.

### Parser boundary

- **regulator-1** — Preflight JSON with a bounded scanner and phase-tagged refusal. **[N4 V4 F7 | 4.75]** TRAP: custom scanner duplicates the parser and creates lexical-correctness burden.
- **regulator-2** — Turn oversized-integer failures into a field/digit-count refusal. **[N3 V6 F8 | 5.45]** TRAP: field-path/digit reporting needs extra parsing; fixed refusal is simpler.
- **attacker-2** — Convert stdlib decoder `RecursionError` from deeply nested JSON into the existing `UsageError` path. **[N3 V10 F10 | 7.55]**
- **attacker-3** — Guard an integer token beyond Python’s digit limit with a bounded diagnostic. **[N3 V6 F8 | 5.45]** TRAP: custom numeric hooks/limits need evidence beyond narrow exception conversion.
- **oncall-1** — Install a parser fuse for excessive nesting and integer digit bombs. **[N3 V5 F8 | 5.05]** TRAP: a fuse implies a new limit/scanner rather than existing refusal.
- **oncall-6** — Separate lexical safety from business aggregation. **[N4 V4 F6 | 4.50]** TRAP: a second lexical parser duplicates JSON validation.
- **budget-1** — Use a bounded integer hook before Python converts the lexeme. **[N2 V6 F8 | 5.10]** TRAP: a new digit policy may reject valid interpreter-accepted input.
- **budget-2** — Preflight braces/brackets with a depth counter. **[N2 V3 F7 | 3.65]** TRAP: a naive counter mishandles strings and escapes.
- **child-1** — Put each JSON value in a box that refuses to open past safe depth. **[N3 V4 F7 | 4.40]** TRAP: a new depth admission rule duplicates the parser.
- **child-2** — Label giant counting strings instead of holding them as numbers. **[N5 V2 F3 | 3.30]** TRAP: replacing numbers with notes changes schema and totals.
- **child-4** — Walk deep JSON iteratively with a notebook. **[N5 V2 F5 | 3.80]** TRAP: a custom iterative JSON parser is disproportionate.

### Output boundary

- **regulator-3** — Detect unpaired surrogates before serialization and refuse atomically. **[N3 V9 F10 | 7.15]**
- **attacker-1** — Inject lone surrogates so `ensure_ascii=False` crashes at stdout; handle only at the final output seam. **[N3 V6 F8 | 5.45]** TRAP: sanitizing success output can alter identity; refuse or prove lossless.
- **oncall-5** — Add a final renderer that substitutes unencodable characters. **[N3 V4 F7 | 4.40]** TRAP: blanket substitution can mask faults or alter identity.
- **budget-3** — Serialize through a UTF-8 backslash-replacing sink. **[N3 V6 F8 | 5.45]** TRAP: backslash replacement is not proven lossless for text identity.
- **budget-5** — Encode the report before reserving output capacity. **[N2 V3 F3 | 2.65]** TRAP: current code already encodes before cap/write.
- **child-5** — Swap terminal-breaking characters for escaped picture codes. **[N3 V5 F7 | 4.80]** TRAP: substitution requires lossless proof and can alter identity.

### Diagnostic boundary

- **regulator-4** — Use a fixed redacted grammar of kind, phase, reason, and offset. **[N5 V7 F9 | 6.80]**
- **oncall-2** — Route diagnostics through an ASCII-safe envelope while preserving ordinary UTF-8 success output. **[N4 V9 F9 | 7.25]**
- **oncall-4** — Use typed quarantine records carrying path, stage, and exception class. **[N5 V3 F5 | 4.20]** TRAP: a new quarantine representation is excessive for a refusing CLI.
- **budget-4** — Reduce parser diagnostics to filename plus line/column. **[N2 V7 F8 | 5.50]** TRAP: the premise that `JSONDecodeError` exposes an excerpt is unverified.

### Evidence/regression boundary

- **regulator-5** — Record each malformed fixture’s exit, stdout byte count, and diagnostic code. **[N2 V10 F9 | 6.95]**
- **attacker-6** — Combine duplicate, deep, huge-int, and surrogate records while asserting unchanged accounting. **[N4 V9 F10 | 7.50]**
- **child-3** — Give each file a bad-input basket so one receipt cannot hide others. **[N4 V2 F2 | 2.70]** TRAP: partial success hides refused sources and changes whole-report behavior.

### Resource/bounds boundary

- **regulator-6** — Record runtime-sensitive parser limits at startup. **[N5 V3 F4 | 3.95]** TRAP: adds a runtime record without solving a reachable failure.
- **attacker-4** — Bind size caps to the opened descriptor against replacement races. **[N4 V3 F4 | 3.60]** TRAP: `read_snapshot` already does this.
- **attacker-5** — Attack whitespace/escaped payload pressure just under byte caps. **[N4 V5 F6 | 4.90]** TRAP: existing finite snapshot covers the bound; no extra defect is demonstrated.
- **oncall-3** — Decode incrementally into bounded buffers. **[N3 V3 F4 | 3.25]** TRAP: existing capped snapshot makes this complexity unneeded.
- **budget-6** — Stop exactly at the first byte beyond the cap. **[N2 V3 F4 | 2.90]** TRAP: `read_snapshot` already provides this.
- **child-6** — Gate every decoded string and number with a friendly size sign. **[N3 V3 F5 | 3.50]** TRAP: per-value limits add admission policy without evidence.

## Converge

1. **attacker-2** — ★ Highest weighted non-trap and directly confirmed by the
   synthetic public CLI: narrow decoder exception conversion is simpler than a
   new depth policy.
2. **attacker-6** — Regression-corpus discipline protects valid totals and
   identity while testing all three failure classes; it is evidence machinery,
   not a product representation.
3. **oncall-2** — A bounded ASCII failure path prevents a second failure at
   stderr/output while keeping ordinary UTF-8 success semantics intact.

The selected seeds are distinct: parser exception boundary, regression proof,
and diagnostics/output boundary. They are not a claim of measured token
savings or user incidence.

### Traps rejected

The inline traps above reject custom scanners, numeric/depth admission limits,
per-source quarantine/partial-success semantics, replacement output, and
already-existing byte/output-cap machinery. No trap is converted into a fix by
score alone.

## Focus

### Focus 1 — parser exception seam

Wrap only the stdlib JSON decode call in `load_json` so confirmed parser
`RecursionError` becomes the existing controlled `UsageError` path. First
reproduce the failure through the public CLI; the change is not justified by a
hypothesis alone. If confirmed, catch only decoder exceptions and use a stable,
receipt-free message. Leave valid decoding, totals, unknown counts,
identity/overlap, dated pricing, CLI behavior, and output encoding unchanged;
`main` remains responsible for the user-visible exit path. This contains
parser-depth exhaustion without dependencies or broad refactoring.

**Load-bearing risk:** a broad `RecursionError` handler could hide an unrelated
recursion defect; the handler must surround only stdlib decoding.

**First step:** generate nested array/object JSON, invoke `usage_report.py`, and
record exit, stdout, stderr, and traceback before editing.

**Child ideas:** array and object regressions with empty stdout; a tiny private
decode helper; threshold comparison across supported Python versions; only
consider a depth precheck after evidence that exception conversion is not enough.

### Focus 2 — public-CLI adversarial corpus

Create one synthetic public-CLI corpus combining duplicates, deep JSON,
huge integers, and surrogate-bearing strings, first establishing which
failures reproduce. For valid duplicates assert totals, unknown counts, identity,
overlap, dated pricing, and schema; for invalid values assert stable refusal,
empty stdout, and receipt-free diagnostics. This separates accounting
regressions from boundary normalization and allows a truthful no-change result.

**Load-bearing risk:** a corpus that does not trigger the actual exceptions can
create false confidence; every case must record the real subprocess result.

**First step:** add focused subprocess regressions using a temporary directory
and the documented CLI, capturing exit/stdout/stderr.

**Child ideas:** threshold parameterization; surrogate positions in receipt and
diagnostic paths; duplicate permutation checks; receipt-content exclusion;
resource-cap combinations.

### Focus 3 — failure-only diagnostic seam

Add one failure-only emitter shared by `load_json` and `main`. Build a fixed
shape containing only an allowlisted stage and error code, excluding paths,
payloads, and raw exception text. Encode with `ensure_ascii=True` and write
bytes directly to stderr so surrogates or hostile stream encodings cannot cause
a second failure. Preserve `ensure_ascii=False` for successful reports and first
prove each public-CLI regression. If diagnostic writing fails, use one constant
ASCII fallback without inspecting input.

**Load-bearing risk:** including `str(exc)`, a path, or payload-derived metadata
can reintroduce Unicode failure and violate the no-content promise.

**First step:** run baseline public-CLI malformed/surrogate fixtures and retain
exact exit/stdout/stderr before implementation.

**Child ideas:** stable symbolic incident codes; centralized bounded stderr
emission; malformed UTF-8/depth/huge-int cases; ASCII failure vs valid UTF-8
success assertions.

## Provocation

Verbatim final wildcard authored by Focus 3 (`cycle20/FOCUS-3.json`):

> Could a deliberately minimal code-and-stage envelope be more operationally useful than raw exception text because it is composable, stable, and incapable of leaking receipt content?
