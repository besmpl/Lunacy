# Install and run

Lunacy Runtime requires Node.js 22 or newer and has no runtime dependencies.
For a locked development install:

```sh
npm ci
npm run check
```

Managed bridge launches below use `"$NODE"`, where `NODE` must be the
absolute, attested Node executable used for deployment; do not substitute an
ambient `PATH` resolution.

For a consumer install, pack and install the exact artifact (the same check is
used by CI):

```sh
npm pack
mkdir /tmp/lunacy-consumer && cd /tmp/lunacy-consumer
npm init -y
npm install /path/to/lunacy-runtime-0.3.0.tgz
```

The package root exports `makeRunKernel` and the `RunKernel` type. Its only
lifecycle method is `kernel.advance(input)`. `rootDir` is optional: omission
uses an in-memory store; a supplied directory persists `.kernel/CURRENT`,
immutable generations, and the append-only journal.

Adaptive deliberation is private host composition. Package install and managed
runtime deployment create no ambient rollout, so omission remains fail-safe
disabled. Plain `$lunacy` Plan authorship defaults to exactly one canonical
typed `AUTO` request in the separately installed operator profile; explicit
`DIRECT` and explicit `EXPLORE` remain authoritative overrides. AUTO never
selects Explore, and a complete Plan takes the physically isolated zero-call
Direct branch. An eligible unresolved named discriminator composes reviewed D3
with `createManagedRolloutPolicy({ generation: 1, mode: 'automatic-focus' })`
only as one generation-1,
effect-denied Focus Wave before the acceptance pointer/Plan is sealed and
before the first implementation spawn. It never automatically WIDENs or
re-enters from gates, repair, worker completion, resume, rollout, or an
existing rollout-bearing run; an unsettled Wave returns exactly one parent
decision boundary. It preserves Direct bypass, user-explicit ADHD/Explore,
exact Luna/max isolation, and parent authority; missing or nonconforming
composition is disabled/refused without fallback. Validate its operator surface and a disposable target with
the copy-paste procedure in the [adaptive operator contract](../orchestrator/DELIBERATION.md).

After deployment and `--check`, the trusted parent invokes adaptive Plan
authorship only through the verified installed route (never a source-checkout
import):

```sh
"$NODE" runtime/bridge.mjs resolve-plan \
  --input REQUEST.json \
  --deliberation-policy DELIBERATION.json --rollout-policy ROLLOUT.json \
  --run-dir RUN --capability CAPABILITY.json --host-policy HOST.json
```

The request mode is exactly `DIRECT`, `AUTO`, or `EXPLORE`. Managed-only arguments are omitted for Direct and AUTO→Direct. All
documents are canonical and exact. The adapter performs no prose parsing,
calls the resolver once, and keeps current Explore authorization private to
that process; no reusable authorization artifact is installed or emitted.

The signed deployment inventory includes
`runtime/assets/deliberation-policy/*.json` and the reader-only
`runtime/assets/deliberation-policy-compatibility/map.json`. Every policy asset
filename is the SHA-256 of its canonical bytes. A deployment missing either a
fresh policy asset or the compatibility map is incomplete and must remain
disabled.

## Minimal API

```js
import { makeRunKernel } from 'lunacy-runtime';
import { createHash } from 'node:crypto';
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash('sha256')
  .update(JSON.stringify(canonical(value))).digest('hex');
const plan = { phaseId: 'demo', steps: [{ stepId: 'hello' }] };
const event = { kind: 'START', intentRef: { id: 'plan', digest: digest(plan) } };
const kernel = makeRunKernel({ plan, rootDir: './demo-run' });
const yieldValue = await kernel.advance({
  runId: 'demo-run',
  identity: { runId: 'demo-run', phaseId: 'demo', stepId: 'run',
    attemptEpoch: 0, authorityEpoch: 0, barrierEpoch: 0,
    eventId: 'start', payloadDigest: digest(event) },
  event,
});
```

Use a real canonicalizer for production inputs; the runtime validates every
payload digest and rejects non-canonical artifact refs.

## CLI and example

The packed `lunacy-runtime` executable reads one canonical plan and one
canonical event, constructs the identity, calls `advance`, and prints one
canonical `Yield` JSON value:

```sh
lunacy-runtime --plan examples/canonical-plan.json \
  --event examples/canonical-event.json --run-id demo --event-id start
```

`examples/` contains the preregistered smoke fixture. `--root-dir DIR` enables
filesystem durability. `--help` lists identity/revision options. There is no
implicit provider, model, token, or native host call.

## Private driver composition

A host with an idempotent capability may import the private composition module
(`lunacy-runtime/dist/composition.js`) and provide `dispatch(command,
launchToken, signal)` plus optional `observe(launchToken)`. The command and
receipt must echo the exact launch token and command digest. `timeoutMs`, an
`AbortSignal`, and a private `onYield` wake-up callback are optional. RESUME
durably claims first, returns immediately, and lets the fenced dispatcher later
commit `ACKED` or `UNKNOWN`; a live in-process call is not prematurely marked
UNKNOWN, and a late matching receipt can reconcile it. If no driver is
composed, the kernel returns `BLOCKED` with `HumanReceiptRequired`; it never
pretends that a launch occurred. `composeKernel` still returns only `RunKernel`
and does not add a public lifecycle.

See [API](API.md), [durability](DURABILITY.md), and [acceleration](ACCELERATION.md)
for the contract and recovery behavior.

## Managed skill deployment and Codex drive

The package-root install intentionally has no provider or native-host side
effects. To install the private runtime-to-skill bridge, build this checkout
and deploy it to an exclusively-owned skill root:

```sh
npm run deploy:skill -- --target /absolute/path/to/skill-root
"$NODE" tools/deploy-skill.mjs --target /absolute/path/to/skill-root --check
```

Deployment writes only the managed `runtime/` directory and its canonical
fingerprint. It stages and verifies a complete sibling tree, then atomically
renames the whole managed directory with a durable recovery marker; stale files
under deployment-owned namespaces cannot survive a redeploy. Unrelated
skill-root files (and explicitly unowned runtime files) are preserved. The
payload includes the private bridge/driver/supervisor modules,
the exact Codex worker/launch/terminal schemas, and the capability probe. The
launcher verifies those bytes before importing them; `--check` must report
`status: current` before a host uses the bundle. It never installs a package,
searches `PATH`, edits the rest of the skill, or publishes a release.

Every `--check`, deploy, and restore first claims the target with one
kernel-atomic `.lunacy-runtime-deploy.lock` and holds that claim through
recovery, publication, and cleanup. A live owner is rejected rather than
adopted; a lock left by an interrupted process is reclaimed only after its
durable owner identity is proven dead. Transaction stages, backups, failed
trees, and marker temporary names are bound in the exclusive marker before
first use, so recovery never scans or deletes a regex-matching sibling. Files
and nested directories are synchronized bottom-up, and a final inode/content
fence rejects an unowned runtime mutation immediately before exchange.

### Private production release boundary

The compatibility commands above remain appropriate only for disposable/local
targets. A production deploy, check, restore, or redeploy must also pass
`--release-manifest /absolute/canonical/manifest.json`. The canonical manifest
uses schema `lunacy-release-operation/v1` and closes `operation`,
`installedTarget`, byte-sorted `discoveryParents`, byte-sorted `runRoots` (an
explicit empty array is allowed), and an initially absent
`processSnapshotPath` outside all release-owned trees. Discovery under the
authorized parents must equal the root list exactly; symlinks, aliases,
unlisted roots, missing roots, and overlapping boundaries are red.

The command acquires durable exact-owner exclusion before its final pure
quiescence verification and retains it through the relying target mutation.
After the exclusion markers appear, capture the canonical
`lunacy-process-snapshot/v1` input and bind it to that exact owner with:

```sh
"$NODE" runtime/tools/bind-release-process-snapshot.mjs \
  --release-manifest /absolute/canonical/manifest.json \
  --snapshot /absolute/fresh/process-snapshot.json
```

The binder exclusively creates the manifest's response path only when the
same live exact owner holds every anchor. Missing, stale, pre-existing, or
owner-mismatched evidence fails closed. Acquisition order is discovery/target
release claims, per-run bridge claims, per-run writer claims, and finally the
target deploy lock; cleanup removes only exact inode-and-byte-matching claims.

### Private resumable release envelope (opt-in)

The existing deploy/check/restore commands remain unchanged unless the
operator explicitly adds `--release-envelope`.  That flag creates the exact
`.lunacy-release-operation.v2.json` marker beside the installed `runtime/`
tree and records only operation/manifest/target/owner/snapshot digests and a
small phase (`prepared`, `admitted`, `quiesced`, `delegated`, `committed`, or
`attention`).  The marker is a projection and never replaces the release
manifest, exclusion claims, target lock, quiescence proof, or inner deployment
transaction.  A prior interrupted operation may be explicitly retried with
`--resume-release`; owner liveness, manifest/target identity, snapshot, and the
inner marker are revalidated before delegation.  A read-only status check is:

```sh
node tools/deploy-skill.mjs --target /absolute/skill-root \
  --release-envelope-status [--release-manifest /absolute/manifest.json]
```

Status acquires no lock, performs no discovery or cleanup, and emits a bounded
canonical capsule.  It never infers approval or relaunches an uncertain inner
operation.  Removing the flag disables the route and preserves the legacy
transaction bytes and CLI output.
Malformed or live/replaced ownership is never cleaned, and the boundary never
signals or kills a run merely to obtain green.

### Audited 0.2.12 restore

A rollback bundle is an immutable `runtime/` payload plus a closed
`inventory.json` attestation. The attestation must name only deployment-owned
files, include their exact SHA-256 digests and aggregate, and state
`runtimeVersion: "0.2.12"` and the installed rollback bridge identity
`bridgeVersion: "0.1.0"`. The restore operation
rejects mutable or extra payload files, preserves explicitly unowned files in
the installed runtime, removes candidate-only owned files, and uses the same
recoverable complete-tree transaction as deployment. It never reads a rollback
path from the ambient `PATH` or from a mutable release manifest.

The inventory is canonical JSON with exactly these top-level fields:
`schema: 1`, `bridgeVersion`, `runtimeVersion`, `manifestDigest`,
`launcherDigest`, `aggregate`, and `files`. Each `files` item has exactly
`path` (`runtime/...`) and its 64-hex `digest`; `aggregate` is the SHA-256 of
the sorted `path\0digest` lines. The payload must contain exactly those files,
including `runtime/DEPLOYMENT.json` and `runtime/bridge.mjs`.

Use the following literal command shape only after independently attesting the
bundle and recording its aggregate (the command derives the recorded value so
the inventory and argument cannot disagree):

```sh
NODE=/absolute/path/to/attested/node
TARGET=/absolute/path/to/skill-root
PAYLOAD=/absolute/path/to/rollback-0.2.12/runtime
INVENTORY=/absolute/path/to/rollback-0.2.12/inventory.json
AGGREGATE="$("$NODE" -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).aggregate)' "$INVENTORY")"
RESTORED="$("$NODE" tools/deploy-skill.mjs --target "$TARGET" --restore \
  --payload "$PAYLOAD" --inventory "$INVENTORY" --aggregate "$AGGREGATE")"
printf '%s\n' "$RESTORED"
```

The restore command emits `status: "restored"`, the attested rollback
aggregate, manifest/launcher digests, and the complete managed-tree aggregate;
that output is the exact post-publication verification. The ordinary `--check`
command checks the current source release (0.3.0), so it is intentionally run
after the identical 0.3.0 redeploy rather than immediately after rollback. The
command is closed: `--restore` requires all three arguments, rejects `--check`
in the same invocation, and accepts no inventory fields beyond the attested
schema. A first-red recovery or process crash is retried by the next identical
invocation; no marker, stage, backup, or failed sibling may remain.

The one-event route remains the compatibility/manual path. An explicitly
attested host may instead invoke the private event-driven pump with a closed
policy:

```sh
"$NODE" runtime/bridge.mjs drive --run-dir RUN --run-id ID --mode runtime \
  --plan PLAN.json --policy POLICY.json
```

The pump removes only the parent's repetitive mechanical loop. Parent intent,
approval, stop/redirect, gate, adoption, and final-result decisions remain
authoritative. If no conforming driver is bound, the runtime still returns the
truthful `HumanReceiptRequired` block rather than pretending to have launched
Codex. See [BRIDGE](BRIDGE.md) and [CODEX_EXEC](CODEX_EXEC.md) for the private
contract and capability probe.
