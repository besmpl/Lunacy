"""Checks for the optional native launch-wave trace diagnostic."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "dispatch_trace.py"


def call(name: str, arguments: dict) -> str:
    return json.dumps({
        "timestamp": "2026-09-23T09:44:26.253Z",
        "type": "response_item",
        "payload": {"type": "function_call", "name": name,
                    "arguments": json.dumps(arguments)},
    })


def custom_call(name: str, input_text: str = "/* inert test input */") -> str:
    return json.dumps({
        "type": "response_item",
        "payload": {"type": "custom_tool_call", "name": name,
                    "input": input_text},
    })


class DispatchTraceTests(unittest.TestCase):
    def check_trace(self, rows: list[str], names: list[str]):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rollout.jsonl"
            source.write_text("\n".join(rows) + "\n", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), "--session", str(source),
                 "--ready-names", *names],
                capture_output=True, text=True, check=False,
            )
        return result, json.loads(result.stdout)

    def test_complete_wave_is_green_even_when_spawns_are_serial(self):
        rows = [call("spawn_agent", {"task_name": name})
                for name in ("b1", "b2", "b3")]
        rows.append(call("wait_agent", {"timeout_ms": 300000}))
        result, report = self.check_trace(rows, ["b1", "b2", "b3"])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report["verdict"], "complete-wave")
        self.assertEqual(report["launched_before_first_wait"], 3)

    def test_wait_before_ready_wave_is_red(self):
        rows = [call("spawn_agent", {"task_name": "b1"}),
                call("wait_agent", {"timeout_ms": 300000}),
                call("spawn_agent", {"task_name": "b2"})]
        result, report = self.check_trace(rows, ["b1", "b2"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["verdict"], "premature-wait")
        self.assertEqual(report["unlaunched_at_wait"], ["b2"])

    def test_unrelated_tool_call_between_launches_is_red(self):
        rows = [call("spawn_agent", {"task_name": "b1"}),
                call("exec_command", {"cmd": "echo status"}),
                call("spawn_agent", {"task_name": "b2"})]
        result, report = self.check_trace(rows, ["b1", "b2"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["verdict"], "interleaved-call")
        self.assertEqual(report["interleaved_calls"], ["exec_command"])

    def test_custom_call_between_launches_before_wait_is_red(self):
        rows = [call("agents.spawn_agent", {"task_name": "b1"}),
                custom_call("exec"),
                call("agents.spawn_agent", {"task_name": "b2"}),
                call("agents.wait_agent", {})]
        result, report = self.check_trace(rows, ["b1", "b2"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["verdict"], "interleaved-call")
        self.assertEqual(report["interleaved_calls"], ["exec"])

    def test_custom_call_interleave_preserves_namespace_and_wait_semantics(self):
        for name, observed_wait in (
            ("exec", False),
            ("functions.exec", False),
            ("functions.exec", True),
            ("outer.functions.exec", False),
            ("outer.functions.exec", True),
        ):
            with self.subTest(name=name, observed_wait=observed_wait):
                rows = [call("spawn_agent", {"task_name": "b1"}),
                        custom_call(name),
                        call("spawn_agent", {"task_name": "b2"})]
                if observed_wait:
                    rows.append(call("wait_agent", {}))
                result, report = self.check_trace(rows, ["b1", "b2"])
                self.assertEqual(result.returncode, 1)
                self.assertEqual(report["verdict"], "interleaved-call")
                self.assertEqual(report["launched_before_first_wait"], 2)
                self.assertEqual(report["missing_names"], [])
                self.assertEqual(report["interleaved_calls"], ["exec"])

    def test_custom_coordination_before_wave_is_allowed(self):
        rows = [custom_call("functions.exec"),
                call("spawn_agent", {"task_name": "b1"}),
                call("spawn_agent", {"task_name": "b2"}),
                call("wait_agent", {})]
        result, report = self.check_trace(rows, ["b1", "b2"])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report["verdict"], "complete-wave")
        self.assertEqual(report["interleaved_calls"], [])

    def test_custom_coordination_after_wave_preserves_wait_requirement(self):
        for observed_wait in (False, True):
            with self.subTest(observed_wait=observed_wait):
                rows = [call("spawn_agent", {"task_name": "b1"}),
                        call("spawn_agent", {"task_name": "b2"}),
                        custom_call("functions.exec")]
                if observed_wait:
                    rows.append(call("wait_agent", {}))
                result, report = self.check_trace(rows, ["b1", "b2"])
                self.assertEqual(result.returncode, 0 if observed_wait else 1)
                self.assertEqual(report["verdict"],
                                 "complete-wave" if observed_wait else "missing-wait")
                self.assertEqual(report["interleaved_calls"], [])

    def test_custom_input_does_not_fabricate_nested_launches(self):
        for input_text in (
            '{"task_name": "b1"}',
            'await tools.agents__spawn_agent({task_name: "b1"});',
            "arbitrary non-JSON {",
        ):
            with self.subTest(input_text=input_text):
                rows = [custom_call("exec", input_text), call("wait_agent", {})]
                result, report = self.check_trace(rows, ["b1"])
                self.assertEqual(result.returncode, 1)
                self.assertEqual(report["verdict"], "missing-launch")
                self.assertEqual(report["launched_before_first_wait"], 0)
                self.assertEqual(report["missing_names"], ["b1"])

    def test_custom_wait_uses_existing_wave_ordering(self):
        for name in ("wait_agent", "agents.wait_agent", "outer.agents.wait_agent"):
            for complete_wave in (False, True):
                with self.subTest(name=name, complete_wave=complete_wave):
                    rows = [call("spawn_agent", {"task_name": "b1"})]
                    if complete_wave:
                        rows.append(call("spawn_agent", {"task_name": "b2"}))
                    rows.append(custom_call(name, "opaque, not JSON"))
                    if not complete_wave:
                        rows.append(call("spawn_agent", {"task_name": "b2"}))
                    result, report = self.check_trace(rows, ["b1", "b2"])
                    self.assertEqual(result.returncode, 0 if complete_wave else 1)
                    self.assertEqual(report["verdict"],
                                     "complete-wave" if complete_wave else "premature-wait")
                    self.assertEqual(report["launched_before_first_wait"],
                                     2 if complete_wave else 1)
                    self.assertEqual(report["unlaunched_at_wait"],
                                     [] if complete_wave else ["b2"])

    def test_custom_wait_preserves_prior_interleave(self):
        rows = [call("spawn_agent", {"task_name": "b1"}),
                custom_call("functions.exec"),
                call("spawn_agent", {"task_name": "b2"}),
                custom_call("agents.wait_agent")]
        result, report = self.check_trace(rows, ["b1", "b2"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["verdict"], "interleaved-call")
        self.assertEqual(report["interleaved_calls"], ["exec"])

    def test_custom_wait_before_first_selected_launch_is_ignored(self):
        rows = [custom_call("agents.wait_agent"),
                call("spawn_agent", {"task_name": "b1"}),
                call("wait_agent", {})]
        result, report = self.check_trace(rows, ["b1"])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report["verdict"], "complete-wave")
        self.assertEqual(report["interleaved_calls"], [])

    def test_custom_spawn_encoding_is_refused_not_inferred(self):
        bodies = (
            {"input": '{"task_name": "b1"}'},
            {"input": "opaque custom input",
             "arguments": '{"task_name": "b1"}'},
            {"arguments": '{"task_name": "b1"}'},
        )
        for name in ("spawn_agent", "agents.spawn_agent", "outer.agents.spawn_agent"):
            for body in bodies:
                with self.subTest(name=name, body=body):
                    row = json.dumps({
                        "type": "response_item",
                        "payload": {"type": "custom_tool_call", "name": name, **body},
                    })
                    result, _ = self.check_trace_error([row, call("wait_agent", {})], ["b1"])
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("dispatch trace failed:", result.stderr)
                    self.assertNotIn("Traceback", result.stderr)

    def test_output_and_other_non_call_records_are_ignored(self):
        for row_type, payload in (
            ("response_item", {"type": "function_call_output", "name": "agents.wait_agent",
                               "output": "wait-shaped output is not an observed wait"}),
            ("response_item", {"type": "custom_tool_call_output", "name": "functions.exec",
                               "output": "custom call result"}),
            ("response_item", {"type": "custom_tool_call_output", "name": ["spawn_agent"]}),
            ("response_item", {"type": "message", "name": "spawn_agent"}),
            ("response_item", {"type": "unknown_record", "name": "wait_agent"}),
            ("event_msg", {"type": "custom_tool_call", "name": "wait_agent"}),
        ):
            with self.subTest(row_type=row_type, payload=payload):
                rows = [call("spawn_agent", {"task_name": "b1"}),
                        json.dumps({"type": row_type, "payload": payload}),
                        call("spawn_agent", {"task_name": "b2"}),
                        call("wait_agent", {})]
                result, report = self.check_trace(rows, ["b1", "b2"])
                self.assertEqual(result.returncode, 0)
                self.assertEqual(report["verdict"], "complete-wave")
                self.assertEqual(report["interleaved_calls"], [])

    def test_post_wave_coordination_before_wait_is_allowed(self):
        rows = [call("spawn_agent", {"task_name": "b1"}),
                call("spawn_agent", {"task_name": "b2"}),
                call("exec_command", {"cmd": "record returned handles in TASK"}),
                call("wait_agent", {"timeout_ms": 300000})]
        result, report = self.check_trace(rows, ["b1", "b2"])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report["verdict"], "complete-wave")
        self.assertEqual(report["interleaved_calls"], [])

    def test_post_wave_coordination_without_observed_wait_is_incomplete(self):
        rows = [call("spawn_agent", {"task_name": "b1"}),
                call("spawn_agent", {"task_name": "b2"}),
                call("exec_command", {"cmd": "record returned handles in TASK"})]
        result, report = self.check_trace(rows, ["b1", "b2"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["verdict"], "missing-wait")
        self.assertEqual(report["interleaved_calls"], [])

    def test_cap_sized_wave_and_event_refill_are_ordering_diagnostics(self):
        # Assume five complete packets exist but only two slots are ready for
        # this wave. The trace checker accepts caller-supplied readiness; it
        # does not prove packet preparation, cap arithmetic, the event, or
        # worker concurrency.
        prepared = ["b1", "b2", "b3", "b4", "b5"]
        cap_wave = prepared[:2]
        first = [call("spawn_agent", {"task_name": name}) for name in cap_wave]
        first.extend([
            call("exec_command", {"cmd": "record b1 and b2 handles"}),
            call("wait_agent", {"timeout_ms": 300000}),
        ])
        result, report = self.check_trace(first, cap_wave)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report["ready_names"], cap_wave)
        self.assertEqual(report["launched_before_first_wait"], 2)

        event = json.dumps({
            "type": "observed_event",
            "payload": {"message": "b1 settled; b2 remains live; one slot is open"},
        })
        refill = [event, call("spawn_agent", {"task_name": "b3"}),
                  call("exec_command", {"cmd": "record b3 handle"}),
                  call("wait_agent", {"timeout_ms": 300000})]
        result, report = self.check_trace(refill, ["b3"])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report["verdict"], "complete-wave")
        self.assertEqual(report["launched_before_first_wait"], 1)
        self.assertLess(refill.index(event), refill.index(call("spawn_agent", {"task_name": "b3"})))
        self.assertIn("Caller-supplied readiness and available capacity are not proven by this trace.",
                      report["non_claims"])
        self.assertIn("Serial launch calls may overlap; this tool does not measure worker concurrency.",
                      report["non_claims"])

    def test_missing_spawn_is_red_not_assumed_complete(self):
        result, report = self.check_trace(
            [call("spawn_agent", {"task_name": "b1"})], ["b1", "b2"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["verdict"], "missing-launch")

    def test_all_launches_without_observed_wait_are_incomplete(self):
        rows = [call("spawn_agent", {"task_name": name}) for name in ("b1", "b2")]
        result, report = self.check_trace(rows, ["b1", "b2"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["verdict"], "missing-wait")

    def test_malformed_input_is_not_false_green(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rollout.jsonl"
            source.write_text("{not-json}\n", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), "--session", str(source),
                 "--ready-names", "b1"],
                capture_output=True, text=True, check=False,
            )
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid JSONL", result.stderr)

    def test_malformed_tool_fields_are_refused_without_traceback(self):
        for row in (
            json.dumps({"type": "response_item", "payload": {
                "type": "function_call", "name": ["spawn_agent"],
                "arguments": json.dumps({"task_name": "b1"})}}),
            call("spawn_agent", {"task_name": ["b1"]}),
        ):
            with self.subTest(row=row):
                result, _ = self.check_trace_error([row], ["b1"])
                self.assertEqual(result.returncode, 2)
                self.assertNotIn("Traceback", result.stderr)

    def test_malformed_custom_names_are_refused_without_traceback(self):
        for fields in ({}, {"name": ""}, {"name": None}, {"name": ["exec"]},
                       {"name": {}}, {"name": 7}, {"name": True}):
            with self.subTest(fields=fields):
                row = json.dumps({
                    "type": "response_item",
                    "payload": {"type": "custom_tool_call", "input": "opaque", **fields},
                })
                rows = [row, call("spawn_agent", {"task_name": "b1"}),
                        call("wait_agent", {})]
                result, _ = self.check_trace_error(rows, ["b1"])
                self.assertEqual(result.returncode, 2)
                self.assertIn("name", result.stderr)
                self.assertNotIn("Traceback", result.stderr)

    def check_trace_error(self, rows: list[str], names: list[str]):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rollout.jsonl"
            source.write_text("\n".join(rows) + "\n", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), "--session", str(source),
                 "--ready-names", *names],
                capture_output=True, text=True, check=False,
            )
        return result, result.stderr
