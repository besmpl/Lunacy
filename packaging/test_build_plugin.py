"""Exercise the public packaging CLI; no real installer or model calls."""

import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "packaging/build_plugin.py"


class PluginBuildTests(unittest.TestCase):
    def run_build(self, destination):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), str(destination)],
                              capture_output=True, text=True, timeout=20)

    def test_complete_package_and_shared_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "lunacy-native"
            result = self.run_build(output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((output / "LICENSE").read_bytes(), (ROOT / "LICENSE").read_bytes())
            manifest = json.loads((output / ".codex-plugin/plugin.json").read_text())
            self.assertEqual(manifest["name"], output.name)
            skills = output / manifest["skills"]
            self.assertEqual({p.name for p in skills.iterdir()}, {"lunacy", "golden"})
            native = skills / "lunacy"
            expected = {ROOT / name for name in
                        ("SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md", "LICENSE")}
            for name in ("orchestrator", "worker", "scripts", "tests"):
                expected.update(p for p in (ROOT / name).rglob("*")
                                if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
            self.assertEqual({p.relative_to(native) for p in native.rglob("*") if p.is_file()},
                             {p.relative_to(ROOT) for p in expected})
            for source in expected:
                self.assertEqual(source.read_bytes(), (native / source.relative_to(ROOT)).read_bytes())
            golden = skills / "golden"
            for source in (ROOT / "packaging/lunacy-native/skills/golden").rglob("*"):
                if source.is_file():
                    self.assertEqual(source.read_bytes(), (golden / source.relative_to(
                        ROOT / "packaging/lunacy-native/skills/golden")).read_bytes())
            links = re.findall(r"\]\((\.\./[^)]+)\)", (golden / "SKILL.md").read_text())
            self.assertTrue(links)
            for link in links:
                self.assertTrue((golden / link).is_file(), link)

    def test_refuses_existing_directory_without_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "lunacy-native"
            output.mkdir()
            (output / "sentinel").write_text("keep")
            self.assertNotEqual(self.run_build(output).returncode, 0)
            self.assertEqual(list(output.iterdir()), [output / "sentinel"])
            self.assertEqual((output / "sentinel").read_text(), "keep")

    def test_refuses_dangling_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "lunacy-native"
            output.symlink_to(Path(temporary) / "missing")
            self.assertNotEqual(self.run_build(output).returncode, 0)
            self.assertTrue(output.is_symlink())
            self.assertFalse(output.exists())

    def test_refuses_inside_checkout(self):
        output = ROOT / "lunacy-native"
        self.assertFalse(output.exists())
        self.assertNotEqual(self.run_build(output).returncode, 0)
        self.assertFalse(output.exists())

    def test_refuses_wrong_folder_name(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "wrong"
            self.assertNotEqual(self.run_build(output).returncode, 0)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
