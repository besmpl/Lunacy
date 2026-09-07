#!/usr/bin/env python3
"""Public-CLI regressions for bounded observer argument refusals."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY / "scripts/evidence_index.py"
FIXTURES = REPOSITORY / "tests/fixtures"
THREAD = "thread"
TURN = "turn"


def golden(name, source=None):
    expected = (FIXTURES / name).read_bytes()
    if source is not None:
        escaped_path = json.dumps(os.fspath(source), ensure_ascii=False)[1:-1].encode()
        expected = expected.replace(b"{{SOURCE_PATH}}", escaped_path)
        expected = expected.replace(
            b"{{SOURCE_SHA256}}", hashlib.sha256(source.read_bytes()).hexdigest().encode()
        )
    return expected


def app_records():
    item = {
        "type": "commandExecution", "id": "item", "command": "true",
        "cwd": "/tmp", "processId": "7", "exitCode": None,
        "status": "inProgress",
    }
    start = {"direction": "receive", "message": {"method": "item/started", "params": {
        "threadId": THREAD, "turnId": TURN, "item": item,
    }}}
    terminal = json.loads(json.dumps(start))
    terminal["message"]["method"] = "item/completed"
    terminal["message"]["params"]["item"].update(status="completed", exitCode=0)
    return start, terminal


def session_records():
    return (
        {"type": "session_meta", "payload": {"id": THREAD, "session_id": THREAD}},
        {"type": "turn_context", "payload": {"turn_id": TURN, "model": "model", "effort": "medium"}},
        {"type": "event_msg", "payload": {"type": "item_completed", "thread_id": THREAD,
         "turn_id": TURN, "item": {"type": "CommandExecution", "id": "item",
         "command": ["true"], "status": "completed", "exit_code": 0}}},
    )


class ParserBoundTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.missing = self.root / "must-not-be-read.jsonl"
        self.fifo = self.root / "must-not-be-opened.fifo"
        os.mkfifo(self.fifo)

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, script, *arguments):
        return subprocess.run(
            [os.fspath(script), *map(os.fspath, arguments)],
            capture_output=True, timeout=3, check=False,
        )

    def required(self, source=None, cap="256"):
        return [os.fspath(source or self.fifo), "--thread-id", THREAD, "--turn-id", TURN,
                "--output-cap", cap]

    def assert_argument_refusal(self, arguments, phrase=None):
        result = self.invoke(SCRIPT, *arguments)
        self.assertEqual((result.returncode, result.stdout), (2, b""), result.stderr)
        self.assertTrue(result.stderr.endswith(b"\n"))
        self.assertEqual(result.stderr.count(b"\n"), 1)
        result.stderr.decode("utf-8", "strict")
        self.assertNotIn(b"Traceback", result.stderr)
        self.assertNotIn(b"usage:", result.stderr)
        self.assertLessEqual(len(result.stderr), 256)
        if phrase is not None:
            self.assertIn(phrase.encode(), result.stderr)
        self.assertNotIn(b"regular file", result.stderr)
        self.assertNotIn(b"unreadable", result.stderr)
        return result

    def write(self, records, name):
        source = self.root / name
        source.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in records))
        return source

    def test_missing_required_arguments_are_bounded_before_source_acquisition(self):
        cases = (
            ([], "required"),
            ([os.fspath(self.fifo), "--turn-id", TURN, "--output-cap", "256"], "--thread-id"),
            ([os.fspath(self.fifo), "--thread-id", THREAD, "--output-cap", "4096"], "--turn-id"),
        )
        for arguments, phrase in cases:
            with self.subTest(arguments=arguments):
                self.assert_argument_refusal(arguments, phrase)

    def test_long_invalid_integer_unknown_option_and_choices_are_bounded_utf8(self):
        cases = (
            (self.required(cap="9" * 2048 + "x"), "invalid int value"),
            (self.required(cap="4096") + ["--" + "项目😀" * 700], "unrecognized arguments"),
            (self.required(cap="4096") + ["--source-format", "格式😀" * 700], "invalid choice"),
        )
        for arguments, phrase in cases:
            with self.subTest(phrase=phrase):
                self.assert_argument_refusal(arguments, phrase)

    def test_invalid_cap_hash_and_duplicate_ids_are_bounded_before_read(self):
        cases = (
            (self.required(cap="255"), "--output-cap must be between"),
            (self.required(cap="1048577"), "--output-cap must be between"),
            (self.required(cap="256") + ["--expected-sha256", "z" * 64], "lowercase hexadecimal"),
            (self.required(cap="4096") + ["--expected-sha256", "😀" * 2048], "lowercase hexadecimal"),
            (self.required(cap="4096") + ["--item-id", "项目😀" * 600,
                                           "--item-id", "项目😀" * 600], "must be unique"),
        )
        for arguments, phrase in cases:
            with self.subTest(phrase=phrase):
                self.assert_argument_refusal(arguments, phrase)

    def test_help_remains_successful(self):
        result = self.invoke(SCRIPT, "--help")
        self.assertEqual((result.returncode, result.stderr), (0, b""))
        self.assertIn(b"usage:", result.stdout)
        self.assertIn(b"--output-cap", result.stdout)

    def test_valid_app_and_session_projections_match_complete_goldens(self):
        cases = (
            (self.write(app_records(), "app.jsonl"), [], "parser-app.stdout.golden"),
            (self.write(session_records(), "session.jsonl"),
             ["--source-format", "session-receipt"], "parser-session.stdout.golden"),
        )
        for source, extra, expected_name in cases:
            with self.subTest(source=source.name):
                before = source.read_bytes()
                arguments = [os.fspath(source), "--thread-id", THREAD, "--turn-id", TURN, *extra]
                new = self.invoke(SCRIPT, *arguments)
                self.assertEqual(
                    (new.returncode, new.stdout, new.stderr),
                    (0, golden(expected_name, source), b""),
                )
                self.assertEqual(source.read_bytes(), before)

    def test_runtime_errors_still_honor_validated_cap_and_match_baseline(self):
        malformed = self.root / "malformed.jsonl"
        malformed.write_text('{"duplicate":1,"duplicate":2}\n')
        before = malformed.read_bytes()
        for cap in ("256", "4096"):
            with self.subTest(cap=cap):
                arguments = [os.fspath(malformed), "--thread-id", THREAD, "--turn-id", TURN,
                             "--output-cap", cap]
                new = self.invoke(SCRIPT, *arguments)
                self.assertEqual(
                    (new.returncode, new.stdout, new.stderr),
                    (2, b"", golden("duplicate-key.stderr.golden")),
                )
                self.assertEqual(malformed.read_bytes(), before)

    def test_valid_expected_sha_mismatch_remains_a_runtime_error(self):
        source = self.write(app_records(), "digest.jsonl")
        before = source.read_bytes()
        wrong = "0" * 64
        self.assertNotEqual(hashlib.sha256(source.read_bytes()).hexdigest(), wrong)
        arguments = [os.fspath(source), "--thread-id", THREAD, "--turn-id", TURN,
                     "--expected-sha256", wrong, "--output-cap", "4096"]
        new = self.invoke(SCRIPT, *arguments)
        expected = golden("sha-mismatch.stderr.golden").replace(
            b"{{SOURCE_SHA256}}", hashlib.sha256(source.read_bytes()).hexdigest().encode()
        )
        self.assertEqual((new.returncode, new.stdout, new.stderr), (2, b"", expected))
        self.assertEqual(source.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
