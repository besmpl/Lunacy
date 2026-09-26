#!/usr/bin/env python3
"""Self-contained public-CLI tests for the offline usage report."""

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "usage_report.py"
sys.path.insert(0, os.fspath(ROOT / "scripts"))
import usage_report as usage_module
sys.path.pop(0)


def cli_usage(**changes):
    usage = {"input_tokens": 17080, "cached_input_tokens": 5888,
             "cache_write_input_tokens": 0, "output_tokens": 2522,
             "reasoning_output_tokens": 1960}
    usage.update(changes)
    return usage


def native_usage(input_tokens, cached_input_tokens=0, cache_write_input_tokens=0,
                 output_tokens=0, reasoning_output_tokens=0):
    return {"input_tokens": input_tokens, "cached_input_tokens": cached_input_tokens,
            "cache_write_input_tokens": cache_write_input_tokens,
            "output_tokens": output_tokens, "reasoning_output_tokens": reasoning_output_tokens}


class UsageReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write_jsonl(self, name, records):
        path = self.root / name
        path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        return path

    def write_bytes(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def manifest(self, sources):
        path = self.root / "manifest.json"
        path.write_text(json.dumps({"schema": "lunacy-usage-input-v1", "sources": sources}), encoding="utf-8")
        return path

    def spec(self, path, kind="cli", phase="focus", boundary=None):
        value = {"path": os.fspath(path), "kind": kind,
                 "assignment": {"phase": phase, "provider": "openai",
                                "model": "gpt-5.6-luna", "effort": "max"}}
        if boundary:
            value["native_boundary"] = boundary
        return value

    def invoke(self, manifest, *extra, cap=65536):
        return subprocess.run([os.fspath(SCRIPT), "--manifest", os.fspath(manifest),
                               "--output-cap", str(cap), *extra], capture_output=True,
                              text=True, timeout=5, check=False)

    def invoke_bytes(self, manifest, *extra, cap=65536, env=None):
        child_env = os.environ.copy()
        child_env["PYTHONDONTWRITEBYTECODE"] = "1"
        child_env.update(env or {})
        return subprocess.run(
            [sys.executable, "-B", os.fspath(SCRIPT), "--manifest", os.fspath(manifest),
             "--output-cap", str(cap), *extra],
            capture_output=True, timeout=5, check=False, env=child_env,
        )

    def manifest_bytes(self, sources):
        return self.write_bytes(
            "manifest-bytes.json",
            (json.dumps({"schema": "lunacy-usage-input-v1", "sources": sources},
                        ensure_ascii=True) + "\n").encode("utf-8"),
        )

    def assert_bounded_refusal(self, result, *forbidden):
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr.count(b"\n"), 1)
        self.assertTrue(result.stderr.endswith(b"\n"))
        self.assertLessEqual(len(result.stderr), 512)
        self.assertTrue(result.stderr.startswith(b"usage report refused: "))
        result.stderr.decode("utf-8", "strict")
        self.assertNotIn(b"Traceback", result.stderr)
        for item in forbidden:
            self.assertNotIn(item, result.stderr)

    def assert_indexed_refusal(self, result, index, *forbidden):
        self.assert_bounded_refusal(result, *forbidden)
        marker = f"sources[{index}]".encode("ascii")
        self.assertEqual(result.stderr.count(marker), 1, result.stderr)

    def ok(self, manifest, *extra):
        result = self.invoke(manifest, *extra)
        self.assertEqual((result.returncode, result.stderr), (0, ""), result.stderr)
        return json.loads(result.stdout)

    def refuse(self, manifest, phrase):
        result = self.invoke(manifest)
        self.assertEqual((result.returncode, result.stdout), (2, ""), result)
        self.assertIn(phrase, result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_cli_exact_cost_shape_and_provenance(self):
        receipt = self.write_jsonl("cli.jsonl", [
            {"type": "thread.started", "thread_id": "thread-a"},
            {"type": "turn.completed", "usage": cli_usage()},
        ])
        report = self.ok(self.manifest([self.spec(receipt)]), "--pricing", "standard-short",
                         "--price-basis", "assigned")
        self.assertEqual(report["totals"]["tokens"], {
            "input": {"known": 17080, "unknown_observations": 0},
            "cache_read": {"known": 5888, "unknown_observations": 0},
            "cache_write": {"known": 0, "unknown_observations": 0},
            "uncached_input": {"known": 11192, "unknown_observations": 0},
            "output": {"known": 2522, "unknown_observations": 0},
            "reasoning": {"known": 1960, "unknown_observations": 0},
        })
        one = report["slices"][0]
        self.assertEqual(one["tokens"], report["totals"]["tokens"])
        self.assertEqual(one["price"]["usd"], "0.00538256")
        self.assertEqual(one["price"]["status"], "counterfactual")
        self.assertEqual(one["phase"], "focus")
        self.assertEqual(one["phase_recorded"], "unknown")
        self.assertEqual(one["attribution_basis"], "manifest.assignment")
        self.assertEqual(one["recorded"], {"provider": None, "model": None, "effort": None})
        self.assertEqual(one["provenance"][0]["lines"], [2])
        self.assertEqual(one["provenance"][0]["sha256"], hashlib.sha256(receipt.read_bytes()).hexdigest())
        self.assertEqual(one["price"]["components_usd"], {
            "uncached_input": "0.00223840", "cache_read": "0.00011776",
            "cache_write": "0.00000000", "output": "0.00302640"})

    def test_cli_counter_basis_ceiling_is_visible_without_changing_counts(self):
        limitation = (
            "A completed CLI total is an observed structural total, not a proven "
            "selected-work delta; fresh 140 and resumed history 100 + new 40 have the "
            "same completed shape. Independent current custody of a fresh, one-turn, "
            "non-resumed, non-forked invocation is required."
        )
        for name, total in (("fresh-40", 40), ("resumed-100-plus-40", 140)):
            with self.subTest(name=name):
                receipt = self.write_jsonl(f"{name}.jsonl", [
                    {"type": "thread.started", "thread_id": name},
                    {"type": "turn.completed", "usage": native_usage(total)},
                ])
                manifest = self.manifest([self.spec(receipt)])
                result = self.invoke(manifest, "--require-complete")
                self.assertEqual((result.returncode, result.stderr), (0, ""))
                report = json.loads(result.stdout)
                self.assertEqual(report["totals"]["tokens"]["input"]["known"], total)
                self.assertEqual(report["slices"][0]["provenance"][0]["basis"], "incremental")
                self.assertEqual(report["coverage"]["status"], "complete")
                self.assertIn(limitation, report["limitations"])
                text = self.invoke(manifest, "--format", "text")
                self.assertEqual((text.returncode, text.stderr), (0, ""))
                self.assertIn("Counter-basis limitation: " + limitation, text.stdout)

    def test_decoder_failures_refuse_at_manifest_and_receipt_seams(self):
        nested = b"[" * 200_000 + b"0" + b"]" * 200_000
        manifest = self.write_bytes("deep-manifest.json", nested)
        manifest_result = self.invoke_bytes(manifest)
        self.assert_bounded_refusal(manifest_result)
        self.assertIn(b"JSON nesting is too deep", manifest_result.stderr)

        receipt = self.write_bytes(
            "deep-receipt.jsonl",
            b'{"type":"turn.completed","usage":{"input_tokens":1},"nested":' +
            b"[" * 200_000 + b"0" + b"]" * 200_000 + b"}\n",
        )
        receipt_manifest = self.manifest_bytes([self.spec(receipt)])
        receipt_result = self.invoke_bytes(receipt_manifest)
        self.assert_bounded_refusal(receipt_result)
        self.assertIn(b"invalid JSONL", receipt_result.stderr)
        self.assertIn(b"JSON nesting is too deep", receipt_result.stderr)

    def test_giant_integer_refusal_uses_deterministic_child_digit_limit(self):
        receipt = self.write_bytes(
            "huge-int.jsonl",
            b'{"type":"turn.completed","usage":{"input_tokens":' + b"9" * 5000 + b"}}\n",
        )
        manifest = self.manifest_bytes([self.spec(receipt)])
        result = self.invoke_bytes(manifest, env={"PYTHONINTMAXSTRDIGITS": "4300"})
        self.assert_bounded_refusal(result, b"5000", b"digits", b"value has")
        self.assertIn(b"JSON value could not be decoded", result.stderr)

    def test_unencodable_json_and_text_reports_refuse_without_substitution(self):
        receipt = self.write_bytes(
            "surrogate.jsonl",
            b'{"type":"thread.started","thread_id":"thread"}\n'
            b'{"type":"turn.completed","provider":"\\ud800",'
            b'"usage":{"input_tokens":17080,"cached_input_tokens":5888,'
            b'"cache_write_input_tokens":0,"output_tokens":2522,'
            b'"reasoning_output_tokens":1960}}\n',
        )
        manifest = self.manifest_bytes([self.spec(receipt)])
        for output_format in ("json", "text"):
            with self.subTest(format=output_format):
                result = self.invoke_bytes(manifest, "--format", output_format)
                self.assert_bounded_refusal(result)
                self.assertEqual(result.stderr,
                                 b"usage report refused: report contains unencodable Unicode\n")

    def test_valid_non_ascii_identity_and_accounting_remain_utf8(self):
        receipt = self.write_bytes(
            "unicode.jsonl",
            b'{"type":"thread.started","thread_id":"caf\\u00e9-\\u9879\\u76ee-\\ud83d\\ude00"}\n'
            b'{"type":"turn.completed","usage":{"input_tokens":17080,'
            b'"cached_input_tokens":5888,"cache_write_input_tokens":0,'
            b'"output_tokens":2522,"reasoning_output_tokens":1960}}\n',
        )
        manifest = self.manifest_bytes([self.spec(receipt)])
        result = self.invoke_bytes(manifest)
        self.assertEqual((result.returncode, result.stderr), (0, b""))
        output = result.stdout.decode("utf-8", "strict")
        report = json.loads(output)
        self.assertEqual(report["sources"][0]["identity"], "café-项目-😀")
        self.assertEqual(report["totals"]["tokens"]["input"],
                         {"known": 17080, "unknown_observations": 0})

    def test_new_decoder_diagnostic_stays_bounded_for_long_multibyte_label(self):
        # Keep every directory/file component below the usual 255-byte
        # filesystem limit while making the diagnostic long independently of
        # the temporary-root length.  Three 160-byte UTF-8 components leave
        # room for the refusal prefix and suffix to exceed the 512-byte cap.
        components = ("😀" * 40,) * 3
        name = Path(*components, "receipt.jsonl")
        for component in (*components, "receipt.jsonl"):
            self.assertLessEqual(len(os.fsencode(component)), 255)
        diagnostic_floor = (
            len(b"usage report refused: invalid JSONL at ")
            + sum(len(os.fsencode(component)) for component in (*components, "receipt.jsonl"))
            + len(b" line 1: JSON nesting is too deep\n")
        )
        self.assertGreater(diagnostic_floor, 512)
        receipt = self.write_bytes(name, b'{"type":"turn.completed","nested":' +
                                    b"[" * 200_000 + b"0" + b"]" * 200_000 + b"}\n")
        manifest = self.manifest_bytes([self.spec(receipt)])
        result = self.invoke_bytes(manifest)
        self.assert_bounded_refusal(result)
        self.assertIn(b"JSON nesting is too deep", result.stderr)

    def test_source_owned_failures_report_only_the_manifest_ordinal(self):
        path_canary = b"path-secret-Round19DoNotDisclose"
        key_canary = b"key-secret-Round19DoNotDisclose"
        value_canary = b"value-secret-Round19DoNotDisclose"
        invalid_root = self.root / path_canary.decode("ascii")
        invalid_root.mkdir()

        malformed = self.write_bytes(
            invalid_root.relative_to(self.root) / "malformed.jsonl",
            b'{"type":"thread.started","thread_id":"bad","' + key_canary +
            b'":"' + value_canary + b'\\r\\n",}\n',
        )
        unrecognized = self.write_jsonl(
            invalid_root.relative_to(self.root) / "unrecognized.jsonl",
            [{key_canary.decode(): value_canary.decode()}],
        )
        mixed = self.write_jsonl(
            invalid_root.relative_to(self.root) / "mixed.jsonl",
            [
                {"type": "thread.started", "thread_id": "mixed"},
                {"type": "session_meta", "payload": {"id": "mixed"}},
            ],
        )
        cli_identity = self.write_jsonl(
            invalid_root.relative_to(self.root) / "cli-identity.jsonl",
            [
                {"type": "thread.started", "thread_id": "first"},
                {"type": "thread.started", "thread_id": "second"},
            ],
        )
        native_fresh = self.write_jsonl(
            invalid_root.relative_to(self.root) / "native-fresh.jsonl",
            [{"type": "event_msg", "payload": {"type": "token_count", "info": {
                "total_token_usage": native_usage(1)}}}],
        )
        native_identity = self.write_jsonl(
            invalid_root.relative_to(self.root) / "native-identity.jsonl",
            [{"type": "session_meta", "payload": {"id": ""}}],
        )
        cases = (
            ("malformed", self.spec(malformed), b"invalid JSONL at line 1"),
            ("unrecognized", self.spec(unrecognized, "auto"), b"recognizable CLI or native"),
            ("mixed", self.spec(mixed, "auto"), b"mixes recognizable CLI and native"),
            ("cli_identity", self.spec(cli_identity), b"multiple thread identities"),
            ("native_fresh", self.spec(native_fresh, "native", boundary="fresh_session"),
             b"fresh_session requires"),
            ("native_identity", self.spec(native_identity, "native"),
             b"session_meta requires"),
        )

        for case, invalid, reason in cases:
            for index in range(3):
                with self.subTest(case=case, index=index):
                    sources = []
                    for slot in range(3):
                        if slot == index:
                            sources.append(invalid)
                        else:
                            valid = self.write_jsonl(
                                f"{case}-valid-{index}-{slot}.jsonl",
                                [
                                    {"type": "thread.started",
                                     "thread_id": f"{case}-{index}-{slot}"},
                                    {"type": "turn.completed", "usage": cli_usage()},
                                ],
                            )
                            sources.append(self.spec(valid))
                    result = self.invoke_bytes(self.manifest_bytes(sources))
                    self.assert_indexed_refusal(
                        result, index, path_canary, key_canary, value_canary,
                    )
                    self.assertIn(reason, result.stderr)

    def test_unrepresentable_paths_refuse_with_only_the_manifest_coordinate(self):
        canary = "SCOUT29_PATH_CANARY_DO_NOT_REFLECT"
        valid = self.write_jsonl("path-boundary-valid.jsonl", [
            {"type": "thread.started", "thread_id": "valid"},
            {"type": "turn.completed", "usage": cli_usage()},
        ])
        invalid_paths = (
            os.fspath(self.root / canary) + "\0nul-tail",
            os.fspath(self.root / canary) + "\ud800surrogate-tail",
        )
        for invalid_path in invalid_paths:
            for index in (0, 1):
                with self.subTest(path=ascii(invalid_path[-16:]), index=index):
                    invalid = self.spec(Path(valid))
                    invalid["path"] = invalid_path
                    sources = [self.spec(valid), self.spec(valid)]
                    sources[index] = invalid
                    result = self.invoke_bytes(self.manifest_bytes(sources))
                    self.assert_indexed_refusal(
                        result, index, canary.encode("ascii"), b"\\u0000", b"\\ud800",
                    )
                    self.assertEqual(
                        result.stderr,
                        f"usage report refused: sources[{index}].path is not representable\n".encode(),
                    )

    def test_resolver_catch_is_narrow_and_precedes_source_acquisition(self):
        source = self.root / "resolver.jsonl"
        manifest = {"sources": [self.spec(source)]}
        info = {"path": "manifest", "sha256": "manifest"}
        representation_errors = (
            ValueError("embedded null"),
            UnicodeEncodeError("utf-8", "\ud800", 0, 1, "surrogate"),
        )
        for error in representation_errors:
            with self.subTest(error=type(error).__name__), mock.patch.object(
                usage_module.Path, "resolve", side_effect=error
            ), mock.patch.object(usage_module, "read_snapshot") as reader:
                with self.assertRaises(usage_module.UsageError) as caught:
                    usage_module.build_report(manifest, info, "none", "recorded", False)
                self.assertEqual(str(caught.exception),
                                 "sources[0].path is not representable")
                reader.assert_not_called()

        with mock.patch.object(
            usage_module.Path, "resolve", side_effect=RuntimeError("inside-resolve-sentinel")
        ), mock.patch.object(usage_module, "read_snapshot") as reader:
            with self.assertRaisesRegex(RuntimeError, "inside-resolve-sentinel"):
                usage_module.build_report(manifest, info, "none", "recorded", False)
            reader.assert_not_called()

        with mock.patch.object(
            usage_module, "source_spec", side_effect=RuntimeError("outside-resolve-sentinel")
        ), mock.patch.object(usage_module.Path, "resolve") as resolver:
            with self.assertRaisesRegex(RuntimeError, "outside-resolve-sentinel"):
                usage_module.build_report(manifest, info, "none", "recorded", False)
            resolver.assert_not_called()

    def test_path_failure_preserves_prior_read_and_accepted_surrogateescape_route(self):
        valid_data = (json.dumps({"type": "thread.started", "thread_id": "valid"}) + "\n" +
                      json.dumps({"type": "turn.completed", "usage": cli_usage()}) +
                      "\n").encode()
        valid_digest = hashlib.sha256(valid_data).hexdigest()
        valid = self.root / "first-valid.jsonl"
        invalid_text = os.fspath(self.root / "invalid") + "\0tail"
        invalid = self.spec(valid)
        invalid["path"] = invalid_text

        def resolve_boundary(path):
            if "\0" in os.fspath(path):
                raise ValueError("embedded null")
            return path

        with mock.patch.object(usage_module.Path, "resolve", autospec=True,
                               side_effect=resolve_boundary), mock.patch.object(
            usage_module, "read_snapshot",
            return_value=(valid, valid_data, valid_digest)
        ) as reader:
            with self.assertRaisesRegex(usage_module.UsageError,
                                        r"sources\[1\]\.path is not representable"):
                usage_module.build_report(
                    {"sources": [self.spec(valid), invalid]},
                    {"path": "manifest", "sha256": "manifest"},
                    "none", "recorded", False,
                )
        self.assertEqual(reader.call_count, 1)

        accepted_text = os.fspath(self.root) + "/accepted-\udcff.jsonl"
        accepted = self.spec(valid)
        accepted["path"] = accepted_text
        with mock.patch.object(usage_module.Path, "resolve", autospec=True,
                               side_effect=lambda path: path), mock.patch.object(
            usage_module, "read_snapshot",
            return_value=(Path(accepted_text), valid_data, valid_digest)
        ):
            report = usage_module.build_report(
                {"sources": [accepted]},
                {"path": "manifest", "sha256": "manifest"},
                "none", "recorded", False,
            )
        self.assertEqual(report["sources"][0]["path"], accepted_text)
        with self.assertRaises(UnicodeEncodeError):
            json.dumps(report, ensure_ascii=False).encode("utf-8")

        accepted_manifest = self.manifest_bytes([accepted])
        real_reader = usage_module.read_snapshot

        def accepted_reader(path, **kwargs):
            if os.fspath(path) == os.fspath(accepted_manifest):
                return real_reader(path, **kwargs)
            return Path(accepted_text), valid_data, valid_digest

        stdout = SimpleNamespace(buffer=io.BytesIO())
        stderr = SimpleNamespace(buffer=io.BytesIO())
        with (mock.patch.object(usage_module.Path, "resolve", autospec=True,
                               side_effect=lambda path: path),
              mock.patch.object(usage_module, "read_snapshot", side_effect=accepted_reader),
              mock.patch.object(usage_module.sys, "stdout", stdout),
              mock.patch.object(usage_module.sys, "stderr", stderr)):
            status = usage_module.main(["--manifest", os.fspath(accepted_manifest)])
        self.assertEqual(status, 2)
        self.assertEqual(stdout.buffer.getvalue(), b"")
        self.assertEqual(
            stderr.buffer.getvalue(),
            b"usage report refused: report contains unencodable Unicode\n",
        )

    def test_malformed_source_locality_is_path_independent_and_ordinal_only(self):
        malformed_bytes = b'{"type":"turn.completed","usage":,}\n'
        names = (
            Path("ordinary.jsonl"),
            Path("name with spaces.jsonl"),
            Path("unicod\u00e9-\u9879\u76ee-\U0001f600.jsonl"),
            Path("x" * 180) / "receipt.jsonl",
            Path("path-canary-Round19DoNotDisclose") / "receipt.jsonl",
        )
        valid = self.write_jsonl("valid.jsonl", [
            {"type": "thread.started", "thread_id": "valid"},
            {"type": "turn.completed", "usage": cli_usage()},
        ])
        observed = []
        for name in names:
            receipt = self.write_bytes(name, malformed_bytes)
            result = self.invoke_bytes(self.manifest_bytes([
                self.spec(valid), self.spec(receipt),
            ]))
            self.assert_indexed_refusal(
                result, 1, os.fsencode(receipt), b"path-canary-Round19DoNotDisclose",
            )
            observed.append(result.stderr)
        self.assertEqual(len(set(observed)), 1)

        moved = self.invoke_bytes(self.manifest_bytes([
            self.spec(self.root / names[0]), self.spec(valid),
        ]))
        self.assert_indexed_refusal(moved, 0, os.fsencode(self.root / names[0]))
        self.assertEqual(moved.stderr, observed[0].replace(b"sources[1]", b"sources[0]"))

        after_duplicate = self.invoke_bytes(self.manifest_bytes([
            self.spec(valid), self.spec(valid), self.spec(self.root / names[0]),
        ]))
        self.assert_indexed_refusal(
            after_duplicate, 2, os.fsencode(self.root / names[0]),
        )
        self.assertEqual(
            after_duplicate.stderr,
            observed[0].replace(b"sources[1]", b"sources[2]"),
        )

    def test_hash_acquisition_and_global_refusal_ownership(self):
        malformed = self.write_bytes("hash-before-parse.jsonl", b"not JSON\n")
        bad_hash = self.spec(malformed)
        bad_hash["expected_sha256"] = "0" * 64
        result = self.invoke_bytes(self.manifest_bytes([self.spec(
            self.write_jsonl("hash-valid.jsonl", [
                {"type": "thread.started", "thread_id": "valid"},
                {"type": "turn.completed", "usage": cli_usage()},
            ])
        ), bad_hash]))
        self.assert_indexed_refusal(result, 1)
        self.assertIn(b"expected_sha256 does not match selected bytes", result.stderr)
        self.assertNotIn(b"invalid JSONL", result.stderr)

        source = self.root / "unreadable.jsonl"
        error = usage_module.EvidenceError(
            "cleanup incomplete (source-close:OSError); source open failed"
        )
        manifest = self.manifest([self.spec(source)])
        real_reader = usage_module.read_snapshot

        def fail_source(path, **kwargs):
            if os.fspath(Path(path).resolve()) == os.fspath(manifest.resolve()):
                return real_reader(path, **kwargs)
            raise error

        stdout = SimpleNamespace(buffer=io.BytesIO())
        stderr = SimpleNamespace(buffer=io.BytesIO())
        with (mock.patch.object(usage_module, "read_snapshot", side_effect=fail_source),
              mock.patch.object(usage_module.sys, "stdout", stdout),
              mock.patch.object(usage_module.sys, "stderr", stderr)):
            status = usage_module.main(["--manifest", os.fspath(manifest)])
        self.assertEqual(status, 2)
        self.assertEqual(stdout.buffer.getvalue(), b"")
        self.assertEqual(
            stderr.buffer.getvalue(),
            b"usage report refused: sources[0]: cleanup incomplete "
            b"(source-close:OSError); source open failed\n",
        )

        one = self.write_jsonl("global-one.jsonl", [
            {"type": "thread.started", "thread_id": "same"},
            {"type": "turn.completed", "usage": cli_usage()},
        ])
        two = self.write_jsonl("global-two.jsonl", [
            {"type": "thread.started", "thread_id": "same"},
            {"type": "turn.completed", "usage": cli_usage()},
        ])
        overlap = self.invoke_bytes(self.manifest_bytes([self.spec(one), self.spec(two)]))
        self.assert_bounded_refusal(overlap)
        self.assertIn(b"overlap_refused", overlap.stderr)
        self.assertNotIn(b"sources[", overlap.stderr)

        conflict = self.spec(one, phase="design")
        duplicate = self.invoke_bytes(self.manifest_bytes([self.spec(one), conflict]))
        self.assert_bounded_refusal(duplicate)
        self.assertIn(b"conflicting duplicate input", duplicate.stderr)
        self.assertNotIn(b"sources[", duplicate.stderr)

        with mock.patch.object(usage_module, "MAX_RECORDS", 2):
            with self.assertRaises(usage_module.UsageError) as caught:
                usage_module.build_report(
                    {"sources": [self.spec(one), self.spec(two)]},
                    {"path": "manifest", "sha256": "manifest"},
                    "none", "recorded", False,
                )
        self.assertEqual(str(caught.exception), "selected receipts exceed 2-record cap")

    def test_missing_fields_are_partial_subtotals_not_zero(self):
        receipt = self.write_jsonl("partial.jsonl", [
            {"type": "thread.started", "thread_id": "thread-a"},
            {"type": "turn.completed", "usage": cli_usage(cached_input_tokens=None)},
            {"type": "turn.completed"},
        ])
        report = self.ok(self.manifest([self.spec(receipt)]), "--pricing", "standard-short",
                         "--price-basis", "assigned")
        self.assertEqual(report["totals"]["status"], "partial")
        self.assertEqual(report["coverage"]["missing_usage"], 1)
        self.assertEqual(report["totals"]["observed_samples"], 2)
        self.assertEqual(report["totals"]["tokens"]["input"], {"known": 17080, "unknown_observations": 0})
        self.assertEqual(report["totals"]["tokens"]["cache_read"], {"known": 0, "unknown_observations": 1})
        price = report["slices"][0]["price"]
        self.assertEqual(price["status"], "partial")
        self.assertIsNone(price["usd"])
        self.assertEqual(price["known_subtotal_usd"], "0.00302640")
        self.assertIn("unknown_uncached_input", price["reasons"])

    def test_no_usage_is_not_complete_zero(self):
        receipt = self.write_jsonl("empty.jsonl", [{"type": "thread.started", "thread_id": "t"}])
        report = self.ok(self.manifest([self.spec(receipt)]))
        self.assertEqual(report["totals"]["status"], "no_usage")
        self.assertEqual(report["totals"]["counted_observations"], 0)
        self.assertEqual(report["totals"]["tokens"]["input"],
                         {"known": 0, "unknown_observations": 1})
        self.assertEqual(report["slices"][0]["tokens"], report["totals"]["tokens"])
        self.assertEqual(report["slices"][0]["provenance"], [])
        self.assertIn("source_without_usage", report["coverage"]["reasons"])

    def test_labeled_source_without_usage_makes_combined_coverage_partial(self):
        complete = self.write_jsonl("complete.jsonl", [
            {"type": "thread.started", "thread_id": "complete"},
            {"type": "turn.completed", "usage": cli_usage()},
        ])
        empty = self.write_jsonl("empty.jsonl", [
            {"type": "thread.started", "thread_id": "empty"},
        ])
        report = self.ok(self.manifest([
            self.spec(complete), self.spec(empty, phase="acceptance")]))
        self.assertEqual(report["coverage"]["status"], "partial")
        self.assertEqual(report["totals"]["tokens"]["input"],
                         {"known": 17080, "unknown_observations": 1})
        acceptance = next(item for item in report["slices"]
                          if item["phase"] == "acceptance")
        self.assertEqual(acceptance["tokens"]["input"],
                         {"known": 0, "unknown_observations": 1})
        self.assertIn("source_without_usage", report["coverage"]["reasons"])

    def test_native_baseline_delta_equal_and_reset(self):
        records = [
            {"type": "session_meta", "payload": {"id": "native", "model_provider": "openai"}},
            {"type": "turn_context", "payload": {"model": "gpt-5.6-luna", "effort": "max"}},
        ]
        for value in (native_usage(10, 2, 0, 3, 1), native_usage(18, 5, 0, 7, 2),
                      native_usage(18, 5, 0, 7, 2), native_usage(1, 0, 0, 1, 0)):
            records.append({"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": value}}})
        receipt = self.write_jsonl("native.jsonl", records)
        report = self.ok(self.manifest([self.spec(receipt, "native")]))
        self.assertEqual(report["coverage"]["baseline_samples"], 1)
        self.assertEqual(report["coverage"]["status"], "partial")
        self.assertEqual(report["totals"]["counted_observations"], 2)
        self.assertEqual(report["totals"]["tokens"]["input"]["known"], 8)
        self.assertIn("counter_reset", report["coverage"]["reasons"])
        self.assertEqual(report["slices"][0]["recorded"],
                         {"provider": "openai", "model": "gpt-5.6-luna", "effort": "max"})

    def test_fresh_session_requires_preceding_meta_and_counts_first(self):
        total = native_usage(17080, 5888, 0, 2522, 1960)
        good = self.write_jsonl("fresh.jsonl", [
            {"type": "session_meta", "payload": {"id": "fresh"}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": total}}},
        ])
        report = self.ok(self.manifest([self.spec(good, "native", boundary="fresh_session")]))
        self.assertEqual(report["totals"]["tokens"]["input"]["known"], 17080)
        boundary = next(d for d in report["diagnostics"] if d["code"] == "fresh_boundary")
        self.assertIn("caller_assertion", boundary["evidence"])
        bad = self.write_jsonl("badfresh.jsonl", [
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": total}}},
            {"type": "session_meta", "payload": {"id": "late"}},
        ])
        self.refuse(self.manifest([self.spec(bad, "native", boundary="fresh_session")]), "preceding")

    def test_metadata_alone_does_not_imply_fresh_and_latest_only_is_partial(self):
        receipt = self.write_jsonl("latest.jsonl", [
            {"type": "session_meta", "payload": {"id": "n"}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"last_token_usage": native_usage(5)}}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": native_usage(10)}}},
        ])
        report = self.ok(self.manifest([self.spec(receipt, "native")]))
        self.assertEqual(report["totals"]["counted_observations"], 0)
        self.assertEqual(report["totals"]["status"], "no_usage")
        self.assertEqual(report["coverage"]["latest_context_only"], 1)
        self.assertEqual(report["totals"]["observed_samples"], 2)

    def test_native_snapshot_markers_surface_unfinished_and_aborted_tasks(self):
        total = native_usage(10, 2, 0, 3, 1)
        complete = self.write_jsonl("native-complete.jsonl", [
            {"type": "session_meta", "payload": {"id": "complete"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
            {"type": "event_msg", "payload": {"type": "token_count",
                                                "info": {"total_token_usage": total}}},
            {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn"}},
        ])
        complete_report = self.ok(self.manifest([
            self.spec(complete, "native", boundary="fresh_session")]))
        self.assertEqual(complete_report["coverage"]["status"], "complete")

        unfinished = self.write_jsonl("native-unfinished.jsonl", [
            {"type": "session_meta", "payload": {"id": "unfinished"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
            {"type": "event_msg", "payload": {"type": "token_count",
                                                "info": {"total_token_usage": total}}},
        ])
        unfinished_report = self.ok(self.manifest([
            self.spec(unfinished, "native", boundary="fresh_session")]))
        self.assertEqual(unfinished_report["coverage"]["status"], "partial")
        self.assertIn("partial_capture", unfinished_report["coverage"]["reasons"])

        aborted = self.write_jsonl("native-aborted.jsonl", [
            {"type": "session_meta", "payload": {"id": "aborted"}},
            {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn"}},
            {"type": "event_msg", "payload": {"type": "token_count",
                                                "info": {"total_token_usage": total}}},
            {"type": "event_msg", "payload": {"type": "turn_aborted", "turn_id": "turn"}},
        ])
        aborted_report = self.ok(self.manifest([
            self.spec(aborted, "native", boundary="fresh_session")]))
        self.assertEqual(aborted_report["coverage"]["status"], "partial")
        self.assertIn("failed_or_interrupted_turn", aborted_report["coverage"]["reasons"])

    def test_known_input_subsets_are_validated_when_a_sibling_is_unknown(self):
        for name, usage in (
                ("read", cli_usage(cached_input_tokens=17081,
                                   cache_write_input_tokens=None)),
                ("write", cli_usage(cached_input_tokens=None,
                                    cache_write_input_tokens=17081))):
            with self.subTest(name=name):
                receipt = self.write_jsonl(f"invalid-{name}.jsonl", [
                    {"type": "thread.started", "thread_id": name},
                    {"type": "turn.completed", "usage": usage},
                ])
                report = self.ok(self.manifest([self.spec(receipt)]))
                self.assertEqual(report["coverage"]["status"], "no_usage")
                self.assertEqual(report["coverage"]["invalid_observations"], 1)
                self.assertEqual(report["totals"]["tokens"]["input"],
                                 {"known": 0, "unknown_observations": 1})

    def test_native_delta_validates_known_input_subset_with_missing_sibling(self):
        for name, first, second in (
                ("read", native_usage(10, 2, None), native_usage(15, 12, None)),
                ("write", native_usage(10, None, 2), native_usage(15, None, 12))):
            with self.subTest(name=name):
                receipt = self.write_jsonl(f"native-delta-{name}.jsonl", [
                    {"type": "session_meta", "payload": {"id": name}},
                    {"type": "event_msg", "payload": {"type": "token_count",
                                                        "info": {"total_token_usage": first}}},
                    {"type": "event_msg", "payload": {"type": "token_count",
                                                        "info": {"total_token_usage": second}}},
                ])
                report = self.ok(self.manifest([self.spec(receipt, "native")]))
                self.assertEqual(report["coverage"]["status"], "no_usage")
                self.assertEqual(report["coverage"]["invalid_observations"], 1)
                detail = next(item["detail"] for item in report["diagnostics"]
                              if item["code"] == "invalid_observation")
                self.assertIn("exceeds input", detail)

    def test_duplicate_file_and_overlap_rules(self):
        one = self.write_jsonl("one.jsonl", [{"type": "thread.started", "thread_id": "same"},
                                              {"type": "turn.completed", "usage": cli_usage()}])
        duplicate = self.ok(self.manifest([self.spec(one), self.spec(one)]))
        self.assertEqual(len(duplicate["sources"]), 1)
        conflict = self.spec(one)
        conflict["assignment"]["phase"] = "design"
        self.refuse(self.manifest([self.spec(one), conflict]), "conflicting duplicate")
        two = self.write_jsonl("two.jsonl", [{"type": "thread.started", "thread_id": "same"},
                                              {"type": "turn.completed", "usage": cli_usage()}])
        self.refuse(self.manifest([self.spec(one), self.spec(two)]), "overlap_refused")
        unknown = self.write_jsonl("unknown.jsonl", [{"type": "turn.completed", "usage": cli_usage()}])
        self.refuse(self.manifest([self.spec(one), self.spec(unknown)]), "overlap_unknown")
        report = self.ok(self.manifest([self.spec(unknown)]))
        self.assertIn("unknown_identity", report["coverage"]["reasons"])

    def test_recorded_basis_unknown_route_is_unpriced_and_long_is_explicit(self):
        receipt = self.write_jsonl("route.jsonl", [{"type": "thread.started", "thread_id": "t"},
                                                    {"type": "turn.completed", "usage": cli_usage()}])
        manifest = self.manifest([self.spec(receipt)])
        recorded = self.ok(manifest, "--pricing", "standard-short")
        self.assertEqual(recorded["slices"][0]["price"]["status"], "unpriced")
        self.assertEqual(recorded["coverage"]["status"], "partial")
        self.assertIn("unpriced_or_partial_cost", recorded["coverage"]["reasons"])
        long = self.ok(manifest, "--pricing", "standard-long", "--price-basis", "assigned")
        self.assertEqual(long["scenario"]["name"], "standard-long")
        self.assertEqual(long["slices"][0]["price"]["usd"], "0.00925192")

    def test_context_change_does_not_fabricate_native_model_attribution(self):
        receipt = self.write_jsonl("contexts.jsonl", [
            {"type": "session_meta", "payload": {"id": "n", "model_provider": "openai"}},
            {"type": "turn_context", "payload": {"model": "gpt-5.6-luna", "effort": "max"}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": native_usage(10)}}},
            {"type": "turn_context", "payload": {"model": "gpt-5.6-sol", "effort": "medium"}},
            {"type": "turn_context", "payload": {"model": "gpt-5.6-luna", "effort": "max"}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": native_usage(20)}}},
        ])
        report = self.ok(self.manifest([self.spec(receipt, "native")]), "--pricing", "standard-short")
        self.assertEqual(report["slices"][0]["recorded"],
                         {"provider": "openai", "model": None, "effort": None})
        self.assertEqual(report["slices"][0]["price"]["status"], "unpriced")
        self.assertIn("context_span", report["coverage"]["reasons"])

    def test_fresh_first_counter_with_multiple_contexts_is_not_route_attributed(self):
        receipt = self.write_jsonl("fresh-contexts.jsonl", [
            {"type": "session_meta", "payload": {"id": "n", "model_provider": "openai"}},
            {"type": "turn_context", "payload": {"model": "gpt-5.6-luna", "effort": "max"}},
            {"type": "turn_context", "payload": {"model": "gpt-5.6-sol", "effort": "medium"}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": native_usage(10)}}},
        ])
        report = self.ok(self.manifest([self.spec(receipt, "native", boundary="fresh_session")]),
                         "--pricing", "standard-short")
        self.assertEqual(report["slices"][0]["recorded"],
                         {"provider": "openai", "model": None, "effort": None})
        self.assertIn("context_span", report["coverage"]["reasons"])

    def test_duplicate_turns_dedupe_or_refuse_and_unfinished_is_partial(self):
        usage = cli_usage()
        receipt = self.write_jsonl("dupe.jsonl", [
            {"type": "thread.started", "thread_id": "t"},
            {"type": "turn.started"},
            {"type": "turn.completed", "turn_id": "turn", "usage": usage},
            {"type": "turn.completed", "turn_id": "turn", "usage": usage},
            {"type": "turn.started"},
            {"type": "turn.started"},
        ])
        report = self.ok(self.manifest([self.spec(receipt)]))
        self.assertEqual(report["totals"]["counted_observations"], 1)
        self.assertEqual(report["coverage"]["status"], "partial")
        self.assertIn("duplicate_observation", report["coverage"]["reasons"])
        self.assertIn("partial_capture", report["coverage"]["reasons"])
        auto = self.spec(receipt, "auto")
        mixed_duplicate = self.ok(self.manifest([self.spec(receipt), auto]))
        self.assertEqual(len(mixed_duplicate["sources"]), 1)
        bad = self.write_jsonl("conflict.jsonl", [
            {"type": "thread.started", "thread_id": "t"},
            {"type": "turn.completed", "turn_id": "turn", "usage": usage},
            {"type": "turn.completed", "turn_id": "turn", "usage": cli_usage(output_tokens=2000)},
        ])
        self.refuse(self.manifest([self.spec(bad)]), "conflicting duplicate")

    def test_invalid_manifest_label_shape_is_bounded_refusal(self):
        receipt = self.write_jsonl("shape.jsonl", [{"type": "thread.started", "thread_id": "t"}])
        spec = self.spec(receipt)
        spec["assignment"]["phase"] = ["not", "hashable"]
        self.refuse(self.manifest([spec]), "phase is not recognized")

    def test_unknown_phase_and_failed_turn_are_visible_partial_coverage(self):
        receipt = self.write_jsonl("failed.jsonl", [
            {"type": "thread.started", "thread_id": "t"},
            {"type": "turn.completed", "usage": cli_usage()},
            {"type": "turn.failed", "error": {"message": "not emitted"}},
        ])
        spec = self.spec(receipt)
        del spec["assignment"]["phase"]
        report = self.ok(self.manifest([spec]))
        self.assertEqual(report["coverage"]["status"], "partial")
        self.assertEqual(report["coverage"]["missing_usage"], 1)
        self.assertEqual(report["totals"]["observed_samples"], 2)
        self.assertEqual(report["slices"][0]["phase"], "unknown")
        self.assertIn("failed_or_interrupted_turn", report["coverage"]["reasons"])
        self.assertIn("unknown_phase", report["coverage"]["reasons"])

    def test_expected_sha256_binds_bytes_before_parsing_and_deduplication(self):
        receipt = self.write_jsonl("pinned.jsonl", [
            {"type": "thread.started", "thread_id": "pinned"},
            {"type": "turn.completed", "usage": cli_usage()},
        ])
        correct = hashlib.sha256(receipt.read_bytes()).hexdigest()
        pinned = self.spec(receipt)
        pinned["expected_sha256"] = correct
        report = self.ok(self.manifest([pinned]))
        self.assertEqual(report["sources"][0]["sha256"], correct)

        receipt.write_text(receipt.read_text() + "\n", encoding="utf-8")
        self.refuse(self.manifest([pinned]), "does not match selected bytes")

        for malformed in (correct.upper(), correct[:-1], None, 7):
            with self.subTest(malformed=malformed):
                bad = self.spec(receipt)
                bad["expected_sha256"] = malformed
                self.refuse(self.manifest([bad]), "exactly 64 lowercase hex")

        malformed_receipt = self.write_bytes("malformed-pinned.jsonl", b"not JSON\n")
        wrong = self.spec(malformed_receipt)
        wrong["expected_sha256"] = "0" * 64
        result = self.invoke(self.manifest([wrong]))
        self.assertEqual((result.returncode, result.stdout), (2, ""))
        self.assertIn("does not match selected bytes", result.stderr)
        self.assertNotIn("invalid JSONL", result.stderr)

        unpinned = self.spec(receipt)
        mismatched = self.spec(receipt)
        mismatched["expected_sha256"] = "0" * 64
        for sources in ([unpinned, mismatched], [mismatched, unpinned]):
            with self.subTest(order="pinned-first" if sources[0] is mismatched else "unpinned-first"):
                self.refuse(self.manifest(sources), "does not match selected bytes")

    def test_source_byte_cap_bounds_acquisition_and_duplicates_read_once(self):
        names = [os.fspath((self.root / f"source-{index}.jsonl").resolve())
                 for index in range(3)]
        manifest = self.manifest([self.spec(Path(name)) for name in names])
        real_read_snapshot = usage_module.read_snapshot
        receipt_reads = []

        supplied_limits = []

        def capped_read(path, **kwargs):
            if os.fspath(Path(path).resolve()) == os.fspath(manifest.resolve()):
                return real_read_snapshot(path)
            receipt_reads.append(path)
            supplied_limits.append(kwargs.get("max_bytes"))
            return Path(path), b"abc", hashlib.sha256(b"abc").hexdigest()

        stdout = SimpleNamespace(buffer=io.BytesIO())
        stderr = SimpleNamespace(buffer=io.BytesIO())
        with (mock.patch.object(usage_module, "TOTAL_SOURCE_CAP", 5),
              mock.patch.object(usage_module, "read_snapshot", side_effect=capped_read),
              mock.patch.object(usage_module.sys, "stdout", stdout),
              mock.patch.object(usage_module.sys, "stderr", stderr)):
            status = usage_module.main(["--manifest", os.fspath(manifest)])
        self.assertEqual(status, 2)
        self.assertEqual(stdout.buffer.getvalue(), b"")
        self.assertIn(b"exceed 5-byte total cap", stderr.buffer.getvalue())
        self.assertEqual(receipt_reads, names[:2])
        self.assertEqual(supplied_limits, [5, 2])

        data = (json.dumps({"type": "thread.started", "thread_id": "one"}) + "\n" +
                json.dumps({"type": "turn.completed", "usage": cli_usage()}) + "\n").encode()
        digest = hashlib.sha256(data).hexdigest()
        duplicate = self.spec(Path(names[0]))
        duplicate["expected_sha256"] = digest
        with (mock.patch.object(usage_module, "TOTAL_SOURCE_CAP", len(data)),
              mock.patch.object(usage_module, "read_snapshot",
                                return_value=(Path(names[0]), data, digest)) as reader):
            report = usage_module.build_report(
                {"sources": [duplicate, duplicate]},
                {"path": "manifest", "sha256": "manifest"}, "none", "recorded", False)
        self.assertEqual(reader.call_count, 1)
        self.assertEqual(len(report["sources"]), 1)

    def test_real_io_aggregate_limit_bounds_second_source_and_default_control(self):
        first = self.write_bytes("first.bin", b"abc")
        second = self.write_bytes("second.bin", b"1234567")
        manifest = {"sources": [self.spec(first), self.spec(second)]}
        real_read = os.read
        events = []

        def observed_read(descriptor, requested):
            data = real_read(descriptor, requested)
            events.append((requested, len(data)))
            return data

        with mock.patch.object(usage_module, "TOTAL_SOURCE_CAP", 5), mock.patch.object(
            os, "read", side_effect=observed_read
        ):
            with self.assertRaisesRegex(usage_module.UsageError, "exceed 5-byte total cap"):
                usage_module.build_report(
                    manifest, {"path": "manifest", "sha256": "manifest"},
                    "none", "recorded", False)
        self.assertEqual(sum(returned for _requested, returned in events), 3)
        self.assertTrue(all(requested <= 6 for requested, _returned in events))

        _path, complete, _digest = usage_module.read_snapshot(os.fspath(second))
        self.assertEqual(complete, b"1234567")

    def test_aggregate_limit_exact_excess_zero_and_failure_precedence(self):
        data = (json.dumps({"type": "thread.started", "thread_id": "one"}) + "\n" +
                json.dumps({"type": "turn.completed", "usage": cli_usage()}) + "\n").encode()
        exact = self.write_bytes("exact.jsonl", data)
        manifest = {"sources": [self.spec(exact)]}
        with mock.patch.object(usage_module, "TOTAL_SOURCE_CAP", len(data)):
            report = usage_module.build_report(
                manifest, {"path": "manifest", "sha256": "manifest"},
                "none", "recorded", False)
        self.assertEqual(report["sources"][0]["sha256"], hashlib.sha256(data).hexdigest())

        with mock.patch.object(usage_module, "TOTAL_SOURCE_CAP", len(data) - 1):
            with self.assertRaisesRegex(usage_module.UsageError, "total cap"):
                usage_module.build_report(
                    manifest, {"path": "manifest", "sha256": "manifest"},
                    "none", "recorded", False)

        empty = self.write_bytes("empty.jsonl", b"")
        with mock.patch.object(usage_module, "TOTAL_SOURCE_CAP", 0):
            empty_report = usage_module.build_report(
                {"sources": [self.spec(empty)]},
                {"path": "manifest", "sha256": "manifest"}, "none", "recorded", False)
            self.assertEqual(empty_report["sources"][0]["sha256"], hashlib.sha256(b"").hexdigest())
            with self.assertRaisesRegex(usage_module.UsageError, "total cap"):
                usage_module.build_report(
                    manifest, {"path": "manifest", "sha256": "manifest"},
                    "none", "recorded", False)

        malformed = self.write_bytes("malformed-after-cap.jsonl", b"not JSON\n")
        later = self.spec(malformed)
        later["expected_sha256"] = "0" * 64
        with mock.patch.object(usage_module, "TOTAL_SOURCE_CAP", 1):
            with self.assertRaises(usage_module.UsageError) as caught:
                usage_module.build_report(
                    {"sources": [later]}, {"path": "manifest", "sha256": "manifest"},
                    "none", "recorded", False)
        self.assertIn("total cap", str(caught.exception))
        self.assertNotIn("selected bytes", str(caught.exception))
        self.assertNotIn("invalid JSONL", str(caught.exception))

    def test_aggregate_limit_duplicate_hash_validation_without_reread(self):
        data = (json.dumps({"type": "thread.started", "thread_id": "one"}) + "\n" +
                json.dumps({"type": "turn.completed", "usage": cli_usage()}) + "\n").encode()
        source = self.write_bytes("duplicate.jsonl", data)
        good = self.spec(source)
        good["expected_sha256"] = hashlib.sha256(data).hexdigest()
        bad = self.spec(source)
        bad["expected_sha256"] = "0" * 64
        real_reader = usage_module.read_snapshot
        with mock.patch.object(usage_module, "TOTAL_SOURCE_CAP", len(data)), mock.patch.object(
            usage_module, "read_snapshot", wraps=real_reader
        ) as reader:
            with self.assertRaisesRegex(usage_module.UsageError, "does not match selected bytes"):
                usage_module.build_report(
                    {"sources": [good, bad]}, {"path": "manifest", "sha256": "manifest"},
                    "none", "recorded", False)
        self.assertEqual(reader.call_count, 1)

    def test_aggregate_limit_cleanup_detail_survives_mapping(self):
        error = usage_module.EvidenceError("source exceeds lower caller byte limit")
        error._caller_limit = True
        error._cleanup_errors = [("source-close", OSError("close failed"))]
        error.args = ("cleanup incomplete (source-close:OSError); source exceeds lower caller byte limit",)
        source = self.write_bytes("source.jsonl", b"x")
        with mock.patch.object(usage_module, "TOTAL_SOURCE_CAP", 1), mock.patch.object(
            usage_module, "read_snapshot", side_effect=error
        ):
            with self.assertRaises(usage_module.UsageError) as caught:
                usage_module.build_report(
                    {"sources": [self.spec(source)]},
                    {"path": "manifest", "sha256": "manifest"}, "none", "recorded", False)
        self.assertIn("cleanup incomplete (source-close:OSError)", str(caught.exception))
        self.assertIn("exceed 1-byte total cap", str(caught.exception))

    def test_require_complete_exit_semantics_and_output_precedence(self):
        complete = self.write_jsonl("strict-complete.jsonl", [
            {"type": "thread.started", "thread_id": "complete"},
            {"type": "turn.completed", "usage": cli_usage()},
        ])
        complete_manifest = self.manifest([self.spec(complete)])
        complete_result = self.invoke(complete_manifest, "--require-complete")
        self.assertEqual((complete_result.returncode, complete_result.stderr), (0, ""))
        self.assertEqual(json.loads(complete_result.stdout)["coverage"]["status"], "complete")

        empty = self.write_jsonl("strict-empty.jsonl", [
            {"type": "thread.started", "thread_id": "empty"},
        ])
        empty_manifest = self.manifest([self.spec(empty)])
        default_result = self.invoke(empty_manifest)
        self.assertEqual(default_result.returncode, 0)
        strict_json = self.invoke(empty_manifest, "--require-complete")
        self.assertEqual((strict_json.returncode, strict_json.stderr), (3, ""))
        strict_report = json.loads(strict_json.stdout)
        self.assertEqual(strict_report["coverage"]["status"], "no_usage")
        self.assertEqual(strict_report["totals"]["tokens"]["input"]["unknown_observations"], 1)

        partial = self.write_jsonl("strict-partial.jsonl", [
            {"type": "thread.started", "thread_id": "partial"},
            {"type": "turn.completed", "usage": cli_usage(cached_input_tokens=None)},
        ])
        partial_manifest = self.manifest([self.spec(partial)])
        strict_text = self.invoke(partial_manifest, "--require-complete", "--format", "text")
        self.assertEqual((strict_text.returncode, strict_text.stderr), (3, ""))
        self.assertIn("Coverage: partial", strict_text.stdout)
        self.assertIn("read 0 + ?x1", strict_text.stdout)

        capped = self.invoke(empty_manifest, "--require-complete", cap=256)
        self.assertEqual((capped.returncode, capped.stdout), (2, ""))
        malformed = self.write_bytes("strict-malformed.jsonl", b"not JSON\n")
        malformed_result = self.invoke(self.manifest([self.spec(malformed)]),
                                       "--require-complete")
        self.assertEqual((malformed_result.returncode, malformed_result.stdout), (2, ""))
        self.assertIn("invalid JSONL", malformed_result.stderr)

    def test_text_matches_json_and_bounds_and_malformed_refuse(self):
        receipt = self.write_jsonl("text.jsonl", [{"type": "thread.started", "thread_id": "t"},
                                                   {"type": "turn.completed", "usage": cli_usage()}])
        manifest = self.manifest([self.spec(receipt)])
        text = self.invoke(manifest, "--pricing", "standard-short", "--price-basis", "assigned", "--format", "text")
        self.assertEqual(text.returncode, 0, text.stderr)
        self.assertIn("0.00538256", text.stdout)
        self.assertIn("2026-09-10 USD", text.stdout)
        self.assertIn("uncached 11192", text.stdout)
        capped = self.invoke(manifest, "--include-observations", cap=256)
        self.assertEqual((capped.returncode, capped.stdout), (2, ""))
        malformed = self.root / "malformed.jsonl"
        malformed.write_text('{"type":"turn.completed",}', encoding="utf-8")
        self.refuse(self.manifest([self.spec(malformed)]), "invalid JSONL")


if __name__ == "__main__":
    unittest.main()
