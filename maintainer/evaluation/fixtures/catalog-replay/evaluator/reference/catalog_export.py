"""Reference implementation for the bounded local catalog export contract."""

import argparse
import csv
import io
import json
from pathlib import Path
import sys


def _current_rows(archive):
    """Validate the reachable capture and return sorted live current rows."""
    if not isinstance(archive, dict) or not {"first", "pages"} <= archive.keys():
        raise ValueError("archive requires first and pages")
    cursor, pages = archive["first"], archive["pages"]
    if (cursor is not None and not isinstance(cursor, str)) or not isinstance(pages, dict):
        raise ValueError("first must be a cursor or null; pages must be an object")

    seen = set()
    current = {}
    while cursor is not None:
        if cursor in seen or cursor not in pages:
            raise ValueError("reachable cursor is repeated or missing")
        seen.add(cursor)
        page = pages[cursor]
        if not isinstance(page, dict) or not {"rows", "next"} <= page.keys():
            raise ValueError("reachable page requires rows and next")
        rows, following = page["rows"], page["next"]
        if not isinstance(rows, list) or (following is not None and not isinstance(following, str)):
            raise ValueError("rows must be an array; next must be a cursor or null")
        for row in rows:
            if not isinstance(row, dict) or not {"sku", "revision", "active", "name"} <= row.keys():
                raise ValueError("row requires sku, revision, active and name")
            sku, revision, active, name = (row["sku"], row["revision"],
                                           row["active"], row["name"])
            if (not isinstance(sku, str) or not sku
                    or type(revision) is not int or revision < 0
                    or type(active) is not bool or not isinstance(name, str)):
                raise ValueError("invalid catalog row field type or value")
            previous = current.get(sku)
            if previous is None or revision > previous[0]:
                current[sku] = (revision, active, name, False)
            elif revision == previous[0] and (active, name) != previous[1:3]:
                current[sku] = (*previous[:3], True)
        cursor = following

    # A conflict observed early can be superseded by a later, higher revision.
    if any(state[3] for state in current.values()):
        raise ValueError("conflicting payloads at the greatest revision")
    return [(sku, revision, name)
            for sku, (revision, active, name, _) in sorted(current.items())
            if active]


def _render_csv(rows):
    output = []
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\r\n")
    for row in [("sku", "revision", "name"), *rows]:
        writer.writerow(row)
        # CRLF makes the stdlib quote both CR and LF inside fields. Change only
        # this record's final terminator, never the contents of its fields.
        output.append(stream.getvalue()[:-2] + "\n")
        stream.seek(0)
        stream.truncate()
    return "".join(output).encode("utf-8")


def export_catalog(source, destination):
    archive = json.loads(Path(source).read_text(encoding="utf-8"))
    content = _render_csv(_current_rows(archive))
    # No destination is opened until parsing, acquisition, validation and
    # encoding have succeeded. Write/disk failure durability is out of scope.
    Path(destination).write_bytes(content)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args(argv)
    try:
        export_catalog(args.source, args.destination)
    except (OSError, ValueError, TypeError) as error:
        print(f"catalog export failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
