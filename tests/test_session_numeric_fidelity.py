#!/usr/bin/env python3
"""Public-CLI regressions for exact session-receipt numeric identity."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY / "scripts/evidence_index.py"
THREAD = "thread"
TURN = "turn"
SENTINEL = "__RAW_JSON_NUMBER__"


def meta():
    return {"type": "session_meta", "payload": {"id": THREAD, "session_id": THREAD}}


def context():
    return {"type": "turn_context", "payload": {"turn_id": TURN, "model": "model", "effort": "medium"}}


def command(extra=None, *, exit_code=0):
    item = {
        "type": "CommandExecution", "id": "item", "command": ["true"],
        "status": "completed", "exit_code": exit_code,
    }
    if extra is not None:
        item["extra"] = extra
    return {"type": "event_msg", "payload": {
        "type": "item_completed", "thread_id": THREAD, "turn_id": TURN, "item": item,
    }}


def raw_line(record, number):
    encoded = json.dumps(record, separators=(",", ":"))
    marker = json.dumps(SENTINEL)
    if marker not in encoded:
        raise AssertionError("raw-number marker missing")
    return encoded.replace(marker, number).encode() + b"\n"


def ordinary_line(record):
    return json.dumps(record, separators=(",", ":")).encode() + b"\n"


class SessionNumericFidelityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def invoke_bytes(self, data, *extra, source_format="session-receipt"):
        source = self.root / "capture.jsonl"
        source.write_bytes(data)
        before = hashlib.sha256(data).hexdigest()
        result = subprocess.run(
            [os.fspath(SCRIPT), os.fspath(source), "--source-format", source_format,
             "--thread-id", THREAD, "--turn-id", TURN, *extra],
            capture_output=True, timeout=10, check=False,
        )
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
        return result

    def session_prefix(self):
        return ordinary_line(meta()) + ordinary_line(context())

    def assert_conflict(self, first, second):
        result = self.invoke_bytes(self.session_prefix() + first + second)
        self.assertEqual((result.returncode, result.stdout), (2, b""), result.stderr)
        self.assertIn(b"line 4: contradictory duplicate completion", result.stderr)
        self.assertEqual(result.stderr.count(b"\n"), 1)
        self.assertNotIn(b"Traceback", result.stderr)

    def test_distinct_raw_fractional_values_refuse_across_structures(self):
        cases = [
            ("representable-distinct", "1.5", "2.5", SENTINEL),
            ("precision-distinct", "9007199254740992.0", "9007199254740993.0", {"nested": SENTINEL}),
            ("overflow-distinct", "1e400", "2e400", [SENTINEL]),
            ("underflow-distinct", "1e-400", "2e-400", {"nested": [SENTINEL]}),
        ]
        for label, left, right, shape in cases:
            with self.subTest(case=label):
                self.assert_conflict(raw_line(command(shape), left), raw_line(command(shape), right))

    def test_equal_decimal_spellings_and_signed_zero_dedupe_once(self):
        cases = [
            ("equivalent-spellings", ("1.5", "1.50", "15e-1")),
            ("signed-zero", ("-0.0", "0.00", "-0e5")),
        ]
        for label, spellings in cases:
            with self.subTest(case=label):
                data = self.session_prefix() + b"".join(raw_line(command({"nested": [SENTINEL]}), n) for n in spellings)
                result = self.invoke_bytes(data)
                self.assertEqual(result.returncode, 0, result.stderr)
                value = json.loads(result.stdout)
                self.assertEqual(value["observed_command_count"], 1)
                self.assertEqual(len(value["commands"]), 1)

    def test_bool_integer_and_fractional_forms_remain_distinct_recursively(self):
        cases = [
            ("bool-int", ordinary_line(command({"nested": [True]})), ordinary_line(command({"nested": [1]})), 2),
            ("bool-exponent", ordinary_line(command({"nested": [True]})), raw_line(command({"nested": [SENTINEL]}), "1e0"), 2),
            ("int-fractional", ordinary_line(command({"nested": [1]})), raw_line(command({"nested": [SENTINEL]}), "1.0"), 2),
            ("equal-fractional-exponent", raw_line(command({"nested": [SENTINEL]}), "1.0"), raw_line(command({"nested": [SENTINEL]}), "1e0"), 0),
        ]
        for label, left, right, expected in cases:
            with self.subTest(case=label):
                result = self.invoke_bytes(self.session_prefix() + left + right)
                if expected == 0:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertEqual((result.returncode, result.stdout), (2, b""), result.stderr)

    def test_numeric_extras_never_enter_projection(self):
        data = self.session_prefix() + raw_line(command({"secret": [SENTINEL]}), "9007199254740993.0")
        result = self.invoke_bytes(data)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(b"9007199254740993", result.stdout)
        self.assertNotIn(b"secret", result.stdout)

    def test_unsupported_decimal_exponent_refuses_atomically(self):
        valid = ordinary_line(command())
        unsupported = raw_line(command({"nested": SENTINEL}), "1e9999999999999999999")
        result = self.invoke_bytes(self.session_prefix() + valid + unsupported)
        self.assertEqual((result.returncode, result.stdout), (2, b""), result.stderr)
        self.assertIn(b"line 4: JSON value could not be decoded", result.stderr)
        self.assertEqual(result.stderr.count(b"\n"), 1)
        self.assertLessEqual(len(result.stderr), 512)
        self.assertNotIn(b"Traceback", result.stderr)

    def test_app_server_ignored_huge_numeric_extra_keeps_default_decode(self):
        def event(method, *, exit_code, process_id):
            item = {"type": "commandExecution", "id": "item",
                    "status": "inProgress" if method == "item/started" else "completed",
                    "exitCode": exit_code, "command": "true", "cwd": "/tmp",
                    "processId": process_id, "ignored": SENTINEL}
            return {"direction": "receive", "message": {"method": method, "params": {
                "threadId": THREAD, "turnId": TURN, "item": item}}}
        data = raw_line(event("item/started", exit_code=None, process_id="1"), "1e9999999999999999999")
        data += raw_line(event("item/completed", exit_code=0, process_id="1"), "1e9999999999999999999")
        result = self.invoke_bytes(data, source_format="app-server")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["observed_command_count"], 1)

    def test_app_server_float_exit_code_and_process_id_stay_rejected(self):
        base = {"direction": "receive", "message": {"method": "item/started", "params": {
            "threadId": THREAD, "turnId": TURN, "item": {"type": "commandExecution", "id": "item",
            "status": "inProgress", "exitCode": None, "command": "true", "cwd": "/tmp", "processId": "1"}}}}
        cases = []
        exit_float = json.loads(json.dumps(base)); exit_float["message"]["method"] = "item/completed"
        exit_float["message"]["params"]["item"].update(status="completed", exitCode=SENTINEL)
        cases.append(raw_line(exit_float, "0.0"))
        process_float = json.loads(json.dumps(base)); process_float["message"]["params"]["item"]["processId"] = SENTINEL
        cases.append(raw_line(process_float, "1.0"))
        for line in cases:
            with self.subTest():
                result = self.invoke_bytes(line, source_format="app-server")
                self.assertEqual((result.returncode, result.stdout), (2, b""), result.stderr)


if __name__ == "__main__":
    unittest.main()
