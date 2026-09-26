import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "evidence_index.py"


class DirectExecIndexTests(unittest.TestCase):
    @staticmethod
    def encode(records):
        return b"".join(
            (json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
            for record in records
        )

    @staticmethod
    def run_source(source, *extra, thread="thread-1"):
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), str(source),
             "--source-format", "direct-exec", "--thread-id", thread, *extra],
            cwd=ROOT, capture_output=True, timeout=15,
        )

    def run_index(self, records=None, *, raw=None, extra=(), thread="thread-1", mode=0o644):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "events.jsonl"
            if raw is None:
                raw = self.encode(records)
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
        for index, raw in enumerate(raw_cases):
            result, _, _, _ = self.run_index(raw=raw)
            self.assert_refused(result)
            self.assertNotIn(canary.encode(), result.stderr)
            self.assertNotIn(canary.encode(), result.stdout)
            if index == 0:
                self.assertEqual(
                    result.stderr,
                    b"evidence-index: line 2: invalid direct-exec JSON record\n",
                )

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

    def test_correlation_uses_first_observation_group_order_and_retrieves_exact_group(self):
        records = self.base(
            self.command("item.started", item_id="A", status="in_progress", exit_marker=None),
            self.command("item.completed", item_id="B", status="failed", exit_marker=3),
            self.command("item.updated", item_id="A", status="running", exit_marker=0),
            self.command("item.completed", item_id="A", status="failed", exit_marker=7),
            self.command("item.completed", item_id="A", status="failed", exit_marker=-2),
        )
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "events.jsonl"
            source.write_bytes(self.encode(records))
            correlated = self.run_source(source, "--correlate", "first-nonzero")
            self.assertEqual(correlated.returncode, 0, correlated.stderr)
            value = json.loads(correlated.stdout)
            self.assertEqual(value["schema"], "lunacy-native-direct-exec-correlation-v1")
            self.assertEqual(value["correlation"], {
                "kind": "first-nonzero-group", "after_ordinal": -1,
                "scanned_through_ordinal": 0, "matched": True, "complete": False,
                "next_after_ordinal": 0,
            })
            self.assertEqual(value["match"], {
                "ordinal": 0, "item_id": "A", "first_observation_line": 3,
                "observation_count": 4, "nonzero_observation_count": 2,
                "first_nonzero_observation_line": 6, "first_nonzero_exit_code": 7,
            })
            digest = value["source"]["sha256"]
            retrieved = self.run_source(
                source, "--item-id", "A", "--expected-sha256", digest,
                "--output-cap", "16384",
            )
            self.assertEqual(retrieved.returncode, 0, retrieved.stderr)
            command = json.loads(retrieved.stdout)["commands"][0]
            self.assertEqual(command["item_id"], value["match"]["item_id"])
            self.assertEqual([item["line"] for item in command["observations"]], [3, 5, 6, 7])

            continued = self.run_source(
                source, "--correlate", "first-nonzero", "--after-ordinal", "0",
                "--expected-sha256", digest,
            )
            self.assertEqual(continued.returncode, 0, continued.stderr)
            next_value = json.loads(continued.stdout)
            self.assertEqual(next_value["match"]["item_id"], "B")
            self.assertEqual(next_value["match"]["ordinal"], 1)

    def test_correlation_no_match_empty_and_exhausted(self):
        cases = (
            (self.base(), -1, None),
            (self.base(self.command("item.completed", item_id="zero", exit_marker=0)), 0, None),
        )
        for records, scanned, after in cases:
            with self.subTest(scanned=scanned):
                with tempfile.TemporaryDirectory() as directory:
                    source = Path(directory) / "events.jsonl"
                    source.write_bytes(self.encode(records))
                    first = self.run_source(source, "--correlate", "first-nonzero")
                    self.assertEqual(first.returncode, 0, first.stderr)
                    value = json.loads(first.stdout)
                    self.assertNotIn("match", value)
                    self.assertEqual(value["correlation"]["scanned_through_ordinal"], scanned)
                    self.assertEqual(value["correlation"]["matched"], False)
                    self.assertEqual(value["correlation"]["complete"], True)
                    self.assertIsNone(value["correlation"]["next_after_ordinal"])

                    digest = value["source"]["sha256"]
                    exhausted = self.run_source(
                        source, "--correlate", "first-nonzero", "--after-ordinal", "9999",
                        "--expected-sha256", digest,
                    )
                    self.assertEqual(exhausted.returncode, 0, exhausted.stderr)
                    self.assertEqual(
                        json.loads(exhausted.stdout)["correlation"]["scanned_through_ordinal"],
                        scanned,
                    )

    def test_correlation_argument_combinations_and_ordinal_bounds(self):
        records = self.base(self.command("item.completed", exit_marker=1))
        digest = hashlib.sha256(self.encode(records)).hexdigest()
        bad = (
            ("--correlate", "first-nonzero", "--item-id", "cmd-1"),
            ("--after-ordinal", "0"),
            ("--correlate", "first-nonzero", "--after-ordinal", "0"),
            ("--correlate", "first-nonzero", "--after-ordinal", "-1", "--expected-sha256", digest),
            ("--correlate", "first-nonzero", "--after-ordinal", "+1", "--expected-sha256", digest),
            ("--correlate", "first-nonzero", "--after-ordinal", " 1", "--expected-sha256", digest),
            ("--correlate", "first-nonzero", "--after-ordinal", "1", "--after-ordinal", "2", "--expected-sha256", digest),
            ("--correlate", "first-nonzero", "--after-ordinal", "9" * 4097, "--expected-sha256", digest),
            ("--correlate", "unknown"),
        )
        for extra in bad:
            with self.subTest(extra=extra[:4]):
                result, _, _, _ = self.run_index(records, extra=extra)
                self.assert_refused(result)
                self.assertLessEqual(len(result.stderr), 256)

        huge, _, _, _ = self.run_index(
            records,
            extra=("--correlate", "first-nonzero", "--after-ordinal", "9" * 4096,
                   "--expected-sha256", digest),
        )
        self.assertEqual(huge.returncode, 0, huge.stderr)
        self.assertFalse(json.loads(huge.stdout)["correlation"]["matched"])

        result, _, _, _ = self.run_index(records, extra=("--correlate", "first-nonzero", "--turn-id", "x"))
        self.assert_refused(result)

    def test_correlation_stricter_host_integer_limit_is_a_bounded_cli_refusal(self):
        records = self.base(self.command("item.completed", exit_marker=1))
        digest = hashlib.sha256(self.encode(records)).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "events.jsonl"
            source.write_bytes(self.encode(records))
            environment = os.environ.copy()
            environment["PYTHONINTMAXSTRDIGITS"] = "640"
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), str(source),
                 "--source-format", "direct-exec", "--thread-id", "thread-1",
                 "--correlate", "first-nonzero", "--after-ordinal", "9" * 700,
                 "--expected-sha256", digest],
                cwd=ROOT, capture_output=True, timeout=10, env=environment,
            )
        self.assert_refused(result)
        self.assertLessEqual(len(result.stderr), 256)
        self.assertIn(b"host integer conversion limit", result.stderr)
        self.assertNotIn(b"Traceback", result.stderr)

    def test_correlation_is_direct_exec_only(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "events.jsonl"
            source.write_bytes(b"not opened")
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), str(source), "--thread-id", "t",
                 "--turn-id", "u", "--correlate", "first-nonzero"],
                cwd=ROOT, capture_output=True, timeout=5,
            )
        self.assert_refused(result)

    def test_correlation_validates_late_records_and_binds_continuation_hash(self):
        good = self.base(self.command("item.completed", item_id="found", exit_marker=4))
        malformed = good + [{"type": "item.started", "item": {
            "type": "command_execution", "id": "late", "status": "x", "exit_code": True,
        }}]
        result, _, _, _ = self.run_index(malformed, extra=("--correlate", "first-nonzero"))
        self.assert_refused(result)

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "events.jsonl"
            source.write_bytes(self.encode(good))
            first = self.run_source(source, "--correlate", "first-nonzero")
            digest = json.loads(first.stdout)["source"]["sha256"]
            source.write_bytes(self.encode(self.base(
                self.command("item.completed", item_id="found", exit_marker=4, private="changed")
            )))
            changed = self.run_source(
                source, "--correlate", "first-nonzero", "--after-ordinal", "0",
                "--expected-sha256", digest,
            )
            self.assert_refused(changed)

    def test_correlation_exact_utf8_cap_and_truthful_indivisible_refusal(self):
        records = self.base(self.command(
            "item.completed", item_id="é\\\"-identity", exit_marker=8,
        ))
        first, _, _, _ = self.run_index(records, extra=("--correlate", "first-nonzero"))
        self.assertEqual(first.returncode, 0, first.stderr)
        required = len(first.stdout)
        exact, _, _, _ = self.run_index(
            records, extra=("--correlate", "first-nonzero", "--output-cap", str(required))
        )
        self.assertEqual(exact.returncode, 0, exact.stderr)
        self.assertEqual(len(exact.stdout), required)
        below, _, _, _ = self.run_index(
            records, extra=("--correlate", "first-nonzero", "--output-cap", str(required - 1))
        )
        self.assertEqual(below.returncode, 3, below.stderr)
        diagnostic = json.loads(below.stdout)
        self.assertEqual(diagnostic["required_bytes"], required)
        self.assertNotIn("after-ordinal", diagnostic["remedy"])
        self.assertNotIn("item-id", diagnostic["remedy"])

        long_id = "x" * 4096
        refused, _, _, _ = self.run_index(
            self.base(self.command("item.completed", item_id=long_id, exit_marker=2)),
            extra=("--correlate", "first-nonzero", "--output-cap", "256"),
        )
        self.assertEqual(refused.returncode, 3, refused.stderr)
        self.assertNotIn(long_id.encode(), refused.stdout + refused.stderr)

    def test_correlation_privacy_keeps_allowlisted_facts_but_changes_digest(self):
        outputs = []
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "events.jsonl"
            for secret in ("PRIVATE-ONE", "PRIVATE-TWO"):
                source.write_bytes(self.encode(self.base(self.command(
                    "item.completed", item_id="same", exit_marker=5,
                    command=secret, output=secret, cwd=secret,
                ))))
                result = self.run_source(source, "--correlate", "first-nonzero")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn(secret.encode(), result.stdout + result.stderr)
                outputs.append(json.loads(result.stdout))
        self.assertEqual(outputs[0]["match"], outputs[1]["match"])
        self.assertEqual(outputs[0]["correlation"], outputs[1]["correlation"])
        self.assertNotEqual(outputs[0]["source"]["sha256"], outputs[1]["source"]["sha256"])

    def test_oversized_capture_correlation_discovers_known_nonzero_for_exact_retrieval(self):
        observations = [
            self.command("item.completed", item_id=f"cmd-{index:04d}", exit_marker=7 if index == 4321 else 0)
            for index in range(8000)
        ]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "events.jsonl"
            source.write_bytes(self.encode(self.base(*observations)))
            whole = self.run_source(source, "--output-cap", str(1024 * 1024))
            self.assertEqual(whole.returncode, 3, whole.stderr)
            correlated = self.run_source(source, "--correlate", "first-nonzero")
            self.assertEqual(correlated.returncode, 0, correlated.stderr)
            value = json.loads(correlated.stdout)
            self.assertEqual(value["match"]["item_id"], "cmd-4321")
            self.assertEqual(value["match"]["ordinal"], 4321)
            selected = self.run_source(
                source, "--item-id", value["match"]["item_id"],
                "--expected-sha256", value["source"]["sha256"],
            )
            self.assertEqual(selected.returncode, 0, selected.stderr)
            self.assertEqual(json.loads(selected.stdout)["commands"][0]["item_id"], "cmd-4321")


if __name__ == "__main__":
    unittest.main()
