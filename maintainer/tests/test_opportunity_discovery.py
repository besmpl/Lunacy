"""Shape checks for manual planning packets, not model behavior."""

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
PACK = ROOT / "maintainer/evaluation/fixtures/opportunity-discovery"


class OpportunityDiscoveryPacketTests(unittest.TestCase):
    def test_unsplit_packets_have_separate_provisional_annotations(self):
        expected = {"broad", "mixed", "coupled", "shared-effect", "valid-zero"}
        self.assertEqual({p.name for p in PACK.iterdir() if p.is_dir()}, expected)
        for case_id in expected:
            with self.subTest(case=case_id):
                case = PACK / case_id
                packet = (case / "worker/packet.md").read_text(encoding="utf-8")
                annotation = json.loads((case / "evaluator/annotations.json").read_text(encoding="utf-8"))
                self.assertEqual(annotation["caseId"], case_id)
                self.assertEqual(annotation["status"], "provisional-synthetic")
                self.assertIn("No assignment", packet)
                self.assertIn("Source snapshot:", packet)
                self.assertFalse((case / "worker/annotations.json").exists())
                useful = annotation["usefulFamilies"]
                ready = annotation["firstWave"]
                deferred = annotation["deferred"]
                self.assertEqual(len(useful), len(set(useful)))
                self.assertLessEqual(set(ready), set(useful))
                self.assertLessEqual({item["family"] for item in deferred}, set(useful))
                self.assertFalse(set(ready) & {item["family"] for item in deferred})
                self.assertTrue(all(item["trigger"] for item in deferred))
                self.assertTrue(annotation["forbidden"])
                self.assertTrue(annotation["acceptanceProof"])

    def test_controls_do_not_reward_width_or_reopen_accepted_work(self):
        def annotation(case_id):
            return json.loads((PACK / case_id / "evaluator/annotations.json").read_text())

        self.assertGreaterEqual(len(annotation("broad")["firstWave"]), 3)
        self.assertEqual(len(annotation("mixed")["firstWave"]), 1)
        self.assertEqual(len(annotation("coupled")["firstWave"]), 1)
        self.assertEqual(len(annotation("shared-effect")["firstWave"]), 1)
        zero = annotation("valid-zero")
        self.assertFalse(zero["usefulFamilies"] or zero["firstWave"] or zero["deferred"])

    def test_recipe_separates_discovery_from_supplied_queue_and_live_claims(self):
        recipe = (PACK / "README.md").read_text(encoding="utf-8")
        for phrase in (
            "pre-change coherent-owner policy", "supplied-ready graph diagnostic",
            "must not", "Folder separation alone is not access control",
            "independent reviewer", "hard stop", "whole-outcome parent acceptance",
            "No run, provider request, host-capacity probe or plugin installation",
        ):
            self.assertIn(phrase, recipe)
        self.assertTrue((PACK / "../../manifest-template.json").is_file())


if __name__ == "__main__":
    unittest.main()
