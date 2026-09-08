#!/usr/bin/env python3
"""Assemble the two-skill plugin without modifying an installation."""

import argparse
from pathlib import Path
import shutil
import stat
import sys


ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = ("SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md", "LICENSE")
TEMPLATE_ANCESTORS = (Path("packaging"), Path("packaging/lunacy-native"))
TEMPLATE_TREES = (Path("packaging/lunacy-native/.codex-plugin"),
                  Path("packaging/lunacy-native/skills"))
NATIVE_TREES = tuple(Path(name) for name in ("orchestrator", "worker", "scripts", "tests"))
NATIVE_IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc")


def _source_name(path):
    return path.relative_to(ROOT).as_posix()


def _metadata(path):
    try:
        return path.lstat()
    except FileNotFoundError as error:
        raise ValueError(f"invalid package source {_source_name(path)}: missing") from error


def _require_directory(path):
    mode = _metadata(path).st_mode
    if stat.S_ISLNK(mode):
        raise ValueError(f"invalid package source {_source_name(path)}: symbolic link")
    if not stat.S_ISDIR(mode):
        raise ValueError(f"invalid package source {_source_name(path)}: expected directory")


def _require_regular_file(path):
    mode = _metadata(path).st_mode
    if stat.S_ISLNK(mode):
        raise ValueError(f"invalid package source {_source_name(path)}: symbolic link")
    if not stat.S_ISREG(mode):
        raise ValueError(f"invalid package source {_source_name(path)}: expected regular file")


def _validate_tree(path, ignore=None):
    """Validate selected descendants without following links or opening files."""
    _require_directory(path)
    children = sorted(path.iterdir(), key=lambda child: child.name)
    ignored = set(ignore(str(path), [child.name for child in children])) if ignore else set()
    for child in children:
        if child.name in ignored:
            continue
        mode = _metadata(child).st_mode
        if stat.S_ISLNK(mode):
            raise ValueError(f"invalid package source {_source_name(child)}: symbolic link")
        if stat.S_ISDIR(mode):
            _validate_tree(child, ignore)
        elif not stat.S_ISREG(mode):
            raise ValueError(
                f"invalid package source {_source_name(child)}: expected regular file or directory")


def _validate_sources():
    for relative in TEMPLATE_ANCESTORS:
        _require_directory(ROOT / relative)
    for name in ROOT_FILES:
        _require_regular_file(ROOT / name)
    for relative in TEMPLATE_TREES:
        _validate_tree(ROOT / relative)
    for relative in NATIVE_TREES:
        _validate_tree(ROOT / relative, NATIVE_IGNORE)


def build(destination):
    destination = destination.absolute()
    if destination.name != "lunacy-native":
        raise ValueError("destination folder must be named lunacy-native")
    if destination.is_symlink() or destination.exists():
        raise ValueError(f"refusing existing destination: {destination}")
    if destination.resolve().is_relative_to(ROOT):
        raise ValueError("destination must be outside the source checkout")
    _validate_sources()
    # mkdir owns only this new output; do not overwrite or clean up other paths.
    destination.mkdir()
    shutil.copy2(ROOT / "LICENSE", destination / "LICENSE")
    for relative in TEMPLATE_TREES:
        shutil.copytree(ROOT / relative, destination / relative.name)
    native = destination / "skills" / "lunacy"
    native.mkdir()
    for name in ROOT_FILES:
        shutil.copy2(ROOT / name, native / name)
    for relative in NATIVE_TREES:
        shutil.copytree(ROOT / relative, native / relative.name, ignore=NATIVE_IGNORE)
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
