"""Trusted-local import-service oracle; no candidate/reference-generated expectations.

Runtime PASS does not certify migration prose quality or native coordination.
"""
from __future__ import annotations

import csv
from contextlib import closing
import hashlib
import importlib
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import traceback

PREFIX = "LUNACY_EVALUATOR_RESULT_V1 "
CLI_TIMEOUT_SECONDS = 2
CSV_FIELD_LIMIT = 131072
ASSETS = Path(__file__).resolve().parent / "captures"
SEED = [
    {"id": "existing", "email": "old@example.com", "display_name": "Historical"},
    {"id": "keep", "email": "keep@example.com", "display_name": "Keep unchanged"},
]
INVALID_INPUT = {"status": "invalid", "errors": [{"row": 0, "code": "INVALID_INPUT"}]}


class BehaviorFailure(Exception):
    """An observed, completed behavior disagrees with the public contract."""


def expect(condition, detail):
    if not condition:
        raise BehaviorFailure(detail)


def same(actual, expected):
    """JSON-shaped equality that does not accept true as integer 1."""
    if isinstance(expected, dict):
        return (isinstance(actual, dict) and actual.keys() == expected.keys()
                and all(same(actual[key], value) for key, value in expected.items()))
    if isinstance(expected, list):
        return (isinstance(actual, list) and len(actual) == len(expected)
                and all(same(left, right) for left, right in zip(actual, expected)))
    return type(actual) is type(expected) and actual == expected


def emit(status, detail):
    print(PREFIX + json.dumps({"protocol": "lunacy-evaluator-result-v1",
                              "status": status, "detail": detail}, sort_keys=True))


def capture_cases():
    data = json.loads((ASSETS / "expectations.json").read_text(encoding="utf-8"))
    cases = []
    for frozen in data["captureCases"]:
        raw = (ASSETS / frozen["file"]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != frozen["sha256"]:
            raise RuntimeError("frozen capture identity changed: " + frozen["name"])
        cases.append({**frozen, "raw": raw, "payload": raw.decode("utf-8")})
    for frozen in data["inlineCases"]:
        cases.append({**frozen, "raw": frozen["payload"].encode("utf-8")})
    return cases, data["boundaryExpectations"]


def v2_boundary_cases():
    """Hand-derived v2 threshold families; original v1 captures stay frozen."""
    limit = CSV_FIELD_LIMIT
    normal = {"id": "limit", "email": "limit@e", "display_name": "Name"}
    families = [
        ("display-below", "id,email,display_name\nlimit,limit@e," + "x" * (limit - 1) + "\n",
         [{**normal, "display_name": "x" * (limit - 1)}]),
        ("display-at-unicode", "id,email,display_name\nlimit,limit@e," + "λ" * limit + "\n",
         [{**normal, "display_name": "λ" * limit}]),
        ("display-over", "id,email,display_name\nlimit,limit@e," + "x" * (limit + 1) + "\n", None),
        ("display-crlf-at", 'id,email,display_name\nlimit,limit@e,"' + "x" * (limit - 2) + '\r\n"\n',
         [{**normal, "display_name": "x" * (limit - 2) + "\r\n"}]),
        ("display-crlf-over", 'id,email,display_name\nlimit,limit@e,"' + "x" * (limit - 1) + '\r\n"\n', None),
        ("id-at", "id,email,display_name\n" + "i" * limit + ",limit@e,Name\n",
         [{**normal, "id": "i" * limit}]),
        ("id-over", "id,email,display_name\n" + "i" * (limit + 1) + ",limit@e,Name\n", None),
        ("email-at", "id,email,display_name\nlimit," + "e" * (limit - 2) + "@e,Name\n",
         [{**normal, "email": "e" * (limit - 2) + "@e"}]),
        ("email-over", "id,email,display_name\nlimit," + "e" * (limit - 1) + "@e,Name\n", None),
        ("extra-at-unicode", "id,email,display_name,ignored\nlimit,limit@e,Name," + "λ" * limit + "\n", [normal]),
        ("extra-over", "id,email,display_name,ignored\nlimit,limit@e,Name," + "x" * (limit + 1) + "\n", None),
        ("header-at-unicode", "id,email,display_name," + "λ" * limit + "\nlimit,limit@e,Name,ignored\n", [normal]),
        ("header-over", "id,email,display_name," + "x" * (limit + 1) + "\nlimit,limit@e,Name,ignored\n", None),
    ]
    cases = []
    for name, payload, records in families:
        expected = ({"records": [], "errors": [{"row": 0, "code": "INVALID_INPUT"}]}
                    if records is None else {"records": records, "errors": []})
        cases.append({"name": "v2-" + name, "format": "csv", "payload": payload,
                      "raw": payload.encode("utf-8"), "expected": expected})
    record = {**normal, "display_name": "λ" * (limit + 1)}
    payload = json.dumps([record], ensure_ascii=False)
    cases.append({"name": "v2-json-no-csv-limit", "format": "json", "payload": payload,
                  "raw": payload.encode("utf-8"), "expected": {"records": [record], "errors": []}})
    return cases


def result_for(case):
    parsed = case["expected"]
    if parsed["errors"]:
        return {"status": "invalid", "errors": parsed["errors"]}
    return {"status": "ok", "imported": len(parsed["records"])}


def expected_store(records):
    # This is a fixed upsert expectation, not a parser implementation.
    combined = {row["id"]: row for row in SEED}
    combined.update((row["id"], row) for row in records)
    return [combined[key] for key in sorted(combined)]


def disk_snapshot(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


def check_parser_and_store(parse, store, cases, root):
    for case in cases:
        actual = parse.parse_records(case["payload"], case["format"])
        expect(same(actual, case["expected"]), "parser contract mismatch: " + case["name"])
    missing = root / "store-missing.sqlite"
    expect(store.list_customers(missing) == [], "missing store was not empty")
    expect(not missing.exists(), "listing missing store created a database")
    db = root / "store.sqlite"
    records = [dict(row) for row in SEED]
    before = json.dumps(records, sort_keys=True)
    store.commit_customers(db, records)
    expect(json.dumps(records, sort_keys=True) == before, "store mutated caller records")
    expect(store.list_customers(db) == SEED, "store initial persistence mismatch")
    replacement = [{"id": "existing", "email": "new@example.com", "display_name": "Replacement"}]
    store.commit_customers(db, replacement)
    expect(store.list_customers(db) == expected_store(replacement), "store upsert lost historical rows")


def check_service(service, store, cases, root):
    mixed = next(case for case in cases if case["name"] == "late-mixed")
    invalid_dir = root / "service-invalid"
    invalid_dir.mkdir()
    db = invalid_dir / "customers.sqlite"
    store.commit_customers(db, SEED)
    before = disk_snapshot(invalid_dir)
    actual = service.import_customers(db, mixed["payload"], mixed["format"])
    expect(disk_snapshot(invalid_dir) == before, "invalid batch was partially committed")
    expect(store.list_customers(db) == SEED, "invalid batch was partially committed")
    expect(same(actual, result_for(mixed)), "service did not return exact ordered row errors")
    for index, case in enumerate(cases):
        db = root / ("service-" + str(index) + ".sqlite")
        actual = service.import_customers(db, case["payload"], case["format"])
        if case["expected"]["errors"]:
            expect(not db.exists(), "invalid service input created a database: " + case["name"])
        else:
            expect(store.list_customers(db) == sorted(case["expected"]["records"], key=lambda row: row["id"]),
                   "service persistence mismatch: " + case["name"])
        expect(same(actual, result_for(case)), "service result mismatch: " + case["name"])
    late = next(case for case in cases if case["name"] == "late-csv")
    db = root / "service-upsert.sqlite"
    store.commit_customers(db, SEED)
    expect(same(service.import_customers(db, late["payload"], "csv"), result_for(late)), "valid shared import failed")
    expect(store.list_customers(db) == expected_store(late["expected"]["records"]), "valid shared import lost historical rows")
    failed = False
    try:
        service.import_customers(root / "missing-service-parent" / "db.sqlite", late["payload"], "csv")
    except (OSError, sqlite3.Error):
        failed = True
    expect(failed, "service hid a persistence I/O failure")


def check_late_store_failure(service, root):
    # The legacy database and trigger are caller facts, not candidate-created
    # fixtures. Direct SQLite reads witness rollback independently of store.list.
    db = root / "legacy-trigger.sqlite"
    with closing(sqlite3.connect(db)) as connection:
        with connection:
            connection.execute("CREATE TABLE customers (id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL)")
            connection.executemany("INSERT INTO customers VALUES (?, ?, ?)", [
                ("existing", "history@e", "Original history"),
                ("keep", "keep@e", "Caller-owned survivor"),
            ])
            connection.execute("CREATE TRIGGER caller_reject_second BEFORE INSERT ON customers WHEN NEW.id = 'blocked-customer' BEGIN SELECT RAISE(ABORT, 'oracle controlled second-row rejection'); END")
        schema_before = connection.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").fetchall()
    before = db.read_bytes()
    payload = '[{"id":"existing","email":"NEW@E","display_name":"Must roll back"},{"id":"blocked-customer","email":"valid@e","display_name":"Valid but constrained"}]'
    failure = None
    try:
        service.import_customers(db, payload, "json")
    except sqlite3.IntegrityError as error:
        failure = error
    with closing(sqlite3.connect(db)) as connection:
        rows = connection.execute("SELECT id, email, display_name FROM customers ORDER BY id").fetchall()
        schema_after = connection.execute("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").fetchall()
    unchanged = (db.read_bytes() == before and rows == [
        ("existing", "history@e", "Original history"), ("keep", "keep@e", "Caller-owned survivor")
    ] and schema_after == schema_before)
    print(f"import-service late SQLite rejection error={str(failure)!r}; unchanged={unchanged}; rows={rows!r}", file=sys.stderr)
    expect(unchanged, "late persistence failure did not roll back the batch")
    expect(failure is not None and str(failure) == "oracle controlled second-row rejection",
           "service did not propagate caller-owned SQLite rejection")


def decode_result(raw, label):
    expect(isinstance(raw, bytes) and raw.endswith(b"\n"), label + " did not return JSON plus LF")
    try:
        # json.loads requires one document; it rejects extra stdout documents/text.
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise BehaviorFailure(label + " returned invalid JSON: " + str(error)) from error
    return result


def run_cli(candidate, root, raw, fmt, db, label, missing=False):
    source = root / "cli-input"
    if not missing:
        source.write_bytes(raw)
    else:
        source = root / "missing-input"
    completed = subprocess.run(
        [sys.executable, "-B", str(candidate / "cli.py"), "--database", str(db),
         "--format", fmt, "--input", str(source)],
        cwd=candidate, stdin=subprocess.DEVNULL, capture_output=True,
        timeout=CLI_TIMEOUT_SECONDS, check=False,
    )
    print(f"import-service {label} CLI exitCode={completed.returncode}; "
          f"stdout={completed.stdout!r}; stderr={completed.stderr!r}", file=sys.stderr)
    if not missing:
        expect(source.read_bytes() == raw, "CLI modified its input capture")
    return completed


def check_cli(candidate, store, cases, root):
    selected = [case for case in cases if case["name"] in {
        "initial-json", "initial-csv", "late-csv", "late-json", "late-mixed", "json-syntax", "csv-wide-row", "empty-json", "empty-csv"} or case["name"].startswith("v2-")]
    for index, case in enumerate(selected):
        db = root / ("cli-" + str(index) + ".sqlite")
        store.commit_customers(db, SEED)
        before = db.read_bytes()
        completed = run_cli(candidate, root, case["raw"], case["format"], db, case["name"])
        errors = case["expected"]["errors"]
        expect(completed.returncode == (2 if errors else 0), "CLI exit mismatch: " + case["name"])
        expect(same(decode_result(completed.stdout, "CLI " + case["name"]), result_for(case)), "CLI result mismatch: " + case["name"])
        if errors:
            expect(db.read_bytes() == before and store.list_customers(db) == SEED, "CLI invalid batch changed historical data")
        else:
            detail = "CLI rewrote preserved CSV display_name" if case["name"] == "late-csv" else "CLI persistence mismatch: " + case["name"]
            expect(store.list_customers(db) == expected_store(case["expected"]["records"]), detail)
    for index, (raw, fmt) in enumerate([(b"\xff", "json"), (b"id,email,display_name\nx,x@e,\xff\n", "csv")]):
        db = root / ("cli-utf8-" + str(index) + ".sqlite")
        completed = run_cli(candidate, root, raw, fmt, db, "invalid UTF-8")
        expect(completed.returncode == 2, "CLI invalid UTF-8 exit was not 2")
        expect(same(decode_result(completed.stdout, "CLI invalid UTF-8"), INVALID_INPUT), "CLI invalid UTF-8 result mismatch")
        expect(not db.exists(), "CLI invalid UTF-8 created database")
    mixed = next(case for case in cases if case["name"] == "late-mixed")
    db = root / "cli-invalid-absent.sqlite"
    completed = run_cli(candidate, root, mixed["raw"], "json", db, "invalid absent database")
    expect(completed.returncode == 2 and same(decode_result(completed.stdout, "CLI invalid absent database"), result_for(mixed)), "CLI invalid absent-database result mismatch")
    expect(not db.exists(), "CLI invalid batch created database")
    valid = next(case for case in cases if case["name"] == "initial-json")
    for label, db, missing in [("missing input", root / "cli-missing-source.sqlite", True),
                               ("persistence I/O failure", root / "missing-cli-parent" / "db.sqlite", False)]:
        completed = run_cli(candidate, root, valid["raw"], "json", db, label, missing=missing)
        expect(completed.returncode != 0, "CLI hid " + label)
        try:
            result = json.loads(completed.stdout)
        except (UnicodeError, json.JSONDecodeError):
            result = None
        expect(not (isinstance(result, dict) and result.get("status") == "ok"), "CLI reported ok for " + label)


class FramedStream:
    """Ordinary binary short-reading stream with an observable declared boundary."""
    def __init__(self, body, declared, chunk=3):
        self.body = body
        self.declared = declared
        self.chunk = chunk
        self.position = 0
        self.requests = []

    def read(self, size=-1):
        expect(isinstance(size, int) and 0 <= size <= self.declared - self.position,
               "WSGI read was not bounded by declared body length")
        self.requests.append(size)
        count = min(size, self.chunk, len(self.body) - self.position)
        result = self.body[self.position:self.position + count]
        self.position += count
        return result


def call_http(application, db, raw, media, label, *, path="/imports", method="POST", length="auto", stream=None):
    if length == "auto":
        length = str(len(raw))
    env = {"PATH_INFO": path, "REQUEST_METHOD": method, "CONTENT_TYPE": media,
           "wsgi.input": stream if stream is not None else io.BytesIO(raw), "lunacy.database": db}
    if length is not None:
        env["CONTENT_LENGTH"] = length
    responses = []
    def start_response(status, headers, exc_info=None):
        responses.append((status, headers))
    body = application(env, start_response)
    expect(isinstance(body, list) and len(body) == 1 and isinstance(body[0], bytes), "WSGI response is not one-element bytes list")
    expect(len(responses) == 1, "WSGI did not call start_response exactly once")
    status, raw_headers = responses[0]
    headers = {key.lower(): value for key, value in raw_headers}
    expect(sum(key.lower() == "content-type" for key, _ in raw_headers) == 1
           and headers.get("content-type") == "application/json", "WSGI Content-Type mismatch")
    expect(sum(key.lower() == "content-length" for key, _ in raw_headers) == 1
           and headers.get("content-length") == str(len(body[0])), "WSGI Content-Length mismatch")
    result = decode_result(body[0], "WSGI " + label)
    print(f"import-service {label} WSGI status={status!r}; headers={raw_headers!r}; body={body[0]!r}", file=sys.stderr)
    return status, result


def check_http(application, store, cases, boundaries, root):
    selected = [case for case in cases if case["name"] in {
        "initial-json", "initial-csv", "late-csv", "late-json", "late-mixed", "json-syntax", "csv-wide-row", "empty-json", "empty-csv"} or case["name"].startswith("v2-")]
    for index, case in enumerate(selected):
        db = root / ("http-" + str(index) + ".sqlite")
        store.commit_customers(db, SEED)
        before = db.read_bytes()
        media = "application/json" if case["format"] == "json" else "text/csv"
        stream = FramedStream(case["raw"] + b"DO-NOT-CONSUME", len(case["raw"]),
                              chunk=4093 if case["name"].startswith("v2-") else 3)
        status, actual = call_http(application, db, case["raw"], media, case["name"], stream=stream)
        expect(stream.position == len(case["raw"]), "WSGI did not consume exactly declared bytes: " + case["name"])
        errors = case["expected"]["errors"]
        expect(status == ("400 Bad Request" if errors else "200 OK"), "WSGI status mismatch: " + case["name"])
        expect(same(actual, result_for(case)), "WSGI result mismatch: " + case["name"])
        if errors:
            expect(db.read_bytes() == before and store.list_customers(db) == SEED, "WSGI invalid batch changed historical data")
        else:
            expect(store.list_customers(db) == expected_store(case["expected"]["records"]), "WSGI persistence mismatch: " + case["name"])
    body = b"[]"
    for index, media in enumerate(boundaries["validMediaTypes"]):
        raw = b"id,email,display_name\n" if media.lower().strip().startswith("text/csv") else body
        status, actual = call_http(application, root / ("http-media-" + str(index) + ".sqlite"), raw, media, "accepted media")
        expect(status == "200 OK" and same(actual, {"status": "ok", "imported": 0}), "WSGI rejected supported media spelling")
    invalid_dir = root / "http-invalid-metadata"
    invalid_dir.mkdir()
    db = invalid_dir / "absent.sqlite"
    invalids = []
    for length in boundaries["invalidLengths"]:
        invalids.append(("invalid length " + repr(length), b"[]", "application/json", {"length": length}, "400 Bad Request", INVALID_INPUT))
    for media in boundaries["invalidMediaTypes"]:
        invalids.append(("unsupported media " + repr(media), b"[]", media, {}, "415 Unsupported Media Type", {"status": "error", "code": "UNSUPPORTED_MEDIA_TYPE"}))
    invalids.extend([
        ("invalid UTF-8", b"\xff", "application/json", {}, "400 Bad Request", INVALID_INPUT),
        ("premature EOF", b"[", "application/json", {"length": "2"}, "400 Bad Request", INVALID_INPUT),
        ("zero body", b"[]", "application/json", {"length": "0"}, "400 Bad Request", INVALID_INPUT),
        ("path precedence", b"\xff", "invalid", {"path": "/other", "method": "GET", "length": "bad"}, "404 Not Found", {"status": "error", "code": "NOT_FOUND"}),
        ("method precedence", b"\xff", "invalid", {"method": "GET", "length": "bad"}, "405 Method Not Allowed", {"status": "error", "code": "METHOD_NOT_ALLOWED"}),
        ("media precedence", b"\xff", "invalid", {"length": "bad"}, "415 Unsupported Media Type", {"status": "error", "code": "UNSUPPORTED_MEDIA_TYPE"}),
    ])
    for label, raw, media, options, expected_status, expected in invalids:
        before = disk_snapshot(invalid_dir)
        status, actual = call_http(application, db, raw, media, label, **options)
        expect(status == expected_status and same(actual, expected), "WSGI boundary mismatch: " + label)
        expect(disk_snapshot(invalid_dir) == before, "WSGI rejected request created or changed database")
    # Leading zeroes are valid decimal spelling, and a tail belongs to the next request.
    stream = FramedStream(b"[]tail", 2, chunk=1)
    status, actual = call_http(application, root / "http-leading-zero.sqlite", body, "application/json", "leading-zero length", length="002", stream=stream)
    expect(status == "200 OK" and same(actual, {"status": "ok", "imported": 0}) and stream.position == 2, "WSGI declared-byte framing mismatch")
    mixed = next(case for case in cases if case["name"] == "late-mixed")
    absent = root / "http-invalid-absent.sqlite"
    status, actual = call_http(application, absent, mixed["raw"], "application/json", "invalid absent database")
    expect(status == "400 Bad Request" and same(actual, result_for(mixed)), "WSGI invalid absent-database result mismatch")
    expect(not absent.exists(), "WSGI invalid batch created database")
    valid = next(case for case in cases if case["name"] == "initial-json")
    responses = []
    failed = False
    try:
        application({"PATH_INFO": "/imports", "REQUEST_METHOD": "POST", "CONTENT_TYPE": "application/json",
                     "CONTENT_LENGTH": str(len(valid["raw"])), "wsgi.input": io.BytesIO(valid["raw"]),
                     "lunacy.database": root / "missing-http-parent" / "db.sqlite"},
                    lambda status, headers: responses.append(status))
    except (OSError, sqlite3.Error):
        failed = True
    expect(failed and "200 OK" not in responses, "WSGI hid a persistence I/O failure")


def check_stream_failure(application, root):
    class FailingRead(io.BytesIO):
        def read(self, size=-1):
            raise OSError("oracle controlled input-stream failure")

    db = root / "stream-error.sqlite"
    responses = []
    failure = None
    try:
        application({"PATH_INFO": "/imports", "REQUEST_METHOD": "POST", "CONTENT_TYPE": "application/json",
                     "CONTENT_LENGTH": "2", "wsgi.input": FailingRead(b"[]"), "lunacy.database": db},
                    lambda status, headers: responses.append(status))
    except OSError as error:
        failure = error
    print(f"import-service input-stream error={str(failure)!r}; responses={responses!r}", file=sys.stderr)
    expect(failure is not None and str(failure) == "oracle controlled input-stream failure" and "200 OK" not in responses,
           "WSGI hid an input-stream I/O failure")
    expect(not db.exists(), "WSGI stream failure created a database")


def evaluate(candidate):
    # Read, never change, the process-global CSV configuration. A mismatched
    # interpreter is unsupported infrastructure, not a candidate behavior FAIL.
    observed_limit = csv.field_size_limit()
    if observed_limit != CSV_FIELD_LIMIT:
        raise RuntimeError(f"CSV runtime prerequisite: field_size_limit must be 131072 (observed {observed_limit})")
    # Candidate is trusted local code. Ordinary imports preserve maintained wiring.
    sys.path.insert(0, str(candidate))
    parse = importlib.import_module("core.parse")
    store = importlib.import_module("core.store")
    service = importlib.import_module("service")
    http_api = importlib.import_module("http_api")
    cases, boundaries = capture_cases()
    cases.extend(v2_boundary_cases())
    with tempfile.TemporaryDirectory(prefix="lunacy-import-service-") as temporary:
        root = Path(temporary)
        check_parser_and_store(parse, store, cases, root)
        check_service(service, store, cases, root)
        check_late_store_failure(service, root)
        check_cli(candidate, store, cases, root)
        check_http(http_api.application, store, cases, boundaries, root)
        check_stream_failure(http_api.application, root)
    migration = candidate / "docs" / "migrate.md"
    expect(migration.is_file() and bool(migration.read_text(encoding="utf-8").strip()), "migration guidance file is missing or empty")
    print("Runtime boundary: migration prose quality and native coordination remain unverified.", file=sys.stderr)


if __name__ == "__main__":
    try:
        evaluate(Path(sys.argv[1]).resolve())
    except BehaviorFailure as error:
        emit("FAIL", str(error))
        raise SystemExit(1)
    except Exception:
        # Import/runtime errors are evaluator ERROR, not a fabricated behavior result.
        traceback.print_exc()
        raise SystemExit(2)
    emit("PASS", "PASS")
