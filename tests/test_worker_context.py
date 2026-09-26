"""Maintenance ceiling for the worker guide actually returned by the read helper."""

import json
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]


class WorkerContextTests(unittest.TestCase):
    def test_worker_guide_read_stays_within_maintenance_ceiling(self):
        result = subprocess.run(
            [sys.executable, "-B", str(ROOT / "scripts/context_excerpt.py"),
             "action-excerpt", "--root", str(ROOT), "--layout", "source",
             "--source-relative", "SKILL.md", "--trigger",
             "Worker implementation/report"],
            capture_output=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        receipt = json.loads(result.stdout)
        guide = next(item for item in receipt["destinations"]
                     if item["logical_path"] == "worker/ENGINEERING.md")
        guide_bytes = guide["text"].encode("utf-8")
        self.assertEqual(guide_bytes, (ROOT / "worker/ENGINEERING.md").read_bytes())
        self.assertEqual(guide["bytes"], len(guide_bytes))
        # This is a maintenance ceiling, not a host context or token limit.
        self.assertLessEqual(
            len(guide_bytes), 9500,
            "Reassess the worker read boundary before changing this ceiling.",
        )


if __name__ == "__main__":
    unittest.main()
