import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts.context_excerpt import resolve_relative
from scripts.read_map_core import AcquisitionBudget, CoreError, published_lunacy_path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/context_excerpt.py"


BASE = """# Entry

## Before-action reads

Keep this complete caveat, including unlinked duties.

<a id="ordinary-progressive-reads"></a>
### Ordinary trigger table

<a id="compact-examples"></a>
| Trigger | Read next |
| --- | --- |
| Act | Keep full row duty, then [target](worker/target.md#real) |
"""


TARGET = """# Top

<a id="real"></a>
## Real

Read [nested](nested.md#later) only if it applies.

## Later

Do not acquire this via the nested link.
"""


class AdversarialContextExcerptTests(unittest.TestCase):
    def make_root(self, parent):
        root = Path(parent) / "source"
        root.mkdir()
        (root / "worker").mkdir()
        (root / "SKILL.md").write_text(BASE)
        (root / "worker/target.md").write_text(TARGET)
        (root / "worker/nested.md").write_text("# Later\nsecret nested target\n")
        return root

    def run_cli(self, root, *extra):
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "action-excerpt", "--root", str(root),
             "--layout", "source", "--source-relative", "SKILL.md",
             "--trigger", "Act", *extra], capture_output=True, timeout=10)

    def assert_error(self, root, code, exit_code=4, *extra):
        result = self.run_cli(root, *extra)
        self.assertEqual(result.returncode, exit_code, result.stderr.decode())
        self.assertEqual(result.stdout, b"")
        self.assertEqual(json.loads(result.stderr)["code"], code)

    def test_alias_heading_span_fences_and_no_recursion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            with (root / "worker/target.md").open("a") as stream:
                stream.write("\n```md\n<a id=\"real\"></a>\n## Real\n```\n")
            result = self.run_cli(root)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            receipt = json.loads(result.stdout)
            destination = receipt["destinations"][0]
            self.assertTrue(destination["text"].startswith('<a id="real"></a>\n## Real'))
            self.assertNotIn("Do not acquire", destination["text"])
            self.assertEqual(receipt["limits"]["files_opened"], 2)
            self.assertEqual(receipt["outstanding_links"][0]["target"],
                             {"fragment": "later", "logical_path": "worker/nested.md"})
            self.assertIn("Read [nested]", receipt["outstanding_links"][0]["source_quote"])

    def test_paragraph_anchor_and_distinct_duplicate_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            (root / "worker/target.md").write_text('<a id="real"></a>\nparagraph only\n')
            self.assert_error(root, "ambiguous_anchor_boundary")
            (root / "worker/target.md").write_text(
                '<a id="real"></a>\n## First\ntext\n\n<a id="real"></a>\n## Second\ntext\n')
            self.assert_error(root, "duplicate_or_ambiguous_anchor")

    def test_malformed_duplicate_table_and_unclear_before_action_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            (root / "SKILL.md").write_text(BASE + "| Act | duplicate |\n")
            self.assert_error(root, "duplicate_trigger")
            (root / "SKILL.md").write_text(BASE.replace(
                "| Act | Keep full row duty, then [target](worker/target.md#real) |",
                "| Act | bad | extra |"))
            self.assert_error(root, "malformed_row")
            (root / "SKILL.md").write_text(BASE.replace(
                '<a id="ordinary-progressive-reads"></a>',
                '<a id="ordinary-progressive-reads"></a>\nsubstantive boundary surprise'))
            self.assert_error(root, "ambiguous_before_action_boundary")

    def test_traversal_symlink_non_utf8_and_missing_target_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            outside = Path(temporary) / "outside.md"
            outside.write_text("# Real\n")
            (root / "SKILL.md").write_text(BASE.replace("worker/target.md", "../outside.md"))
            self.assert_error(root, "path_escape", 3)
            (root / "SKILL.md").write_text(BASE)
            (root / "worker/target.md").unlink()
            (root / "worker/target.md").symlink_to(outside)
            self.assert_error(root, "ancestor_symlink", 3)
            (root / "worker/target.md").unlink()
            (root / "worker/target.md").write_bytes(b"\xff")
            self.assert_error(root, "invalid_utf8", 3)
            (root / "worker/target.md").unlink()
            self.assert_error(root, "missing_target", 3)

    def test_legal_normalized_parent_link_stays_inside_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            (root / "worker/docs").mkdir()
            (root / "SKILL.md").write_text(
                BASE.replace("worker/target.md", "worker/docs/../target.md"))
            result = self.run_cli(root)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(json.loads(result.stdout)["destinations"][0]["logical_path"],
                             "worker/target.md")

    def test_observed_identity_change_during_individual_read_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            actual = os.stat(root / "SKILL.md")
            changed = SimpleNamespace(
                st_dev=actual.st_dev, st_ino=actual.st_ino, st_mode=actual.st_mode,
                st_size=actual.st_size + 1, st_mtime_ns=actual.st_mtime_ns,
                st_ctime_ns=actual.st_ctime_ns)
            budget = AcquisitionBudget(max_acquired_bytes=1_000_000, max_files=2)
            with mock.patch("scripts.read_map_core.os.fstat", side_effect=[actual, changed]):
                with self.assertRaisesRegex(CoreError, "changed while read") as caught:
                    budget.read(root, "SKILL.md", "SKILL.md")
            self.assertEqual(caught.exception.code, "source_changed_while_read")

    def test_fifo_empty_and_byte_exact_whole_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            entry = BASE.replace("worker/target.md#real", "worker/target.md")
            (root / "SKILL.md").write_text(entry)
            (root / "worker/target.md").unlink()
            os.mkfifo(root / "worker/target.md")
            result = self.run_cli(root)
            self.assertEqual(result.returncode, 3, result.stderr.decode())
            self.assertEqual(json.loads(result.stderr)["code"], "missing_target")
            (root / "worker/target.md").unlink()
            (root / "worker/target.md").write_bytes(b"")
            result = self.run_cli(root)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(json.loads(result.stdout)["destinations"][0]["text"], "")
            (root / "worker/target.md").write_bytes(b"## Real\nbody\n")
            result = self.run_cli(root)
            self.assertEqual(json.loads(result.stdout)["destinations"][0]["text"],
                             "## Real\nbody\n")

    def test_duplicate_alias_inline_collision_and_all_row_uniqueness(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            (root / "worker/target.md").write_text(
                '<a id="real"></a>\n<a id="real"></a>\n## Real\nbody\n')
            self.assert_error(root, "duplicate_or_ambiguous_anchor")
            (root / "worker/target.md").write_text(
                '## Real\nbody\n\ntext <a id="real"></a> collision\n')
            self.assert_error(root, "duplicate_or_ambiguous_anchor")
            (root / "worker/target.md").write_text(TARGET)
            (root / "SKILL.md").write_text(BASE + "| Other | x |\n| Other | y |\n")
            self.assert_error(root, "duplicate_trigger")

    def test_fenced_governing_and_fenced_quote_boundaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            (root / "SKILL.md").write_text(BASE.replace(
                "Keep this complete caveat, including unlinked duties.",
                "Keep this complete caveat, including unlinked duties.\n\n```\nimportant\n```"))
            self.assert_error(root, "ambiguous_before_action_boundary")
            (root / "SKILL.md").write_text(BASE)
            (root / "worker/target.md").write_text(
                '## Real\nRead [next](next.md) only if needed.\n```\nnot prose\n```\n')
            result = self.run_cli(root)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(json.loads(result.stdout)["outstanding_links"][0]["source_quote"],
                             "Read [next](next.md) only if needed.\n")

    def test_unicode_error_json_publication_and_parser_caps(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), "action-excerpt", "--root", str(root),
                 "--layout", "source", "--source-relative", "SKILL.md",
                 "--trigger", "界" * 5000], capture_output=True, timeout=10)
            self.assertLessEqual(len(result.stderr), 8192)
            self.assertEqual(json.loads(result.stderr)["code"], "missing_trigger")
            (root / "private.md").write_text("# Real\n")
            (root / "SKILL.md").write_text(BASE.replace(
                "worker/target.md#real", "private.md#real"))
            self.assert_error(root, "unpublished_target", 3)
            (root / "scripts/__pycache__").mkdir(parents=True)
            (root / "scripts/ignored.pyc").write_bytes(b"ignored")
            (root / "scripts/__pycache__/cached.py").write_text("ignored")
            for target in ("scripts/ignored.pyc", "scripts/__pycache__/cached.py"):
                (root / "SKILL.md").write_text(BASE.replace(
                    "worker/target.md#real", target))
                self.assert_error(root, "unpublished_target", 3)
            (root / "SKILL.md").write_text(BASE)
            self.assert_error(root, "work_cap_exceeded", 5, "--max-work-units", "1")
            self.assert_error(root, "link_count_cap_exceeded", 5, "--max-links", "1")

    def test_fragment_only_identity_and_scan_materialization_caps(self):
        self.assertEqual(
            resolve_relative("source", "worker/ENGINEERING.md", "#foo"),
            (("worker/ENGINEERING.md", "worker/ENGINEERING.md"), "foo", "local"))
        self.assertEqual(
            resolve_relative("package", "skills/lunacy/worker/ENGINEERING.md", "#foo"),
            (("skills/lunacy/worker/ENGINEERING.md", "worker/ENGINEERING.md"),
             "foo", "local"))
        self.assertFalse(published_lunacy_path("scripts/ignored.pyc"))
        self.assertFalse(published_lunacy_path("scripts/ignored.pyo"))
        self.assertFalse(published_lunacy_path("scripts/__pycache__/cached.py"))
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            (root / "SKILL.md").write_text(BASE.replace(
                "worker/target.md#real", "#entry"))
            result = self.run_cli(root)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(json.loads(result.stdout)["destinations"][0]["logical_path"],
                             "SKILL.md")
            (root / "SKILL.md").write_text(BASE)
            (root / "worker/target.md").write_text(
                "## Real\n" + "".join(
                    f"line {number} [same](#real)\n" for number in range(6)))
            result = self.run_cli(root, "--max-work-units", "26")
            self.assertEqual(result.returncode, 5, result.stderr.decode())
            self.assertEqual(json.loads(result.stderr)["code"], "work_cap_exceeded")
            result = self.run_cli(root, "--max-output-bytes", "200")
            self.assertEqual(result.returncode, 5, result.stderr.decode())
            self.assertEqual(json.loads(result.stderr)["code"], "output_cap_exceeded")

    def test_directory_fd_acquisition_survives_controlled_ancestor_swap(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = self.make_root(temporary)
            outside = Path(temporary) / "outside"
            outside.mkdir()
            (outside / "target.md").write_text("outside bytes\n")
            held = root / "held-worker"
            original_open = os.open
            swapped = False
            def swapping_open(path, flags, *args, **kwargs):
                nonlocal swapped
                fd = original_open(path, flags, *args, **kwargs)
                if path == "worker" and kwargs.get("dir_fd") is not None and not swapped:
                    (root / "worker").rename(held)
                    (root / "worker").symlink_to(outside, target_is_directory=True)
                    swapped = True
                return fd
            budget = AcquisitionBudget(max_acquired_bytes=1_000_000, max_files=2)
            try:
                with mock.patch("scripts.read_map_core.os.open", side_effect=swapping_open):
                    acquired = budget.read(root, "worker/target.md", "worker/target.md")
                self.assertIn("## Real", acquired.text)
                self.assertNotIn("outside bytes", acquired.text)
            finally:
                if (root / "worker").is_symlink():
                    (root / "worker").unlink()
                if held.exists():
                    held.rename(root / "worker")


if __name__ == "__main__":
    unittest.main()
