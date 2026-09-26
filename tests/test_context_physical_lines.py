import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts.context_excerpt import line_records
from scripts.read_map_core import anchors, outside_fence_lines


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/context_excerpt.py"
SEPARATORS = (
    ("line separator", "\u2028"),
    ("paragraph separator", "\u2029"),
    ("next line", "\u0085"),
    ("vertical tab", "\v"),
    ("form feed", "\f"),
    ("file separator", "\x1c"),
    ("group separator", "\x1d"),
    ("record separator", "\x1e"),
)
ENTRY = (
    "# Entry\n\n## Before-action reads\n\nPreserve applicable duties.\n\n"
    "### Ordinary trigger table\n\n| Trigger | Read next |\n| --- | --- |\n"
    "| Act | [target](worker/target.md#real) |\n"
)


class PhysicalLineTests(unittest.TestCase):
    def test_records_recognize_only_physical_endings_and_exact_utf8_offsets(self):
        cases = (
            ("empty", "", []),
            ("unterminated", "a", [(1, "a", 0, 1, 1)]),
            ("empty LF", "\n", [(1, "", 0, 0, 1)]),
            ("empty CR", "\r", [(1, "", 0, 0, 1)]),
            ("empty CRLF", "\r\n", [(1, "", 0, 0, 2)]),
            ("trailing LF", "a\n", [(1, "a", 0, 1, 2)]),
            ("trailing CR", "a\r", [(1, "a", 0, 1, 2)]),
            ("trailing CRLF", "a\r\n", [(1, "a", 0, 1, 3)]),
            ("blank LF", "a\n\n", [(1, "a", 0, 1, 2), (2, "", 2, 2, 3)]),
            ("blank CR", "a\r\r", [(1, "a", 0, 1, 2), (2, "", 2, 2, 3)]),
            ("blank CRLF", "a\r\n\r\n", [(1, "a", 0, 1, 3), (2, "", 3, 3, 5)]),
            ("mixed empty", "\r\n\n\r", [
                (1, "", 0, 0, 2), (2, "", 2, 2, 3), (3, "", 3, 3, 4)]),
            ("mixed content", "a\rb\r\nc\n", [
                (1, "a", 0, 1, 2), (2, "b", 2, 3, 5), (3, "c", 5, 6, 7)]),
            ("multibyte mixed", "é\r\nЖ\n🧪\rZ", [
                (1, "é", 0, 2, 4), (2, "Ж", 4, 6, 7),
                (3, "🧪", 7, 11, 12), (4, "Z", 12, 13, 13)]),
        )
        for name, text, expected in cases:
            with self.subTest(case=name):
                self.assertEqual(line_records(text), expected)
                self.assertEqual(list(outside_fence_lines(text)),
                                 [(record[0], record[1]) for record in expected])

    def test_nonphysical_separators_are_literal_content_in_both_views(self):
        for name, separator in SEPARATORS:
            for ending in ("", "\n", "\r", "\r\n"):
                with self.subTest(separator=name, ending=repr(ending)):
                    content = "é" + separator + "🧪"
                    size = len(content.encode("utf-8"))
                    self.assertEqual(line_records(content + ending),
                                     [(1, content, 0, size, size + len(ending))])
                    self.assertEqual(list(outside_fence_lines(content + ending)),
                                     [(1, content)])

    def test_nonphysical_separators_do_not_create_heading_anchors(self):
        for name, separator in SEPARATORS:
            with self.subTest(separator=name):
                text = "## Real\nprose" + separator + "## Phantom\n## Later\n"
                self.assertEqual(anchors(text), {"real", "later"})
                self.assertEqual(list(outside_fence_lines(text)), [
                    (1, "## Real"), (2, "prose" + separator + "## Phantom"),
                    (3, "## Later"),
                ])

    def test_nonphysical_separators_do_not_open_fences(self):
        for name, separator in SEPARATORS:
            for fence in ("```", "~~~"):
                with self.subTest(separator=name, fence=fence):
                    text = "prose" + separator + fence + "\n## Real\n"
                    self.assertEqual(list(outside_fence_lines(text)), [
                        (1, "prose" + separator + fence), (2, "## Real")])
                    self.assertEqual(anchors(text), {"real"})

    def test_nonphysical_separators_do_not_close_fences_or_expose_anchors(self):
        for name, separator in SEPARATORS:
            for fence in ("```", "~~~"):
                with self.subTest(separator=name, fence=fence):
                    text = (fence + "\nexample" + separator + fence + "\n"
                            '<a id="hidden-alias"></a>\n## Hidden\n' +
                            fence + "\n## Real\n")
                    self.assertEqual(list(outside_fence_lines(text)), [(6, "## Real")])
                    self.assertEqual(anchors(text), {"real"})

    def test_real_mixed_endings_keep_fence_and_anchor_line_numbers(self):
        text = '## First\r```md\r\n<a id="hidden"></a>\n## Hidden\r```\n## Last\r\n'
        self.assertEqual(list(outside_fence_lines(text)), [(1, "## First"), (6, "## Last")])
        self.assertEqual(anchors(text), {"first", "last"})


class PhysicalLineCliTests(unittest.TestCase):
    def run_cli(self, target, *, fragment="real", entry=ENTRY):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "worker").mkdir()
            (root / "SKILL.md").write_bytes(entry.replace(
                "worker/target.md#real", "worker/target.md#" + fragment).encode("utf-8"))
            (root / "worker/target.md").write_bytes(target.encode("utf-8"))
            return subprocess.run(
                [sys.executable, "-B", str(SCRIPT), "action-excerpt", "--root", str(root),
                 "--layout", "source", "--source-relative", "SKILL.md", "--trigger", "Act"],
                capture_output=True, timeout=10)

    def successful_receipt(self, result):
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8"))
        self.assertEqual(result.stderr, b"")
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["status"], "ok")
        self.assertFalse(receipt["limits"]["truncated"])
        self.assertEqual(receipt["limits"]["files_opened"], 2)
        return receipt

    def assert_destination(self, receipt, expected, *, start, end, first_line, last_line):
        destination = receipt["destinations"][0]
        data = expected.encode("utf-8")
        self.assertEqual(destination["text"], expected)
        self.assertEqual(destination["byte_range"], {"start": start, "end": end})
        self.assertEqual(destination["line_range"], {"start": first_line, "end": last_line})
        self.assertEqual(destination["bytes"], len(data))
        self.assertEqual(destination["sha256"], hashlib.sha256(data).hexdigest())

    def test_original_false_success_returns_all_70_bytes(self):
        expected = "## Real\nFirst duty\u2028## Not a physical heading\nREQUIRED SECOND DUTY.\n\n"
        self.assertEqual(len(expected.encode("utf-8")), 70)
        receipt = self.successful_receipt(self.run_cli(
            expected + "## Later\nOutside selected block.\n"))
        self.assert_destination(receipt, expected, start=0, end=70, first_line=1, last_line=4)

    def test_all_nonphysical_separators_preserve_nested_link_and_exact_span(self):
        for name, separator in SEPARATORS:
            with self.subTest(separator=name):
                prefix = "# Préface\r\n"
                expected = ("## Real\r\nFirst duty" + separator + "## Not a physical heading\n"
                            "REQUIRED [nested](nested.md#later) duty.\r\n\r")
                target = prefix + expected + "## Later\nOutside selected block.\n"
                receipt = self.successful_receipt(self.run_cli(target))
                self.assert_destination(
                    receipt, expected, start=len(prefix.encode("utf-8")),
                    end=len((prefix + expected).encode("utf-8")), first_line=2, last_line=5)
                self.assertEqual(len(receipt["outstanding_links"]), 1)
                nested = receipt["outstanding_links"][0]
                self.assertEqual(nested["target"],
                                 {"logical_path": "worker/nested.md", "fragment": "later"})
                self.assertEqual(nested["source_range"], {"start": 3, "end": 4})
                self.assertEqual(nested["source_quote"],
                                 "First duty" + separator + "## Not a physical heading\n"
                                 "REQUIRED [nested](nested.md#later) duty.\r\n")
                self.assertEqual(nested["resolution_state"], "unfollowed")
                self.assertEqual(nested["applicability"], "caller-decides")

    def test_nonphysical_separator_cannot_attach_alias_to_false_heading(self):
        for name, separator in SEPARATORS:
            with self.subTest(separator=name):
                target = '<a id="real"></a>' + separator + "## Phantom\n## Actual\nDuty.\n"
                result = self.run_cli(target)
                self.assertEqual(result.returncode, 4, result.stderr.decode("utf-8"))
                self.assertEqual(result.stdout, b"")
                self.assertEqual(json.loads(result.stderr)["code"], "ambiguous_anchor_boundary")

    def test_actual_endings_still_end_heading_spans(self):
        for ending in ("\n", "\r", "\r\n"):
            with self.subTest(ending=repr(ending)):
                expected = "## Real" + ending + "First duty" + ending
                target = expected + "## Later" + ending + "Outside selected block." + ending
                receipt = self.successful_receipt(self.run_cli(
                    target, entry=ENTRY.replace("\n", ending)))
                self.assert_destination(receipt, expected, start=0,
                                        end=len(expected), first_line=1, last_line=2)

    def test_ordinary_alias_and_fenced_headings_remain_compatible(self):
        expected = ('<a id="real"></a>\n## Actual\nDuty.\n```md\n## Hidden\n```\n\n')
        receipt = self.successful_receipt(self.run_cli(expected + "## Later\nOutside.\n"))
        self.assert_destination(receipt, expected, start=0, end=len(expected),
                                first_line=1, last_line=7)
        self.assertEqual(receipt["outstanding_links"], [])


if __name__ == "__main__":
    unittest.main()
