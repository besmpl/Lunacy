"""Shared atomic customer import operation."""

from core.parse import parse_records
from core.store import commit_customers


def import_customers(db_path, payload: str, format: str) -> dict:
    parsed = parse_records(payload, format)
    if parsed["errors"]:
        return {"status": "invalid", "errors": parsed["errors"]}
    commit_customers(db_path, parsed["records"])
    return {"status": "ok", "imported": len(parsed["records"])}
