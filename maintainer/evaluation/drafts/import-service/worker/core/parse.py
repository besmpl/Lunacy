"""Pure parsing and row validation shared by every import adapter."""

import csv
import io
import json


def _input_rows(payload, format):
    if format == "json":
        try:
            rows = json.loads(payload)
        except json.JSONDecodeError:
            return None
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            return None
        return rows
    if format != "csv":
        return None
    try:
        rows = list(csv.reader(io.StringIO(payload, newline=""), strict=True))
    except csv.Error:
        return None
    if not rows:
        return None
    header, *data = rows
    if any(header.count(field) != 1 for field in ("id", "email", "display_name")):
        return None
    if any(len(row) != len(header) for row in data):
        return None
    return [dict(zip(header, row)) for row in data]


def _validate_row(row):
    customer_id = row.get("id")
    if not isinstance(customer_id, str) or not customer_id.strip():
        return None, "INVALID_ID"
    email = row.get("email")
    if not isinstance(email, str):
        return None, "INVALID_EMAIL"
    email = email.strip().lower()
    parts = email.split("@")
    if len(parts) != 2 or not all(parts) or any(char.isspace() for char in email):
        return None, "INVALID_EMAIL"
    name = row.get("display_name")
    if not isinstance(name, str):
        return None, "INVALID_DISPLAY_NAME"
    return {"id": customer_id.strip(), "email": email, "display_name": name}, None


def parse_records(payload: str, format: str) -> dict:
    """Return normalized previews and one ordered error per invalid data row."""
    rows = _input_rows(payload, format)
    if rows is None:
        return {"records": [], "errors": [{"row": 0, "code": "INVALID_INPUT"}]}
    records, errors = [], []
    seen = set()
    for number, row in enumerate(rows, 1):
        record, error = _validate_row(row)
        if error is None and record["id"] in seen:
            error = "DUPLICATE_ID"
        if error is not None:
            errors.append({"row": number, "code": error})
        else:
            seen.add(record["id"])
            records.append(record)
    return {"records": records, "errors": errors}
