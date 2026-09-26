#!/usr/bin/env python3
"""Emit bounded, source-authoritative context for one Lunacy action or section."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys

try:
    from read_map_core import (
        AcquisitionBudget, CoreError, EXPLICIT_ANCHOR, EXTERNAL, HEADING, INLINE_LINK,
        EXPLICIT_ANCHOR_ANY, normalize_relative, outside_fence_lines, physical_line_records,
        resolve_published_link, slug, split_target,
    )
except ImportError:  # imported as scripts.context_excerpt by source tests
    from scripts.read_map_core import (
        AcquisitionBudget, CoreError, EXPLICIT_ANCHOR, EXTERNAL, HEADING, INLINE_LINK,
        EXPLICIT_ANCHOR_ANY, normalize_relative, outside_fence_lines, physical_line_records,
        resolve_published_link, slug, split_target,
    )

SCHEMA = "lunacy.action_excerpt.v1"
ERROR_SCHEMA = "lunacy.action_excerpt.error.v1"
MAX_ARGUMENT = 4096
MAX_SELECTOR = 65536
DEFAULT_ACQUIRED = 4 * 1024 * 1024
HARD_ACQUIRED = 16 * 1024 * 1024
DEFAULT_FILES = 32
HARD_FILES = 128
DEFAULT_LINKS = 512
HARD_LINKS = 4096
DEFAULT_WORK = 100_000
HARD_WORK = 1_000_000
DEFAULT_OUTPUT = 256 * 1024
HARD_OUTPUT = 1024 * 1024
FRESHNESS = "individual-acquisition-only; no-atomic-multi-file-snapshot"


class Work:
    def __init__(self, maximum: int, links: int, materialized: int):
        self.maximum = maximum
        self.link_maximum = links
        self.materialized_maximum = materialized
        self.units = 0
        self.links = 0
        self.materialized_bytes = 0

    def add(self, count=1):
        self.units += count
        if self.units > self.maximum:
            raise CoreError("work_cap_exceeded", "parser work cap exceeded", 5)

    def link(self):
        self.links += 1
        if self.links > self.link_maximum:
            raise CoreError("link_count_cap_exceeded", "link record cap exceeded", 5)

    def reserve(self, count: int):
        """Reserve source bytes before copying/decoding them into result objects."""
        if self.materialized_bytes + count > self.materialized_maximum:
            raise CoreError("output_cap_exceeded", "complete JSON exceeds output cap", 5)
        self.materialized_bytes += count


def line_records(text: str):
    return list(physical_line_records(text))


def excerpt_record(acquired, records, start: int, end: int, kind: str,
                   fragment: str | None = None, work: Work | None = None):
    if not records and start == 1 and end == 0:
        byte_start = byte_end = 0
    else:
        byte_start = records[start - 1][2]
        byte_end = records[end - 1][4]
    if work is not None:
        work.reserve(byte_end - byte_start)
    data = acquired.data[byte_start:byte_end]
    result = {
        "kind": kind,
        "logical_path": acquired.logical_path,
        "canonical_path": acquired.canonical_path,
        "fragment": fragment,
        "line_range": {"start": start, "end": end},
        "byte_range": {"start": byte_start, "end": byte_end},
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "text": data.decode("utf-8"),
    }
    return result


def marker(line: str):
    match = EXPLICIT_ANCHOR.match(line)
    return match.group(1) if match else None


def parse_entry(acquired, trigger: str, work: Work):
    records = line_records(acquired.text)
    outside = {number: line for number, line in outside_fence_lines(acquired.text)}
    work.add(len(records))
    before_heads = []
    table_heads = []
    for number, line in outside.items():
        match = HEADING.match(line)
        if match and len(match.group(1)) == 2 and match.group(2) == "Before-action reads":
            before_heads.append(number)
        if match and len(match.group(1)) == 3 and match.group(2) == "Ordinary trigger table":
            table_heads.append(number)
    if len(before_heads) != 1 or len(table_heads) != 1:
        raise CoreError("ambiguous_before_action_boundary",
                        "expected one Before-action reads and one Ordinary trigger table")
    before_start, table_heading = before_heads[0], table_heads[0]
    if table_heading <= before_start:
        raise CoreError("ambiguous_before_action_boundary", "trigger table precedes governing text")
    markers = []
    substantive_end = before_start
    for number in range(before_start + 1, table_heading):
        line = outside.get(number)
        if line is None:
            if records[number - 1][1].strip():
                raise CoreError("ambiguous_before_action_boundary",
                                "fenced or otherwise hidden before-action content")
            continue
        anchor = marker(line)
        if anchor:
            markers.append({"id": anchor, "line": number})
        elif line.strip():
            if markers:
                raise CoreError("ambiguous_before_action_boundary",
                                "substantive content follows before-action boundary marker")
            substantive_end = number
    # Only blank lines and marker-only metadata may follow the governing prose.
    for number in range(substantive_end + 1, table_heading):
        line = outside.get(number, "")
        if line.strip() and not marker(line):
            raise CoreError("ambiguous_before_action_boundary", "unclear before-action boundary")
    if substantive_end == before_start:
        raise CoreError("ambiguous_before_action_boundary", "missing before-action prose")
    governing = excerpt_record(acquired, records, before_start, substantive_end,
                                "before-action", work=work)

    number = table_heading + 1
    boundary_markers = list(markers)
    while number <= len(records):
        line = outside.get(number, "")
        if not line.strip():
            number += 1
            continue
        if marker(line):
            boundary_markers.append({"id": marker(line), "line": number})
            number += 1
            continue
        break
    expected = ["Trigger", "Read next"]
    if number > len(records) or split_table_row(outside.get(number, "")) != expected:
        raise CoreError("missing_table", "missing two-column ordinary trigger table")
    divider = split_table_row(outside.get(number + 1, "")) if number + 1 <= len(records) else None
    if not divider or len(divider) != 2 or not all(re.fullmatch(r":?-{3,}:?", cell) for cell in divider):
        raise CoreError("missing_table", "missing trigger table divider")
    selected = []
    trigger_rows = {}
    row_number = number + 2
    while row_number <= len(records):
        line = outside.get(row_number)
        if line is None or not line.lstrip().startswith("|"):
            break
        cells = split_table_row(line)
        if cells is None or len(cells) != 2:
            raise CoreError("malformed_row", f"malformed trigger row at line {row_number}")
        trigger_rows.setdefault(cells[0], []).append(row_number)
        if cells[0] == trigger:
            selected.append(row_number)
        row_number += 1
    duplicates = sorted(name for name, rows in trigger_rows.items() if len(rows) > 1)
    if duplicates:
        raise CoreError("duplicate_trigger", f"duplicate trigger: {duplicates[0]}")
    if len(selected) > 1:
        raise CoreError("duplicate_trigger", f"duplicate trigger: {trigger}")
    if not selected:
        raise CoreError("missing_trigger", f"trigger not found: {trigger}", 2)
    row = excerpt_record(acquired, records, selected[0], selected[0], "trigger-row",
                         work=work)
    row.update({"trigger": trigger, "boundary_markers": boundary_markers})
    return records, governing, row


def split_table_row(line: str):
    if not line.startswith("|") or not line.endswith("|"):
        return None
    cells, current, escaped = [], [], False
    for char in line[1:-1]:
        if escaped:
            current.append(char)
            escaped = False
        elif char == "\\":
            current.append(char)
            escaped = True
        elif char == "|":
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    cells.append("".join(current).strip())
    return cells


def anchor_index(text: str, work: Work):
    records = line_records(text)
    outside = {number: line for number, line in outside_fence_lines(text)}
    work.add(len(records))
    headings = []
    counts = {}
    pending = []
    unattached = []
    explicit_counts = {}
    for number in range(1, len(records) + 1):
        line = outside.get(number)
        if line is None:
            pending = []
            continue
        explicit = marker(line)
        if explicit:
            explicit_counts[explicit] = explicit_counts.get(explicit, 0) + 1
            pending.append((explicit, number))
            continue
        inline_ids = EXPLICIT_ANCHOR_ANY.findall(line)
        if inline_ids:
            for explicit_id in inline_ids:
                explicit_counts[explicit_id] = explicit_counts.get(explicit_id, 0) + 1
                unattached.append((explicit_id, number))
        heading = HEADING.match(line)
        if heading:
            base = slug(heading.group(2))
            count = counts.get(base, 0)
            counts[base] = count + 1
            generated = base if count == 0 else f"{base}-{count}"
            headings.append({"line": number, "level": len(heading.group(1)),
                             "start": pending[0][1] if pending else number,
                             "aliases": [item[0] for item in pending],
                             "generated": generated})
            pending = []
            continue
        if line.strip():
            unattached.extend(pending)
            pending = []
        elif pending:
            # A blank line breaks attachment.
            unattached.extend(pending)
            pending = []
    unattached.extend(pending)
    candidates = {}
    nearest_by_level = [None] * 7
    for heading in reversed(headings):
        work.add(1 + heading["level"])
        following_starts = [nearest_by_level[level]
                            for level in range(1, heading["level"] + 1)
                            if nearest_by_level[level] is not None]
        heading["end"] = (min(following_starts) - 1
                          if following_starts else len(records))
        nearest_by_level[heading["level"]] = heading["start"]
        for name in [heading["generated"], *heading["aliases"]]:
            candidates.setdefault(name, []).append(heading)
    ambiguous_unattached = {}
    for name, number in unattached:
        ambiguous_unattached.setdefault(name, []).append(number)
    return records, candidates, ambiguous_unattached, explicit_counts


def resolve_relative(layout: str, source_physical: str, destination: str):
    path_part, fragment = split_target(destination)
    if EXTERNAL.match(destination) or destination.startswith(("//", "/")):
        return None, fragment, "non-local"
    physical, logical = resolve_published_link(layout, source_physical, path_part)
    return (physical, logical), fragment, "local"


def containing_block(records, line_number, minimum, maximum, outside_numbers):
    start = end = line_number
    while (start > minimum and start - 1 in outside_numbers
           and records[start - 2][1].strip()
           and not HEADING.match(records[start - 2][1])):
        start -= 1
    while (end < maximum and end + 1 in outside_numbers and records[end][1].strip()
           and not HEADING.match(records[end][1])):
        end += 1
    return start, end


def _select_span(line_count, candidates, unattached, explicit_counts, logical, fragment):
    """Select an indexed exact heading, or a fragmentless whole-file target."""
    if not fragment:
        return 1, line_count, "whole-file"
    if fragment in unattached:
        code = ("duplicate_or_ambiguous_anchor" if candidates.get(fragment)
                or explicit_counts.get(fragment, 0) > 1
                else "ambiguous_anchor_boundary")
        raise CoreError(code, f"anchor boundary is ambiguous: {logical}#{fragment}")
    if explicit_counts.get(fragment, 0) > 1:
        raise CoreError("duplicate_or_ambiguous_anchor",
                        f"anchor is duplicated: {logical}#{fragment}")
    matches = candidates.get(fragment, [])
    unique = {(item["start"], item["line"], item["end"]) for item in matches}
    if len(unique) != 1:
        code = "missing_target" if not matches else "duplicate_or_ambiguous_anchor"
        raise CoreError(code, f"anchor is missing or ambiguous: {logical}#{fragment}")
    heading = matches[0]
    return heading["start"], heading["end"], "heading-span"


def build_result(root: Path, layout: str, source_relative: str, trigger: str,
                 *, max_output: int, max_acquired: int, max_files: int,
                 max_links: int = DEFAULT_LINKS, max_work: int = DEFAULT_WORK):
    work = Work(max_work, max_links, max_output)
    budget = AcquisitionBudget(max_acquired_bytes=max_acquired, max_files=max_files)
    source_logical = source_relative if layout == "source" else source_relative.removeprefix("skills/lunacy/")
    source = budget.read(root, source_relative, source_logical)
    entry_records, governing, row = parse_entry(source, trigger, work)
    destinations = []
    outstanding = []
    non_local = []
    scanned_spans = set()
    row_line = row["line_range"]["start"]
    row_text = entry_records[row_line - 1][1]
    for match in INLINE_LINK.finditer(row_text):
        work.link()
        destination = match.group(1)
        resolved, fragment, state = resolve_relative(layout, source_relative, destination)
        if state == "non-local":
            non_local.append({"target": destination, "resolution_state": "unopened-non-local"})
            continue
        physical, logical = resolved
        acquired = budget.read(root, physical, logical)
        records, candidates, unattached, explicit_counts = anchor_index(acquired.text, work)
        start, end, kind = _select_span(
            len(records), candidates, unattached, explicit_counts, logical, fragment)
        item = excerpt_record(acquired, records, start, end, kind, fragment or None,
                              work=work)
        item["nested_scan"] = "direct-target-scanned-once"
        item["acquisition"] = {"bytes": len(acquired.data), "sha256": acquired.sha256,
                               "freshness": FRESHNESS}
        destinations.append(item)
        span_key = (physical, start, end)
        if span_key in scanned_spans:
            continue
        scanned_spans.add(span_key)
        blocks = set()
        outside_numbers = {number for number, _ in outside_fence_lines(acquired.text)}
        for number in range(start, end + 1):
            work.add()
            if number not in outside_numbers:
                continue
            line = records[number - 1][1]
            for nested in INLINE_LINK.finditer(line):
                work.link()
                nested_target = nested.group(1)
                nested_resolved, nested_fragment, nested_state = resolve_relative(
                    layout, physical, nested_target)
                if nested_state != "local":
                    continue
                nested_physical, nested_logical = nested_resolved
                block_start, block_end = containing_block(
                    records, number, start, end, outside_numbers)
                key = (number, nested_target, block_start, block_end)
                if key in blocks:
                    continue
                blocks.add(key)
                quote = excerpt_record(acquired, records, block_start, block_end,
                                       "source-quote", work=work)
                outstanding.append({
                    "source_logical_path": logical,
                    "source_range": {"start": block_start, "end": block_end},
                    "source_quote": quote["text"],
                    "target": {"logical_path": nested_logical,
                               "fragment": nested_fragment or None},
                    "resolution_state": "unfollowed",
                    "applicability": "caller-decides",
                })
    result = {
        "schema": SCHEMA,
        "status": "ok",
        "host_context": {"identity": None, "claims": "none"},
        "source": {"layout": layout, "root": str(root),
                   "canonical_path": source.canonical_path,
                   "logical_path": source.logical_path, "sha256": source.sha256,
                   "bytes": len(source.data), "freshness": FRESHNESS},
        "selection": {"row": row},
        "governing_excerpts": [governing],
        "destinations": destinations,
        "outstanding_links": outstanding,
        "non_local_links": non_local,
        "limits": {"max_output_bytes": max_output,
                   "max_acquired_bytes": max_acquired,
                   "max_files": max_files, "max_links": max_links,
                   "max_work_units": max_work,
                   "acquired_bytes": budget.acquired_bytes,
                   "files_opened": budget.files_opened,
                   "link_records": work.links, "work_units": work.units,
                   "materialized_source_bytes": work.materialized_bytes,
                   "truncated": False},
        "non_claims": ["not recursive closure", "not a complete obligation set",
                       "not future freshness", "not host, route, or model proof"],
    }
    encoded = stable_json(result)
    if len(encoded) > max_output:
        raise CoreError("output_cap_exceeded", "complete JSON exceeds output cap", 5)
    return encoded


def _build_section_result(root: Path, layout: str, source_relative: str, fragment: str,
                          *, max_output: int, max_acquired: int, max_files: int,
                          max_links: int = DEFAULT_LINKS, max_work: int = DEFAULT_WORK):
    physical, logical = resolve_published_link(
        layout, normalize_relative(source_relative).as_posix(), "", enforce_published=True)
    work = Work(max_work, max_links, max_output)
    budget = AcquisitionBudget(max_acquired_bytes=max_acquired, max_files=max_files)
    source = budget.read(root, physical, logical)
    records, candidates, unattached, explicit_counts = anchor_index(source.text, work)
    start, end, kind = _select_span(
        len(records), candidates, unattached, explicit_counts, logical, fragment)
    excerpt = excerpt_record(source, records, start, end, kind, fragment, work=work)
    excerpt["nested_scan"] = "not-performed"
    excerpt["acquisition"] = {"bytes": len(source.data), "sha256": source.sha256,
                              "freshness": FRESHNESS}
    result = {
        "schema": "lunacy.section_excerpt.v1",
        "status": "ok",
        "host_context": {"identity": None, "claims": "none"},
        "source": {"layout": layout, "root": str(root),
                   "canonical_path": source.canonical_path,
                   "logical_path": source.logical_path, "sha256": source.sha256,
                   "bytes": len(source.data), "freshness": FRESHNESS},
        "selection": {"fragment": fragment},
        "excerpt": excerpt,
        "limits": {"max_output_bytes": max_output,
                   "max_acquired_bytes": max_acquired,
                   "max_files": max_files, "max_links": max_links,
                   "max_work_units": max_work,
                   "acquired_bytes": budget.acquired_bytes,
                   "files_opened": budget.files_opened,
                   "link_records": work.links, "work_units": work.units,
                   "materialized_source_bytes": work.materialized_bytes,
                   "truncated": False},
        "non_claims": ["not recursive closure", "not a complete obligation set",
                       "not future freshness", "not host, route, or model proof",
                       "not authority or applicability"],
    }
    encoded = stable_json(result)
    if len(encoded) > max_output:
        raise CoreError("output_cap_exceeded", "complete JSON exceeds output cap", 5)
    return encoded


def stable_json(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True,
                       separators=(",", ":")) + "\n").encode("utf-8")


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CoreError("usage_error", message, 2)


def bounded_positive(value, name, hard):
    try:
        number = int(value)
    except ValueError as exc:
        raise CoreError("usage_error", f"{name} must be an integer", 2) from exc
    if number < 1 or number > hard:
        raise CoreError("usage_cap_exceeded", f"{name} must be 1..{hard}", 2)
    return number


def parse_args(argv, namespace=None):
    parser = Parser(description=__doc__)
    parser.add_argument("command", choices=("action-excerpt", "section-excerpt"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--layout", required=True, choices=("source", "package"))
    parser.add_argument("--source-relative", required=True)
    selectors = parser.add_mutually_exclusive_group()
    selectors.add_argument("--trigger")
    selectors.add_argument("--trigger-file")
    parser.add_argument("--fragment")
    parser.add_argument("--format", "--f", default="json", choices=("json",))
    parser.add_argument("--max-output-bytes", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--max-acquired-bytes", default=str(DEFAULT_ACQUIRED))
    parser.add_argument("--max-files", default=str(DEFAULT_FILES))
    parser.add_argument("--max-links", default=str(DEFAULT_LINKS))
    parser.add_argument("--max-work-units", default=str(DEFAULT_WORK))
    args = parser.parse_args(argv, namespace=namespace)
    if args.command == "action-excerpt":
        if args.trigger is None and args.trigger_file is None:
            parser.error("one of the arguments --trigger --trigger-file is required")
        if args.fragment is not None:
            parser.error("--fragment is only valid with section-excerpt")
    else:
        if args.trigger is not None or args.trigger_file is not None:
            parser.error("--trigger and --trigger-file are not valid with section-excerpt")
        if args.fragment is None:
            parser.error("section-excerpt requires --fragment")
    for name in (args.root, args.source_relative, args.trigger_file or ""):
        if len(name.encode("utf-8")) > MAX_ARGUMENT:
            raise CoreError("usage_cap_exceeded", "path/root argument exceeds 4 KiB", 2)
    root = Path(args.root)
    if not root.is_absolute():
        raise CoreError("usage_error", "--root must be absolute", 2)
    if root.is_symlink() or not root.is_dir():
        raise CoreError("ancestor_symlink", "--root must be a non-symlink directory", 3)
    root = root.resolve()
    if args.command == "section-excerpt":
        if normalize_relative(args.source_relative).suffix != ".md":
            raise CoreError("usage_error", "--source-relative must name a Markdown .md file", 2)
        if len(args.fragment.encode("utf-8")) > MAX_SELECTOR:
            raise CoreError("usage_cap_exceeded", "selector exceeds 64 KiB", 2)
        if args.fragment.startswith("#"):
            raise CoreError("usage_error", "--fragment must not start with #", 2)
        _, fragment = split_target("#" + args.fragment)
        if not fragment:
            raise CoreError("usage_error", "fragment must not be empty", 2)
        return args, root, fragment
    expected = "SKILL.md" if args.layout == "source" else "skills/lunacy/SKILL.md"
    if args.source_relative != expected:
        raise CoreError("usage_error", f"--source-relative must be {expected}", 2)
    if args.trigger is not None:
        if len(args.trigger.encode("utf-8")) > MAX_SELECTOR:
            raise CoreError("usage_cap_exceeded", "selector exceeds 64 KiB", 2)
        trigger = args.trigger
    else:
        path = Path(args.trigger_file)
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            raise CoreError("usage_error", "--trigger-file must be an absolute regular file", 2)
        with path.open("rb") as stream:
            data = stream.read(MAX_SELECTOR + 1)
        if len(data) > MAX_SELECTOR:
            raise CoreError("usage_cap_exceeded", "selector file exceeds 64 KiB", 2)
        try:
            trigger = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise CoreError("invalid_utf8", "selector file is not UTF-8", 3) from exc
        trigger = trigger.rstrip("\r\n")
    if not trigger:
        raise CoreError("usage_error", "trigger must not be empty", 2)
    return args, root, trigger


def emit_error(error, schema=ERROR_SCHEMA):
    message = str(error)
    payload = {"schema": schema, "status": "error", "code": error.code,
               "message": message}
    data = stable_json(payload)
    if len(data) > 8192:
        low, high = 0, len(message)
        while low < high:
            middle = (low + high + 1) // 2
            payload["message"] = message[:middle]
            if len(stable_json(payload)) <= 8192:
                low = middle
            else:
                high = middle - 1
        payload["message"] = message[:low]
        data = stable_json(payload)
    sys.stderr.buffer.write(data)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    # Keep the recognized command even when later argument validation fails.
    # An early malformed option may prevent recognition; command-first remains
    # identifiable, otherwise the legacy error envelope is the fallback.
    parsed = argparse.Namespace(command=argv[0] if argv else None)
    try:
        args, root, selector = parse_args(argv, namespace=parsed)
        maximum_output = bounded_positive(args.max_output_bytes, "max-output-bytes", HARD_OUTPUT)
        maximum_acquired = bounded_positive(args.max_acquired_bytes, "max-acquired-bytes", HARD_ACQUIRED)
        maximum_files = bounded_positive(args.max_files, "max-files", HARD_FILES)
        maximum_links = bounded_positive(args.max_links, "max-links", HARD_LINKS)
        maximum_work = bounded_positive(args.max_work_units, "max-work-units", HARD_WORK)
        build = _build_section_result if args.command == "section-excerpt" else build_result
        output = build(root, args.layout, args.source_relative, selector,
                       max_output=maximum_output,
                       max_acquired=maximum_acquired, max_files=maximum_files,
                       max_links=maximum_links, max_work=maximum_work)
    except CoreError as error:
        schema = ("lunacy.section_excerpt.error.v1" if parsed.command == "section-excerpt"
                  else ERROR_SCHEMA)
        emit_error(error, schema)
        return error.exit_code
    except Exception as error:  # bounded last-resort diagnostic, no partial stdout
        schema = ("lunacy.section_excerpt.error.v1" if parsed.command == "section-excerpt"
                  else ERROR_SCHEMA)
        emit_error(CoreError("internal_error", f"unexpected implementation failure: {error}", 70),
                   schema)
        return 70
    sys.stdout.buffer.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
