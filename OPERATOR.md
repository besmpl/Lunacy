# Lunacy operator guide

## Release status

This repository is Lunacy native `0.2.0-rc.1`, using workflow contract `0.1.29`.
It is a guidance release candidate with optional read-only evidence and
[worker-model selection](orchestrator/WORKER-MODELS.md) helpers. Offline
validation does not prove installation, route availability, model behavior,
live reliability, speed, cost, or savings.

## Large-output command reference

For a potentially large-output command, first choose a new, exact assignment-owned `LOG_PATH` (inside an already owned directory) and use this small shell pattern as `args.cmd`; replace only `YOUR_FINITE_COMMAND` with a command that has its own real finite bound:

```sh
log=${LOG_PATH:?set LOG_PATH to a new assignment-owned log}
set +e
if [ -e "$log" ] || [ -L "$log" ]; then
  printf 'LOG_OPEN_EXIT=73 LOG_PATH=%s\n' "$log" >&2
  exit 73
fi
capture_opened=0
set -C
{
  set +C
  capture_opened=1
  ( YOUR_FINITE_COMMAND ) >&3 2>&1
  producer_rc=$?
  printf 'PRODUCER_EXIT=%s\n' "$producer_rc"
  printf '%s\n' '--- LOG TAIL (at most 16384 bytes) ---'
  tail -c 16384 -- "$log"
  view_rc=$?
  printf '\nVIEW_EXIT=%s LOG_PATH=%s\n' "$view_rc" "$log"
  final_rc=$view_rc
  if [ "$producer_rc" -ne 0 ]; then
    final_rc=$producer_rc
  fi
  (exit "$final_rc")
} 3>"$log"
run_rc=$?
set +C
if [ "$capture_opened" -ne 1 ]; then
  printf 'LOG_OPEN_EXIT=%s LOG_PATH=%s\n' "$run_rc" "$log" >&2
fi
exit "$run_rc"
```

Invoke it without reconstructing the result:

```javascript
// An authorized execution deadline must bound the underlying command,
// including log setup and viewing. Timing out this await is not cancellation;
// yield_time_ms is only receipt timing, not that deadline.
const r = await tools.exec_command({
  cmd: shellPattern,
  workdir: exactWorkdir,
  shell: "/bin/sh",
  login: false,
  yield_time_ms: 10000,
  max_output_tokens: 5000,
});
text(r);
```

The precheck rejects any existing path or symlink—including a regular file, directory, FIFO, special target, or dangling symlink—before redirection; noclobber remains active at actual creation to reject an ordinary collision after that check. Either refusal is a visible `LOG_OPEN_EXIT`, and the producer does not run. This assumes the chosen output namespace is exclusively owned: the precheck does not defend against hostile concurrent path replacement and provides no transactional filesystem safety. The producer runs in a subshell so its `exit`, shell options, and local variable changes cannot bypass bookkeeping or replace the wrapper's log pointer. The already-authorized enclosing operation needs a real finite deadline covering precheck, log establishment, producer, and view; a producer-only timer and `yield_time_ms` do not bound pre- or post-producer blocking, and `exec_command` has no timeout parameter. The log starts at execution and is **PARTIAL** while a returned native `session_id` is live. Keep every native result, then resume that exact handle with `write_stdin` until its terminal result before calling the output settled. The tail is an independent bounded view; `PRODUCER_EXIT`, `VIEW_EXIT`, and the native exit keep producer, view, and tool outcomes distinguishable, and a successful view cannot mask producer failure. Do not use `tee` or pipeline success as producer proof. Review enough of the retained log and relevant source to cover the actual decision—including diagnostics outside the first excerpt—but do not dump a full large log by default. Return the exact `LOG_PATH`. Logging preserves captured stdout/stderr only: it does not prove successful writes, semantic success, descendants or broader effects settled, or cost/cache savings.

A huge single-line or JSONL record is not bounded by its line count. Bound the
bytes read and displayed, disclose omitted bytes, and retain the exact raw
`LOG_PATH`. For one inspection operation, cap the combined preview rather than
an unlimited number of per-file excerpts; keep bounded I/O distinct from
bounded display. Fixed labels, diagnostics, and path text are separate from
the 16,384-byte tail when claiming a total output bound. A byte slice may split
UTF-8; do not promise valid UTF-8 unless that behavior is implemented and
tested. A cap does not waive a named additional bounded read for a material
diagnostic.


## Optional evidence-index helper

For a named command fact, first reuse adequate structured evidence already delivered; when necessary, a purpose-built task or turn read may avoid acquiring a full capture. Treat this as an optional retrieval shortcut, not a mandatory preliminary stage, guaranteed host capability, new required schema, or dependency on a literal tool name. Bind retained evidence to the exact task, turn, command or item ID, and matching command; follow supplied pagination only as needed, preserve returned fields with source attribution, and disclose truncation or missing fields. Use the existing capture route whenever stronger adopted claims require information or completeness absent from this view. Structured command, status, exit, and identifier fields support only those recorded facts: later application records do not recover original execution returns or prove complete output, descendants, effects, semantic acceptance, custody, or backend state. Missing retrieval never authorizes replay, invented values, raised caps, omitted required proof, or unsupported substitution of prose summaries for required structured evidence.

Use the helper only for an already captured, authorized native JSONL file:

```text
python3 scripts/evidence_index.py /absolute/path/events.jsonl [--source-format app-server|session-receipt] --thread-id EXACT [--session-id EXACT] --turn-id EXACT [--item-id EXACT ...] [--expected-sha256 LOWERCASE_SHA256] [--output-cap BYTES]
python3 scripts/evidence_index.py /absolute/path/events.jsonl --source-format direct-exec --thread-id EXACT [--item-id EXACT ...] [--expected-sha256 LOWERCASE_SHA256] [--output-cap BYTES]
```

Input must be an absolute regular UTF-8 JSONL file no larger than 64 MiB with complete LF records. The helper opens nonblocking, verifies the descriptor, and hashes one bounded snapshot. This nonblocking filesystem capability is also required by offline readers: an exported catalog avoids live collection, not the offline reader's host prerequisites. If `os.O_NONBLOCK` is unavailable, refuse through the bounded diagnostic rather than substitute blocking I/O or claim broad portable support. Output caps are 256 through 1,048,576 bytes, default 8192. After arguments validate, runtime diagnostics honor the requested cap and 512-byte diagnostic ceiling. Argument parsing and validation errors instead use the minimum supported 256-byte allowance because no supplied cap is trusted before complete validation, and omit usage boilerplate; `--help` still exits successfully with ordinary help. All error diagnostics preserve valid UTF-8 by dropping only an incomplete final code point when truncated and end in one LF. App-server serialization preserves ordinary UTF-8 and losslessly backslash-escapes exceptional lone surrogates only at final encoding; the cap measures those final emitted bytes including the newline. Session serialization remains ASCII. `app-server` is the default and retains the existing received-event lifecycle semantics. Selection is explicit: there is no format auto-detection, fallback, or join to a second capture.

Locators apply only to the reported source hash. `observed_zero`, `observed_nonzero`, `observed_declined`, `missing_terminal`, and `incomplete_evidence` describe native command records, not inner shell steps or acceptance. `observed_declined` requires an explicit received declined terminal with a present null `exitCode`; absent or nonnull is refused. The helper never parses prose as authority, writes files, uses network, starts models/processes, creates captures, validates reports, settles custody, or gates acceptance. Success means only a valid projection. Missing capture never authorizes an exporter or omitted proof; unsupported required host formats are the trigger to replace this narrow helper.

For `session-receipt`, one exact `session_meta` must bind `id` to the requested thread. By default, its `session_id` must also equal that thread; the optional explicit `--session-id` instead requires exact equality to that separate nonempty value and is rejected for `app-server`. Opt-in output adds `recorded_session_id` inside `session`, sourced from the validated metadata. This records an association only: it does not infer ancestry, backend identity, or custody, and it never substitutes for command `thread_id`. An exact matching `turn_context` supplies nonempty recorded model/effort on a source-associated basis. Command evidence comes only from explicit same-thread/same-turn `event_msg` / `item_completed` / `CommandExecution` completions; starts are neither required nor synthesized. Identical matching contexts or completions deduplicate, while identity conflicts, malformed purported commands, conflicting duplicates, or missing requested items refuse atomically. Other well-identified turns may coexist. The `session-receipt` selector does not support turnless direct-exec stdout and never joins it to session evidence; use the separate explicit `direct-exec` format only for its supported envelope.

The session projection allowlist contains only the source path/hash, requested scope, metadata/context physical LF lines, recorded model/effort, the validated recorded session ID only under explicit `--session-id`, and each completion's physical LF line, item ID, raw status, and integer-or-null exit code. Command arguments, cwd, output, prompts, reasoning, encrypted content, arbitrary extras, and generated report text are never displayed. Counts cover captured matching completions only. Raw status/exit facts imply no lifecycle consistency, semantic verdict, completeness beyond the capture, route/backend truth, deadline correctness, custody, or acceptance.

`direct-exec` is a separate opt-in projection for one unambiguous, turn-ID-free
direct-exec snapshot. `--turn-id` and `--session-id` are forbidden. The first
record must be the one matching `thread.started` header; exactly one later
`turn.started` and at most one later `turn.completed` or `turn.failed` delimit
the observed scope. Unknown top-level events, repeated or competing boundaries,
top-level `turn_id`, foreign explicit thread identity, and command observations
outside that scope refuse. The complete file is validated before filtering.
Direct-exec JSON integers are limited to 4096 digits and decoded JSON values to
512 levels below the top-level record; larger values refuse through the bounded
diagnostic. Command item IDs and native statuses are each limited to 4096
characters.

Within that narrow envelope, every `item.started`, `item.updated`, and
`item.completed` command occurrence is retained in source order and grouped by
its exact item ID. Duplicate and conflicting statuses or exits, missing exits,
explicit null exits, unmatched starts, and unmatched terminals remain literal
observations; the helper does not pair, deduplicate, repair, classify, or infer a
lifecycle. Known non-command items and `error` events contribute only to an
ignored-record count. Output allowlists source path/hash, requested thread and
filters, boundary lines/kinds, counts, item IDs, event kinds, raw statuses, and
integer-or-null exit metadata including whether the exit field was present. It
never exports commands, output, cwd, prompts, reasoning, messages, errors,
usage, arbitrary metadata, or model/effort. Grouping proves only decoded item-ID
equality in this snapshot and establishes none of acceptance, routing, custody,
effects, retry safety, semantic success, or capture completeness.
