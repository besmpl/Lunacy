"""Pure Markdown/path primitives shared by Lunacy's read-map tools.

This is deliberately not a general Markdown parser.  It recognizes only the
narrow links, headings, explicit anchors, and backtick/tilde fences used by the
shipped guidance.
"""

from __future__ import annotations

from dataclasses import dataclass
import errno
import hashlib
import os
from pathlib import Path, PurePosixPath
import re
import stat
from urllib.parse import unquote


INLINE_LINK = re.compile(r"(?<!!)\[[^\]\n]+\]\(([^)\s]+)\)")
EXTERNAL = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
EXPLICIT_ANCHOR = re.compile(
    r"^\s*<a\s+[^>]*\bid=[\"']([^\"']+)[\"'][^>]*>\s*(?:</a>)?\s*$", re.I)
EXPLICIT_ANCHOR_ANY = re.compile(r"<a\s+[^>]*\bid=[\"']([^\"']+)[\"'][^>]*>", re.I)
HEADING = re.compile(r"^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


class CoreError(ValueError):
    """A bounded acquisition or narrow parse failed."""

    def __init__(self, code: str, message: str, exit_code: int = 4):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def physical_line_records(text: str):
    """Yield line number, content, and UTF-8 start/content-end/line-end offsets.

    Only CRLF, LF, and CR end a physical line. Other Unicode/control separators
    remain content; empty input and a trailing ending add no phantom line.
    """
    start = offset = 0
    number = 1
    for ending in re.finditer(r"\r\n|\r|\n", text):
        content = text[start:ending.start()]
        content_end = offset + len(content.encode("utf-8"))
        line_end = content_end + ending.end() - ending.start()
        yield number, content, offset, content_end, line_end
        start = ending.end()
        offset = line_end
        number += 1
    if start < len(text):
        content = text[start:]
        end = offset + len(content.encode("utf-8"))
        yield number, content, offset, end, end


def outside_fence_lines(text: str):
    """Yield ``(one_based_line, text)`` for lines outside recognized fences."""
    fence = None
    for number, line, _, _, _ in physical_line_records(text):
        if fence is None:
            match = FENCE.match(line)
            if match:
                token = match.group(1)
                fence = (token[0], len(token))
                continue
            yield number, line
            continue
        marker, minimum = fence
        if re.fullmatch(rf" {{0,3}}{re.escape(marker)}{{{minimum},}}[ \t]*", line):
            fence = None


def outside_fences(text: str):
    for _, line in outside_fence_lines(text):
        yield line


def slug(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text).lower()
    text = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE).strip()
    return re.sub(r"\s+", "-", text)


def anchors(text: str) -> set[str]:
    """Compatibility anchor view used by the maintainer validator."""
    result: set[str] = set()
    duplicate_counts: dict[str, int] = {}
    for _, line in outside_fence_lines(text):
        result.update(EXPLICIT_ANCHOR_ANY.findall(line))
        heading = HEADING.match(line)
        if heading:
            base = slug(heading.group(2))
            count = duplicate_counts.get(base, 0)
            duplicate_counts[base] = count + 1
            result.add(base if count == 0 else f"{base}-{count}")
    return result


@dataclass(frozen=True)
class AcquiredFile:
    canonical_path: str
    logical_path: str
    data: bytes
    text: str
    sha256: str


class AcquisitionBudget:
    def __init__(self, *, max_acquired_bytes: int, max_files: int,
                 max_file_bytes: int = 64 * 1024 * 1024):
        self.max_acquired_bytes = max_acquired_bytes
        self.max_files = max_files
        self.max_file_bytes = max_file_bytes
        self.acquired_bytes = 0
        self.files_opened = 0
        self._cache: dict[str, AcquiredFile] = {}

    @staticmethod
    def _identity(stat_result):
        return (stat_result.st_dev, stat_result.st_ino, stat_result.st_mode,
                stat_result.st_size, stat_result.st_mtime_ns, stat_result.st_ctime_ns)

    def read(self, root: Path, relative: str, logical: str) -> AcquiredFile:
        normalized = normalize_relative(relative)
        candidate = root.joinpath(*normalized.parts)
        key = str(candidate)
        if key in self._cache:
            return self._cache[key]
        if self.files_opened >= self.max_files:
            raise CoreError("file_count_cap_exceeded", "file count cap exceeded", 5)
        opened = []
        try:
            directory_flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
                               | getattr(os, "O_DIRECTORY", 0)
                               | getattr(os, "O_NOFOLLOW", 0))
            directory_fd = os.open(root, directory_flags)
            opened.append(directory_fd)
            for part in normalized.parts[:-1]:
                directory_fd = os.open(part, directory_flags, dir_fd=directory_fd)
                opened.append(directory_fd)
            flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
                     | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
            fd = os.open(normalized.parts[-1], flags, dir_fd=directory_fd)
            opened.append(fd)
        except (OSError, ValueError) as exc:
            for opened_fd in reversed(opened):
                os.close(opened_fd)
            code = ("ancestor_symlink" if isinstance(exc, OSError)
                    and exc.errno in {errno.ELOOP, errno.ENOTDIR} else "missing_target")
            raise CoreError(code, f"cannot open regular target: {relative}", 3) from exc
        self.files_opened += 1
        chunks = []
        total = 0
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode):
                raise CoreError("missing_target", f"target is not a regular file: {relative}", 3)
            if before.st_size > self.max_file_bytes:
                raise CoreError("input_cap_exceeded", f"file exceeds input cap: {relative}", 5)
            while True:
                chunk = os.read(fd, min(65536, self.max_file_bytes + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > self.max_file_bytes:
                    raise CoreError("input_cap_exceeded", f"file exceeds input cap: {relative}", 5)
                if self.acquired_bytes + total > self.max_acquired_bytes:
                    raise CoreError("aggregate_cap_exceeded", "aggregate acquisition cap exceeded", 5)
            after = os.fstat(fd)
        finally:
            for opened_fd in reversed(opened):
                os.close(opened_fd)
        if self._identity(before) != self._identity(after):
            raise CoreError("source_changed_while_read", f"target changed while read: {relative}", 3)
        data = b"".join(chunks)
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise CoreError("invalid_utf8", f"target is not UTF-8: {relative}", 3) from exc
        self.acquired_bytes += len(data)
        item = AcquiredFile(str(candidate), logical, data, text,
                            hashlib.sha256(data).hexdigest())
        self._cache[key] = item
        return item


def normalize_relative(relative: str) -> PurePosixPath:
    if not relative or relative.startswith("/") or EXTERNAL.match(relative):
        raise CoreError("path_escape", f"path is not local relative: {relative}", 3)
    pure = PurePosixPath(relative)
    normalized = PurePosixPath(os.path.normpath(pure.as_posix()))
    if normalized.as_posix() == ".." or normalized.as_posix().startswith("../"):
        raise CoreError("path_escape", f"path escapes root: {relative}", 3)
    return normalized


def secure_path(root: Path, relative: str) -> Path:
    """Return the lexical in-root path; acquisition enforces it with directory fds."""
    return root.joinpath(*normalize_relative(relative).parts)


def published_lunacy_path(logical: str) -> bool:
    path = PurePosixPath(logical)
    if "__pycache__" in path.parts or path.suffix in {".pyc", ".pyo"}:
        return False
    if logical in {"SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md", "LICENSE"}:
        return True
    return bool(path.parts and path.parts[0] in {"orchestrator", "worker", "scripts", "tests"})


def resolve_published_link(layout: str, source_relative: str, target: str,
                           *, allow_golden: bool = False,
                           enforce_published: bool = True) -> tuple[str, str]:
    """Map a local link through the actual package publication layout."""
    if layout not in {"source", "package"}:
        raise ValueError(f"unsupported layout: {layout}")
    if layout == "source":
        publication = ("skills/golden/SKILL.md" if source_relative ==
                       "packaging/lunacy-native/skills/golden/SKILL.md"
                       else f"skills/lunacy/{source_relative}")
    else:
        publication = source_relative
    combined = (PurePosixPath(publication) if not target else
                PurePosixPath(os.path.normpath(os.path.join(
                    PurePosixPath(publication).parent.as_posix(), target))))
    published = combined.as_posix()
    if published == "skills/golden/SKILL.md" and allow_golden:
        physical = ("packaging/lunacy-native/skills/golden/SKILL.md"
                    if layout == "source" else published)
        return physical, "../golden/SKILL.md"
    prefix = "skills/lunacy/"
    if not published.startswith(prefix):
        raise CoreError("path_escape", f"link escapes published Lunacy guidance: {target}", 3)
    logical = published.removeprefix(prefix)
    if enforce_published and not published_lunacy_path(logical):
        raise CoreError("unpublished_target", f"link target is not published: {target}", 3)
    return (logical if layout == "source" else published), logical


def split_target(destination: str) -> tuple[str, str]:
    path, separator, fragment = destination.partition("#")
    return path, unquote(fragment) if separator else ""
