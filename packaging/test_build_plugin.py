"""Exercise the public packaging CLI; no real installer or model calls."""

import json
import os
from pathlib import Path
import re
import shutil
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

    def make_source(self, parent):
        """Make a small, git-free checkout containing the unmodified real CLI."""
        source = parent / "source"
        (source / "packaging/lunacy-native/.codex-plugin").mkdir(parents=True)
        (source / "packaging/lunacy-native/skills/golden/agents").mkdir(parents=True)
        shutil.copy2(SCRIPT, source / "packaging/build_plugin.py")
        root_files = {
            "SKILL.md": "native skill\n",
            "WORKSPACE.md": "workspace\n",
            "OPERATOR.md": "operator\n",
            "README.md": "read me — utf-8\n",
            "LICENSE": "fixture license\n",
        }
        for name, contents in root_files.items():
            (source / name).write_text(contents)
        for name in ("orchestrator", "worker", "scripts", "tests"):
            (source / name).mkdir()
            (source / name / f"{name}.txt").write_text(f"{name}\n")
        (source / "scripts/naïve.txt").write_text("snowman ☃\n")
        (source / "packaging/lunacy-native/.codex-plugin/plugin.json").write_text(
            '{"name":"lunacy-native","skills":"./skills"}\n')
        (source / "packaging/lunacy-native/skills/golden/SKILL.md").write_text(
            "golden fixture\n")
        (source / "packaging/lunacy-native/skills/golden/agents/openai.yaml").write_text(
            "interface: {}\n")
        return source

    def run_fixture_build(self, source, destination):
        script = source / "packaging/build_plugin.py"
        return subprocess.run([sys.executable, "-B", str(script), str(destination)],
                              capture_output=True, text=True, timeout=20)

    def assert_source_refused(self, mutate):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            marker = base / "outside-marker"
            marker.write_text("inert marker: do not copy or print\n")
            mutate(source, marker)
            output = base / "lunacy-native"
            result = self.run_fixture_build(source, output)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertFalse(output.exists() or output.is_symlink())
            self.assertEqual(marker.read_text(), "inert marker: do not copy or print\n")
            self.assertNotIn(marker.read_text().strip(), result.stdout + result.stderr)
            return result

    def test_complete_package_and_shared_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "lunacy-native"
            result = self.run_build(output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((output / "LICENSE").read_bytes(), (ROOT / "LICENSE").read_bytes())
            manifest = json.loads((output / ".codex-plugin/plugin.json").read_text())
            self.assertEqual(manifest["name"], output.name)
            self.assertEqual(manifest["version"], "0.2.0-rc.1")
            self.assertEqual(
                manifest["interface"]["defaultPrompt"],
                "Use $lunacy-native:lunacy for a genuinely new engineering task; "
                "plan before dispatch and preserve exact worker routing.",
            )
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
            golden_text = (golden / "SKILL.md").read_text()
            self.assertIn("$lunacy-native:golden", golden_text)
            links = re.findall(r"\]\((\.\./[^)]+)\)", (golden / "SKILL.md").read_text())
            self.assertTrue(links)
            for link in links:
                self.assertTrue((golden / link).is_file(), link)

    def test_git_free_fixture_builds_complete_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            output = base / "lunacy-native"
            result = self.run_fixture_build(source, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = {
                "LICENSE": "fixture license\n",
                ".codex-plugin/plugin.json": '{"name":"lunacy-native","skills":"./skills"}\n',
                "skills/golden/SKILL.md": "golden fixture\n",
                "skills/golden/agents/openai.yaml": "interface: {}\n",
                "skills/lunacy/SKILL.md": "native skill\n",
                "skills/lunacy/WORKSPACE.md": "workspace\n",
                "skills/lunacy/OPERATOR.md": "operator\n",
                "skills/lunacy/README.md": "read me — utf-8\n",
                "skills/lunacy/LICENSE": "fixture license\n",
                "skills/lunacy/orchestrator/orchestrator.txt": "orchestrator\n",
                "skills/lunacy/worker/worker.txt": "worker\n",
                "skills/lunacy/scripts/scripts.txt": "scripts\n",
                "skills/lunacy/scripts/naïve.txt": "snowman ☃\n",
                "skills/lunacy/tests/tests.txt": "tests\n",
            }
            actual = {str(path.relative_to(output)): path.read_text()
                      for path in output.rglob("*") if path.is_file()}
            self.assertEqual(actual, expected)
            self.assertEqual({path.name for path in (output / "skills").iterdir()},
                             {"lunacy", "golden"})

    def test_refuses_selected_root_file_symlink(self):
        def mutate(source, marker):
            (source / "LICENSE").unlink()
            (source / "LICENSE").symlink_to(marker)
        result = self.assert_source_refused(mutate)
        self.assertIn("LICENSE", result.stderr)

    def test_refuses_nested_native_file_symlinks(self):
        mutations = {
            "external": lambda source, marker: (source / "scripts/external").symlink_to(marker),
            "internal": lambda source, marker: (source / "scripts/internal").symlink_to(
                source / "worker/worker.txt"),
            "dangling": lambda source, marker: (source / "scripts/dangling").symlink_to(
                source / "missing"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                result = self.assert_source_refused(mutate)
                self.assertIn(f"scripts/{name}", result.stderr)

    def test_refuses_native_directory_and_template_links(self):
        def native_directory(source, marker):
            outside = marker.parent / "outside-dir"
            outside.mkdir()
            (outside / "payload").write_text("outside\n")
            (source / "scripts/linked-dir").symlink_to(outside, target_is_directory=True)

        def template_ancestor(source, marker):
            skills = source / "packaging/lunacy-native/skills"
            shutil.rmtree(skills)
            outside = marker.parent / "outside-skills"
            (outside / "golden").mkdir(parents=True)
            (outside / "golden/SKILL.md").write_text("outside\n")
            skills.symlink_to(outside, target_is_directory=True)

        def template_container(source, marker):
            container = source / "packaging/lunacy-native"
            shutil.rmtree(container)
            outside = marker.parent / "outside-template"
            (outside / ".codex-plugin").mkdir(parents=True)
            (outside / "skills/golden").mkdir(parents=True)
            (outside / ".codex-plugin/plugin.json").write_text("{}\n")
            (outside / "skills/golden/SKILL.md").write_text("outside\n")
            container.symlink_to(outside, target_is_directory=True)

        def manifest_root(source, marker):
            manifest = source / "packaging/lunacy-native/.codex-plugin"
            shutil.rmtree(manifest)
            outside = marker.parent / "outside-manifest"
            outside.mkdir()
            (outside / "plugin.json").write_text("{}\n")
            manifest.symlink_to(outside, target_is_directory=True)

        def golden_subtree(source, marker):
            outside = marker.parent / "outside-golden"
            outside.mkdir()
            (outside / "payload").write_text("outside\n")
            (source / "packaging/lunacy-native/skills/golden/linked-dir").symlink_to(
                outside, target_is_directory=True)

        def golden_cache_named_link(source, marker):
            (source / "packaging/lunacy-native/skills/golden/ignored.pyc").symlink_to(marker)

        for name, mutate, expected in (
                ("native-directory", native_directory, "scripts/linked-dir"),
                ("template-container", template_container, "packaging/lunacy-native"),
                ("template-ancestor", template_ancestor, "packaging/lunacy-native/skills"),
                ("manifest-root", manifest_root, "packaging/lunacy-native/.codex-plugin"),
                ("golden-subtree", golden_subtree, "skills/golden/linked-dir"),
                ("golden-cache-name", golden_cache_named_link, "skills/golden/ignored.pyc")):
            with self.subTest(name=name):
                result = self.assert_source_refused(mutate)
                self.assertIn(expected, result.stderr)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "os.mkfifo is unavailable")
    def test_refuses_fifo_without_opening_it(self):
        def mutate(source, marker):
            os.mkfifo(source / "scripts/inert-fifo")
        result = self.assert_source_refused(mutate)
        self.assertIn("scripts/inert-fifo", result.stderr)

    def test_excluded_native_cache_links_are_ignored(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            marker = base / "marker"
            marker.write_text("ignored\n")
            (source / "scripts/__pycache__").mkdir()
            (source / "scripts/__pycache__/linked").symlink_to(marker)
            (source / "scripts/ignored.pyc").symlink_to(marker)
            output = base / "lunacy-native"
            result = self.run_fixture_build(source, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((output / "skills/lunacy/scripts/__pycache__").exists())
            self.assertFalse((output / "skills/lunacy/scripts/ignored.pyc").exists())

    def test_new_regular_native_file_is_copied(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            (source / "worker/new-untracked.txt").write_text("regular fixture\n")
            output = base / "lunacy-native"
            result = self.run_fixture_build(source, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((output / "skills/lunacy/worker/new-untracked.txt").read_text(),
                             "regular fixture\n")

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

    def test_fixture_destination_refusals_preserve_sentinels(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            for kind in ("file", "directory", "symlink"):
                with self.subTest(kind=kind):
                    parent = base / kind
                    parent.mkdir()
                    output = parent / "lunacy-native"
                    if kind == "file":
                        output.write_text("keep\n")
                    elif kind == "directory":
                        output.mkdir()
                        (output / "sentinel").write_text("keep\n")
                    else:
                        target = parent / "target"
                        target.write_text("keep\n")
                        output.symlink_to(target)
                    before = target.read_text() if kind == "symlink" else None
                    result = self.run_fixture_build(source, output)
                    self.assertNotEqual(result.returncode, 0)
                    if kind == "file":
                        self.assertEqual(output.read_text(), "keep\n")
                    elif kind == "directory":
                        self.assertEqual((output / "sentinel").read_text(), "keep\n")
                    else:
                        self.assertTrue(output.is_symlink())
                        self.assertEqual(target.read_text(), before)
            inside = source / "lunacy-native"
            result = self.run_fixture_build(source, inside)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(inside.exists())

    def test_missing_selected_source_has_no_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            (source / "OPERATOR.md").unlink()
            output = base / "lunacy-native"
            result = self.run_fixture_build(source, output)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("OPERATOR.md", result.stderr)
            self.assertFalse(output.exists())

    def test_unreadable_copy_failure_retains_partial_output(self):
        if os.name != "posix":
            self.skipTest("POSIX mode bits are unavailable")
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            blocked = source / "scripts/scripts.txt"
            blocked.chmod(0)
            try:
                if os.access(blocked, os.R_OK):
                    self.skipTest("platform/effective user can still read a mode-000 file")
                output = base / "lunacy-native"
                result = self.run_fixture_build(source, output)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(output.is_dir())
                self.assertEqual((output / "LICENSE").read_text(), "fixture license\n")
                self.assertIn("scripts.txt", result.stderr)
            finally:
                blocked.chmod(0o600)


if __name__ == "__main__":
    unittest.main()
