import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY / "scripts/evidence_index.py"


def event(method, thread="thread", turn="turn", item="item", *, status=None, exit_code=None, output=None):
    if status is None:
        status = "inProgress" if method == "item/started" else ("failed" if isinstance(exit_code, int) and exit_code != 0 else "completed")
    value = {
        "type": "commandExecution", "id": item, "status": status,
        "exitCode": exit_code, "command": "printf PASS", "cwd": "/tmp", "processId": "42", "aggregatedOutput": output,
    }
    return {"direction": "receive", "message": {"method": method, "params": {"threadId": thread, "turnId": turn, "item": value}}}


class EvidenceIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write(self, records, name="events.jsonl"):
        path = self.base / name
        path.write_text("".join(json.dumps(value) + "\n" for value in records))
        return path

    def invoke(self, path, *extra):
        return subprocess.run(
            [sys.executable, os.fspath(SCRIPT), os.fspath(path), "--thread-id", "thread", "--turn-id", "turn", *extra],
            text=True, capture_output=True, timeout=5, check=False,
        )

    def invoke_raw(self, text, *extra):
        path = self.base / "raw.jsonl"
        path.write_text(text)
        return self.invoke(path, *extra)

    def ok(self, records, *extra, name="events.jsonl"):
        result = self.invoke(self.write(records, name), *extra)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_zero_nonzero_pending_and_false_pass_are_observations_only(self):
        result = self.ok([
            event("item/started", item="zero"), event("item/completed", item="zero", exit_code=0, output="inner failed\nPASS"),
            event("item/started", item="bad"), event("item/completed", item="bad", exit_code=7, output="PASS"),
            event("item/started", item="pending"),
        ])
        self.assertEqual([c["classification"] for c in result["commands"]], ["observed_zero", "observed_nonzero", "missing_terminal"])
        self.assertTrue(result["projection_only"])
        self.assertNotIn("inner failed", json.dumps(result))
        self.assertIn("not proof", result["non_claims"][0])

    def test_no_matching_scope_and_same_item_elsewhere(self):
        result = self.ok([
            event("item/started", thread="other"), event("item/completed", thread="other", exit_code=9),
            event("item/started", turn="other"), event("item/completed", turn="other", exit_code=8),
        ])
        self.assertEqual(result["observed_command_count"], 0)
        self.assertEqual(result["ignored_unrelated_record_count"], 4)

    def test_same_item_in_distinct_scopes_does_not_collide(self):
        result = self.ok([
            event("item/started", thread="other"), event("item/completed", thread="other", exit_code=9),
            event("item/started"), event("item/completed", exit_code=0),
        ])
        self.assertEqual(result["commands"][0]["exit_code"], 0)

    def test_reordered_terminals_across_items_are_supported(self):
        result = self.ok([
            event("item/started", item="a"), event("item/started", item="b"),
            event("item/completed", item="b", exit_code=2), event("item/completed", item="a", exit_code=0),
        ])
        self.assertEqual([c["item_id"] for c in result["commands"]], ["a", "b"])
        self.assertEqual(result["commands"][1]["terminal_line"], 3)

    def test_identical_duplicate_dedupes_but_contradiction_fails(self):
        start = event("item/started")
        good = self.ok([start, start, event("item/completed", exit_code=0), event("item/completed", exit_code=0)])
        self.assertEqual(good["observed_command_count"], 1)
        changed = event("item/started"); changed["message"]["params"]["item"]["command"] = "other"
        bad = self.invoke(self.write([start, changed]))
        self.assertEqual(bad.returncode, 2)
        self.assertIn("contradictory duplicate", bad.stderr)

    def test_malformed_matching_records_and_terminal_before_start_fail(self):
        malformed = event("item/completed", exit_code=True)
        result = self.invoke(self.write([event("item/started"), malformed]))
        self.assertEqual(result.returncode, 2)
        self.assertIn("integer or null", result.stderr)
        result = self.invoke(self.write([event("item/completed", exit_code=0)]))
        self.assertEqual(result.returncode, 2)
        self.assertIn("terminal before start", result.stderr)

    def test_duplicate_json_keys_and_partial_json_fail(self):
        path = self.base / "dupe.jsonl"
        path.write_text('{"message":{},"message":{}}\n')
        result = self.invoke(path)
        self.assertEqual(result.returncode, 2)
        self.assertIn("duplicate JSON object key", result.stderr)
        path.write_text('{"message":')
        result = self.invoke(path)
        self.assertEqual(result.returncode, 2)
        self.assertIn("incomplete trailing", result.stderr)

    def test_missing_requested_item_and_post_digest_source_mutation_mismatch_fail(self):
        path = self.write([event("item/started"), event("item/completed", exit_code=0)])
        result = self.invoke(path, "--item-id", "missing")
        self.assertEqual(result.returncode, 2)
        self.assertIn("not found", result.stderr)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        path.write_text(path.read_text() + json.dumps({"message": {}}) + "\n")
        result = self.invoke(path, "--expected-sha256", digest)
        self.assertEqual(result.returncode, 2)
        self.assertIn("mismatch", result.stderr)

    def test_expected_hash_and_source_locator(self):
        path = self.write([event("item/started"), event("item/completed", exit_code=0)])
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        result = self.invoke(path, "--expected-sha256", digest)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["source"], {"path": os.fspath(path), "sha256": digest})

    def test_output_cap_refuses_without_truncation(self):
        records = []
        for number in range(30):
            records.extend([event("item/started", item=f"item-{number}"), event("item/completed", item=f"item-{number}", exit_code=number % 2)])
        result = self.invoke(self.write(records), "--output-cap", "512")
        self.assertEqual(result.returncode, 3)
        diagnostic = json.loads(result.stdout)
        self.assertEqual(diagnostic["error"], "output_cap_exceeded")

    def test_large_stdout_is_not_duplicated(self):
        result = self.ok([event("item/started"), event("item/completed", exit_code=0, output="X" * 500_000)])
        self.assertLess(len(json.dumps(result)), 4000)
        self.assertNotIn("XXXX", json.dumps(result))

    def test_path_metacharacters_and_read_only_preservation(self):
        path = self.write([event("item/started"), event("item/completed", exit_code=0)], "space ' quote ` tick.jsonl")
        path.chmod(0o444)
        before = (path.read_bytes(), stat.S_IMODE(path.stat().st_mode), path.stat().st_mtime_ns)
        result = self.invoke(path)
        after = (path.read_bytes(), stat.S_IMODE(path.stat().st_mode), path.stat().st_mtime_ns)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, after)

    def test_relative_and_nonregular_fifo_refuse_without_blocking(self):
        regular = self.write([])
        result = subprocess.run([os.fspath(SCRIPT), regular.name, "--thread-id", "thread", "--turn-id", "turn"], cwd=self.base, text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        fifo = self.base / "capture.fifo"
        os.mkfifo(fifo)
        result = self.invoke(fifo)
        self.assertEqual(result.returncode, 2)
        self.assertIn("regular file", result.stderr)

    def test_invalid_utf8_directory_and_oversize_refuse(self):
        invalid = self.base / "invalid.jsonl"
        invalid.write_bytes(b"\xff\n")
        result = self.invoke(invalid)
        self.assertEqual(result.returncode, 2)
        self.assertIn("valid UTF-8", result.stderr)
        result = self.invoke(self.base)
        self.assertEqual(result.returncode, 2)
        self.assertIn("regular file", result.stderr)
        large = self.base / "large.jsonl"
        with large.open("wb") as output:
            output.seek(64 * 1024 * 1024)
            output.write(b"x")
        result = self.invoke(large)
        self.assertEqual(result.returncode, 2)
        self.assertIn("input cap", result.stderr)

    def test_only_received_records_are_authoritative(self):
        sent = [event("item/started"), event("item/completed", exit_code=0)]
        for record in sent:
            record["direction"] = "send"
        result = self.ok(sent + [event("item/started", item="real"), event("item/completed", item="real", exit_code=0)])
        self.assertEqual([command["item_id"] for command in result["commands"]], ["real"])
        self.assertEqual(result["ignored_unrelated_record_count"], 2)
        missing = event("item/started"); missing.pop("direction")
        invalid = event("item/started"); invalid["direction"] = "sideways"
        for record in (missing, invalid):
            refused = self.invoke(self.write([record]))
            self.assertEqual(refused.returncode, 2)
            self.assertIn("direction", refused.stderr)

    def test_matching_envelope_identity_type_and_status_are_validated(self):
        cases = []
        null_item = event("item/completed", exit_code=0); null_item["message"]["params"]["item"] = None; cases.append((null_item, "item must be an object"))
        bad_identity = event("item/started"); bad_identity["message"]["params"]["threadId"] = None; cases.append((bad_identity, "threadId"))
        bad_type = event("item/started"); bad_type["message"]["params"]["item"]["type"] = None; cases.append((bad_type, "item.type"))
        bad_start = event("item/started", status="completed"); cases.append((bad_start, "start requires"))
        bad_terminal = event("item/completed", status="completed", exit_code=9); cases.append((bad_terminal, "contradicts exitCode"))
        for record, phrase in cases:
            result = self.invoke(self.write([record]))
            self.assertEqual(result.returncode, 2)
            self.assertIn(phrase, result.stderr)

    def test_cross_phase_command_cwd_and_process_identity_must_agree(self):
        for field, value in (("command", "different"), ("cwd", "/elsewhere"), ("processId", "99")):
            terminal = event("item/completed", exit_code=0)
            terminal["message"]["params"]["item"][field] = value
            result = self.invoke(self.write([event("item/started"), terminal]))
            self.assertEqual(result.returncode, 2)
            self.assertIn(f"terminal {'process_id' if field == 'processId' else field}", result.stderr)

    def test_nonstandard_constant_deep_json_and_unicode_separator(self):
        path = self.base / "special.jsonl"
        path.write_text('{"direction":"receive","message":{"method":"unrelated","params":{"x":"a\\u2028b"}}}\n')
        result = self.invoke(path)
        self.assertEqual(result.returncode, 0, result.stderr)
        path.write_text('{"direction":"receive","message":{"method":"unrelated","params":{"x":NaN}}}\n')
        result = self.invoke(path)
        self.assertEqual(result.returncode, 2)
        self.assertIn("nonstandard JSON constant", result.stderr)
        path.write_text("[" * 1500 + "]" * 1500 + "\n")
        result = self.invoke(path)
        self.assertEqual(result.returncode, 2)
        self.assertLessEqual(len(result.stderr.encode()), 512)

    @unittest.skipUnless(hasattr(sys, "get_int_max_str_digits"), "interpreter has no integer digit limit")
    def test_integer_digit_limit_controls_and_downstream_validation(self):
        limit = sys.get_int_max_str_digits()
        self.assertGreater(limit, 0, "test must not alter or disable the active interpreter digit limit")
        for digits in (limit - 1, limit):
            result = self.invoke_raw(
                '{"direction":"send","message":{"method":"ignored","value":' + "7" * digits + "}}\n"
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["ignored_unrelated_record_count"], 1)
        result = self.invoke_raw(
            '{"direction":"sideways","message":{"method":"ignored","value":' + "7" * limit + "}}\n"
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("direction", result.stderr)

        result = self.invoke_raw(
            '{"direction":"send","message":{"method":"ignored","value":' + "7" * (limit + 1) + "}}\n",
            "--output-cap", "256",
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("Traceback", result.stderr)
        self.assertLessEqual(len(result.stderr.encode()), 256)

    @unittest.skipUnless(hasattr(sys, "get_int_max_str_digits"), "interpreter has no integer digit limit")
    def test_signed_nested_and_late_integer_conversion_refusals_are_atomic(self):
        limit = sys.get_int_max_str_digits()
        self.assertGreater(limit, 0, "test must not alter or disable the active interpreter digit limit")
        too_many = "8" * (limit + 1)
        cases = [
            '{"direction":"send","message":{"value":-' + too_many + "}}\n",
            '{"direction":"send","message":{"nested":[{"value":' + too_many + "}]}}\n",
        ]
        valid = "".join(json.dumps(record) + "\n" for record in (
            event("item/started"), event("item/completed", exit_code=0),
        ))
        cases.append(valid + '{"direction":"send","message":{"value":' + too_many + "}}\n")
        for text in cases:
            result = self.invoke_raw(text, "--output-cap", "256")
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")
            self.assertNotIn("Traceback", result.stderr)
            self.assertLessEqual(len(result.stderr.encode()), 256)

    def test_refusal_diagnostics_are_bounded_for_hostile_text(self):
        path = self.base / "duplicate.jsonl"
        key = "K" * 20000
        path.write_text(json.dumps({key: 1})[:-1] + "," + json.dumps(key) + ":2}\n")
        result = self.invoke(path, "--output-cap", "256")
        self.assertEqual(result.returncode, 2)
        self.assertLessEqual(len(result.stderr.encode()), 256)
        result = self.invoke(self.write([]), "--item-id", "I" * 5000, "--output-cap", "256")
        self.assertEqual(result.returncode, 2)
        self.assertLessEqual(len(result.stderr.encode()), 256)

    def test_synthetic_capture_projects_expected_scopes(self):
        records = [
            event("item/started", thread="alpha", turn="one", item="a"),
            event("item/completed", thread="alpha", turn="one", item="a", exit_code=0),
            event("item/started", thread="alpha", turn="one", item="b"),
            event("item/completed", thread="alpha", turn="one", item="b", exit_code=4),
            event("item/started", thread="beta", turn="two", item="c"),
            event("item/completed", thread="beta", turn="two", item="c", exit_code=0),
        ]
        capture = self.write(records, "multi-scope.jsonl")
        scopes = (("alpha", "one", 2, 1), ("beta", "two", 1, 0))
        for thread, turn, count, nonzero in scopes:
            result = subprocess.run(
                [os.fspath(SCRIPT), os.fspath(capture), "--thread-id", thread,
                 "--turn-id", turn, "--output-cap", "16384"],
                text=True, capture_output=True, timeout=5, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            projection = json.loads(result.stdout)
            self.assertEqual(projection["observed_command_count"], count)
            self.assertEqual(
                sum(c["classification"] == "observed_nonzero" for c in projection["commands"]),
                nonzero,
            )


if __name__ == "__main__":
    unittest.main()
