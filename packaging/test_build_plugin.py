"""Exercise the public packaging CLI; no real installer or model calls."""

import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

from maintainer.read_map import validate_package


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "packaging/build_plugin.py"


class PluginBuildTests(unittest.TestCase):
    @staticmethod
    def snapshot_path(path):
        """Capture destination identity and bytes without following a link."""
        metadata = path.lstat()
        snapshot = {"device": metadata.st_dev, "inode": metadata.st_ino,
                    "mode": metadata.st_mode}
        if stat.S_ISLNK(metadata.st_mode):
            snapshot["target"] = os.readlink(path)
            target = path.resolve()
            if target.is_file():
                snapshot["target_bytes"] = target.read_bytes()
        elif stat.S_ISREG(metadata.st_mode):
            snapshot["bytes"] = path.read_bytes()
        elif stat.S_ISDIR(metadata.st_mode):
            snapshot["entries"] = {
                item.relative_to(path).as_posix(): item.read_bytes()
                for item in path.rglob("*") if item.is_file() and not item.is_symlink()
            }
        return snapshot

    def run_build(self, destination):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), str(destination)],
                              capture_output=True, text=True, timeout=20)

    def make_source(self, parent):
        """Make a small, git-free checkout containing the unmodified real CLI."""
        source = parent / "source"
        (source / "packaging/lunacy-native/.codex-plugin").mkdir(parents=True)
        (source / "packaging/lunacy-native/skills/golden/agents").mkdir(parents=True)
        (source / "maintainer").mkdir()
        shutil.copy2(SCRIPT, source / "packaging/build_plugin.py")
        shutil.copy2(ROOT / "packaging/release_inputs.py",
                     source / "packaging/release_inputs.py")
        for name in ("read_footprint.py", "read_map.py"):
            shutil.copy2(ROOT / "maintainer" / name, source / "maintainer" / name)
        root_files = {
            "SKILL.md": "---\nname: lunacy\ndescription: fixture\n---\nnative skill\n",
            "WORKSPACE.md": '<a id="historical"></a>\nworkspace\n',
            "OPERATOR.md": "operator\n",
            "README.md": "read me — utf-8\n",
            "LICENSE": "fixture license\n",
        }
        for name, contents in root_files.items():
            (source / name).write_text(contents)
        for name in ("orchestrator", "worker", "scripts", "tests"):
            (source / name).mkdir()
            (source / name / f"{name}.txt").write_text(f"{name}\n")
        shutil.copy2(ROOT / "scripts/read_map_core.py", source / "scripts/read_map_core.py")
        (source / "scripts/naïve.txt").write_text("snowman ☃\n")
        (source / "orchestrator/PLANNING.md").write_text("# Planning\n")
        (source / "orchestrator/IMPROVEMENT.md").write_text("# Improvement\n")
        (source / "worker/ENGINEERING.md").write_text("# Engineering\n")
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
                "Use $lunacy-native:lunacy for a genuinely new authorized task; "
                "plan before dispatch and preserve exact worker routing.",
            )
            skills = output / manifest["skills"]
            self.assertEqual({p.name for p in skills.iterdir()}, {"lunacy", "golden"})
            native = skills / "lunacy"
            self.assertTrue((native / "scripts/run_command.py").is_file())
            self.assertTrue((native / "scripts/context_excerpt.py").is_file())
            self.assertTrue((native / "scripts/read_map_core.py").is_file())
            self.assertFalse((native / "maintainer").exists())
            expected = {ROOT / name for name in
                        ("SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md", "LICENSE")}
            for name in ("orchestrator", "worker", "scripts", "tests"):
                expected.update(p for p in (ROOT / name).rglob("*")
                if p.is_file() and "__pycache__" not in p.parts
                and p.suffix not in {".pyc", ".pyo"})
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
                path, _, fragment = link.partition("#")
                target = golden / path
                self.assertTrue(target.is_file(), link)
                if fragment:
                    target_text = target.read_text()
                    explicit = f'id="{fragment}"' in target_text
                    headings = re.findall(r"^#{1,6}\s+(.+?)\s*$", target_text, re.MULTILINE)
                    generated = {
                        re.sub(r"[^a-z0-9 -]", "", heading.lower()).strip().replace(" ", "-")
                        for heading in headings
                    }
                    self.assertTrue(explicit or fragment in generated, link)
            package_read_map = validate_package(output)
            self.assertGreater(package_read_map["localLinksChecked"], 0)
            self.assertLessEqual(package_read_map["ordinaryEntryWords"], 650)

            def logical(receipt):
                return {
                    "row": {key: receipt["selection"]["row"][key]
                            for key in ("trigger", "text", "line_range", "bytes", "sha256")},
                    "governing": [{key: item[key] for key in
                                   ("logical_path", "line_range", "bytes", "sha256", "text")}
                                  for item in receipt["governing_excerpts"]],
                    "destinations": [{key: item[key] for key in
                                      ("logical_path", "fragment", "kind", "line_range",
                                       "bytes", "sha256", "text")}
                                     for item in receipt["destinations"]],
                    "outstanding": receipt["outstanding_links"],
                }
            for trigger in (
                "Worker implementation/report",
                "Overlap, unknown authority/effects, deadline, recovery",
                "Adopted task deadline",
            ):
                with self.subTest(trigger=trigger):
                    source_command = [
                        sys.executable, "-B", str(ROOT / "scripts/context_excerpt.py"),
                        "action-excerpt", "--root", str(ROOT), "--layout", "source",
                        "--source-relative", "SKILL.md", "--trigger", trigger,
                    ]
                    package_command = [
                        sys.executable, "-B", str(native / "scripts/context_excerpt.py"),
                        "action-excerpt", "--root", str(output), "--layout", "package",
                        "--source-relative", "skills/lunacy/SKILL.md", "--trigger", trigger,
                    ]
                    source_receipt = json.loads(subprocess.run(
                        source_command, capture_output=True, check=True, timeout=20).stdout)
                    package_receipt = json.loads(subprocess.run(
                        package_command, capture_output=True, check=True, timeout=20).stdout)
                    self.assertEqual(logical(source_receipt), logical(package_receipt))

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
                "skills/lunacy/SKILL.md": (
                    "---\nname: lunacy\ndescription: fixture\n---\nnative skill\n"),
                "skills/lunacy/WORKSPACE.md": '<a id="historical"></a>\nworkspace\n',
                "skills/lunacy/OPERATOR.md": "operator\n",
                "skills/lunacy/README.md": "read me — utf-8\n",
                "skills/lunacy/LICENSE": "fixture license\n",
                "skills/lunacy/orchestrator/orchestrator.txt": "orchestrator\n",
                "skills/lunacy/orchestrator/PLANNING.md": "# Planning\n",
                "skills/lunacy/orchestrator/IMPROVEMENT.md": "# Improvement\n",
                "skills/lunacy/worker/worker.txt": "worker\n",
                "skills/lunacy/worker/ENGINEERING.md": "# Engineering\n",
                "skills/lunacy/scripts/scripts.txt": "scripts\n",
                "skills/lunacy/scripts/naïve.txt": "snowman ☃\n",
                "skills/lunacy/scripts/read_map_core.py": (
                    source / "scripts/read_map_core.py").read_text(),
                "skills/lunacy/tests/tests.txt": "tests\n",
            }
            actual = {str(path.relative_to(output)): path.read_text()
                      for path in output.rglob("*") if path.is_file()}
            self.assertEqual(actual, expected)
            self.assertEqual({path.name for path in (output / "skills").iterdir()},
                             {"lunacy", "golden"})

    def test_guidance_preflight_refuses_before_creating_output(self):
        mutations = {
            "missing-file": lambda source, marker: (source / "SKILL.md").write_text(
                "[missing](absent.md)\n"),
            "missing-anchor": lambda source, marker: (source / "SKILL.md").write_text(
                "[history](WORKSPACE.md#removed-history)\n"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                result = self.assert_source_refused(mutate)
                self.assertIn("missing local", result.stderr)

    def test_guidance_preflight_includes_golden_and_shipped_improvement(self):
        mutations = {
            "golden": lambda source, marker: (
                source / "packaging/lunacy-native/skills/golden/SKILL.md").write_text(
                    "[missing](../lunacy/SKILL.md#absent)\n"),
            "improvement": lambda source, marker: (
                source / "orchestrator/IMPROVEMENT.md").write_text(
                    "[missing](../SKILL.md#absent)\n"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                result = self.assert_source_refused(mutate)
                self.assertIn("missing local anchor", result.stderr)

    def test_recursive_guidance_owner_success_matrix(self):
        cases = {
            "top-to-nested": lambda source: (
                (source / "orchestrator/nested").mkdir(),
                (source / "orchestrator/nested/DETAIL.md").write_text(
                    '<a id="detail"></a>\ndetail\n'),
                (source / "SKILL.md").write_text(
                    "[detail](orchestrator/nested/DETAIL.md#detail)\n")),
            "nested-to-nested": lambda source: (
                (source / "worker/nested").mkdir(),
                (source / "orchestrator/nested").mkdir(),
                (source / "worker/nested/TARGET.md").write_text("# Target\n"),
                (source / "orchestrator/nested/OWNER.md").write_text(
                    "[target](../../worker/nested/TARGET.md#target)\n")),
            "cyclic-nested": lambda source: (
                (source / "orchestrator/nested").mkdir(),
                (source / "orchestrator/nested/A.md").write_text("[b](B.md)\n"),
                (source / "orchestrator/nested/B.md").write_text("[a](A.md)\n")),
            "markdown-named-directory": lambda source: (
                (source / "orchestrator/notes.md").mkdir(),
                (source / "orchestrator/notes.md/OWNER.md").write_text(
                    "[planning](../PLANNING.md)\n")),
            "published-script-and-test-targets": lambda source: (
                (source / "scripts/example.md").write_text("# Script target\n"),
                (source / "tests/example.md").write_text("# Test target\n"),
                (source / "worker/OWNER.md").write_text(
                    "[script](../scripts/example.md#script-target)\n"
                    "[test](../tests/example.md#test-target)\n")),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                source = self.make_source(base)
                mutate(source)
                output = base / "lunacy-native"
                result = self.run_fixture_build(source, output)
                self.assertEqual(result.returncode, 0, result.stderr)
                for relative in source.rglob("*.md"):
                    selected = (relative.is_relative_to(source / "orchestrator")
                                or relative.is_relative_to(source / "worker"))
                    if relative.is_file() and selected:
                        projected = output / "skills/lunacy" / relative.relative_to(source)
                        self.assertEqual(projected.read_bytes(), relative.read_bytes())

    def test_recursive_guidance_owner_refusal_matrix(self):
        def nested_missing_target(source, marker):
            (source / "orchestrator/nested").mkdir()
            (source / "orchestrator/nested/OWNER.md").write_text("[missing](ABSENT.md)\n")

        def nested_missing_anchor(source, marker):
            (source / "worker/nested").mkdir()
            (source / "orchestrator/nested").mkdir()
            (source / "worker/nested/TARGET.md").write_text("# Present\n")
            (source / "orchestrator/nested/OWNER.md").write_text(
                "[missing](../../worker/nested/TARGET.md#absent)\n")

        def unlinked_nested(source, marker):
            (source / "orchestrator/nested").mkdir()
            (source / "orchestrator/nested/OWNER.md").write_text("[missing](absent)\n")

        def unlinked_mixed_case(source, marker):
            (source / "worker/nested").mkdir()
            (source / "worker/nested/OWNER.MD").write_text("[missing](absent)\n")

        def below_markdown_directory(source, marker):
            (source / "orchestrator/notes.md").mkdir()
            (source / "orchestrator/notes.md/OWNER.md").write_text("[missing](absent)\n")

        for name, mutate, diagnostic, owner in (
                ("nested-missing-target", nested_missing_target,
                 "missing local link target", "orchestrator/nested/OWNER.md"),
                ("nested-missing-anchor", nested_missing_anchor,
                 "missing local anchor", "orchestrator/nested/OWNER.md"),
                ("unlinked-nested", unlinked_nested,
                 "missing local link target", "orchestrator/nested/OWNER.md"),
                ("unlinked-mixed-case", unlinked_mixed_case,
                 "missing local link target", "worker/nested/OWNER.MD"),
                ("below-markdown-directory", below_markdown_directory,
                 "missing local link target", "orchestrator/notes.md/OWNER.md")):
            with self.subTest(name=name):
                result = self.assert_source_refused(mutate)
                self.assertIn(diagnostic, result.stderr)
                self.assertIn(owner, result.stderr)

    def test_excluded_markdown_owners_do_not_block(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            (source / "scripts/example.md").write_text("[missing](absent.md)\n")
            (source / "tests/example.md").write_text("[missing](absent.md)\n")
            template = source / "packaging/lunacy-native/skills/golden/NOT_OWNER.md"
            template.write_text("[missing](absent.md)\n")
            output = base / "lunacy-native"
            result = self.run_fixture_build(source, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((output / "skills/lunacy/scripts/example.md").read_bytes(),
                             (source / "scripts/example.md").read_bytes())
            self.assertEqual((output / "skills/lunacy/tests/example.md").read_bytes(),
                             (source / "tests/example.md").read_bytes())
            self.assertEqual((output / "skills/golden/NOT_OWNER.md").read_bytes(),
                             template.read_bytes())

    def test_linked_excluded_markdown_is_still_checked_as_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = self.make_source(base)
            (source / "scripts/example.md").write_text("# Present\n")
            (source / "orchestrator/OWNER.md").write_text(
                "[script](../scripts/example.md#absent)\n")
            output = base / "lunacy-native"
            result = self.run_fixture_build(source, output)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing local anchor", result.stderr)
            self.assertFalse(output.exists() or output.is_symlink())

    def test_guidance_preflight_rejects_existing_unshipped_targets(self):
        def unshipped(source, marker):
            (source / "SKILL.md").write_text(
                "[private helper](maintainer/read_map.py)\n")

        def ignored_pyc(source, marker):
            (source / "scripts/ignored.pyc").write_bytes(b"bytecode")
            (source / "SKILL.md").write_text("[ignored](scripts/ignored.pyc)\n")

        def ignored_pyo(source, marker):
            (source / "scripts/ignored.pyo").write_bytes(b"bytecode")
            (source / "SKILL.md").write_text("[ignored](scripts/ignored.pyo)\n")

        def ignored_cache(source, marker):
            (source / "scripts/__pycache__").mkdir()
            (source / "scripts/__pycache__/cached.pyc").write_bytes(b"bytecode")
            (source / "SKILL.md").write_text(
                "[ignored](scripts/__pycache__/cached.pyc)\n")

        for name, mutate in {
            "unshipped-helper": unshipped,
            "ignored-pyc": ignored_pyc,
            "ignored-pyo": ignored_pyo,
            "ignored-cache": ignored_cache,
        }.items():
            with self.subTest(name=name):
                result = self.assert_source_refused(mutate)
                self.assertIn("target is not shipped", result.stderr)

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
            (source / "scripts/ignored.pyo").symlink_to(marker)
            output = base / "lunacy-native"
            result = self.run_fixture_build(source, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((output / "skills/lunacy/scripts/__pycache__").exists())
            self.assertFalse((output / "skills/lunacy/scripts/ignored.pyc").exists())
            self.assertFalse((output / "skills/lunacy/scripts/ignored.pyo").exists())

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

    def test_whitespace_parent_path_builds(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary) / "output with whitespace"
            parent.mkdir()
            output = parent / "lunacy-native"
            result = self.run_build(output)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((output / ".codex-plugin/plugin.json").is_file())

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
                    before = self.snapshot_path(output)
                    result = self.run_fixture_build(source, output)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(self.snapshot_path(output), before)
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
