#!/usr/bin/env python3
"""Public-CLI coverage for the opt-in native session-receipt projection."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/evidence_index.py"
MISSING = object()


def meta(thread="thread", *, ident=MISSING, session_id=MISSING, **extra):
    payload = {"id": thread if ident is MISSING else ident,
               "session_id": thread if session_id is MISSING else session_id}
    payload.update(extra)
    return {"type": "session_meta", "payload": payload}


def context(turn="turn", *, model="gpt-recorded", effort="medium", **extra):
    payload = {"turn_id": turn, "model": model, "effort": effort}
    payload.update(extra)
    return {"type": "turn_context", "payload": payload}


def command(*, thread="thread", turn="turn", item="item", argv=MISSING,
            status="completed", exit_code=0, item_type="CommandExecution", **extra):
    value = {"type": item_type, "id": item,
             "command": ["printf", "SECRET_ARGV"] if argv is MISSING else argv,
             "status": status, "exit_code": exit_code,
             "cwd": "SECRET_CWD", "stdout": "SECRET_OUTPUT"}
    value.update(extra)
    return {"type": "event_msg", "payload": {"type": "item_completed",
            "thread_id": thread, "turn_id": turn, "item": value}}


class SessionReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, records, *, ensure_ascii=True):
        source = self.root / "session receipt.jsonl"
        source.write_text("".join(json.dumps(row, ensure_ascii=ensure_ascii) + "\n" for row in records))
        return source

    def invoke(self, records, *extra, ensure_ascii=True):
        source = self.write(records, ensure_ascii=ensure_ascii)
        result = subprocess.run(
            [os.fspath(SCRIPT), os.fspath(source), "--source-format", "session-receipt",
             "--thread-id", "thread", "--turn-id", "turn", *extra],
            text=True, capture_output=True, timeout=5, check=False,
        )
        return result, source

    def ok(self, records, *extra, ensure_ascii=True):
        result, source = self.invoke(records, *extra, ensure_ascii=ensure_ascii)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout), source

    def test_completion_only_projection_has_explicit_basis_and_raw_facts(self):
        value, source = self.ok([meta(), context(), command(status="future-status", exit_code=-7)])
        self.assertEqual(value["schema"], "lunacy-session-command-index-v1")
        self.assertEqual(value["source"], {"path": os.fspath(source),
                                           "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
        self.assertEqual(value["scope"], {"thread_id": "thread", "turn_id": "turn",
                                           "selected_item_ids": None})
        self.assertEqual(value["session"], {"metadata_line": 1, "context_line": 2,
                                             "recorded_model": "gpt-recorded",
                                             "recorded_effort": "medium",
                                             "context_thread_basis": "source-associated"})
        self.assertEqual(value["commands"], [{"item_id": "item", "completion_line": 3,
                                               "status": "future-status", "exit_code": -7}])
        self.assertNotIn("classification", json.dumps(value))

    def test_exact_turn_item_filter_and_multiple_turns(self):
        records = [meta(), context("other", model="other-model"), context(),
                   command(turn="other", item="other"), command(item="a"), command(item="b", exit_code=None)]
        value, _ = self.ok(records, "--item-id", "b")
        self.assertEqual(value["session"]["context_line"], 3)
        self.assertEqual(value["commands"], [{"item_id": "b", "completion_line": 6,
                                               "status": "completed", "exit_code": None}])

    def test_identical_context_and_completion_duplicates_dedupe(self):
        ctx = context(); done = command()
        value, _ = self.ok([meta(), ctx, ctx, done, done])
        self.assertEqual(value["session"]["context_line"], 2)
        self.assertEqual(value["commands"][0]["completion_line"], 4)

    def test_conflicting_context_or_completion_duplicates_refuse(self):
        cases = [
            ([meta(), context(), context(model="different"), command()], "conflicting turn_context"),
            ([meta(), context(), command(), command(stdout="changed")], "contradictory duplicate"),
        ]
        for records, phrase in cases:
            with self.subTest(phrase=phrase):
                result, _ = self.invoke(records)
                self.assertEqual(result.returncode, 2)
                self.assertIn(phrase, result.stderr)

    def test_duplicate_completion_comparison_preserves_json_types_recursively(self):
        cases = [
            ({"flag": 1}, {"flag": True}, "top-level"),
            ({"extra": {"value": 1}}, {"extra": {"value": True}}, "nested-object"),
            ({"extra": [1]}, {"extra": [True]}, "nested-list"),
        ]
        for first, second, label in cases:
            with self.subTest(label=label):
                result, _ = self.invoke([meta(), context(), command(**first), command(**second)])
                self.assertEqual(result.returncode, 2)
                self.assertIn("contradictory duplicate", result.stderr)

    def test_identical_nested_duplicate_with_reordered_object_keys_dedupes(self):
        first = command(extra={"outer": {"a": 1, "b": [False, None]}})
        second = command(extra={"outer": {"b": [False, None], "a": 1}})
        value, _ = self.ok([meta(), context(), first, second])
        self.assertEqual(value["commands"], [{"item_id": "item", "completion_line": 3,
                                               "status": "completed", "exit_code": 0}])

    def test_session_metadata_identity_and_cardinality_refusals(self):
        cases = [
            ([context(), command()], "session_meta"),
            ([meta(), meta(), context(), command()], "multiple session_meta"),
            ([meta(ident="wrong"), context(), command()], "session_meta.id"),
            ([meta(session_id="wrong"), context(), command()], "session_meta.session_id"),
            ([meta(ident=""), context(), command()], "nonempty string"),
        ]
        for records, phrase in cases:
            with self.subTest(phrase=phrase):
                result, _ = self.invoke(records)
                self.assertEqual(result.returncode, 2)
                self.assertIn(phrase, result.stderr)

    def test_context_missing_ambiguous_or_conflicting_identity_refuses(self):
        cases = [
            ([meta(), context("other"), command()], "matching turn_context"),
            ([meta(), context(model=""), command()], "model"),
            ([meta(), context(effort=None), command()], "effort"),
            ([meta(), context(), command(thread="wrong")], "conflicting thread_id"),
        ]
        for records, phrase in cases:
            with self.subTest(phrase=phrase):
                result, _ = self.invoke(records)
                self.assertEqual(result.returncode, 2)
                self.assertIn(phrase, result.stderr)

    def test_command_wrapper_identity_and_item_shapes_refuse(self):
        bad_wrapper = command(); del bad_wrapper["payload"]["turn_id"]
        bad_item = command(); bad_item["payload"]["item"] = None
        cases = [
            (bad_wrapper, "turn_id"), (bad_item, "item must be an object"),
            (command(item=""), "item.id"), (command(argv=[]), "nonempty string array"),
            (command(argv=["ok", 4]), "nonempty string array"),
            (command(status=""), "item.status"),
            (command(exit_code=True), "integer or null"),
        ]
        for bad, phrase in cases:
            with self.subTest(phrase=phrase):
                result, _ = self.invoke([meta(), context(), bad])
                self.assertEqual(result.returncode, 2)
                self.assertIn(phrase, result.stderr)

    def test_exit_code_must_be_present_but_may_be_null(self):
        absent = command(); del absent["payload"]["item"]["exit_code"]
        result, _ = self.invoke([meta(), context(), absent])
        self.assertEqual(result.returncode, 2)
        self.assertIn("present", result.stderr)
        value, _ = self.ok([meta(), context(), command(exit_code=None)])
        self.assertIsNone(value["commands"][0]["exit_code"])
        empty_argument, _ = self.ok([meta(), context(), command(argv=[""])])
        self.assertEqual(empty_argument["observed_command_count"], 1)

    def test_unrelated_well_formed_rows_are_ignored_but_purported_commands_validate(self):
        unrelated = {"type": "event_msg", "payload": {"type": "item_completed",
                     "thread_id": "thread", "turn_id": "turn",
                     "item": {"type": "FileChange", "secret": "SECRET_EXTRA"}}}
        value, _ = self.ok([{"type": "user_message", "payload": "SECRET_PROMPT"},
                            meta(), context(), unrelated, command()])
        self.assertEqual(value["observed_command_count"], 1)
        invalid_other_turn = command(turn="other", argv=[])
        result, _ = self.invoke([meta(), context(), invalid_other_turn, command()])
        self.assertEqual(result.returncode, 2)
        self.assertIn("nonempty string array", result.stderr)

    def test_selected_missing_and_invalid_unselected_item_refuse(self):
        missing, _ = self.invoke([meta(), context(), command(item="a")], "--item-id", "missing")
        self.assertEqual(missing.returncode, 2)
        self.assertIn("not found", missing.stderr)
        invalid = command(item="bad", argv=[])
        hidden, _ = self.invoke([meta(), context(), invalid, command(item="good")], "--item-id", "good")
        self.assertEqual(hidden.returncode, 2)

    def test_allowlist_hides_sensitive_fields_and_unicode_separator_keeps_line_numbers(self):
        records = [{"type": "reasoning", "payload": "SECRET_REASONING\u2028still one line"},
                   meta(secret="SECRET_META"), context(secret="SECRET_CONTEXT"),
                   command(extra="SECRET_EXTRA")]
        value, _ = self.ok(records, ensure_ascii=False)
        output = json.dumps(value)
        for sentinel in ("SECRET_REASONING", "SECRET_META", "SECRET_CONTEXT", "SECRET_ARGV",
                         "SECRET_CWD", "SECRET_OUTPUT", "SECRET_EXTRA"):
            self.assertNotIn(sentinel, output)
        self.assertEqual(value["session"]["metadata_line"], 2)
        self.assertEqual(value["commands"][0]["completion_line"], 4)

    def test_session_output_ascii_escapes_preserve_projected_strings(self):
        cases = [
            (context(model="\ud800"), command(), ("session", "recorded_model"), "\ud800"),
            (context(effort="\udfff"), command(), ("session", "recorded_effort"), "\udfff"),
            (context(), command(item="item-\ud800"), ("commands", 0, "item_id"), "item-\ud800"),
            (context(), command(status="done-\udfff"), ("commands", 0, "status"), "done-\udfff"),
        ]
        for ctx, done, path, expected in cases:
            with self.subTest(path=path):
                result, _ = self.invoke([meta(), ctx, done])
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(result.stdout.isascii())
                value = json.loads(result.stdout)
                current = value
                for part in path:
                    current = current[part]
                self.assertEqual(current, expected)

        ordinary, _ = self.invoke([meta(), context(model="modèle", effort="médium"),
                                   command(item="项目", status="terminé")])
        self.assertEqual(ordinary.returncode, 0, ordinary.stderr)
        self.assertTrue(ordinary.stdout.isascii())
        decoded = json.loads(ordinary.stdout)
        self.assertEqual((decoded["session"]["recorded_model"], decoded["session"]["recorded_effort"]),
                         ("modèle", "médium"))
        self.assertEqual((decoded["commands"][0]["item_id"], decoded["commands"][0]["status"]),
                         ("项目", "terminé"))

    def test_ignored_surrogate_payload_fields_do_not_break_serialization(self):
        value, _ = self.ok([
            meta(secret="\ud800"), context(secret="\udfff"),
            {"type": "reasoning", "payload": "\ud800"},
            command(stdout="\udfff", extra={"nested": "\ud800"}),
        ])
        self.assertEqual(value["observed_command_count"], 1)

    def test_escaped_session_output_cap_is_atomic(self):
        result, _ = self.invoke(
            [meta(), context(model="\ud800" * 200), command()], "--output-cap", "1000"
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        diagnostic = json.loads(result.stdout)
        self.assertEqual(diagnostic["error"], "output_cap_exceeded")
        self.assertGreater(diagnostic["required_bytes"], 1000)
        self.assertNotIn("commands", result.stdout)

    def test_direct_exec_stdout_refuses_and_default_does_not_auto_detect(self):
        app_server = {"direction": "receive", "message": {"method": "unrelated", "params": {}}}
        explicit, _ = self.invoke([app_server])
        self.assertEqual(explicit.returncode, 2)
        self.assertIn("record type", explicit.stderr)
        source = self.write([meta(), context(), command()])
        default = subprocess.run([os.fspath(SCRIPT), os.fspath(source), "--thread-id", "thread",
                                  "--turn-id", "turn"], text=True, capture_output=True,
                                 timeout=5, check=False)
        self.assertEqual(default.returncode, 2)
        self.assertIn("direction", default.stderr)

    def test_common_reader_hash_late_errors_and_output_cap_are_atomic(self):
        records = [meta(), context()] + [command(item=f"item-{i}") for i in range(20)]
        capped, _ = self.invoke(records, "--output-cap", "256")
        self.assertEqual(capped.returncode, 3)
        self.assertEqual(json.loads(capped.stdout)["error"], "output_cap_exceeded")
        self.assertNotIn("commands", capped.stdout)
        source = self.write([meta(), context(), command()])
        wrong = subprocess.run([os.fspath(SCRIPT), os.fspath(source), "--source-format", "session-receipt",
                                "--thread-id", "thread", "--turn-id", "turn",
                                "--expected-sha256", "0" * 64], text=True, capture_output=True,
                               timeout=5, check=False)
        self.assertEqual((wrong.returncode, wrong.stdout), (2, ""))
        for suffix in ('{"x":1,"x":2}\n', "[" * 1500 + "]" * 1500 + "\n"):
            raw = source.read_text() + suffix
            source.write_text(raw)
            late = subprocess.run([os.fspath(SCRIPT), os.fspath(source), "--source-format", "session-receipt",
                                   "--thread-id", "thread", "--turn-id", "turn"],
                                  text=True, capture_output=True, timeout=5, check=False)
            self.assertEqual((late.returncode, late.stdout), (2, ""))
            source.write_text("".join(json.dumps(row) + "\n" for row in [meta(), context(), command()]))


if __name__ == "__main__":
    unittest.main()
