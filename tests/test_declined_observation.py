#!/usr/bin/env python3
"""Public-CLI coverage for the explicit declined/null observation."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/evidence_index.py"
MISSING = object()


def event(method, *, item="item", status=None, exit_code=MISSING, thread="thread", turn="turn", direction="receive"):
    if status is None:
        status = "inProgress" if method == "item/started" else "completed"
    command = {"type": "commandExecution", "id": item, "status": status,
               "command": "printf PASS", "cwd": "/tmp", "processId": "42",
               "aggregatedOutput": "PASS\n"}
    if exit_code is not MISSING:
        command["exitCode"] = exit_code
    return {"direction": direction, "message": {"method": method, "params": {
        "threadId": thread, "turnId": turn, "item": command}}}


class DeclinedObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, records, *extra):
        source = self.root / "capture with spaces.jsonl"
        source.write_text("".join(json.dumps(row) + "\n" for row in records))
        result = subprocess.run([os.fspath(SCRIPT), os.fspath(source), "--thread-id", "thread",
                                 "--turn-id", "turn", *extra], text=True, capture_output=True,
                                timeout=5, check=False)
        return result, source

    def test_explicit_declined_null_is_observed_with_exact_locator(self):
        result, source = self.run_cli([
            event("item/started", exit_code=None),
            event("item/completed", status="declined", exit_code=None),
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["source"]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertEqual(value["commands"], [{"item_id": "item", "start_line": 1, "terminal_line": 2,
                                               "native_status": "declined", "exit_code": None,
                                               "classification": "observed_declined"}])

    def test_declined_requires_present_null_exit_code(self):
        cases = [
            (MISSING, "explicit null exitCode"), (0, "null exitCode"), (4, "null exitCode"),
            (False, "null exitCode"), ("0", "null exitCode"),
        ]
        for exit_code, phrase in cases:
            with self.subTest(exit_code=exit_code):
                result, _ = self.run_cli([
                    event("item/started", exit_code=None),
                    event("item/completed", status="declined", exit_code=exit_code),
                ])
                self.assertEqual(result.returncode, 2)
                self.assertIn(phrase, result.stderr)

    def test_completed_failed_absent_or_null_keep_incomplete_behavior(self):
        for status in ("completed", "failed"):
            for exit_code in (MISSING, None):
                with self.subTest(status=status, exit_code=exit_code):
                    result, _ = self.run_cli([
                        event("item/started", exit_code=None),
                        event("item/completed", status=status, exit_code=exit_code),
                    ])
                    self.assertEqual(result.returncode, 0, result.stderr)
                    command = json.loads(result.stdout)["commands"][0]
                    self.assertEqual(command["classification"], "incomplete_evidence")
                    self.assertEqual(command["native_status"], status)

    def test_unknown_status_and_declined_contradiction_refuse(self):
        unknown, _ = self.run_cli([event("item/started", exit_code=None),
                                   event("item/completed", status="future", exit_code=None)])
        self.assertEqual(unknown.returncode, 2)
        self.assertIn("terminal status", unknown.stderr)
        terminal = event("item/completed", status="declined", exit_code=None)
        changed = event("item/completed", status="declined", exit_code=None)
        changed["message"]["params"]["item"]["command"] = "other"
        contradiction, _ = self.run_cli([event("item/started", exit_code=None), terminal, changed])
        self.assertEqual(contradiction.returncode, 2)
        self.assertIn("contradictory duplicate", contradiction.stderr)

    def test_missing_terminal_selection_caps_and_cross_identity_remain(self):
        pending, _ = self.run_cli([event("item/started", item="pending", exit_code=None)])
        self.assertEqual(json.loads(pending.stdout)["commands"][0]["classification"], "missing_terminal")
        records = []
        for number in range(30):
            records += [event("item/started", item=f"d-{number}", exit_code=None),
                        event("item/completed", item=f"d-{number}", status="declined", exit_code=None)]
        selected, _ = self.run_cli(records, "--item-id", "d-7")
        self.assertEqual([c["item_id"] for c in json.loads(selected.stdout)["commands"]], ["d-7"])
        capped, _ = self.run_cli(records, "--output-cap", "512")
        self.assertEqual(capped.returncode, 3)
        cross, _ = self.run_cli([event("item/started", exit_code=None),
                                 event("item/completed", status="declined", exit_code=None, turn="other")])
        self.assertEqual(json.loads(cross.stdout)["commands"][0]["classification"], "missing_terminal")


if __name__ == "__main__":
    unittest.main()
