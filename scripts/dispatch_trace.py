#!/usr/bin/env python3
"""Check a known-ready native agent launch wave in one Codex session trace.

The caller supplies the exact task names known to be ready at the first launch.
This checks parent tool-call ordering, not worker overlap, route fidelity, host
capacity, assignment readiness, or semantic completion.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


def tool_name(value: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("invalid function-call name")
    return value.rsplit(".", 1)[-1]


def check(path: Path, names: list[str]) -> dict:
    expected = set(names)
    launched: set[str] = set()
    interleaved: list[str] = []
    started = False
    verdict = "missing-launch"

    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, 1):
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSONL at line {line_number}: {exc.msg}") from exc
            if not isinstance(row, dict):
                raise ValueError(f"invalid JSONL at line {line_number}: expected object")
            payload = row.get("payload")
            if (row.get("type") != "response_item" or
                    not isinstance(payload, dict) or
                    payload.get("type") not in ("function_call", "custom_tool_call")):
                continue
            name = tool_name(payload.get("name", ""))
            if name == "spawn_agent":
                if payload["type"] != "function_call":
                    raise ValueError(
                        f"unsupported custom spawn_agent encoding at line {line_number}")
                try:
                    arguments = json.loads(payload.get("arguments", ""))
                except (TypeError, json.JSONDecodeError) as exc:
                    raise ValueError(
                        f"invalid spawn arguments at line {line_number}") from exc
                if not isinstance(arguments, dict):
                    raise ValueError(f"invalid spawn arguments at line {line_number}")
                task_name = arguments.get("task_name")
                if not isinstance(task_name, str) or not task_name:
                    raise ValueError(f"invalid spawn task_name at line {line_number}")
                if task_name in expected:
                    if task_name in launched:
                        raise ValueError(f"duplicate selected launch: {task_name}")
                    started = True
                    launched.add(task_name)
                    continue
            if started:
                if name == "wait_agent":
                    if launched != expected:
                        verdict = "premature-wait"
                    else:
                        verdict = "complete-wave" if not interleaved else "interleaved-call"
                    break
                if launched != expected:
                    interleaved.append(name or "unknown-tool")

    missing = sorted(expected - launched)
    if verdict == "missing-launch":
        if interleaved:
            verdict = "interleaved-call"
        elif started and launched == expected:
            verdict = "missing-wait"
    return {
        "schema": "lunacy-dispatch-wave-trace-v1",
        "verdict": verdict,
        "ready_names": names,
        "launched_before_first_wait": len(launched),
        "unlaunched_at_wait": missing if verdict == "premature-wait" else [],
        "missing_names": missing,
        "interleaved_calls": interleaved,
        "non_claims": [
            "Caller-supplied readiness and available capacity are not proven by this trace.",
            "Serial launch calls may overlap; this tool does not measure worker concurrency.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", required=True, type=Path,
                        help="one existing parent rollout JSONL file")
    parser.add_argument("--ready-names", nargs="+", required=True,
                        help="exact task_name values ready at the first launch")
    args = parser.parse_args()
    if len(args.ready_names) != len(set(args.ready_names)):
        parser.error("--ready-names must be unique")
    try:
        report = check(args.session, args.ready_names)
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"dispatch trace failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["verdict"] == "complete-wave" else 1


if __name__ == "__main__":
    sys.exit(main())
