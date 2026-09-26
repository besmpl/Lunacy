from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from maintainer import evaluation_pack


ROOT = Path(__file__).resolve().parents[2]


class EvaluationPackTests(unittest.TestCase):
    def _check_control(self, fixture, module_name, source):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = evaluation_pack.materialize(
                fixture, Path(temporary) / "case")
            (candidate / module_name).write_text(source)
            return evaluation_pack.check(fixture, candidate)

    def test_all_fixtures_reject_starters_and_incomplete_variants(self):
        observations = evaluation_pack.run_selfcheck()
        self.assertEqual(len(observations), 3 * len(evaluation_pack.FIXTURES))
        grouped = {(row["fixture"], row["variant"]): row for row in observations}
        for fixture in evaluation_pack.FIXTURES:
            starter = grouped[(fixture.name, "starter")]
            reference = grouped[(fixture.name, "reference")]
            incomplete = grouped[(fixture.name, "incomplete")]
            self.assertEqual(starter["status"], "FAIL")
            self.assertEqual(starter["exitCode"], 1)
            self.assertEqual(starter["detail"], fixture.starter_failure)
            self.assertNotIn("SyntaxError", starter["detail"])
            self.assertNotIn("ImportError", starter["detail"])
            self.assertEqual(reference["status"], "PASS")
            self.assertEqual(reference["exitCode"], 0)
            self.assertEqual(reference["detail"], "PASS")
            self.assertEqual(incomplete["status"], "FAIL")
            self.assertEqual(incomplete["exitCode"], 1)
            self.assertEqual(incomplete["detail"], fixture.incomplete_failure)

    def test_materializer_exposes_worker_packet_only_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "case"
            evaluation_pack.materialize("late-cancellation", destination)
            self.assertTrue((destination / "TASK.md").is_file())
            self.assertTrue((destination / "request_state.py").is_file())
            self.assertFalse((destination / "evaluator").exists())
            with self.assertRaisesRegex(evaluation_pack.EvaluationError,
                                        "refusing existing destination"):
                evaluation_pack.materialize("late-cancellation", destination)

    def test_manifest_has_unknown_counters_and_required_finite_budget_slots(self):
        manifest = json.loads(
            (ROOT / "maintainer/evaluation/manifest-template.json").read_text())
        self.assertEqual(manifest["schema"], "lunacy-offline-evaluation-run-v1")
        self.assertTrue(manifest["budgets"].pop(
            "requirePositiveFiniteIntegersBeforeDispatch"))
        self.assertEqual(set(manifest["budgets"]),
                         {"wallClockSeconds", "turns", "toolCalls", "outputBytes"})
        self.assertTrue(all(value is None for value in manifest["budgets"].values()))
        self.assertTrue(all(value is None
                            for value in manifest["observedCounters"].values()))
        for section, keys in {
            "comparison": {"cohortId", "workloadId", "baselineSourceSha256",
                           "acceptanceCriteriaSha256", "cacheCondition"},
            "scale": {"requestedTotalAgents", "effectiveCapacityTotalAgents",
                      "countConvention", "topology", "observedPeakActiveTotalAgents",
                      "observedPeakOpenTotalAgents", "observedDistinctAgents",
                      "slotReuseEvidencePointer"},
            "route": {"parentModel", "parentEffort", "workerModel", "workerEffort"},
            "workspace": {"strategy", "startingDirtyStateEvidencePointer",
                          "sentinelPreservationEvidencePointer"},
            "resourceBaseline": {"measurementWindow", "availableCpuCount",
                                 "availableMemoryBytes", "existingTestLoad",
                                 "plannedLimits"},
        }.items():
            self.assertLessEqual(keys, set(manifest[section]))
            self.assertTrue(all(manifest[section][key] is None for key in keys))
        self.assertIsNone(manifest["observedOutcomes"]["accepted"])
        self.assertEqual(manifest["observedOutcomes"]["failures"], [])
        self.assertEqual(manifest["observedOutcomes"]["cancellations"], [])
        self.assertNotIn("command", json.dumps(manifest).lower())

    def test_fixture_metadata_matches_the_fixed_runner_contract(self):
        for fixture in evaluation_pack.FIXTURES:
            fixture_root = ROOT / "maintainer/evaluation/fixtures" / fixture.name
            case = json.loads((fixture_root / "evaluator/case.json").read_text())
            task = (fixture_root / "worker/TASK.md").read_text()
            self.assertEqual(case["fixtureId"], fixture.name)
            self.assertEqual(case["starterFailure"], fixture.starter_failure)
            self.assertEqual(case["incompleteFailure"], fixture.incomplete_failure)
            self.assertTrue(case["acceptance"])
            self.assertTrue(case["forbiddenEffects"])
            for heading in ("## User request", "## Observable acceptance",
                            "## Forbidden effects"):
                self.assertIn(heading, task)

    def test_packaging_selection_excludes_maintainer_tree(self):
        builder = (ROOT / "packaging/build_plugin.py").read_text()
        self.assertNotIn('Path("maintainer")', builder)
        self.assertNotIn('"maintainer"', builder.split("NATIVE_TREES", 1)[1].split("\n", 1)[0])

    def test_timeout_boundary_is_finite(self):
        with self.assertRaisesRegex(evaluation_pack.EvaluationError, "timeout must"):
            evaluation_pack.run_selfcheck(0)
        with self.assertRaisesRegex(evaluation_pack.EvaluationError, "timeout must"):
            evaluation_pack.run_selfcheck(evaluation_pack.MAX_TIMEOUT_SECONDS + 1)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unsupported")
    def test_checker_rejects_a_symlink_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = evaluation_pack.materialize("late-cancellation", root / "real")
            link = root / "link"
            link.symlink_to(candidate, target_is_directory=True)
            with self.assertRaisesRegex(evaluation_pack.EvaluationError,
                                        "fixture tree is not a real directory"):
                evaluation_pack.check("late-cancellation", link)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unsupported")
    def test_checker_rejects_nested_symlinks_before_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = evaluation_pack.materialize("late-cancellation", root / "case")
            (candidate / "nested-link").symlink_to(candidate / "request_state.py")
            with self.assertRaisesRegex(evaluation_pack.EvaluationError,
                                        "fixture contains unsupported node"):
                evaluation_pack.check("late-cancellation", candidate)

    def test_malformed_candidate_is_error_with_raw_exit(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = evaluation_pack.materialize(
                "late-cancellation", Path(temporary) / "case")
            (candidate / "request_state.py").write_text("def broken(:\n")
            result = evaluation_pack.check("late-cancellation", candidate)
            self.assertEqual(result["status"], "ERROR")
            self.assertEqual(result["exitCode"], 1)
            self.assertIn("without exactly one result record", result["detail"])
            self.assertIn("SyntaxError", result["detail"])
            completed = subprocess.run(
                [sys.executable, "-B", "-m", "maintainer.evaluation_pack", "check",
                 "late-cancellation", str(candidate)],
                cwd=ROOT, capture_output=True, text=True, check=False)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(json.loads(completed.stdout)["status"], "ERROR")

    def test_cli_check_fails_for_behavioral_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = evaluation_pack.materialize(
                "late-cancellation", Path(temporary) / "case")
            completed = subprocess.run(
                [sys.executable, "-B", "-m", "maintainer.evaluation_pack", "check",
                 "late-cancellation", str(candidate)],
                cwd=ROOT, capture_output=True, text=True, check=False)
            self.assertEqual(completed.returncode, 1)
            result = json.loads(completed.stdout)
            self.assertEqual(result["status"], "FAIL")
            self.assertEqual(result["exitCode"], 1)

    def test_cli_selfcheck_succeeds_for_expected_rejections(self):
        completed = subprocess.run(
            [sys.executable, "-B", "-m", "maintainer.evaluation_pack", "selfcheck"],
            cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(len(json.loads(completed.stdout)),
                         3 * len(evaluation_pack.FIXTURES))

    def test_hard_cases_exercise_code_not_status_markdown(self):
        fixtures = ROOT / "maintainer/evaluation/fixtures"
        for name in ("misleading-green", "stale-evidence", "missing-test-environment"):
            worker = fixtures / name / "worker"
            self.assertTrue(any(path.suffix == ".py" for path in worker.iterdir()))
            self.assertFalse(any("status.md" == path.name.lower()
                                 for path in worker.iterdir()))

    def test_misleading_green_uses_fixed_behavior_not_candidate_tests(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = evaluation_pack.materialize(
                "misleading-green", Path(temporary) / "case")
            (candidate / "test_contact.py").unlink()
            result = evaluation_pack.check("misleading-green", candidate)
            self.assertEqual(result["status"], "FAIL")
            self.assertEqual(result["detail"], "email whitespace was not normalized")

    def test_chunk_oracle_distinguishes_boundary_controls(self):
        controls = {
            "reference": (
                "def positive(size):\n"
                "    if size <= 0:\n"
                "        raise ValueError\n"
                "    return size\n"
                "def chunk(values, size):\n"
                "    size = positive(size)\n"
                "    return [values[i:i + size] for i in range(0, len(values), size)]\n"
                "def count_chunks(length, size):\n"
                "    size = positive(size)\n"
                "    if length < 0:\n"
                "        raise ValueError\n"
                "    return (length + size - 1) // size\n",
                "PASS", 0),
            "zero-only-size-check": (
                "def valid(size):\n"
                "    if size == 0:\n"
                "        raise ValueError\n"
                "    return size\n"
                "def chunk(values, size):\n"
                "    size = valid(size)\n"
                "    return [values[i:i + size] for i in range(0, len(values), size)]\n"
                "def count_chunks(length, size):\n"
                "    size = valid(size)\n"
                "    if length < 0:\n"
                "        raise ValueError\n"
                "    return (length + size - 1) // size\n",
                "FAIL", 1),
            "missing-negative-length-check": (
                "def valid(size):\n"
                "    if size <= 0:\n"
                "        raise ValueError\n"
                "    return size\n"
                "def chunk(values, size):\n"
                "    size = valid(size)\n"
                "    return [values[i:i + size] for i in range(0, len(values), size)]\n"
                "def count_chunks(length, size):\n"
                "    size = valid(size)\n"
                "    return (length + size - 1) // size\n",
                "FAIL", 1),
            "alternative": (
                "def chunk(values, size):\n"
                "    if size < 1:\n"
                "        raise ValueError\n"
                "    result = []\n"
                "    offset = 0\n"
                "    while offset < len(values):\n"
                "        result.append(values[offset:offset + size])\n"
                "        offset += size\n"
                "    return result\n"
                "def count_chunks(length, size):\n"
                "    if size < 1 or length < 0:\n"
                "        raise ValueError\n"
                "    whole, remainder = divmod(length, size)\n"
                "    return whole + bool(remainder)\n",
                "PASS", 0),
        }
        for label, (source, status, exit_code) in controls.items():
            with self.subTest(label=label):
                result = self._check_control("chunk-refactor", "chunks.py", source)
                self.assertEqual(result["status"], status, result)
                self.assertEqual(result["exitCode"], exit_code, result)

    def test_email_oracle_distinguishes_whitespace_controls(self):
        controls = {
            "reference": (
                "def normalize_email(email):\n"
                "    local, domain = email.strip().split('@', 1)\n"
                "    return local + '@' + domain.lower()\n",
                "PASS", 0),
            "space-only-strip": (
                "def normalize_email(email):\n"
                "    local, domain = email.strip(' ').split('@', 1)\n"
                "    return local + '@' + domain.lower()\n",
                "FAIL", 1),
            "alternative": (
                "def normalize_email(email):\n"
                "    cleaned = email.strip()\n"
                "    separator = cleaned.index('@')\n"
                "    return cleaned[:separator] + '@' + cleaned[separator + 1:].lower()\n",
                "PASS", 0),
        }
        for label, (source, status, exit_code) in controls.items():
            with self.subTest(label=label):
                result = self._check_control("misleading-green", "contact.py", source)
                self.assertEqual(result["status"], status, result)
                self.assertEqual(result["exitCode"], exit_code, result)

    def test_stale_evidence_rejects_constant_stale_and_unknown_result_bug(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = evaluation_pack.materialize(
                "stale-evidence", Path(temporary) / "constant")
            (candidate / "evidence.py").write_text(
                "def classify_check(artifact_path, evidence):\n"
                "    return 'unknown' if evidence is None else 'stale'\n")
            result = evaluation_pack.check("stale-evidence", candidate)
            self.assertEqual(result["status"], "FAIL")
            self.assertEqual(result["detail"],
                             "matching before-edit evidence was not applicable")

        observations = evaluation_pack.run_selfcheck()
        incomplete = next(row for row in observations
                          if row["fixture"] == "stale-evidence"
                          and row["variant"] == "incomplete")
        self.assertEqual(incomplete["status"], "FAIL")
        self.assertEqual(incomplete["detail"],
                         "matching evidence without a result was not unknown")

    def test_interface_slices_can_be_green_while_combined_call_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = evaluation_pack.materialize(
                "interface-integration", Path(temporary) / "case")
            # The fixed checker runs the two local slice controls before the
            # actual catalog-to-invoice call. Their passing cannot mask the
            # shared-interface mismatch.
            result = evaluation_pack.check("interface-integration", candidate)
            self.assertEqual(result["status"], "FAIL")
            self.assertEqual(result["detail"],
                             "individually green slices did not integrate")
            reference = ROOT / "maintainer/evaluation/fixtures/interface-integration/evaluator/reference"
            (candidate / "invoice.py").write_bytes((reference / "invoice.py").read_bytes())
            result = evaluation_pack.check("interface-integration", candidate)
            self.assertEqual(result["status"], "FAIL")
            self.assertEqual(result["detail"],
                             "integration repair reused old passing proof")
            (candidate / "receipt.py").write_bytes((reference / "receipt.py").read_bytes())
            self.assertEqual(evaluation_pack.check("interface-integration", candidate)["status"],
                             "PASS")

    def test_interface_catalog_only_repair_keeps_legacy_invoice_and_passes(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = evaluation_pack.materialize(
                "interface-integration", Path(temporary) / "case")
            starter_invoice = (candidate / "invoice.py").read_bytes()
            catalog = (candidate / "catalog.py")
            catalog.write_text(
                "ORDERS = {\n"
                "    'desk': [('pen', 125, 2), ('pad', 75, 1)],\n"
                "    'mail': [('stamp', 40, 3)],\n"
                "}\n"
                "class CompatibleRow(dict):\n"
                "    def __getitem__(self, key):\n"
                "        if key == 'price_cents':\n"
                "            key = 'unit_cents'\n"
                "        return super().__getitem__(key)\n"
                "def lines_for_order(order_id):\n"
                "    return [CompatibleRow(sku=sku, unit_cents=cents, quantity=quantity)\n"
                "            for sku, cents, quantity in ORDERS[order_id]]\n",
                encoding="utf-8")
            reference = ROOT / "maintainer/evaluation/fixtures/interface-integration/evaluator/reference"
            (candidate / "receipt.py").write_bytes((reference / "receipt.py").read_bytes())
            self.assertEqual((candidate / "invoice.py").read_bytes(), starter_invoice)
            result = evaluation_pack.check("interface-integration", candidate)
            self.assertEqual(result["status"], "PASS", result)

    def test_dirty_workspace_preparation_preserves_existing_user_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = evaluation_pack.materialize(
                "dirty-sentinel", Path(temporary) / "case")
            user_note = candidate / "user-note.txt"
            original = user_note.read_bytes()
            reference = ROOT / "maintainer/evaluation/fixtures/dirty-sentinel/evaluator/reference/app.py"
            (candidate / "app.py").write_bytes(reference.read_bytes())
            self.assertEqual(user_note.read_bytes(), original)
            self.assertEqual(evaluation_pack.check("dirty-sentinel", candidate)["status"],
                             "PASS")
            with self.assertRaisesRegex(evaluation_pack.EvaluationError,
                                        "refusing existing destination"):
                evaluation_pack.materialize("dirty-sentinel", candidate)
            self.assertEqual(user_note.read_bytes(), original)

    def test_checker_import_does_not_create_candidate_bytecode(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = evaluation_pack.materialize(
                "late-cancellation", Path(temporary) / "case")
            result = evaluation_pack.check("late-cancellation", candidate)
            self.assertEqual(result["status"], "FAIL")
            self.assertFalse(any(path.name == "__pycache__" or path.suffix == ".pyc"
                                 for path in candidate.rglob("*")))


if __name__ == "__main__":
    unittest.main()
