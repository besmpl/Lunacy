#!/usr/bin/env python3
"""Public-CLI regression coverage for bounded surrogate-safe JSON emission."""

import json
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY / "scripts/evidence_index.py"
FIXTURES = REPOSITORY / "tests/fixtures"


def golden(name, source):
    expected = (FIXTURES / name).read_bytes()
    escaped_path = json.dumps(os.fspath(source), ensure_ascii=False)[1:-1].encode()
    expected = expected.replace(b"{{SOURCE_PATH}}", escaped_path).replace(
        b"{{SOURCE_SHA256}}", hashlib.sha256(source.read_bytes()).hexdigest().encode()
    )
    return expected


def app_event(method, item, *, output=None):
    return {
        "direction": "receive",
        "message": {
            "method": method,
            "params": {
                "threadId": "thread",
                "turnId": "turn",
                "item": {
                    "type": "commandExecution",
                    "id": item,
                    "status": "inProgress" if method == "item/started" else "completed",
                    "exitCode": None if method == "item/started" else 0,
                    "command": "printf PASS",
                    "cwd": "/tmp",
                    "processId": "42",
                    "aggregatedOutput": output,
                },
            },
        },
    }


def session_records(model="modèle", item="项目", status="terminé"):
    return [
        {"type": "session_meta", "payload": {"id": "thread", "session_id": "thread"}},
        {"type": "turn_context", "payload": {"turn_id": "turn", "model": model, "effort": "médium"}},
        {
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "thread_id": "thread",
                "turn_id": "turn",
                "item": {
                    "type": "CommandExecution",
                    "id": item,
                    "command": ["printf", "SECRET"],
                    "status": status,
                    "exit_code": 0,
                    "stdout": "SECRET_OUTPUT",
                },
            },
        },
    ]


class SurrogateOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, records, name="capture.jsonl"):
        path = self.root / name
        path.write_text(
            "".join(json.dumps(row, ensure_ascii=True) + "\n" for row in records),
            encoding="utf-8",
        )
        return path

    def invoke(self, script, source, *extra):
        return subprocess.run(
            [
                os.fspath(script),
                os.fspath(source),
                "--thread-id",
                "thread",
                "--turn-id",
                "turn",
                *extra,
            ],
            capture_output=True,
            timeout=5,
            check=False,
        )

    def app_source(self, item, *, ignored=None, name="capture.jsonl"):
        records = []
        if ignored is not None:
            records.append({"direction": "send", "message": {"method": "ignored", "payload": ignored}})
        records += [
            app_event("item/started", item),
            app_event("item/completed", item, output=ignored),
        ]
        return self.write(records, name)

    def assert_success_value(self, item, *, ignored=None):
        source = self.app_source(item, ignored=ignored)
        result = self.invoke(SCRIPT, source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertNotIn(b"Traceback", result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["commands"][0]["item_id"], item)
        return source, result, value

    def test_lone_high_surrogate_is_losslessly_emitted(self):
        self.assert_success_value("high-\ud800")

    def test_lone_low_surrogate_is_losslessly_emitted(self):
        self.assert_success_value("low-\udfff")

    def test_mixed_unicode_and_surrogate_preserves_decoded_value(self):
        self.assert_success_value("café-项目-😀-\ud800-fin")

    def test_literal_backslash_u_is_not_converted_to_surrogate(self):
        literal = r"literal-\ud800"
        _, result, value = self.assert_success_value(literal)
        self.assertEqual(value["commands"][0]["item_id"], literal)
        self.assertIn(b"literal-\\\\ud800", result.stdout)

    def test_paired_json_escapes_follow_decoder_value(self):
        decoded_id = json.loads(r'"pair-\ud83d\ude00"')
        source = self.app_source(decoded_id)
        result = self.invoke(SCRIPT, source)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["commands"][0]["item_id"], decoded_id)

    def test_ignored_surrogate_payload_does_not_change_projection(self):
        ignored = self.app_source("visible", ignored="hidden-\ud800", name="ignored.jsonl")
        result = self.invoke(SCRIPT, ignored)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["commands"][0]["item_id"], "visible")
        self.assertEqual(value["ignored_unrelated_record_count"], 1)
        self.assertNotIn("hidden", json.dumps(value))

    def test_cap_counts_final_escaped_bytes_exactly(self):
        source = self.app_source("bounded-\ud800")
        before = source.read_bytes()
        expected = golden("surrogate-app-bounded.stdout.golden", source)
        unrestricted = self.invoke(SCRIPT, source, "--output-cap", "1048576")
        self.assertEqual(
            (unrestricted.returncode, unrestricted.stdout, unrestricted.stderr),
            (0, expected, b""),
        )
        exact = len(expected)
        self.assertGreaterEqual(exact, 257)
        accepted = self.invoke(SCRIPT, source, "--output-cap", str(exact))
        self.assertEqual(
            (accepted.returncode, accepted.stdout, accepted.stderr),
            (0, expected, b""),
        )
        refused = self.invoke(SCRIPT, source, "--output-cap", str(exact - 1))
        expected_diagnostic = (json.dumps({
            "error": "output_cap_exceeded",
            "limit_bytes": exact - 1,
            "remedy": "select fewer item IDs with --item-id or raise --output-cap "
                      "within the supported limit",
            "required_bytes": exact,
        }, sort_keys=True, separators=(",", ":")) + "\n").encode()
        self.assertEqual(
            (refused.returncode, refused.stdout, refused.stderr),
            (3, expected_diagnostic, b""),
        )
        self.assertEqual(source.read_bytes(), before)

    def test_ordinary_app_server_default_equals_explicit(self):
        source = self.app_source("café-项目-😀")
        before = source.read_bytes()
        new = self.invoke(SCRIPT, source)
        explicit = self.invoke(SCRIPT, source, "--source-format", "app-server")
        expected = (0, golden("surrogate-app-ordinary.stdout.golden", source), b"")
        self.assertEqual((new.returncode, new.stdout, new.stderr), expected)
        self.assertEqual(
            (new.returncode, new.stdout, new.stderr),
            (explicit.returncode, explicit.stdout, explicit.stderr),
        )
        self.assertEqual(source.read_bytes(), before)

    def test_session_output_is_ascii_for_ordinary_and_surrogate(self):
        cases = (
            ("ordinary", session_records()),
            ("surrogate", session_records(model="m-\ud800", item="i-\udfff")),
        )
        for name, records in cases:
            with self.subTest(name=name):
                source = self.write(records, name + ".jsonl")
                before = source.read_bytes()
                extra = ("--source-format", "session-receipt")
                new = self.invoke(SCRIPT, source, *extra)
                self.assertEqual(
                    (new.returncode, new.stdout, new.stderr),
                    (0, golden("surrogate-session-" + name + ".stdout.golden", source), b""),
                )
                self.assertEqual(source.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
