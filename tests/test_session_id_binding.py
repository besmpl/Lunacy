#!/usr/bin/env python3
"""Public-CLI regressions for explicit session-ID association."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve()
SCRIPT = HERE.parents[1] / "scripts/evidence_index.py"
FIXTURES = HERE.parent / "fixtures"
THREAD = "child-thread"
SESSION = "parent-session"
TURN = "selected-turn"


def golden(name, source):
    expected = (FIXTURES / name).read_bytes()
    escaped_path = json.dumps(os.fspath(source), ensure_ascii=True)[1:-1].encode()
    return expected.replace(b"{{SOURCE_PATH}}", escaped_path).replace(
        b"{{SOURCE_SHA256}}", hashlib.sha256(source.read_bytes()).hexdigest().encode()
    )


def meta(*, ident=THREAD, session_id=SESSION):
    return {"type": "session_meta", "payload": {"id": ident, "session_id": session_id}}


def context(turn=TURN, *, model="gpt-recorded", effort="medium"):
    return {"type": "turn_context", "payload": {"turn_id": turn, "model": model, "effort": effort}}


def command(*, thread=THREAD, turn=TURN, item="item", status="completed", exit_code=0):
    return {"type": "event_msg", "payload": {"type": "item_completed", "thread_id": thread,
        "turn_id": turn, "item": {"type": "CommandExecution", "id": item,
        "command": ["true"], "status": status, "exit_code": exit_code}}}


class SessionIdBindingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, records, name="capture.jsonl"):
        path = self.root / name
        path.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in records))
        return path

    def invoke_path(self, path, *extra, script=SCRIPT, source_format=True):
        argv = [os.fspath(script), os.fspath(path)]
        if source_format:
            argv += ["--source-format", "session-receipt"]
        argv += ["--thread-id", THREAD, "--turn-id", TURN, *extra]
        return subprocess.run(argv, capture_output=True, timeout=5, check=False)

    def invoke(self, records, *extra, **kwargs):
        return self.invoke_path(self.write(records), *extra, **kwargs)

    def assert_refusal(self, result, phrase):
        self.assertEqual((result.returncode, result.stdout), (2, b""), result.stderr)
        self.assertIn(phrase, result.stderr)
        self.assertEqual(result.stderr.count(b"\n"), 1)
        self.assertNotIn(b"Traceback", result.stderr)

    def test_parent_session_child_thread_exact_value_is_accepted_and_recorded(self):
        source = self.write([meta(), context(), command()])
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        result = self.invoke_path(source, "--session-id", SESSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["scope"]["thread_id"], THREAD)
        self.assertEqual(value["session"]["recorded_session_id"], SESSION)
        self.assertEqual(value["session"]["metadata_line"], 1)
        self.assertEqual(value["commands"][0]["item_id"], "item")
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)

    def test_wrong_explicit_session_id_refuses(self):
        self.assert_refusal(self.invoke([meta(), context(), command()], "--session-id", "wrong"),
                            b"session_meta.session_id does not match requested session ID")

    def test_omission_retains_original_thread_session_binding_refusal(self):
        self.assert_refusal(self.invoke([meta(), context(), command()]),
                            b"session_meta.session_id does not match requested thread ID")

    def test_same_id_explicit_case_adds_validated_field(self):
        result = self.invoke([meta(session_id=THREAD), context(), command()], "--session-id", THREAD)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["session"]["recorded_session_id"], THREAD)

    def test_ordinary_default_output_is_byte_identical_and_has_no_new_field(self):
        source = self.write([meta(session_id=THREAD), context(), command()])
        before = source.read_bytes()
        new = self.invoke_path(source)
        self.assertEqual(
            (new.returncode, new.stdout, new.stderr),
            (0, golden("session-default.stdout.golden", source), b""),
        )
        self.assertEqual(source.read_bytes(), before)
        value = json.loads(new.stdout)
        self.assertNotIn("recorded_session_id", value["session"])

    def test_missing_empty_and_app_server_session_id_refuse_before_acquisition(self):
        fifo = self.root / "must-not-open"
        os.mkfifo(fifo)
        required = [os.fspath(SCRIPT), os.fspath(fifo), "--source-format", "session-receipt",
                    "--thread-id", THREAD, "--turn-id", TURN]
        cases = [
            (required + ["--session-id"], b"expected one argument"),
            (required + ["--session-id", ""], b"must be a nonempty string"),
            ([os.fspath(SCRIPT), os.fspath(fifo), "--thread-id", THREAD, "--turn-id", TURN,
              "--session-id", SESSION], b"requires --source-format session-receipt"),
            ([os.fspath(SCRIPT), os.fspath(fifo), "--source-format", "app-server", "--thread-id", THREAD,
              "--turn-id", TURN, "--session-id", SESSION], b"requires --source-format session-receipt"),
        ]
        for argv, phrase in cases:
            with self.subTest(argv=argv):
                result = subprocess.run(argv, capture_output=True, timeout=3, check=False)
                self.assert_refusal(result, phrase)
                self.assertNotIn(b"regular file", result.stderr)

    def test_metadata_id_and_command_thread_remain_independently_bound(self):
        self.assert_refusal(self.invoke([meta(ident="other"), context(), command()], "--session-id", SESSION),
                            b"session_meta.id does not match requested thread ID")
        self.assert_refusal(self.invoke([meta(), context(), command(thread="other")], "--session-id", SESSION),
                            b"conflicting thread_id")

    def test_duplicate_and_late_contradictory_metadata_refuse_atomically(self):
        for records in ([meta(), meta(), context(), command()],
                        [meta(), context(), command(), meta(session_id="other")]):
            with self.subTest(records=records):
                self.assert_refusal(self.invoke(records, "--session-id", SESSION), b"multiple session_meta")

    def test_exact_turn_selection_is_unchanged(self):
        result = self.invoke([meta(), context("other", model="wrong"), context(),
                              command(turn="other", item="other"), command(item="selected")],
                             "--session-id", SESSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value["session"]["context_line"], 3)
        self.assertEqual([row["item_id"] for row in value["commands"]], ["selected"])

    def test_late_malformed_data_leaves_no_partial_output(self):
        records = [meta(), context(), command(), {"type": "event_msg", "payload": {
            "type": "item_completed", "thread_id": THREAD, "turn_id": TURN,
            "item": {"type": "CommandExecution", "id": "late", "command": ["true"],
                     "status": "completed"}}}]
        self.assert_refusal(self.invoke(records, "--session-id", SESSION), b"item.exit_code must be present")


if __name__ == "__main__":
    unittest.main()
