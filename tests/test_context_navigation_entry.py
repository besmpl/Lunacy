"""Optional navigator signposts survive ordinary, non-recursive action reads."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/context_excerpt.py"
PARENT_CAPABILITY = (
    "Optional [navigation](OPERATOR.md#optional-action-context-navigator) and "
    "[authorized POSIX runners](OPERATOR.md) aren't model\n"
    "launchers, sandboxes, supervisors or authority resolvers. Capture proves neither\n"
    "settled effects nor correctness. Indexing grants no replay/acceptance; commands\n"
    "require authority.\n"
)
WORKER_SIGNPOST = (
    "After authority and assignment are known, the optional "
    "[action/section navigator](../OPERATOR.md#optional-action-context-navigator) "
    "can retrieve exact triggers or linked fragments. It grants no authority "
    "and waives no applicable reading obligations; neither using it nor "
    "reading its reference is an ordinary prerequisite."
)
DIRECT_DESTINATIONS = {
    "One-owner adoption/dispatch": [
        ("WORKSPACE.md", "authority-entry-and-coexistence", "heading-span"),
        ("orchestrator/PLANNING.md", "compact-task-form", "heading-span"),
        ("WORKSPACE.md", "the-uniform-record-contract", "heading-span"),
        ("orchestrator/PLANNING.md", "exact-native-routing", "heading-span"),
    ],
    "Worker implementation/report": [
        ("worker/ENGINEERING.md", None, "whole-file"),
        ("WORKSPACE.md", "worker-updates-and-immutable-report", "heading-span"),
    ],
}


class ContextNavigationEntryTests(unittest.TestCase):
    def excerpt(self, command, *selection, root=ROOT):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), command, "--root", str(root),
             "--layout", "source", "--source-relative", "SKILL.md", *selection],
            capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        return json.loads(result.stdout)

    def test_parent_capability_section_preserves_optional_pointer_and_warnings(self):
        receipt = self.excerpt("section-excerpt", "--fragment", "capability-ceiling")
        excerpt = receipt["excerpt"]
        self.assertIn(PARENT_CAPABILITY, excerpt["text"])
        bounds = excerpt["byte_range"]
        self.assertEqual(excerpt["text"].encode("utf-8"),
                         (ROOT / "SKILL.md").read_bytes()[bounds["start"]:bounds["end"]])
        self.assertEqual(excerpt["nested_scan"], "not-performed")
        self.assertEqual(receipt["limits"]["files_opened"], 1)

    def test_worker_destination_retains_full_optional_unfollowed_source_quote(self):
        receipt = self.excerpt("action-excerpt", "--trigger", "Worker implementation/report")
        guide = receipt["destinations"][0]
        self.assertEqual(guide["kind"], "whole-file")
        self.assertEqual(guide["text"].encode("utf-8"),
                         (ROOT / "worker/ENGINEERING.md").read_bytes())
        self.assertIn(WORKER_SIGNPOST, guide["text"])
        links = [item for item in receipt["outstanding_links"]
                 if item["source_logical_path"] == "worker/ENGINEERING.md"
                 and item["target"] == {
                     "logical_path": "OPERATOR.md",
                     "fragment": "optional-action-context-navigator",
                 }]
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["source_quote"], WORKER_SIGNPOST + "\n")
        self.assertEqual(links[0]["resolution_state"], "unfollowed")
        self.assertEqual(links[0]["applicability"], "caller-decides")

    def test_action_destinations_stay_direct_without_acquiring_operator(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            # Real entry documents, but no OPERATOR: neither pointer is a read prerequisite.
            for relative in ("SKILL.md", "WORKSPACE.md", "orchestrator/PLANNING.md",
                             "worker/ENGINEERING.md"):
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / relative).read_bytes())
            self.assertFalse((root / "OPERATOR.md").exists())
            for trigger, expected in DIRECT_DESTINATIONS.items():
                with self.subTest(trigger=trigger):
                    receipt = self.excerpt("action-excerpt", "--trigger", trigger, root=root)
                    self.assertEqual(
                        [(item["logical_path"], item["fragment"], item["kind"])
                         for item in receipt["destinations"]], expected,
                    )
                    self.assertEqual(receipt["limits"]["files_opened"], 3)


if __name__ == "__main__":
    unittest.main()
