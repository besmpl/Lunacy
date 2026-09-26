"""Command-line customer import adapter."""

import argparse
import json
from pathlib import Path

from service import import_customers


def main(argv=None):
    parser = argparse.ArgumentParser(description="Import customers from a UTF-8 JSON or CSV file.")
    parser.add_argument("--database", required=True)
    parser.add_argument("--format", choices=("json", "csv"), required=True)
    parser.add_argument("--input", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        payload = args.input.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        result = {"status": "invalid", "errors": [{"row": 0, "code": "INVALID_INPUT"}]}
    else:
        result = import_customers(args.database, payload, args.format)
    print(json.dumps(result))
    return 0 if result["status"] == "ok" else 2


if __name__ == "__main__":
    raise SystemExit(main())
