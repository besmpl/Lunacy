import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "evidence_index.py"


class DirectExecIndexTests(unittest.TestCase):
    def run_index(self, records=None, *, raw=None, extra=(), thread="thread-1", mode=0o644):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "events.jsonl"
            if raw is None:
                raw = b"".join(
                    (json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
                    for record in records
                )
            source.write_bytes(raw)
            source.chmod(mode)
            before = (source.read_bytes(), source.stat().st_mode)
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), str(source),
                 "--source-format", "direct-exec", "--thread-id", thread, *extra],
                cwd=ROOT, capture_output=True, timeout=10,
            )
            after = (source.read_bytes(), source.stat().st_mode)
            return result, source, before, after

    @staticmethod
    def base(*middle, end="turn.completed"):
        records = [{"type": "thread.started", "thread_id": "thread-1"}, {"type": "turn.started"}]
        records.extend(middle)
        if end is not None:
            records.append({"type": end})
        return records

    @staticmethod
    def command(event, item_id="cmd-1", status="completed", *, exit_marker="missing", **hidden):
        item = {"type": "command_execution", "id": item_id, "status": status, **hidden}
        if exit_marker != "missing":
            item["exit_code"] = exit_marker
        return {"type": event, "item": item}

    def assert_refused(self, result):
        self.assertEqual(result.returncode, 2, result)
        self.assertEqual(result.stdout, b"")
        self.assertLessEqual(len(result.stderr), 512)
        result.stderr.decode("utf-8")

    def test_success_preserves_literal_observations_hash_and_read_only_source(self):
        observations = [
            self.command("item.started", status="in_progress", command="SECRET", cwd="SECRET", exit_marker=None),
            self.command("item.updated", status="odd-status", output="SECRET", exit_marker=-2),
            self.command("item.completed", status="completed", exit_marker=7, command="DIFFERENT-SECRET"),
            self.command("item.completed", status="completed", exit_marker=7),
            self.command("item.completed", item_id="cmd-2", status="failed", exit_marker=0),
        ]
        result, source, before, after = self.run_index(self.base(*observations), mode=0o444)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(before, after)
        projected = json.loads(result.stdout)
        self.assertEqual(projected["schema"], "lunacy-native-direct-exec-index-v1")
        self.assertEqual(projected["source"], {"path": str(source), "sha256": hashlib.sha256(before[0]).hexdigest()})
        self.assertNotIn("turn_id", projected["scope"])
        self.assertEqual(projected["thread_header_line"], 1)
        self.assertEqual(projected["turn"], {"start_line": 2, "end_line": 8, "end_event": "turn.completed"})
        self.assertEqual(projected["observed_command_count"], 2)
        self.assertEqual(projected["observed_command_record_count"], 5)
        first = projected["commands"][0]
        self.assertEqual(first["item_id"], "cmd-1")
        self.assertEqual([entry["line"] for entry in first["observations"]], [3, 4, 5, 6])
        self.assertEqual(set(first["observations"][0]), {"line", "event", "native_status", "exit_code_present", "exit_code"})
        self.assertEqual(first["observations"][0]["exit_code"], None)
        self.assertTrue(first["observations"][0]["exit_code_present"])
        self.assertNotIn(b"SECRET", result.stdout)

    def test_started_only_failed_and_zero_command_shapes(self):
        for records, expected_end, count in (
            (self.base(self.command("item.started", status="in_progress"), end=None), (None, None), 1),
            (self.base(self.command("item.completed", status="failed", exit_marker=1), end="turn.failed"), (4, "turn.failed"), 1),
            (self.base(end="turn.completed"), (3, "turn.completed"), 0),
        ):
            with self.subTest(expected_end=expected_end, count=count):
                result, _, _, _ = self.run_index(records)
                self.assertEqual(result.returncode, 0, result.stderr)
                value = json.loads(result.stdout)
                self.assertEqual((value["turn"]["end_line"], value["turn"]["end_event"]), expected_end)
                self.assertEqual(value["observed_command_count"], count)

    def test_scope_and_header_ambiguities_refuse(self):
        cases = [
            [],
            [{"type": "turn.started"}],
            [{"type": "thread.started", "thread_id": "wrong"}, {"type": "turn.started"}],
            [{"type": "thread.started", "thread_id": "thread-1"}, {"type": "thread.started", "thread_id": "thread-1"}, {"type": "turn.started"}],
            [{"type": "thread.started", "thread_id": "thread-1"}],
            self.base({"type": "turn.started"}),
            [{"type": "thread.started", "thread_id": "thread-1"}, {"type": "turn.completed"}, {"type": "turn.started"}],
            self.base({"type": "turn.completed"}),
            self.base(end="turn.completed") + [{"type": "turn.failed"}],
            self.base({"type": "error", "thread_id": "foreign", "message": "SECRET"}),
            self.base({"type": "error", "turn_id": None}),
        ]
        for index, records in enumerate(cases):
            with self.subTest(index=index):
                result, _, _, _ = self.run_index(records)
                self.assert_refused(result)

    def test_commands_outside_turn_refuse_but_noncommands_are_counted_anywhere(self):
        command = self.command("item.completed", exit_marker=0)
        for records in (
            [{"type": "thread.started", "thread_id": "thread-1"}, command, {"type": "turn.started"}],
            self.base(end="turn.completed") + [command],
        ):
            result, _, _, _ = self.run_index(records)
            self.assert_refused(result)
        other = {"type": "item.updated", "item": {"type": "message", "text": "SECRET"}}
        records = [{"type": "thread.started", "thread_id": "thread-1"}, other, {"type": "turn.started"}, {"type": "error", "message": "SECRET"}, {"type": "turn.completed"}, other]
        result, _, _, _ = self.run_index(records)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["ignored_noncommand_record_count"], 3)
        self.assertNotIn(b"SECRET", result.stdout)

    def test_command_field_boundaries(self):
        accepted = [
            self.command("item.completed", item_id="missing", status="arbitrary"),
            self.command("item.completed", item_id="null", exit_marker=None),
            self.command("item.completed", item_id="negative", exit_marker=-1),
            self.command("item.completed", item_id="zero", exit_marker=0),
            self.command("item.completed", item_id="nonzero", exit_marker=9),
        ]
        result, _, _, _ = self.run_index(self.base(*accepted))
        self.assertEqual(result.returncode, 0, result.stderr)
        observations = [command["observations"][0] for command in json.loads(result.stdout)["commands"]]
        self.assertEqual([(entry["exit_code_present"], entry["exit_code"]) for entry in observations], [(False, None), (True, None), (True, -1), (True, 0), (True, 9)])
        bad_items = [
            {"type": "command_execution", "status": "x"},
            {"type": "command_execution", "id": "", "status": "x"},
            {"type": "command_execution", "id": 2, "status": "x"},
            {"type": "command_execution", "id": "x", "status": ""},
            {"type": "command_execution", "id": "x", "status": 2},
            {"type": "command_execution", "id": "x" * 4097, "status": "x"},
            {"type": "command_execution", "id": "x", "status": "x" * 4097},
            *({"type": "command_execution", "id": "x", "status": "x", "exit_code": value} for value in (True, 1.5, {}, [])),
        ]
        for index, item in enumerate(bad_items):
            with self.subTest(index=index):
                result, _, _, _ = self.run_index(self.base({"type": "item.completed", "item": item}))
                self.assert_refused(result)

    def test_filters_keep_all_occurrences_and_validate_entire_file(self):
        records = self.base(
            self.command("item.completed", item_id="b", exit_marker=0),
            self.command("item.started", item_id="a", status="x"),
            self.command("item.updated", item_id="b", status="y", exit_marker=None),
        )
        result, _, _, _ = self.run_index(records, extra=("--item-id", "b"))
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["scope"]["selected_item_ids"], ["b"])
        self.assertEqual(value["observed_command_count"], 1)
        self.assertEqual(value["observed_command_record_count"], 2)
        self.assertEqual(value["ignored_noncommand_record_count"], 0)
        for extra in (("--item-id", "missing"), ("--item-id", "b", "--item-id", "b")):
            refused, _, _, _ = self.run_index(records, extra=extra)
            self.assert_refused(refused)
        malformed = self.base(self.command("item.completed", item_id="b", exit_marker=0), {"type": "item.started", "item": {"type": "command_execution", "id": "bad", "status": "x", "exit_code": True}})
        refused, _, _, _ = self.run_index(malformed, extra=("--item-id", "b"))
        self.assert_refused(refused)

    def test_private_or_unknown_content_never_leaks_in_diagnostics(self):
        canary = "PRIVATE-CANARY-741"
        raw_cases = [
            ('{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started","%s":1,"%s":2}\n' % (canary, canary)).encode(),
            (json.dumps({"type": canary, "command": canary, "output": canary}) + "\n").encode(),
            b'{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n{"type":"item.started","item":{"type":"command_execution","id":"x","status":"x","exit_code":1e999999999999999999999999}}\n',
        ]
        for raw in raw_cases:
            result, _, _, _ = self.run_index(raw=raw)
            self.assert_refused(result)
            self.assertNotIn(canary.encode(), result.stderr)
            self.assertNotIn(canary.encode(), result.stdout)

    def test_malformed_json_utf8_trailing_line_and_envelope_refuse(self):
        header = b'{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n'
        raws = [
            b"{\n", b'{}', b'\xff\n', b'\n',
            header + b'{"type":"error","private_number":' + b"9" * 5000 + b'}\n',
            header + b'{"type":"error","private_nesting":' + b"[" * 2000 + b"0" + b"]" * 2000 + b'}\n',
        ]
        for raw in raws:
            result, _, _, _ = self.run_index(raw=raw)
            self.assert_refused(result)
        malformed_records = [
            [{"type": "thread.started", "thread_id": "thread-1"}, {"type": "turn.started"}, {"type": "item.started"}],
            [{"type": "thread.started", "thread_id": "thread-1"}, {"type": "turn.started"}, {"type": "item.started", "item": {}}],
            [{"type": "thread.started", "thread_id": "thread-1"}, {"type": "turn.started"}, {"type": 3}],
        ]
        for records in malformed_records:
            result, _, _, _ = self.run_index(records)
            self.assert_refused(result)

    def test_depth_boundary_and_wide_ignored_array(self):
        header = b'{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n'
        prefix = header + b'{"type":"error","private_nesting":'
        accepted, _, _, _ = self.run_index(
            raw=prefix + b"[" * 511 + b"0" + b"]" * 511 + b'}\n'
        )
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(json.loads(accepted.stdout)["ignored_noncommand_record_count"], 1)

        refused, _, _, _ = self.run_index(
            raw=prefix + b"[" * 512 + b"0" + b"]" * 512 + b'}\n'
        )
        self.assert_refused(refused)

        wide, _, _, _ = self.run_index(
            raw=header + b'{"type":"error","private_wide":[' + b",".join([b"0"] * 100_000) + b']}\n'
        )
        self.assertEqual(wide.returncode, 0, wide.stderr)
        value = json.loads(wide.stdout)
        self.assertEqual(value["ignored_noncommand_record_count"], 1)
        self.assertNotIn(b"private_wide", wide.stdout)

    def test_argument_digest_and_output_caps(self):
        records = self.base(self.command("item.completed", item_id="x" * 300, status="y" * 300, exit_marker=0))
        for extra in (
            ("--turn-id", ""), ("--turn-id", "turn-1"), ("--session-id", "session-1"),
            ("--expected-sha256", "0" * 64),
        ):
            result, _, _, _ = self.run_index(records, extra=extra)
            self.assert_refused(result)
        result, _, _, _ = self.run_index(records, extra=("--output-cap", "256"))
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(json.loads(result.stdout)["error"], "output_cap_exceeded")

    def test_input_cap_refuses_without_reading(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "large.jsonl"
            with source.open("wb") as stream:
                stream.truncate(64 * 1024 * 1024 + 1)
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), str(source), "--source-format", "direct-exec", "--thread-id", "thread-1"],
                cwd=ROOT, capture_output=True, timeout=10,
            )
        self.assert_refused(result)


if __name__ == "__main__":
    unittest.main()
