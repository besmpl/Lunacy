"""Exercise research helpers and opt-in reads from real release projections.

These checks establish shipped behavior, not research quality, independence,
live worker custody, or acceptance of the supplied observations.
"""

import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PYTHON = [sys.executable, "-E", "-s", "-B"]
RESEARCH_TRIGGER = "Explicit research swarm"
RESEARCH_GUIDE = "orchestrator/RESEARCH-SWARM.md"
CHECKPOINT_SCRIPT = "scripts/research_checkpoint.py"
ORDINARY_DESTINATIONS = {
    "Worker implementation/report": [
        ("worker/ENGINEERING.md", None, "whole-file"),
        ("WORKSPACE.md", "worker-updates-and-immutable-report", "heading-span"),
    ],
    "Parent acceptance/evidence gap": [
        ("orchestrator/PLANNING.md", "acceptance-and-barrier", "heading-span"),
        ("WORKSPACE.md", "ownership-barrier-and-acceptance", "heading-span"),
    ],
    "Overlap, unknown authority/effects, deadline, recovery": [
        ("WORKSPACE.md", "authority-entry-and-coexistence", "heading-span"),
        ("WORKSPACE.md", "ownership-barrier-and-acceptance", "heading-span"),
        ("orchestrator/PLANNING.md", "adopted-deadlines-and-finalization", "heading-span"),
        ("orchestrator/PLANNING.md", "recovery-and-anti-stall", "heading-span"),
    ],
    "Adopted task deadline": [
        ("WORKSPACE.md", "authority-entry-and-coexistence", "heading-span"),
        ("WORKSPACE.md", "ownership-barrier-and-acceptance", "heading-span"),
        ("orchestrator/PLANNING.md", "adopted-deadlines-and-finalization", "heading-span"),
    ],
}


def mixed_checkpoint():
    """Hand-worked input: copied support, dissent, stale proof and empty proof."""
    return {
        "schema": "lunacy-research-checkpoint-v1",
        "basis_revision": "revision-2",
        "branches": ["gamma", "delta", "beta", "alpha"],
        "evidence": [
            {"id": "e3", "branch": "alpha", "basis_revision": "revision-2",
             "relation": "challenges", "origin": "counterexample",
             "receipt": "unfetched:counterexample"},
            {"id": "e1", "branch": "alpha", "basis_revision": "revision-2",
             "relation": "supports", "origin": "upstream",
             "receipt": "unfetched:first-copy"},
            {"id": "e0", "branch": "alpha", "basis_revision": "revision-1",
             "relation": "supports", "origin": "upstream",
             "receipt": "unfetched:old-support"},
            {"id": "e5", "branch": "gamma", "basis_revision": "revision-2",
             "relation": "inconclusive", "origin": "separate-observation",
             "receipt": "unfetched:inconclusive"},
            {"id": "e4", "branch": "beta", "basis_revision": "revision-1",
             "relation": "inconclusive", "origin": "counterexample",
             "receipt": "unfetched:old-inconclusive"},
            {"id": "e2", "branch": "alpha", "basis_revision": "revision-2",
             "relation": "supports", "origin": "upstream",
             "receipt": "unfetched:second-copy"},
        ],
        "checks": [
            {"id": "c-subset", "branch": "alpha", "basis_revision": "revision-2",
             "evidence_ids": ["e2", "e1"], "result": "passed",
             "receipt": "unfetched:before-counterexample"},
            {"id": "c-unavailable", "branch": "gamma", "basis_revision": "revision-2",
             "evidence_ids": ["e5"], "result": "unavailable",
             "receipt": "unfetched:unavailable"},
            {"id": "c-old", "branch": "alpha", "basis_revision": "revision-1",
             "evidence_ids": ["e0"], "result": "passed",
             "receipt": "unfetched:old-check"},
            {"id": "c-empty", "branch": "delta", "basis_revision": "revision-2",
             "evidence_ids": [], "result": "passed", "receipt": "unfetched:empty"},
            {"id": "c-all", "branch": "alpha", "basis_revision": "revision-2",
             "evidence_ids": ["e3", "e1", "e2"], "result": "failed",
             "receipt": "unfetched:failed-current-check"},
        ],
    }


def tree_state(root):
    """Detect created paths or changed bytes in the owned, regular-file stage."""
    return {path.relative_to(root).as_posix(): (
                hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None)
            for path in root.rglob("*")}


def logical_excerpt(receipt):
    """Ignore physical paths and frontmatter-dependent byte offsets only."""
    row = receipt["selection"]["row"]
    return {
        "row": {key: row[key] for key in ("trigger", "text", "line_range", "bytes", "sha256")},
        "governing": [{key: item[key] for key in
                       ("logical_path", "line_range", "bytes", "sha256", "text")}
                      for item in receipt["governing_excerpts"]],
        "destinations": [{key: item[key] for key in
                          ("logical_path", "fragment", "kind", "line_range",
                           "bytes", "sha256", "text")}
                         for item in receipt["destinations"]],
        "outstanding": receipt["outstanding_links"],
    }


class ResearchSwarmPackageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        temporary = tempfile.TemporaryDirectory(prefix="lunacy-research-package-")
        cls.addClassCleanup(temporary.cleanup)
        cls.base = Path(temporary.name)
        cls.run_directory = cls.base / "isolated-working-directory"
        cls.run_directory.mkdir()
        native_parent = cls.base / "plugin"
        standalone_parent = cls.base / "standalone"
        native_parent.mkdir()
        standalone_parent.mkdir()
        cls.plugin = native_parent / "lunacy-native"
        cls.native = cls.plugin / "skills/lunacy"
        cls.standalone = standalone_parent / "lunacy-native"
        commands = [
            [*PYTHON, str(ROOT / "packaging/build_plugin.py"), str(cls.plugin)],
            [*PYTHON, str(ROOT / "packaging/build_standalone.py"),
             str(ROOT), str(cls.standalone)],
        ]
        for command in commands:
            result = subprocess.run(command, cwd=cls.run_directory,
                                    capture_output=True, timeout=30)
            if result.returncode:
                raise AssertionError(
                    f"fresh build failed ({result.returncode}): {command!r}\n"
                    f"{result.stderr.decode('utf-8', errors='replace')}")
        cls.surfaces = (
            ("source", ROOT, ROOT, "source", "SKILL.md"),
            ("plugin", cls.native, cls.plugin, "package", "skills/lunacy/SKILL.md"),
            ("standalone", cls.standalone, cls.standalone, "source", "SKILL.md"),
        )

    def run_excerpt(self, surface, trigger):
        _, skill, root, layout, entry = surface
        return subprocess.run(
            [*PYTHON, str(skill / "scripts/context_excerpt.py"), "action-excerpt",
             "--root", str(root), "--layout", layout, "--source-relative", entry,
             "--trigger", trigger],
            cwd=self.run_directory, capture_output=True, timeout=15)

    def assert_ordinary_excerpt(self, receipt, trigger):
        self.assertEqual(receipt["schema"], "lunacy.action_excerpt.v1")
        self.assertEqual(receipt["selection"]["row"]["trigger"], trigger)
        self.assertEqual(
            [(item["logical_path"], item["fragment"], item["kind"])
             for item in receipt["destinations"]], ORDINARY_DESTINATIONS[trigger])
        unique_files = {"SKILL.md", *(item[0] for item in ORDINARY_DESTINATIONS[trigger])}
        self.assertEqual(receipt["limits"]["files_opened"], len(unique_files))
        self.assertFalse(receipt["limits"]["truncated"])
        governing = "\n".join(item["text"] for item in receipt["governing_excerpts"])
        self.assertIn("Missing records decide nothing", governing)
        for path in (RESEARCH_GUIDE, CHECKPOINT_SCRIPT):
            self.assertNotIn(path, governing)
            self.assertNotIn(path, receipt["selection"]["row"]["text"])

    def assert_hand_worked_view(self, view):
        self.assertEqual(set(view), {
            "schema", "basis_revision", "advisory_only", "branches",
            "shared_origin_groups", "non_claims",
        })
        self.assertEqual(view["schema"], "lunacy-research-checkpoint-view-v1")
        self.assertEqual(view["basis_revision"], "revision-2")
        self.assertIs(view["advisory_only"], True)
        self.assertIsInstance(view["non_claims"], list)
        self.assertTrue(view["non_claims"])
        self.assertTrue(all(isinstance(item, str) and item for item in view["non_claims"]))
        expected = [
            {"id": "alpha", "applicable_evidence_ids": ["e1", "e2", "e3"],
             "stale_evidence_ids": ["e0"], "supports": ["e1", "e2"],
             "challenges": ["e3"], "inconclusive": [], "mixed_evidence": True,
             "current_declared_checks": [
                 {"id": "c-all", "result": "failed",
                  "receipt": "unfetched:failed-current-check"}],
             "stale_check_ids": ["c-old", "c-subset"], "gaps": ["declared-check-failed"]},
            {"id": "beta", "applicable_evidence_ids": [], "stale_evidence_ids": ["e4"],
             "supports": [], "challenges": [], "inconclusive": [], "mixed_evidence": False,
             "current_declared_checks": [], "stale_check_ids": [],
             "gaps": ["no-applicable-evidence", "no-current-declared-check"]},
            {"id": "delta", "applicable_evidence_ids": [], "stale_evidence_ids": [],
             "supports": [], "challenges": [], "inconclusive": [], "mixed_evidence": False,
             "current_declared_checks": [
                 {"id": "c-empty", "result": "passed", "receipt": "unfetched:empty"}],
             "stale_check_ids": [], "gaps": ["no-applicable-evidence"]},
            {"id": "gamma", "applicable_evidence_ids": ["e5"], "stale_evidence_ids": [],
             "supports": [], "challenges": [], "inconclusive": ["e5"], "mixed_evidence": False,
             "current_declared_checks": [
                 {"id": "c-unavailable", "result": "unavailable",
                  "receipt": "unfetched:unavailable"}],
             "stale_check_ids": [], "gaps": ["declared-check-unavailable"]},
        ]
        # Gap order is not part of the v1 ordering contract; ID ordering is.
        actual = copy.deepcopy(view["branches"])
        for branch in actual:
            branch["gaps"].sort()
        self.assertEqual(actual, expected)
        self.assertEqual(view["shared_origin_groups"], [
            {"origin": "counterexample", "evidence_ids": ["e3", "e4"]},
            {"origin": "upstream", "evidence_ids": ["e0", "e1", "e2"]},
        ])

    def test_new_files_ship_byte_identically_without_maintainer_dependency(self):
        source_entry = (ROOT / "SKILL.md").read_bytes()
        self.assertLessEqual(len(source_entry.decode("utf-8").split()), 650)
        self.assertEqual((self.native / "SKILL.md").read_bytes(), source_entry)
        self.assertEqual(
            (self.standalone / "SKILL.md").read_bytes(),
            source_entry.replace(b"\nname: lunacy\n", b"\nname: lunacy-native\n", 1))
        for skill in (self.native, self.standalone):
            with self.subTest(skill=skill):
                for relative in (RESEARCH_GUIDE, CHECKPOINT_SCRIPT):
                    self.assertEqual((skill / relative).read_bytes(), (ROOT / relative).read_bytes())
                self.assertFalse((skill / "maintainer").exists())
                self.assertFalse((skill / "packaging").exists())
        self.assertTrue((self.plugin / "skills/golden/SKILL.md").is_file())
        self.assertFalse((self.standalone / ".codex-plugin").exists())
        self.assertFalse((self.standalone / "skills").exists())

    def test_packaged_cli_valid_view_is_not_acceptance_and_has_no_output_files(self):
        payload = json.dumps(mixed_checkpoint()).encode("utf-8")
        views = []
        for name, skill in (("plugin", self.native), ("standalone", self.standalone)):
            for mode in ("file", "stdin"):
                with self.subTest(layout=name, mode=mode), tempfile.TemporaryDirectory(
                        dir=self.base, prefix="checkpoint-") as temporary:
                    cwd = Path(temporary)
                    checkpoint = cwd / "input.json"
                    checkpoint.write_bytes(payload)
                    before_work, before_skill = tree_state(cwd), tree_state(skill)
                    result = subprocess.run(
                        [*PYTHON, str(skill / CHECKPOINT_SCRIPT), "inspect",
                         str(checkpoint) if mode == "file" else "-"],
                        input=payload if mode == "stdin" else None, cwd=cwd,
                        capture_output=True, timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    self.assertEqual(result.stderr, b"")
                    view = json.loads(result.stdout)
                    self.assert_hand_worked_view(view)
                    views.append(view)
                    self.assertEqual(tree_state(cwd), before_work)
                    self.assertEqual(tree_state(skill), before_skill)
        self.assertTrue(all(view == views[0] for view in views))

    def test_packaged_cli_rejects_invalid_json_and_dangling_check_without_payload_leak(self):
        marker = "private-receipt-content-must-not-appear-8472"
        snapshot = mixed_checkpoint()
        snapshot["evidence"][0]["receipt"] = marker
        duplicate = json.dumps(snapshot)[:-1] + ', "evidence": []}'
        snapshot["checks"][0]["evidence_ids"] = ["not-known"]
        invalid_inputs = {"duplicate-key": duplicate, "dangling-evidence": json.dumps(snapshot)}
        for name, skill in (("plugin", self.native), ("standalone", self.standalone)):
            for case, payload in invalid_inputs.items():
                with self.subTest(layout=name, case=case):
                    before = tree_state(skill)
                    result = subprocess.run(
                        [*PYTHON, str(skill / CHECKPOINT_SCRIPT), "inspect", "-"],
                        input=payload.encode("utf-8"), cwd=self.run_directory,
                        capture_output=True, timeout=15)
                    self.assertEqual(result.returncode, 2, result.stderr.decode())
                    self.assertEqual(result.stdout, b"")
                    self.assertTrue(result.stderr.strip())
                    self.assertNotIn(marker.encode(), result.stderr)
                    self.assertEqual(tree_state(skill), before)
                    self.assertEqual(tree_state(self.run_directory), {})

    def test_research_trigger_reads_real_guide_identically_in_each_projection(self):
        excerpts = []
        for surface in self.surfaces:
            with self.subTest(layout=surface[0]):
                result = self.run_excerpt(surface, RESEARCH_TRIGGER)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                receipt = json.loads(result.stdout)
                self.assertFalse(receipt["limits"]["truncated"])
                self.assertEqual(receipt["selection"]["row"]["trigger"], RESEARCH_TRIGGER)
                self.assertEqual(
                    [(item["logical_path"], item["fragment"], item["kind"])
                     for item in receipt["destinations"]],
                    [(RESEARCH_GUIDE, None, "whole-file")])
                self.assertEqual(receipt["destinations"][0]["text"],
                                 (ROOT / RESEARCH_GUIDE).read_text(encoding="utf-8"))
                for link in receipt["outstanding_links"]:
                    self.assertEqual(link["resolution_state"], "unfollowed")
                    self.assertEqual(link["applicability"], "caller-decides")
                    target = link["target"]["logical_path"]
                    self.assertNotIn("maintainer", Path(target).parts)
                    self.assertTrue((surface[1] / target).is_file(), target)
                excerpts.append(logical_excerpt(receipt))
        self.assertEqual(excerpts[0], excerpts[1])
        self.assertEqual(excerpts[0], excerpts[2])

    def test_ordinary_action_reads_preserve_direct_destinations_in_each_projection(self):
        for trigger in ORDINARY_DESTINATIONS:
            excerpts = []
            for surface in self.surfaces:
                with self.subTest(layout=surface[0], trigger=trigger):
                    result = self.run_excerpt(surface, trigger)
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    receipt = json.loads(result.stdout)
                    self.assert_ordinary_excerpt(receipt, trigger)
                    excerpts.append(logical_excerpt(receipt))
            self.assertEqual(excerpts[0], excerpts[1])
            self.assertEqual(excerpts[0], excerpts[2])

    def test_ordinary_excerpts_work_without_optional_research_files(self):
        with tempfile.TemporaryDirectory(dir=self.base, prefix="missing-research-") as temporary:
            reduced = Path(temporary) / "lunacy-native"
            shutil.copytree(self.standalone, reduced)
            (reduced / RESEARCH_GUIDE).unlink()
            (reduced / CHECKPOINT_SCRIPT).unlink()
            surface = ("research-files-absent", reduced, reduced, "source", "SKILL.md")
            before = tree_state(reduced)
            for trigger in ORDINARY_DESTINATIONS:
                with self.subTest(trigger=trigger):
                    result = self.run_excerpt(surface, trigger)
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    self.assert_ordinary_excerpt(json.loads(result.stdout), trigger)
            research = self.run_excerpt(surface, RESEARCH_TRIGGER)
            self.assertNotEqual(research.returncode, 0)
            self.assertEqual(research.stdout, b"")
            self.assertTrue(research.stderr.strip())
            self.assertEqual(tree_state(reduced), before)


if __name__ == "__main__":
    unittest.main()
