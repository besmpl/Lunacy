# Cycle21 source reconciliation and design

## Verdict

**No implementation is justified by the present evidence.** The cycle20
reliability work is accepted and its source is read-only for this assignment.
The three selected ADHD ideas describe capabilities that are either already
available through ordinary `unittest` and existing receipts, or would add a
new convention without showing that it removes repeated work. The observed
repairs are heterogeneous: one fixture exceeded a byte cap, one exploratory
shell probe had invalid Python syntax, one probe asserted an incidental exact
512-byte result when the implementation correctly returned a shorter
boundary-safe 508-byte diagnostic, and one scope probe mis-sliced Git output.
They do not establish a common missing runner or a product defect.

This is a finite no-change disposition, not a claim that the broader Golden
cost/coordination objective is complete. No new runner, parser, status
normalizer, capsule, ledger, monitor, mandatory stage, parent replay rule, or
assertion framework should be adopted on this record.

## Source boundary and contracts inspected

The read-only source is
`cycle20/implementation-checkout` (the accepted portability checkout's
source state). Relevant source facts:

- `tests/test_usage_report.py:33-108` already owns temporary fixture setup,
  byte writing, public CLI invocation, five-second child bounds, raw
  stdout/stderr capture, exit checks, bounded UTF-8 refusal checks, and normal
  `unittest` assertion reporting.
- The same module exposes 23 ordinary named methods at `:110-493`, including
  decoder seams (`test_decoder_failures_refuse_at_manifest_and_receipt_seams`),
  deterministic integer handling, output encoding, valid Unicode, and the
  existing accounting/overlap/pricing/native cases. A fully qualified
  `unittest` method selector is therefore an existing runner capability, not
  a missing product seam.
- `scripts/usage_report.py:42-60` already renders bounded refusal bytes and
  `:68-86` owns JSON decoding exceptions. Its final output boundary at
  `:585-615` encodes before writing, refuses unencodable output, and returns
  the controlled status. There is no evidence that a new verification runner
  would improve this product path.
- `orchestrator/USAGE-METRICS.md:3-7,30-36,86-94` documents a read-only,
  standard-library CLI and its real command. It explicitly describes byte
  caps, selected receipts, hashes/line pointers rather than payloads, and
  disclaims route verification, quality comparison, and savings claims.
- `packaging/build_plugin.py` is an artifact copier/metadata preflight. It
  validates selected files and directories and copies them; it does not own
  arbitrary test commands or Git-status interpretation. The inversion-3 idea
  is therefore out of ownership scope.
- Existing guidance is already explicit: `orchestrator/IMPROVEMENT.md:307-324`
  calls for small evidence-based feedback, improving an ambiguous instruction
  rather than adding a rule for each correction, and forbids a checker,
  report-validation pass, ledger, runtime, retry, or test waiver. The shared
  acceptance contract in `WORKSPACE.md:52-62` requires applicable evidence,
  independent parent acceptance, and no unconditional replay merely because a
  verifier differs.

The accepted cycle20 worker and portability reports also record the helper's
and test's final hashes, complete test/package results, and retained failed
receipts. Those reports are evidence of cycle20 correctness and custody; they
are not evidence of reduced orchestration cost.

## Reconciliation of the disclosed failures

| Observation | Evidence and actual owner | Classification | Reusable seam? |
| --- | --- | --- | --- |
| Initial manifest fixture exceeded the existing 1 MiB cap | `cycle20/implementation/logs/pre-fix/usage-report-regressions.stderr.log` records refusal as `manifest exceeds 1048576-byte cap` rather than the intended deep-JSON message; implementation report says the oversized object fixture was corrected before v2. | Test fixture construction/contract misunderstanding. The cap is bytes, not entries or nesting depth. | No. A runner cannot make an oversized fixture represent a different contract. |
| Deep/huge-int/surrogate pre-fix failures | `cycle20/implementation/logs/pre-fix/usage-report-regressions-v2.stderr.log` records five expected test failures with exit 1/tracebacks; the accepted helper repaired decoder and final encoding seams. | Real product boundary defect, already fixed and accepted in cycle20. | No new cycle21 seam. Existing named regressions and raw receipts cover it. |
| Exploratory fixture-truncation probe had a heredoc syntax error | `cycle20/portability/logs/fixture-truncation-observation.log` contains only the Python `SyntaxError`; the corrected observation is separately retained in `fixture-truncation-observation-final.log`. | Command assembly error in an ad-hoc probe, not a test or product failure. | No. Existing focused test already invokes the CLI through a finite subprocess. |
| Exploratory probe expected exactly 512 bytes | `cycle20/portability/logs/fixture-truncation-observation-corrected.log` records exit 1 from that assertion; final observation records diagnostic floor 566 and actual bounded refusal 508 bytes. The implementation preserves UTF-8 boundaries. | Incorrect probe oracle. 512 is the cap, not an exact output length; 508 is a valid consequence of boundary-safe truncation. | No. A fixed metadata value or two-case pair would risk encoding an incidental result. |
| Scope probe reported unexpected tracked paths | `cycle20/portability/logs/scope-review.log` records a failed expectation; `scope-review-corrected.log` shows the accepted carried-forward guidance and the two owned source/test files, then SCOPE PASS. | Scope-check script misclassified known carried-forward changes; Git probe was not product behavior. | No. A status parser would add ceremony and still need the correct expected scope. |

The failures therefore have at least four distinct owners (fixture
semantics, command syntax, assertion oracle, and scope bookkeeping), plus the
already-closed cycle20 product defect. The common factor is informal
verification activity, not a demonstrated code-level abstraction. Existing
worker guidance already assigns raw command exits, repair ownership, bounded
processes, and independent acceptance; cycle20's reports show those rules
were eventually usable. They do not show that a new artifact would improve
compliance.

## Candidate decision

### Selected `budget-5`: reject as already available

A qualified method selector is already a normal `unittest` feature, and the
module has named methods for every accepted cycle20 regression. The stable
selector can be used directly when a worker has a genuine localized failure.
Adding a new “only rerun token” rule would turn an existing capability into
mandatory ceremony, and “acceptance replays the same selector” conflicts with
the source acceptance contract: independent acceptance is conditional on
applicable evidence, not an unconditional duplicate run.

### Selected `inversion-1`: reject as unproven protocol

The source does not maintain a canonical argv plus fixture-state vector for
all methods. A printed shell-safe command could omit the temporary directory,
interpreter/environment, or setup assumptions; it could become a new public
output convention whose own quoting needs tests. The heredoc error was from an
exploratory script, not from the maintained unittest entry point. Existing
failure output, method names, and raw command receipts are sufficient when a
rerun is actually authorized.

### Selected `budget-1`: reject as broad convention; allow local ordinary repair

Unit-bearing messages may be useful where a maintained assertion genuinely
mixes entries, bytes, or records. However, the disclosed exact-512 and
manifest-cap failures were wrong expectations/fixtures, not merely unlabeled
numbers; the Git slice was incidental. No repeated ambiguous assertion seam
was found in the read-only source. A future worker may improve one message as
ordinary pre-FINAL repair only if source evidence identifies that exact
ambiguity, without adding a helper or changing the comparison.

All other proposals are rejected for the recorded traps: retained receipts
already provide evidence; capsules duplicate reports; metadata can make the
oracle tautological; test temp lifecycle already exists; packaging does not
own Git/test orchestration; and monitors, ledgers, parsers, replay, and proof
locks add state or authority. The child ideas' agreement/representation
signals cannot establish correctness.

## Roadmap and revisit trigger

There is no source-edit roadmap for this cycle. The smallest defensible future
route is evidence-gated and reuses current seams:

1. **Observe one naturally occurring repeat.** In an ordinary future Golden
   task, retain the existing raw command result and report fields already
   named by `IMPROVEMENT.md:307` (time to accepted output, first-pass
   acceptance, defects caught, repair burden). Record whether the applicable
   command and test selector were already available and followed. Do not add
   a runner or synthetic replay merely to produce this measurement.
2. **Classify before designing.** If the repeat is another fixture/oracle,
   syntax, scope, or noncompliance incident, repair that owner locally and
   close the issue. If the same maintained assertion or invocation boundary
   repeatedly causes reconstruction despite compliant use of the existing
   method selector and receipts, then source-check that common seam.
3. **Prefer deletion/reuse.** A future adopted slice should first use the
   existing fully qualified selector, unittest output, and raw report logs.
   Only a narrowly local unit-bearing message change is eligible without a
   new protocol; a command emitter or metadata convention requires evidence
   that setup can be represented losslessly and that total complexity falls.
4. **Re-adopt only on material evidence.** Any source edit needs a fresh
   adoption and independent writable surface. Preserve all required tests,
   raw exits, finite subprocess bounds, offline standard-library operation,
   worker ownership, and parent acceptance. If no repeated common seam is
   demonstrated, remain idle rather than converting this roadmap into policy.

## Effects, checks, and limits

This assignment is source-read-only. No product tests, packaging tests,
synthetic runner, build, network, model, telemetry, install, configuration,
release, or Git effect was performed. The relevant retained logs were read;
cycle20's final reports and receipts were not rewritten or rerun. Source
checks for this design are limited to inspection of the paths and line ranges
cited above. This document does not claim Linux execution, reduced turns,
token savings, or a behavioral change.

## Source-only self-review

I reread this design against the complete 30-score rendering, the three focus
outputs and Focus-3 wildcard, the authoritative oncall response, and the
cycle20 implementation/portability reports plus failed receipts. The verdict
keeps the original malformed oncall proposal separate from its authoritative
response, does not promote incidental Git or exact-512 observations into
contracts, does not require parent replay/repair, and does not assign coding
work. Every proposed future action remains conditional on new evidence and a
fresh adoption.
