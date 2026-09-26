import tempfile
import unittest
from pathlib import Path
from subprocess import run
import sys

from maintainer.read_footprint import FootprintError, create_report


class ReadFootprintTests(unittest.TestCase):
    def test_counts_declared_complete_files_without_token_claims(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "a.md").write_text("one two\n", encoding="utf-8")
            (root / "b.md").write_text("three—four\n", encoding="utf-8")
            report = create_report(root, {"entry": ("a.md",), "combined": ("a.md", "b.md")})
        self.assertEqual(report["schema"], "lunacy-read-footprint-v1")
        self.assertEqual(report["readSets"][0]["words"], 2)
        self.assertEqual(report["readSets"][1]["words"], 4)
        self.assertIn("not model tokens", report["measurement"]["words"])
        self.assertIn("not observed", report["measurement"]["scope"])

    def test_rejects_duplicate_and_escaping_declarations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "a.md").write_text("one\n", encoding="utf-8")
            with self.assertRaises(FootprintError):
                create_report(root, {"duplicate": ("a.md", "a.md")})
            with self.assertRaises(FootprintError):
                create_report(root, {"escape": ("../a.md",)})

    def test_rejects_symlinked_declared_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target.md"
            target.write_text("one\n", encoding="utf-8")
            link = root / "link.md"
            try:
                link.symlink_to(target)
            except (NotImplementedError, OSError):
                self.skipTest("symlinks unavailable")
            with self.assertRaises(FootprintError):
                create_report(root, {"linked": ("link.md",)})

    def test_cli_is_stdout_only_and_does_not_accept_output_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            sentinel = Path(temporary) / "sentinel.json"
            sentinel.write_text("keep\n", encoding="utf-8")
            result = run(
                [sys.executable, "-B", "-m", "maintainer.read_footprint",
                 "--root", str(Path(__file__).resolve().parents[2]),
                 "--output", str(sentinel)],
                cwd=Path(__file__).resolve().parents[2],
                text=True,
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("unrecognized arguments", result.stderr)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep\n")


if __name__ == "__main__":
    unittest.main()
