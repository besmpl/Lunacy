# Lunacy native

Lunacy is an explicitly adopted workflow for genuinely new engineering work.
Astra owns planning and acceptance; a bounded native worker owns its assigned
implementation, verification, report, and logs. This release candidate keeps
the repository's root-level Codex skill layout and workflow contract `0.1.29`.

An optional [continuous-improvement mode](orchestrator/IMPROVEMENT.md) adds a
slow strategy loop around fast, acceptance-first delivery for user-authorized
ongoing plugin improvement. Ordinary engineering keeps the existing low-overhead
path and does not automatically invoke strategy consultations.

In the installed plugin, invoke **`$lunacy-native:golden <your task>`** for the
golden workflow: parent-led planning, conditional ADHD/Web Pro, worker delivery,
and independent acceptance. This is a distinct shortcut in the same plugin,
not another installed version. Finite tasks stay finite; ongoing improvement
requires your request. Ordinary `lunacy-native:lunacy` behavior is unchanged.

## Release status

Version `0.2.0-rc.1` is a native-guidance release candidate. The package has
offline structural, documented shell-recipe, and observer tests only. It has no
claim of proven live reliability, route availability, model obedience, speed,
cost, or savings.

## Native routes

| Route | Exact model | Effort | Selection |
| --- | --- | --- | --- |
| `luna` | `gpt-5.6-luna` | `max` | default named worker route |
| `sol-medium` | `gpt-5.6-sol` | `medium` | default named worker route |
| `sol-high` | `gpt-5.6-sol` | `high` | explicit selection only |

The parent must seal the literal model/effort pair before dispatch. Current
authority may instead authorize another exact native pair for a specific worker
purpose. Unsupported or conflicting pairs are refused; there is no probing,
normalization, fallback, or mid-attempt route change.

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

### Build the plugin from this release

The root remains the standalone Lunacy skill. The `packaging/` directory holds
Golden and the plugin manifest; it is a build input, not a complete plugin.
Build a self-contained plugin outside this checkout at a **new** destination:

```sh
python3 -B packaging/build_plugin.py /path/to/staging/lunacy-native
```

The builder copies the root skill and Golden into sibling `skills/lunacy` and
`skills/golden` directories, so shared references resolve without symlinks or
duplicating maintained source. It refuses existing destinations (including
symlinks) and destinations inside the checkout. On a copy failure, the new
partial output is retained for inspection; it is not an installable success.
It does not register, install, enable, or migrate anything. For an existing
plugin, compare the output with the confirmed marketplace source, apply only
the intended release files there, preserve its local version suffix until the
cachebuster step, and use the update flow below. For a first plugin install,
use the installed `plugin-creator` skill to register this built package in your
chosen marketplace. Do not also enable a standalone native copy.

Maintainers can verify packaging without installing or contacting a model:

```sh
python3 -B -m unittest discover -s packaging -p 'test_*.py' -v
```

### Update an existing plugin (preferred for plugin users)

If `lunacy-native` is already installed as a plugin, keep that delivery channel.
Do **not** copy this skill into standalone discovery as an update.

First use `codex plugin list` and the installed `plugin-creator` guidance to
confirm the enabled `lunacy-native@<marketplace>` identity, that its marketplace
is local, and that its entry points at the plugin source you intend to edit.
Do not assume the marketplace is named `personal`. From the installed
`plugin-creator` skill root, validate that source, read the name from its actual
marketplace file, replace the manifest cachebuster, and reinstall the same
identity:

```sh
python3 scripts/validate_plugin.py /path/to/existing/lunacy-native-plugin || exit
python3 scripts/read_marketplace_name.py \
  --marketplace-path /path/to/actual/marketplace.json || exit
python3 scripts/update_plugin_cachebuster.py \
  /path/to/existing/lunacy-native-plugin || exit
codex plugin add 'lunacy-native@<validated-marketplace-name>'
```

For the default personal marketplace file, follow `plugin-creator` and omit
`--marketplace-path`; it is discovered implicitly and must not be added again.
For a different marketplace, follow its documented configured-local-marketplace
checks. Stop if the selected entry is remote or points at another source; this
update flow does not rewrite marketplace or Codex configuration. Start a new
task after reinstall so Codex loads the updated plugin, then invoke
`lunacy-native:lunacy`.

To roll back a plugin update, restore the previously accepted plugin source and
repeat the same validated cachebuster/reinstall flow for the same identity.
That does not authorize enabling, deleting, moving, or migrating any standalone
or legacy installation.

### Install a standalone skill instead

Use this alternative only when no native plugin is enabled and standalone
installation is the selected delivery channel. The canonical source skill
remains named `lunacy`. Clone the release outside skill discovery; this public
root-level skill checkout is copy source, not a directly installable plugin
package:

```sh
git clone --branch release/native-0.2.0-rc.1 --single-branch \
  https://github.com/besmpl/Lunacy.git \
  /path/to/lunacy-native-source
```

The shell guard below checks only whether its filesystem destination already
exists; it does not inspect enabled skills or plugins. It refuses an existing
destination, copies this public skill tree to
`${CODEX_HOME:-$HOME/.codex}/skills/lunacy-native`, and changes exactly the
frontmatter `name: lunacy` line in the copied `SKILL.md` to
`name: lunacy-native`. Do not change the source checkout's canonical name or
mix files from the legacy installation. No installer or automatic cutover is
provided.

```sh
src=/path/to/lunacy-native-source
dest="${CODEX_HOME:-$HOME/.codex}/skills/lunacy-native"
if [ -e "$dest" ] || [ -L "$dest" ]; then
  printf 'refusing existing destination: %s\n' "$dest" >&2
  exit 73
fi
mkdir "$dest" || exit
cp "$src/SKILL.md" "$src/WORKSPACE.md" "$src/OPERATOR.md" \
  "$src/README.md" "$src/LICENSE" "$dest/" || exit
cp -R "$src/orchestrator" "$src/worker" "$src/scripts" "$src/tests" "$dest/" || exit
python3 -B - "$dest/SKILL.md" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
old = "name: lunacy\n"
if text.count(old) != 1:
    raise SystemExit("refusing unexpected SKILL.md name field")
path.write_text(text.replace(old, "name: lunacy-native\n"), encoding="utf-8")
PY
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

The observer uses only the Python standard library.

```sh
python3 -B ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
python3 -B -m unittest discover -s tests -p 'test_install_recipes.py' -v
python3 -B -m unittest discover -s tests -v
```

The focused recipe tests extract the commands above from this README and use
disposable local stubs and directories; they do not install a plugin, contact a
model or the network, or validate live routing.

The optional observer is documented in
[OPERATOR.md](OPERATOR.md#optional-evidence-index-helper). It reads an already
captured, authorized JSONL file and never launches models or changes evidence.

## Files

- [SKILL.md](SKILL.md) — entry, scope, routing, and required reads.
- [WORKSPACE.md](WORKSPACE.md) — authority, ownership, records, and acceptance.
- [orchestrator/PLANNING.md](orchestrator/PLANNING.md) — Astra planning,
  dispatch, deadline, and recovery rules.
- [orchestrator/IMPROVEMENT.md](orchestrator/IMPROVEMENT.md) — optional
  execution-first continuous-improvement mode.
- [worker/ENGINEERING.md](worker/ENGINEERING.md) — worker execution contract.
- [OPERATOR.md](OPERATOR.md) — large-output recipe and observer reference.
- [`scripts/evidence_index.py`](scripts/evidence_index.py) — bounded read-only
  evidence projection.
- [`tests/`](tests/) — offline documented-recipe and observer CLI regression
  suite.

## Legacy change

The earlier `references/CODEX_LUNA_COMPAT.md` catalogue-mutation and retry
guidance is intentionally absent. Native routing has no probe or fallback.
Keep an old installation intact until its active and unresolved effects are
settled and a safe whole-installation migration and rollback path is recorded.

Licensed under the [Apache License 2.0](LICENSE).
