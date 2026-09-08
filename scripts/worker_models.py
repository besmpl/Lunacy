#!/usr/bin/env python3
"""Read the visible Codex model catalog and resolve task-local worker roles."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time
from typing import Any


CATALOG_CAP = 8 * 1024 * 1024
MAX_PAGES = 32
PAGE_LIMIT = 100
CURSOR_CAP = 1024
DEADLINE_SECONDS = 10.0
DIAGNOSTIC_CAP = 512
ROLE_DEFAULTS = {
    "bulk": ("gpt-5.6-luna", "max", "luna"),
    "judgment": ("gpt-5.6-sol", "medium", "sol-medium"),
}


class WorkerModelError(Exception):
    pass


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise WorkerModelError(message)


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise WorkerModelError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _constant(value: str) -> None:
    raise WorkerModelError(f"nonstandard JSON constant: {value}")


def _decode(data: bytes, label: str) -> Any:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise WorkerModelError(f"{label} is not valid UTF-8") from exc
    try:
        return json.loads(text, object_pairs_hook=_pairs, parse_constant=_constant)
    except WorkerModelError:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise WorkerModelError(f"{label} is not complete valid JSON: {exc}") from exc


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise WorkerModelError(f"{label} must be a nonempty string")
    return value


def _validate_catalog(value: Any) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    if not isinstance(value, dict):
        raise WorkerModelError("catalog must be an object")
    if set(value) != {"data", "nextCursor"}:
        raise WorkerModelError("catalog must contain exactly data and nextCursor")
    if value["nextCursor"] is not None:
        raise WorkerModelError("catalog is incomplete: nextCursor must be null")
    data = value["data"]
    if not isinstance(data, list):
        raise WorkerModelError("catalog data must be an array")
    by_model: dict[str, dict[str, Any]] = {}
    picker_ids: set[str] = set()
    for number, model in enumerate(data):
        label = f"catalog data[{number}]"
        if not isinstance(model, dict):
            raise WorkerModelError(f"{label} must be an object")
        model_id = _text(model.get("id"), f"{label}.id")
        dispatch_model = _text(model.get("model"), f"{label}.model")
        display = _text(model.get("displayName"), f"{label}.displayName")
        if model.get("hidden") is not False:
            raise WorkerModelError(f"{label} ({model_id}) is hidden or lacks hidden=false")
        default = _text(model.get("defaultReasoningEffort"), f"{label}.defaultReasoningEffort")
        supported_raw = model.get("supportedReasoningEfforts")
        if not isinstance(supported_raw, list) or not supported_raw:
            raise WorkerModelError(f"{label}.supportedReasoningEfforts must be a nonempty array")
        efforts: set[str] = set()
        for effort_number, item in enumerate(supported_raw):
            if not isinstance(item, dict):
                raise WorkerModelError(f"{label}.supportedReasoningEfforts[{effort_number}] must be an object")
            effort = _text(item.get("reasoningEffort"), f"{label}.supportedReasoningEfforts[{effort_number}].reasoningEffort")
            if effort in efforts:
                raise WorkerModelError(f"{label} has duplicate reasoning effort {effort}")
            efforts.add(effort)
        if default not in efforts:
            raise WorkerModelError(f"{label} default reasoning effort is unsupported")
        if model_id in picker_ids:
            raise WorkerModelError(f"duplicate picker id: {model_id}")
        if dispatch_model in by_model:
            raise WorkerModelError(f"duplicate dispatch model: {dispatch_model}")
        picker_ids.add(model_id)
        # Store derived values privately; output remains the original catalog data.
        by_model[dispatch_model] = {
            "value": model, "picker_id": model_id, "display": display,
            "default": default, "efforts": efforts,
        }
    return data, by_model


def _read_catalog(path_text: str) -> Any:
    path = Path(path_text)
    nonblocking = getattr(os, "O_NONBLOCK", None)
    if nonblocking is None:
        raise WorkerModelError("nonblocking file acquisition is unavailable on this platform")
    flags = os.O_RDONLY | nonblocking
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise WorkerModelError(f"catalog is unreadable: {exc.strerror}") from exc
    primary: BaseException | None = None
    try:
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise WorkerModelError("catalog must be a regular file")
            if info.st_size > CATALOG_CAP:
                raise WorkerModelError(f"catalog exceeds {CATALOG_CAP}-byte limit")
            with os.fdopen(descriptor, "rb") as source:
                descriptor = -1
                data = source.read(CATALOG_CAP + 1)
        except OSError as exc:
            raise WorkerModelError(f"catalog is unreadable: {exc.strerror}") from exc
    except BaseException as exc:
        primary = exc
        raise
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError as exc:
                if primary is None:
                    detail = exc.strerror or str(exc) or type(exc).__name__
                    raise WorkerModelError(f"catalog descriptor close failed: {detail}") from exc
                primary._cleanup_errors = getattr(primary, "_cleanup_errors", []) + [("catalog-close", exc)]
                if not isinstance(primary, WorkerModelError) and hasattr(primary, "add_note"):
                    primary.add_note(f"catalog cleanup incomplete (catalog-close:{type(exc).__name__})")
    if len(data) > CATALOG_CAP:
        raise WorkerModelError(f"catalog exceeds {CATALOG_CAP}-byte limit")
    return _decode(data, "catalog")


def _find_model(query: str, by_model: dict[str, dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    # The dispatch model is canonical. Picker IDs and display labels are accepted
    # only when their exact spelling identifies one canonical model.
    if query in by_model:
        return query, by_model[query]
    matches = [
        (dispatch_model, item) for dispatch_model, item in by_model.items()
        if item["display"] == query or item["picker_id"] == query
    ]
    if not matches:
        raise WorkerModelError(f"model not found by exact id or display label: {query}")
    if len(matches) != 1:
        raise WorkerModelError(f"ambiguous exact picker id or display label: {query}")
    return matches[0]


def resolve_roles(catalog: Any, args: argparse.Namespace) -> dict[str, Any]:
    _, by_model = _validate_catalog(catalog)
    roles: dict[str, Any] = {}
    for role in ("bulk", "judgment"):
        custom_model = getattr(args, f"{role}_model")
        custom_effort = getattr(args, f"{role}_effort")
        default_model, default_effort, alias = ROLE_DEFAULTS[role]
        if custom_model is None:
            if default_model not in by_model:
                raise WorkerModelError(f"canonical default model is unavailable: {default_model}")
            dispatch_model, item = default_model, by_model[default_model]
            effort = custom_effort if custom_effort is not None else default_effort
            selection = "explicit" if custom_effort is not None else "named-default"
        else:
            dispatch_model, item = _find_model(custom_model, by_model)
            if custom_effort is not None:
                effort = custom_effort
            elif args.use_catalog_default_effort:
                effort = item["default"]
            else:
                raise WorkerModelError(
                    f"--{role}-model requires --{role}-effort or --use-catalog-default-effort"
                )
            selection = "explicit"
        if effort not in item["efforts"]:
            raise WorkerModelError(f"model {dispatch_model} does not support reasoning effort {effort}")
        roles[role] = {
            "model": dispatch_model,
            "effort": effort,
            "displayName": item["display"],
            "selection": selection,
            "namedAlias": alias if dispatch_model == default_model and effort == default_effort else None,
            "codexExecArgs": [
                "codex", "exec", "-m", dispatch_model, "-c",
                f"model_reasoning_effort={json.dumps(effort, ensure_ascii=False)}",
            ],
        }
    return {"roles": roles, "launchPerformed": False}


def _raise_with_cleanup(primary: BaseException | None, errors: list[tuple[str, BaseException]]) -> None:
    """Retain actual secondary errors; interruptions outrank ordinary failures."""
    interruptions = [exc for _, exc in errors if not isinstance(exc, Exception)]
    if interruptions:
        interruption = interruptions[0]
        interruption._cleanup_errors = errors
        if interruption is primary:
            raise interruption
        raise interruption from primary
    if primary is None and errors:
        primary = next((exc for _, exc in errors if not isinstance(exc, (OSError, ValueError, subprocess.SubprocessError))), None)
        if primary is None:
            primary = WorkerModelError("app-server cleanup failed")
            primary.__cause__ = errors[0][1]
    if primary is not None:
        if errors:
            primary._cleanup_errors = getattr(primary, "_cleanup_errors", []) + errors
        raise primary


def _settle_process(process: subprocess.Popen[bytes], selector: selectors.BaseSelector | None, deadline: float) -> tuple[int | None, list[tuple[str, BaseException]]]:
    """Attempt independent releases and finite escalation for this owned leader."""
    errors: list[tuple[str, BaseException]] = []
    def attempt(stage, operation):
        try:
            return operation()
        except BaseException as exc:
            errors.append((stage, exc))
            return None
    if selector is not None:
        attempt("selector-close", selector.close)
    if process.stdin is not None:
        attempt("stdin-close", process.stdin.close)
    returncode = None
    for index, budget in enumerate((max(0.0, deadline - time.monotonic()), 1, 1)):
        if index:
            try:
                os.killpg(process.pid, signal.SIGTERM if index == 1 else signal.SIGKILL)
            except ProcessLookupError:
                pass  # Only a subsequent wait can establish the leader outcome.
            except BaseException as exc:
                errors.append(("term" if index == 1 else "kill", exc))
        try:
            returncode = process.wait(timeout=budget)
            break
        except subprocess.TimeoutExpired as exc:
            if index == 2:
                errors.append(("wait", exc))
        except BaseException as exc:
            errors.append(("wait", exc))
    if process.stdout is not None:
        attempt("stdout-close", process.stdout.close)
    return returncode, errors


def _write_message(process: subprocess.Popen[bytes], message: dict[str, Any], deadline: float) -> None:
    assert process.stdin is not None
    data = (json.dumps(message, separators=(",", ":")) + "\n").encode()
    written = 0
    writer = None
    primary = None
    try:
        writer = selectors.DefaultSelector()
        os.set_blocking(process.stdin.fileno(), False)
        writer.register(process.stdin, selectors.EVENT_WRITE)
        while written < len(data):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not writer.select(remaining):
                raise WorkerModelError("app-server write deadline exceeded")
            amount = os.write(process.stdin.fileno(), data[written:])
            if amount <= 0:
                raise WorkerModelError("app-server closed stdin")
            written += amount
    except (OSError, ValueError) as exc:
        primary = WorkerModelError("app-server closed stdin")
        primary.__cause__ = exc
    except BaseException as exc:
        primary = exc
    errors = []
    if writer is not None:
        try:
            writer.close()
        except BaseException as exc:
            errors.append(("writer-close", exc))
    _raise_with_cleanup(primary, errors)


def _request(process: subprocess.Popen[bytes], selector: selectors.BaseSelector, request: dict[str, Any], request_id: int, deadline: float, total: list[int], pending: bytearray) -> Any:
    _write_message(process, request, deadline)
    while True:
        newline = pending.find(b"\n")
        if newline >= 0:
            line = bytes(pending[:newline])
            del pending[: newline + 1]
            if not line:
                continue
            message = _decode(line, "app-server response line")
            if not isinstance(message, dict):
                raise WorkerModelError("app-server message must be an object")
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise WorkerModelError(f"app-server request {request_id} failed: {message['error']}")
            if "result" not in message:
                raise WorkerModelError(f"app-server response {request_id} lacks result")
            return message["result"]
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise WorkerModelError("app-server deadline exceeded")
        try:
            events = selector.select(remaining)
        except (OSError, ValueError) as exc:
            raise WorkerModelError("app-server stdout cannot be monitored") from exc
        if not events:
            raise WorkerModelError("app-server deadline exceeded")
        for key, _ in events:
            try:
                chunk = os.read(key.fileobj.fileno(), 65536)
            except OSError as exc:
                raise WorkerModelError("app-server stdout read failed") from exc
            if not chunk:
                raise WorkerModelError("app-server exited before the expected response")
            total[0] += len(chunk)
            if total[0] > CATALOG_CAP:
                raise WorkerModelError(f"app-server output exceeds {CATALOG_CAP}-byte limit")
            pending.extend(chunk)


def read_live_catalog(codex: str) -> dict[str, Any]:
    if os.name != "posix":
        raise WorkerModelError("catalog transport requires POSIX pipe selector support")
    deadline = time.monotonic() + DEADLINE_SECONDS
    try:
        process = subprocess.Popen(
            [codex, "app-server", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, start_new_session=True,
        )
    except OSError as exc:
        raise WorkerModelError(f"cannot start codex app-server: {exc.strerror}") from exc
    selector = None
    primary = None
    completed: dict[str, Any] | None = None
    try:
        assert process.stdout is not None
        total = [0]
        pending = bytearray()
        try:
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
        except (OSError, ValueError) as exc:
            raise WorkerModelError("app-server stdout cannot be monitored") from exc
        _request(process, selector, {
            "id": 1, "method": "initialize",
            "params": {"clientInfo": {"name": "lunacy_worker_models", "version": "1"}},
        }, 1, deadline, total, pending)
        _write_message(process, {"method": "initialized", "params": {}}, deadline)
        models: list[dict[str, Any]] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        for page in range(MAX_PAGES):
            request_id = page + 2
            result = _request(process, selector, {
                "id": request_id, "method": "model/list",
                "params": {"includeHidden": False, "limit": PAGE_LIMIT, "cursor": cursor},
            }, request_id, deadline, total, pending)
            if not isinstance(result, dict) or not isinstance(result.get("data"), list):
                raise WorkerModelError("model/list result must contain a data array")
            next_cursor = result.get("nextCursor")
            if next_cursor is not None and (not isinstance(next_cursor, str) or not next_cursor):
                raise WorkerModelError("model/list nextCursor must be null or a nonempty string")
            if isinstance(next_cursor, str) and len(next_cursor) > CURSOR_CAP:
                raise WorkerModelError(f"model/list nextCursor exceeds {CURSOR_CAP}-character limit")
            models.extend(result["data"])
            if next_cursor is None:
                completed = {"data": models, "nextCursor": None}
                _validate_catalog(completed)
                break
            if next_cursor in seen_cursors:
                raise WorkerModelError("model/list pagination cursor repeated")
            seen_cursors.add(next_cursor)
            cursor = next_cursor
        if completed is None:
            raise WorkerModelError(f"model/list exceeds {MAX_PAGES}-page limit")
    except BaseException as exc:
        primary = exc
    returncode, errors = _settle_process(process, selector, deadline)
    if primary is None:
        # Unexpected cleanup failures outrank exit-status refusal, not an
        # already-existing collection failure.
        primary = next((exc for _, exc in errors if not isinstance(exc, (OSError, ValueError, subprocess.SubprocessError))), None)
        if primary is None and returncode is not None and returncode != 0:
            primary = WorkerModelError(f"codex app-server exited with status {returncode}")
    _raise_with_cleanup(primary, errors)
    assert completed is not None
    return completed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = Parser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    catalog = sub.add_parser("catalog")
    catalog.add_argument("--codex", default="codex")
    resolve = sub.add_parser("resolve")
    resolve.add_argument("--catalog", required=True)
    for role in ("bulk", "judgment"):
        resolve.add_argument(f"--{role}-model")
        resolve.add_argument(f"--{role}-effort")
    resolve.add_argument("--use-catalog-default-effort", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        result = read_live_catalog(args.codex) if args.command == "catalog" else resolve_roles(_read_catalog(args.catalog), args)
        try:
            prepared = json.dumps(result, allow_nan=False, sort_keys=True, separators=(",", ":")) + "\n"
        except ValueError as exc:
            raise WorkerModelError(f"cannot serialize result as strict JSON: {exc}") from exc
        if args.command == "catalog":
            encoded = prepared.encode("utf-8")
            if len(encoded) > CATALOG_CAP:
                raise WorkerModelError(f"serialized catalog exceeds {CATALOG_CAP}-byte limit")
            sys.stdout.buffer.write(encoded)
        else:
            sys.stdout.write(prepared)
        return 0
    except (WorkerModelError, RecursionError, MemoryError) as exc:
        cleanup = getattr(exc, "_cleanup_errors", [])
        if any(error is exc for _, error in cleanup):
            # An unexpected cleanup MemoryError/RecursionError is not a
            # collection/resource-limit refusal merely because main catches it.
            raise
        context = ""
        if cleanup:
            stages = ",".join(f"{stage}:{type(error).__name__}" for stage, error in cleanup)
            context = f"failure; cleanup incomplete ({stages}): "
        message = f"worker-models: {context}{exc}".replace("\n", "\\n").replace("\r", "\\r")
        body = message.encode("utf-8", "replace")
        if len(body) > DIAGNOSTIC_CAP - 1:
            body = body[:DIAGNOSTIC_CAP - 1].decode("utf-8", "ignore").encode("utf-8")
        encoded = body + b"\n"
        sys.stderr.buffer.write(encoded)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
