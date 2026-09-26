"""Independent controls for the fixed import-service evaluator (stdlib only)."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

# One override permits task-local staging; the default is the integrated layout.
FIXTURE = Path(os.environ.get("IMPORT_SERVICE_FIXTURE", str(
    Path(__file__).resolve().parents[1] / "evaluation" / "fixtures" / "import-service")))
PREFIX = "LUNACY_EVALUATOR_RESULT_V1 "
FROZEN_EXPECTATIONS = "289117e23b1fb3be354bb51305c62f3ee8134184810492a42296019266981f14"


class ImportServiceOracleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="import-oracle-control-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def candidate(self, variant="reference"):
        candidate = self.root / "candidate"
        shutil.copytree(FIXTURE / "worker", candidate)
        if variant != "starter":
            shutil.copytree(FIXTURE / "evaluator" / variant, candidate, dirs_exist_ok=True)
        return candidate

    def check(self, candidate, csv_limit=None):
        checker = FIXTURE / "evaluator" / "check.py"
        command = [sys.executable, "-I", "-B", str(checker), str(candidate)]
        if csv_limit is not None:
            # Only mock the getter in this disposable subprocess: do not set the
            # process-global CSV parser configuration in checker or tests.
            code = ("import runpy, sys; from unittest.mock import patch; "
                    "checker, candidate, value = sys.argv[1:]; "
                    "sys.argv = [checker, candidate]; "
                    "guard = patch('csv.field_size_limit', return_value=int(value)); "
                    "guard.start(); runpy.run_path(checker, run_name='__main__')")
            command = [sys.executable, "-I", "-B", "-c", code, str(checker), str(candidate), str(csv_limit)]
        completed = subprocess.run(command,
                                   stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                   timeout=5, check=False)
        records = [json.loads(line[len(PREFIX):]) for line in completed.stdout.splitlines() if line.startswith(PREFIX)]
        return completed, records

    def assert_behavior(self, candidate, status, detail):
        completed, records = self.check(candidate)
        self.assertEqual(completed.returncode, 0 if status == "PASS" else 1,
                         (completed.stdout, completed.stderr))
        self.assertEqual(records, [{"protocol": "lunacy-evaluator-result-v1", "status": status, "detail": detail}],
                         (completed.stdout, completed.stderr))
        return completed

    def append(self, candidate, name, code):
        with (candidate / name).open("a", encoding="utf-8") as target:
            target.write("\n" + code + "\n")

    def test_frozen_expectation_identity(self):
        self.assertEqual(hashlib.sha256((FIXTURE / "evaluator" / "captures" / "expectations.json").read_bytes()).hexdigest(), FROZEN_EXPECTATIONS)

    def test_reference_passes_actual_cli_and_wsgi(self):
        completed = self.assert_behavior(self.candidate(), "PASS", "PASS")
        self.assertIn("CLI exitCode=2", completed.stderr)
        self.assertIn("WSGI status='400 Bad Request'", completed.stderr)
        self.assertIn("migration prose quality and native coordination remain unverified", completed.stderr)

    def test_starter_has_real_partial_commit_failure(self):
        self.assert_behavior(self.candidate("starter"), "FAIL", "invalid batch was partially committed")

    def test_incomplete_misses_newline_preservation(self):
        self.assert_behavior(self.candidate("incomplete"), "FAIL", "CLI rewrote preserved CSV display_name")

    def test_import_errors_are_error_not_synthetic_failure(self):
        candidate = self.candidate()
        (candidate / "service.py").write_text("raise ImportError('deliberate import control')\n", encoding="utf-8")
        completed, records = self.check(candidate)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(records, [])
        self.assertIn("deliberate import control", completed.stderr)

    def test_unexpected_runtime_errors_are_error_not_synthetic_failure(self):
        candidate = self.candidate()
        self.append(candidate, "service.py", "def import_customers(*args, **kwargs):\n    raise RuntimeError('deliberate runtime control')")
        completed, records = self.check(candidate)
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(records, [])
        self.assertIn("deliberate runtime control", completed.stderr)

    def test_preview_records_do_not_authorize_partial_commit(self):
        candidate = self.candidate()
        self.append(candidate, "service.py", '''
from core import parse as _oracle_parse, store as _oracle_store
def import_customers(db_path, payload, format):
    parsed = _oracle_parse.parse_records(payload, format)
    _oracle_store.commit_customers(db_path, parsed["records"])
    if parsed["errors"]:
        return {"status": "invalid", "errors": parsed["errors"]}
    return {"status": "ok", "imported": len(parsed["records"])}
''')
        self.assert_behavior(candidate, "FAIL", "invalid batch was partially committed")

    def test_ordered_error_control_is_rejected(self):
        candidate = self.candidate()
        self.append(candidate, "service.py", '''
_oracle_original_import = import_customers
def import_customers(db_path, payload, format):
    result = _oracle_original_import(db_path, payload, format)
    if result["status"] == "invalid":
        result["errors"] = list(reversed(result["errors"]))
    return result
''')
        self.assert_behavior(candidate, "FAIL", "service did not return exact ordered row errors")

    def test_false_is_not_an_exact_zero_import_count(self):
        candidate = self.candidate()
        self.append(candidate, "service.py", '''
_oracle_original_import = import_customers
def import_customers(db_path, payload, format):
    result = _oracle_original_import(db_path, payload, format)
    if result == {"status": "ok", "imported": 0}:
        result["imported"] = False
    return result
''')
        self.assert_behavior(candidate, "FAIL", "service result mismatch: empty-json")

    def test_short_read_control_is_rejected(self):
        candidate = self.candidate()
        self.append(candidate, "http_api.py", '''
import io as _oracle_io
_oracle_original_application = application
def application(environ, start_response):
    environ = dict(environ)
    if environ.get("CONTENT_LENGTH", "").isdigit():
        data = environ["wsgi.input"].read(int(environ["CONTENT_LENGTH"]))
        environ["wsgi.input"] = _oracle_io.BytesIO(data)
        environ["CONTENT_LENGTH"] = str(len(data))
    return _oracle_original_application(environ, start_response)
''')
        self.assert_behavior(candidate, "FAIL", "WSGI did not consume exactly declared bytes: initial-json")

    def test_unbounded_body_read_is_rejected(self):
        candidate = self.candidate()
        self.append(candidate, "http_api.py", '''
_oracle_original_application = application
def application(environ, start_response):
    environ["wsgi.input"].read()
    return _oracle_original_application(environ, start_response)
''')
        self.assert_behavior(candidate, "FAIL", "WSGI read was not bounded by declared body length")

    def test_actual_http_header_control_is_rejected(self):
        candidate = self.candidate()
        self.append(candidate, "http_api.py", '''
_oracle_original_application = application
def application(environ, start_response):
    def wrong_header(status, headers, exc_info=None):
        headers = [(key, "0" if key.lower() == "content-length" else value) for key, value in headers]
        return start_response(status, headers)
    return _oracle_original_application(environ, wrong_header)
''')
        self.assert_behavior(candidate, "FAIL", "WSGI Content-Length mismatch")

    def test_mid_batch_sqlite_failure_rolls_back_prior_write(self):
        candidate = self.candidate()
        self.append(candidate, "core/store.py", '''
import sqlite3 as _oracle_sqlite
from contextlib import closing as _oracle_closing
def commit_customers(db_path, records):
    with _oracle_closing(_oracle_sqlite.connect(db_path)) as connection:
        with connection:
            connection.execute("CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL)")
        for record in records:
            with connection:
                connection.execute("INSERT INTO customers VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET email=excluded.email, display_name=excluded.display_name", (record["id"], record["email"], record["display_name"]))
''')
        self.assert_behavior(candidate, "FAIL", "late persistence failure did not roll back the batch")

    def test_wsgi_stream_oserror_must_propagate(self):
        candidate = self.candidate()
        self.append(candidate, "http_api.py", '''
_oracle_original_application = application
def application(environ, start_response):
    try:
        return _oracle_original_application(environ, start_response)
    except OSError:
        body = b'{"status":"invalid","errors":[{"row":0,"code":"INVALID_INPUT"}]}\\n'
        start_response("400 Bad Request", [("Content-Type", "application/json"), ("Content-Length", str(len(body)))])
        return [body]
''')
        self.assert_behavior(candidate, "FAIL", "WSGI hid an input-stream I/O failure")

    def test_csv_limit_environment_mismatch_is_error(self):
        completed, records = self.check(self.candidate(), csv_limit=65536)
        self.assertEqual(completed.returncode, 2, (completed.stdout, completed.stderr))
        self.assertEqual(records, [])
        self.assertIn("CSV runtime prerequisite: field_size_limit must be 131072", completed.stderr)

    def test_csv_cap_counts_characters_not_encoded_bytes(self):
        candidate = self.candidate()
        self.append(candidate, "core/parse.py", '''
_oracle_original_parse = parse_records
def parse_records(payload, format):
    result = _oracle_original_parse(payload, format)
    if format == "csv" and any(len(row["display_name"].encode("utf-8")) > 131072 for row in result["records"]):
        return {"records": [], "errors": [{"row": 0, "code": "INVALID_INPUT"}]}
    return result
''')
        self.assert_behavior(candidate, "FAIL", "parser contract mismatch: v2-display-at-unicode")

    def test_csv_cap_is_inclusive(self):
        candidate = self.candidate()
        self.append(candidate, "core/parse.py", '''
_oracle_original_parse = parse_records
def parse_records(payload, format):
    result = _oracle_original_parse(payload, format)
    if format == "csv" and any(len(row["display_name"]) >= 131072 for row in result["records"]):
        return {"records": [], "errors": [{"row": 0, "code": "INVALID_INPUT"}]}
    return result
''')
        self.assert_behavior(candidate, "FAIL", "parser contract mismatch: v2-display-at-unicode")

    def test_csv_ignored_field_cannot_evade_size_bound(self):
        candidate = self.candidate()
        self.append(candidate, "core/parse.py", '''
_oracle_original_parse = parse_records
def parse_records(payload, format):
    result = _oracle_original_parse(payload, format)
    lines = payload.splitlines()
    if format == "csv" and result["errors"] and len(lines) == 2:
        header, row = [line.split(",") for line in lines]
        if len(header) == len(row) == 4 and len(row[-1]) > 131072:
            return _oracle_original_parse(",".join(header[:3]) + "\\n" + ",".join(row[:3]) + "\\n", format)
    return result
''')
        self.assert_behavior(candidate, "FAIL", "parser contract mismatch: v2-extra-over")

    def test_csv_header_field_cannot_evade_size_bound(self):
        candidate = self.candidate()
        self.append(candidate, "core/parse.py", '''
_oracle_original_parse = parse_records
def parse_records(payload, format):
    result = _oracle_original_parse(payload, format)
    lines = payload.splitlines()
    if format == "csv" and result["errors"] and len(lines) == 2:
        header, row = [line.split(",") for line in lines]
        if len(header) == len(row) == 4 and len(header[-1]) > 131072:
            return _oracle_original_parse(",".join(header[:3]) + "\\n" + ",".join(row[:3]) + "\\n", format)
    return result
''')
        self.assert_behavior(candidate, "FAIL", "parser contract mismatch: v2-header-over")

    def test_runtime_does_not_certify_migration_semantics(self):
        candidate = self.candidate()
        (candidate / "docs" / "migrate.md").write_text("This intentionally lacks migration guidance.\n", encoding="utf-8")
        self.assert_behavior(candidate, "PASS", "PASS")

    def test_missing_migration_file_rejected(self):
        candidate = self.candidate()
        (candidate / "docs" / "migrate.md").unlink()
        self.assert_behavior(candidate, "FAIL", "migration guidance file is missing or empty")


if __name__ == "__main__":
    unittest.main()
