# Optional Beads planning source

Lunacy can consume one read-only planning snapshot from an operator-provisioned
Beads `bd` v1.2.2 executable. This is a private host/composition seam, not a
package dependency and not a second runtime authority. `RunKernel.advance`,
CURRENT, the journal, reducer, dispatcher, and outbox remain unchanged.

## Provisioning

Provision the official platform asset for tag `v1.2.2` outside this repository.
Verify its release SHA-256, extract `bd`, and pass its **absolute** executable
path plus the binary SHA-256. The adapter does not search `PATH`, download,
install, update, initialize, setup, hook, sync, push, pull, or write to Beads.
The pinned release reports:

- version `1.2.2`
- build `6c124203e`
- commit `6c124203e771433a3550c348771a5b5e27fd3c21`
- schema version `1`

The selected workspace and its `.beads` directory must already exist. Each
capture runs with an isolated `BEADS_DIR`, `HOME`, `XDG_CONFIG_HOME`,
`BD_DISABLE_METRICS=1`, and `NO_COLOR=1`; inherited Beads/Dolt/proxy/credential
variables are not passed to the child. Each capture copies executable bytes
from one `O_NOFOLLOW` descriptor into a fresh private temporary inode, removes
the Linux pathname, and executes one descriptor-bound image for both probes
(macOS uses an immutable private pathname). Workspace and `.beads` directories
are held open as no-follow descriptors on Linux and passed through fixed child
slots 4 and 5, so a parent descriptor number is never mistaken for the child's
`/proc/self/fd` path; a swap-and-restore while `bd` runs cannot change the
database being read. On macOS, where `spawn` cannot
use a directory descriptor as `cwd`, the selected `.beads` tree is copied once
into a bounded owner-only private snapshot before either probe; both probes read
that snapshot and the original descriptor/path identity is fenced afterward. The
default HOME/XDG pair is fresh per capture and removed in `finally`; explicit custom directories must already be private,
owned by the caller, and physically disjoint from the workspace, `.beads`, and
the protected runtime root supplied by the bridge.
Any path, hash, version, build, schema, timeout, workspace-identity, or process
error fails closed; the pinned version probe must also remain silent on stderr.

## Capture and modes

`BeadsPlanSource.capture(signal)` performs exactly:

```text
bd version --json
bd --readonly --json export
```

The export is bounded JSONL (8 MiB stdout, 64 KiB stderr, 128 KiB line, 4,096
records, 16,384 edges) and accepts only issue records with `open`/`closed`
status, the six built-in work types, and `blocks` dependencies. Titles and
descriptions remain opaque plan data. Closed blockers are satisfied and omitted
from executable dependencies; missing endpoints, cycles, duplicate IDs/edges,
custom statuses/types, gates/molecules, comments/labels, metadata, malformed
JSON, NUL/non-UTF-8 data, and oversized input are rejected.

The bridge chooses one explicit mode per invocation:

- **off** (default): use the parent-owned native plan.
- **shadow**: capture and compare the candidate digest, return diagnostics, and
  do not invoke the runtime or mutate CURRENT/journal/plan.
- **active**: require a parent acknowledgement binding snapshot digest, target
  Plan digest, workspace identity, pinned commit, and binary digest. The
  captured Plan is then supplied to the existing bridge authority/adoption
  flow; drift produces the runtime's digest-bound decision rather than silent
  replacement.

The snapshot is immutable input evidence. An acknowledged active START/adoption
is persisted privately in a digest-addressed artifact
`.kernel/BEADS.INPUT.<planDigest>.json`; every attempted event identity gets an
append-only `.kernel/BEADS.REPLAY.<identityDigest>.json` binding, so a
precommit crash cannot monopolize a candidate or make an alternate accepted
alias unreplayable. Ordinary receipts, recovery, and gate events select the
artifact named by CURRENT and do not require `bd`. The legacy
`.kernel/BEADS.INPUT.json` name is only a post-commit convenience alias and is
not recovery authority. A fresh capture occurs only at START, explicit
authority adoption, or an explicit `OBSERVATION` event. There is no `bd ready`, claim,
write-back, direct Dolt/JSONL read, scheduler, graph, gate, lease, or polling
path. Disable/delete remains a quiescent bridge operation and never removes
CURRENT, journal, declarations, receipts, reports, or evidence.

On pathname-snapshot hosts, private-tree construction is iterative and bounded
by aggregate bytes, entry/file/directory counts, maximum depth, cumulative
relative-path bytes, and the capture deadline/abort signal; partial snapshots
are removed on every failure. Missing protected runtime roots are physicalized
through their nearest existing ancestor before overlap checks. Executable
copies use complete-write loops and hash the exact read-only execution image;
the recorded binary digest cannot describe bytes that were not written. The
canonical deployment tool's `--check` path applies the same fixed-size,
stat-fenced reads to its mutable manifest and streams payload digests without
retaining whole files.

Private snapshot storage has one explicit, future-only
`evidenceCopyPolicy: 'off' | 'prefer' | 'require'` option. Omission and `off`
retain the original direct full-copy artifact bytes and emit no storage
metadata. On macOS, eligible files of at least 1 MiB are cloned only when the
source and private destination are on the same APFS volume, using
`COPYFILE_FICLONE_FORCE` into an exclusive temporary sibling. The source must
remain the same regular inode, size, mode, timestamps, and SHA-256 throughout;
the distinct destination inode is size/SHA checked, normalized to `0500`,
fsynced, published by a verified atomic no-replace hard link, and followed by a
parent-directory sync. `require` aborts if that clone path is unavailable.
`prefer` uses the same verified atomic publication for a full-copy fallback and
includes an `evidenceCopy` receipt with exact clone/fallback counts and bounded
reasons; the receipt is persisted with acknowledged input and survives ordinary
receipt/recovery events without changing snapshot or Plan identity. Existing
files are never migrated: rollback is simply `off`, and prior reflinks remain
ordinary valid files. Reflinks are an allocation optimization, never a backup
or independent durability copy.

## Private CLI example

After `npm run build`, an active capture can be selected by the private bridge
CLI (the acknowledgement is canonical JSON produced by the parent). Set
`NODE` to the absolute, attested Node executable used by the managed
deployment; do not resolve this launch through ambient `PATH`:

```sh
"$NODE" dist/bridge-cli.js \
  --run-dir /abs/run --run-id run-1 --mode runtime \
  --beads-mode active --bd-path /abs/bin/bd \
  --beads-workspace /abs/workspace --beads-sha256 SHA256 \
  --beads-evidence-copy prefer \
  --beads-ack /abs/ack.json --event /abs/start.json --event-id start
```

The package root does not export this adapter or bridge lifecycle. Deployment
copies the private module into the managed installed runtime and performs no
global package mutation.
