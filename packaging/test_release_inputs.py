"""Focused tests for the shared, metadata-only release selector."""

import os
from pathlib import Path
import shutil
import tempfile
import unittest

from release_inputs import select_release_inputs


ROOT = Path(__file__).resolve().parents[1]


def make_source(base: Path) -> Path:
    source = base / "source tree"
    (source / "packaging/lunacy-native/.codex-plugin").mkdir(parents=True)
    (source / "packaging/lunacy-native/skills/golden").mkdir(parents=True)
    (source / "maintainer").mkdir()
    for name in ("SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md", "LICENSE"):
        (source / name).write_text(f"{name}\n")
    for name in ("orchestrator", "worker", "scripts", "tests"):
        (source / name).mkdir()
        (source / name / "payload.txt").write_text(name)
    for name in ("read_footprint.py", "read_map.py"):
        (source / "maintainer" / name).write_text("# fixture\n")
    (source / "packaging/lunacy-native/.codex-plugin/plugin.json").write_text("{}\n")
    (source / "packaging/lunacy-native/skills/golden/SKILL.md").write_text("golden\n")
    return source


class ReleaseInputTests(unittest.TestCase):
    def test_order_and_native_generated_exclusions(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = make_source(Path(temporary))
            (source / "scripts/__pycache__").mkdir()
            (source / "scripts/__pycache__/linked").symlink_to(source / "missing")
            (source / "scripts/ignored.pyc").symlink_to(source / "missing")
            (source / "scripts/ignored.pyo").write_bytes(b"generated")
            plan = select_release_inputs(source)
            observed = [path.as_posix() for path in plan.native_entries]
            self.assertEqual(observed[:2], ["orchestrator", "orchestrator/payload.txt"])
            self.assertNotIn("scripts/__pycache__", observed)
            self.assertNotIn("scripts/ignored.pyc", observed)
            self.assertNotIn("scripts/ignored.pyo", observed)

    def test_template_regular_generated_nodes_skip_after_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = make_source(Path(temporary))
            golden = source / "packaging/lunacy-native/skills/golden"
            (golden / "__pycache__").mkdir()
            (golden / "__pycache__/bad-link").symlink_to(source / "missing")
            (golden / "ignored.pyc").write_bytes(b"generated")
            extra = source / "packaging/lunacy-native/skills/extra"
            extra.mkdir()
            (extra / "SKILL.md").write_text("extra\n")
            plan = select_release_inputs(source)
            observed = {path.as_posix() for path in plan.template_entries}
            self.assertFalse(any("__pycache__" in path for path in observed))
            self.assertFalse(any(path.endswith(".pyc") for path in observed))
            self.assertIn("packaging/lunacy-native/skills/extra/SKILL.md", observed)

    def test_template_cache_named_unsafe_nodes_refuse(self):
        mutations = {
            "link.pyc": lambda path: path.symlink_to(path.parent / "missing"),
            "__pycache__": lambda path: path.symlink_to(path.parent / "missing",
                                                         target_is_directory=True),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                source = make_source(Path(temporary))
                target = source / "packaging/lunacy-native/skills/golden" / name
                mutate(target)
                with self.assertRaisesRegex(ValueError, "symbolic link"):
                    select_release_inputs(source)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "os.mkfifo is unavailable")
    def test_template_cache_named_special_node_refuses(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = make_source(Path(temporary))
            target = source / "packaging/lunacy-native/skills/golden/ignored.pyo"
            os.mkfifo(target)
            with self.assertRaisesRegex(ValueError, "expected regular file or directory"):
                select_release_inputs(source)


if __name__ == "__main__":
    unittest.main()
