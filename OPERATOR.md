# Lunacy operator guide

## Release status

This repository is Lunacy native `0.2.0-rc.1`, using workflow contract `0.1.29`.
It is a guidance release candidate with an optional one-shot local command
runner, read-only evidence, and [worker-model selection](orchestrator/WORKER-MODELS.md)
helpers. Offline
validation does not prove installation, route availability, model behavior,
live reliability, speed, cost, or savings.

## Optional launch-wave diagnostic

When exact assignment names are known to be ready together and host room was
observed, check the parent's actual native call order without starting agents:

```text
python3 -B scripts/dispatch_trace.py --session /absolute/path/parent-rollout.jsonl --ready-names worker_a worker_b worker_c
```

Exit `0` means every named spawn call occurred before the first observed wait
after the selected wave starts, with no tool call between selected launch
calls; post-wave calls before that wait are allowed. Exit `1` reports missing
selected launches, a tool call between launches, a wait before the wave is
complete, or no observed wait after the wave starts; exit `2` refuses invalid
input. For a task-local cap smaller than the total stage, check each
known-ready cap-sized wave separately. The caller must establish readiness and
room independently. This diagnostic neither dispatches nor proves overlap,
model routing, host capacity, or worker results. The source log may contain
private prompts; its arguments are not printed by this tool.

<a id="large-output-command-reference"></a>
## Large-output command contract

Before a potentially large-output producer, choose an assignment-owned log, a
real finite deadline, and one capture path. Inspect command, termination, and
capture facts separately; retain the exact raw output as required; disclose
caps, omissions, partial or incomplete capture, and unreaped observations.
Never infer descendant or broader-effect settlement, semantic success,
route/model behavior, or acceptance from a helper or view exit alone.

A huge single-line or JSONL record is not bounded by its line count. Bound the
bytes read and displayed, disclose omitted bytes, and retain the exact raw
`LOG_PATH`. For one inspection operation, cap the combined preview rather than
an unlimited number of per-file excerpts; keep bounded I/O distinct from
bounded display. Fixed labels, diagnostics, and path text are separate from
the 16,384-byte tail when claiming a total output bound. A byte slice may split
UTF-8; do not promise valid UTF-8 unless that behavior is implemented and
tested. A cap does not waive a named additional bounded read for a material
diagnostic.

Choose one applicable recipe: the
[optional POSIX command runner](#optional-posix-command-runner) or the
[bounded shell fallback](#bounded-shell-fallback). These are conditional recipe
reads, not recursive acquisition or authority.

## Optional POSIX command runner

For one caller-authorized local command on a POSIX host, the optional helper can
provide the actual subprocess deadline as well as bounded capture:

```text
python3 -B scripts/run_command.py \
  --cwd /absolute/owned/workdir \
  --log /absolute/owned/new-run.log \
  --deadline-seconds 30 \
  [--term-grace-seconds 2] \
  [--capture-limit 1048576] \
  [--tail-bytes 16384] \
  [--preview-bytes 16384] \
  [--stdin-file /absolute/owned/input.bin [--stdin-limit 1048576]] \
  -- executable arg1 arg2 ...
```

To keep machine-readable stdout separate from diagnostics, replace `--log`
with the opt-in pair below. The forms are mutually exclusive and neither split
path may be omitted:

```text
python3 -B scripts/run_command.py \
  --cwd /absolute/owned/workdir \
  --stdout-log /absolute/owned/new-stdout.log \
  --stderr-log /absolute/owned/new-stderr.log \
  --deadline-seconds 30 \
  [--capture-limit 1048576] \
  [--stdout-capture-bytes 524288] \
  [--tail-bytes 16384] [--preview-bytes 16384] \
  [--stdin-file /absolute/owned/input.bin [--stdin-limit 1048576]] \
  -- executable arg1 arg2 ...
```

`--deadline-seconds` is 1 through 86,400. `--term-grace-seconds` is 0
through 30 (default 2). `--capture-limit` is 1,024 through 64 MiB (default
1 MiB); `--tail-bytes` is 0 through that capture limit (default 16 KiB), and
`--preview-bytes` is 0 through 16 KiB (default 16 KiB). One argument is at
most 4,096 characters and the combined UTF-8 argv is at most 64 KiB. Run
`python3 -B scripts/run_command.py --help` without a command for option help.
`--stdin-file` optionally supplies one pre-spawn snapshot of an absolute regular
file as the child's raw stdin. `--stdin-limit` is 0 through 64 MiB (default
1 MiB) and is valid only with `--stdin-file`; the limit and counts are bytes,
not characters.

In split mode `--capture-limit` remains one total retained-byte ceiling. By
default stdout receives its floor half and stderr the remainder;
`--stdout-capture-bytes` can instead reserve 1 through `capture-limit - 1`
bytes for stdout, leaving the rest for stderr. The fixed reservations never
borrow. `--tail-bytes` applies independently but must fit both reservations;
lower it (often to zero) with small partitions. `--preview-bytes` caps the raw
source slice for each stream separately and remains outside the capture ledger.
Each preview is UTF-8 with replacement and is not the structured payload.

| Helper exit | Meaning |
| --- | --- |
| `0` | Direct child exited 0 naturally, was reaped, and capture is complete/exact with EOF. |
| `1` | Child failed or was signalled, deadline/cancellation occurred, or capture was truncated, incomplete, or failed. |
| `2` | Usage/host/path refusal or spawn/post-spawn setup failure. |
| `3` | Unexpected internal failure after setup; any successfully spawned direct child still receives bounded cleanup/observation and a JSON result when serialization remains possible. |

The helper passes the argv directly without a shell, creates one new process
group, and prints exactly one JSON result after a successful spawn. The
default form merges stdout/stderr unchanged. Split mode uses two pipes and
rotates bounded service between ready channels while preserving the same
deadline, stdin, and cancellation referee. It sends TERM at cancellation or deadline, honors the full
configured grace, and sends KILL only while the direct parent is still
unreaped. Parent observation and pipe drain are finite; `unreaped`, `unknown`,
or `capture.status=incomplete` are truthful terminal observations, not claims
that descendants or effects settled. A child can escape the group or retain an
output descriptor. The helper is not a workflow/model launcher, daemon,
sandbox, authority resolver, retry policy, or process-tree supervisor.

When `--stdin-file` is present, the helper opens the leaf without following a
symlink, requires a regular file in a caller-owned namespace, and acquires one
bounded raw-byte snapshot before log creation and child spawn. FIFO, directory,
device, missing/unreadable leaf, cap overflow, or an observed metadata change
during the read is a bounded refusal with no child or log. This detects some
changes but is not an atomic filesystem snapshot and does not protect against
hostile ancestor replacement; the command deadline begins after acquisition and
therefore does not bound filesystem latency.

The snapshot is delivered through the child's ordinary stdin by bounded
nonblocking writes interleaved with output capture and supervision. A present
empty snapshot still sends EOF. The result adds `input.status`,
`bytes_acquired`, `bytes_written`, and `eof_sent`; omitted input preserves the
old result shape and uses `DEVNULL`. `bytes_written` means only that the parent
write was accepted by the kernel, and `eof_sent` means only that the parent
closed its pipe after all bytes were accepted. Neither proves child consumption,
parsing, retention, or semantic use. The input object contains no source path,
payload, digest, preview, or input cap, although an authorized child can echo
its input into the ordinary output capture. This offline helper makes no claim
that any installed CLI accepts stdin, a particular prompt form, model, or route.

Every new absolute log path is opened exclusively with mode `0600`. Split
paths must be lexically distinct after normalization, have existing real
parents, and not name any existing node or symlink. Both reservations happen
before spawn. If the second exclusive open loses a race, the first empty owned
reservation is deliberately retained; no child runs and no rollback deletion
is attempted. This assumes a caller-owned namespace and does not protect
against hostile ancestor or parent replacement. Capture is
buffered in memory and assembled at finalization, so an existing empty or
partial path while the helper runs is not durable-capture evidence. Exact
captures preserve arbitrary raw bytes. Lossy head/tail captures contain an
ASCII truncation marker and report exact observed/dropped byte counts with
`log_is_exact_raw=false`; the separately byte-capped preview is always a valid
JSON Unicode string decoded with UTF-8 replacement. The deadline governs child
supervision, not arbitrary blocked filesystem operations. Inspect the result's
separate command, termination, and capture facts rather than treating the
helper exit alone as semantic acceptance.

The result line is compact JSON emitted as deterministic UTF-8 bytes followed
by one LF. Ordinary Unicode is preserved in its UTF-8 form; exceptional Python
code points that UTF-8 cannot encode are backslash-escaped only at the final
byte boundary. This makes the receipt independent of the parent text encoding,
but does not change raw command logs or the child's inherited environment. A
caught stdout write or flush failure remains exit 3 and may have exposed a
partial or complete JSON line; there is no replay, downstream-delivery promise,
empty-output guarantee, or universal claim about interpreter shutdown.

Split results set `log_path` to null, add `log_paths`, and report aggregate
`capture` totals plus independent `capture.streams.stdout` and `.stderr`
status, EOF, observed/retained/dropped/log byte counts, exactness, preview, and
stream-local read/write errors. Status precedence is `write_error`,
`read_error`, `incomplete`, `truncated`, then `complete`; aggregate status is
the worse stream and aggregate EOF requires both. Parse stdout only when its
stream is `complete`, `eof=true`, and `log_is_exact_raw=true`, then still judge
the parsed value, direct command, and termination facts separately. A started
process without observed EOF is never exact. A split spawn failure retains two
empty exact files with `eof=true` only as the inherited vacuous no-child
convention, not as an observed producer EOF. A stream read failure does not
stop its sibling, and finalization attempts both logs even if one write fails.
After direct-parent reap, a descendant-held descriptor receives only the same
finite drain window and is reported `incomplete`; it is not descendant custody.

The script refuses unsupported hosts, non-absolute paths, aliases, existing or
symlink log paths, invalid limits, and missing `--` before starting the producer. It
never chooses another path. If executable spawn fails after exclusive creation,
it leaves that owned log in place and emits `command.state=spawn_error`. A
post-spawn pipe/selector setup failure instead performs bounded cleanup,
reports `setup_error` plus the observed direct-parent state, and returns 2.

## Bounded shell fallback

For hosts where this optional POSIX helper is unavailable, or when an enclosing
operation already supplies the real deadline, choose a new, exact
assignment-owned `LOG_PATH` (inside an already owned directory) and use this
small shell pattern as `args.cmd`; replace only `YOUR_FINITE_COMMAND` with a
command that has its own real finite bound:

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

<a id="optional-action-context-navigator"></a>
## Optional action-context navigator

After authority and the applicable assignment are already known, select one
exact visible trigger from `SKILL.md` without copying its destinations by hand:

```text
python3 -B scripts/context_excerpt.py action-excerpt \
  --root /absolute/source/checkout --layout source \
  --source-relative SKILL.md --trigger 'Worker implementation/report'
```

A packaged copy uses `--layout package`, its package root, and
`--source-relative skills/lunacy/SKILL.md`. For `action-excerpt`, exactly one of `--trigger` or an
absolute regular UTF-8 `--trigger-file` is required. The latter is capped at
64 KiB. `--format json` is the only format. `--max-output-bytes` defaults to
256 KiB (hard maximum 1 MiB), `--max-acquired-bytes` to 4 MiB (hard maximum
16 MiB), `--max-files` to 32 (hard maximum 128), `--max-links` to 512
(hard maximum 4,096), and `--max-work-units` to 100,000 (hard maximum
1,000,000). Lower limits fail the whole result rather than clipping it.

Success includes the complete physical trigger row and before-action prose,
direct live heading spans or whole files in source order, per-acquisition
paths/hashes/ranges, and nested local links as quoted `unfollowed` records.
Nested targets are never acquired. Exact trigger matching and ambiguous anchor
or boundary refusal prevent fuzzy selection. Source/package comparison is by
logical path, fragment, ranges, hashes, and bytes—not absolute package paths.
Physical lines end only at CRLF, LF, or CR; other Unicode/control separators
remain literal content. Heading, anchor, and fence scanning uses the same
physical lines as excerpt ranges, whose byte offsets preserve the exact UTF-8
source bytes and line endings.

For an already-authorized linked section, use its exact fragment rather than
guessing a heading title or importing the helper's private indexing functions:

```text
python3 -B scripts/context_excerpt.py section-excerpt \
  --root /absolute/source/checkout --layout source \
  --source-relative WORKSPACE.md --fragment worker-updates-and-immutable-report
```

For the large-output reference, substitute `--source-relative OPERATOR.md
--fragment large-output-command-reference`. Use the helper shipped in the
selected checkout/artifact. A native package uses `--layout package`, its
package root, and physical paths such as `skills/lunacy/WORKSPACE.md`; a
standalone skill uses source layout. Only published Lunacy Markdown paths
inside that root are supported, with the same guarded acquisition and caps.
Section mode requires `--fragment` and rejects action selectors. Supply a
nonempty URL-fragment component without the leading `#`; it is decoded once
and matched exactly, including explicit aliases. Missing, unattached or
ambiguous anchors refuse the whole result—never a whole-file fallback.

The `lunacy.section_excerpt.v1` result contains one `excerpt` with exact
physical line/byte ranges, text and SHA-256, plus source acquisition identity.
`nested_scan: not-performed` means links in that text were neither scanned nor
followed; callers still decide which obligations apply. Section mode internally
acquires and indexes the bounded whole file, not just its returned bytes. Its
error envelope is `lunacy.section_excerpt.error.v1`; usage errors exit 2,
acquisition/path errors 3, selection errors 4, budget errors 5, and unexpected
implementation failures 70. No partial success is emitted. This command grants
no authority and makes no token, cost, latency or complete-obligation claim.

The exact `Overlap, unknown authority/effects, deadline, recovery` selector
preserves its prior destinations and appends recovery. Use `Adopted task
deadline` for only deadline/finalization planning; it retains shared authority
and barrier context. These excerpts are text, not proof of current authority, TASK
freshness, custody, effect settlement, interruption authority, or safe replay.

The navigator is source-authoritative only for bytes individually acquired in
that invocation. Per-file descriptor checks can detect an observed change
during that read; they do not provide an atomic multi-file snapshot, future
freshness, semantic applicability, complete obligations, authority, host or
route identity, model behavior, or recursive closure. Regular-file size and
aggregate work limits do not guarantee latency for arbitrary filesystem I/O.
Errors leave stdout empty and emit bounded JSON on stderr.

## Optional evidence-index helper

For a named command fact, first reuse adequate structured evidence already delivered; when necessary, a purpose-built task or turn read may avoid acquiring a full capture. Treat this as an optional retrieval shortcut, not a mandatory preliminary stage, guaranteed host capability, new required schema, or dependency on a literal tool name. Bind retained evidence to the exact task, turn, command or item ID, and matching command; follow supplied pagination only as needed, preserve returned fields with source attribution, and disclose truncation or missing fields. Use the existing capture route whenever stronger adopted claims require information or completeness absent from this view. Structured command, status, exit, and identifier fields support only those recorded facts: later application records do not recover original execution returns or prove complete output, descendants, effects, semantic acceptance, custody, or backend state. Missing retrieval never authorizes replay, invented values, raised caps, omitted required proof, or unsupported substitution of prose summaries for required structured evidence.

Use the helper only for an already captured, authorized native JSONL file:

```text
python3 scripts/evidence_index.py /absolute/path/events.jsonl [--source-format app-server|session-receipt] --thread-id EXACT [--session-id EXACT] --turn-id EXACT [--item-id EXACT ...] [--expected-sha256 LOWERCASE_SHA256] [--output-cap BYTES]
python3 scripts/evidence_index.py /absolute/path/events.jsonl --source-format direct-exec --thread-id EXACT [--item-id EXACT ...] [--expected-sha256 LOWERCASE_SHA256] [--output-cap BYTES]
python3 scripts/evidence_index.py /absolute/path/events.jsonl --source-format direct-exec --thread-id EXACT --correlate first-nonzero [--after-ordinal N] [--expected-sha256 LOWERCASE_SHA256] [--output-cap BYTES]
```

Input must be an absolute regular UTF-8 JSONL file no larger than 64 MiB with complete LF records. The helper opens nonblocking, verifies the descriptor, and hashes one bounded snapshot. This nonblocking filesystem capability is also required by offline readers: an exported catalog avoids live collection, not the offline reader's host prerequisites. If `os.O_NONBLOCK` is unavailable, refuse through the bounded diagnostic rather than substitute blocking I/O or claim broad portable support. Output caps are 256 through 1,048,576 bytes, default 8192; native-lifecycle has a tighter 8192-byte maximum. After arguments validate, runtime diagnostics honor the requested cap and 512-byte diagnostic ceiling. Argument parsing and validation errors instead use the minimum supported 256-byte allowance because no supplied cap is trusted before complete validation, and omit usage boilerplate; `--help` still exits successfully with ordinary help. All error diagnostics preserve valid UTF-8 by dropping only an incomplete final code point when truncated and end in one LF. App-server serialization preserves ordinary UTF-8 and losslessly backslash-escapes exceptional lone surrogates only at final encoding; the cap measures those final emitted bytes including the newline. Session serialization remains ASCII. `app-server` is the default and retains the existing received-event lifecycle semantics. Selection is explicit: there is no format auto-detection, fallback, or join to a second capture.

Locators apply only to the reported source hash. `observed_zero`, `observed_nonzero`, `observed_declined`, `missing_terminal`, and `incomplete_evidence` describe native command records, not inner shell steps or acceptance. `observed_declined` requires an explicit received declined terminal with a present null `exitCode`; absent or nonnull is refused. The helper never parses prose as authority, writes files, uses network, starts models/processes, creates captures, validates reports, settles custody, or gates acceptance. Success means only a valid projection. Missing capture never authorizes an exporter or omitted proof; unsupported required host formats are the trigger to replace this narrow helper.

For `session-receipt`, one exact `session_meta` must bind `id` to the requested thread. By default, its `session_id` must also equal that thread; the optional explicit `--session-id` instead requires exact equality to that separate nonempty value and is rejected for `app-server`. Opt-in output adds `recorded_session_id` inside `session`, sourced from the validated metadata. This records an association only: it does not infer ancestry, backend identity, or custody, and it never substitutes for command `thread_id`. An exact matching `turn_context` supplies nonempty recorded model/effort on a source-associated basis. Command evidence comes only from explicit same-thread/same-turn `event_msg` / `item_completed` / `CommandExecution` completions; starts are neither required nor synthesized. Identical matching contexts or completions deduplicate, while identity conflicts, malformed purported commands, conflicting duplicates, or missing requested items refuse atomically. Other well-identified turns may coexist. The `session-receipt` selector does not support turnless direct-exec stdout and never joins it to session evidence; use the separate explicit `direct-exec` format only for its supported envelope.

The session projection allowlist contains only the source path/hash, requested scope, metadata/context physical LF lines, recorded model/effort, the validated recorded session ID only under explicit `--session-id`, and each completion's physical LF line, item ID, raw status, and integer-or-null exit code. Command arguments, cwd, output, prompts, reasoning, encrypted content, arbitrary extras, and generated report text are never displayed in successful projections; arbitrary captured JSON member names are also excluded from refusal diagnostics. Counts cover captured matching completions only. Raw status/exit facts imply no lifecycle consistency, semantic verdict, completeness beyond the capture, route/backend truth, deadline correctness, custody, or acceptance.

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

When the complete direct-exec projection exceeds the output cap and the caller
does not already know an item ID, `--correlate first-nonzero` is a narrow,
opt-in discovery operation. It returns at most one allowlisted group: the first
group in the existing first-observation order that contains an integer
`exit_code != 0`. This is deliberately not the earliest nonzero physical line:
a later observation in an earlier-started group wins over a physically earlier
nonzero observation in a later-started group. Repeated observations are counted
without lifecycle inference. A no-match response is complete and reports the
last scanned group ordinal, or `-1` for an empty scope.

To retrieve the group, pass the returned literal item ID to the unchanged
`--item-id` form and bind that call with the returned source SHA-256. To search
for a later matching group, repeat the correlation with its returned ordinal as
the exclusive `--after-ordinal` and the returned digest as
`--expected-sha256`; the hash is mandatory whenever `--after-ordinal` is used.
The ordinal is an explicit direct-exec-only query input, not an opaque token or
universal continuation guarantee. It accepts at most 4096 unsigned decimal
digits syntactically. A host may enforce a lower integer-string conversion
ceiling (for example through `PYTHONINTMAXSTRDIGITS`); values above that active
ceiling receive a bounded argument refusal, and the helper never disables or
raises the host policy. This matches the existing bounded refusal of source
JSON integers that exceed the active conversion ceiling. An ordinal at or
beyond the final group yields a normal complete no-match result. Changed bytes
fail the hash check, and a changed thread scope fails the validated header
check.

Correlation still validates the whole finite snapshot before emitting any
facts, including malformed records after a potential match. Its complete JSON
plus final LF is measured in encoded UTF-8 against the exact requested cap. If
the allowlisted match envelope itself cannot fit, the helper returns the normal
`output_cap_exceeded` refusal with `required_bytes`; it never truncates or
hashes the item ID, skips the unreturned match, or suggests `--after-ordinal`
as a bypass. This operation does not search command text, export raw fields,
generalize to the other source formats, or create a database, lease, or
persistent cursor.

### Native lifecycle observations

For timing review, use an existing authorized frozen session capture rather than
dumping its prompts and tool bodies:

```text
python3 -B scripts/evidence_index.py /absolute/path/frozen.jsonl --source-format native-lifecycle --thread-id CHILD_THREAD_ID --turn-id TURN_ID --expected-sha256 LOWERCASE_SHA256 --output-cap 2048
```

The digest is mandatory. One `session_meta.payload.id` must match the requested
thread; `session_id` may identify a different parent session and is not used.
Missing or duplicate metadata refuses. Thread/turn IDs are nonempty strings of
at most 128 characters. `--session-id`, `--item-id`, `--correlate` and
`--after-ordinal` are unsupported here. Supply a real command deadline; byte
bounds do not provide elapsed-time cancellation.

The `lunacy-native-lifecycle-index-v1` projection returns source path/hash/byte
and physical-LF-line counts, requested scope, metadata line, and observations
with only `line`, `event`, and `recorded_timestamp`. Supported `event_msg` labels
are exactly `task_started`, `task_complete`, and `turn_aborted`. Explicit matching
turn IDs populate `events`; absent/null IDs populate separate `unscoped_events`
and are never assigned from neighboring context. Other explicit turns and
unsupported event labels produce only `other_turn_event_count` and
`ignored_event_count`, respectively. Duplicates, reversed order and competing
terminals remain in source order, not a computed status.

An absent/null timestamp stays null; an emitted timestamp must be valid RFC3339
with uppercase `T`/`Z` (or a numeric zone), seconds 00–59, and optional
one-to-nine fractional digits. Its spelling is retained,
not normalized or trusted as a clock measurement. No arguments, results, prompts,
reasons, model metadata or arbitrary payload fields are returned. Invalid JSON
and malformed supported records refuse with bounded, payload-free diagnostics.

At most 128 selected plus unscoped observations and 8192 total output bytes are
allowed. A smaller requested cap still applies. The complete projection is
measured before emission; exit 3 returns only an output-cap diagnostic, never
partial observations. Input/acquisition failures return exit 2 with empty stdout.
An empty event list means no matching evidence in these bytes, not that work has
not started or is still running. Line pointers bind only to the reported hash;
excerpt lines do not become original-session lines without a separate mapping.

This is recorded evidence, not proof of semantic success, custody settlement,
valid dispatch, simultaneous execution, capacity, backend identity, authenticated
messages, accurate clocks or complete history. It neither joins captures nor
replaces independent artifact/check evidence or the launch-order diagnostic.
