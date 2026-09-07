# Lunacy native

Lunacy is an explicitly adopted workflow for genuinely new engineering work.
Astra owns planning and acceptance; a bounded native worker owns its assigned
implementation, verification, report, and logs. This release candidate keeps
the repository's root-level Codex skill layout and workflow contract `0.1.29`.

## Release status

Version `0.2.0-rc.1` is a native-guidance release candidate. The package has
offline structural and observer tests only. It has no claim of proven live
reliability, route availability, model obedience, speed, cost, or savings.

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

## Safe coexistence install

The canonical source package remains named `lunacy`. Do not overwrite, move,
or edit an installed legacy `$lunacy`; it remains the recovery route for its
existing work. First clone the release outside skill discovery:

```sh
git clone --branch release/native-0.2.0-rc.1 --single-branch \
  https://github.com/besmpl/Lunacy.git \
  /path/to/lunacy-native-source
```

For coexistence, refuse an existing destination, copy this public skill tree to
`${CODEX_HOME:-$HOME/.codex}/skills/lunacy-native`, and change exactly the
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

Invoke `$lunacy-native` only for genuinely new work whose current project/user
authority explicitly adopts workflow contract `0.1.29`. Existing work remains
on `$lunacy` and its original contract, route, history, effects, and recovery
owner; installation never migrates it. Roll back the native candidate by
removing only its separate inactive directory after establishing that no
active or uncertain owner depends on it. The legacy directory stays intact.

## Validate

The observer uses only the Python standard library.

```sh
python3 -B ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py .
python3 -B -m unittest discover -s tests -v
```

The optional observer is documented in
[OPERATOR.md](OPERATOR.md#optional-evidence-index-helper). It reads an already
captured, authorized JSONL file and never launches models or changes evidence.

## Files

- [SKILL.md](SKILL.md) — entry, scope, routing, and required reads.
- [WORKSPACE.md](WORKSPACE.md) — authority, ownership, records, and acceptance.
- [orchestrator/PLANNING.md](orchestrator/PLANNING.md) — Astra planning,
  dispatch, deadline, and recovery rules.
- [worker/ENGINEERING.md](worker/ENGINEERING.md) — worker execution contract.
- [OPERATOR.md](OPERATOR.md) — large-output recipe and observer reference.
- [`scripts/evidence_index.py`](scripts/evidence_index.py) — bounded read-only
  evidence projection.
- [`tests/`](tests/) — standalone observer CLI regression suite.

## Legacy change

The earlier `references/CODEX_LUNA_COMPAT.md` catalogue-mutation and retry
guidance is intentionally absent. Native routing has no probe or fallback.
Keep an old installation intact until its active and unresolved effects are
settled and a safe whole-installation migration and rollback path is recorded.

Licensed under the [Apache License 2.0](LICENSE).
