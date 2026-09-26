"""Preflight the source inputs shared by Lunacy's two release projections.

The returned plan records metadata-selected paths, not a byte snapshot.  Callers
must use a quiescent trusted checkout and retain their own copy-failure policy.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import stat


ROOT_FILES = tuple(Path(name) for name in
                   ("SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md", "LICENSE"))
NATIVE_TREES = tuple(Path(name) for name in ("orchestrator", "worker", "scripts", "tests"))
SOURCE_ANCESTORS = (Path("packaging"), Path("packaging/lunacy-native"), Path("maintainer"))
TEMPLATE_TREES = (Path("packaging/lunacy-native/.codex-plugin"),
                  Path("packaging/lunacy-native/skills"))
BUILD_HELPERS = (Path("maintainer/read_footprint.py"), Path("maintainer/read_map.py"))
GOLDEN_SKILL = Path("packaging/lunacy-native/skills/golden/SKILL.md")


@dataclass(frozen=True)
class ReleaseInputs:
    """An ordered, validated, source-relative release plan."""

    source: Path
    root_files: tuple[Path, ...]
    native_entries: tuple[Path, ...]
    template_entries: tuple[Path, ...]

    @property
    def published_sources(self) -> set[str]:
        return ({path.as_posix() for path in self.root_files}
                | {path.as_posix() for path in self.native_entries}
                | {GOLDEN_SKILL.as_posix()})


def is_generated(relative: Path) -> bool:
    """Return whether a native relative path is generated Python bytecode."""
    return "__pycache__" in relative.parts or relative.suffix in {".pyc", ".pyo"}


def _label(source: Path, path: Path) -> str:
    try:
        return path.relative_to(source).as_posix()
    except ValueError:
        return str(path)


def _metadata(source: Path, path: Path):
    try:
        return path.lstat()
    except FileNotFoundError as exc:
        raise ValueError(f"invalid release source {_label(source, path)}: missing") from exc


def _require_directory(source: Path, path: Path) -> None:
    mode = _metadata(source, path).st_mode
    if stat.S_ISLNK(mode):
        raise ValueError(f"invalid release source {_label(source, path)}: symbolic link")
    if not stat.S_ISDIR(mode):
        raise ValueError(f"invalid release source {_label(source, path)}: expected directory")


def _require_regular_file(source: Path, path: Path) -> None:
    mode = _metadata(source, path).st_mode
    if stat.S_ISLNK(mode):
        raise ValueError(f"invalid release source {_label(source, path)}: symbolic link")
    if not stat.S_ISREG(mode):
        raise ValueError(f"invalid release source {_label(source, path)}: expected regular file")


def _scan_tree(source: Path, relative: Path, *, template: bool) -> list[Path]:
    """Validate and enumerate one tree without following links.

    Native generated names are ignored before metadata inspection.  Template
    nodes are inspected first: only generated *regular* files/directories are
    skipped, while cache-named links and special nodes are refused.
    """
    root = source / relative
    _require_directory(source, root)
    selected = [relative]

    def visit(directory: Path) -> None:
        for child in sorted(directory.iterdir(), key=lambda item: item.name):
            child_relative = child.relative_to(source)
            generated = is_generated(child_relative)
            if generated and not template:
                continue
            mode = _metadata(source, child).st_mode
            if stat.S_ISLNK(mode):
                raise ValueError(
                    f"invalid release source {_label(source, child)}: symbolic link")
            if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError(
                    f"invalid release source {_label(source, child)}: "
                    "expected regular file or directory")
            if generated and template:
                continue
            selected.append(child_relative)
            if stat.S_ISDIR(mode):
                visit(child)

    visit(root)
    return selected


def select_release_inputs(source: Path) -> ReleaseInputs:
    """Validate ``source`` and return the canonical ordered release inventory."""
    source = Path(source).absolute()
    _require_directory(source, source)
    for relative in SOURCE_ANCESTORS:
        _require_directory(source, source / relative)
    for relative in ROOT_FILES:
        _require_regular_file(source, source / relative)
    for relative in BUILD_HELPERS:
        _require_regular_file(source, source / relative)

    native: list[Path] = []
    for relative in NATIVE_TREES:
        native.extend(_scan_tree(source, relative, template=False))
    template_entries: list[Path] = []
    for relative in TEMPLATE_TREES:
        template_entries.extend(_scan_tree(source, relative, template=True))
    return ReleaseInputs(source, ROOT_FILES, tuple(native), tuple(template_entries))


def copy_entries(plan: ReleaseInputs, entries: tuple[Path, ...], destination: Path,
                 *, strip: Path | None = None) -> None:
    """Project already-preflighted entries, preserving a partial copy on error."""
    import shutil

    for relative in entries:
        projected = relative.relative_to(strip) if strip is not None else relative
        source_path = plan.source / relative
        target = destination / projected
        mode = source_path.lstat().st_mode
        if stat.S_ISDIR(mode):
            target.mkdir(exist_ok=True)
        else:
            shutil.copy2(source_path, target)
