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


def shaped_diagnostic(key, cap):
    """Independent character-by-character byte-budget oracle for this CLI error."""
    key_text = key if len(key) <= 120 else key[:117] + "..."
    message = f"line 1: duplicate JSON object key: {key_text}"
    limit = min(cap, 512)
    message_limit = max(16, limit - len(PREFIX) - 2)
    if len(message) > message_limit:
        message = message[:message_limit - 3] + "..."
    body = PREFIX + message
    retained = bytearray()
    for character in body:
        encoded = character.encode("utf-8", "replace")
        if len(retained) + len(encoded) > limit - 1:
            break
        retained.extend(encoded)
    return bytes(retained) + b"\n"


class DiagnosticUtf8Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, key, name="duplicate.jsonl"):
        path = self.root / name
        quoted = json.dumps(key, ensure_ascii=True)
        path.write_text(f"{{{quoted}:1,{quoted}:2}}\n", encoding="utf-8")
        return path

    def invoke(self, script, source, cap, source_format="app-server"):
        return subprocess.run(
            [
                os.fspath(script), os.fspath(source),
                "--source-format", source_format,
                "--thread-id", "thread", "--turn-id", "turn",
                "--output-cap", str(cap),
            ],
            capture_output=True, timeout=5, check=False,
        )

    def assert_refusal(self, key, cap, source_format="app-server", name="duplicate.jsonl"):
        source = self.fixture(key, name)
        result = self.invoke(SCRIPT, source, cap, source_format)
        expected = shaped_diagnostic(key, cap)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, expected)
        self.assertLessEqual(len(result.stderr), min(cap, 512))
        self.assertEqual(result.stderr.count(b"\n"), 1)
        self.assertTrue(result.stderr.endswith(b"\n"))
        result.stderr.decode("utf-8", "strict")
        return source, result

    def boundary_key(self, character, interior_offset, cap=256):
        # Find an ASCII alignment where the old byte slice ends at this
        # interior byte offset; the expected value still comes from the
        # character-by-character oracle above.
        for pad in range(12):
            key = "p" * pad + character * 117
            full = (PREFIX + f"line 1: duplicate JSON object key: {key[:117]}...").encode("utf-8")
            if (cap - 1 - len(PREFIX + "line 1: duplicate JSON object key: " + "p" * pad)) % len(character.encode()) == interior_offset:
                self.assertGreater(len(full), cap)
                return key
        self.fail("could not construct requested UTF-8 boundary")

    def test_all_six_interior_multibyte_cut_positions_for_both_selectors(self):
        cases = (("two-1", "é", 1), ("three-1", "€", 1), ("three-2", "€", 2),
                 ("four-1", "😀", 1), ("four-2", "😀", 2), ("four-3", "😀", 3))
        for source_format in ("app-server", "session-receipt"):
            for label, character, offset in cases:
                with self.subTest(source_format=source_format, case=label):
                    key = self.boundary_key(character, offset)
                    self.assert_refusal(key, 256, source_format, f"{source_format}-{label}.jsonl")

    def test_exact_fit_and_one_byte_smaller_twin(self):
        key = "😀" * 100
        full = shaped_diagnostic(key, 512)
        self.assertGreaterEqual(len(full), 256)
        source, exact = self.assert_refusal(key, len(full), name="exact-fit.jsonl")
        smaller = self.invoke(SCRIPT, source, len(full) - 1)
        self.assertEqual(smaller.returncode, 2)
        self.assertEqual(smaller.stdout, b"")
        self.assertEqual(smaller.stderr, shaped_diagnostic(key, len(full) - 1))
        smaller.stderr.decode("utf-8", "strict")

    def test_minimum_ceiling_and_supported_above_ceiling_caps(self):
        key = "€" * 117
        source, at_minimum = self.assert_refusal(key, 256, name="caps.jsonl")
        at_ceiling = self.invoke(SCRIPT, source, 512)
        above_ceiling = self.invoke(SCRIPT, source, 4096)
        for result in (at_ceiling, above_ceiling):
            self.assertEqual((result.returncode, result.stdout), (2, b""))
            result.stderr.decode("utf-8", "strict")
            self.assertEqual(result.stderr, shaped_diagnostic(key, 512))
        self.assertLessEqual(len(at_minimum.stderr), 256)
        self.assertLessEqual(len(at_ceiling.stderr), 512)
        self.assertEqual(at_ceiling.stderr, above_ceiling.stderr)

    def test_ascii_boundary_after_retained_multibyte_and_untruncated_unicode(self):
        truncated_key = "é" * 100 + "A" * 17
        source, truncated = self.assert_refusal(truncated_key, 256, name="ascii-boundary.jsonl")
        self.assertIn("é".encode(), truncated.stderr)
        self.assertTrue(truncated.stderr.removesuffix(b"\n").endswith(b"A"))

        untruncated_key = "café-项目-😀"
        source = self.fixture(untruncated_key, "untruncated.jsonl")
        new = self.invoke(SCRIPT, source, 256)
        self.assertEqual((new.returncode, new.stdout), (2, b""))
        self.assertEqual(new.stderr, shaped_diagnostic(untruncated_key, 256))
        new.stderr.decode("utf-8", "strict")

    def test_replacement_surrogate_combining_and_aligned_controls(self):
        controls = (
            ("literal-replacement", "�" * 60),
            ("lone-surrogate-replacement", "\ud800" * 60),
            ("combining-mark", ("e\u0301" * 45)),
            ("aligned-two-byte", "é" * 80),
            ("aligned-three-byte", "€" * 60),
            ("aligned-four-byte", "😀" * 48),
        )
        for label, key in controls:
            with self.subTest(case=label):
                source = self.fixture(key, label + ".jsonl")
                new = self.invoke(SCRIPT, source, 256)
                self.assertEqual((new.returncode, new.stdout), (2, b""))
                self.assertEqual(new.stderr, shaped_diagnostic(key, 256))
                new.stderr.decode("utf-8", "strict")


if __name__ == "__main__":
    unittest.main()
