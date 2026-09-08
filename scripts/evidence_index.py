#!/usr/bin/env python3
"""Bounded, read-only projection of caller-authorized native evidence."""

from __future__ import annotations

import argparse
from decimal import Decimal, DecimalException
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from typing import Any

INPUT_CAP = 64 * 1024 * 1024
DEFAULT_OUTPUT_CAP = 8192
MAX_OUTPUT_CAP = 1024 * 1024
DIAGNOSTIC_CAP = 512
TEXT_CAP = 4096
NON_CLAIMS = [
    "A zero process exit is not proof that an inner check suite passed.",
    "This projection does not establish plan satisfaction, artifact acceptance, custody settlement, route truth, report correctness, descendant effects, or completeness of work not supplied in the capture.",
]
SESSION_NON_CLAIMS = [
    "Recorded status and exit code are raw captured facts, not a semantic verdict.",
    "The count covers selected captured CommandExecution completions, not all commands, tools, effects, or capture completeness.",
    "Source-associated context does not establish route or backend truth, deadline correctness, custody, report correctness, semantic acceptance, or work completeness.",
]
DIRECT_EXEC_NON_CLAIMS = [
    "Commands are grouped only by literal item ID; observations are not paired, deduplicated, or interpreted as a lifecycle.",
    "Counts describe selected observations in this finite snapshot only, not producer or capture completeness.",
    "This projection does not establish acceptance, route or model identity, custody, effects, retry safety, semantic success, or work completeness.",
]


class EvidenceError(Exception):
    pass


class EvidenceArgumentParser(argparse.ArgumentParser):
    """Route argument refusals through the observer's bounded diagnostic."""

    def error(self, message: str) -> None:
        raise EvidenceError(message)


def short(value: object, limit: int = 120) -> str:
    text = str(value).replace("\n", "\\n").replace("\r", "\\r")
    return text if len(text) <= limit else text[: limit - 3] + "..."


def no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise EvidenceError(f"duplicate JSON object key: {short(key)}")
        value[key] = item
    return value


def reject_constant(value: str) -> None:
    raise EvidenceError(f"nonstandard JSON constant: {short(value)}")


def require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise EvidenceError(f"{label} must be a nonempty string")
    return value


def read_snapshot(path_text: str) -> tuple[Path, bytes, str]:
    path = Path(path_text)
    if not path.is_absolute():
        raise EvidenceError("source path must be absolute")
    try:
        before = path.stat()
    except OSError as exc:
        raise EvidenceError(f"source is unreadable: {exc.strerror}") from exc
    if not stat.S_ISREG(before.st_mode):
        raise EvidenceError("source must be a regular file")
    if before.st_size > INPUT_CAP:
        raise EvidenceError(f"source exceeds {INPUT_CAP}-byte input cap")
    nonblocking = getattr(os, "O_NONBLOCK", None)
    if nonblocking is None:
        raise EvidenceError("nonblocking file acquisition is unavailable on this platform")
    flags = os.O_RDONLY | nonblocking
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    descriptor = None
    primary: BaseException | None = None
    try:
        try:
            descriptor = os.open(path, flags)
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode):
                raise EvidenceError("source must be a regular file")
            chunks = []
            remaining = INPUT_CAP + 1
            while remaining:
                chunk = os.read(descriptor, min(1024 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            after = os.fstat(descriptor)
        except EvidenceError:
            raise
        except OSError as exc:
            raise EvidenceError(f"source is unreadable: {short(exc.strerror or type(exc).__name__)}") from exc
    except BaseException as exc:
        primary = exc
        raise
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError as exc:
                if primary is None:
                    detail = short(exc.strerror or str(exc) or type(exc).__name__)
                    raise EvidenceError(f"source descriptor close failed: {detail}") from exc
                primary._cleanup_errors = getattr(primary, "_cleanup_errors", []) + [("source-close", exc)]
                if isinstance(primary, EvidenceError):
                    primary.args = (f"cleanup incomplete (source-close:{type(exc).__name__}); {primary}",)
                elif hasattr(primary, "add_note"):
                    primary.add_note(f"source cleanup incomplete (source-close:{type(exc).__name__})")
    if len(data) > INPUT_CAP:
        raise EvidenceError(f"source exceeds {INPUT_CAP}-byte input cap")
    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns)
    try:
        current = path.stat()
    except OSError as exc:
        raise EvidenceError(f"source changed while read: {exc.strerror}") from exc
    if identity(before) != identity(opened) or identity(opened) != identity(after) or identity(after) != identity(current):
        raise EvidenceError("source changed while read")
    return path, data, hashlib.sha256(data).hexdigest()


def decode_lines(data: bytes) -> list[str]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise EvidenceError(f"source is not valid UTF-8 at byte {exc.start}") from exc
    if text and not text.endswith("\n"):
        raise EvidenceError("source ends with an incomplete trailing JSON line")
    # Only a physical LF delimits JSONL. U+2028/U+2029 inside a JSON string do not.
    return text.split("\n")[:-1] if text else []


def load_line(
    text: str,
    line_number: int,
    *,
    _parse_float: Any = float,
    _parse_int: Any = int,
) -> dict[str, Any]:
    if not text.strip():
        raise EvidenceError(f"line {line_number}: blank JSONL record")
    try:
        value = json.loads(
            text, object_pairs_hook=no_duplicate_keys, parse_constant=reject_constant,
            parse_float=_parse_float, parse_int=_parse_int,
        )
    except EvidenceError as exc:
        raise EvidenceError(f"line {line_number}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise EvidenceError(f"line {line_number}: invalid JSON: {short(exc.msg)}") from exc
    except (ValueError, DecimalException) as exc:
        raise EvidenceError(f"line {line_number}: JSON value could not be decoded") from exc
    except (RecursionError, MemoryError) as exc:
        raise EvidenceError(f"line {line_number}: JSON nesting is too deep") from exc
    if not isinstance(value, dict):
        raise EvidenceError(f"line {line_number}: event must be an object")
    return value


def project_app_server(data: bytes, source: Path, digest: str, thread_id: str, turn_id: str, selected: set[str] | None) -> dict[str, Any]:
    records: dict[str, dict[str, Any]] = {}
    unrelated = 0
    for line_number, text in enumerate(decode_lines(data), 1):
        event = load_line(text, line_number)
        direction = event.get("direction")
        if direction == "send":
            unrelated += 1
            continue
        if direction != "receive":
            raise EvidenceError(f"line {line_number}: direction must be receive or send")
        message = event.get("message")
        if not isinstance(message, dict):
            raise EvidenceError(f"line {line_number}: message must be an object")
        method = message.get("method")
        if not isinstance(method, str) or not method:
            if "id" in message and (("result" in message) != ("error" in message)):
                unrelated += 1
                continue
            raise EvidenceError(f"line {line_number}: message.method must be a nonempty string")
        if method not in ("item/started", "item/completed"):
            unrelated += 1
            continue
        params = message.get("params")
        if not isinstance(params, dict):
            raise EvidenceError(f"line {line_number}: {method} params must be an object")
        record_thread = require_text(params.get("threadId"), f"line {line_number}: threadId")
        record_turn = require_text(params.get("turnId"), f"line {line_number}: turnId")
        if record_thread != thread_id or record_turn != turn_id:
            unrelated += 1
            continue
        item = params.get("item")
        if not isinstance(item, dict):
            raise EvidenceError(f"line {line_number}: matching {method} item must be an object")
        item_type = require_text(item.get("type"), f"line {line_number}: item.type")
        if item_type != "commandExecution":
            unrelated += 1
            continue

        item_id = require_text(item.get("id"), f"line {line_number}: item.id")
        status_value = require_text(item.get("status"), f"line {line_number}: item.status")
        command = require_text(item.get("command"), f"line {line_number}: item.command")
        cwd = item.get("cwd")
        process_id = item.get("processId")
        if cwd is not None and not isinstance(cwd, str):
            raise EvidenceError(f"line {line_number}: cwd must be a string or null")
        if isinstance(process_id, bool) or (process_id is not None and not isinstance(process_id, (str, int))):
            raise EvidenceError(f"line {line_number}: processId must be a string, integer, or null")
        exit_code_present = "exitCode" in item
        exit_code = item.get("exitCode")
        if status_value == "declined":
            if not exit_code_present:
                raise EvidenceError(f"line {line_number}: declined status requires explicit null exitCode")
            if exit_code is not None:
                raise EvidenceError(f"line {line_number}: declined status requires null exitCode")
        elif isinstance(exit_code, bool) or (exit_code is not None and not isinstance(exit_code, int)):
            raise EvidenceError(f"line {line_number}: exitCode must be an integer or null")
        phase = "start" if method == "item/started" else "terminal"
        if phase == "start":
            if status_value != "inProgress" or exit_code is not None:
                raise EvidenceError(f"line {line_number}: command start requires inProgress status and null exitCode")
        else:
            if status_value not in ("completed", "failed", "declined"):
                raise EvidenceError(f"line {line_number}: command terminal status must be completed, failed, or declined")
            if status_value != "declined" and exit_code is not None and ((status_value == "completed") != (exit_code == 0)):
                raise EvidenceError(f"line {line_number}: terminal status contradicts exitCode")
        normalized = {"status": status_value, "exit_code": exit_code, "command": command, "cwd": cwd, "process_id": process_id}
        slot = records.setdefault(item_id, {"start": None, "terminal": None})
        prior = slot[phase]
        if prior is not None:
            if prior["value"] != normalized:
                raise EvidenceError(f"line {line_number}: contradictory duplicate {phase} for item {short(item_id)}")
            continue  # identical re-emission is deterministically deduplicated
        if phase == "terminal" and slot["start"] is None:
            raise EvidenceError(f"line {line_number}: terminal before start for item {short(item_id)}")
        if phase == "terminal":
            start_value = slot["start"]["value"]
            for field in ("command", "cwd", "process_id"):
                if normalized[field] != start_value[field]:
                    raise EvidenceError(f"line {line_number}: terminal {field} contradicts start for item {short(item_id)}")
        slot[phase] = {"line": line_number, "value": normalized}

    if selected is not None:
        missing = sorted(selected - records.keys())
        if missing:
            raise EvidenceError(f"requested item IDs not found in scope ({len(missing)}): {short(', '.join(missing))}")
        records = {key: records[key] for key in sorted(selected)}

    commands = []
    for item_id, pair in sorted(records.items(), key=lambda entry: entry[1]["start"]["line"]):
        start = pair["start"]
        terminal = pair["terminal"]
        if terminal is None:
            classification = "missing_terminal"
            native_status = start["value"]["status"]
            exit_code = None
            terminal_line = None
        else:
            native_status = terminal["value"]["status"]
            exit_code = terminal["value"]["exit_code"]
            terminal_line = terminal["line"]
            classification = (
                "observed_declined" if native_status == "declined"
                else "incomplete_evidence" if exit_code is None
                else "observed_zero" if exit_code == 0
                else "observed_nonzero"
            )
        commands.append({
            "item_id": item_id,
            "start_line": start["line"],
            "terminal_line": terminal_line,
            "native_status": native_status,
            "exit_code": exit_code,
            "classification": classification,
        })
    return {
        "schema": "lunacy-native-command-index-v1",
        "source": {"path": str(source), "sha256": digest},
        "scope": {"thread_id": thread_id, "turn_id": turn_id, "selected_item_ids": sorted(selected) if selected is not None else None},
        "observed_command_count": len(commands),
        "ignored_unrelated_record_count": unrelated,
        "commands": commands,
        "projection_only": True,
        "non_claims": NON_CLAIMS,
    }


def require_string_array(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not value or any(not isinstance(part, str) for part in value):
        raise EvidenceError(f"{label} must be a nonempty string array")
    return value


def decoded_json_equal(left: Any, right: Any) -> bool:
    """Compare decoded JSON values without Python's bool/number coercion."""
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(
            decoded_json_equal(value, right[key]) for key, value in left.items()
        )
    if isinstance(left, list):
        return len(left) == len(right) and all(
            decoded_json_equal(left_item, right_item)
            for left_item, right_item in zip(left, right)
        )
    return left == right


def project_session_receipt(
    data: bytes,
    source: Path,
    digest: str,
    thread_id: str,
    turn_id: str,
    selected: set[str] | None,
    requested_session_id: str | None,
) -> dict[str, Any]:
    metadata: dict[str, Any] | None = None
    matching_context: dict[str, Any] | None = None
    commands: dict[str, dict[str, Any]] = {}

    for line_number, text in enumerate(decode_lines(data), 1):
        record = load_line(text, line_number, _parse_float=Decimal)
        record_type = record.get("type")
        if not isinstance(record_type, str) or not record_type:
            raise EvidenceError(f"line {line_number}: record type must be a nonempty string")

        if record_type == "session_meta":
            if metadata is not None:
                raise EvidenceError(f"line {line_number}: multiple session_meta records are ambiguous")
            payload = record.get("payload")
            if not isinstance(payload, dict):
                raise EvidenceError(f"line {line_number}: session_meta payload must be an object")
            ident = require_text(payload.get("id"), f"line {line_number}: session_meta.id")
            recorded_session_id = require_text(payload.get("session_id"), f"line {line_number}: session_meta.session_id")
            if ident != thread_id:
                raise EvidenceError(f"line {line_number}: session_meta.id does not match requested thread ID")
            expected_session_id = thread_id if requested_session_id is None else requested_session_id
            if recorded_session_id != expected_session_id:
                identity_label = "thread ID" if requested_session_id is None else "session ID"
                raise EvidenceError(
                    f"line {line_number}: session_meta.session_id does not match requested {identity_label}"
                )
            metadata = {"line": line_number, "session_id": recorded_session_id}
            continue

        if record_type == "turn_context":
            payload = record.get("payload")
            if not isinstance(payload, dict):
                raise EvidenceError(f"line {line_number}: turn_context payload must be an object")
            record_turn = require_text(payload.get("turn_id"), f"line {line_number}: turn_context.turn_id")
            if record_turn != turn_id:
                continue
            model = require_text(payload.get("model"), f"line {line_number}: turn_context.model")
            effort = require_text(payload.get("effort"), f"line {line_number}: turn_context.effort")
            identity = {"model": model, "effort": effort}
            if matching_context is not None:
                if matching_context["identity"] != identity:
                    raise EvidenceError(f"line {line_number}: conflicting turn_context identity for requested turn")
                continue
            matching_context = {"line": line_number, "identity": identity}
            continue

        if record_type != "event_msg":
            continue
        payload = record.get("payload")
        if not isinstance(payload, dict):
            raise EvidenceError(f"line {line_number}: event_msg payload must be an object")
        payload_type = require_text(payload.get("type"), f"line {line_number}: event_msg payload.type")
        if payload_type != "item_completed":
            continue
        item = payload.get("item")
        if not isinstance(item, dict):
            raise EvidenceError(f"line {line_number}: item_completed item must be an object")
        item_type = require_text(item.get("type"), f"line {line_number}: item.type")
        if item_type != "CommandExecution":
            continue

        record_thread = require_text(payload.get("thread_id"), f"line {line_number}: thread_id")
        record_turn = require_text(payload.get("turn_id"), f"line {line_number}: turn_id")
        if record_thread != thread_id:
            raise EvidenceError(f"line {line_number}: conflicting thread_id in CommandExecution completion")
        item_id = require_text(item.get("id"), f"line {line_number}: item.id")
        require_string_array(item.get("command"), f"line {line_number}: item.command")
        status_value = require_text(item.get("status"), f"line {line_number}: item.status")
        if "exit_code" not in item:
            raise EvidenceError(f"line {line_number}: item.exit_code must be present")
        exit_code = item["exit_code"]
        if isinstance(exit_code, bool) or (exit_code is not None and not isinstance(exit_code, int)):
            raise EvidenceError(f"line {line_number}: item.exit_code must be an integer or null")

        prior = commands.get(item_id) if record_turn == turn_id else None
        if record_turn != turn_id:
            continue
        if prior is not None:
            if not decoded_json_equal(prior["item"], item):
                raise EvidenceError(f"line {line_number}: contradictory duplicate completion for item {short(item_id)}")
            continue
        commands[item_id] = {
            "line": line_number,
            "item": item,
            "status": status_value,
            "exit_code": exit_code,
        }

    if metadata is None:
        raise EvidenceError("source has no session_meta record")
    if matching_context is None:
        raise EvidenceError("source has no matching turn_context for requested turn")

    if selected is not None:
        missing = sorted(selected - commands.keys())
        if missing:
            raise EvidenceError(f"requested item IDs not found in scope ({len(missing)}): {short(', '.join(missing))}")
        commands = {key: commands[key] for key in selected}

    projected_commands = [
        {
            "item_id": item_id,
            "completion_line": value["line"],
            "status": value["status"],
            "exit_code": value["exit_code"],
        }
        for item_id, value in sorted(commands.items(), key=lambda entry: entry[1]["line"])
    ]
    session = {
        "metadata_line": metadata["line"],
        "context_line": matching_context["line"],
        "recorded_model": matching_context["identity"]["model"],
        "recorded_effort": matching_context["identity"]["effort"],
        "context_thread_basis": "source-associated",
    }
    if requested_session_id is not None:
        session["recorded_session_id"] = metadata["session_id"]
    return {
        "schema": "lunacy-session-command-index-v1",
        "source": {"path": str(source), "sha256": digest},
        "scope": {
            "thread_id": thread_id,
            "turn_id": turn_id,
            "selected_item_ids": sorted(selected) if selected is not None else None,
        },
        "session": session,
        "observed_command_count": len(projected_commands),
        "commands": projected_commands,
        "projection_only": True,
        "non_claims": SESSION_NON_CLAIMS,
    }


def load_direct_exec_line(text: str, line_number: int) -> dict[str, Any]:
    """Decode a direct-exec record without echoing excluded JSON content."""
    def bounded_integer(value: str) -> int:
        if len(value.removeprefix("-")) > TEXT_CAP:
            raise EvidenceError("direct-exec JSON integer is too large")
        return int(value)

    try:
        record = load_line(text, line_number, _parse_int=bounded_integer)
        # Keep only iterators for currently active containers. Enqueuing every
        # child would add breadth-proportional tuple storage for wide JSON.
        stack = [(iter((record,)), 0)]
        while stack:
            children, depth = stack[-1]
            try:
                value = next(children)
            except StopIteration:
                stack.pop()
                continue
            if depth > 512:
                raise EvidenceError("direct-exec JSON nesting is too deep")
            if isinstance(value, dict):
                stack.append((iter(value.values()), depth + 1))
            elif isinstance(value, list):
                stack.append((iter(value), depth + 1))
        return record
    except (EvidenceError, RecursionError, MemoryError) as exc:
        raise EvidenceError(f"line {line_number}: invalid direct-exec JSON record") from exc


def project_direct_exec(
    data: bytes,
    source: Path,
    digest: str,
    thread_id: str,
    selected: set[str] | None,
) -> dict[str, Any]:
    supported_events = {
        "thread.started", "turn.started", "turn.completed", "turn.failed",
        "item.started", "item.updated", "item.completed", "error",
    }
    command_groups: dict[str, list[dict[str, Any]]] = {}
    header_line: int | None = None
    turn_start_line: int | None = None
    turn_end_line: int | None = None
    turn_end_event: str | None = None
    ignored_noncommand = 0

    lines = decode_lines(data)
    for line_number, text in enumerate(lines, 1):
        record = load_direct_exec_line(text, line_number)
        event = record.get("type")
        if not isinstance(event, str) or not event:
            raise EvidenceError(f"line {line_number}: malformed direct-exec event kind")
        if event not in supported_events:
            raise EvidenceError(f"line {line_number}: unsupported direct-exec event kind")
        if "turn_id" in record:
            raise EvidenceError(f"line {line_number}: top-level turn_id is unsupported")

        if event == "thread.started":
            if line_number != 1 or header_line is not None:
                raise EvidenceError(f"line {line_number}: multiple or misplaced thread headers")
            header_thread = record.get("thread_id")
            if not isinstance(header_thread, str) or not header_thread:
                raise EvidenceError(f"line {line_number}: thread header ID must be a nonempty string")
            if header_thread != thread_id:
                raise EvidenceError(f"line {line_number}: thread header does not match requested thread ID")
            header_line = line_number
            continue

        if line_number == 1:
            raise EvidenceError("line 1: first direct-exec record must be thread.started")
        if "thread_id" in record and record["thread_id"] != thread_id:
            raise EvidenceError(f"line {line_number}: conflicting top-level thread identity")

        if event == "turn.started":
            if turn_start_line is not None or turn_end_line is not None:
                raise EvidenceError(f"line {line_number}: multiple or misplaced turn starts")
            turn_start_line = line_number
            continue
        if event in ("turn.completed", "turn.failed"):
            if turn_start_line is None:
                raise EvidenceError(f"line {line_number}: turn end precedes turn start")
            if turn_end_line is not None:
                raise EvidenceError(f"line {line_number}: repeated or competing turn end")
            turn_end_line = line_number
            turn_end_event = event
            continue
        if event == "error":
            ignored_noncommand += 1
            continue

        # Every known item envelope is structurally checked, even when its item
        # kind is intentionally outside this narrow projection.
        item = record.get("item")
        if not isinstance(item, dict):
            raise EvidenceError(f"line {line_number}: item envelope must contain an object")
        item_type = item.get("type")
        if not isinstance(item_type, str) or not item_type:
            raise EvidenceError(f"line {line_number}: item.type must be a nonempty string")
        if item_type != "command_execution":
            ignored_noncommand += 1
            continue
        if turn_start_line is None or turn_end_line is not None:
            raise EvidenceError(f"line {line_number}: command observation is outside the observed turn scope")

        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            raise EvidenceError(f"line {line_number}: command item.id must be a nonempty string")
        if len(item_id) > TEXT_CAP:
            raise EvidenceError(f"line {line_number}: command item.id exceeds {TEXT_CAP} characters")
        status_value = item.get("status")
        if not isinstance(status_value, str) or not status_value:
            raise EvidenceError(f"line {line_number}: command item.status must be a nonempty string")
        if len(status_value) > TEXT_CAP:
            raise EvidenceError(f"line {line_number}: command item.status exceeds {TEXT_CAP} characters")
        exit_present = "exit_code" in item
        exit_code = item.get("exit_code")
        if exit_present and (isinstance(exit_code, bool) or (exit_code is not None and not isinstance(exit_code, int))):
            raise EvidenceError(f"line {line_number}: command item.exit_code must be an integer or null")
        command_groups.setdefault(item_id, []).append({
            "line": line_number,
            "event": event,
            "native_status": status_value,
            "exit_code_present": exit_present,
            "exit_code": exit_code,
        })

    if header_line is None:
        raise EvidenceError("source has no direct-exec thread header")
    if turn_start_line is None:
        raise EvidenceError("source has no direct-exec turn start")
    if selected is not None:
        missing = sorted(selected - command_groups.keys())
        if missing:
            raise EvidenceError(f"requested item IDs not found in scope ({len(missing)}): {short(', '.join(missing))}")

    included = command_groups if selected is None else {
        item_id: observations for item_id, observations in command_groups.items()
        if item_id in selected
    }
    commands = [
        {"item_id": item_id, "observations": observations}
        for item_id, observations in sorted(included.items(), key=lambda entry: entry[1][0]["line"])
    ]
    return {
        "schema": "lunacy-native-direct-exec-index-v1",
        "source": {"path": str(source), "sha256": digest},
        "scope": {
            "thread_id": thread_id,
            "selected_item_ids": sorted(selected) if selected is not None else None,
        },
        "thread_header_line": header_line,
        "turn": {"start_line": turn_start_line, "end_line": turn_end_line, "end_event": turn_end_event},
        "observed_command_count": len(commands),
        "observed_command_record_count": sum(len(command["observations"]) for command in commands),
        "ignored_noncommand_record_count": ignored_noncommand,
        "commands": commands,
        "projection_only": True,
        "non_claims": DIRECT_EXEC_NON_CLAIMS,
    }


def emit(value: dict[str, Any], cap: int, *, ensure_ascii: bool = False) -> int:
    encoded = (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=ensure_ascii) + "\n").encode("utf-8", "backslashreplace")
    if len(encoded) <= cap:
        sys.stdout.buffer.write(encoded)
        return 0
    diagnostic = {
        "error": "output_cap_exceeded",
        "limit_bytes": cap,
        "required_bytes": len(encoded),
        "remedy": "select fewer item IDs with --item-id or raise --output-cap within the supported limit",
    }
    fallback = (json.dumps(diagnostic, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if len(fallback) <= cap:
        sys.stdout.buffer.write(fallback)
    else:
        sys.stderr.write("output cap is too small for the diagnostic\n")
    return 3


def emit_error(exc: Exception, cap: int) -> int:
    limit = min(cap, DIAGNOSTIC_CAP)
    prefix = "evidence-index: "
    message = short(exc, max(16, limit - len(prefix) - 2))
    encoded = (prefix + message + "\n").encode("utf-8", "replace")
    if len(encoded) > limit:
        encoded = encoded[:limit - 1].decode("utf-8", "ignore").encode("utf-8") + b"\n"
    sys.stderr.buffer.write(encoded)
    return 2


def parse_args() -> argparse.Namespace:
    parser = EvidenceArgumentParser(description=__doc__)
    parser.add_argument("source", help="caller-authorized absolute path to a regular JSONL capture")
    parser.add_argument("--source-format", choices=("app-server", "session-receipt", "direct-exec"), default="app-server")
    parser.add_argument("--thread-id", required=True)
    parser.add_argument("--session-id")
    parser.add_argument("--turn-id")
    parser.add_argument("--item-id", action="append", dest="item_ids")
    parser.add_argument("--expected-sha256")
    parser.add_argument("--output-cap", type=int, default=DEFAULT_OUTPUT_CAP)
    args = parser.parse_args()
    if not 256 <= args.output_cap <= MAX_OUTPUT_CAP:
        parser.error(f"--output-cap must be between 256 and {MAX_OUTPUT_CAP}")
    if args.expected_sha256 is not None and (len(args.expected_sha256) != 64 or any(c not in "0123456789abcdef" for c in args.expected_sha256)):
        parser.error("--expected-sha256 must be 64 lowercase hexadecimal characters")
    if args.item_ids is not None and len(set(args.item_ids)) != len(args.item_ids):
        parser.error("--item-id values must be unique")
    if args.source_format == "direct-exec":
        if args.turn_id is not None:
            parser.error("--turn-id is forbidden for --source-format direct-exec")
        if args.session_id is not None:
            parser.error("--session-id is forbidden for --source-format direct-exec")
    elif args.turn_id is None or not args.turn_id:
        parser.error("--turn-id is required and must be nonempty for app-server and session-receipt")
    if args.session_id is not None:
        if args.source_format != "session-receipt":
            parser.error("--session-id requires --source-format session-receipt")
        if not args.session_id:
            parser.error("--session-id must be a nonempty string")
    return args


def main() -> int:
    try:
        args = parse_args()
    except (EvidenceError, RecursionError, MemoryError) as exc:
        # Argument parsing cannot trust --output-cap until the complete argv has
        # been parsed and validated, so use the minimum supported allowance.
        return emit_error(exc, 256)
    try:
        source, data, digest = read_snapshot(args.source)
        if args.expected_sha256 is not None and digest != args.expected_sha256:
            raise EvidenceError(f"source SHA-256 mismatch: expected {args.expected_sha256}, observed {digest}")
        selected = None if args.item_ids is None else {require_text(item, "requested item ID") for item in args.item_ids}
        if selected is not None and any(len(item) > TEXT_CAP for item in selected):
            raise EvidenceError(f"requested item ID exceeds {TEXT_CAP} characters")
        thread_id = require_text(args.thread_id, "thread ID")
        if args.source_format == "app-server":
            turn_id = require_text(args.turn_id, "turn ID")
            result = project_app_server(data, source, digest, thread_id, turn_id, selected)
        elif args.source_format == "session-receipt":
            turn_id = require_text(args.turn_id, "turn ID")
            result = project_session_receipt(
                data, source, digest, thread_id, turn_id, selected, args.session_id
            )
        else:
            result = project_direct_exec(data, source, digest, thread_id, selected)
        return emit(result, args.output_cap, ensure_ascii=args.source_format == "session-receipt")
    except (EvidenceError, RecursionError, MemoryError) as exc:
        return emit_error(exc, args.output_cap)


if __name__ == "__main__":
    raise SystemExit(main())
