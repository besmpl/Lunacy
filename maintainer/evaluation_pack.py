#!/usr/bin/env python3
"""Materialize and check the trusted offline engineering fixtures.

The runner has a fixed evaluator entry point per repository-owned fixture. It
never reads commands from a manifest or dispatches an agent. Candidate Python
is executed locally in a bounded child process; this is not security isolation.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parent / "evaluation"
DEFAULT_TIMEOUT_SECONDS = 5
MAX_TIMEOUT_SECONDS = 30
RESULT_PREFIX = "LUNACY_EVALUATOR_RESULT_V1 "


@dataclass(frozen=True)
class Fixture:
    name: str
    starter_failure: str
    incomplete_failure: str


FIXTURES = (
    Fixture("late-cancellation", "late completion overwrote cancellation",
            "stale generation overwrote newer request"),
    Fixture("paginated-listing", "paginated listing omitted later page",
            "paginated listing omitted later page"),
    Fixture("chunk-refactor", "empty length must have zero chunks",
            "exact boundary gained an empty chunk"),
    Fixture("dirty-sentinel", "negative quantities must be rejected",
            "preexisting user sentinel changed"),
    Fixture("misleading-green", "email whitespace was not normalized",
            "email whitespace was not normalized"),
    Fixture("stale-evidence", "old passing evidence was reused after candidate edit",
            "matching evidence without a result was not unknown"),
    Fixture("missing-test-environment",
            "unavailable required check was reported passed",
            "unavailable required check was not reported unknown"),
    Fixture("interface-integration", "individually green slices did not integrate",
            "integration repair reused old passing proof"),
    Fixture("catalog-replay", "initial archive export mismatch",
            "late revision replay mismatch"),
)
FIXTURE_BY_NAME = {fixture.name: fixture for fixture in FIXTURES}


class EvaluationError(ValueError):
    """A fixture or requested evaluation boundary is invalid."""


def _fixture(name: str) -> Fixture:
    try:
        return FIXTURE_BY_NAME[name]
    except KeyError as exc:
        raise EvaluationError(f"unknown fixture: {name}") from exc


def _validate_timeout(seconds: int) -> int:
    if isinstance(seconds, bool) or not 1 <= seconds <= MAX_TIMEOUT_SECONDS:
        raise EvaluationError(
            f"timeout must be an integer from 1 to {MAX_TIMEOUT_SECONDS} seconds")
    return seconds


def _require_trusted_tree(path: Path) -> None:
    if path.is_symlink() or not path.is_dir():
        raise EvaluationError(f"fixture tree is not a real directory: {path}")
    for child in path.rglob("*"):
        mode = child.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise EvaluationError(f"fixture contains unsupported node: {child}")


def materialize(name: str, destination: Path) -> Path:
    """Copy only the worker-visible starter into a new destination."""
    fixture = _fixture(name)
    source = ROOT / "fixtures" / fixture.name / "worker"
    _require_trusted_tree(source)
    destination = Path(destination)
    if destination.is_symlink() or destination.exists():
        raise EvaluationError(f"refusing existing destination: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination)
    return destination


def _overlay(source: Path, destination: Path) -> None:
    _require_trusted_tree(source)
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        target = destination / relative
        if path.is_dir():
            target.mkdir(exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def check(name: str, candidate: Path,
          timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS) -> dict[str, object]:
    """Run one fixed evaluator against a local candidate directory."""
    fixture = _fixture(name)
    timeout_seconds = _validate_timeout(timeout_seconds)
    candidate = Path(candidate)
    _require_trusted_tree(candidate)
    candidate = candidate.resolve()
    evaluator = ROOT / "fixtures" / fixture.name / "evaluator" / "check.py"
    if evaluator.is_symlink() or not evaluator.is_file():
        raise EvaluationError(f"missing evaluator for fixture: {fixture.name}")
    try:
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(evaluator), str(candidate)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {
            "fixture": name,
            "status": "TIMEOUT",
            "exitCode": None,
            "detail": f"evaluator exceeded {timeout_seconds} seconds",
        }
    records = [line[len(RESULT_PREFIX):] for line in completed.stdout.splitlines()
               if line.startswith(RESULT_PREFIX)]
    if len(records) != 1:
        diagnostic = (completed.stderr or completed.stdout).strip()
        detail = "evaluator exited without exactly one result record"
        if diagnostic:
            detail += f": {diagnostic}"
        status = "ERROR"
    else:
        try:
            record = json.loads(records[0])
        except (json.JSONDecodeError, TypeError):
            record = None
        if (not isinstance(record, dict)
                or set(record) != {"detail", "protocol", "status"}
                or record.get("protocol") != "lunacy-evaluator-result-v1"
                or record.get("status") not in {"PASS", "FAIL"}
                or not isinstance(record.get("detail"), str)
                or (record["status"] == "PASS" and completed.returncode != 0)
                or (record["status"] == "FAIL" and completed.returncode == 0)):
            status = "ERROR"
            detail = "evaluator returned an invalid result record"
        else:
            status = record["status"]
            detail = record["detail"]
    return {
        "fixture": name,
        "status": status,
        "exitCode": completed.returncode,
        "detail": detail,
    }


def run_selfcheck(timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS) -> list[dict[str, object]]:
    """Prove starter failure, reference success, and incomplete rejection."""
    _validate_timeout(timeout_seconds)
    observations: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="lunacy-evaluation-") as temporary:
        temporary_root = Path(temporary)
        for fixture in FIXTURES:
            case_root = ROOT / "fixtures" / fixture.name
            for variant, overlay, expected_status, expected_detail in (
                ("starter", None, "FAIL", fixture.starter_failure),
                ("reference", case_root / "evaluator" / "reference", "PASS", "PASS"),
                ("incomplete", case_root / "evaluator" / "incomplete", "FAIL",
                 fixture.incomplete_failure),
            ):
                candidate = materialize(fixture.name,
                                        temporary_root / f"{fixture.name}-{variant}")
                if overlay is not None:
                    _overlay(overlay, candidate)
                result = check(fixture.name, candidate, timeout_seconds)
                result["variant"] = variant
                if result["status"] != expected_status or result["detail"] != expected_detail:
                    raise EvaluationError(
                        f"selfcheck mismatch for {fixture.name}/{variant}: {result}")
                observations.append(result)
    return observations


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list")

    materialize_parser = subparsers.add_parser("materialize")
    materialize_parser.add_argument("fixture", choices=FIXTURE_BY_NAME)
    materialize_parser.add_argument("destination", type=Path)

    check_parser = subparsers.add_parser("check")
    check_parser.add_argument("fixture", choices=FIXTURE_BY_NAME)
    check_parser.add_argument("candidate", type=Path)
    check_parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)

    selfcheck_parser = subparsers.add_parser("selfcheck")
    selfcheck_parser.add_argument("--timeout-seconds", type=int,
                                  default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args(argv)
    try:
        if args.command == "list":
            result: object = [fixture.name for fixture in FIXTURES]
        elif args.command == "materialize":
            result = {"materialized": str(materialize(args.fixture, args.destination))}
        elif args.command == "check":
            result = check(args.fixture, args.candidate, args.timeout_seconds)
        else:
            result = run_selfcheck(args.timeout_seconds)
        print(json.dumps(result, indent=2, sort_keys=True))
        if args.command == "check" and result["status"] != "PASS":
            return 1
    except (EvaluationError, OSError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
