"""Integrity checks for manual decision packets, not agent behavior tests."""

import ast
import json
from pathlib import Path, PurePosixPath
import unittest


ROOT = Path(__file__).resolve().parents[2]
PACK = ROOT / "maintainer/evaluation/fixtures/research-swarm"
CASE_IDS = {"rival-transfer", "stale-origin", "custody-budget"}


def read_json(path):
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate fixture key: {key}")
            result[key] = value
        return result

    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)


class ResearchSwarmPacketTests(unittest.TestCase):
    def annotations(self, case_id):
        return read_json(PACK / case_id / "evaluator/annotations.json")

    def worker_file(self, case_id, relative):
        self.assertIsInstance(relative, str)
        path = PurePosixPath(relative)
        self.assertFalse(path.is_absolute())
        self.assertEqual(path.parts[0], "worker")
        self.assertNotIn("..", path.parts)
        root = PACK / case_id
        result = root / relative
        self.assertTrue(result.is_file(), relative)
        self.assertFalse(result.is_symlink(), relative)
        self.assertTrue(result.resolve().is_relative_to((root / "worker").resolve()))
        return result

    def pointer_value(self, value, pointer):
        self.assertIsInstance(pointer, str)
        self.assertTrue(pointer.startswith("/"))
        for token in pointer[1:].split("/"):
            key = token.replace("~1", "/").replace("~0", "~")
            if isinstance(value, list):
                self.assertTrue(key.isdecimal())
                self.assertEqual(str(int(key)), key)
                self.assertLess(int(key), len(value))
                value = value[int(key)]
            else:
                self.assertIsInstance(value, dict)
                self.assertIn(key, value)
                value = value[key]
        return value

    def test_cases_have_separate_complete_stage_inventories(self):
        self.assertEqual({p.name for p in PACK.iterdir() if p.is_dir()}, CASE_IDS)
        self.assertTrue((PACK / "README.md").is_file())
        self.assertTrue((PACK / "../../manifest-template.json").is_file())
        self.assertTrue((PACK / "../../native-run-recipe.md").is_file())
        for case_id in sorted(CASE_IDS):
            with self.subTest(case=case_id):
                annotation = self.annotations(case_id)
                self.assertEqual(annotation["schema"], "lunacy-research-swarm-rubric-v1")
                self.assertEqual(annotation["caseId"], case_id)
                self.assertEqual(annotation["status"], "provisional-synthetic")
                self.assertTrue(annotation["stages"])
                stage_ids, files = set(), set()
                for stage in annotation["stages"]:
                    self.assertEqual(set(stage), {"id", "after", "packet", "artifacts"})
                    self.assertNotIn(stage["id"], stage_ids)
                    if stage_ids:
                        self.assertIn(stage["after"], stage_ids)
                    else:
                        self.assertEqual(stage["id"], "initial")
                        self.assertIsNone(stage["after"])
                    stage_ids.add(stage["id"])
                    self.assertTrue(stage["packet"].endswith(".md"))
                    self.assertIsInstance(stage["artifacts"], list)
                    for relative in [stage["packet"], *stage["artifacts"]]:
                        self.assertNotIn(relative, files)
                        files.add(relative)
                        path = self.worker_file(case_id, relative)
                        contents = path.read_text(encoding="utf-8")
                        self.assertTrue(contents.strip())
                        if path.suffix == ".json":
                            self.assertIsInstance(read_json(path), dict)
                        elif path.suffix == ".py":
                            ast.parse(contents, filename=str(path))
                actual = {
                    str(p.relative_to(PACK / case_id))
                    for p in (PACK / case_id / "worker").rglob("*") if p.is_file()
                }
                self.assertEqual(files, actual)
                self.assertEqual(
                    {p.name for p in (PACK / case_id / "evaluator").iterdir()},
                    {"annotations.json"},
                )

    def test_evidence_locations_and_stage_availability_are_valid(self):
        for case_id in sorted(CASE_IDS):
            annotation = self.annotations(case_id)
            file_stage = {
                path: index
                for index, stage in enumerate(annotation["stages"])
                for path in [stage["packet"], *stage["artifacts"]]
            }
            stage_order = {s["id"]: i for i, s in enumerate(annotation["stages"])}
            for ref_id, reference in annotation["evidenceRefs"].items():
                with self.subTest(case=case_id, reference=ref_id):
                    self.assertTrue(ref_id)
                    self.assertIn(reference["path"], file_stage)
                    path = self.worker_file(case_id, reference["path"])
                    if "pointer" in reference:
                        self.assertEqual(set(reference), {"path", "pointer"})
                        self.pointer_value(read_json(path), reference["pointer"])
                    else:
                        self.assertEqual(set(reference), {"path", "lines"})
                        start, end = reference["lines"]
                        self.assertIs(type(start), int)
                        self.assertIs(type(end), int)
                        self.assertGreaterEqual(start, 1)
                        self.assertGreaterEqual(end, start)
                        self.assertLessEqual(end, len(path.read_text().splitlines()))
            for criterion in annotation["criteria"]:
                for ref in criterion["evidenceRefs"]:
                    path = annotation["evidenceRefs"][ref]["path"]
                    self.assertLessEqual(file_stage[path], stage_order[criterion["stage"]])

    def test_rubrics_have_linked_alternatives_and_wrong_controls(self):
        for case_id in sorted(CASE_IDS):
            with self.subTest(case=case_id):
                annotation = self.annotations(case_id)
                stages = {stage["id"] for stage in annotation["stages"]}
                criteria = {item["id"]: item for item in annotation["criteria"]}
                self.assertTrue(criteria)
                self.assertEqual(len(criteria), len(annotation["criteria"]))
                for item in criteria.values():
                    self.assertIn(item["stage"], stages)
                    self.assertIn(item["severity"], {"quality", "critical"})
                    self.assertIsInstance(item["requirement"], str)
                    self.assertTrue(item["requirement"].strip())
                    self.assertTrue(item["evidenceRefs"])
                    self.assertLessEqual(set(item["evidenceRefs"]), set(annotation["evidenceRefs"]))
                for collection, text_key, refs_key in (
                    ("acceptableAlternatives", "description", "preserves"),
                    ("wrongControls", "response", "rejectedBy"),
                ):
                    items = annotation[collection]
                    self.assertGreaterEqual(len(items), 2)
                    self.assertEqual(len({item["id"] for item in items}), len(items))
                    for item in items:
                        self.assertIsInstance(item[text_key], str)
                        self.assertTrue(item[text_key].strip())
                        self.assertTrue(item[refs_key])
                        self.assertLessEqual(set(item[refs_key]), set(criteria))
                        if "stage" in item:
                            self.assertIn(item["stage"], stages)
                            for criterion_id in item[refs_key]:
                                self.assertEqual(criteria[criterion_id]["stage"], item["stage"])

    def test_checkpoint_input_has_retrievable_same_branch_references(self):
        case_id = "stale-origin"
        checkpoint = read_json(self.worker_file(case_id, "worker/checkpoint.json"))
        observations = read_json(self.worker_file(case_id, "worker/observations.json"))
        self.assertEqual(checkpoint["schema"], "lunacy-research-checkpoint-v1")
        self.assertEqual(checkpoint["basis_revision"], observations["current_basis_revision"])
        branches = set(checkpoint["branches"])
        self.assertEqual(len(branches), len(checkpoint["branches"]))
        evidence = {item["id"]: item for item in checkpoint["evidence"]}
        self.assertEqual(len(evidence), len(checkpoint["evidence"]))
        self.assertEqual(len({item["id"] for item in checkpoint["checks"]}), len(checkpoint["checks"]))
        for item in [*checkpoint["evidence"], *checkpoint["checks"]]:
            self.assertIn(item["branch"], branches)
            filename, pointer = item["receipt"].split("#", 1)
            path = self.worker_file(case_id, "worker/" + filename)
            self.pointer_value(read_json(path), pointer)
        for check in checkpoint["checks"]:
            self.assertEqual(len(set(check["evidence_ids"])), len(check["evidence_ids"]))
            for evidence_id in check["evidence_ids"]:
                self.assertIn(evidence_id, evidence)
                self.assertEqual(evidence[evidence_id]["branch"], check["branch"])


if __name__ == "__main__":
    unittest.main()
