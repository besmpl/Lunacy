"""Export the captured catalog through the nightly command-line entry point."""

import json
from pathlib import Path
import sys


def export_catalog(source, destination):
    archive = json.loads(Path(source).read_text(encoding="utf-8"))
    with Path(destination).open("w", encoding="utf-8", newline="") as output:
        output.write("sku,revision,name\n")
        cursor = archive["first"]
        while cursor is not None:
            page = archive["pages"][cursor]
            if not page["rows"]:
                break
            for row in page["rows"]:
                if row["active"]:
                    output.write(
                        f'{row["sku"]},{row["revision"]},{row["name"]}\n')
            cursor = page["next"]


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: catalog_export.py INPUT_JSON OUTPUT_CSV")
    export_catalog(sys.argv[1], sys.argv[2])
