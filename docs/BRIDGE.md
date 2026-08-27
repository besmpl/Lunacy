# Private runtime-to-skill bridge

The bridge is an optional host seam for an explicitly selected run. It calls
the existing `RunKernel.advance` method once per invocation and writes only
machine-owned projection sections into `STATE.md` and a phase `STEPS.md`.
`PLAN.md`, notes, decisions, reports, and evidence remain parent declarations
and are never parsed as executable prose.

Set `NODE` to the absolute, attested Node executable used by the managed
deployment; do not resolve Node through ambient `PATH`.

## Explicit mode

Choose `runtime` or `markdown` when the run is created. A legacy Markdown run
does not acquire a `.kernel/BRIDGE.json` file. A runtime run is initialized by
one `START` transition and is never silently downgraded to Markdown. Missing,
corrupt, stale, disabled, or version/path-mismatched bridge metadata fails
closed.

The declaration supplied to the bridge is canonical JSON with the normal
Lunacy Plan shape (`phaseId` and executable `steps`). Unknown fields,
non-canonical values, duplicate steps, cycles, unsafe identifiers, and invalid
claims are rejected before the kernel is called. The `START.intentRef.digest`
must name that declaration (raw or validator-normalized form); later changes
produce the runtime's digest-bound `DECISION_REQUIRED` adoption flow.
When active Beads supplies a source-bound declaration, bridge preflight uses
the same three aliases as RunKernel (captured raw, normalized, or normalized
with the source binding omitted) and rejects arbitrary native raw spellings
before publishing bridge metadata.
The host declaration and event are snapshotted once at the boundary, so a
mutable caller object cannot be read once for identity and again for effects.

## One-event command

After `npm run build`, run the private CLI directly (or use the installed
`runtime/bridge.mjs` deployment):

```sh
"$NODE" dist/bridge-cli.js \
  --run-dir /path/to/Lunacy/runs/example --run-id example \
  --mode runtime --plan /tmp/plan.json --event /tmp/event.json \
  --event-id start
```

Each invocation accepts exactly one event and emits canonical JSON. This
one-event route does not spawn Codex workers, call providers, install packages,
use Beads, or claim token/native capability. An absent driver therefore remains
the runtime's truthful `HumanReceiptRequired` result.

## Runtime drive mode

The managed skill also provides a private event-driven pump for an explicitly
attested Codex host. It is a mechanical adapter around the same kernel; it
does not become a scheduler or a second durable authority:

```sh
"$NODE" runtime/bridge.mjs drive \
  --run-dir /path/to/Lunacy/runs/example --run-id example \
  --mode runtime --plan /tmp/plan.json \
  --policy /path/to/policy.json
```

The policy is closed capability data (run/plan digest, workspace and run-root
paths, attested Codex binary, Sol model, high default, sandbox, output
ceilings, and any exact durable `max` override). The pump asks
`RunKernel.advance` to select and claim work, waits for the one-token
supervisor's launch/terminal evidence, submits the exact receipt/envelope, and
continues only through another kernel call. It stops for `BLOCKED`,
`NEEDS-DECISION`, approval/redirect/cancellation, unsupported capability,
phase/final boundaries, or a hard gate. It never parses Markdown to authorize
work, creates a batch, retries an uncertain token, closes a gate, or adopts a
plan.

This Sol `codex exec` policy is private to managed runtime drive. The root
`SKILL.md` direct/manual `agents.spawn_agent` choice between default Luna and
explicit Sol/high does not enter this policy, change its schema or digest, or
provide a fallback for it.

After a bridge-process restart, drive performs one bounded reconciliation from
the verified committed kernel state and exact-token immutable effect records.
Missing, stale, malformed, or conflicting evidence remains fail-closed. The
private driver, supervisor, policy, and pump are not package-root exports.

## Projections and rollback

Projection blocks are delimited by `lunacy-runtime:state` and
`lunacy-runtime:steps` markers. Content outside those blocks is preserved;
duplicate, injected, or malformed markers fail closed before a transition is
committed. If projection fails after a
successful kernel commit, the durable `.kernel/CURRENT` and journal remain the
authority and a later invocation may retry projection.

`--disable` and `--delete` require an explicit `--mode runtime` and operate
only at a quiescent boundary: no `ACTIVE`
step and no `PENDING`, `CLAIMED`, or `UNKNOWN` outbox command. Disable writes a
disabled bridge manifest; lifecycle calls reconcile a stale manifest against
CURRENT only with the exact consumed adoption-predecessor proof. Delete writes
its tombstone before cleanup, and a retry resumes idempotent manifest/input
cleanup after a crash. Neither removes
CURRENT, generations, journal, Markdown declarations, reports, or projections.

## Deterministic deployment

`npm run deploy:skill -- --target /path/to/skill-root` assembles a complete
sibling managed `runtime/` tree, verifies its exact deployment-owned inventory,
and publishes it with a recoverable directory-rename transaction. `--check`
verifies the complete tree (including absence of stale owned files), exact
bytes, and the aggregate deployment fingerprint. Unrelated files beneath the
skill root—and explicitly unowned files under `runtime/`—are preserved; files
under the managed `dist/`, `schemas/`, and `tools/` namespaces are replaced as
part of the complete tree. A durable transaction marker allows the next
invocation to roll an interrupted exchange back to the prior whole tree rather
than exposing an overlay or mixed release. Deployment performs no network or
global install and never edits unrelated skill files. The deployment/check/
restore commands hold one kernel-atomic target lock for their full recovery
and publication lifetime. Transaction names are recorded exclusively before
use; recovery touches only those exact names, leaves foreign matching
siblings alone, and restores an exact verified backup even when the
interrupted candidate is incomplete. Nested stage/restore trees are fsync'd
bottom-up, with a final inode/content fence for explicitly unowned runtime
files immediately before exchange.
The installed `runtime/bridge.mjs` embeds the expected release fingerprint,
manifest digest, and normalized launcher digest from the deployment manager.
It reads every listed module through no-follow descriptors with strict
per-file and aggregate byte ceilings before allocation, and registers an
in-memory ESM loader over those exact verified bytes. Entry and transitive
imports therefore evaluate the verified byte graph directly; no mutable
temporary module pathname is reopened between verification and execution.
The mutable manifest is accepted only when its exact bytes and launcher
provenance match those embedded release values, so a recomputed/tampered
manifest, launcher, or verify-to-import substitution is rejected.
The npm package has no bridge executable; this remains a private managed-skill
surface.

An audited 0.2.12 rollback is an explicit closed operation, not an instruction
to exchange directories by hand. Prepare an immutable payload and canonical
inventory attestation, then run the complete command from [INSTALL](INSTALL.md):
`tools/deploy-skill.mjs --target TARGET --restore --payload PAYLOAD
--inventory INVENTORY --aggregate AGGREGATE`. Its `status: "restored"` output
verifies the exact manifest/launcher/inventory aggregate and complete managed
tree. The operation preserves unowned runtime files, removes only
deployment-owned extras, and resumes the same transaction after any crash;
run ordinary `--check` after the identical 0.3.0 redeploy.

The managed launcher requires Node `>=22.15.0 <23 || >=23.5.0`, the releases
that provide synchronous `registerHooks()`. Node 22.0–22.14 and 23.0–23.4 are
unsupported; there is no deprecated-loader fallback. An eligible engine range
is not a claim of universal patch or platform qualification.

For a private read-only dependency explanation, use the separate Workfront
route before transition handling:

```sh
"$NODE" runtime/bridge.mjs workfront --run-root /absolute/run/root --run-id ID
```

See `WORKFRONT.md`. The route loads only the native Workfront/store path (not
the transition bridge or Beads adapter), reads one verified committed
generation, emits one bounded canonical capsule, and performs zero filesystem
mutations on success or failure. It never authorizes dispatch or replaces the
authoritative Markdown/runtime recovery path.

The optional read-only Beads planning boundary is documented in `BEADS.md`.
It is a separate explicit `off`/`shadow`/`active` selection and is never called
from `RunKernel.advance`.

## Host trust boundary

The canonical deployment tool and the installed `runtime/bridge.mjs` launcher
are the trusted entrypoints. The launcher verifies its normalized own bytes,
the exact managed runtime bytes, and the attested deployment manifest before
importing them. Deployment and bridge startup reject launcher/runtime, run-root,
`.kernel`, and projection-parent paths that are not owned by the current user
or are group/world-writable (when the host exposes a user id). Keep each run
root exclusively owned by the invoking user and do not concurrently rename or
replace it while a bridge operation is in flight.

This is an explicit host boundary, not a sandbox against malicious code already
running as the same desktop user. Such code can replace the complete launcher,
manifest, and embedded release bundle (or unset owner-controlled file flags),
trace or signal the process, and mutate any owner-writable resource. Preventing
that requires an OS sandbox, separate account, or vendor-signing trust root
outside this private bridge. Untrusted Beads data,
tampered pre-verification payload/manifest bytes, other-user permissions,
symlinks, crashes, cooperating concurrent bridge processes, ordinary workspace
drift, and all RunKernel authority/replay/recovery invariants remain in scope.
