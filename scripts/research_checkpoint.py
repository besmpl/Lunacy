#!/usr/bin/env python3
"""Project a caller-declared research checkpoint; never certify or execute it.

``project(snapshot)`` is pure and raises ValueError for malformed snapshots.
The CLI reads one bounded UTF-8 JSON input. Receipt and origin strings are
opaque data, not instructions or paths to acquire. Stdin's EOF and lifetime
remain the caller's responsibility.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from typing import Any


INPUT_SCHEMA = "lunacy-research-checkpoint-v1"
OUTPUT_SCHEMA = "lunacy-research-checkpoint-view-v1"
MAX_INPUT_BYTES = 1024 * 1024
MAX_ID_CHARS = 128
MAX_TEXT_CHARS = 2048
MAX_BRANCHES = 128
MAX_EVIDENCE = 2048
MAX_CHECKS = 512

_SNAPSHOT_KEYS = frozenset({"schema", "basis_revision", "branches", "evidence", "checks"})
_EVIDENCE_KEYS = frozenset({"id", "branch", "basis_revision", "relation", "origin", "receipt"})
_CHECK_KEYS = frozenset({"id", "branch", "basis_revision", "evidence_ids", "result", "receipt"})
_RELATIONS = frozenset({"supports", "challenges", "inconclusive"})
_RESULTS = frozenset({"passed", "failed", "unavailable"})
_NON_CLAIMS = (
    "Caller-supplied facts only; this view does not certify truth, independence, "
    "authority, acceptance, execution, or custody.",
    "Matching revision labels do not prove source applicability or freshness; "
    "the parent must recheck both at execution.",
    "Shared origins are caller-declared relationships, not independent confirmations; "
    "mixed evidence is not a proven contradiction and gaps are not logical falsity.",
    "This stateless view cannot compare hidden historical versions or certify that "
    "evidence IDs, check IDs, and receipts are immutable.",
)


def _object(value: Any, keys: frozenset[str], label: str) -> None:
    if type(value) is not dict:
        raise ValueError(f"{label} must be an object")
    if any(type(key) is not str for key in value) or value.keys() != keys:
        raise ValueError(f"{label} must contain exactly the required keys")


def _text(value: Any, maximum: int, label: str) -> str:
    if type(value) is not str or not value:
        raise ValueError(f"{label} must be a nonempty string")
    if len(value) > maximum:
        raise ValueError(f"{label} exceeds the {maximum}-character limit")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError(f"{label} must contain valid Unicode text") from None
    return value


def _array(value: Any, maximum: int, label: str, *, nonempty: bool = False) -> list:
    if type(value) is not list or (nonempty and not value):
        requirement = "a nonempty array" if nonempty else "an array"
        raise ValueError(f"{label} must be {requirement}")
    if len(value) > maximum:
        raise ValueError(f"{label} exceeds the {maximum}-item limit")
    return value


def _validate(snapshot: Any) -> tuple[str, set[str], dict[str, dict], dict[str, dict]]:
    """Validate the complete JSON-shaped value before projecting any of it."""
    _object(snapshot, _SNAPSHOT_KEYS, "snapshot")
    if type(snapshot["schema"]) is not str or snapshot["schema"] != INPUT_SCHEMA:
        raise ValueError("snapshot.schema must be lunacy-research-checkpoint-v1")
    basis = _text(snapshot["basis_revision"], MAX_TEXT_CHARS, "snapshot.basis_revision")
    branches: set[str] = set()
    for number, branch in enumerate(_array(
            snapshot["branches"], MAX_BRANCHES, "snapshot.branches", nonempty=True)):
        label = f"snapshot.branches[{number}]"
        branch = _text(branch, MAX_ID_CHARS, label)
        if branch in branches:
            raise ValueError(f"{label} duplicates a branch ID")
        branches.add(branch)

    evidence: dict[str, dict] = {}
    for number, row in enumerate(_array(snapshot["evidence"], MAX_EVIDENCE, "snapshot.evidence")):
        label = f"snapshot.evidence[{number}]"
        _object(row, _EVIDENCE_KEYS, label)
        row_id = _text(row["id"], MAX_ID_CHARS, f"{label}.id")
        branch = _text(row["branch"], MAX_ID_CHARS, f"{label}.branch")
        _text(row["basis_revision"], MAX_TEXT_CHARS, f"{label}.basis_revision")
        relation = _text(row["relation"], MAX_ID_CHARS, f"{label}.relation")
        _text(row["origin"], MAX_TEXT_CHARS, f"{label}.origin")
        _text(row["receipt"], MAX_TEXT_CHARS, f"{label}.receipt")
        if row_id in evidence:
            raise ValueError(f"{label}.id duplicates an evidence ID")
        if branch not in branches:
            raise ValueError(f"{label}.branch refers to an unknown branch")
        if relation not in _RELATIONS:
            raise ValueError(f"{label}.relation must be supports, challenges, or inconclusive")
        evidence[row_id] = row

    checks: dict[str, dict] = {}
    for number, row in enumerate(_array(snapshot["checks"], MAX_CHECKS, "snapshot.checks")):
        label = f"snapshot.checks[{number}]"
        _object(row, _CHECK_KEYS, label)
        row_id = _text(row["id"], MAX_ID_CHARS, f"{label}.id")
        branch = _text(row["branch"], MAX_ID_CHARS, f"{label}.branch")
        _text(row["basis_revision"], MAX_TEXT_CHARS, f"{label}.basis_revision")
        result = _text(row["result"], MAX_ID_CHARS, f"{label}.result")
        _text(row["receipt"], MAX_TEXT_CHARS, f"{label}.receipt")
        if row_id in checks:
            raise ValueError(f"{label}.id duplicates a check ID")
        if branch not in branches:
            raise ValueError(f"{label}.branch refers to an unknown branch")
        if result not in _RESULTS:
            raise ValueError(f"{label}.result must be passed, failed, or unavailable")
        seen: set[str] = set()
        for index, evidence_id in enumerate(_array(
                row["evidence_ids"], MAX_EVIDENCE, f"{label}.evidence_ids")):
            item_label = f"{label}.evidence_ids[{index}]"
            evidence_id = _text(evidence_id, MAX_ID_CHARS, item_label)
            if evidence_id in seen:
                raise ValueError(f"{item_label} duplicates an evidence ID")
            if evidence_id not in evidence:
                raise ValueError(f"{item_label} refers to unknown evidence")
            if evidence[evidence_id]["branch"] != branch:
                raise ValueError(f"{item_label} refers to evidence from a different branch")
            seen.add(evidence_id)
        checks[row_id] = row
    return basis, branches, evidence, checks


def project(snapshot: Any) -> dict:
    """Return a canonical advisory view without mutating or acquiring inputs.

    A current declared check must name exactly all applicable evidence for its
    branch. Neither a current check nor its declared result proves acceptance.
    """
    basis, branches, evidence, checks = _validate(snapshot)
    views = {
        branch: {
            "id": branch,
            "applicable_evidence_ids": [],
            "stale_evidence_ids": [],
            "supports": [],
            "challenges": [],
            "inconclusive": [],
            "mixed_evidence": False,
            "current_declared_checks": [],
            "stale_check_ids": [],
            "gaps": [],
        }
        for branch in sorted(branches)
    }
    origins: dict[str, list[str]] = {}
    for evidence_id in sorted(evidence):
        row = evidence[evidence_id]
        view = views[row["branch"]]
        origins.setdefault(row["origin"], []).append(evidence_id)
        if row["basis_revision"] == basis:
            view["applicable_evidence_ids"].append(evidence_id)
            view[row["relation"]].append(evidence_id)
        else:
            view["stale_evidence_ids"].append(evidence_id)

    applicable = {branch: set(view["applicable_evidence_ids"]) for branch, view in views.items()}
    for check_id in sorted(checks):
        row = checks[check_id]
        view = views[row["branch"]]
        if row["basis_revision"] == basis and set(row["evidence_ids"]) == applicable[row["branch"]]:
            view["current_declared_checks"].append({
                "id": check_id, "result": row["result"], "receipt": row["receipt"],
            })
        else:
            view["stale_check_ids"].append(check_id)

    for view in views.values():
        view["mixed_evidence"] = bool(view["supports"] and view["challenges"])
        gaps = view["gaps"]
        if not view["applicable_evidence_ids"]:
            gaps.append("no-applicable-evidence")
        if not view["current_declared_checks"]:
            gaps.append("no-current-declared-check")
        results = {check["result"] for check in view["current_declared_checks"]}
        if "failed" in results:
            gaps.append("declared-check-failed")
        if "unavailable" in results:
            gaps.append("declared-check-unavailable")
        gaps.sort()

    return {
        "schema": OUTPUT_SCHEMA,
        "basis_revision": basis,
        "advisory_only": True,
        "branches": list(views.values()),
        "shared_origin_groups": [
            {"origin": origin, "evidence_ids": origins[origin]}
            for origin in sorted(origins) if len(origins[origin]) > 1
        ],
        "non_claims": list(_NON_CLAIMS),
    }


def _read_input(path: str) -> bytes:
    if path == "-":
        # Do not close, reconfigure, or assume EOF ownership of caller stdin.
        data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    else:
        if not stat.S_ISREG(os.stat(path).st_mode):
            raise ValueError("input must be a regular file")
        nonblocking = getattr(os, "O_NONBLOCK", None)
        if nonblocking is None:
            raise ValueError("nonblocking file acquisition is unavailable on this platform")
        flags = os.O_RDONLY | nonblocking | getattr(os, "O_CLOEXEC", 0)
        descriptor = os.open(path, flags)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("input must be a regular file")
            if info.st_size > MAX_INPUT_BYTES:
                raise ValueError("input exceeds the 1048576-byte limit")
            chunks = []
            remaining = MAX_INPUT_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, remaining)
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
        finally:
            os.close(descriptor)
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("input exceeds the 1048576-byte limit")
    return data


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("input contains a duplicate JSON object key")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError("input contains a nonfinite JSON constant")


def _decode(data: bytes) -> Any:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("input is not valid UTF-8") from None
    try:
        return json.loads(text, object_pairs_hook=_unique_pairs, parse_constant=_reject_constant)
    except (json.JSONDecodeError, RecursionError):
        raise ValueError("input is not complete valid JSON") from None
    except ValueError:
        # Hooks have safe messages, but the integer parser's ValueError can
        # include caller data. Keep every parser diagnostic payload-free.
        raise ValueError("input is not valid JSON (duplicate keys, nonfinite constants, or invalid values)") from None


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # argparse normally quotes invalid arguments; inputs may be sensitive.
        raise ValueError("expected: inspect PATH (use '-' for bounded stdin)")


def main() -> int:
    parser = _Parser(prog="research_checkpoint.py", description=__doc__)
    parser.add_argument("command", choices=("inspect",))
    parser.add_argument("path", help="one UTF-8 JSON regular file, or '-' for stdin")
    try:
        args = parser.parse_args()
        report = project(_decode(_read_input(args.path)))
    except ValueError as exc:
        print(f"research checkpoint refused: {exc}", file=sys.stderr)
        return 2
    except OSError:
        print("research checkpoint refused: input could not be acquired", file=sys.stderr)
        return 2
    # ASCII JSON escapes preserve Unicode values without depending on the
    # caller's terminal encoding. No output is emitted before full validation.
    print(json.dumps(report, ensure_ascii=True, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
