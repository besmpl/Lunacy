#!/usr/bin/env python3
"""Public-CLI regression tests for bounded UTF-8 error diagnostics."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY / "scripts/evidence_index.py"
PREFIX = "evidence-index: "


def short(value, limit=120):
    text = str(value).replace("\n", "\\n").replace("\r", "\\r")
    return text if len(text) <= limit else text[:limit - 3] + "..."


def shaped_diagnostic(message, cap):
    """Independent character-by-character byte-budget oracle for this CLI error."""
    limit = min(cap, 512)
    message = short(message, max(16, limit - len(PREFIX) - 2))
    body = PREFIX + message
    retained = bytearray()
    for character in body:
        encoded = character.encode("utf-8", "replace")
        if len(retained) + len(encoded) > limit - 1:
            break
        retained.extend(encoded)
    return bytes(retained) + b"\n"


def missing_message(item_id):
    return f"requested item IDs not found in scope (1): {short(item_id)}"


class DiagnosticUtf8Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, source_format, name="empty.jsonl"):
        path = self.root / name
        if source_format == "app-server":
            path.write_bytes(b"")
        else:
            records = (
                {"type": "session_meta", "payload": {"id": "thread", "session_id": "thread"}},
                {"type": "turn_context", "payload": {
                    "turn_id": "turn", "model": "model", "effort": "medium",
                }},
            )
            path.write_text("".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
        return path

    def invoke(self, source, cap, source_format="app-server", item_id=None):
        arguments = [
            os.fspath(SCRIPT), os.fspath(source),
            "--source-format", source_format,
            "--thread-id", "thread", "--turn-id", "turn",
            "--output-cap", str(cap),
        ]
        if item_id is not None:
            arguments.extend(("--item-id", item_id))
        return subprocess.run(arguments, capture_output=True, timeout=5, check=False)

    def assert_missing_refusal(self, item_id, cap, source_format="app-server", name="empty.jsonl"):
        source = self.fixture(source_format, name)
        result = self.invoke(source, cap, source_format, item_id)
        expected = shaped_diagnostic(missing_message(item_id), cap)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, expected)
        self.assertLessEqual(len(result.stderr), min(cap, 512))
        self.assertEqual(result.stderr.count(b"\n"), 1)
        self.assertTrue(result.stderr.endswith(b"\n"))
        result.stderr.decode("utf-8", "strict")
        return source, result

    def boundary_identity(self, character, interior_offset, cap=256):
        for pad in range(4):
            item_id = "p" * pad + character * (120 - pad)
            full = (PREFIX + missing_message(item_id)).encode("utf-8")
            before_character = (PREFIX + "requested item IDs not found in scope (1): " + "p" * pad).encode()
            if (cap - 1 - len(before_character)) % len(character.encode()) == interior_offset:
                self.assertGreater(len(full), cap)
                return item_id
        self.fail("could not construct requested UTF-8 boundary")

    def test_all_six_interior_multibyte_cut_positions_for_both_selectors(self):
        cases = (("two-1", "é", 1), ("three-1", "€", 1), ("three-2", "€", 2),
                 ("four-1", "😀", 1), ("four-2", "😀", 2), ("four-3", "😀", 3))
        for source_format in ("app-server", "session-receipt"):
            for label, character, offset in cases:
                with self.subTest(source_format=source_format, case=label):
                    item_id = self.boundary_identity(character, offset)
                    self.assert_missing_refusal(
                        item_id, 256, source_format, f"{source_format}-{label}.jsonl"
                    )

    def test_exact_fit_and_one_byte_smaller_twin_for_both_selectors(self):
        item_id = "😀" * 100
        full = shaped_diagnostic(missing_message(item_id), 512)
        self.assertGreaterEqual(len(full), 256)
        for source_format in ("app-server", "session-receipt"):
            with self.subTest(source_format=source_format):
                source, exact = self.assert_missing_refusal(
                    item_id, len(full), source_format, f"{source_format}-exact-fit.jsonl"
                )
                self.assertEqual(len(exact.stderr), len(full))
                smaller = self.invoke(source, len(full) - 1, source_format, item_id)
                self.assertEqual((smaller.returncode, smaller.stdout), (2, b""))
                self.assertEqual(
                    smaller.stderr, shaped_diagnostic(missing_message(item_id), len(full) - 1)
                )
                smaller.stderr.decode("utf-8", "strict")

    def test_minimum_ceiling_and_supported_above_ceiling_caps_for_both_selectors(self):
        item_id = "€" * 117
        for source_format in ("app-server", "session-receipt"):
            with self.subTest(source_format=source_format):
                source, at_minimum = self.assert_missing_refusal(
                    item_id, 256, source_format, f"{source_format}-caps.jsonl"
                )
                at_ceiling = self.invoke(source, 512, source_format, item_id)
                above_ceiling = self.invoke(source, 4096, source_format, item_id)
                for result in (at_ceiling, above_ceiling):
                    self.assertEqual((result.returncode, result.stdout), (2, b""))
                    result.stderr.decode("utf-8", "strict")
                    self.assertEqual(result.stderr, shaped_diagnostic(missing_message(item_id), 512))
                self.assertLessEqual(len(at_minimum.stderr), 256)
                self.assertLessEqual(len(at_ceiling.stderr), 512)
                self.assertEqual(at_ceiling.stderr, above_ceiling.stderr)

    def test_ascii_after_unicode_and_untruncated_unicode_for_both_selectors(self):
        truncated_identity = None
        for unicode_count in range(70, 111):
            candidate = "é" * unicode_count + "A" * (120 - unicode_count)
            expected = shaped_diagnostic(missing_message(candidate), 256)
            if len(expected) == 256 and expected.removesuffix(b"\n").endswith(b"A"):
                truncated_identity = candidate
                break
        self.assertIsNotNone(truncated_identity)
        untruncated_identity = "café-项目-😀"
        for source_format in ("app-server", "session-receipt"):
            with self.subTest(source_format=source_format):
                _, truncated = self.assert_missing_refusal(
                    truncated_identity, 256, source_format, f"{source_format}-ascii-boundary.jsonl"
                )
                self.assertIn("é".encode(), truncated.stderr)
                self.assertTrue(truncated.stderr.removesuffix(b"\n").endswith(b"A"))
                self.assert_missing_refusal(
                    untruncated_identity, 256, source_format, f"{source_format}-untruncated.jsonl"
                )

    def test_replacement_combining_and_aligned_controls_for_both_selectors(self):
        controls = (
            ("literal-replacement", "�" * 60),
            ("combining-mark", "e\u0301" * 45),
            ("aligned-two-byte", "é" * 80),
            ("aligned-three-byte", "€" * 60),
            ("aligned-four-byte", "😀" * 48),
        )
        for source_format in ("app-server", "session-receipt"):
            for label, item_id in controls:
                with self.subTest(source_format=source_format, case=label):
                    self.assert_missing_refusal(
                        item_id, 256, source_format, f"{source_format}-{label}.jsonl"
                    )

    def test_source_carried_lone_surrogate_uses_public_identity_diagnostic(self):
        item_id = "\ud800" * 60
        item = {
            "type": "commandExecution", "id": item_id, "status": "inProgress",
            "exitCode": None, "command": "first", "cwd": "/tmp", "processId": "1",
        }
        first = {"direction": "receive", "message": {"method": "item/started", "params": {
            "threadId": "thread", "turnId": "turn", "item": item,
        }}}
        second = json.loads(json.dumps(first))
        second["message"]["params"]["item"]["command"] = "second"
        source = self.root / "lone-surrogate.jsonl"
        source.write_text(
            json.dumps(first, ensure_ascii=True) + "\n" + json.dumps(second, ensure_ascii=True) + "\n",
            encoding="utf-8",
        )
        result = self.invoke(source, 256)
        message = f"line 2: contradictory duplicate start for item {short(item_id)}"
        self.assertEqual((result.returncode, result.stdout), (2, b""))
        self.assertEqual(result.stderr, shaped_diagnostic(message, 256))
        self.assertIn(b"?", result.stderr)
        self.assertLessEqual(len(result.stderr), 256)
        result.stderr.decode("utf-8", "strict")


if __name__ == "__main__":
    unittest.main()
