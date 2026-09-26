#!/usr/bin/env python3
"""Run one explicit argv with a deadline and bounded output capture."""

from __future__ import annotations

import argparse
import errno
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time


SCHEMA = "lunacy-command-result-v1"
FINAL_OBSERVATION_SECONDS = 2.0
MAX_ARG_CHARS = 4096
MAX_ARGV_BYTES = 64 * 1024
MAX_STDIN_BYTES = 64 * 1024 * 1024
INPUT_WRITE_QUANTUM = 16 * 1024


class Capture:
    """Keep a byte-exact fixed head and chronological fixed tail."""

    def __init__(self, limit: int, tail_limit: int):
        self.limit = limit
        self.tail_limit = tail_limit
        self.head_limit = limit - tail_limit
        self.head = bytearray()
        self.tail = bytearray()
        self.observed = 0

    def add(self, data: bytes) -> None:
        self.observed += len(data)
        head_room = self.head_limit - len(self.head)
        if head_room > 0:
            take = min(head_room, len(data))
            self.head.extend(data[:take])
            data = data[take:]
        if data and self.tail_limit:
            self.tail.extend(data)
            if len(self.tail) > self.tail_limit:
                del self.tail[:len(self.tail) - self.tail_limit]

    @property
    def retained(self) -> bytes:
        return bytes(self.head + self.tail)

    @property
    def dropped(self) -> int:
        return self.observed - len(self.head) - len(self.tail)

    def log_bytes(self) -> bytes:
        if not self.dropped:
            return self.retained
        marker = ("\n[LUNACY_CAPTURE_TRUNCATED observed_dropped_bytes="
                  f"{self.dropped}]\n").encode("ascii")
        return bytes(self.head) + marker + bytes(self.tail)


class UsageError(Exception):
    pass


def diagnostic(message: str) -> None:
    prefix = "run-command: "
    raw = (prefix + message).encode("utf-8", "replace")
    raw = raw[:512]
    while True:
        try:
            text = raw.decode("utf-8")
            break
        except UnicodeDecodeError:
            raw = raw[:-1]
    sys.stderr.write(text + "\n")


def integer(name: str, low: int, high: int):
    def parse(value: str) -> int:
        try:
            number = int(value)
        except ValueError as exc:
            raise argparse.ArgumentTypeError(f"{name} must be an integer") from exc
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f"{name} must be from {low} through {high}")
        return number
    return parse


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise UsageError(message)


def parse_args(arguments: list[str]):
    parser = Parser(add_help=True, allow_abbrev=False)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--log")
    parser.add_argument("--stdout-log")
    parser.add_argument("--stderr-log")
    parser.add_argument("--deadline-seconds", required=True,
                        type=integer("deadline-seconds", 1, 86400))
    parser.add_argument("--term-grace-seconds", default=2,
                        type=integer("term-grace-seconds", 0, 30))
    parser.add_argument("--capture-limit", default=1024 * 1024,
                        type=integer("capture-limit", 1024, 64 * 1024 * 1024))
    parser.add_argument("--tail-bytes", default=16 * 1024,
                        type=integer("tail-bytes", 0, 64 * 1024 * 1024))
    parser.add_argument("--preview-bytes", default=16 * 1024,
                        type=integer("preview-bytes", 0, 16 * 1024))
    parser.add_argument("--stdout-capture-bytes", default=None,
                        type=integer("stdout-capture-bytes", 1, 64 * 1024 * 1024))
    parser.add_argument("--stdin-file")
    parser.add_argument("--stdin-limit", default=None,
                        type=integer("stdin-limit", 0, MAX_STDIN_BYTES))
    option_arguments = arguments[:arguments.index("--")] if "--" in arguments else arguments
    if "--help" in option_arguments or "-h" in option_arguments:
        parser.parse_args(option_arguments)
    if "--" not in arguments:
        raise UsageError("a mandatory -- must precede the command argv")
    separator = arguments.index("--")
    options, command = arguments[:separator], arguments[separator + 1:]
    if not command:
        raise UsageError("command argv must not be empty")
    parsed = parser.parse_args(options)
    split = parsed.stdout_log is not None or parsed.stderr_log is not None
    if parsed.log is not None and split:
        raise UsageError("log and split log options are mutually exclusive")
    if parsed.log is None and not split:
        raise UsageError("either log or both stdout-log and stderr-log are required")
    if split and (parsed.stdout_log is None or parsed.stderr_log is None):
        raise UsageError("both stdout-log and stderr-log are required in split mode")
    if parsed.stdout_capture_bytes is not None and not split:
        raise UsageError("stdout-capture-bytes requires split mode")
    if split:
        stdout_limit = (parsed.capture_limit // 2 if parsed.stdout_capture_bytes is None
                        else parsed.stdout_capture_bytes)
        if not 1 <= stdout_limit < parsed.capture_limit:
            raise UsageError("stdout-capture-bytes must be from 1 through capture-limit minus 1")
        parsed.stdout_capture_bytes = stdout_limit
        parsed.stderr_capture_bytes = parsed.capture_limit - stdout_limit
        if (parsed.tail_bytes > parsed.stdout_capture_bytes
                or parsed.tail_bytes > parsed.stderr_capture_bytes):
            raise UsageError("tail-bytes must not exceed either split stream limit")
    elif parsed.tail_bytes > parsed.capture_limit:
        raise UsageError("tail-bytes must not exceed capture-limit")
    if parsed.stdin_limit is not None and parsed.stdin_file is None:
        raise UsageError("stdin-limit requires stdin-file")
    if parsed.stdin_file is not None and parsed.stdin_limit is None:
        parsed.stdin_limit = 1024 * 1024
    for argument in command:
        if len(argument) > MAX_ARG_CHARS:
            raise UsageError("one command argument exceeds 4096 characters")
        try:
            argument.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise UsageError("command arguments must be UTF-8 encodable") from exc
    if sum(len(arg.encode("utf-8")) + 1 for arg in command) > MAX_ARGV_BYTES:
        raise UsageError("combined command argv exceeds 64 KiB")
    return parsed, command


def validate_host_and_paths(args) -> tuple[Path, dict[str, Path]]:
    if os.name != "posix" or not hasattr(os, "killpg") or not hasattr(os, "set_blocking"):
        raise UsageError("this helper requires POSIX process groups and nonblocking pipes")
    cwd = Path(args.cwd)
    if not cwd.is_absolute() or not cwd.is_dir():
        raise UsageError("cwd must be an absolute existing directory")
    raw_logs = ({"merged": args.log} if args.log is not None else
                {"stdout": args.stdout_log, "stderr": args.stderr_log})
    # Normalize only for lexical alias detection.  The caller's original path
    # must remain the path validated, opened, and reported: collapsing `..`
    # before the kernel resolves a preceding symlink can change the target.
    logs = {name: Path(value) for name, value in raw_logs.items()}
    normalized = {name: os.path.normpath(value) for name, value in raw_logs.items()}
    if len(set(normalized.values())) != len(logs):
        raise UsageError("split log paths must be lexically distinct")
    for path in logs.values():
        if not path.is_absolute():
            raise UsageError("log paths must be absolute")
        if not path.parent.is_dir():
            raise UsageError("log parent must be an existing directory")
        if os.path.lexists(path):
            raise UsageError("log path already exists")
    return cwd, logs


def acquire_stdin_snapshot(args) -> bytes:
    """Acquire one bounded byte snapshot without retaining source identity."""
    source = Path(args.stdin_file)
    if not source.is_absolute():
        raise UsageError("stdin-file must be an absolute regular file")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        source_fd = os.open(source, flags)
    except OSError as exc:
        raise UsageError("stdin-file must be an absolute regular file") from exc
    snapshot = None
    failure = None
    try:
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode):
            raise UsageError("stdin-file must be an absolute regular file")
        identity_before = (
            before.st_dev, before.st_ino, before.st_mode, before.st_size,
            before.st_mtime_ns, before.st_ctime_ns,
        )
        acquired = bytearray()
        reached_eof = False
        while len(acquired) < args.stdin_limit:
            remaining = args.stdin_limit - len(acquired)
            try:
                chunk = os.read(source_fd, min(65536, remaining))
            except OSError as exc:
                raise UsageError("cannot read stdin-file") from exc
            if not chunk:
                reached_eof = True
                break
            acquired.extend(chunk)
        extra = b""
        if not reached_eof:
            try:
                extra = os.read(source_fd, 1)
            except OSError as exc:
                raise UsageError("cannot read stdin-file") from exc
        after = os.fstat(source_fd)
        identity_after = (
            after.st_dev, after.st_ino, after.st_mode, after.st_size,
            after.st_mtime_ns, after.st_ctime_ns,
        )
        if identity_before != identity_after:
            raise UsageError("stdin-file changed while read")
        if extra:
            raise UsageError("stdin-file exceeds stdin-limit")
        snapshot = bytes(acquired)
    except UsageError as exc:
        failure = exc
    except OSError:
        failure = UsageError("cannot read stdin-file")
    try:
        os.close(source_fd)
    except OSError:
        if failure is None:
            failure = UsageError("cannot close stdin-file")
    if failure is not None:
        raise failure
    assert snapshot is not None
    return snapshot


def base_result(command, cwd, logs, input_present=False, input_bytes=0):
    split = "merged" not in logs
    result = {
        "schema": SCHEMA,
        "argv": command,
        "cwd": str(cwd),
        "log_path": None if split else str(logs["merged"]),
        "command": {"state": "not_started", "exit_code": None, "signal": None},
        "termination": {
            "reason": None, "cancel_signals": 0, "term_sent": False,
            "kill_sent": False, "parent_reaped": False,
            "group_scope": "created_process_group", "ownership_lost": False,
        },
    }
    if split:
        result["log_paths"] = {name: str(logs[name]) for name in ("stdout", "stderr")}
        streams = {}
        for name in ("stdout", "stderr"):
            streams[name] = {
                "status": "complete", "eof": True, "observed_bytes": 0,
                "retained_bytes": 0, "observed_dropped_bytes": 0,
                "log_bytes": 0, "log_is_exact_raw": True,
                "preview": {"encoding": "utf-8-replace", "source_bytes": 0,
                            "truncated": False, "text": ""},
            }
        result["capture"] = {
            "mode": "split", "status": "complete", "eof": True,
            "observed_bytes": 0, "retained_bytes": 0,
            "observed_dropped_bytes": 0, "log_bytes": 0,
            "log_is_exact_raw": True,
            "limits": {"total": 0, "stdout": 0, "stderr": 0},
            "streams": streams,
        }
    else:
        result["capture"] = {
            "status": "complete", "eof": True, "observed_bytes": 0,
            "retained_bytes": 0, "observed_dropped_bytes": 0,
            "log_bytes": 0, "log_is_exact_raw": True,
        }
        result["preview"] = {
            "encoding": "utf-8-replace", "source_bytes": 0,
            "truncated": False, "text": "",
        }
    if input_present:
        result["input"] = {
            "status": "not_started", "bytes_acquired": input_bytes,
            "bytes_written": 0, "eof_sent": False,
        }
    return result


def emit(result) -> None:
    encoded = (json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode(
        "utf-8", "backslashreplace")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def run(args, command, cwd: Path, logs: dict[str, Path], log_fds: dict[str, int],
        stdin_snapshot: bytes | None = None) -> tuple[dict, int]:
    split = "merged" not in logs
    names = ("stdout", "stderr") if split else ("merged",)
    limits = ({"stdout": args.stdout_capture_bytes,
               "stderr": args.stderr_capture_bytes} if split else
              {"merged": args.capture_limit})
    input_present = stdin_snapshot is not None
    result = base_result(command, cwd, logs, input_present,
                         len(stdin_snapshot) if input_present else 0)
    if split:
        result["capture"]["limits"] = {
            "total": args.capture_limit,
            "stdout": limits["stdout"], "stderr": limits["stderr"],
        }
    captures = {name: Capture(limits[name], args.tail_bytes) for name in names}
    pending_signals = 0

    def cancel(_signum, _frame):
        nonlocal pending_signals
        pending_signals += 1

    previous = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    for number in previous:
        signal.signal(number, cancel)
    start = time.monotonic()
    try:
        process = subprocess.Popen(
            command, cwd=cwd,
            stdin=subprocess.PIPE if input_present else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE if split else subprocess.STDOUT,
            start_new_session=True, close_fds=True,
        )
    except (OSError, ValueError) as exc:
        for number, handler in previous.items():
            signal.signal(number, handler)
        result["command"]["state"] = "spawn_error"
        result["error"] = {"type": type(exc).__name__, "message": str(exc)[:512]}
        return result, 2

    pipes = {"merged": process.stdout} if not split else {
        "stdout": process.stdout, "stderr": process.stderr,
    }
    assert all(stream is not None for stream in pipes.values())
    pipe_fds = {name: stream.fileno() for name, stream in pipes.items()}
    input_fd = process.stdin.fileno() if input_present and process.stdin is not None else None
    selector = None
    pipe_closed = {name: False for name in names}
    eof = {name: False for name in names}
    read_errors: dict[str, dict] = {}
    setup_failed = False
    selector_failed = False
    reaped = False
    wait_unknown = False
    wait_status = None
    grace_until = None
    observation_until = None
    drain_until = None
    handled_signals = 0
    forced_exit = None
    input_closed = not input_present
    input_ready = False
    input_offset = 0
    rotation = 0

    def close_pipe(name):
        if selector is not None:
            try:
                selector.unregister(pipe_fds[name])
            except Exception:
                pass
        if not pipe_closed[name]:
            try:
                pipes[name].close()
            except OSError:
                pass
            pipe_closed[name] = True

    def close_all_pipes():
        for name in names:
            close_pipe(name)

    def close_input(status=None, eof_sent=False):
        nonlocal input_closed, input_ready
        if not input_present or input_closed:
            return
        if selector is not None and input_fd is not None:
            try:
                selector.unregister(input_fd)
            except Exception:
                pass
        closed = True
        if process.stdin is not None:
            try:
                process.stdin.close()
            except OSError:
                closed = process.stdin.closed
        input_closed = True
        input_ready = False
        if status is not None:
            if eof_sent and not closed:
                status, eof_sent = "interrupted", False
            result["input"]["status"] = status
            result["input"]["eof_sent"] = eof_sent

    def lose_ownership(unknown=False):
        nonlocal observation_until, wait_unknown
        result["termination"]["ownership_lost"] = True
        wait_unknown = wait_unknown or unknown
        observation_until = observation_until or (time.monotonic() + FINAL_OBSERVATION_SECONDS)

    def send_group(sig):
        if reaped or result["termination"]["ownership_lost"]:
            return False
        try:
            os.killpg(process.pid, sig)
            return True
        except (ProcessLookupError, PermissionError):
            lose_ownership()
        except OSError as exc:
            lose_ownership(exc.errno not in (errno.ESRCH, errno.EPERM))
        return False

    def reap_once():
        nonlocal reaped, wait_status, wait_unknown, drain_until, observation_until
        if reaped or wait_unknown:
            return
        try:
            pid, status = os.waitpid(process.pid, os.WNOHANG)
        except (ChildProcessError, OSError):
            wait_unknown = True
            lose_ownership(True)
            return
        if pid:
            reaped = True
            wait_status = status
            process.returncode = os.waitstatus_to_exitcode(status)
            result["termination"]["parent_reaped"] = True
            drain_until = time.monotonic() + FINAL_OBSERVATION_SECONDS
            observation_until = None
            if input_present and not input_closed:
                close_input("interrupted")

    def record_read_error(name, exc):
        if name not in read_errors:
            read_errors[name] = {"type": type(exc).__name__, "message": str(exc)[:512]}
        close_pipe(name)
        if not split and "capture_error" not in result:
            result["capture_error"] = read_errors[name]
        if not split and input_present and not input_closed:
            close_input("interrupted")

    def drain_one_turn(name):
        try:
            chunk = os.read(pipe_fds[name], 65536)
        except BlockingIOError:
            return
        except OSError as exc:
            record_read_error(name, exc)
            return
        if not chunk:
            eof[name] = True
            close_pipe(name)
            return
        captures[name].add(chunk)

    def write_input_one_turn():
        nonlocal input_offset
        if not input_present or input_closed or not input_ready:
            return
        assert stdin_snapshot is not None and input_fd is not None
        try:
            count = os.write(input_fd, stdin_snapshot[
                input_offset:input_offset + INPUT_WRITE_QUANTUM])
        except BlockingIOError:
            return
        except (BrokenPipeError, OSError):
            close_input("interrupted")
            return
        if count <= 0:
            close_input("interrupted")
            return
        input_offset += count
        result["input"]["bytes_written"] = input_offset
        if input_offset == len(stdin_snapshot):
            close_input("complete", eof_sent=True)

    def emergency_cleanup():
        nonlocal grace_until, observation_until
        close_all_pipes()
        if input_present and not input_closed:
            close_input("interrupted")
        reap_once()
        if not reaped and not wait_unknown:
            if send_group(signal.SIGTERM):
                result["termination"]["term_sent"] = True
            grace_until = time.monotonic() + args.term_grace_seconds
            while not reaped and not wait_unknown and time.monotonic() < grace_until:
                reap_once()
                if not reaped:
                    time.sleep(.01)
        reap_once()
        if not reaped and not wait_unknown:
            if send_group(signal.SIGKILL):
                result["termination"]["kill_sent"] = True
            observation_until = time.monotonic() + FINAL_OBSERVATION_SECONDS
            while not reaped and not wait_unknown and time.monotonic() < observation_until:
                reap_once()
                if not reaped:
                    time.sleep(.01)
        reap_once()

    try:
        try:
            for name in names:
                os.set_blocking(pipe_fds[name], False)
            selector = selectors.DefaultSelector()
            for name in names:
                selector.register(pipe_fds[name], selectors.EVENT_READ, ("output", name))
            if input_present:
                assert input_fd is not None and process.stdin is not None
                os.set_blocking(input_fd, False)
                selector.register(input_fd, selectors.EVENT_WRITE, ("input", None))
                input_ready = True
                if not stdin_snapshot:
                    close_input("complete", eof_sent=True)
        except Exception as exc:
            setup_failed = True
            selector_failed = True
            forced_exit = 2
            result["setup_error"] = {"type": type(exc).__name__, "message": str(exc)[:512]}
            if not split:
                result["capture_error"] = result["setup_error"].copy()
            if input_present and not input_closed:
                close_input("not_attempted")
            close_all_pipes()
            reap_once()
            if not reaped and not wait_unknown:
                if send_group(signal.SIGTERM):
                    result["termination"]["term_sent"] = True
                grace_until = time.monotonic() + args.term_grace_seconds

        while True:
            now = time.monotonic()
            if pending_signals > handled_signals:
                handled_signals = pending_signals
                result["termination"]["cancel_signals"] = pending_signals
                if not setup_failed and not reaped and result["termination"]["reason"] is None:
                    result["termination"]["reason"] = "cancelled"
                    if send_group(signal.SIGTERM):
                        result["termination"]["term_sent"] = True
                        grace_until = now + args.term_grace_seconds
                    if input_present and not input_closed:
                        close_input("interrupted")
                if (not reaped and grace_until is not None and pending_signals >= 2
                        and not result["termination"]["kill_sent"]):
                    if send_group(signal.SIGKILL):
                        result["termination"]["kill_sent"] = True
                    observation_until = now + FINAL_OBSERVATION_SECONDS
                    grace_until = None

            if (not setup_failed and not reaped and result["termination"]["reason"] is None
                    and now >= start + args.deadline_seconds):
                result["termination"]["reason"] = "deadline"
                if send_group(signal.SIGTERM):
                    result["termination"]["term_sent"] = True
                    grace_until = now + args.term_grace_seconds
                if input_present and not input_closed:
                    close_input("interrupted")

            reap_once()
            now = time.monotonic()
            if (not reaped and grace_until is not None and now >= grace_until
                    and not result["termination"]["kill_sent"]):
                if send_group(signal.SIGKILL):
                    result["termination"]["kill_sent"] = True
                observation_until = now + FINAL_OBSERVATION_SECONDS
                grace_until = None

            all_outputs_done = all(pipe_closed.values())
            if reaped and all_outputs_done:
                break
            if reaped and drain_until is not None and now >= drain_until:
                break
            if not reaped and observation_until is not None and now >= observation_until:
                break

            bounds = [now + 0.05]
            for bound in (start + args.deadline_seconds
                          if not setup_failed and result["termination"]["reason"] is None else None,
                          grace_until, observation_until, drain_until):
                if bound is not None:
                    bounds.append(bound)
            timeout = max(0.0, min(bounds) - now)
            if selector is None or selector_failed:
                time.sleep(timeout)
                continue
            try:
                events = selector.select(timeout)
            except OSError as exc:
                selector_failed = True
                for name in names:
                    if not pipe_closed[name]:
                        record_read_error(name, exc)
                if input_present and not input_closed:
                    close_input("interrupted")
                continue
            if events:
                ready_outputs = {key.data[1] for key, mask in events
                                 if key.data[0] == "output" and mask & selectors.EVENT_READ}
                order = list(names[rotation:]) + list(names[:rotation])
                rotation = (rotation + 1) % len(names)
                for name in order:
                    if name in ready_outputs:
                        drain_one_turn(name)
                stdin_ready = any(key.data[0] == "input" and mask & selectors.EVENT_WRITE
                                  for key, mask in events)
                if stdin_ready:
                    write_input_one_turn()
    except BaseException as exc:
        forced_exit = 3
        result["internal_error"] = {"type": type(exc).__name__, "message": str(exc)[:512]}
        if not split and "capture_error" not in result:
            result["capture_error"] = result["internal_error"]
        emergency_cleanup()
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        if selector is not None:
            try:
                selector.close()
            except OSError:
                pass
        if input_present and not input_closed:
            close_input("interrupted")
        close_all_pipes()

    if reaped:
        code = os.waitstatus_to_exitcode(wait_status)
        result["command"] = ({"state": "signalled", "exit_code": None, "signal": -code}
                             if code < 0 else
                             {"state": "exited", "exit_code": code, "signal": None})
    elif wait_unknown:
        result["command"]["state"] = "unknown"
    else:
        result["command"]["state"] = "unreaped"

    statuses = {}
    stream_results = {}
    for name in names:
        capture = captures[name]
        retained = capture.retained
        rendered_log = capture.log_bytes()
        written = 0
        write_error = None
        try:
            while written < len(rendered_log):
                count = os.write(log_fds[name], rendered_log[written:])
                if count <= 0:
                    raise OSError("short log write")
                written += count
        except OSError as exc:
            write_error = {"type": type(exc).__name__, "message": str(exc)[:512]}
        if write_error is not None:
            status = "write_error"
        elif name in read_errors:
            # Preserve the historical merged projection; split mode exposes
            # the more precise per-stream read_error state.
            status = "read_error" if split else "incomplete"
        elif not eof[name]:
            status = "incomplete"
        elif capture.dropped:
            status = "truncated"
        else:
            status = "complete"
        statuses[name] = status
        preview_source = retained[:args.preview_bytes]
        stream_result = {
            "status": status, "eof": eof[name], "observed_bytes": capture.observed,
            "retained_bytes": len(retained), "observed_dropped_bytes": capture.dropped,
            "log_bytes": written, "log_is_exact_raw": status == "complete",
        }
        if split and name in read_errors:
            stream_result["read_error"] = read_errors[name]
        if split and write_error is not None:
            stream_result["write_error"] = write_error
        preview = {
            "encoding": "utf-8-replace", "source_bytes": len(preview_source),
            "truncated": len(retained) > len(preview_source),
            "text": preview_source.decode("utf-8", "replace"),
        }
        if split:
            stream_result["preview"] = preview
        stream_results[name] = stream_result
        if not split and write_error is not None:
            result["capture_error"] = write_error
        if not split:
            result["preview"] = preview

    if split:
        severity = {"complete": 0, "truncated": 1, "incomplete": 2,
                    "read_error": 3, "write_error": 4}
        aggregate_status = max(statuses.values(), key=severity.__getitem__)
        result["capture"] = {
            "mode": "split", "status": aggregate_status,
            "eof": all(eof.values()),
            "observed_bytes": sum(c.observed for c in captures.values()),
            "retained_bytes": sum(len(c.retained) for c in captures.values()),
            "observed_dropped_bytes": sum(c.dropped for c in captures.values()),
            "log_bytes": sum(s["log_bytes"] for s in stream_results.values()),
            "log_is_exact_raw": all(s["log_is_exact_raw"] for s in stream_results.values()),
            "limits": {"total": args.capture_limit, "stdout": limits["stdout"],
                       "stderr": limits["stderr"]},
            "streams": stream_results,
        }
        capture_clean = all(statuses[name] == "complete" and eof[name] for name in names)
    else:
        result["capture"] = stream_results["merged"]
        capture_clean = statuses["merged"] == "complete" and eof["merged"]

    result["termination"]["cancel_signals"] = pending_signals
    if forced_exit is not None:
        return result, forced_exit
    clean = (result["command"]["state"] == "exited"
             and result["command"]["exit_code"] == 0
             and result["termination"]["reason"] is None
             and reaped and capture_clean
             and (not input_present or result["input"]["status"] == "complete"))
    return result, 0 if clean else 1


def main(arguments=None) -> int:
    log_fds = {}
    try:
        args, command = parse_args(sys.argv[1:] if arguments is None else arguments)
        cwd, logs = validate_host_and_paths(args)
        stdin_snapshot = acquire_stdin_snapshot(args) if args.stdin_file is not None else None
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        for name, path in logs.items():
            try:
                log_fds[name] = os.open(path, flags, 0o600)
            except OSError as exc:
                raise UsageError(f"cannot create exclusive {name} log: {exc}") from exc
    except UsageError as exc:
        diagnostic(str(exc))
        return 2
    finally:
        # Pre-spawn failures retain every successfully acquired reservation.
        if "logs" not in locals() or len(log_fds) != len(logs):
            for fd in log_fds.values():
                try:
                    os.close(fd)
                except OSError:
                    pass

    try:
        result, exit_code = run(args, command, cwd, logs, log_fds, stdin_snapshot)
        emit(result)
        return exit_code
    except Exception as exc:
        diagnostic(f"internal failure: {type(exc).__name__}: {exc}")
        return 3
    finally:
        for fd in log_fds.values():
            try:
                os.close(fd)
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
