"""Fixed, offline behavioral checks; candidate execution is trusted, not isolated."""

import csv
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile


PREFIX = "LUNACY_EVALUATOR_RESULT_V1 "
CLI_TIMEOUT_SECONDS = 2
FIXTURE = Path(__file__).resolve().parents[1]
SENTINEL = b"LAST-KNOWN-GOOD\n"
HEADER = b"sku,revision,name\n"
INITIAL = b'sku,revision,name\na,1,Desk\nb,1,"Pad, ""Blue"""\nc,1,"Line\nBreak"\n'
LATE = b'sku,revision,name\na,3,Desk Prime\nc,1,"Line\nBreak"\nd,1,"North, ""Annex"""\n'
INITIAL_ROWS = [["sku", "revision", "name"], ["a", "1", "Desk"],
                ["b", "1", 'Pad, "Blue"'], ["c", "1", "Line\nBreak"]]
LATE_ROWS = [["sku", "revision", "name"], ["a", "3", "Desk Prime"],
             ["c", "1", "Line\nBreak"], ["d", "1", 'North, "Annex"']]


class BehaviorFailure(Exception):
    pass


def expect(condition, detail):
    if not condition:
        raise BehaviorFailure(detail)


def emit(status, detail):
    print(PREFIX + json.dumps({"protocol": "lunacy-evaluator-result-v1",
                               "status": status, "detail": detail}, sort_keys=True))


def load(candidate):
    # Local helper modules are a valid implementation choice. This path setup
    # provides ordinary candidate imports; it is not a confinement mechanism.
    sys.path.insert(0, str(candidate))
    spec = importlib.util.spec_from_file_location(
        "candidate_catalog_export", candidate / "catalog_export.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def expect_csv(destination, expected_bytes, expected_rows, detail):
    expect(destination.is_file(), detail)
    actual = destination.read_bytes()
    expect(actual == expected_bytes, detail)
    try:
        decoded = list(csv.reader(io.StringIO(actual.decode("utf-8"), newline=""),
                                  strict=True))
    except (UnicodeError, csv.Error) as error:
        raise BehaviorFailure(f"{detail}: invalid CSV ({error})") from error
    expect(decoded == expected_rows, detail)


def check_valid(module, source, destination, expected_bytes, expected_rows, detail,
                *, source_type=Path, destination_type=Path):
    before = source.read_bytes()
    destination.write_bytes(SENTINEL)
    try:
        module.export_catalog(source_type(source), destination_type(destination))
    except Exception as error:
        raise BehaviorFailure(f"{detail}: {type(error).__name__}: {error}") from error
    expect(source.read_bytes() == before, "export modified its input capture")
    expect_csv(destination, expected_bytes, expected_rows, detail)


def check_invalid(module, source, destination, detail,
                  *, source_type=Path, destination_type=Path):
    before = source.read_bytes() if source.exists() else None
    destination.write_bytes(SENTINEL)
    rejected = False
    try:
        module.export_catalog(source_type(source), destination_type(destination))
    except Exception:
        rejected = True
    expect(destination.is_file() and destination.read_bytes() == SENTINEL,
           f"{detail}: existing destination changed")
    expect(rejected, f"{detail}: invalid capture accepted")
    expect((source.read_bytes() if source.exists() else None) == before,
           "export modified its input capture")


def single(rows):
    return {"first": "root", "pages": {"root": {"rows": rows, "next": None}}}


def valid_cases():
    # Each byte/row expectation is a fixed, hand-derived oracle. Nothing here
    # imports or executes the reference implementation or candidate-owned tests.
    return [
        ("empty", {"first": None, "pages": {"ignored": None}}, HEADER,
         [["sku", "revision", "name"]]),
        ("empty-page", single([]), HEADER, [["sku", "revision", "name"]]),
        ("single-page", single([
            {"sku": "b", "revision": 0, "active": True, "name": ""},
            {"sku": "a", "revision": 2, "active": True, "name": "Desk"}]),
         b"sku,revision,name\na,2,Desk\nb,0,\n",
         [["sku", "revision", "name"], ["a", "2", "Desk"], ["b", "0", ""]]),
        ("superseded-conflict", single([
            {"sku": "a", "revision": 1, "active": True, "name": "One"},
            {"sku": "a", "revision": 1, "active": False, "name": "Two"},
            {"sku": "a", "revision": 3, "active": True, "name": "Current"},
            {"sku": "a", "revision": 2, "active": True, "name": "Older"}]),
         b"sku,revision,name\na,3,Current\n",
         [["sku", "revision", "name"], ["a", "3", "Current"]]),
        ("same-state-extra-fields", {
            "first": "root", "metadata": [1, 2], "pages": {"root": {
                "rows": [
                    {"sku": "a", "revision": 1, "active": True, "name": "Desk", "extra": 1},
                    {"sku": "a", "revision": 1, "active": True, "name": "Desk", "extra": 2}],
                "next": None, "pageMetadata": False}}},
         b"sku,revision,name\na,1,Desk\n",
         [["sku", "revision", "name"], ["a", "1", "Desk"]]),
        ("opaque-empty-cursor", {"first": "", "pages": {
            "": {"rows": [], "next": "not/a/number?"},
            "not/a/number?": {"rows": [
                {"sku": "a", "revision": 1, "active": True, "name": "Desk"}], "next": None},
            "unreachable": {"rows": [{"not": "a catalog row"}], "next": 12}}},
         b"sku,revision,name\na,1,Desk\n",
         [["sku", "revision", "name"], ["a", "1", "Desk"]]),
        ("inactive-current", single([
            {"sku": "a", "revision": 4, "active": False, "name": "Gone"},
            {"sku": "a", "revision": 1, "active": True, "name": "Old"},
            {"sku": "a", "revision": 4, "active": False, "name": "Gone"}]),
         HEADER, [["sku", "revision", "name"]]),
        ("unicode-and-carriage-returns", single([
            {"sku": "é", "revision": 1, "active": True, "name": "Line\r\nBreak"},
            {"sku": "z", "revision": 0, "active": True, "name": "Café"},
            {"sku": "a", "revision": 2, "active": True, "name": "\r"}]),
         'sku,revision,name\na,2,"\r"\nz,0,Café\né,1,"Line\r\nBreak"\n'.encode("utf-8"),
         [["sku", "revision", "name"], ["a", "2", "\r"], ["z", "0", "Café"],
          ["é", "1", "Line\r\nBreak"]]),
        ("quoted-sku-and-name", single([
            {"sku": 'a,"', "revision": 7, "active": True, "name": '"\n'}]),
         b'sku,revision,name\n"a,""",7,"""\n"\n',
         [["sku", "revision", "name"], ['a,"', "7", '"\n']]),
    ]


def invalid_cases():
    cases = [
        ("archive-not-object", []),
        ("missing-first", {"pages": {}}),
        ("missing-pages", {"first": None}),
        ("first-not-cursor", {"first": False, "pages": {}}),
        ("pages-not-object", {"first": None, "pages": []}),
        ("unknown-cursor", {"first": "missing", "pages": {}}),
        ("cycle", {"first": "root", "pages": {"root": {"rows": [], "next": "root"}}}),
        ("page-not-object", {"first": "root", "pages": {"root": []}}),
        ("missing-rows", {"first": "root", "pages": {"root": {"next": None}}}),
        ("missing-next", {"first": "root", "pages": {"root": {"rows": []}}}),
        ("rows-not-array", {"first": "root", "pages": {"root": {"rows": {}, "next": None}}}),
        ("next-not-cursor", {"first": "root", "pages": {"root": {"rows": [], "next": 1}}}),
        ("row-not-object", single([None])),
        ("greatest-name-conflict", single([
            {"sku": "a", "revision": 2, "active": True, "name": "One"},
            {"sku": "a", "revision": 2, "active": True, "name": "Two"}])),
        ("greatest-active-conflict", single([
            {"sku": "a", "revision": 2, "active": True, "name": "Same"},
            {"sku": "a", "revision": 2, "active": False, "name": "Same"}])),
        ("inactive-greatest-conflict", single([
            {"sku": "a", "revision": 2, "active": False, "name": "One"},
            {"sku": "a", "revision": 2, "active": False, "name": "Two"}])),
        ("invalid-superseded-row", single([
            {"sku": "a", "revision": 3, "active": True, "name": "Current"},
            {"sku": "a", "revision": 1, "active": False, "name": 42}])),
        ("missing-after-valid-page", {"first": "root", "pages": {"root": {
            "rows": [{"sku": "a", "revision": 1, "active": True, "name": "Desk"}],
            "next": "missing"}}}),
    ]
    row = {"sku": "a", "revision": 1, "active": True, "name": "Desk"}
    for field in row:
        cases.append(("missing-" + field, single([
            {key: value for key, value in row.items() if key != field}])))
    for name, field, value in [
        ("sku-empty", "sku", ""), ("sku-not-string", "sku", 1),
        ("revision-boolean", "revision", True), ("revision-negative", "revision", -1),
        ("revision-string", "revision", "1"), ("revision-float", "revision", 1.0),
        ("active-integer", "active", 1), ("active-string", "active", "true"),
        ("name-not-string", "name", None),
    ]:
        cases.append((name, single([{**row, field: value}])))
    return cases


def run_cli(candidate, source, destination, label):
    try:
        completed = subprocess.run(
            [sys.executable, "-B", str(candidate / "catalog_export.py"),
             str(source), str(destination)],
            cwd=candidate, stdin=subprocess.DEVNULL, capture_output=True,
            text=True, encoding="utf-8", errors="replace", check=False,
            timeout=CLI_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        print(f"catalog-replay {label} CLI timeout; stderr={error.stderr!r}", file=sys.stderr)
        raise BehaviorFailure(f"{label} CLI exceeded {CLI_TIMEOUT_SECONDS} seconds") from error
    # Retain the real CLI's outcome and diagnostics in raw checker logs, even
    # when a nonzero exit is the expected invalid-input result.
    print(f"catalog-replay {label} CLI exitCode={completed.returncode}; "
          f"stdout={completed.stdout!r}; stderr={completed.stderr!r}", file=sys.stderr)
    return completed


def evaluate(candidate):
    module = load(candidate)
    expect(callable(getattr(module, "export_catalog", None)),
           "export_catalog callable missing")
    with tempfile.TemporaryDirectory(prefix="lunacy-catalog-replay-") as temporary:
        root = Path(temporary)
        destination = root / "catalog.csv"
        source = root / "capture.json"
        initial_bytes = (FIXTURE / "worker" / "inputs" / "initial.json").read_bytes()
        late_bytes = (FIXTURE / "evaluator" / "stage2" / "late.json").read_bytes()
        bad_bytes = (FIXTURE / "evaluator" / "stage2" / "late-bad.json").read_bytes()
        source.write_bytes(initial_bytes)
        check_valid(module, source, destination, INITIAL, INITIAL_ROWS,
                    "initial archive export mismatch")
        source.write_bytes(late_bytes)
        check_valid(module, source, destination, LATE, LATE_ROWS,
                    "late revision replay mismatch")
        source.write_bytes(bad_bytes)
        check_invalid(module, source, destination, "late invalid record")

        # The API promises both path representations independently. The CLI can
        # normalize arguments itself, so CLI success alone cannot establish it.
        for source_type in (Path, str):
            for destination_type in (Path, str):
                label = f"API path arguments {source_type.__name__}/{destination_type.__name__}"
                source.write_bytes(late_bytes)
                check_valid(module, source, destination, LATE, LATE_ROWS,
                            label + " export mismatch", source_type=source_type,
                            destination_type=destination_type)
                source.write_bytes(bad_bytes)
                check_invalid(module, source, destination, label + " invalid capture",
                              source_type=source_type, destination_type=destination_type)

        for name, archive, expected_bytes, expected_rows in valid_cases():
            source.write_text(json.dumps(archive, ensure_ascii=False), encoding="utf-8")
            check_valid(module, source, destination, expected_bytes, expected_rows,
                        name + " export mismatch")
        for name, archive in invalid_cases():
            source.write_text(json.dumps(archive), encoding="utf-8")
            check_invalid(module, source, destination, name)
        source.write_bytes(b'{"first":')
        check_invalid(module, source, destination, "malformed JSON")
        source.write_bytes(b"\xff")
        check_invalid(module, source, destination, "invalid UTF-8")
        check_invalid(module, root / "missing.json", destination, "missing input file")

        source.write_bytes(late_bytes)
        destination.write_bytes(SENTINEL)
        result = run_cli(candidate, source, destination, "valid capture")
        expect(result.returncode == 0,
               f"valid capture CLI failed: exit={result.returncode}; stderr={result.stderr!r}")
        expect_csv(destination, LATE, LATE_ROWS, "CLI late revision replay mismatch")
        expect(source.read_bytes() == late_bytes, "CLI modified its input capture")

        source.write_bytes(bad_bytes)
        destination.write_bytes(SENTINEL)
        result = run_cli(candidate, source, destination, "invalid capture")
        expect(destination.is_file() and destination.read_bytes() == SENTINEL,
               "CLI invalid capture changed existing destination")
        expect(result.returncode != 0,
               f"CLI invalid capture returned success; stderr={result.stderr!r}")
        expect(source.read_bytes() == bad_bytes, "CLI modified its input capture")


if __name__ == "__main__":
    try:
        evaluate(Path(sys.argv[1]).resolve())
    except BehaviorFailure as error:
        emit("FAIL", str(error))
        raise SystemExit(1)
    emit("PASS", "PASS")
