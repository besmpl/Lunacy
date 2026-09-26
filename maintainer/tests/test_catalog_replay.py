from __future__ import annotations

import copy
import csv
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from maintainer import evaluation_pack


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "maintainer/evaluation/fixtures/catalog-replay"
HEADER = b"sku,revision,name\n"
SENTINEL = b'LAST-KNOWN-GOOD\n\x00unchanged,"bytes"\r\n'

# Independently derived from the public input table before reading any fixture
# implementation. Neither the reference nor a CSV writer computes expectations.
INITIAL = b'sku,revision,name\na,1,Desk\nb,1,"Pad, ""Blue"""\nc,1,"Line\nBreak"\n'
LATE = b'sku,revision,name\na,3,Desk Prime\nc,1,"Line\nBreak"\nd,1,"North, ""Annex"""\n'
INITIAL_ROWS = [
    ["sku", "revision", "name"], ["a", "1", "Desk"],
    ["b", "1", 'Pad, "Blue"'], ["c", "1", "Line\nBreak"],
]
LATE_ROWS = [
    ["sku", "revision", "name"], ["a", "3", "Desk Prime"],
    ["c", "1", "Line\nBreak"], ["d", "1", 'North, "Annex"'],
]


def row(sku="a", revision=1, active=True, name="Desk", **metadata):
    return dict(sku=sku, revision=revision, active=active, name=name, **metadata)


def archive(rows, *, first="root", next_cursor=None):
    return {"first": first, "pages": {first: {"rows": rows, "next": next_cursor}}}


INITIAL_ARCHIVE = {
    "first": "root",
    "pages": {
        "root": {"rows": [row(), row("b", name='Pad, "Blue"')], "next": "gap"},
        "gap": {"rows": [], "next": "tail"},
        "tail": {"rows": [row("c", name="Line\nBreak")], "next": None},
    },
}
LATE_ARCHIVE = {
    "first": "root",
    "pages": {
        "root": {"rows": [row(revision=3, name="Desk Prime"),
                           row("b", name='Pad, "Blue"')], "next": "gap"},
        "gap": {"rows": [], "next": "tail"},
        "tail": {"rows": [row("c", name="Line\nBreak"),
                           row("b", 2, False, 'Pad, "Blue"'),
                           row(revision=2, name="Desk Old"),
                           row("d", name='North, "Annex"'),
                           row("c", name="Line\nBreak")], "next": None},
    },
}
LATE_BAD_ARCHIVE = copy.deepcopy(LATE_ARCHIVE)
LATE_BAD_ARCHIVE["pages"]["tail"]["rows"].append(row("e", "4", True, "Bad"))


# An independent valid control uses collection followed by sort/group reduction,
# and manually escapes CSV fields. Mutants change one decision in that control;
# they do not depend on the reference implementation's source shape.
ALTERNATIVE_FRONT = '''\
from itertools import groupby
import json
from pathlib import Path
import sys

def _records(data):
    if not isinstance(data, dict) or not {"first", "pages"} <= data.keys():
        raise ValueError("invalid archive")
    cursor, pages = data["first"], data["pages"]
    if not isinstance(pages, dict):
        raise ValueError("invalid pages")
    result, seen = [], set()
    while cursor is not None:
        if not isinstance(cursor, str) or cursor in seen or cursor not in pages:
            raise ValueError("invalid cursor")
        seen.add(cursor)
        page = pages[cursor]
        if not isinstance(page, dict) or not {"rows", "next"} <= page.keys():
            raise ValueError("invalid page")
        if not isinstance(page["rows"], list):
            raise ValueError("invalid rows")
        if page["next"] is not None and not isinstance(page["next"], str):
            raise ValueError("invalid next")
        for item in page["rows"]:
            if not isinstance(item, dict) or not {"sku", "revision", "active", "name"} <= item.keys():
                raise ValueError("invalid row")
            if not isinstance(item["sku"], str) or not item["sku"]:
                raise ValueError("invalid sku")
            if type(item["revision"]) is not int or item["revision"] < 0:
                raise ValueError("invalid revision")
            if type(item["active"]) is not bool or not isinstance(item["name"], str):
                raise ValueError("invalid payload")
            result.append(item)
        cursor = page["next"]
    return result

'''
CORRECT_SELECTOR = '''\
def _current(rows):
    result = []
    for sku, values in groupby(sorted(rows, key=lambda item: (item["sku"], -item["revision"])),
                              key=lambda item: item["sku"]):
        values = list(values)
        winner = values[0]
        payloads = {(item["active"], item["name"]) for item in values
                    if item["revision"] == winner["revision"]}
        if len(payloads) != 1:
            raise ValueError("conflicting greatest revision")
        result.append(winner)
    return result

'''
ALTERNATIVE_BACK = r'''
def _field(value):
    value = str(value)
    if any(character in value for character in ',"\r\n'):
        return '"' + value.replace('"', '""') + '"'
    return value

def export_catalog(source, destination):
    data = json.loads(Path(source).read_text(encoding="utf-8"))
    rows = _current(_records(data))
    records = ["sku,revision,name"]
    for item in sorted(rows, key=lambda item: item["sku"]):
        if item["active"]:
            records.append(",".join(_field(item[key]) for key in ("sku", "revision", "name")))
    content = ("\n".join(records) + "\n").encode("utf-8")
    Path(destination).write_bytes(content)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(2)
    export_catalog(sys.argv[1], sys.argv[2])
'''
ALTERNATIVE = ALTERNATIVE_FRONT + CORRECT_SELECTOR + ALTERNATIVE_BACK


def load_module(path):
    spec = importlib.util.spec_from_file_location("catalog_replay_test_candidate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def decoded(content):
    return list(csv.reader(io.StringIO(content.decode("utf-8"), newline="")))


class CatalogReplayTests(unittest.TestCase):
    def _candidate(self, root, variant="reference", source=None):
        destination = evaluation_pack.materialize("catalog-replay", root / variant)
        if source is not None:
            (destination / "catalog_export.py").write_text(source, encoding="utf-8")
        elif variant != "starter":
            reference = FIXTURE / "evaluator" / variant / "catalog_export.py"
            (destination / "catalog_export.py").write_bytes(reference.read_bytes())
        return destination

    def _export(self, module, root, capture, expected):
        source, destination = root / "capture.json", root / "output.csv"
        source.write_text(json.dumps(capture, ensure_ascii=False), encoding="utf-8")
        original_source = source.read_bytes()
        destination.write_bytes(SENTINEL)
        module.export_catalog(source, destination)
        self.assertEqual(source.read_bytes(), original_source)
        self.assertEqual(destination.read_bytes(), expected)
        return destination.read_bytes()

    def test_frozen_capture_data_and_literal_oracle(self):
        captures = (
            (FIXTURE / "worker/inputs/initial.json", INITIAL_ARCHIVE),
            (FIXTURE / "evaluator/stage2/late.json", LATE_ARCHIVE),
            (FIXTURE / "evaluator/stage2/late-bad.json", LATE_BAD_ARCHIVE),
        )
        for path, expected in captures:
            with self.subTest(capture=path.name):
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")), expected)
        self.assertEqual(decoded(INITIAL), INITIAL_ROWS)
        self.assertEqual(decoded(LATE), LATE_ROWS)

    def test_materialization_exposes_only_phase_one_packet(self):
        with tempfile.TemporaryDirectory() as temporary:
            candidate = self._candidate(Path(temporary), "starter")
            files = {path.relative_to(candidate).as_posix()
                     for path in candidate.rglob("*") if path.is_file()}
            self.assertEqual(files, {"TASK.md", "CONTRACT.md", "catalog_export.py",
                                     "test_catalog_export.py", "inputs/initial.json"})

    def test_fixed_runner_accepts_reference_and_rejects_behavioral_controls(self):
        controls = (
            ("starter", "FAIL", "initial archive export mismatch"),
            ("reference", "PASS", "PASS"),
            ("incomplete", "FAIL", "late revision replay mismatch"),
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for variant, status, detail in controls:
                with self.subTest(variant=variant):
                    candidate = self._candidate(root, variant)
                    module = load_module(candidate / "catalog_export.py")
                    self._export(module, root, archive([row()]), b"sku,revision,name\na,1,Desk\n")
                    result = evaluation_pack.check("catalog-replay", candidate)
                    self.assertEqual(result["status"], status, result)
                    self.assertEqual(result["exitCode"], 0 if status == "PASS" else 1, result)
                    self.assertEqual(result["detail"], detail, result)

    def test_narrow_worker_test_is_green_for_starter_and_incomplete(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for variant in ("starter", "incomplete"):
                with self.subTest(variant=variant):
                    candidate = self._candidate(root, variant)
                    completed = subprocess.run(
                        [sys.executable, "-B", "-m", "unittest", "test_catalog_export", "-v"],
                        cwd=candidate, capture_output=True, text=True, timeout=2, check=False)
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    self.assertIn("Ran 1 test", completed.stderr)

    def test_different_valid_implementation_passes_without_candidate_tests(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = self._candidate(root, "alternative", ALTERNATIVE)
            module = load_module(candidate / "catalog_export.py")
            self.assertEqual(decoded(self._export(module, root, INITIAL_ARCHIVE, INITIAL)), INITIAL_ROWS)
            self.assertEqual(decoded(self._export(module, root, LATE_ARCHIVE, LATE)), LATE_ROWS)
            (candidate / "test_catalog_export.py").write_text(
                "raise RuntimeError('candidate-owned tests must not be trusted')\n", encoding="utf-8")
            result = evaluation_pack.check("catalog-replay", candidate)
            self.assertEqual(result["status"], "PASS", result)
            self.assertEqual(result["exitCode"], 0, result)

    def _valid_cases(self):
        low_conflict = [row("x", 1, True, "Old A"), row("x", 1, False, "Old B"),
                        row("x", 2, True, "Current")]
        metadata = archive([row("m", 7, True, "Same", hint="one"),
                            row("m", 7, True, "Same", hint="two")])
        metadata["capture_note"] = {"arbitrary": True}
        metadata["pages"]["root"]["page_note"] = 123
        return (
            ("empty", {"first": None, "pages": {}}, HEADER),
            ("unreachable invalid page", {"first": None, "pages": {"unused": 7}}, HEADER),
            ("zero revision empty name empty cursor", archive([row("z", 0, True, "")], first=""),
             b"sku,revision,name\nz,0,\n"),
            ("empty continuing page", {"first": "head", "pages": {
                "head": {"rows": [], "next": ""},
                "": {"rows": [row()], "next": None}, "unused": "not a page"}},
             b"sku,revision,name\na,1,Desk\n"),
            ("sort and tombstone", archive([row("z"), row("a"), row("A"), row("gone", active=False)]),
             b"sku,revision,name\nA,1,Desk\na,1,Desk\nz,1,Desk\n"),
            ("superseded conflict", archive(low_conflict), b"sku,revision,name\nx,2,Current\n"),
            ("superseded conflict reordered", archive(list(reversed(low_conflict))),
             b"sku,revision,name\nx,2,Current\n"),
            ("metadata ignored", metadata, b"sku,revision,name\nm,7,Same\n"),
            ("quote alone", archive([row(name='"')]), b'sku,revision,name\na,1,""""\n'),
            ("quoted sku", archive([row('x,"\ny', name="value")]),
             b'sku,revision,name\n"x,""\ny",1,value\n'),
            ("unicode and carriage returns", archive([row("é", name="left\rright\r\nend")]),
             'sku,revision,name\né,1,"left\rright\r\nend"\n'.encode("utf-8")),
            ("large integer revision", archive([row(revision=10**30)]),
             b"sku,revision,name\na,1000000000000000000000000000000,Desk\n"),
        )

    def test_valid_boundaries_preserve_canonical_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for variant, source in (("reference", None), ("alternative", ALTERNATIVE)):
                candidate = self._candidate(root, variant, source)
                module = load_module(candidate / "catalog_export.py")
                for name, capture, expected in self._valid_cases():
                    with self.subTest(variant=variant, case=name):
                        self._export(module, root, capture, expected)

    def test_private_pure_reference_core_matches_oracle_without_mutating_inputs(self):
        module = load_module(FIXTURE / "evaluator/reference/catalog_export.py")
        cases = self._valid_cases() + (("initial", INITIAL_ARCHIVE, INITIAL),
                                      ("late", LATE_ARCHIVE, LATE))
        for name, capture, expected in cases:
            with self.subTest(case=name):
                before = copy.deepcopy(capture)
                expected_rows = [(sku, int(revision), name)
                                 for sku, revision, name in decoded(expected)[1:]]
                self.assertEqual(module._current_rows(capture), expected_rows)
                self.assertEqual(capture, before)
                render_input = copy.deepcopy(expected_rows)
                self.assertEqual(module._render_csv(render_input), expected)
                self.assertEqual(render_input, expected_rows)
        for name, capture in self._invalid_cases():
            with self.subTest(invalid=name):
                before = copy.deepcopy(capture)
                with self.assertRaises(ValueError):
                    module._current_rows(capture)
                self.assertEqual(capture, before)

    def test_row_order_page_boundaries_and_duplicates_do_not_change_winners(self):
        rows = LATE_ARCHIVE["pages"]["root"]["rows"] + LATE_ARCHIVE["pages"]["tail"]["rows"]
        permutations = (rows, list(reversed(rows)), rows[3:] + rows[:3],
                        rows[::2] + rows[1::2])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for variant, source in (("reference", None), ("alternative", ALTERNATIVE)):
                candidate = self._candidate(root, variant, source)
                module = load_module(candidate / "catalog_export.py")
                for index, reordered in enumerate(permutations):
                    with self.subTest(variant=variant, permutation=index):
                        capture = {"first": "opaque ?/+", "pages": {
                            "opaque ?/+": {"rows": reordered[:3], "next": ""},
                            "": {"rows": [], "next": "last"},
                            "last": {"rows": reordered[3:] + [copy.deepcopy(rows[2])], "next": None},
                            "unreachable": {"rows": [row(revision=-1)], "next": "unreachable"},
                        }}
                        self._export(module, root, capture, LATE)

    def _invalid_cases(self):
        cases = [
            ("archive not object", []),
            ("missing first", {"pages": {}}),
            ("missing pages", {"first": None}),
            ("pages not object", {"first": None, "pages": []}),
            ("first not string or null", {"first": False, "pages": {}}),
            ("missing first cursor", {"first": "absent", "pages": {}}),
            ("page not object", {"first": "root", "pages": {"root": []}}),
            ("missing rows", {"first": "root", "pages": {"root": {"next": None}}}),
            ("missing next", {"first": "root", "pages": {"root": {"rows": []}}}),
            ("rows not array", archive({})),
            ("next not string or null", archive([row()], next_cursor=False)),
            ("missing successor", archive([row()], next_cursor="absent")),
            ("self cycle", archive([row()], next_cursor="root")),
            ("multi page cycle", {"first": "root", "pages": {
                "root": {"rows": [row()], "next": "tail"},
                "tail": {"rows": [], "next": "root"}}}),
            ("row not object", archive([[]])),
            ("greatest name conflict", archive([row(), row(name="Other")])),
            ("greatest active conflict", archive([row(), row(active=False)])),
            ("superseded invalid row", archive([row(revision=-1), row(revision=2)])),
            ("inactive invalid row", archive([row(active=False, name=None)])),
            ("late invalid row", LATE_BAD_ARCHIVE),
        ]
        for key in ("sku", "revision", "active", "name"):
            missing = row()
            del missing[key]
            cases.append(("missing " + key, archive([missing])))
        for key, values in (("sku", ("", None, 1)),
                            ("revision", (True, False, -1, 1.0, "4", None)),
                            ("active", (1, "true", None)),
                            ("name", (None, 1))):
            for value in values:
                changed = row()
                changed[key] = value
                cases.append((f"invalid {key} {value!r}", archive([changed])))
        return cases

    def test_all_invalid_inputs_preserve_existing_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for variant, source in (("reference", None), ("alternative", ALTERNATIVE)):
                candidate = self._candidate(root, variant, source)
                module = load_module(candidate / "catalog_export.py")
                for name, capture in self._invalid_cases() + [("malformed JSON", None)]:
                    with self.subTest(variant=variant, case=name):
                        source_path, destination = root / "bad.json", root / "existing.csv"
                        source_bytes = b"{" if capture is None else json.dumps(capture).encode("utf-8")
                        source_path.write_bytes(source_bytes)
                        destination.write_bytes(SENTINEL)
                        with self.assertRaises(Exception):
                            module.export_catalog(str(source_path), str(destination))
                        self.assertEqual(destination.read_bytes(), SENTINEL)
                        self.assertEqual(source_path.read_bytes(), source_bytes)

    def test_parse_and_acquisition_failures_preserve_existing_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for variant, source in (("reference", None), ("alternative", ALTERNATIVE)):
                candidate = self._candidate(root, variant, source)
                module = load_module(candidate / "catalog_export.py")
                for name, content in (("invalid UTF-8", b"\xff"), ("missing file", None)):
                    with self.subTest(variant=variant, case=name):
                        source_path, destination = root / "capture.json", root / "output.csv"
                        if content is None:
                            source_path.unlink(missing_ok=True)
                        else:
                            source_path.write_bytes(content)
                        destination.write_bytes(SENTINEL)
                        with self.assertRaises((OSError, ValueError)):
                            module.export_catalog(source_path, destination)
                        self.assertEqual(destination.read_bytes(), SENTINEL)
                        self.assertEqual(source_path.read_bytes() if source_path.exists() else None, content)

    def test_real_cli_writes_literal_bytes_and_preserves_on_invalid_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = self._candidate(root)
            source, destination = root / "capture.json", root / "existing.csv"
            cases = (("initial", INITIAL_ARCHIVE, INITIAL), ("late", LATE_ARCHIVE, LATE),
                     ("late invalid", LATE_BAD_ARCHIVE, None),
                     ("greatest conflict", archive([row(), row(active=False)]), None),
                     ("cycle", archive([row()], next_cursor="root"), None),
                     ("malformed JSON", None, None))
            for name, capture, expected in cases:
                with self.subTest(case=name):
                    source.write_bytes(b"{" if capture is None else json.dumps(capture).encode("utf-8"))
                    before = source.read_bytes()
                    destination.write_bytes(SENTINEL)
                    completed = subprocess.run(
                        [sys.executable, "-B", str(candidate / "catalog_export.py"),
                         str(source), str(destination)], cwd=root,
                        capture_output=True, text=True, timeout=2, check=False)
                    if expected is None:
                        self.assertNotEqual(completed.returncode, 0, completed)
                        self.assertEqual(destination.read_bytes(), SENTINEL)
                    else:
                        self.assertEqual(completed.returncode, 0, completed.stderr)
                        self.assertEqual(destination.read_bytes(), expected)
                    self.assertEqual(source.read_bytes(), before)

    def test_callable_supports_all_path_representations_on_success_and_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_path, destination = root / "capture.json", root / "output.csv"
            for variant, source in (("reference", None), ("alternative", ALTERNATIVE)):
                candidate = self._candidate(root, variant, source)
                module = load_module(candidate / "catalog_export.py")
                for source_type, destination_type in ((Path, Path), (str, Path), (Path, str), (str, str)):
                    with self.subTest(variant=variant, source=source_type.__name__,
                                      destination=destination_type.__name__):
                        source_bytes = json.dumps(LATE_ARCHIVE).encode("utf-8")
                        source_path.write_bytes(source_bytes)
                        destination.write_bytes(SENTINEL)
                        module.export_catalog(source_type(source_path), destination_type(destination))
                        self.assertEqual(destination.read_bytes(), LATE)
                        self.assertEqual(source_path.read_bytes(), source_bytes)
                        invalid_bytes = json.dumps(LATE_BAD_ARCHIVE).encode("utf-8")
                        source_path.write_bytes(invalid_bytes)
                        destination.write_bytes(SENTINEL)
                        with self.assertRaises(ValueError):
                            module.export_catalog(source_type(source_path), destination_type(destination))
                        self.assertEqual(destination.read_bytes(), SENTINEL)
                        self.assertEqual(source_path.read_bytes(), invalid_bytes)

    def test_fixed_checker_rejects_path_only_api_even_when_cli_adapts(self):
        source = (ALTERNATIVE
                  .replace("Path(source).read_text", "source.read_text")
                  .replace("Path(destination).write_bytes(content)", "destination.write_bytes(content)")
                  .replace("export_catalog(sys.argv[1], sys.argv[2])",
                           "export_catalog(Path(sys.argv[1]), Path(sys.argv[2]))"))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = self._candidate(root, "path-only-api", source)
            module = load_module(candidate / "catalog_export.py")
            self._export(module, root, LATE_ARCHIVE, LATE)
            source_path, destination = root / "capture.json", root / "output.csv"
            for source_type, destination_type in ((str, Path), (Path, str), (str, str)):
                with self.subTest(source=source_type.__name__, destination=destination_type.__name__):
                    destination.write_bytes(SENTINEL)
                    with self.assertRaises(AttributeError):
                        module.export_catalog(source_type(source_path), destination_type(destination))
                    self.assertEqual(destination.read_bytes(), SENTINEL)
            result = evaluation_pack.check("catalog-replay", candidate)
            self.assertEqual(result["status"], "FAIL", result)
            self.assertEqual(result["exitCode"], 1, result)
            self.assertIn("path", result["detail"].lower(), result)

    def test_semantic_revision_mutants_run_but_fail_late_behavior(self):
        selectors = {
            "newest-arrival": '''\
def _current(rows):
    return list({item["sku"]: item for item in rows}.values())

''',
            "first-seen": '''\
def _current(rows):
    result = {}
    for item in rows:
        result.setdefault(item["sku"], item)
    return list(result.values())

''',
            "active-before-reconcile": CORRECT_SELECTOR.replace(
                "    result = []\n", "    rows = [item for item in rows if item['active']]\n    result = []\n"),
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, selector in selectors.items():
                with self.subTest(mutant=name):
                    source = ALTERNATIVE_FRONT + selector + ALTERNATIVE_BACK
                    candidate = self._candidate(root, name, source)
                    module = load_module(candidate / "catalog_export.py")
                    self._export(module, root, INITIAL_ARCHIVE, INITIAL)
                    with self.assertRaises(AssertionError):
                        self._export(module, root, LATE_ARCHIVE, LATE)
                    result = evaluation_pack.check("catalog-replay", candidate)
                    self.assertEqual(result["status"], "FAIL", result)
                    self.assertEqual(result["exitCode"], 1, result)
                    self.assertEqual(result["detail"], "late revision replay mismatch", result)

    def test_truncate_before_validation_mutant_is_rejected_for_data_loss(self):
        source = ALTERNATIVE.replace(
            "def export_catalog(source, destination):\n",
            "def export_catalog(source, destination):\n    Path(destination).write_bytes(b'')\n")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = self._candidate(root, "truncate-before-validation", source)
            module = load_module(candidate / "catalog_export.py")
            self._export(module, root, LATE_ARCHIVE, LATE)
            source_path, destination = root / "late-bad.json", root / "existing.csv"
            source_path.write_text(json.dumps(LATE_BAD_ARCHIVE), encoding="utf-8")
            destination.write_bytes(SENTINEL)
            with self.assertRaises(ValueError):
                module.export_catalog(source_path, destination)
            self.assertEqual(destination.read_bytes(), b"")
            result = evaluation_pack.check("catalog-replay", candidate)
            self.assertEqual(result["status"], "FAIL", result)
            self.assertEqual(result["exitCode"], 1, result)
            self.assertEqual(result["detail"], "late invalid record: existing destination changed", result)

    def test_correct_api_wrong_cli_mutant_is_rejected_at_cli(self):
        source = ALTERNATIVE.replace(
            "    export_catalog(sys.argv[1], sys.argv[2])",
            "    Path(sys.argv[2]).write_bytes(b'wrong-cli-output\\n')")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = self._candidate(root, "wrong-cli", source)
            module = load_module(candidate / "catalog_export.py")
            self._export(module, root, INITIAL_ARCHIVE, INITIAL)
            self._export(module, root, LATE_ARCHIVE, LATE)
            source_path, destination = root / "capture.json", root / "output.csv"
            completed = subprocess.run(
                [sys.executable, "-B", str(candidate / "catalog_export.py"),
                 str(source_path), str(destination)], cwd=root,
                capture_output=True, text=True, timeout=2, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(destination.read_bytes(), b"wrong-cli-output\n")
            result = evaluation_pack.check("catalog-replay", candidate)
            self.assertEqual(result["status"], "FAIL", result)
            self.assertEqual(result["exitCode"], 1, result)
            self.assertEqual(result["detail"], "CLI late revision replay mismatch", result)


if __name__ == "__main__":
    unittest.main()
