from pathlib import Path
import tempfile
import unittest

from maintainer.read_map import ReadMapError, validate_source
from maintainer import read_map
from scripts import read_map_core


ROOT = Path(__file__).resolve().parents[2]


class ReadMapTests(unittest.TestCase):
    def test_parser_adapter_reuses_shipped_core_without_semantic_drift(self):
        self.assertIs(read_map.INLINE_LINK, read_map_core.INLINE_LINK)
        self.assertIs(read_map.FENCE, read_map_core.FENCE)
        self.assertIs(read_map.resolve_published_link,
                      read_map_core.resolve_published_link)
        self.assertEqual(
            read_map.resolve_published_link(
                "source", "worker/ENGINEERING.md", "../WORKSPACE.md"),
            ("WORKSPACE.md", "WORKSPACE.md"))
        self.assertEqual(
            read_map.resolve_published_link(
                "package", "skills/lunacy/worker/ENGINEERING.md",
                "../WORKSPACE.md"),
            ("skills/lunacy/WORKSPACE.md", "WORKSPACE.md"))
        self.assertEqual(
            read_map.resolve_published_link(
                "source", "worker/ENGINEERING.md", ""),
            ("worker/ENGINEERING.md", "worker/ENGINEERING.md"))
        self.assertEqual(
            read_map.resolve_published_link(
                "package", "skills/lunacy/worker/ENGINEERING.md", ""),
            ("skills/lunacy/worker/ENGINEERING.md", "worker/ENGINEERING.md"))
        self.assertFalse(read_map_core.published_lunacy_path("scripts/ignored.pyc"))
        self.assertFalse(read_map_core.published_lunacy_path("scripts/ignored.pyo"))
        self.assertFalse(read_map_core.published_lunacy_path(
            "scripts/__pycache__/cached.py"))
        sample = "# Same\n# Same\n```\n<a id=\"fake\"></a>\n```\n"
        self.assertEqual(read_map._anchors(sample), {"same", "same-1"})

    def make_source(self, root):
        (root / "orchestrator").mkdir()
        (root / "worker").mkdir()
        (root / "packaging/lunacy-native/skills/golden").mkdir(parents=True)
        (root / "SKILL.md").write_text(
            "# Entry\n"
            "<a id=\"entry-compat\"></a>\n"
            "[same](#entry-compat) [local](WORKSPACE.md#workspace-compat)\n"
            "[external](https://example.invalid/missing)\n"
            "```md\n[code example](missing-example.md#nope)\n```\n")
        (root / "WORKSPACE.md").write_text(
            "<a id=\"workspace-compat\"></a>\n# Workspace\n")
        (root / "OPERATOR.md").write_text("# Operator\n")
        (root / "README.md").write_text("# Readme\n")
        (root / "orchestrator/PLANNING.md").write_text("# Planning\n")
        (root / "orchestrator/IMPROVEMENT.md").write_text("# Golden cycle\n")
        (root / "worker/ENGINEERING.md").write_text("# Engineering\n")
        (root / "packaging/lunacy-native/skills/golden/SKILL.md").write_text(
            "[entry](../lunacy/SKILL.md#entry-compat)\n")

    def test_valid_fragments_and_ignored_external_and_fenced_examples(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_source(root)
            with (root / "SKILL.md").open("a") as stream:
                stream.write(
                    "````md\n"
                    "[inside](shorter-fence-does-not-close.md)\n"
                    "```\n"
                    "[still inside](marker-info-does-not-close.md)\n"
                    "```` not-a-close\n"
                    "[also inside](still-fenced.md)\n"
                    "````\n")
            report = validate_source(root)
        self.assertEqual(report["layout"], "source")
        self.assertEqual(report["localLinksChecked"], 3)
        self.assertIn("not model tokens", report["claims"])

    def test_missing_file_and_historical_anchor_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_source(root)
            (root / "SKILL.md").write_text("[missing](absent.md)\n")
            with self.assertRaisesRegex(ReadMapError, "missing local link target"):
                validate_source(root)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_source(root)
            (root / "WORKSPACE.md").write_text("# Workspace\n")
            with self.assertRaisesRegex(ReadMapError, "missing local anchor"):
                validate_source(root)

    def test_golden_guidance_is_forbidden_in_ordinary_declared_set(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_source(root)
            read_sets = {
                "ordinary-entry": ("SKILL.md",),
                "ordinary-bad": ("orchestrator/IMPROVEMENT.md",),
            }
            with self.assertRaisesRegex(ReadMapError, "Golden-only guidance"):
                validate_source(root, read_sets)
            read_sets["ordinary-bad"] = ("./orchestrator/IMPROVEMENT.md",)
            with self.assertRaisesRegex(ReadMapError, "path is not canonical"):
                validate_source(root, read_sets)

    def test_existing_unshipped_and_ignored_targets_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_source(root)
            (root / "maintainer").mkdir()
            (root / "maintainer/read_map.py").write_text("private\n")
            (root / "scripts/__pycache__").mkdir(parents=True)
            (root / "scripts/ignored.pyc").write_bytes(b"bytecode")
            (root / "scripts/ignored.pyo").write_bytes(b"bytecode")
            (root / "scripts/__pycache__/cached.pyc").write_bytes(b"bytecode")
            for destination in (
                "maintainer/read_map.py",
                "scripts/ignored.pyc",
                "scripts/ignored.pyo",
                "scripts/__pycache__/cached.pyc",
            ):
                with self.subTest(destination=destination):
                    (root / "SKILL.md").write_text(f"[private]({destination})\n")
                    with self.assertRaisesRegex(ReadMapError, "target is not shipped"):
                        validate_source(root)

    def test_entry_cap_is_whitespace_words_not_model_tokens(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_source(root)
            (root / "SKILL.md").write_text("word " * 651)
            with self.assertRaisesRegex(ReadMapError, "650 whitespace words: 651"):
                validate_source(root)

    def test_explicit_guidance_projection_checks_only_selected_shipped_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_source(root)
            (root / "packaging/lunacy-native/skills/golden/SKILL.md").write_text(
                "[missing](../lunacy/SKILL.md#absent)\n")
            published = {
                "SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md", "LICENSE",
                "orchestrator/PLANNING.md", "orchestrator/IMPROVEMENT.md",
                "worker/ENGINEERING.md",
            }
            report = validate_source(
                root,
                published_sources=published,
                guidance_paths=(
                    "SKILL.md", "WORKSPACE.md", "OPERATOR.md", "README.md",
                    "orchestrator/PLANNING.md", "orchestrator/IMPROVEMENT.md",
                    "worker/ENGINEERING.md",
                ),
            )
            self.assertEqual(report["guidanceFiles"], 7)
            with self.assertRaisesRegex(ReadMapError, "missing local anchor"):
                validate_source(root)

    def test_explicit_guidance_projection_enforces_publication_membership(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_source(root)
            (root / "maintainer").mkdir()
            (root / "maintainer/read_map.py").write_text("private\n")
            (root / "SKILL.md").write_text("[private](maintainer/read_map.py)\n")
            with self.assertRaisesRegex(ReadMapError, "target is not shipped"):
                validate_source(
                    root,
                    published_sources={"SKILL.md"},
                    guidance_paths=("SKILL.md",),
                )

    def test_explicit_guidance_projection_rejects_unsafe_or_malformed_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.make_source(root)
            for guidance in (
                ("../SKILL.md",), ("/SKILL.md",), ("./SKILL.md",),
                ("SKILL.md", "SKILL.md"), ("",), ("SKILL.md", 1),
            ):
                with self.subTest(guidance=guidance):
                    with self.assertRaisesRegex(ReadMapError, "guidance path"):
                        validate_source(root, guidance_paths=guidance)

    def test_current_source_contract_and_historical_anchors_pass(self):
        report = validate_source(ROOT)
        self.assertLessEqual(report["ordinaryEntryWords"], 650)
        self.assertGreater(report["localLinksChecked"], 0)
        self.assertIn("not model tokens", report["claims"])


if __name__ == "__main__":
    unittest.main()
