import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/context_excerpt.py"

LEGACY_RECOVERY = "Overlap, unknown authority/effects, deadline, recovery"
DEADLINE = "Adopted task deadline"


def destination_identity(receipt):
    return [(item["logical_path"], item["fragment"], item["kind"])
            for item in receipt["destinations"]]


def assert_recovery_text(test, receipt):
    recovery = receipt["destinations"][-1]
    test.assertEqual(
        (recovery["logical_path"], recovery["fragment"], recovery["kind"]),
        ("orchestrator/PLANNING.md", "recovery-and-anti-stall", "heading-span"),
    )
    text = recovery["text"]
    for expected in (
        "## Recovery and anti-stall",
        "Sealed assignment, dispatch never attempted, no handle",
        "Dispatch attempted but return missing or ambiguous",
        "Known running native tool/session",
        "Command settled, required report missing",
        "FINAL/report received, acceptance missing",
        "Finite task already accepted",
        "Material new input",
        "Unknown effects retain custody.",
        "No qualifying evidence observed is not proof that no work occurred",
        "15 minutes without an actionable attributed event",
        "Any authority, overlap, ordering, custody, effect, or freshness fact unknown",
        "### Worked recovery handoff",
    ):
        test.assertIn(expected, text)


class ContextExcerptTests(unittest.TestCase):
    def run_cli(self, *arguments, root=ROOT):
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "action-excerpt", "--root", str(root),
             "--layout", "source", "--source-relative", "SKILL.md", *arguments],
            capture_output=True, timeout=10)

    def test_real_worker_row_preserves_prose_and_direct_only_context(self):
        result = self.run_cli("--trigger", "Worker implementation/report")
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["schema"], "lunacy.action_excerpt.v1")
        self.assertIn("Current assignment and project rules", receipt["selection"]["row"]["text"])
        self.assertIn("Missing records decide nothing", receipt["governing_excerpts"][0]["text"])
        self.assertEqual(
            [(item["logical_path"], item["fragment"], item["kind"])
             for item in receipt["destinations"]],
            [("worker/ENGINEERING.md", None, "whole-file"),
             ("WORKSPACE.md", "worker-updates-and-immutable-report", "heading-span")],
        )
        self.assertTrue(receipt["outstanding_links"])
        self.assertTrue(all(item["resolution_state"] == "unfollowed"
                            and item["applicability"] == "caller-decides"
                            and item["source_quote"]
                            for item in receipt["outstanding_links"]))
        self.assertFalse(receipt["limits"]["truncated"])
        self.assertIn("no-atomic-multi-file-snapshot", receipt["source"]["freshness"])

    def test_acceptance_row_starts_at_acceptance_and_keeps_dispatch_conditional(self):
        result = self.run_cli("--trigger", "Parent acceptance/evidence gap")
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        receipt = json.loads(result.stdout)
        self.assertEqual(
            [(item["logical_path"], item["fragment"], item["kind"])
             for item in receipt["destinations"]],
            [("orchestrator/PLANNING.md", "acceptance-and-barrier", "heading-span"),
             ("WORKSPACE.md", "ownership-barrier-and-acceptance", "heading-span")],
        )
        acceptance = receipt["destinations"][0]
        self.assertIn("otherwise keep the acceptance path local", acceptance["text"])
        self.assertTrue(any(
            item["source_logical_path"] == "orchestrator/PLANNING.md"
            and item["target"]["fragment"] == "dispatch-and-evidence-ownership"
            and item["resolution_state"] == "unfollowed"
            for item in receipt["outstanding_links"]
        ))
        self.assertNotIn(
            "dispatch-and-evidence-ownership",
            [item["fragment"] for item in receipt["destinations"]],
        )

    def test_legacy_recovery_selector_preserves_prefix_and_adds_recovery(self):
        result = self.run_cli("--trigger", LEGACY_RECOVERY)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["selection"]["row"]["trigger"], LEGACY_RECOVERY)
        self.assertEqual(destination_identity(receipt), [
            ("WORKSPACE.md", "authority-entry-and-coexistence", "heading-span"),
            ("WORKSPACE.md", "ownership-barrier-and-acceptance", "heading-span"),
            ("orchestrator/PLANNING.md", "adopted-deadlines-and-finalization",
             "heading-span"),
            ("orchestrator/PLANNING.md", "recovery-and-anti-stall", "heading-span"),
        ])
        governing = receipt["governing_excerpts"][0]["text"]
        self.assertIn("Read current authority and mutable `TASK.md` coordination", governing)
        assert_recovery_text(self, receipt)

    def test_deadline_selector_is_local(self):
        result = self.run_cli("--trigger", DEADLINE)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        deadline = json.loads(result.stdout)
        self.assertEqual(destination_identity(deadline), [
            ("WORKSPACE.md", "authority-entry-and-coexistence", "heading-span"),
            ("WORKSPACE.md", "ownership-barrier-and-acceptance", "heading-span"),
            ("orchestrator/PLANNING.md", "adopted-deadlines-and-finalization",
             "heading-span"),
        ])
        deadline_text = "\n".join(item["text"] for item in deadline["destinations"])
        for excluded in ("Recovery and anti-stall", "Resume by the observed boundary",
                         "15 minutes without an actionable attributed event",
                         "Worked recovery handoff"):
            self.assertNotIn(excluded, deadline_text)

    def test_missing_legacy_recovery_edge_is_a_discriminating_negative_control(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "orchestrator").mkdir()
            skill = (ROOT / "SKILL.md").read_text()
            skill = skill.replace(
                ", [recovery](orchestrator/PLANNING.md#recovery-and-anti-stall)", "", 1)
            (root / "SKILL.md").write_text(skill)
            (root / "WORKSPACE.md").write_bytes((ROOT / "WORKSPACE.md").read_bytes())
            (root / "orchestrator/PLANNING.md").write_bytes(
                (ROOT / "orchestrator/PLANNING.md").read_bytes())
            result = self.run_cli("--trigger", LEGACY_RECOVERY, root=root)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        receipt = json.loads(result.stdout)
        self.assertEqual(len(receipt["destinations"]), 3)
        with self.assertRaises(AssertionError):
            assert_recovery_text(self, receipt)

    def test_legacy_operator_alias_exposes_conditional_recipe_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "OPERATOR.md").write_bytes((ROOT / "OPERATOR.md").read_bytes())
            (root / "SKILL.md").write_text(
                "# Fixture\n\n## Before-action reads\n\n"
                "Before action, acquire direct destinations; nested links remain unfollowed.\n\n"
                "### Ordinary trigger table\n\n| Trigger | Read next |\n| --- | --- |\n"
                "| Legacy contract | [contract](OPERATOR.md#large-output-command-reference) |\n",
                encoding="utf-8",
            )
            result = self.run_cli("--trigger", "Legacy contract", root=root)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["destinations"][0]["fragment"],
                         "large-output-command-reference")
        self.assertEqual(receipt["destinations"][0]["kind"], "heading-span")
        self.assertEqual(
            {(item["target"]["fragment"], item["resolution_state"])
             for item in receipt["outstanding_links"]},
            {("optional-posix-command-runner", "unfollowed"),
             ("bounded-shell-fallback", "unfollowed")},
        )

    def test_trigger_file_is_optional_bounded_exact_selector(self):
        with tempfile.TemporaryDirectory() as temporary:
            selector = Path(temporary) / "trigger"
            selector.write_text("Worker implementation/report\n")
            result = self.run_cli("--trigger-file", str(selector))
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            selector.write_bytes(b"x" * 65537)
            result = self.run_cli("--trigger-file", str(selector))
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(json.loads(result.stderr)["code"], "usage_cap_exceeded")

    def test_new_selectors_keep_direct_exactness_and_trigger_file_crlf_rule(self):
        for selector in (LEGACY_RECOVERY, DEADLINE):
            for mismatch in (selector.lower(), " " + selector, selector + " "):
                with self.subTest(selector=selector, mismatch=mismatch):
                    result = self.run_cli("--trigger", mismatch)
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(json.loads(result.stderr)["code"], "missing_trigger")
        with tempfile.TemporaryDirectory() as temporary:
            selector_file = Path(temporary) / "trigger"
            selector_file.write_bytes((DEADLINE + "\r\n\r\n").encode())
            result = self.run_cli("--trigger-file", str(selector_file))
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(json.loads(result.stdout)["selection"]["row"]["trigger"], DEADLINE)
            selector_file.write_bytes((DEADLINE + " \r\n").encode())
            result = self.run_cli("--trigger-file", str(selector_file))
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stderr)["code"], "missing_trigger")

    def test_effective_caps_fail_all_or_error(self):
        for arguments, code, exit_code in (
            (("--max-acquired-bytes", "10"), "aggregate_cap_exceeded", 5),
            (("--max-files", "1"), "file_count_cap_exceeded", 5),
            (("--max-output-bytes", "10"), "output_cap_exceeded", 5),
            (("--max-files", "129"), "usage_cap_exceeded", 2),
        ):
            with self.subTest(code=code):
                result = self.run_cli("--trigger", "Worker implementation/report", *arguments)
                self.assertEqual(result.returncode, exit_code, result.stderr.decode())
                self.assertEqual(result.stdout, b"")
                self.assertEqual(json.loads(result.stderr)["code"], code)

    def test_source_root_and_selector_are_exact(self):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "action-excerpt", "--root", ".",
             "--layout", "source", "--source-relative", "SKILL.md",
             "--trigger", "worker implementation/report"],
            capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stderr)["code"], "usage_error")
        result = self.run_cli("--trigger", "worker implementation/report")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stderr)["code"], "missing_trigger")


if __name__ == "__main__":
    unittest.main()
