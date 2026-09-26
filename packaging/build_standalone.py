#!/usr/bin/env python3
"""Compose a standalone lunacy-native skill from a source checkout."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import re
import shutil
import stat
import sys
import unicodedata

from release_inputs import copy_entries, select_release_inputs


SOURCE_NAME = "lunacy"
TARGET_NAME = "lunacy-native"
ROOT = Path(__file__).resolve().parents[1]
KEY = re.compile(r"[A-Za-z][A-Za-z0-9_-]*\Z")
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")


@dataclass(frozen=True)
class IdentityTransform:
    source_name: str
    target_name: str
    skill_bytes: bytes


def transform_skill(data: bytes) -> IdentityTransform:
    """Validate the documented line-oriented header and rewrite only its name."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("invalid standalone SKILL.md: not UTF-8") from exc
    # Deliberately recognize only LF and CRLF.  str.splitlines() also treats CR,
    # VT, FF, NEL, LS, and PS as line boundaries, which is broader than the
    # documented grammar and can make a rewritten header invalid YAML.
    lines = text.split("\n")
    if not lines or not text:
        raise ValueError("invalid standalone SKILL.md: missing frontmatter")

    def content(line: str, number: int) -> str:
        value = line[:-1] if line.endswith("\r") else line
        if "\r" in value or any(
            unicodedata.category(character).startswith("C")
            or unicodedata.category(character) in {"Zl", "Zp"}
            for character in value
        ):
            raise ValueError(
                f"invalid standalone SKILL.md: unsupported header character on line {number}"
            )
        return value

    if content(lines[0], 1) != "---":
        raise ValueError("invalid standalone SKILL.md: first line must be ---")
    close = None
    for index, line in enumerate(lines[1:], 1):
        if content(line, index + 1) == "---":
            close = index
            break
    if close is None:
        raise ValueError("invalid standalone SKILL.md: missing frontmatter close")
    if close == 1:
        raise ValueError("invalid standalone SKILL.md: empty frontmatter")

    seen: set[str] = set()
    name_index = None
    for index in range(1, close):
        raw = content(lines[index], index + 1)
        if "\t" in raw or ": " not in raw:
            raise ValueError(f"invalid standalone SKILL.md: malformed header line {index + 1}")
        key, value = raw.split(": ", 1)
        if not KEY.fullmatch(key) or not value or value != value.strip():
            raise ValueError(f"invalid standalone SKILL.md: malformed header line {index + 1}")
        if key in seen:
            raise ValueError(f"invalid standalone SKILL.md: duplicate header key {key}")
        seen.add(key)
        if (value[0] in "&*!|>'\"[{},]%@`" or value.startswith(("#", "- ", "? ", ": "))
                or " #" in value or ": " in value or value.endswith(":")):
            raise ValueError(f"invalid standalone SKILL.md: unsupported header value for {key}")
        if key == "name":
            if not NAME.fullmatch(value):
                raise ValueError("invalid standalone SKILL.md: name is not a plain scalar")
            name_index = index
            source_name = value
    if name_index is None:
        raise ValueError("invalid standalone SKILL.md: missing name")
    if source_name != SOURCE_NAME:
        raise ValueError(f"invalid standalone SKILL.md: expected name {SOURCE_NAME}")

    carriage_return = "\r" if lines[name_index].endswith("\r") else ""
    lines[name_index] = f"name: {TARGET_NAME}{carriage_return}"
    return IdentityTransform(SOURCE_NAME, TARGET_NAME, "\n".join(lines).encode("utf-8"))


def _existing(path: Path) -> bool:
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def _validate_destination(source: Path, destination: Path) -> Path:
    destination = destination.absolute()
    if destination.name != TARGET_NAME:
        raise ValueError(f"destination folder must be named {TARGET_NAME}")
    if _existing(destination):
        raise ValueError(f"refusing existing destination: {destination}")
    parent = destination.parent
    try:
        mode = parent.lstat().st_mode
    except FileNotFoundError as exc:
        raise ValueError(f"destination parent must already exist: {parent}") from exc
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
        raise ValueError(f"destination parent must be a real directory: {parent}")
    if destination.resolve(strict=False).is_relative_to(source.resolve(strict=True)):
        raise ValueError("destination must be outside the source checkout")
    return destination


def _validate_guidance(source: Path, plan) -> None:
    """Validate selected data with the builder checkout's trusted validator."""
    sys.path.insert(0, str(ROOT))
    try:
        from maintainer.read_map import ROOT_GUIDANCE, validate_source

        selected = ({path.as_posix() for path in plan.root_files}
                    | {path.as_posix() for path in plan.native_entries})
        guidance = [name for name in ROOT_GUIDANCE if name in selected]
        guidance.extend(sorted(
            path.as_posix() for path in plan.native_entries
            if path.suffix.lower() == ".md"
            and path.parts[0] in {"orchestrator", "worker"}
            and (source / path).is_file()
        ))
        validate_source(source, published_sources=selected, guidance_paths=guidance)
    finally:
        if sys.path[0] == str(ROOT):
            sys.path.pop(0)


def build(source: Path, destination: Path) -> Path:
    source = Path(source).absolute()
    destination = _validate_destination(source, Path(destination))
    plan = select_release_inputs(source)
    # Validate the identity transform, then selected guidance, before creating output.
    identity = transform_skill((source / "SKILL.md").read_bytes())
    _validate_guidance(source, plan)
    destination.mkdir()
    for relative in plan.root_files:
        target = destination / relative
        if relative == Path("SKILL.md"):
            target.write_bytes(identity.skill_bytes)
            shutil.copystat(source / relative, target)
        else:
            shutil.copy2(source / relative, target)
    copy_entries(plan, plan.native_entries, destination)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="source checkout root")
    parser.add_argument("destination", type=Path,
                        help="new lunacy-native folder; parent must exist")
    args = parser.parse_args()
    try:
        result = build(args.source, args.destination)
    except (OSError, ValueError) as exc:
        print(f"standalone build failed: {exc}", file=sys.stderr)
        return 1
    print(f"Built {result}; no installation or configuration changes made.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
