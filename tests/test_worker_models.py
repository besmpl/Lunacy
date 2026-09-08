import json
import io
from unittest.mock import Mock, patch
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest


REPOSITORY = Path(__file__).resolve().parents[1]
SCRIPT = REPOSITORY / "scripts/worker_models.py"


def model(model_id, display, efforts, default, *, hidden=False, picker_id=None):
    return {
        "id": model_id if picker_id is None else picker_id,
        "model": model_id,
        "displayName": display,
        "description": f"{display} description",
        "hidden": hidden,
        "supportedReasoningEfforts": [
            {"reasoningEffort": effort, "description": effort} for effort in efforts
        ],
        "defaultReasoningEffort": default,
    }


def complete_catalog():
    return {
        "data": [
            model("gpt-5.6-luna", "GPT-5.6-Luna", ["low", "medium", "high", "max"], "medium"),
            model("gpt-5.6-sol", "GPT-5.6-Sol", ["low", "medium", "high", "max"], "low"),
            model("gpt-6-astra", "GPT-6-Astra", ["low", "medium", "high", "max", "ultra"], "medium"),
            model("opencode-go/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor · OpenCode Go", ["low"], "low"),
        ],
        "nextCursor": None,
    }


def load_worker_models():
    spec = importlib.util.spec_from_file_location("worker_models_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class WorkerModelsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def write_catalog(self, value=None, name="catalog.json"):
        path = self.base / name
        path.write_text(json.dumps(complete_catalog() if value is None else value))
        return path

    def invoke(self, *args, timeout=5):
        return subprocess.run(
            [sys.executable, "-B", os.fspath(SCRIPT), *map(os.fspath, args)],
            text=True, capture_output=True, timeout=timeout, check=False,
        )

    def resolve(self, *args, catalog=None):
        path = self.write_catalog(catalog)
        result = self.invoke("resolve", "--catalog", path, *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def fake_codex(self, pages, *, error_id=None, repeat_cursor=False, marker=None,
                   exit_code=0, hang=False, pid_marker=None, cursor_override=None):
        path = self.base / "fake codex"
        program = f"""\
            #!{sys.executable}
            import json, os, pathlib, sys, time
            pages = {pages!r}
            error_id = {error_id!r}
            repeat_cursor = {repeat_cursor!r}
            marker = {os.fspath(marker) if marker else None!r}
            exit_code = {exit_code!r}
            hang = {hang!r}
            pid_marker = {os.fspath(pid_marker) if pid_marker else None!r}
            cursor_override = {cursor_override!r}
            if pid_marker:
                pathlib.Path(pid_marker).write_text(str(os.getpid()))
            try:
                for line in sys.stdin:
                    request = json.loads(line)
                    method = request.get("method")
                    if method == "initialize":
                        print(json.dumps({{"method":"server/notice","params":{{"safe":True}}}}), flush=True)
                        print(json.dumps({{"id":request["id"],"result":{{"userAgent":"fake"}}}}), flush=True)
                    elif method == "model/list":
                        if hang:
                            time.sleep(60)
                        if request["id"] == error_id:
                            print(json.dumps({{"id":request["id"],"error":{{"code":-1,"message":"no page"}}}}), flush=True)
                            continue
                        number = request["id"] - 2
                        data = pages[number]
                        if repeat_cursor:
                            cursor = "again"
                        elif cursor_override is not None:
                            cursor = cursor_override
                        else:
                            cursor = None if number + 1 == len(pages) else "page-" + str(number + 1)
                        print(json.dumps({{"id":request["id"],"result":{{"data":data,"nextCursor":cursor}}}}), flush=True)
            finally:
                if marker:
                    pathlib.Path(marker).write_text("eof")
            raise SystemExit(exit_code)
        """
        path.write_text(textwrap.dedent(program))
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return path

    def test_omitted_overrides_preserve_named_role_defaults(self):
        output = self.resolve()
        self.assertFalse(output["launchPerformed"])
        self.assertEqual(
            (output["roles"]["bulk"]["model"], output["roles"]["bulk"]["effort"]),
            ("gpt-5.6-luna", "max"),
        )
        self.assertEqual(output["roles"]["bulk"]["namedAlias"], "luna")
        self.assertEqual(
            (output["roles"]["judgment"]["model"], output["roles"]["judgment"]["effort"]),
            ("gpt-5.6-sol", "medium"),
        )
        self.assertEqual(output["roles"]["judgment"]["namedAlias"], "sol-medium")
        self.assertEqual(output["roles"]["judgment"]["codexExecArgs"], [
            "codex", "exec", "-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="medium"'
        ])

    def test_exact_id_and_exact_display_label_examples(self):
        output = self.resolve(
            "--bulk-model", "Muse Spark 1.3 Contributor · OpenCode Go", "--bulk-effort", "low",
            "--judgment-model", "gpt-6-astra", "--judgment-effort", "low",
        )
        self.assertEqual(output["roles"]["bulk"]["model"], "opencode-go/muse-spark-1.3-contributor")
        self.assertEqual(output["roles"]["judgment"]["effort"], "low")
        self.assertIsNone(output["roles"]["bulk"]["namedAlias"])

    def test_catalog_default_requires_express_switch_and_tracks_snapshot(self):
        refused = self.invoke(
            "resolve", "--catalog", self.write_catalog(), "--bulk-model", "gpt-6-astra"
        )
        self.assertEqual(refused.returncode, 2)
        self.assertIn("requires --bulk-effort", refused.stderr)
        catalog = complete_catalog()
        catalog["data"][2]["defaultReasoningEffort"] = "high"
        output = self.resolve(
            "--bulk-model", "gpt-6-astra", "--use-catalog-default-effort", catalog=catalog
        )
        self.assertEqual(output["roles"]["bulk"]["effort"], "high")

    def test_effort_only_overrides_default_model_and_clears_changed_alias(self):
        output = self.resolve("--bulk-effort", "high")
        self.assertEqual((output["roles"]["bulk"]["model"], output["roles"]["bulk"]["effort"]),
                         ("gpt-5.6-luna", "high"))
        self.assertIsNone(output["roles"]["bulk"]["namedAlias"])
        self.assertEqual(output["roles"]["judgment"]["namedAlias"], "sol-medium")
        same = self.resolve("--bulk-effort", "max")
        self.assertEqual(same["roles"]["bulk"]["namedAlias"], "luna")

    def test_implicit_defaults_require_canonical_catalog_rows(self):
        for role in ("bulk", "judgment"):
            missing = "gpt-5.6-luna" if role == "bulk" else "gpt-5.6-sol"
            collision = "gpt-5.6-sol" if role == "bulk" else "gpt-5.6-luna"
            for alias_field in ("id", "displayName"):
                for effort_only in (False, True):
                    with self.subTest(role=role, alias_field=alias_field, effort_only=effort_only):
                        catalog = complete_catalog()
                        catalog["data"] = [row for row in catalog["data"] if row["model"] != missing]
                        row = next(row for row in catalog["data"] if row["model"] == collision)
                        row[alias_field] = missing
                        arguments = [f"--{role}-effort", "high"] if effort_only else []
                        result = self.invoke(
                            "resolve", "--catalog", self.write_catalog(
                                catalog, f"missing-{role}-{alias_field}-{effort_only}.json"
                            ), *arguments,
                        )
                        self.assertEqual(result.returncode, 2)
                        self.assertEqual(result.stdout, "")
                        self.assertIn("canonical default", result.stderr)
                        self.assertIn(missing, result.stderr)
                        self.assertNotIn("does not support reasoning effort", result.stderr)

    def test_catalog_default_effort_switch_does_not_substitute_implicit_model(self):
        for role, missing, collision in (
            ("bulk", "gpt-5.6-luna", "gpt-5.6-sol"),
            ("judgment", "gpt-5.6-sol", "gpt-5.6-luna"),
        ):
            for alias_field in ("id", "displayName"):
                catalog = complete_catalog()
                catalog["data"] = [row for row in catalog["data"] if row["model"] != missing]
                next(row for row in catalog["data"] if row["model"] == collision)[alias_field] = missing
                result = self.invoke(
                    "resolve", "--catalog", self.write_catalog(catalog, f"switch-{role}-{alias_field}.json"),
                    "--use-catalog-default-effort",
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertIn("canonical default", result.stderr)

    def test_present_implicit_canonical_default_wins_over_colliding_alias(self):
        for alias_field in ("id", "displayName"):
            catalog = complete_catalog()
            catalog["data"][0]["id"] = "picker/luna"
            catalog["data"][2][alias_field] = "gpt-5.6-luna"
            result = self.resolve(catalog=catalog)
            self.assertEqual(result["roles"]["bulk"]["model"], "gpt-5.6-luna")
            self.assertEqual(result["roles"]["bulk"]["namedAlias"], "luna")

    def test_explicit_alias_remains_available_when_spelling_matches_missing_default(self):
        for role, missing, collision in (
            ("bulk", "gpt-5.6-luna", "gpt-5.6-sol"),
            ("judgment", "gpt-5.6-sol", "gpt-5.6-luna"),
        ):
            for alias_field in ("id", "displayName"):
                catalog = complete_catalog()
                catalog["data"] = [row for row in catalog["data"] if row["model"] != missing]
                next(row for row in catalog["data"] if row["model"] == collision)[alias_field] = missing
                result = self.resolve(
                    f"--{role}-model", missing, f"--{role}-effort", "high", catalog=catalog
                )
                self.assertEqual(result["roles"][role]["model"], collision)
                self.assertEqual(result["roles"][role]["effort"], "high")
                self.assertEqual(result["roles"][role]["selection"], "explicit")
                self.assertIsNone(result["roles"][role]["namedAlias"])

    def test_unsupported_pair_refuses(self):
        path = self.write_catalog()
        result = self.invoke(
            "resolve", "--catalog", path, "--bulk-model",
            "opencode-go/muse-spark-1.3-contributor", "--bulk-effort", "max",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("does not support", result.stderr)

    def test_dispatch_model_is_canonical_and_picker_alias_must_be_unambiguous(self):
        catalog = complete_catalog()
        catalog["data"].append(model(
            "dispatch/custom", "Custom Label", ["low"], "low", picker_id="picker/custom"
        ))
        by_picker = self.resolve("--bulk-model", "picker/custom", "--bulk-effort", "low", catalog=catalog)
        self.assertEqual(by_picker["roles"]["bulk"]["model"], "dispatch/custom")
        self.assertEqual(by_picker["roles"]["bulk"]["codexExecArgs"][3], "dispatch/custom")
        by_model = self.resolve("--bulk-model", "dispatch/custom", "--bulk-effort", "low", catalog=catalog)
        self.assertEqual(by_model["roles"]["bulk"]["model"], "dispatch/custom")

        canonical_collision = complete_catalog()
        canonical_collision["data"].extend([
            model("dispatch/canonical", "Canonical", ["low"], "low", picker_id="picker/canonical"),
            model("dispatch/other", "Other", ["low"], "low", picker_id="dispatch/canonical"),
        ])
        canonical = self.resolve(
            "--bulk-model", "dispatch/canonical", "--bulk-effort", "low",
            catalog=canonical_collision,
        )
        self.assertEqual(canonical["roles"]["bulk"]["displayName"], "Canonical")

        collision = complete_catalog()
        collision["data"].extend([
            model("dispatch/a", "Label A", ["low"], "low", picker_id="shared"),
            model("dispatch/b", "shared", ["low"], "low", picker_id="picker/b"),
        ])
        result = self.invoke(
            "resolve", "--catalog", self.write_catalog(collision, "collision.json"),
            "--bulk-model", "shared", "--bulk-effort", "low",
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("ambiguous", result.stderr)

    def test_fuzzy_absent_and_ambiguous_display_labels_refuse(self):
        catalog = complete_catalog()
        catalog["data"].append(model("other-astra", "GPT-6-Astra", ["low"], "low"))
        path = self.write_catalog(catalog)
        for query, phrase in [("Astra light", "not found"), ("GPT-6-Astra", "ambiguous")]:
            result = self.invoke(
                "resolve", "--catalog", path, "--bulk-model", query, "--bulk-effort", "low"
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn(phrase, result.stderr)

    def test_hidden_duplicate_and_incomplete_catalogs_refuse(self):
        cases = []
        hidden = complete_catalog(); hidden["data"][0]["hidden"] = True; cases.append((hidden, "hidden"))
        duplicate = complete_catalog(); duplicate["data"].append(dict(duplicate["data"][0])); cases.append((duplicate, "duplicate picker id"))
        incomplete = complete_catalog(); incomplete["nextCursor"] = "more"; cases.append((incomplete, "incomplete"))
        partial = {"data": []}; cases.append((partial, "exactly data and nextCursor"))
        for number, (catalog, phrase) in enumerate(cases):
            result = self.invoke("resolve", "--catalog", self.write_catalog(catalog, f"bad-{number}.json"))
            self.assertEqual(result.returncode, 2)
            self.assertIn(phrase, result.stderr)

    def test_malformed_duplicate_keys_constants_and_invalid_efforts_refuse(self):
        raw_cases = [
            ('{"data":[],"data":[],"nextCursor":null}', "duplicate JSON object key"),
            ('{"data":[', "not complete valid JSON"),
            ('{"data":[],"nextCursor":NaN}', "nonstandard JSON constant"),
        ]
        for number, (raw, phrase) in enumerate(raw_cases):
            path = self.base / f"raw-{number}.json"; path.write_text(raw)
            result = self.invoke("resolve", "--catalog", path)
            self.assertEqual(result.returncode, 2)
            self.assertIn(phrase, result.stderr)
        bad = complete_catalog()
        bad["data"][0]["supportedReasoningEfforts"].append({"reasoningEffort": "max"})
        result = self.invoke("resolve", "--catalog", self.write_catalog(bad, "efforts.json"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("duplicate reasoning effort", result.stderr)

    def test_resolve_never_invokes_codex_or_any_model(self):
        sentinel = self.base / "launched"
        fake = self.base / "codex"
        fake.write_text(f"#!/bin/sh\ntouch {sentinel!s}\n")
        fake.chmod(0o755)
        environment = dict(os.environ, PATH=os.fspath(self.base))
        result = subprocess.run(
            [sys.executable, "-B", os.fspath(SCRIPT), "resolve", "--catalog", os.fspath(self.write_catalog())],
            text=True, capture_output=True, timeout=5, check=False, env=environment,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(sentinel.exists())

    def test_fake_app_server_catalog_paginates_and_preserves_models(self):
        catalog = complete_catalog()
        marker = self.base / "closed"
        fake = self.fake_codex([catalog["data"][:2], catalog["data"][2:]], marker=marker)
        result = self.invoke("catalog", "--codex", fake)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output, catalog)
        self.assertEqual(output["data"][0]["description"], "GPT-5.6-Luna description")
        self.assertEqual(marker.read_text(), "eof")

    def test_fake_app_server_error_and_pagination_stall_fail_and_cleanup(self):
        catalog = complete_catalog()
        for number, options in enumerate(({"error_id": 3}, {"repeat_cursor": True})):
            marker = self.base / f"closed-{number}"
            fake = self.fake_codex([catalog["data"][:2], catalog["data"][2:]], marker=marker, **options)
            result = self.invoke("catalog", "--codex", fake)
            self.assertEqual(result.returncode, 2)
            self.assertTrue("failed" in result.stderr or "cursor repeated" in result.stderr)
            self.assertEqual(marker.read_text(), "eof")

    def test_fake_app_server_malformed_page_is_rejected(self):
        bad = complete_catalog()
        bad["data"][0]["hidden"] = True
        fake = self.fake_codex([bad["data"]])
        result = self.invoke("catalog", "--codex", fake)
        self.assertEqual(result.returncode, 2)
        self.assertIn("hidden", result.stderr)

    def test_fake_app_server_nonzero_exit_is_not_masked(self):
        fake = self.fake_codex([complete_catalog()["data"]], exit_code=7)
        result = self.invoke("catalog", "--codex", fake)
        self.assertEqual(result.returncode, 2)
        self.assertIn("exited with status 7", result.stderr)

    def test_fake_app_server_deadline_reaps_fake_leader(self):
        module = load_worker_models()
        module.DEADLINE_SECONDS = 0.75
        pid_marker = self.base / "pid"
        fake = self.fake_codex([complete_catalog()["data"]], hang=True, pid_marker=pid_marker)
        with self.assertRaisesRegex(module.WorkerModelError, "deadline exceeded"):
            module.read_live_catalog(os.fspath(fake))
        pid = int(pid_marker.read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_fake_app_server_output_and_page_limits_fail_closed(self):
        module = load_worker_models()
        module.CATALOG_CAP = 1024
        large = complete_catalog()
        large["data"][0]["description"] = "x" * 4096
        fake = self.fake_codex([large["data"]])
        with self.assertRaisesRegex(module.WorkerModelError, "output exceeds"):
            module.read_live_catalog(os.fspath(fake))

        module = load_worker_models()
        module.MAX_PAGES = 2
        data = complete_catalog()["data"]
        fake = self.fake_codex([data[:1], data[1:2], data[2:]])
        with self.assertRaisesRegex(module.WorkerModelError, "2-page limit"):
            module.read_live_catalog(os.fspath(fake))

        module = load_worker_models()
        fake = self.fake_codex([data[:1], data[1:]], cursor_override="x" * 1025)
        with self.assertRaisesRegex(module.WorkerModelError, "nextCursor exceeds"):
            module.read_live_catalog(os.fspath(fake))

    def test_catalog_input_must_be_a_regular_file_without_fifo_blocking(self):
        result = self.invoke("resolve", "--catalog", self.base)
        self.assertEqual(result.returncode, 2)
        self.assertIn("regular file", result.stderr)
        if hasattr(os, "mkfifo"):
            fifo = self.base / "catalog.fifo"
            os.mkfifo(fifo)
            result = self.invoke("resolve", "--catalog", fifo)
            self.assertEqual(result.returncode, 2)
            self.assertIn("regular file", result.stderr)

    def test_missing_executable_and_cli_argument_errors_are_bounded(self):
        result = self.invoke("catalog", "--codex", self.base / "missing")
        self.assertEqual(result.returncode, 2)
        self.assertIn("cannot start", result.stderr)
        result = self.invoke("resolve")
        self.assertEqual(result.returncode, 2)
        self.assertLessEqual(len(result.stderr.encode()), 512)
        self.assertNotIn("Traceback", result.stderr)

    def test_raw_publication_and_offline_numeric_metadata(self):
        for token in ("1e400", "-1e400", "1.234567890123456789", "1e-400"):
            catalog = complete_catalog()
            catalog["data"][-1]["extra"] = "TOKEN"
            raw = json.dumps(catalog, ensure_ascii=False).replace('"TOKEN"', token)
            path = self.base / "raw.json"; path.write_text(raw)
            self.assertEqual(self.invoke("resolve", "--catalog", path).returncode, 0)
            # Preserve numeric lexemes on the actual fake-server wire, on page two.
            pages = [json.dumps({"data": catalog["data"][:-1], "nextCursor":"next"}), json.dumps({"data": catalog["data"][-1:], "nextCursor":None}).replace('"TOKEN"', token)]
            fake = self.base / "raw-server"
            fake.write_text(f"#!{sys.executable}\nimport json,sys\npages={pages!r}\nfor line in sys.stdin:\n r=json.loads(line)\n if r.get('method')=='initialize': print('{{\"id\":1,\"result\":{{}}}}',flush=True)\n elif r.get('method')=='model/list': print('{{\"id\":'+str(r['id'])+',\"result\":'+pages[r['id']-2]+'}}',flush=True)\n")
            fake.chmod(0o755)
            result = self.invoke("catalog", "--codex", fake)
            if token in ("1e400", "-1e400"):
                self.assertEqual(result.returncode, 2); self.assertEqual(result.stdout, "")
                self.assertNotIn("Traceback", result.stderr)
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), json.loads(raw))

    def test_effort_validation_order_and_original_array(self):
        catalog = complete_catalog(); row = catalog["data"][0]
        row["supportedReasoningEfforts"] = [{"reasoningEffort":f"unusual-{i}", "description":str(i)} for i in range(80)] + [{"reasoningEffort":"max"}]
        row["defaultReasoningEffort"] = "max"
        self.assertEqual(self.resolve("--bulk-model", row["model"], "--use-catalog-default-effort", catalog=catalog)["roles"]["bulk"]["effort"], "max")
        fake = self.fake_codex([catalog["data"]]); result = self.invoke("catalog", "--codex", fake)
        self.assertEqual(json.loads(result.stdout), catalog)
        for entries, phrase in (([{"reasoningEffort":"a"},{"reasoningEffort":"b"},{"reasoningEffort":"a","description":"different"},None], "duplicate reasoning effort"), ([None,{"reasoningEffort":"a"},{"reasoningEffort":"a"}], "must be an object"), ([], "nonempty array"), ([{"reasoningEffort":""}], "nonempty string"), ([{"reasoningEffort":3}], "nonempty string"), ([{"reasoningEffort":"other"}], "default reasoning effort is unsupported")):
            row["supportedReasoningEfforts"] = entries
            result = self.invoke("resolve", "--catalog", self.write_catalog(catalog))
            self.assertEqual(result.returncode, 2); self.assertIn(phrase, result.stderr)


class LifecycleBoundaryTests(unittest.TestCase):
    def exercise(self, *, primary=None, selector_error=None, register_error=None, close_errors=None, waits=None, signals=None):
        module = load_worker_models()
        process = Mock(pid=12345, returncode=None)
        selector = Mock()
        selector.register.side_effect = register_error
        for stage, error in (close_errors or {}).items():
            (selector if stage == "selector" else getattr(process, stage)).close.side_effect = error
        outcomes = iter(waits or [0])
        def wait(timeout):
            outcome = next(outcomes)
            if isinstance(outcome, BaseException):
                raise outcome
            process.returncode = outcome
            return outcome
        process.wait.side_effect = wait
        request = Mock(side_effect=primary) if primary else Mock(side_effect=[{}, complete_catalog()])
        with patch.object(module.subprocess, "Popen", return_value=process), patch.object(module.selectors, "DefaultSelector", side_effect=selector_error, return_value=selector), patch.object(module, "_request", request), patch.object(module, "_write_message"), patch.object(module.os, "killpg", side_effect=signals) as kill:
            try:
                result = module.read_live_catalog("fake")
                error = None
            except BaseException as exc:
                result, error = None, exc
        return module, process, selector, kill, result, error

    def test_acquisition_and_independent_cleanup(self):
        for stage in ("selector", "stdin", "stdout"):
            with self.subTest(stage=stage):
                m, p, s, k, result, error = self.exercise(close_errors={stage: OSError("close")})
                self.assertIsInstance(error, m.WorkerModelError)
                self.assertIsNone(result)
                p.stdin.close.assert_called_once(); p.stdout.close.assert_called_once(); p.wait.assert_called_once()
        m, p, s, k, result, error = self.exercise(selector_error=OSError("construct"))
        self.assertIsInstance(error, m.WorkerModelError)
        p.stdin.close.assert_called_once(); p.stdout.close.assert_called_once(); p.wait.assert_called_once()

    def test_registration_and_nonzero_cleanup_precedence(self):
        m, p, s, k, result, error = self.exercise(register_error=ValueError("register"))
        self.assertIsInstance(error, m.WorkerModelError)
        self.assertEqual(str(error), "app-server stdout cannot be monitored")
        p.stdout.close.assert_called_once()
        m, p, s, k, result, error = self.exercise(waits=[7], close_errors={"stdout":OSError("close")})
        self.assertIn("status 7", str(error)); self.assertEqual(error._cleanup_errors[0][0], "stdout-close")

    def test_bounded_combined_diagnostic_retains_objects(self):
        m = load_worker_models(); primary = m.WorkerModelError("x" * 2000)
        secondary = RuntimeError("unexpected")
        try:
            m._raise_with_cleanup(primary, [("writer-close", secondary)])
        except m.WorkerModelError as error:
            self.assertIs(error, primary)
        stdout = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        stderr = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        with patch.object(m, "read_live_catalog", side_effect=primary), patch.object(m.sys, "stdout", stdout), patch.object(m.sys, "stderr", stderr):
            self.assertEqual(m.main(["catalog"]), 2)
        self.assertEqual(stdout.buffer.getvalue(), b"")
        diagnostic = stderr.buffer.getvalue()
        self.assertLessEqual(len(diagnostic), 512)
        self.assertIn(b"cleanup incomplete (writer-close:RuntimeError)", diagnostic)
        self.assertIs(primary._cleanup_errors[0][1], secondary)

    def test_writer_acquisition_registration_and_close_failures(self):
        for stage in ("construct", "register", "close"):
            m = load_worker_models(); process = Mock(); selector = Mock()
            error = OSError(stage)
            if stage != "construct": getattr(selector, stage).side_effect = error
            with patch.object(m.selectors, "DefaultSelector", side_effect=error if stage == "construct" else None, return_value=selector), patch.object(m.os, "set_blocking"), patch.object(m.os, "write", return_value=1000):
                with self.assertRaises(m.WorkerModelError):
                    m._write_message(process, {}, m.time.monotonic()+1)
            if stage != "construct": selector.close.assert_called_once()

    def test_primary_identity_secondary_and_interruption(self):
        for secondary in (OSError("close"), RuntimeError("bug")):
            primary = ValueError("original")
            m, p, s, k, result, error = self.exercise(primary=primary, close_errors={"selector": secondary})
            self.assertIs(error, primary)
            self.assertIn(("selector-close", secondary), error._cleanup_errors)
            p.stdout.close.assert_called_once()
        unexpected = RuntimeError("bug")
        self.assertIs(self.exercise(close_errors={"stdin": unexpected})[-1], unexpected)
        self.assertIs(self.exercise(waits=[7], close_errors={"stdin": unexpected})[-1], unexpected)
        for interruption in (KeyboardInterrupt(), SystemExit(9)):
            self.assertIs(self.exercise(primary=ValueError("original"), close_errors={"stdin": interruption})[-1], interruption)

    def test_cleanup_resource_exception_and_interruption_are_not_refusals(self):
        for exception in (MemoryError("cleanup"), RecursionError("cleanup"), KeyboardInterrupt(), SystemExit(4)):
            m, p, s, k, result, error = self.exercise(close_errors={"stdout": exception})
            self.assertIs(error, exception)
            self.assertIsNot(error.__cause__, error)
            with patch.object(m, "read_live_catalog", side_effect=error):
                with self.assertRaises(type(exception)):
                    m.main(["catalog"])

    def test_wait_escalation_and_error_precedence(self):
        timeout = subprocess.TimeoutExpired("fake", 1)
        m, p, s, k, result, error = self.exercise(waits=[timeout, 0])
        self.assertIsNone(error); self.assertEqual(result, complete_catalog())
        k.assert_called_once_with(12345, __import__("signal").SIGTERM)
        self.assertGreaterEqual(p.wait.call_args_list[0].kwargs["timeout"], 0)
        self.assertLessEqual(p.wait.call_args_list[0].kwargs["timeout"], m.DEADLINE_SECONDS)
        self.assertEqual(p.wait.call_args_list[1].kwargs["timeout"], 1)
        m, p, s, k, result, error = self.exercise(waits=[timeout, timeout, 0])
        self.assertIsNone(error)
        self.assertEqual(k.call_args_list[-1].args, (12345, __import__("signal").SIGKILL))
        self.assertIsNone(self.exercise(waits=[timeout, 0], signals=ProcessLookupError())[-1])
        for waits, signals in (([timeout, timeout, timeout], None), ([OSError("wait"), 0], None), ([timeout, 0], PermissionError("signal"))):
            m, p, s, k, result, error = self.exercise(waits=waits, signals=signals)
            self.assertIsInstance(error, m.WorkerModelError)
            p.stdout.close.assert_called_once()
        primary = RuntimeError("deadline exceeded")
        self.assertIs(self.exercise(primary=primary, waits=[timeout, 0])[-1], primary)

    def test_writer_primary_survives_close(self):
        m = load_worker_models(); p = Mock(); selector = Mock()
        original = OSError("write"); secondary = OSError("close")
        selector.close.side_effect = secondary
        with patch.object(m.selectors, "DefaultSelector", return_value=selector), patch.object(m.os, "set_blocking"), patch.object(m.os, "write", side_effect=original):
            with self.assertRaises(m.WorkerModelError) as caught:
                m._write_message(p, {}, m.time.monotonic() + 1)
        self.assertIs(caught.exception.__cause__, original)
        self.assertIn(("writer-close", secondary), caught.exception._cleanup_errors)


class PublicationBoundaryTests(unittest.TestCase):
    def publish(self, value, cap=None):
        m = load_worker_models()
        if cap is not None: m.CATALOG_CAP = cap
        output = io.TextIOWrapper(io.BytesIO(), encoding="utf-16")
        error = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        with patch.object(m, "read_live_catalog", return_value=value), patch.object(m.sys, "stdout", output), patch.object(m.sys, "stderr", error):
            status = m.main(["catalog"])
        output.flush(); error.flush()
        return status, output.buffer.getvalue(), error.buffer.getvalue()

    def test_strict_numeric_and_prepared_byte_boundary(self):
        for token in ("1e400", "-1e400"):
            value = json.loads('{"data":[],"nextCursor":null,"extra":' + token + '}')
            status, out, err = self.publish(value)
            self.assertEqual(status, 2); self.assertEqual(out, b""); self.assertLessEqual(len(err), 512)
        value = {"data":[], "nextCursor":None, "extra":"€"}
        expected = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
        self.assertEqual(self.publish(value, len(expected))[:2], (0, expected))
        self.assertEqual(self.publish(value, len(expected)-1)[:2], (2, b""))

    def test_finite_values_and_resolve_stream_compatibility(self):
        value = {"extra":[10**100, True, None, "Infinity", 1.25, 0.0]}
        expected = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
        self.assertEqual(self.publish(value)[:2], (0, expected))
        m = load_worker_models(); m.CATALOG_CAP = 1
        output = io.TextIOWrapper(io.BytesIO(), encoding="utf-16")
        with patch.object(m, "_read_catalog", return_value=complete_catalog()), patch.object(m.sys, "stdout", output):
            self.assertEqual(m.main(["resolve", "--catalog", "unused"]), 0)
        output.flush()
        self.assertEqual(json.loads(output.buffer.getvalue().decode("utf-16"))["roles"]["bulk"]["effort"], "max")

    def test_raw_unicode_wire_fits_but_publication_exceeds_cap(self):
        # Actual fake transport reads raw UTF-8, never a json.dumps-escaped surrogate.
        with tempfile.TemporaryDirectory() as directory:
            m = load_worker_models()
            value = {"data":[model("m", "M", ["low"], "low")], "nextCursor":None}
            value["data"][0]["extra"] = "€" * 300
            raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            wire = ('{"id":1,"result":{}}\n{"id":2,"result":{"data":[],"nextCursor":"later"}}\n{"id":3,"result":' + raw + '}\n').encode()
            prepared = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
            self.assertLess(len(wire), len(prepared)-1)
            fake = Path(directory) / "fake"
            fake.write_text(f"#!{sys.executable}\nimport sys\nwire={wire!r}\nfor line in sys.stdin.buffer:\n if b'initialize' in line and b'initialized' not in line: sys.stdout.buffer.write(wire); sys.stdout.buffer.flush()\n")
            fake.chmod(0o755)
            for cap, expected in ((len(prepared), 0), (len(prepared)-1, 2), (len(wire)-1, 2)):
                m.CATALOG_CAP = cap
                output = io.TextIOWrapper(io.BytesIO(), encoding="latin-1")
                error = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
                with patch.object(m.sys, "stdout", output), patch.object(m.sys, "stderr", error):
                    self.assertEqual(m.main(["catalog", "--codex", str(fake)]), expected)
                output.flush()
                self.assertEqual(output.buffer.getvalue(), prepared if expected == 0 else b"")
                if expected == 0:
                    snapshot = Path(directory) / "snapshot"; snapshot.write_bytes(output.buffer.getvalue())
                    self.assertEqual(m._read_catalog(str(snapshot)), value)
            combined = wire.replace(b'"extra":', b'"numeric":1e400,"extra":')
            fake.write_text(f"#!{sys.executable}\nimport sys\nwire={combined!r}\nfor line in sys.stdin.buffer:\n if b'initialize' in line and b'initialized' not in line: sys.stdout.buffer.write(wire); sys.stdout.buffer.flush()\n")
            m.CATALOG_CAP = len(prepared)-1
            output = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
            error = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
            with patch.object(m.sys, "stdout", output), patch.object(m.sys, "stderr", error):
                self.assertEqual(m.main(["catalog", "--codex", str(fake)]), 2)
            self.assertEqual(output.buffer.getvalue(), b"")
            self.assertIn(b"strict JSON", error.buffer.getvalue())


class OfflineCatalogBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "catalog.json"
        self.path.write_text(json.dumps(complete_catalog()), encoding="utf-8")
        self.open_descriptors = []
        self.real_close = os.close

    def tearDown(self):
        for descriptor in self.open_descriptors:
            try:
                self.real_close(descriptor)
            except OSError:
                pass
        self.temp.cleanup()

    def fail_close(self, error):
        def fail(descriptor):
            self.open_descriptors.append(descriptor)
            raise error
        return fail

    @staticmethod
    def os_without_nonblock(module, open_mock):
        values = {
            "O_RDONLY": module.os.O_RDONLY,
            "open": open_mock,
            "fstat": module.os.fstat,
            "fdopen": module.os.fdopen,
            "close": module.os.close,
        }
        if hasattr(module.os, "O_CLOEXEC"):
            values["O_CLOEXEC"] = module.os.O_CLOEXEC
        return types.SimpleNamespace(**values)

    def test_missing_nonblocking_capability_refuses_before_open(self):
        m = load_worker_models()
        attempted_open = Mock(side_effect=AssertionError("open must not run"))
        output = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        error = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        replacement = self.os_without_nonblock(m, attempted_open)
        with patch.object(m, "os", replacement), patch.object(m.sys, "stdout", output), patch.object(m.sys, "stderr", error):
            status = m.main(["resolve", "--catalog", str(self.path)])
        self.assertEqual(status, 2)
        self.assertEqual(output.buffer.getvalue(), b"")
        self.assertIn(b"nonblocking file acquisition is unavailable", error.buffer.getvalue())
        attempted_open.assert_not_called()

    def test_primary_catalog_failure_survives_secondary_close_failure(self):
        m = load_worker_models()
        read_error = OSError("fstat failed")
        close_error = OSError("close failed")
        with patch.object(m.os, "fstat", side_effect=read_error), patch.object(
            m.os, "close", side_effect=self.fail_close(close_error)
        ) as close:
            with self.assertRaises(m.WorkerModelError) as caught:
                m._read_catalog(str(self.path))
        close.assert_called_once()
        self.assertIs(caught.exception.__cause__, read_error)
        self.assertIs(caught.exception._cleanup_errors[0][1], close_error)
        self.assertEqual(caught.exception._cleanup_errors[0][0], "catalog-close")

        output = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        error = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        m = load_worker_models()
        with patch.object(m.os, "fstat", side_effect=OSError("fstat failed")), patch.object(
            m.os, "close", side_effect=self.fail_close(OSError("close failed"))
        ), patch.object(m.sys, "stdout", output), patch.object(m.sys, "stderr", error):
            self.assertEqual(m.main(["resolve", "--catalog", str(self.path)]), 2)
        self.assertEqual(output.buffer.getvalue(), b"")
        diagnostic = error.buffer.getvalue()
        self.assertIn(b"cleanup incomplete (catalog-close:OSError)", diagnostic)
        self.assertLessEqual(len(diagnostic), 512)
        diagnostic.decode("utf-8", "strict")

    def test_raw_close_precedence_at_validation_and_fdopen_boundaries(self):
        for stage in ("invalid-type", "oversize", "fdopen"):
            with self.subTest(stage=stage):
                m = load_worker_models()
                close_error = OSError("close failed")
                patches = [patch.object(m.os, "close", side_effect=self.fail_close(close_error))]
                if stage == "invalid-type":
                    patches.append(patch.object(m.os, "fstat", return_value=self.path.parent.stat()))
                elif stage == "oversize":
                    patches.append(patch.object(
                        m.os, "fstat", return_value=types.SimpleNamespace(st_mode=self.path.stat().st_mode, st_size=m.CATALOG_CAP + 1)
                    ))
                else:
                    patches.append(patch.object(m.os, "fdopen", side_effect=OSError("fdopen failed")))
                with patches[0] as close, patches[1]:
                    with self.assertRaises(m.WorkerModelError) as caught:
                        m._read_catalog(str(self.path))
                close.assert_called_once()
                self.assertIs(caught.exception._cleanup_errors[0][1], close_error)
                if stage == "fdopen":
                    self.assertIsInstance(caught.exception.__cause__, OSError)

    def test_catalog_interruption_identity_survives_secondary_close_failure(self):
        for primary in (KeyboardInterrupt(), SystemExit(9), RuntimeError("unexpected")):
            with self.subTest(primary=type(primary).__name__):
                m = load_worker_models()
                close_error = OSError("close failed")
                with patch.object(m.os, "fstat", side_effect=primary), patch.object(
                    m.os, "close", side_effect=self.fail_close(close_error)
                ) as close:
                    with self.assertRaises(type(primary)) as caught:
                        m._read_catalog(str(self.path))
                close.assert_called_once()
                self.assertIs(caught.exception, primary)
                self.assertIs(caught.exception._cleanup_errors[0][1], close_error)
                if isinstance(primary, RuntimeError):
                    self.assertIn("catalog cleanup incomplete", primary.__notes__[0])

    def test_open_failure_does_not_close_and_stream_transfer_skips_raw_close(self):
        m = load_worker_models()
        with patch.object(m.os, "open", side_effect=OSError("open failed")), patch.object(m.os, "close") as close:
            with self.assertRaises(m.WorkerModelError):
                m._read_catalog(str(self.path))
        close.assert_not_called()
        m = load_worker_models()
        with patch.object(m.os, "close") as close:
            self.assertEqual(m._read_catalog(str(self.path)), complete_catalog())
        close.assert_not_called()


class WorkerDiagnosticUtf8Tests(unittest.TestCase):
    PREFIX = "worker-models: "

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, key, name):
        quoted = json.dumps(key, ensure_ascii=True)
        path = self.root / name
        path.write_text(f"{{{quoted}:1,{quoted}:2}}", encoding="utf-8")
        return path

    @classmethod
    def expected(cls, key, cap=512):
        body = (cls.PREFIX + f"duplicate JSON object key: {key}").replace("\n", "\\n").replace("\r", "\\r")
        retained = bytearray()
        for character in body:
            encoded = character.encode("utf-8", "replace")
            if len(retained) + len(encoded) > cap - 1:
                break
            retained.extend(encoded)
        return bytes(retained) + b"\n"

    def invoke(self, path):
        return subprocess.run(
            [sys.executable, "-B", os.fspath(SCRIPT), "resolve", "--catalog", os.fspath(path)],
            capture_output=True, timeout=5, check=False,
        )

    def assert_diagnostic(self, key, name):
        result = self.invoke(self.fixture(key, name))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, self.expected(key))
        self.assertLessEqual(len(result.stderr), 512)
        self.assertEqual(result.stderr.count(b"\n"), 1)
        result.stderr.decode("utf-8", "strict")

    def boundary_key(self, character, offset):
        marker = f"{self.PREFIX}duplicate JSON object key: "
        for padding in range(16):
            key = "p" * padding + character * 300
            if (511 - len((marker + "p" * padding).encode())) % len(character.encode()) == offset:
                self.assertGreater(len((marker + key).encode()), 512)
                return key
        self.fail("unable to align diagnostic boundary")

    def test_all_six_interior_multibyte_boundaries(self):
        for label, character, offset in (
            ("two-1", "é", 1), ("three-1", "€", 1), ("three-2", "€", 2),
            ("four-1", "😀", 1), ("four-2", "😀", 2), ("four-3", "😀", 3),
        ):
            with self.subTest(case=label):
                self.assert_diagnostic(self.boundary_key(character, offset), label + ".json")

    def test_exact_fit_one_over_ascii_unicode_and_replacement_controls(self):
        prefix_bytes = len((self.PREFIX + "duplicate JSON object key: ").encode())
        exact = "x" * (511 - prefix_bytes)
        self.assertEqual(len(self.expected(exact)), 512)
        self.assert_diagnostic(exact, "exact.json")
        self.assert_diagnostic(exact + "x", "one-over.json")
        for label, key in (
            ("ascii", "x" * 900),
            ("unicode", "café-项目-😀"),
            ("aligned-two", "é" * 300),
            ("aligned-three", "€" * 300),
            ("aligned-four", "😀" * 300),
            ("replacement", "�" * 300),
            ("surrogate", "\ud800" * 300),
            ("escaped-lines", "a\nb\rc" * 150),
        ):
            with self.subTest(case=label):
                self.assert_diagnostic(key, label + ".json")


if __name__ == "__main__":
    unittest.main()
