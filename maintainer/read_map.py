"""Validate the narrow shipped Lunacy guidance read-map contract.

Supported links are inline ``[label](path)`` forms without titles, outside
backtick/tilde fenced blocks whose marker-only close is at least as long as the
opening marker. Local relative files and fragments are checked.
External-scheme, protocol-relative, and absolute links are ignored. Images,
reference-style links, autolinks, raw HTML links, and inline-code interpretation
are outside this deliberately small checker. HTML ``<a id=...>`` is recognized
only as a target anchor.

These structural checks do not prove natural-language instructions are obeyed,
that a read is mandatory, or that a host actually loaded any context.
"""

from __future__ import annotations

import posixpath
from pathlib import Path, PurePosixPath
from typing import Iterable
from urllib.parse import unquote

from maintainer.read_footprint import READ_SETS, create_report
from scripts.read_map_core import (
    EXPLICIT_ANCHOR, EXTERNAL, FENCE, HEADING, INLINE_LINK,
    anchors as _core_anchors, outside_fences as _core_outside_fences,
    resolve_published_link, slug as _core_slug,
)


ENTRY_WORD_LIMIT = 650
GOLDEN_ONLY_GUIDANCE = frozenset({
    "orchestrator/IMPROVEMENT.md",
    "packaging/lunacy-native/skills/golden/SKILL.md",
})
ROOT_GUIDANCE = ("SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md")
DEFAULT_ROOT_FILES = ROOT_GUIDANCE + ("LICENSE",)
DEFAULT_NATIVE_TREES = ("orchestrator", "worker", "scripts", "tests")
GOLDEN_SOURCE = "packaging/lunacy-native/skills/golden/SKILL.md"
class ReadMapError(ValueError):
    """A shipped guidance link, anchor, read set, or entry cap is invalid."""


def _read_utf8(path: Path, label: str) -> str:
    if path.is_symlink() or not path.is_file():
        raise ReadMapError(f"guidance file is not a regular file: {label}")
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ReadMapError(f"guidance file is not UTF-8: {label}") from exc


def _outside_fences(text: str):
    yield from _core_outside_fences(text)


def _slug(text: str) -> str:
    return _core_slug(text)


def _anchors(text: str) -> set[str]:
    return _core_anchors(text)


def _source_guidance(root: Path) -> list[str]:
    paths = list(ROOT_GUIDANCE)
    for directory in ("orchestrator", "worker"):
        paths.extend(path.relative_to(root).as_posix()
                     for path in sorted((root / directory).glob("*.md")))
    paths.append(GOLDEN_SOURCE)
    return paths


def _explicit_guidance(paths: Iterable[str], published_sources: set[str]) -> list[str]:
    """Validate and retain an explicitly selected source projection in order."""
    guidance: list[str] = []
    seen: set[str] = set()
    for path in paths:
        if not isinstance(path, str):
            raise ReadMapError(f"guidance path is not a string: {path!r}")
        pure = PurePosixPath(path)
        canonical = pure.as_posix()
        if (not path or pure.is_absolute() or canonical != path
                or ".." in pure.parts or path in seen):
            raise ReadMapError(f"guidance path is not canonical and unique: {path!r}")
        if path not in published_sources:
            raise ReadMapError(f"guidance path is not shipped: {path}")
        seen.add(path)
        guidance.append(path)
    return guidance


def _publication_path(source_relative: str) -> str:
    if source_relative == GOLDEN_SOURCE:
        return "skills/golden/SKILL.md"
    return f"skills/lunacy/{source_relative}"


def _default_published_sources(root: Path) -> set[str]:
    """Return source-relative files selected by the current package layout."""
    selected = set(DEFAULT_ROOT_FILES)
    for directory in DEFAULT_NATIVE_TREES:
        base = root / directory
        if not base.is_dir():
            continue
        selected.add(directory)
        for path in base.rglob("*"):
            relative = path.relative_to(root)
            if ("__pycache__" not in relative.parts and path.suffix not in {".pyc", ".pyo"}
                    and (path.is_file() or path.is_dir())):
                selected.add(relative.as_posix())
    selected.add(GOLDEN_SOURCE)
    return selected


def _source_target(root: Path, source_relative: str, target: str,
                   published_sources: set[str]) -> tuple[Path, str]:
    if not target:
        return root / source_relative, source_relative
    try:
        relative, _ = resolve_published_link(
            "source", source_relative, target, allow_golden=True,
            enforce_published=False)
    except ValueError as exc:
        raise ReadMapError(
            f"local link escapes shipped guidance: {source_relative} -> {target}") from exc
    candidate = root / relative
    if candidate.exists() and relative not in published_sources:
        raise ReadMapError(
            f"local link target is not shipped: {source_relative} -> {target}")
    return candidate, relative


def _package_guidance(root: Path) -> list[str]:
    lunacy = root / "skills/lunacy"
    paths = [f"skills/lunacy/{name}" for name in ROOT_GUIDANCE]
    for directory in ("orchestrator", "worker"):
        paths.extend(path.relative_to(root).as_posix()
                     for path in sorted((lunacy / directory).glob("*.md")))
    paths.append("skills/golden/SKILL.md")
    return paths


def _validate_links(root: Path, guidance: list[str], source_layout: bool,
                    published_sources: set[str] | None = None) -> int:
    checked = 0
    for relative in guidance:
        text = _read_utf8(root / relative, relative)
        for line in _outside_fences(text):
            for match in INLINE_LINK.finditer(line):
                destination = match.group(1)
                if (EXTERNAL.match(destination) or destination.startswith(("//", "/"))):
                    continue
                path_part, separator, fragment = destination.partition("#")
                if source_layout:
                    assert published_sources is not None
                    target, label = _source_target(
                        root, relative, path_part, published_sources)
                else:
                    combined = (relative if not path_part else
                                posixpath.normpath(posixpath.join(
                                    posixpath.dirname(relative), path_part)))
                    if combined == ".." or combined.startswith("../"):
                        raise ReadMapError(
                            f"local link escapes package: {relative} -> {destination}")
                    target, label = root / PurePosixPath(combined), combined
                if target.is_symlink() or not target.exists():
                    raise ReadMapError(f"missing local link target: {relative} -> {destination}")
                if separator:
                    if not target.is_file() or target.suffix.lower() != ".md":
                        raise ReadMapError(
                            f"fragment target is not Markdown: {relative} -> {destination}")
                    target_text = _read_utf8(target, label)
                    decoded = unquote(fragment)
                    if not decoded or decoded not in _anchors(target_text):
                        raise ReadMapError(f"missing local anchor: {relative} -> {destination}")
                checked += 1
    return checked


def _validate_declared_reads(root: Path, read_sets=READ_SETS) -> dict[str, object]:
    for name, paths in read_sets.items():
        for path in paths:
            canonical = PurePosixPath(path).as_posix()
            if (not path or path.startswith("/") or canonical != path
                    or ".." in PurePosixPath(path).parts):
                raise ReadMapError(
                    f"read-set path is not canonical: {name}: {path}")
        if name.startswith("ordinary-"):
            forbidden = sorted(set(paths) & GOLDEN_ONLY_GUIDANCE)
            if forbidden:
                raise ReadMapError(
                    f"ordinary read set includes Golden-only guidance: {name}: {forbidden[0]}")
    try:
        footprint = create_report(root, read_sets)
    except ValueError as exc:
        raise ReadMapError(str(exc)) from exc
    entry = next((item for item in footprint["readSets"]
                  if item["name"] == "ordinary-entry"), None)
    if entry is None or entry["declaredFiles"] != ["SKILL.md"]:
        raise ReadMapError("ordinary-entry must declare only SKILL.md")
    words = len(_read_utf8(root / "SKILL.md", "SKILL.md").split())
    if words > ENTRY_WORD_LIMIT:
        raise ReadMapError(
            f"ordinary entry exceeds {ENTRY_WORD_LIMIT} whitespace words: {words}")
    return {"ordinaryEntryWords": words, "ordinaryEntryWordLimit": ENTRY_WORD_LIMIT,
            "readSetCount": len(footprint["readSets"])}


def validate_source(root: Path, read_sets=READ_SETS,
                    published_sources: set[str] | None = None, *,
                    guidance_paths: Iterable[str] | None = None) -> dict[str, object]:
    """Validate source files using their generated-package publication paths."""
    root = Path(root)
    if published_sources is None:
        published_sources = _default_published_sources(root)
    else:
        published_sources = set(published_sources)
    reads = _validate_declared_reads(root, read_sets)
    guidance = (_source_guidance(root) if guidance_paths is None
                else _explicit_guidance(guidance_paths, published_sources))
    return {"layout": "source", "guidanceFiles": len(guidance),
            "localLinksChecked": _validate_links(
                root, guidance, True, published_sources), **reads,
            "claims": "structural declarations only; not model tokens or observed reads"}


def validate_package(root: Path, read_sets=READ_SETS) -> dict[str, object]:
    """Validate the same contract against actual generated package paths."""
    root = Path(root)
    lunacy = root / "skills/lunacy"
    reads = _validate_declared_reads(lunacy, read_sets)
    guidance = _package_guidance(root)
    return {"layout": "package", "guidanceFiles": len(guidance),
            "localLinksChecked": _validate_links(root, guidance, False), **reads,
            "claims": "structural declarations only; not model tokens or observed reads"}
