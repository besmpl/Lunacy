import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "evidence_index.py"
THREAD = "child-thread"
TURN = "selected-turn"
SECRET = "EXCLUDED-秘密-PRIVATE-CANARY"
MISSING = object()


def load_module():
    spec = importlib.util.spec_from_file_location("native_lifecycle_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def encode(records):
    return b"".join((json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")
                    for record in records)


def metadata(thread=THREAD, **extra):
    return {"type": "session_meta", "payload": {"id": thread, **extra}}


def event(label="task_started", turn=TURN, timestamp=MISSING, **extra):
    payload = {"type": label, **extra}
    if turn is not MISSING:
        payload["turn_id"] = turn
    record = {"type": "event_msg", "payload": payload}
    if timestamp is not MISSING:
        record["timestamp"] = timestamp
    return record


class NativeLifecyclePureTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()

    def project(self, records=None, *, raw=None, thread=THREAD, turn=TURN):
        data = encode(records) if raw is None else raw
        return self.module._project_native_lifecycle(
            data, Path("/not-read/finite-capture.jsonl"), hashlib.sha256(data).hexdigest(),
            thread, turn,
        )

    def assert_refused(self, records=None, *, raw=None, **selectors):
        with self.assertRaises(self.module.EvidenceError) as caught:
            self.project(records, raw=raw, **selectors)
        self.assertNotIn(SECRET, str(caught.exception))
        return str(caught.exception)

    def test_exact_empty_projection_is_not_an_inferred_state(self):
        records = [metadata(session_id="parent-session", prompt=SECRET)]
        raw = encode(records)
        value = self.project(raw=raw)
        self.assertEqual(set(value), {"schema", "source", "scope", "session", "events",
                                     "unscoped_events", "ignored_event_count",
                                     "other_turn_event_count", "projection_only", "non_claims"})
        self.assertEqual(value["schema"], "lunacy-native-lifecycle-index-v1")
        self.assertEqual(value["source"], {"path": "/not-read/finite-capture.jsonl",
                                         "sha256": hashlib.sha256(raw).hexdigest(),
                                         "bytes": len(raw), "lines": 1})
        self.assertEqual(value["scope"], {"thread_id": THREAD, "turn_id": TURN})
        self.assertEqual(value["session"], {"metadata_line": 1})
        self.assertEqual(value["events"], [])
        self.assertEqual(value["unscoped_events"], [])
        self.assertEqual(value["ignored_event_count"], 0)
        self.assertEqual(value["other_turn_event_count"], 0)
        self.assertIs(value["projection_only"], True)
        self.assertTrue(value["non_claims"])
        self.assertTrue(all(isinstance(claim, str) and claim for claim in value["non_claims"]))
        self.assertNotIn(SECRET, json.dumps(value, ensure_ascii=False))

    def test_exact_source_order_duplicates_reversed_terminals_and_unscoped(self):
        records = [
            {"type": "turn_context", "payload": {"turn_id": "context-must-not-bind"}},
            event("task_complete", timestamp="2026-09-26T12:00:00Z"),
            metadata(session_id="different-parent"),
            event("task_started", timestamp="2026-09-25T10:00:00+03:00"),
            event("turn_aborted", timestamp=None, reason=SECRET),
            event("task_complete"), event("task_complete"),
            event("task_started", turn=None),
            event("task_complete", turn=MISSING),
            event("task_started", turn="other-turn", timestamp=SECRET),
            event("token_count", turn=TURN, timestamp=SECRET, info=SECRET),
            {"type": "response_item", "payload": SECRET},
        ]
        value = self.project(records)
        self.assertEqual(value["session"], {"metadata_line": 3})
        self.assertEqual(value["events"], [
            {"line": 2, "event": "task_complete", "recorded_timestamp": "2026-09-26T12:00:00Z"},
            {"line": 4, "event": "task_started", "recorded_timestamp": "2026-09-25T10:00:00+03:00"},
            {"line": 5, "event": "turn_aborted", "recorded_timestamp": None},
            {"line": 6, "event": "task_complete", "recorded_timestamp": None},
            {"line": 7, "event": "task_complete", "recorded_timestamp": None},
        ])
        self.assertEqual(value["unscoped_events"], [
            {"line": 8, "event": "task_started", "recorded_timestamp": None},
            {"line": 9, "event": "task_complete", "recorded_timestamp": None},
        ])
        self.assertEqual(value["ignored_event_count"], 1)
        self.assertEqual(value["other_turn_event_count"], 1)
        self.assertEqual(value["source"]["lines"], 12)
        self.assertNotIn(SECRET, json.dumps(value, ensure_ascii=False))

    def test_metadata_identity_is_id_not_parent_session_id(self):
        self.project([metadata(session_id=SECRET), event()])
        self.project([metadata(), event()])
        self.assert_refused([metadata("other-child", session_id=THREAD), event()])
        self.assert_refused([{"type": "session_meta", "payload": {"session_id": THREAD}}])

    def test_missing_duplicate_and_malformed_metadata_refuse(self):
        cases = [[], [event()], [metadata(), metadata()], [metadata(), metadata("other")]]
        cases += [[{"type": "session_meta", "payload": payload}]
                  for payload in (None, [], SECRET, {}, {"id": None}, {"id": ""}, {"id": True})]
        for records in cases:
            with self.subTest(records=records):
                self.assert_refused(records)

    def test_record_and_event_payload_shapes_refuse_without_values(self):
        cases = [None, [], SECRET, {}, {"type": ""}, {"type": True},
                 {"type": 17}, {"type": []}, {"type": "event_msg"}]
        cases += [{"type": "event_msg", "payload": payload}
                  for payload in (None, [], SECRET, {}, {"type": None}, {"type": ""},
                                  {"type": True}, {"type": 17}, {"type": []})]
        for record in cases:
            with self.subTest(record=record):
                self.assert_refused([metadata(), record])

    def test_explicit_invalid_turn_ids_refuse_but_missing_and_null_are_unscoped(self):
        for turn in ("", 0, True, [], {}, "x" * 129):
            for label in ("task_started", "task_complete", "turn_aborted"):
                with self.subTest(turn=turn, label=label):
                    self.assert_refused([metadata(), event(label, turn=turn)])
        value = self.project([metadata(), event(turn=None), event(turn=MISSING)])
        self.assertEqual(value["events"], [])
        self.assertEqual([entry["line"] for entry in value["unscoped_events"]], [2, 3])

    def test_private_selector_validation_and_unicode_character_boundary(self):
        for name in ("thread", "turn"):
            for invalid in (None, "", 0, True, [], "x" * 129):
                with self.subTest(name=name, invalid=invalid):
                    self.assert_refused([metadata()], **{name: invalid})
        thread, turn = "界" * 128, "😀" * 128
        value = self.project([metadata(thread), event(turn=turn)], thread=thread, turn=turn)
        self.assertEqual(value["scope"], {"thread_id": thread, "turn_id": turn})
        self.assertEqual(len(value["events"]), 1)

    def test_supported_labels_are_exact_and_excluded_fields_are_opaque(self):
        labels = ["task_started ", "Task_started", "turn_started", "turn_completed",
                  "token_count", "agent_message", SECRET]
        records = [metadata(), event(arguments={SECRET: 1e200}, results=[SECRET],
                                     reason=SECRET, model=SECRET, duration="not a duration")]
        records += [event(label, turn=[], timestamp={SECRET: SECRET}) for label in labels]
        value = self.project(records)
        self.assertEqual(value["ignored_event_count"], len(labels))
        self.assertEqual(value["other_turn_event_count"], 0)
        self.assertEqual(value["events"], [{"line": 2, "event": "task_started", "recorded_timestamp": None}])
        self.assertNotIn(SECRET, json.dumps(value, ensure_ascii=False))

    def test_valid_timestamps_preserve_exact_spelling(self):
        timestamps = [None, "0001-01-01T00:00:00Z", "2024-02-29T23:59:59Z",
                      "2026-09-26T01:02:03.1Z", "2026-09-26T01:02:03.123456789Z",
                      "2026-09-26T01:02:03+05:30", "2026-09-26T01:02:03-00:00",
                      "2026-09-26T01:02:03.100000000-12:34"]
        value = self.project([metadata()] + [event(timestamp=value) for value in timestamps])
        self.assertEqual([entry["recorded_timestamp"] for entry in value["events"]], timestamps)

    def test_invalid_emitted_timestamps_refuse_including_unscoped(self):
        timestamps = ["", SECRET, True, 0, [], {}, "2023-02-29T12:00:00Z",
                      "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "0000-01-01T00:00:00Z",
                      "2026-09-26T24:00:00Z", "2026-09-26T01:60:00Z", "2026-09-26T01:00:61Z",
                      "2026-09-26T01:02:03", "2026-09-26 01:02:03Z", "2026-09-26t01:02:03z",
                      "2026-09-26T01:02:03.Z", "2026-09-26T01:02:03.1234567890Z",
                      "2026-09-26T01:02:03+24:00", "2026-09-26T01:02:03+01:60",
                      "2026-09-26T01:02:03+0100", "2026-09-26T01:02:03Z\n"]
        for timestamp in timestamps:
            for turn in (TURN, None):
                with self.subTest(timestamp=timestamp, turn=turn):
                    self.assert_refused([metadata(), event(turn=turn, timestamp=timestamp)])

    def test_combined_observation_limit_and_nonemitted_records(self):
        value = self.project([metadata()] + [event()] * 64 + [event(turn=None)] * 64)
        self.assertEqual((len(value["events"]), len(value["unscoped_events"])), (64, 64))
        for selected, unscoped in ((129, 0), (0, 129), (64, 65)):
            with self.subTest(selected=selected, unscoped=unscoped):
                self.assert_refused([metadata()] + [event()] * selected + [event(turn=None)] * unscoped)
        value = self.project([metadata()] + [event(turn="other", timestamp=SECRET)] * 129
                             + [event("unknown", timestamp=SECRET)] * 129)
        self.assertEqual((value["other_turn_event_count"], value["ignored_event_count"]), (129, 129))

    def test_jsonl_is_physical_lf_and_unicode_is_not_a_line_boundary(self):
        raw = encode([metadata(), {"type": "response_item", "payload": "a\u2028b\u2029c"}, event()])
        value = self.project(raw=raw)
        self.assertEqual(value["source"]["lines"], 3)
        self.assertEqual(value["source"]["bytes"], len(raw))
        self.assertEqual(value["events"][0]["line"], 3)
        self.assert_refused(raw=raw[:-1])
        self.assert_refused(raw=raw + b"\xff\n")
        self.assert_refused(raw=raw + b"\n")

    def test_strict_json_failures_do_not_echo_excluded_keys_or_payload(self):
        key = json.dumps(SECRET, ensure_ascii=False)
        suffixes = [
            f'{{"type":"response_item","payload":{{{key}:1,{key}:2}}}}\n',
            f'{{"type":"response_item","payload":{{{key}:NaN}}}}\n',
            f'{{"type":"response_item","payload":{{{key}:Infinity}}}}\n',
            f'{{"type":"response_item","payload":{{{key}:1e999999999999999999999999}}}}\n',
            f'{{"type":"response_item","payload":{key} oops}}\n',
        ]
        for suffix in suffixes:
            with self.subTest(suffix=suffix):
                message = self.assert_refused(raw=encode([metadata()]) + suffix.encode())
                self.assertIn("2", message)

    def test_projection_neither_reads_files_nor_shares_mutable_result_state(self):
        raw = encode([metadata(), event(body=SECRET)])
        original = bytes(raw)
        with patch("builtins.open", side_effect=AssertionError("unexpected file read")), \
                patch.object(Path, "read_bytes", side_effect=AssertionError("unexpected path read")), \
                patch.object(self.module, "read_snapshot", side_effect=AssertionError("unexpected snapshot")):
            first = self.project(raw=raw)
            expected = self.project(raw=raw)
            first["events"][0]["event"] = "changed"
            first["non_claims"].append("changed")
            actual = self.project(raw=raw)
        self.assertEqual(raw, original)
        self.assertEqual(actual, expected)


class NativeLifecycleCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "capture ' 秘密.jsonl"
        self.raw = encode([metadata(session_id="parent"), event(body=SECRET)])
        self.source.write_bytes(self.raw)
        self.digest = hashlib.sha256(self.raw).hexdigest()

    def arguments(self, **changes):
        values = {"--source-format": "native-lifecycle", "--thread-id": THREAD,
                  "--turn-id": TURN, "--expected-sha256": self.digest}
        values.update(changes)
        return [part for key, value in values.items() if value is not None for part in (key, value)]

    def invoke(self, *extra, args=None, source=None):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), str(source or self.source),
                               *(self.arguments() if args is None else args), *extra],
                              capture_output=True, timeout=5, check=False)

    def assert_refused(self, result, cap=512):
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(result.stdout, b"")
        self.assertLessEqual(len(result.stderr), cap)
        self.assertNotIn(SECRET.encode(), result.stderr)
        result.stderr.decode("utf-8", "strict")

    def test_real_cli_matches_pure_projection_and_preserves_read_only_source(self):
        self.source.chmod(0o444)
        before = (self.source.read_bytes(), self.source.stat().st_mtime_ns,
                  stat.S_IMODE(self.source.stat().st_mode), sorted(self.root.iterdir()))
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertTrue(result.stdout.endswith(b"\n"))
        self.assertEqual(result.stdout.count(b"\n"), 1)
        self.assertNotIn(SECRET.encode(), result.stdout)
        module = load_module()
        self.assertEqual(json.loads(result.stdout), module._project_native_lifecycle(
            self.raw, self.source, self.digest, THREAD, TURN))
        after = (self.source.read_bytes(), self.source.stat().st_mtime_ns,
                 stat.S_IMODE(self.source.stat().st_mode), sorted(self.root.iterdir()))
        self.assertEqual(before, after)

    def test_argument_misuse_refuses_before_source_acquisition(self):
        cases = [self.arguments(**{flag: value})
                 for flag, values in (("--thread-id", (None, "", "x" * 129)),
                                      ("--turn-id", (None, "", "x" * 129)),
                                      ("--expected-sha256", (None, "0", "G" * 64)),
                                      ("--output-cap", ("255", "8193", "1048576")))
                 for value in values]
        cases += [self.arguments() + [flag, value] for flag, value in (
            ("--session-id", "session"), ("--item-id", "item"),
            ("--correlate", "first-nonzero"), ("--after-ordinal", "0"))]
        module = load_module()
        for args in cases:
            with self.subTest(args=args):
                result = self.invoke(args=args)
                self.assert_refused(result, 256)
                stdout, stderr = io.TextIOWrapper(io.BytesIO()), io.TextIOWrapper(io.BytesIO())
                with patch.object(module.sys, "argv", [str(SCRIPT), str(self.source), *args]), \
                        patch.object(module.sys, "stdout", stdout), \
                        patch.object(module.sys, "stderr", stderr), \
                        patch.object(module, "read_snapshot", side_effect=AssertionError("read before validation")) as read:
                    self.assertEqual(module.main(), 2)
                read.assert_not_called()

    def test_digest_mismatch_and_unreadable_nonregular_or_oversized_input_refuse(self):
        result = self.invoke(args=self.arguments(**{"--expected-sha256": "0" * 64}))
        self.assert_refused(result)
        self.assertIn(b"mismatch", result.stderr)
        for source in (self.source.name, self.root / "absent", self.root):
            with self.subTest(source=source):
                self.assert_refused(self.invoke(source=source))
        fifo = self.root / "pipe"
        os.mkfifo(fifo)
        self.assert_refused(self.invoke(source=fifo))
        big = self.root / "too-big.jsonl"
        with big.open("wb") as handle:
            handle.truncate(64 * 1024 * 1024 + 1)
        result = self.invoke(source=big)
        self.assert_refused(result)
        self.assertIn(b"input cap", result.stderr)

    def test_valid_input_over_one_megabyte_remains_supported(self):
        data = encode([metadata(), {"type": "response_item", "payload": "x" * (1024 * 1024)}, event()])
        self.source.write_bytes(data)
        result = self.invoke(args=self.arguments(**{"--expected-sha256": hashlib.sha256(data).hexdigest()}))
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["source"]["bytes"], len(data))
        self.assertEqual(value["events"], [{"line": 3, "event": "task_started", "recorded_timestamp": None}])
        self.assertLess(len(result.stdout), 8192)

    def test_output_cap_is_a_complete_diagnostic_never_partial_evidence(self):
        for cap, records in ((256, [metadata(), event()]),
                             (8192, [metadata()] + [event(timestamp="2026-09-26T01:02:03.123456789+05:30")] * 128)):
            with self.subTest(cap=cap):
                data = encode(records)
                self.source.write_bytes(data)
                args = self.arguments(**{"--expected-sha256": hashlib.sha256(data).hexdigest(),
                                         "--output-cap": str(cap)})
                result = self.invoke(args=args)
                self.assertEqual(result.returncode, 3, result.stderr)
                self.assertEqual(result.stderr, b"")
                self.assertLessEqual(len(result.stdout), cap)
                diagnostic = json.loads(result.stdout)
                self.assertEqual(set(diagnostic), {"error", "limit_bytes", "required_bytes", "remedy"})
                self.assertEqual(diagnostic["error"], "output_cap_exceeded")
                self.assertEqual(diagnostic["limit_bytes"], cap)
                self.assertGreater(diagnostic["required_bytes"], cap)
                self.assertNotIn("--item-id", diagnostic["remedy"])
                self.assertTrue(diagnostic["remedy"])

    def test_privacy_and_bounded_utf8_for_runtime_parse_refusals(self):
        key = json.dumps(SECRET, ensure_ascii=False)
        for suffix in (f'{{{key}:1,{key}:2}}\n',
                       f'{{"type":"event_msg","payload":{{"type":"task_started","turn_id":"{TURN}"}},"timestamp":{key}}}\n',
                       f'{{"type":"response_item","payload":{key} broken}}\n'):
            with self.subTest(suffix=suffix):
                data = encode([metadata()]) + suffix.encode()
                self.source.write_bytes(data)
                result = self.invoke(args=self.arguments(**{
                    "--expected-sha256": hashlib.sha256(data).hexdigest(), "--output-cap": "256"}))
                self.assert_refused(result, 256)


if __name__ == "__main__":
    unittest.main()
