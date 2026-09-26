# Lunacy native

Lunacy is an explicitly selected workflow for genuinely new authorized tasks,
including engineering, research, writing, and system maintenance. Selection
does not itself authorize deletion, transmission, purchases, or other effects.
Astra owns planning and acceptance; a bounded native worker owns its assigned
delivery, verification, report, and logs. This release candidate keeps
the repository's root-level Codex skill layout and workflow contract `0.1.29`.

The ordinary path is: **establish authority and scope -> bind coherent
ownership and exact literal routes -> deliver, check, and report -> parent
independently accepts**. Small or coupled work keeps one owner; larger work assesses the canonical [ready-work parallel policy](orchestrator/PLANNING.md#ready-work-parallel-delivery) and dispatches useful safe ready assignments within observed host and execution-resource limits. The configurable 64-total-agent target is prospective, not a claim that this host supports it. Start with [SKILL.md](SKILL.md); it links only the
canonical detail needed for each action. Use ordinary Lunacy for a known
outcome unless Golden is explicitly selected. Explicit Golden
selection for any outcome—including known implementation—keeps the full path
in [IMPROVEMENT.md](orchestrator/IMPROVEMENT.md); it is never silently reduced
to ordinary delivery.

### Task-local worker pace

`super-parallel` with `worker limit: 22` is the default for a new task. It
prepares and launches the largest safe ready wave before waiting, without
inventing work to fill slots. Override the mode or limit for a quieter task:

```text
$lunacy-native:lunacy Implement the adopted API and CLI changes.
Parallel mode: normal. Worker limit: 2.
```

The limit counts child assignments, not the parent; it cannot raise the host's
actual capacity, force pointless splits, or cancel already running work. Golden keeps
its five breadth and three focus outputs, using cap-sized waves when necessary.
The parent [refills on meaningful events and checks before waiting](orchestrator/PLANNING.md#event-driven-parent-refill),
not by busy-polling. A [bounded read-only scout](orchestrator/PLANNING.md#opportunity-scout)
is optional only when a named uncertainty could reveal useful next work; it
counts against the same limit and cannot launch workers. See the
[dispatch mode and wave protocol](orchestrator/PLANNING.md#dispatch-modes-and-wave-protocol).

### Optional research swarm

For an uncertain outcome, explicitly request a research swarm or select
`research: on`; research is otherwise off. It is independent of
`normal`/`super-parallel` dispatch:

```text
$lunacy-native:lunacy Investigate <question> before proposing delivery.
research: on. research budget: 8 probes. Parallel mode: normal.
```

The default finite budget is **8 probe assignments**, not a target;
`research budget: N probes` overrides it with a positive integer. A probe is a
bounded evidence-producing investigation or experiment, including independent
experimental verification—not a summary or the at-most-one optional
[opportunity scout](orchestrator/PLANNING.md#opportunity-scout).
`research: off` stops new probes without cancelling or rebinding live work.
The [research protocol](orchestrator/RESEARCH-SWARM.md) uses existing TASK
records, root-only dispatch, worker limits, ownership/custody and acceptance.
New workers still default to `gpt-6-luna` / `max` unless explicitly overridden;
research never replaces Golden's required stages or their ordering.

An optional [continuous-improvement mode](orchestrator/IMPROVEMENT.md) adds a
slow strategy loop around fast, acceptance-first delivery for user-authorized
ongoing plugin improvement. Ordinary work keeps the existing low-overhead
path and does not automatically invoke strategy consultations.

In the installed plugin, invoke **`$lunacy-native:golden <your task>`** for the
golden workflow: a task-selected consultation (Astra/high by default), actual ADHD
using a task-local uniform or opt-in staged model/effort binding (`gpt-6-luna / max`
uniformly by default), `gpt-6-luna / max` by default for
substantive design and solution authorship, adopted planning, Lunacy worker
delivery, and independent acceptance. Selected ADHD workers generate, deepen, and
repair proposals and author the final provocation; Astra in its parent role exercises
judgment to evaluate, select, and adopt, while its adviser role provides bounded
evidence-only advice, not replacement idea or solution authorship.
This is a distinct shortcut in the same plugin, not another installed version. Finite
tasks stay finite; ongoing improvement requires your request. Ordinary
`lunacy-native:lunacy` behavior is unchanged.

Lunacy can handle a newly authorized, scoped task in an existing repository when
current authority and ownership/effect checks permit it; “new” describes the
work, not the repository's age. A new Codex task, filename, or installation does
not turn an existing or uncertain run into new work or migrate its contract,
owner, or effects. Separate new work proceeds only when its actual independence
is established.

Lunacy is guidance for the current parent and its workers, not an autonomous
model runner. The parent plans and accepts; Astra/high is the recommended parent
preset, but Golden neither selects nor verifies it. If the actual parent setting
is unconfirmed, say so rather than claiming Astra is running. Every meaningful
Golden outcome uses a real consultation followed by actual ADHD, even for routine
work; this extra strategy cost is why ordinary Lunacy remains the lighter path.
Worker choices are task-local and do not change the parent, consultation,
or ADHD route. Golden's distinct ADHD selector is also task-local: use
`choose ADHD workers`, or supply `ADHD workers: gpt-6-astra / low`, for one exact
uniform pair. To opt into stage-specific routing, use
`ADHD stages: breadth gpt-6-luna / max; focus gpt-6-astra / low`. Omission keeps
uniform `gpt-6-luna / max`; both explicit pairs are verified and sealed before
any generator, without silent substitution. See [ADHD worker selection](orchestrator/IMPROVEMENT.md#adhd-worker-selection-route-and-sealing)
for catalog validation, sealing, and boundary rules. Architecture-only work stays
architecture-only, and the optional evidence/catalog helpers do not launch
workers or establish correctness.

For a design-only roadmap through the existing Golden route, use:

```text
$lunacy-native:golden Design a roadmap for <outcome>. Architecture only; do not implement.
```

The output is a prioritized design and a detailed proposal for the next coherent
slice—not implementation, tests, builds, probes, environment changes, or
publication. “Continue” remains design-only in that task. A later explicit
implementation request still requires review of the current source and
constraints plus new adoption and assignments under the canonical
[authority contract](WORKSPACE.md#authority-entry-and-coexistence). This example
adds no new mode and does not change ordinary finite work.

### Consultation choice

Golden also accepts a separate task-local consultation choice. With no override,
or `Consultation: astra-high`, each new unbound Golden cycle selects a fresh
native `gpt-6-astra` / `high` adviser without first trying Pro. Explicit
`Consultation: pro` selects direct `chatgpt-web/pro` / `ultra`.
`Consultation: auto` prefers Pro and permits
Astra/high only when Pro is known unavailable before binding and dispatch; stale
or generic quota text is not enough, and unknown availability does not justify a
probe. Keep consultation packets small under the [bounded advice
policy](orchestrator/IMPROVEMENT.md#direct-exact-web-pro-advice). Automatic
failover after a started or uncertain consultation attempt is not enabled: preserve the
attempt and do not replay it. These choices do not change workers, the parent,
global settings, or parent acceptance. An override continues within its task;
a future task without an override returns to Astra/high. Existing task bindings
are not migrated, and applicable same-cycle advice is reused.

The policy targets a small, cold-complete parent packet and keeps its short
leading rubric stable where practical. That is cache-friendly, not evidence that
native or ChatGPT-web consultation is cache-heavy: parent UTF-8 bytes exclude
host-injected context, and route cache-counter semantics and billing remain
unverified. Count the final wrappers and attachments, preserve raw usage fields
when available, and make no savings claim from a missing or zero cache count.

Golden records its compact current cycle/stage, real output references, existing
assignment/handle references, and next action in the one parent-owned `TASK.md`.
On resume it reconciles those facts instead of redispatching completed stages.
Missing required consultation or ADHD pauses dependent progression; it is never
silently replaced. Coherent delivery slices and same-owner repair remain in the
same cycle. A materially distinct later outcome starts a fresh consultation and
ADHD cycle, while an accepted finite task remains complete on stale continuation.
Architecture-only or source-only authority still produces only those artifacts.

## Release status

Version `0.2.0-rc.1` is a native-guidance release candidate. The package has
offline structural, documented shell-recipe, catalog/selection, and observer
tests. It has no claim of proven live reliability, route availability, model obedience, speed,
cost, cache behavior, or savings.

Ordinary hot-path compression is implemented and covered by the offline
structural scenario corpus. The corpus includes default/affirmative/negated Sol
routing, unknown dispatch return, stale proof, dirty/untracked work, and late
cancellation cases. These are cited human-evaluation cases, not an executable
policy engine or evidence of live model obedience; no live cohort was run.

Cold-complete assignment and acceptance-evidence views are optional templates
inside the existing TASK assignment and worker report. They add no required
ledger, parser, launcher, reviewer, or check. The offline corpus covers their
structure and negative controls; it does not demonstrate live model behavior.

Compaction recovery now uses the same TASK coordination and immutable pointers,
with structural interruption cases for bounded human review. It adds no resume
inspector, scheduler, retry engine, or claim of live recovery behavior.

## Native routes

| Route | Exact model | Effort | Selection |
| --- | --- | --- | --- |
| `luna` | `gpt-6-luna` | `max` | default named worker route |
| `sol-medium` | `gpt-5.6-sol` | `medium` | explicit task-local `use Sol medium` or exact pair |
| `sol-high` | `gpt-5.6-sol` | `high` | explicit selection only |

`luna` is the only implicit worker default: both **bulk** and **judgment** start
at `gpt-6-luna` / `max`. `sol-medium` and `sol-high` require explicit
task-local selection; for hard delivery, diagnosis, or discriminating
verification, a clear affirmative request such as `use Sol medium` opts only the
`judgment` assignment into `gpt-5.6-sol` / `medium`. Quoted, negated,
hypothetical, or incidental mentions are not authorization. Difficulty or
worker failure never opts in, and the request does not change all work, the
parent, or a live assignment. At launch
you can choose separate **bulk** and **judgment** worker models from the current
Codex catalog; this `choose workers` selector does not select ADHD workers:

```text
$lunacy-native:golden choose workers; build <your feature>
```

Or supply both pairs directly (examples must still exist in your live catalog):

```text
$lunacy-native:golden build <your feature>.
Workers: bulk = opencode-go/muse-spark-1.3-contributor / low;
judgment = gpt-6-astra / low.
```

The selector asks in the conversation, using catalog names and reasoning
options; it does not add controls to Codex's native picker or change global
settings. No customization request means the existing defaults. Unspecified
roles keep their defaults; custom roles do not rename the fixed aliases or
change the parent, ADHD, or the consultation choice. Selecting a custom model never inherits
Luna's `max` effort: choose a supported effort or explicitly its catalog default.
See [Worker model selection](orchestrator/WORKER-MODELS.md) for catalog/helper
commands, launch transport selection, and capability limits. Availability in a
catalog is not proof that a particular worker tool supports that model.

The parent seals each literal model/effort pair and chosen transport before
dispatch. Unsupported or conflicting pairs are refused; there is no probing,
silent fallback, or mid-attempt route change.

## Install or update: choose one native delivery channel

Use either the existing plugin channel or the standalone skill channel, not
both. They expose different invocation names:

- one installed plugin exposes `lunacy-native:lunacy` and the `lunacy-native:golden` shortcut;
- the optional standalone copy below exposes `$lunacy-native`;
- an installed legacy skill remains `$lunacy`.

Do not overwrite, move, edit, or automatically re-enable a legacy `$lunacy`.
Its files and disabled state remain intact for recovery under the authority of
its existing work. If duplicate entries are already visible, disable the
unintended entry through the supported Codex Plugins or Skills UI rather than
removing or moving its directory.

Execution roots are explicit throughout this section. `<source-checkout>` owns
release composition, maintainer tools, and the complete source tests;
`<ordinary-skill-root>` owns shipped runtime helpers for a standalone skill;
`<plugin-root>` is an already-built plugin artifact; and
`<external-plugin-creator-root>` owns plugin validation and cachebuster helpers.
A copied artifact README is guidance, not evidence that source-only commands or
their omitted `packaging/` and `maintainer/` modules are present there.

### Build the plugin from this release

The root remains the standalone Lunacy skill. The `packaging/` directory holds
Golden and the plugin manifest; it is a build input, not a complete plugin.
Build a self-contained plugin outside this checkout at a **new** destination.
This is a **source-checkout-only** command; run it from `<source-checkout>`:

```sh
cd <source-checkout> || exit
python3 -B packaging/build_plugin.py /path/to/staging/lunacy-native
```

The builder copies the root skill and Golden into sibling `skills/lunacy` and
`skills/golden` directories, so shared references resolve without symlinks or
duplicating maintained source. It refuses existing destinations (including
symlinks) and destinations inside the checkout. Selected build inputs must be
regular files and real directories: source symlinks and special filesystem
nodes are refused before the output is created. Build from a quiescent ordinary
checkout; this metadata preflight is not an atomic snapshot and does not protect
against hostile concurrent replacement. On a later copy failure, the new partial
output is retained for inspection; it is not an installable success.

Before creating a fresh destination, the plugin builder validates local links
and fragments supported by the existing narrow grammar: inline
Markdown links with a relative path and optional fragment, outside backtick or
tilde fenced blocks. Reference-style links, autolinks, images, raw HTML links,
and inline-code interpretation remain outside this checker. The selected owners are root
`SKILL.md`, `WORKSPACE.md`, `OPERATOR.md`, and
`README.md`; every regular file recursively below `orchestrator/` or `worker/`
whose suffix case-folds to `.md`; and plugin-only Golden `SKILL.md`. A directory
whose name ends in `.md` is not itself an owner, but qualifying files below it
are. `scripts/` and `tests/` remain valid published link targets, not owners;
`LICENSE`, non-Markdown and generated files, and other template Markdown are
also not owners. This finite selection does not follow links to discover more
owners and does not broaden the standalone, default-validator, or package
validator policies.

It does not register, install, enable, or migrate anything. For an existing
plugin, compare the output with the confirmed marketplace source, apply only
the intended release files there, preserve its local version suffix until the
cachebuster step, and use the update flow below. For a first plugin install,
use the installed `plugin-creator` skill to register this built package in your
chosen marketplace. Do not also enable a standalone native copy.

Maintainers can verify packaging without installing or contacting a model.
This is also **source-checkout only**; run it from `<source-checkout>`:

```sh
cd <source-checkout> || exit
python3 -B -m unittest discover -s packaging -p 'test_*.py' -v
```

They can also run the synthetic counterexample pilot and create or verify a
deterministic package inventory receipt without installing anything. These
`maintainer` commands are **source-checkout only** and are not included in a
fresh plugin or standalone artifact:

```sh
cd <source-checkout> || exit
python3 -B -m unittest discover -s maintainer/tests -p 'test_*.py' -v
python3 -B -m maintainer.package_receipt create \
  --package-dir /path/to/staging/lunacy-native \
  --identity 'lunacy-native@candidate' \
  --output /path/outside/staging/receipt.json
python3 -B -m maintainer.package_receipt verify \
  --package-dir /path/to/staging/lunacy-native \
  --receipt /path/outside/staging/receipt.json
```

For a reproducible documentation-footprint baseline, run from
`<source-checkout>` (**source-checkout only**):

```sh
cd <source-checkout> || exit
set -C
python3 -B -m maintainer.read_footprint --root . > /tmp/lunacy-footprint.json
```

The report counts UTF-8 bytes and regex words for declared complete-file read
sets. Words are not model tokens, and declared sets are not a measurement of
what a host actually loaded into context. Compare reports only when their
schema and declarations match. The CLI writes only to stdout; shell noclobber
above makes the example refuse an existing destination.

Create refuses an existing output (including a symlink) and any resolved output
inside the package, so it cannot overwrite package content. Run it only on a
trusted, quiescent tree: its `lstat`/open sequence is not hostile-race safe.
The identity and source labels are caller-supplied and do not prove manifest or
repository identity. The pilot is a small synthetic lifecycle example, not live
agent evidence or proof of overall Lunacy correctness.

### Update an existing plugin (preferred for plugin users)

If `lunacy-native` is already installed as a plugin, keep that delivery channel.
Do **not** copy this skill into standalone discovery as an update.

First use `codex plugin list` and the installed `plugin-creator` guidance to
confirm the enabled `lunacy-native@<marketplace>` identity, that its marketplace
is local, and that its entry points at the plugin source you intend to edit.
Do not assume the marketplace is named `personal`. From the installed
`plugin-creator` skill root, validate that source, read the name from its actual
marketplace file, replace the manifest cachebuster, and reinstall the same
identity. In the commands below, `<external-plugin-creator-root>` is the
installed helper root and `<plugin-root>` is the already-built plugin source:

```sh
cd <external-plugin-creator-root> || exit
python3 scripts/validate_plugin.py /path/to/existing/lunacy-native-plugin || exit
marketplace_name="$(python3 scripts/read_marketplace_name.py \
  --marketplace-path /path/to/actual/marketplace.json)"
helper_status=$?
if [ "$helper_status" -ne 0 ]; then
  exit "$helper_status"
fi
if [ -z "$marketplace_name" ]; then
  printf '%s\n' 'marketplace helper returned an empty identity' >&2
  exit 1
fi
python3 scripts/update_plugin_cachebuster.py \
  /path/to/existing/lunacy-native-plugin || exit
codex plugin add "lunacy-native@${marketplace_name}"
```

The marketplace helper's stdout is the identity data channel; stderr remains
diagnostic and is not part of the final selector.

For the default personal marketplace file, follow `plugin-creator` and omit
`--marketplace-path`; it is discovered implicitly and must not be added again.
For a different marketplace, follow its documented configured-local-marketplace
checks. Stop if the selected entry is remote or points at another source; this
update flow does not rewrite marketplace or Codex configuration. Start a new
task after reinstall so Codex loads the updated plugin, then invoke
`lunacy-native:lunacy`.

Validation, cachebusting, and reinstall update registration metadata and ask
the host to reload; they do **not** transfer release bytes into `<plugin-root>`.
Before this sequence, manually compare the fresh artifact with `<plugin-root>`
and apply only the intended files, or stop. No command here automates that
operator-owned comparison or transfer.

To roll back a plugin update, restore the previously accepted plugin source and
repeat the same validated cachebuster/reinstall flow for the same identity.
That does not authorize enabling, deleting, moving, or migrating any standalone
or legacy installation.

### Install a standalone skill instead

Use this alternative only when no native plugin is enabled and standalone
installation is the selected delivery channel. The canonical source skill
remains named `lunacy`. Begin with an authorized `<source-checkout>` outside
skill discovery at a revision that contains both `packaging/build_standalone.py`
and `packaging/release_inputs.py`; stop if either prerequisite is absent. This
public root-level checkout is copy source, not a directly installable plugin
package. These instructions do not assert that any named remote branch contains
the composer.

The source composer below checks only its filesystem inputs; it does not inspect
enabled skills or plugins. It refuses an existing destination, validates the
complete shared release inventory and its selected shipped guidance before
creating output, excludes native `__pycache__`, `*.pyc`, and `*.pyo`, and changes
exactly the validated frontmatter `name: lunacy` line in the output `SKILL.md` to
`name: lunacy-native`. Use a trusted, quiescent source checkout: the preflight is
not an atomic snapshot and does not protect against hostile concurrent changes;
a later copy failure retains the partial directory for inspection. Do not change
the source checkout's canonical name or mix files from the legacy installation.
No installer or automatic cutover is provided. `packaging/` and `maintainer/`
remain intentionally absent from the completed artifact.
Run this **source-checkout-only** command from `<source-checkout>`; `packaging/`
and `maintainer/` are intentionally absent from the finished artifact:

```sh
dest="${CODEX_HOME:-$HOME/.codex}/skills/lunacy-native"
cd <source-checkout> || exit
if [ ! -f packaging/build_standalone.py ] || [ ! -f packaging/release_inputs.py ]; then
  printf '%s\n' 'source revision lacks the standalone composer prerequisites' >&2
  exit 66
fi
python3 -B packaging/build_standalone.py "$PWD" "$dest"
```

Start a new task after copying, and invoke `$lunacy-native` only for genuinely
new work whose current project/user authority explicitly adopts workflow
contract `0.1.29`. Existing work remains
on `$lunacy` and its original contract, route, history, effects, and recovery
owner; installation never migrates it. Roll back this standalone mode only by
removing its separate inactive `lunacy-native` directory after establishing
that no active or uncertain owner depends on it. This does not authorize any
plugin change. Legacy files and their disabled state stay intact.

## Validate

The observer uses only the Python standard library. These validation commands
are **source-checkout only**; run them from `<source-checkout>`. A fresh plugin
or standalone artifact intentionally has neither `packaging/` nor `maintainer/`:

```sh
cd <source-checkout> || exit
python3 -B ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
python3 -B -m unittest discover -s tests -p 'test_install_recipes.py' -v
python3 -B -m unittest discover -s tests -p 'test_worker_models.py' -v
python3 -B -m unittest discover -s tests -p 'test_run_command.py' -v
python3 -B -m unittest discover -s tests -v
```

The focused recipe tests extract the commands above from this README and use
disposable local stubs and directories; they do not install a plugin, contact a
model or the network, or validate live routing.

The optional observer is documented in
[OPERATOR.md](OPERATOR.md#optional-evidence-index-helper). It reads an already
captured, authorized JSONL file and never launches models or changes evidence.
For an oversized `direct-exec` projection, its narrow opt-in
`--correlate first-nonzero` operation can return the first existing item-ID
group containing a nonzero integer exit. It preserves first-observation group
order, fully validates the snapshot, and emits no command or output text. Use
the returned item ID and source SHA-256 with the unchanged `--item-id` form for
exact retrieval. Continuation with the returned exclusive ordinal requires the
same source hash; an indivisible result that exceeds the requested output cap
is refused rather than skipped or shortened. See the operator reference for
the exact command and limitations, including the host's integer-conversion
ceiling for very large continuation ordinals.

For exact lookup of one current ordinary trigger, the optional
[`scripts/context_excerpt.py`](scripts/context_excerpt.py) navigator emits the
complete trigger row, governing before-action caveat, live direct heading or
whole-file excerpts, and quoted-but-unfollowed nested links. It is a bounded
read-only navigation aid, not an authority resolver or recursive obligation
map. The exact `Overlap, unknown authority/effects, deadline, recovery` selector
keeps its existing destinations and adds recovery; `Adopted task deadline`
selects deadline planning only, after shared authority and barrier context.
Returned text grants no custody or authorization. See
[OPERATOR.md](OPERATOR.md#optional-action-context-navigator).

For one already-authorized local argv on a POSIX host,
[`scripts/run_command.py`](scripts/run_command.py) provides an optional actual
deadline, cancellation escalation, byte-bounded output logs, and optional
bounded raw regular-file stdin snapshot. The default `--log` form keeps its
merged stdout/stderr bytes and result shape. An opt-in pair of `--stdout-log`
and `--stderr-log` preserves channel identity under one statically partitioned
capture ceiling, allowing a caller to consume exact structured stdout while
retaining diagnostics separately. Omitted input retains the existing `DEVNULL`
behavior. Present-input counts report parent-side kernel acceptance and EOF
closure, not child consumption; acquisition is not an atomic filesystem
snapshot or part of the command deadline. Its JSON keeps direct-parent,
capture, input-transport, and termination facts separate; it is not a
workflow/model launcher, a live CLI compatibility claim, or proof that
descendants and side effects settled.
See the [large-output command reference](OPERATOR.md#large-output-command-reference).

For an explicitly requested, offline token and API-equivalent cost summary of
selected receipts, see [optional usage metrics](orchestrator/USAGE-METRICS.md).
The helper is not an automatic collector, billing meter, or global scan.

## Files

- [SKILL.md](SKILL.md) — entry, scope, routing, and required reads.
- [WORKSPACE.md](WORKSPACE.md) — authority, ownership, records, and acceptance.
- [orchestrator/PLANNING.md](orchestrator/PLANNING.md) — Astra planning,
  dispatch, deadline, and recovery rules.
- [orchestrator/IMPROVEMENT.md](orchestrator/IMPROVEMENT.md) — optional
  execution-first continuous-improvement mode.
- [orchestrator/WORKER-MODELS.md](orchestrator/WORKER-MODELS.md) — task-scoped
  model choices from the live Codex catalog; no global configuration changes.
- [`scripts/worker_models.py`](scripts/worker_models.py) — read-only catalog and
  offline role resolver; never launches a worker.
- [worker/ENGINEERING.md](worker/ENGINEERING.md) — worker execution contract.
- [OPERATOR.md](OPERATOR.md) — large-output recipe and observer reference.
- [`scripts/evidence_index.py`](scripts/evidence_index.py) — bounded read-only
  evidence projection.
- [`scripts/run_command.py`](scripts/run_command.py) — optional POSIX one-shot
  direct-argv deadline, cancellation, and bounded-capture helper.
- [`scripts/context_excerpt.py`](scripts/context_excerpt.py) and
  [`scripts/read_map_core.py`](scripts/read_map_core.py) — optional bounded
  direct action-context navigation and its shared standard-library parser.
- [orchestrator/USAGE-METRICS.md](orchestrator/USAGE-METRICS.md) and
  [`scripts/usage_report.py`](scripts/usage_report.py) — optional offline token
  and dated API-equivalent cost reporting for caller-selected receipts.
- [`tests/`](tests/) — offline documented-recipe, worker-selection, observer,
  and disposable local command-runner regression suite.

## Legacy change

The earlier `references/CODEX_LUNA_COMPAT.md` catalogue-mutation and retry
guidance is intentionally absent. Native routing has no probe or fallback.
Keep an old installation intact until its active and unresolved effects are
settled and a safe whole-installation migration and rollback path is recorded.

Licensed under the [Apache License 2.0](LICENSE).
