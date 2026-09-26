"""Behavioral tests for the standalone release projection."""

import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "packaging/build_standalone.py"


def make_source(base: Path) -> Path:
    source = base / "source with whitespace"
    (source / "packaging/lunacy-native/.codex-plugin").mkdir(parents=True)
    (source / "packaging/lunacy-native/skills/golden").mkdir(parents=True)
    (source / "maintainer").mkdir()
    files = {
        "SKILL.md": "---\nname: lunacy\ndescription: fixture\n---\n# Body\n---\nname: opaque\n",
        "WORKSPACE.md": "workspace\n", "OPERATOR.md": "operator\n",
        "README.md": "readme\n", "LICENSE": "license\n",
    }
    for relative, data in files.items():
        (source / relative).write_text(data)
    for name in ("orchestrator", "worker", "scripts", "tests"):
        (source / name).mkdir()
        (source / name / f"{name}.txt").write_text(f"{name}\n")
    (source / "scripts/__pycache__").mkdir()
    (source / "scripts/__pycache__/cached.pyc").write_bytes(b"cache")
    (source / "scripts/ignored.pyc").write_bytes(b"cache")
    (source / "scripts/ignored.pyo").write_bytes(b"cache")
    for name in ("read_footprint.py", "read_map.py"):
        (source / "maintainer" / name).write_text(
            "raise RuntimeError('selected-source helper executed')\n")
    (source / "orchestrator/PLANNING.md").write_text("# Planning\n")
    (source / "orchestrator/IMPROVEMENT.md").write_text("# Improvement\n")
    (source / "worker/ENGINEERING.md").write_text("# Engineering\n")
    (source / "packaging/lunacy-native/.codex-plugin/plugin.json").write_text("{}\n")
    (source / "packaging/lunacy-native/skills/golden/SKILL.md").write_text("golden\n")
    return source


class StandaloneBuildTests(unittest.TestCase):
    def run_build(self, source, destination):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), str(source), str(destination)],
                              capture_output=True, text=True, timeout=20)

    def test_independent_projection_and_opaque_body(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = make_source(base)
            parent = base / "output with whitespace"
            parent.mkdir()
            destination = parent / "lunacy-native"
            result = self.run_build(source, destination)
            self.assertEqual(result.returncode, 0, result.stderr)
            expected_files = {
                "SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md", "LICENSE",
                "orchestrator/orchestrator.txt", "orchestrator/PLANNING.md",
                "orchestrator/IMPROVEMENT.md", "worker/worker.txt",
                "worker/ENGINEERING.md",
                "scripts/scripts.txt", "tests/tests.txt",
            }
            actual_files = {path.relative_to(destination).as_posix()
                            for path in destination.rglob("*") if path.is_file()}
            self.assertEqual(actual_files, expected_files)
            expected_skill = (source / "SKILL.md").read_bytes().replace(
                b"name: lunacy\n", b"name: lunacy-native\n", 1)
            self.assertEqual((destination / "SKILL.md").read_bytes(), expected_skill)
            self.assertIn(b"name: opaque", expected_skill)
            for relative in expected_files - {"SKILL.md"}:
                self.assertEqual((destination / relative).read_bytes(),
                                 (source / relative).read_bytes())

    def test_identity_refusals_happen_before_destination_creation(self):
        invalid = {
            "missing": b"body only\nname: lunacy\n",
            "wrong": b"---\nname: other\n---\nbody\n",
            "duplicate": b"---\nname: lunacy\nname: lunacy\n---\n",
            "duplicate-other-key": (
                b"---\nname: lunacy\ndescription: one\ndescription: two\n---\n"),
            "body-only": b"---\ndescription: fixture\n---\nname: lunacy\n",
            "unclosed": b"---\nname: lunacy\nbody\n",
            "alias": b"---\nname: *lunacy\n---\n",
            "quoted-name": b"---\nname: 'lunacy'\n---\n",
            "comment-name": b"---\nname: lunacy # ambiguous\n---\n",
            "block": b"---\nname: lunacy\ndescription: |\n---\n",
            "tab": b"---\nname:\tlunacy\n---\n",
            "nested-mapping": b"---\nname: lunacy\ndescription: a: b\n---\n",
            "cr-only": b"---\rname: lunacy\rdescription: fixture\r---\rbody\r",
            "non-utf8": b"---\nname: lunacy\n---\n\xff",
        }
        for indicator in "%,]}@`":
            invalid[f"reserved-indicator-{ord(indicator)}"] = (
                f"---\nname: lunacy\ndescription: {indicator}fixture\n---\n".encode()
            )
        for label, separator in {
            "vertical-tab": "\v", "form-feed": "\f", "nel": "\u0085",
            "line-separator": "\u2028", "paragraph-separator": "\u2029",
        }.items():
            invalid[label] = (
                f"---\nname: lunacy{separator}description: fixture\n---\nbody\n".encode()
            )
        for name, skill in invalid.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                source = make_source(base)
                (source / "SKILL.md").write_bytes(skill)
                destination = base / "lunacy-native"
                result = self.run_build(source, destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(destination.exists() or destination.is_symlink())

    def test_crlf_header_is_preserved_and_body_line_characters_are_opaque(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = make_source(base)
            skill = (
                b"---\r\nname: lunacy\r\ndescription: fixture\r\n---\r\n"
                + "body\v\f\u0085\u2028\u2029\rremains opaque\n".encode()
            )
            (source / "SKILL.md").write_bytes(skill)
            destination = base / "lunacy-native"
            result = self.run_build(source, destination)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                (destination / "SKILL.md").read_bytes(),
                skill.replace(b"name: lunacy\r\n", b"name: lunacy-native\r\n", 1),
            )

    def test_destination_refusals_and_missing_parent(self):
        for kind in ("file", "directory", "dangling", "missing-parent"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                source = make_source(base)
                destination = base / "lunacy-native"
                if kind == "file":
                    destination.write_text("keep\n")
                elif kind == "directory":
                    destination.mkdir(); (destination / "sentinel").write_text("keep\n")
                elif kind == "dangling":
                    destination.symlink_to(base / "absent")
                else:
                    destination = base / "absent parent" / "lunacy-native"
                result = self.run_build(source, destination)
                self.assertNotEqual(result.returncode, 0)
                if kind == "file": self.assertEqual(destination.read_text(), "keep\n")
                elif kind == "directory": self.assertEqual(
                    (destination / "sentinel").read_text(), "keep\n")
                elif kind == "dangling": self.assertTrue(destination.is_symlink())
                else: self.assertFalse(destination.exists())

    def test_wrong_basename_and_inside_source_refuse_without_effects(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); source = make_source(base)
            wrong = base / "wrong-name"
            result = self.run_build(source, wrong)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(wrong.exists())
            inside = source / "lunacy-native"
            result = self.run_build(source, inside)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(inside.exists())

    def test_selected_symlink_and_special_node_refuse_before_effects(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); source = make_source(base)
            (source / "WORKSPACE.md").unlink()
            (source / "WORKSPACE.md").symlink_to(base / "outside")
            destination = base / "lunacy-native"
            result = self.run_build(source, destination)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(destination.exists())
        if hasattr(os, "mkfifo"):
            with tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary); source = make_source(base)
                os.mkfifo(source / "scripts/fifo")
                destination = base / "lunacy-native"
                result = self.run_build(source, destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(destination.exists())

    def test_guidance_refusals_happen_before_destination_creation(self):
        mutations = {
            "missing-target": lambda source: (source / "SKILL.md").write_text(
                "---\nname: lunacy\ndescription: fixture\n---\n[missing](absent.md)\n"),
            "missing-anchor": lambda source: (source / "WORKSPACE.md").write_text(
                "[missing](SKILL.md#absent)\n"),
            "shipped-improvement": lambda source: (
                source / "orchestrator/IMPROVEMENT.md").write_text(
                    "[missing](../SKILL.md#absent)\n"),
            "unshipped-target": lambda source: (source / "SKILL.md").write_text(
                "---\nname: lunacy\ndescription: fixture\n---\n"
                "[private](maintainer/read_map.py)\n"),
            "escape": lambda source: (source / "SKILL.md").write_text(
                "---\nname: lunacy\ndescription: fixture\n---\n[escape](../outside)\n"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                source = make_source(base)
                before = {p.relative_to(source): p.read_bytes()
                          for p in source.rglob("*") if p.is_file()}
                mutate(source)
                expected = {p.relative_to(source): p.read_bytes()
                            for p in source.rglob("*") if p.is_file()}
                destination = base / "lunacy-native"
                result = self.run_build(source, destination)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(destination.exists() or destination.is_symlink())
                self.assertEqual(
                    {p.relative_to(source): p.read_bytes()
                     for p in source.rglob("*") if p.is_file()}, expected)
                self.assertNotEqual(before, expected)

    def test_bad_utf8_guidance_refuses_before_destination_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = make_source(base)
            (source / "orchestrator/IMPROVEMENT.md").write_bytes(b"\xff")
            destination = base / "lunacy-native"
            result = self.run_build(source, destination)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not UTF-8", result.stderr)
            self.assertFalse(destination.exists())

    def test_broken_unshipped_golden_guidance_does_not_block_standalone(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = make_source(base)
            (source / "packaging/lunacy-native/skills/golden/SKILL.md").write_text(
                "[missing](../lunacy/SKILL.md#absent)\n")
            destination = base / "lunacy-native"
            result = self.run_build(source, destination)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((destination / "SKILL.md").is_file())

    def test_markdown_named_directory_is_copied_and_nested_markdown_is_validated(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = make_source(base)
            notes = source / "orchestrator/notes.md"
            notes.mkdir()
            (notes / "DETAIL.md").write_text("# Detail\n")
            destination = base / "lunacy-native"
            result = self.run_build(source, destination)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                (destination / "orchestrator/notes.md/DETAIL.md").read_text(),
                "# Detail\n",
            )

        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = make_source(base)
            notes = source / "orchestrator/notes.md"
            notes.mkdir()
            (notes / "DETAIL.md").write_text("[missing](../../absent.md)\n")
            destination = base / "lunacy-native"
            result = self.run_build(source, destination)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("orchestrator/notes.md/DETAIL.md", result.stderr)
            self.assertIn("missing local link target", result.stderr)
            self.assertFalse(destination.exists())

    def test_destination_and_frontmatter_errors_precede_guidance_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = make_source(base)
            (source / "orchestrator/IMPROVEMENT.md").write_text("[missing](absent.md)\n")
            destination = base / "lunacy-native"
            destination.mkdir()
            result = self.run_build(source, destination)
            self.assertIn("refusing existing destination", result.stderr)
            self.assertNotIn("missing local", result.stderr)
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = make_source(base)
            (source / "SKILL.md").write_text("not frontmatter\n")
            (source / "orchestrator/IMPROVEMENT.md").write_text("[missing](absent.md)\n")
            destination = base / "lunacy-native"
            result = self.run_build(source, destination)
            self.assertIn("invalid standalone SKILL.md", result.stderr)
            self.assertNotIn("missing local", result.stderr)
            self.assertFalse(destination.exists())

    def test_later_copy_failure_retains_partial_output(self):
        sys.path.insert(0, str(ROOT / "packaging"))
        try:
            spec = importlib.util.spec_from_file_location("standalone_fixture", SCRIPT)
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
        finally:
            sys.path.pop(0)
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); source = make_source(base)
            destination = base / "lunacy-native"
            real_copy = shutil.copy2
            def fail_late(src, dst, *args, **kwargs):
                if Path(src).name == "scripts.txt":
                    raise OSError("induced later-copy failure")
                return real_copy(src, dst, *args, **kwargs)
            with mock.patch.object(module.shutil, "copy2", side_effect=fail_late):
                with self.assertRaisesRegex(OSError, "induced"):
                    module.build(source, destination)
            self.assertTrue(destination.is_dir())
            self.assertTrue((destination / "LICENSE").is_file())


if __name__ == "__main__":
    unittest.main()
