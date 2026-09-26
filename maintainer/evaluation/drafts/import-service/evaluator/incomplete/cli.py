"""Deliberate control: ordinary text reading quietly translates CR/CRLF."""
import argparse
import json
from pathlib import Path

from service import import_customers


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--format", choices=("json", "csv"), required=True)
    parser.add_argument("--input", required=True)
    args = parser.parse_args(argv)
    try:
        # This is a real maintained-adapter mistake, not an import/syntax trap.
        payload = Path(args.input).read_text(encoding="utf-8")
    except UnicodeDecodeError:
        result = {"status": "invalid", "errors": [{"row": 0, "code": "INVALID_INPUT"}]}
    else:
        result = import_customers(args.database, payload, args.format)
    print(json.dumps(result))
    return 0 if result["status"] == "ok" else 2


if __name__ == "__main__":
    raise SystemExit(main())
