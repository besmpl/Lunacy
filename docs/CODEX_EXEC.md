# Codex exec capability contract

This release records the local contract needed by the private orchestration
adapter. `tools/probe-codex-exec.mjs` is a capability probe, not a scheduler or
a worker launcher. It never selects a Lunacy step and it never retries a
failed command.

Set `NODE` to the absolute, attested Node executable used by the managed
deployment; the launcher rejects ambient `PATH` Node resolution.

`npm run deploy:skill` carries this document, the four closed Codex schemas,
and the probe into the fingerprinted managed skill under `runtime/`. Hosts must
bind policy paths to those deployed bytes (or to an independently verified
equivalent); they must not reach into an ambient source checkout at launch.

## Attested executable

The probe accepts an **absolute** executable path (default:
`/opt/homebrew/bin/codex`), resolves it to its physical file, and records only
non-secret identity facts: regular-file status, owner/group, mode, SHA-256, and
exact version `codex-cli 0.145.0`. The Node executable and supported runtime
version are attested as well. A symlink is allowed only when its resolved target
is an executable regular file.

The probe obtains `codex exec --help` from that same physical image and refuses
to continue when any required automation flag is missing:

- `--model gpt-5.6-sol`;
- `--sandbox workspace-write` (never full access);
- `--json`, `--output-schema`, and `--output-last-message`;
- `--ephemeral`, `--ignore-user-config`, `--strict-config`, `--cd`, and `--config`.

The constructed invocation is an argument array with `shell: false`. Dangerous
bypass flags and `--ignore-rules` are rejected. There is no model fallback.

## Immutable launch binding

Before entering `child_process`, the supervisor reserves a one-shot launch
intent and materializes the command-selected authority bytes (including the
phase-derived `phases/<phaseId>/STEPS.md`) in a token-addressed private
snapshot. Every newly-created directory chain and protocol filename is
`fsync`ed before publication, including launch intent, launch receipt, result,
report, terminal, and snapshot entries. The snapshot is sealed read-only and
its paths are committed by the handoff and argv digests. On Linux, the
executable image, workspace, run root, and authority files are passed through
fixed child descriptor slots; on macOS, the copied executable, every snapshot
entry/root, and the workspace/run-root roots are sealed first, then synchronously
rechecked for identity, digest, ownership, mode, metadata, and immutable flags
immediately before process entry. Immediately after `spawn` returns, the two
entry-only workspace/run-root flags are synchronously cleared and verified
against those exact inode witnesses before launch publication or any awaited
bridge work, so state projection can proceed while the child remains live. A
native flag observation fails closed when the filesystem inspection or
fallback `stat` subprocess errors, exits unsuccessfully, or returns missing,
unparseable, or out-of-range flags; test-only flag setter/observer seams are
rejected when paired with the production spawn implementation. A
clear/verification failure terminates the unpublished owned child tree and
leaves the one-shot intent as conservative evidence; terminal cleanup is a
separate best-effort fallback that never clears a replacement pathname. The
copied executable and authority snapshot retain their immutable evidence
boundary. A replacement or transient mutation of any attested input fences the
launch before spawn or before launch publication, respectively.

## Disposable probe

The live probe creates a temporary Git repository, writes the closed
`schemas/codex-worker-result.schema.json`, and makes one `high` invocation and
one independent `max` invocation. Each invocation pins the model, explicit
sandbox, JSONL stream, schema, final-output file, ephemeral mode, and
`approval_policy="never"`. Output and error streams are bounded in memory and
are not written to source fixtures or reports. The temporary repository is
removed after the probe.

The structured final file must contain exactly:

```json
{
  "status": "PASS | NEEDS-DECISION | BLOCKED",
  "reportPath": "non-empty path",
  "reportDigest": "64 lowercase hexadecimal characters"
}
```

The JSONL event stream and final file are classified into these stable
representations: `normal-completion`, `turn-failure`, `sandbox-denial`,
`approval-required`, `cancellation`, `host-evidence-failure`,
`unresolved-termination`, `malformed-final-output`, `absent-final-output`, and
`process-failure`. Normalized fixtures under
`test/fixtures/codex-exec/` lock the parser contract without retaining
machine-specific logs.

## Release quiescence

`runtime/tools/verify-release-quiescence.mjs` is the closed, read-only release
preflight. It requires the exact installed skill target, every canonical run
root in the closed production set, and one bounded canonical process snapshot
whose records contain exact executable paths and argv tokens. It validates the
committed CURRENT generation/state/journal/outbox, complete Codex effect chains,
deployment residue, and process ownership. It reports and exits only: it never
signals a process, acquires or removes a lock, reconciles a run, cleans a
transaction, or changes any file. A missing root or snapshot is a failure; the
tool never discovers and silently adopts an ambient run.

Production release actions use a separate private exclusion boundary around
that verifier. The boundary first claims every authorized discovery parent and
the installed target, then each byte-sorted run's bridge/launch admission and
writer fence, and only then the target deployment transaction. Store writes,
managed drives, claimed-command dispatch, and copied-child spawn all check the
ancestor claim; asynchronous launch preparation retains a run writer claim
through launch-record publication. Thus an earlier entrant settles or remains
verifier-visible, while no later root, writer, drive, successor, or child can
cross a green verification. The verifier itself remains byte-for-byte
read-only and receives exact owned-claim bytes only from this private caller.

`max` is probed separately. A valid structured completion records
`max: supported`; **any rejection, timeout, or other failed max attempt records
`max: unsupported` and blocks max-authorized commands**. The probe never retries
or silently downgrades a max attempt to `high`.

## Credential boundary

The probe does not open, parse, copy, hash, or persist credential files or
values. Codex may consume its own configured authentication while running; the
report records only the names of explicitly recognized authentication
environment variables that were present, and records `credentialsInspected` and
`credentialsPersisted` as `false`.

## Running

```bash
npm run probe:codex
npm run probe:codex -- --codex /absolute/path/to/codex --timeout-ms 60000
"$NODE" tools/probe-codex-exec.mjs --fixtures
```

After deployment, the same normalized fixture probe is available as:

```bash
"$NODE" runtime/tools/probe-codex-exec.mjs --fixtures
```

A live report has status `PASS` only when the high contract and all normalized
representations pass. Unsupported max is an explicit capability result, not a
reason to downgrade high. Any other missing local capability returns
`BLOCKED_CODEX_EXEC_CAPABILITY` and production adapter work must stop.
