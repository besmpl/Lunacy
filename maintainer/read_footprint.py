"""Report reproducible file-level sizes for declared Lunacy read sets.

Counts are UTF-8 bytes and regex words, never model tokens. Declared read sets
are maintenance comparisons; they do not observe or claim host-loaded context.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Iterable


WORD_PATTERN = re.compile(r"\b[\w'-]+\b", re.UNICODE)
READ_SETS = {
    "ordinary-entry": ("SKILL.md",),
    "ordinary-adoption": ("SKILL.md", "WORKSPACE.md", "orchestrator/PLANNING.md"),
    "ordinary-worker": ("SKILL.md", "WORKSPACE.md", "worker/ENGINEERING.md"),
    "ordinary-acceptance": ("SKILL.md", "WORKSPACE.md", "orchestrator/PLANNING.md"),
}


class FootprintError(ValueError):
    """Raised when a declared source cannot be measured safely."""


def _measure_file(root: Path, relative: str) -> dict[str, object]:
    target = root / relative
    if target.is_symlink() or not target.is_file():
        raise FootprintError(f"declared source is not a regular file: {relative}")
    data = target.read_bytes()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise FootprintError(f"declared source is not UTF-8: {relative}") from exc
    return {
        "path": relative,
        "bytes": len(data),
        "words": len(WORD_PATTERN.findall(text)),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def create_report(root: Path, read_sets: dict[str, Iterable[str]] = READ_SETS) -> dict[str, object]:
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise FootprintError(f"root is not a real directory: {root}")
    measured: dict[str, dict[str, object]] = {}
    sets = []
    for name, paths in read_sets.items():
        declared = list(paths)
        if not name or not declared or len(declared) != len(set(declared)):
            raise FootprintError(f"invalid declared read set: {name!r}")
        for relative in declared:
            if Path(relative).is_absolute() or ".." in Path(relative).parts:
                raise FootprintError(f"unsafe declared path: {relative}")
            if relative not in measured:
                measured[relative] = _measure_file(root, relative)
        sets.append(
            {
                "name": name,
                "declaredFiles": declared,
                "bytes": sum(int(measured[path]["bytes"]) for path in declared),
                "words": sum(int(measured[path]["words"]) for path in declared),
            }
        )
    return {
        "schema": "lunacy-read-footprint-v1",
        "measurement": {
            "bytes": "UTF-8 file bytes",
            "words": "Unicode regex word matches; not model tokens",
            "scope": "declared complete-file read sets, not observed host-loaded context",
        },
        "files": [measured[path] for path in sorted(measured)],
        "readSets": sets,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args(argv)
    try:
        rendered = json.dumps(create_report(args.root), indent=2, sort_keys=True) + "\n"
        print(rendered, end="")
    except (FootprintError, OSError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
