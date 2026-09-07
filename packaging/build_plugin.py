#!/usr/bin/env python3
"""Assemble the two-skill plugin without modifying an installation."""

import argparse
from pathlib import Path
import shutil
import sys


ROOT = Path(__file__).resolve().parents[1]


def build(destination):
    destination = destination.absolute()
    if destination.name != "lunacy-native":
        raise ValueError("destination folder must be named lunacy-native")
    if destination.is_symlink() or destination.exists():
        raise ValueError(f"refusing existing destination: {destination}")
    if destination.resolve().is_relative_to(ROOT):
        raise ValueError("destination must be outside the source checkout")
    # mkdir owns only this new output; do not overwrite or clean up other paths.
    destination.mkdir()
    shutil.copy2(ROOT / "LICENSE", destination / "LICENSE")
    template = ROOT / "packaging" / "lunacy-native"
    shutil.copytree(template / ".codex-plugin", destination / ".codex-plugin")
    shutil.copytree(template / "skills", destination / "skills")
    native = destination / "skills" / "lunacy"
    native.mkdir()
    for name in ("SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md", "LICENSE"):
        shutil.copy2(ROOT / name, native / name)
    for name in ("orchestrator", "worker", "scripts", "tests"):
        shutil.copytree(ROOT / name, native / name,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="new lunacy-native folder; parent must exist")
    args = parser.parse_args()
    try:
        result = build(args.destination)
    except (OSError, ValueError) as error:
        print(f"plugin build failed: {error}", file=sys.stderr)
        return 1
    print(f"Built {result}; no installation or configuration changes made.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
