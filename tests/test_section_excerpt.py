import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import context_excerpt as context
from scripts.read_map_core import CoreError


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/context_excerpt.py"
FRESHNESS = "individual-acquisition-only; no-atomic-multi-file-snapshot"


class SectionExcerptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "source"
        self.root.mkdir()

    def write(self, data, relative="OPERATOR.md", root=None):
        path = (root or self.root) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def command(self, *arguments):
        return subprocess.run([sys.executable, "-B", str(SCRIPT), *arguments],
                              capture_output=True, timeout=10)

    def run_cli(self, fragment="chosen", *extra, relative="OPERATOR.md",
                layout="source", root=None):
        return self.command("section-excerpt", "--root", str(root or self.root),
                            "--layout", layout, "--source-relative", relative,
                            "--fragment", fragment, *extra)

    def success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stderr, b"")
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["schema"], "lunacy.section_excerpt.v1")
        self.assertEqual(receipt["status"], "ok")
        self.assertEqual(receipt["host_context"], {"identity": None, "claims": "none"})
        self.assertEqual(receipt["limits"]["files_opened"], 1)
        self.assertEqual(receipt["limits"]["link_records"], 0)
        self.assertIs(receipt["limits"]["truncated"], False)
        self.assertEqual(receipt["excerpt"]["nested_scan"], "not-performed")
        return receipt

    def error(self, result, code, exit_code=4, schema="lunacy.section_excerpt.error.v1"):
        self.assertEqual(result.returncode, exit_code, result.stderr.decode())
        self.assertEqual(result.stdout, b"")
        self.assertLessEqual(len(result.stderr), 8192)
        receipt = json.loads(result.stderr)
        self.assertEqual(receipt["schema"], schema)
        self.assertEqual(receipt["status"], "error")
        self.assertEqual(receipt["code"], code)
        return receipt

    def assert_excerpt(self, receipt, data, chosen, start, end, byte_start,
                       fragment, relative="OPERATOR.md", root=None, layout="source"):
        root = (root or self.root).resolve()
        logical = relative.removeprefix("skills/lunacy/") if layout == "package" else relative
        excerpt = receipt["excerpt"]
        self.assertEqual(receipt["selection"], {"fragment": fragment})
        self.assertEqual(excerpt["kind"], "heading-span")
        self.assertEqual(excerpt["fragment"], fragment)
        self.assertEqual(excerpt["logical_path"], logical)
        self.assertEqual(excerpt["canonical_path"], str(root / relative))
        self.assertEqual(excerpt["line_range"], {"start": start, "end": end})
        self.assertEqual(excerpt["byte_range"],
                         {"start": byte_start, "end": byte_start + len(chosen)})
        self.assertEqual(excerpt["text"].encode("utf-8"), chosen)
        self.assertEqual(excerpt["bytes"], len(chosen))
        self.assertEqual(excerpt["sha256"], hashlib.sha256(chosen).hexdigest())
        self.assertEqual(excerpt["acquisition"],
                         {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                          "freshness": FRESHNESS})
        self.assertEqual(receipt["source"],
                         {"layout": layout, "root": str(root),
                          "canonical_path": str(root / relative), "logical_path": logical,
                          "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                          "freshness": FRESHNESS})
        self.assertEqual(receipt["limits"]["acquired_bytes"], len(data))
        self.assertEqual(receipt["limits"]["materialized_source_bytes"], len(chosen))

    def test_aliases_nesting_fences_and_sibling_alias_boundary_are_exact(self):
        prefix = b"# Guide\r\nintro\n"
        chosen = ('<a id="compat"></a>\r\n<a id="alias"></a>\n## Café\n'
                  'first🙂\r\n### Child\rchild body\vstays content\n```md\n'
                  '## Hidden\n<a id="fenced"></a>\n```\ntail\n').encode()
        data = prefix + chosen + b'<a id="next-alias"></a>\n## Next\nexcluded\n'
        self.write(data)
        for fragment in ("compat", "alias", "caf%C3%A9"):
            with self.subTest(fragment=fragment):
                receipt = self.success(self.run_cli(fragment))
                self.assert_excerpt(receipt, data, chosen, 3, 13, len(prefix),
                                    "café" if fragment.startswith("caf") else fragment)
        for fragment in ("hidden", "fenced", "Café", "Caf", "missing"):
            with self.subTest(fragment=fragment):
                self.error(self.run_cli(fragment), "missing_target")

    def test_physical_endings_unicode_content_and_eof(self):
        for ending in (b"\n", b"\r\n", b"\r"):
            for final_ending in (b"", ending):
                with self.subTest(ending=ending, final=final_ending):
                    prefix = b"# Top" + ending
                    chosen = b"## Chosen" + ending + "é🙂\u0085\u2028\u2029body".encode() + final_ending
                    data = prefix + chosen
                    self.write(data)
                    receipt = self.success(self.run_cli())
                    self.assert_excerpt(receipt, data, chosen, 2, 3, len(prefix), "chosen")

    def test_generated_duplicate_suffixes_select_distinct_sections(self):
        data = b"# Top\n## Repeat\nfirst\n## Repeat\nsecond\n"
        self.write(data)
        for fragment, chosen, start, end, offset in (
                ("repeat", b"## Repeat\nfirst\n", 2, 3, len(b"# Top\n")),
                ("repeat-1", b"## Repeat\nsecond\n", 4, 5, len(b"# Top\n## Repeat\nfirst\n"))):
            with self.subTest(fragment=fragment):
                self.assert_excerpt(self.success(self.run_cli(fragment)), data, chosen,
                                    start, end, offset, fragment)
        self.error(self.run_cli("repeat-2"), "missing_target")

    def test_explicit_and_generated_same_span_is_not_ambiguous(self):
        data = b'<a id="chosen"></a>\n## Chosen\nbody\n'
        self.write(data)
        self.assert_excerpt(self.success(self.run_cli()), data, data, 1, 3, 0, "chosen")

    def test_missing_unattached_duplicate_and_collision_refusals(self):
        cases = (
            ("empty file", b"", "missing_target"),
            ("plain text", b"chosen body\n", "missing_target"),
            ("blank breaks attachment", b'<a id="chosen"></a>\n\n## Other\n', "ambiguous_anchor_boundary"),
            ("inline", b'body <a id="chosen"></a> text\n', "ambiguous_anchor_boundary"),
            ("eof marker", b'<a id="chosen"></a>\n', "ambiguous_anchor_boundary"),
            ("duplicate attached", b'<a id="chosen"></a>\n## A\n<a id="chosen"></a>\n## B\n', "duplicate_or_ambiguous_anchor"),
            ("duplicate same heading", b'<a id="chosen"></a>\n<a id="chosen"></a>\n## A\n', "duplicate_or_ambiguous_anchor"),
            ("attached and inline", b'<a id="chosen"></a>\n## A\nbody <a id="chosen"></a>\n', "duplicate_or_ambiguous_anchor"),
            ("generated collision", b'## Chosen\n<a id="chosen"></a>\n## Other\n', "duplicate_or_ambiguous_anchor"),
        )
        for name, data, code in cases:
            with self.subTest(name=name):
                self.write(data)
                self.error(self.run_cli(), code)

    def test_percent_decoding_happens_once_and_plus_stays_literal(self):
        for selector, decoded in (("name%252Fpart", "name%2Fpart"),
                                  ("plus+sign", "plus+sign"), ("%23hash", "#hash"),
                                  ("raw%zz", "raw%zz"), ("%E9%9B%AA", "雪")):
            with self.subTest(selector=selector):
                data = f'<a id="{decoded}"></a>\n## Other\nbody\n'.encode()
                self.write(data)
                self.assert_excerpt(self.success(self.run_cli(selector)), data, data,
                                    1, 3, 0, decoded)
        self.write(b'<a id="name%2Fpart"></a>\n## Other\n')
        self.error(self.run_cli("name%2Fpart"), "missing_target")

    def test_source_and_package_paths_normalize_before_publication_mapping(self):
        data = b"# Top\n## Chosen\nbody\n"
        chosen = b"## Chosen\nbody\n"
        for layout, physical, supplied in (
                ("source", "OPERATOR.md", "./worker/../OPERATOR.md"),
                ("source", "worker/guide.md", "worker//guide.md"),
                ("package", "skills/lunacy/worker/guide.md", "skills/lunacy/worker/./guide.md")):
            with self.subTest(layout=layout, path=supplied):
                self.write(data, physical)
                receipt = self.success(self.run_cli(relative=supplied, layout=layout))
                self.assert_excerpt(receipt, data, chosen, 2, 3, len(b"# Top\n"),
                                    "chosen", relative=physical, layout=layout)

    def test_unpublished_traversal_external_and_non_markdown_paths_fail(self):
        cases = (
            ("source", "../OPERATOR.md", "path_escape", 3),
            ("source", "/OPERATOR.md", "path_escape", 3),
            ("source", "https://example.test/OPERATOR.md", "path_escape", 3),
            ("source", "private/secret.md", "unpublished_target", 3),
            ("source", "worker/__pycache__/secret.md", "unpublished_target", 3),
            ("source", "packaging/lunacy-native/skills/golden/SKILL.md", "path_escape", 3),
            ("package", "OPERATOR.md", "path_escape", 3),
            ("package", "skills/golden/SKILL.md", "path_escape", 3),
            ("package", "skills/lunacy/../../outside.md", "path_escape", 3),
            ("source", "worker/source.py", "usage_error", 2),
            ("source", "worker/guide.MD", "usage_error", 2),
            ("source", "LICENSE", "usage_error", 2),
        )
        for layout, relative, code, status in cases:
            with self.subTest(layout=layout, path=relative):
                self.error(self.run_cli(relative=relative, layout=layout), code, status)

    def test_no_nested_acquisition_or_link_scanning_and_explicit_nonclaims(self):
        data = (b"## Chosen\n[missing](worker/missing.md#none)\n"
                b"[escape](../../secret.md) [external](https://example.test/)\n"
                b"[invalid publication](private/no.md)\n")
        self.write(data)
        receipt = self.success(self.run_cli("chosen", "--max-files", "1", "--max-links", "1"))
        self.assert_excerpt(receipt, data, data, 1, 4, 0, "chosen")
        for nonclaim in ("not recursive closure", "not a complete obligation set",
                         "not future freshness", "not host, route, or model proof"):
            self.assertIn(nonclaim, receipt["non_claims"])
        self.assertTrue(any("authority" in claim and "applicability" in claim
                            for claim in receipt["non_claims"]))

    def test_guarded_acquisition_rejects_missing_invalid_utf8_symlinks_and_nonregular(self):
        self.error(self.run_cli(), "missing_target", 3)
        path = self.write(b"## Chosen\n\xff")
        self.error(self.run_cli(), "invalid_utf8", 3)
        path.unlink()
        target = Path(self.temporary.name) / "target.md"
        target.write_bytes(b"## Chosen\nbody\n")
        path.symlink_to(target)
        self.error(self.run_cli(), "ancestor_symlink", 3)
        path.unlink()
        path.mkdir()
        self.error(self.run_cli(), "missing_target", 3)
        path.rmdir()
        if hasattr(os, "mkfifo"):
            os.mkfifo(path)
            self.error(self.run_cli(), "missing_target", 3)

    def test_guarded_acquisition_rejects_symlinked_ancestor_and_root(self):
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        (outside / "guide.md").write_bytes(b"## Chosen\nbody\n")
        (self.root / "worker").symlink_to(outside, target_is_directory=True)
        self.error(self.run_cli(relative="worker/guide.md"), "ancestor_symlink", 3)
        root_link = Path(self.temporary.name) / "root-link"
        root_link.symlink_to(self.root, target_is_directory=True)
        self.error(self.run_cli(root=root_link), "ancestor_symlink", 3)

    def test_acquisition_and_work_cap_exact_boundaries(self):
        data = b"# Top\ntext\n## Chosen\nbody\n"
        self.write(data)
        self.success(self.run_cli("chosen", "--max-acquired-bytes", str(len(data))))
        self.error(self.run_cli("chosen", "--max-acquired-bytes", str(len(data) - 1)),
                   "aggregate_cap_exceeded", 5)
        # Four physical lines plus the existing level-one (2) and level-two (3) indexing cost.
        self.assertEqual(self.success(self.run_cli("chosen", "--max-work-units", "9"))
                         ["limits"]["work_units"], 9)
        self.error(self.run_cli("chosen", "--max-work-units", "8"), "work_cap_exceeded", 5)

    def test_sparse_file_over_per_file_cap_is_refused_before_reading(self):
        path = self.write(b"## Chosen\n")
        with path.open("r+b") as stream:
            stream.truncate(64 * 1024 * 1024 + 1)
        self.error(self.run_cli(), "input_cap_exceeded", 5)

    def test_hard_cap_bounds_and_path_root_usage_errors(self):
        self.write(b"## Chosen\nbody\n")
        maxima = (("--max-files", 128), ("--max-links", 4096),
                  ("--max-work-units", 1000000), ("--max-acquired-bytes", 16777216),
                  ("--max-output-bytes", 1048576))
        flags = [part for flag, maximum in maxima for part in (flag, str(maximum))]
        self.success(self.run_cli("chosen", *flags))
        for flag, maximum in maxima:
            with self.subTest(flag=flag):
                self.error(self.run_cli("chosen", flag, str(maximum + 1)),
                           "usage_cap_exceeded", 2)
        self.error(self.run_cli(relative="worker/" + "x" * 4096 + ".md"),
                   "usage_cap_exceeded", 2)
        self.error(self.run_cli(relative=""), "path_escape", 3)
        self.error(self.run_cli(root=Path("relative")), "usage_error", 2)
        self.error(self.run_cli(layout="invalid"), "usage_error", 2)

    def test_complete_serialized_output_cap_and_materialized_cap(self):
        self.write(b"## Chosen\nbody\n")
        receipt = self.success(self.run_cli("chosen", "--max-output-bytes", "10000"))
        for _ in range(5):
            size = len((json.dumps(receipt, ensure_ascii=False, sort_keys=True,
                                   separators=(",", ":")) + "\n").encode())
            if receipt["limits"]["max_output_bytes"] == size:
                break
            receipt["limits"]["max_output_bytes"] = size
        else:
            self.fail("JSON-size fixed point did not converge")
        result = self.run_cli("chosen", "--max-output-bytes", str(size))
        self.success(result)
        self.assertEqual(len(result.stdout), size)
        self.error(self.run_cli("chosen", "--max-output-bytes", str(size - 1)),
                   "output_cap_exceeded", 5)
        self.error(self.run_cli("chosen", "--max-output-bytes", "1"),
                   "output_cap_exceeded", 5)

    def test_selector_limits_diagnostics_and_usage(self):
        self.write(b"## Chosen\nbody\n")
        for selector in ("", "#chosen"):
            with self.subTest(selector=selector):
                self.error(self.run_cli(selector), "usage_error", 2)
        self.error(self.run_cli("x" * 65536), "missing_target")
        self.error(self.run_cli("x" * 65537), "usage_cap_exceeded", 2)
        self.error(self.run_cli("é" * 32769), "usage_cap_exceeded", 2)
        self.error(self.command("section-excerpt"), "usage_error", 2)
        self.error(self.command("section-excerpt", "--unknown"), "usage_error", 2)
        for flag in ("--max-files", "--max-links", "--max-work-units",
                     "--max-acquired-bytes", "--max-output-bytes"):
            with self.subTest(flag=flag):
                self.error(self.run_cli("chosen", flag, "0"), "usage_cap_exceeded", 2)
                self.error(self.run_cli("chosen", flag, "not-integer"), "usage_error", 2)

    def test_selectors_are_exclusive_and_action_error_schema_remains_action(self):
        self.write(b"## Chosen\nbody\n")
        base = ("--root", str(self.root), "--layout", "source", "--source-relative", "OPERATOR.md")
        for flags in (("--trigger", "Act"), ("--trigger-file", "/missing"),
                      ("--fragment", "chosen", "--trigger", "Act"),
                      ("--fragment", "chosen", "--trigger-file", "/missing"), ()):
            with self.subTest(flags=flags):
                self.error(self.command("section-excerpt", *base, *flags), "usage_error", 2)
        self.error(self.command("action-excerpt", *base, "--trigger", "section-excerpt",
                                "--fragment", "chosen"), "usage_error", 2,
                   "lunacy.action_excerpt.error.v1")

    def test_options_before_command_and_option_value_not_command(self):
        self.write(b"## Chosen\nbody\n")
        base = ("--root", str(self.root), "--layout", "source", "--source-relative", "OPERATOR.md")
        self.success(self.command(*base, "section-excerpt", "--fragment", "chosen"))
        self.error(self.command(*base, "section-excerpt", "--fragment", "chosen", "--unknown"),
                   "usage_error", 2)
        self.error(self.command("--trigger", "section-excerpt", "action-excerpt", *base,
                                "--fragment", "chosen"), "usage_error", 2,
                   "lunacy.action_excerpt.error.v1")

    def test_action_format_prefixes_preserve_full_option_receipt(self):
        self.write(b"# Entry\n\n## Before-action reads\n\n"
                   b"Keep this governing instruction.\n\n"
                   b"### Ordinary trigger table\n\n"
                   b"| Trigger | Read next |\n| --- | --- |\n"
                   b"| Act | Read [guide](worker/guide.md#chosen). |\n", "SKILL.md")
        self.write(b"# Guide\n## Chosen\nExact body.\n## Later\nExcluded.\n",
                   "worker/guide.md")
        base = ("--root", str(self.root), "--layout", "source",
                "--source-relative", "SKILL.md", "--trigger", "Act")
        full = self.command("action-excerpt", *base, "--format", "json")
        self.assertEqual(full.returncode, 0, full.stderr.decode())
        self.assertEqual(full.stderr, b"")
        receipt = json.loads(full.stdout)
        self.assertEqual(receipt["schema"], "lunacy.action_excerpt.v1")
        self.assertEqual(receipt["selection"]["row"]["trigger"], "Act")
        self.assertEqual(receipt["destinations"][0]["text"], "## Chosen\nExact body.\n")
        for spelling in ("--f", "--fo", "--for", "--form", "--forma", "--format"):
            for options in ((spelling, "json"), (spelling + "=json",)):
                for command_first in (True, False):
                    with self.subTest(options=options, command_first=command_first):
                        arguments = (("action-excerpt", *base, *options) if command_first
                                     else (*base, *options, "action-excerpt"))
                        result = self.command(*arguments)
                        self.assertEqual(result.returncode, 0, result.stderr.decode())
                        self.assertEqual(result.stderr, b"")
                        self.assertEqual(result.stdout, full.stdout)

    def test_unexpected_failure_is_section_error_without_partial_stdout(self):
        stdout, stderr = io.TextIOWrapper(io.BytesIO()), io.TextIOWrapper(io.BytesIO())
        with mock.patch.object(context, "parse_args", side_effect=RuntimeError("test failure")), \
                mock.patch.object(context.sys, "stdout", stdout), \
                mock.patch.object(context.sys, "stderr", stderr):
            status = context.main(["section-excerpt"])
        self.assertEqual(status, 70)
        self.assertEqual(stdout.buffer.getvalue(), b"")
        error = json.loads(stderr.buffer.getvalue())
        self.assertEqual(error["schema"], "lunacy.section_excerpt.error.v1")
        self.assertEqual(error["code"], "internal_error")


class SectionSpanDecisionTests(unittest.TestCase):
    def test_value_decisions_and_input_preservation(self):
        heading = {"start": 3, "line": 4, "end": 8}
        other = {"start": 9, "line": 9, "end": 11}
        cases = (
            ("fragmentless nonempty", 11, {}, {}, {}, "", (1, 11, "whole-file")),
            ("fragmentless empty", 0, {}, {}, {}, None, (1, 0, "whole-file")),
            ("single", 11, {"chosen": [heading]}, {}, {}, "chosen", (3, 8, "heading-span")),
            ("two names same span", 11, {"chosen": [heading, dict(heading)]}, {}, {"chosen": 1}, "chosen", (3, 8, "heading-span")),
            ("missing", 11, {}, {}, {}, "chosen", "missing_target"),
            ("unattached", 11, {}, {"chosen": [2]}, {"chosen": 1}, "chosen", "ambiguous_anchor_boundary"),
            ("attached plus unattached", 11, {"chosen": [heading]}, {"chosen": [2]}, {"chosen": 1}, "chosen", "duplicate_or_ambiguous_anchor"),
            ("duplicate unattached", 11, {}, {"chosen": [1, 2]}, {"chosen": 2}, "chosen", "duplicate_or_ambiguous_anchor"),
            ("duplicate explicit", 11, {"chosen": [heading]}, {}, {"chosen": 2}, "chosen", "duplicate_or_ambiguous_anchor"),
            ("distinct spans", 11, {"chosen": [heading, other]}, {}, {}, "chosen", "duplicate_or_ambiguous_anchor"),
            ("other ambiguity irrelevant", 11, {"chosen": [heading], "other": [heading, other]}, {"other": [1]}, {"other": 2}, "chosen", (3, 8, "heading-span")),
        )
        for name, count, candidates, unattached, explicit, fragment, expected in cases:
            with self.subTest(name=name):
                inputs = (candidates, unattached, explicit)
                before = copy.deepcopy(inputs)
                if isinstance(expected, tuple):
                    self.assertEqual(context._select_span(count, *inputs, "worker/guide.md", fragment), expected)
                else:
                    with self.assertRaises(CoreError) as raised:
                        context._select_span(count, *inputs, "worker/guide.md", fragment)
                    self.assertEqual(raised.exception.code, expected)
                    self.assertEqual(raised.exception.exit_code, 4)
                    self.assertIn("worker/guide.md#chosen", str(raised.exception))
                self.assertEqual(inputs, before)


if __name__ == "__main__":
    unittest.main()
