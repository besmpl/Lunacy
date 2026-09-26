"""Shared customer import operation."""

from core.parse import parse_records
from core.store import commit_customers


def import_customers(db_path, payload: str, format: str) -> dict:
    parsed = parse_records(payload, format)
    commit_customers(db_path, parsed["records"])
    if parsed["errors"]:
        return {"status": "invalid", "errors": parsed["errors"]}
    return {"status": "ok", "imported": len(parsed["records"])}
