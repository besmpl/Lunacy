"""Public CLI tests for the optional one-shot bounded command helper."""

import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/run_command.py"


@unittest.skipUnless(os.name == "posix", "run_command is POSIX-only")
class RunCommandTests(unittest.TestCase):
    def invoke(self, base, code, *, name="run.log", deadline=5, extra=(), timeout=12,
               env=None):
        log = base / name
        command = [
            sys.executable, "-B", str(SCRIPT),
            "--cwd", str(base), "--log", str(log),
            "--deadline-seconds", str(deadline), *map(str, extra),
            "--", sys.executable, "-B", "-c", code,
        ]
        completed = subprocess.run(command, capture_output=True, timeout=timeout, env=env)
        result = json.loads(completed.stdout) if completed.stdout else None
        return completed, result, log

    def invoke_split(self, base, code, *, deadline=5, extra=(), timeout=12,
                     stdout_name="stdout.log", stderr_name="stderr.log"):
        stdout_log = base / stdout_name
        stderr_log = base / stderr_name
        command = [
            sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
            "--stdout-log", str(stdout_log), "--stderr-log", str(stderr_log),
            "--deadline-seconds", str(deadline), "--capture-limit", "4096",
            "--tail-bytes", "0", *map(str, extra), "--",
            sys.executable, "-B", "-c", code,
        ]
        completed = subprocess.run(command, capture_output=True, timeout=timeout)
        result = json.loads(completed.stdout) if completed.stdout else None
        return completed, result, stdout_log, stderr_log

    def popen(self, base, code, *, deadline=10, extra=()):
        log = base / "run.log"
        command = [
            sys.executable, "-B", str(SCRIPT),
            "--cwd", str(base), "--log", str(log),
            "--deadline-seconds", str(deadline), *map(str, extra),
            "--", sys.executable, "-B", "-c", code,
        ]
        return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE), log

    def communicate_owned(self, helper, *, timeout, settle_seconds):
        try:
            return helper.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            helper.kill()
            helper.communicate()
            time.sleep(settle_seconds)
            raise

    def injected(self, base, injection, code, *, name="run.log", deadline=5,
                 extra=(), timeout=10, child_args=(), parse_result=True):
        log = base / name
        runner_argv = [
            str(SCRIPT), "--cwd", str(base), "--log", str(log),
            "--deadline-seconds", str(deadline), *map(str, extra), "--",
            sys.executable, "-B", "-c", code, *child_args,
        ]
        command = [sys.executable, "-B", "-c", injection, *runner_argv]
        try:
            completed = subprocess.run(command, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            # Injected children use alarm/self-exit bounds; allow that owned
            # cleanup to settle before surfacing the failed helper test.
            time.sleep(2)
            raise
        result = (json.loads(completed.stdout)
                  if parse_result and completed.stdout else None)
        return completed, result, log

    def test_receipt_is_utf8_under_ascii_utf8_and_utf16_parent_encodings(self):
        with tempfile.TemporaryDirectory(prefix="run-command-\u00e9-") as temporary:
            base = Path(temporary)
            name = "receipt-\u00e9.log"
            marker = "PREVIEW_\u20ac\n".encode()
            child_environment = base / "child-environment"
            code = ("import os;"
                    f"open({str(child_environment)!r},'w').write(os.environ['PYTHONIOENCODING']);"
                    f"os.write(1,{marker!r})")
            outputs = {}
            for encoding in ("ascii:strict", "utf-8:strict", "utf-16:strict"):
                with self.subTest(encoding=encoding):
                    env = os.environ.copy()
                    env["PYTHONIOENCODING"] = encoding
                    completed, result, log = self.invoke(
                        base, code, name=name, deadline=2, timeout=6, env=env)
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    self.assertEqual(completed.stderr, b"")
                    self.assertEqual(completed.stdout.count(b"\n"), 1)
                    self.assertEqual(result["cwd"], str(base))
                    self.assertEqual(result["log_path"], str(log))
                    self.assertEqual(result["preview"]["text"], marker.decode())
                    self.assertEqual(log.read_bytes(), marker)
                    self.assertEqual(child_environment.read_text(), encoding)
                    self.assertIn("\u00e9".encode(), completed.stdout)
                    self.assertIn("\u20ac".encode(), completed.stdout)
                    self.assertNotIn(b"\\u00e9", completed.stdout.lower())
                    self.assertNotIn(b"\\u20ac", completed.stdout.lower())
                    outputs[encoding] = completed.stdout
                    # Reuse the exact dynamic path so the raw receipt comparison
                    # differs only by the parent's requested stdout encoding.
                    log.unlink()
            self.assertEqual(outputs["ascii:strict"], outputs["utf-8:strict"])
            self.assertEqual(outputs["ascii:strict"], outputs["utf-16:strict"])

    def test_emit_backslash_escapes_only_exceptional_surrogate_at_byte_boundary(self):
        code = '''import io,os,runpy,sys
namespace=runpy.run_path(sys.argv[1])
raw=io.BytesIO()
wrapper=io.TextIOWrapper(raw,encoding="ascii",errors="strict")
real_stdout=sys.stdout
try:
 sys.stdout=wrapper
 namespace["emit"]({"ordinary":"\u00e9","exceptional":chr(0xd800)})
 wrapper.flush()
 data=raw.getvalue()
finally:
 sys.stdout=real_stdout
os.write(1,data)
'''
        completed = subprocess.run(
            [sys.executable, "-B", "-c", code, str(SCRIPT)],
            capture_output=True, timeout=5)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.count(b"\n"), 1)
        self.assertIn("\u00e9".encode(), completed.stdout)
        self.assertNotIn(b"\\u00e9", completed.stdout.lower())
        self.assertIn(b"\\ud800", completed.stdout.lower())
        self.assertEqual(json.loads(completed.stdout), {
            "ordinary": "\u00e9", "exceptional": chr(0xd800)})

    def test_receipt_write_and_flush_faults_keep_effects_without_replay(self):
        injection = '''import runpy,sys
kind=FAULT_KIND
real_stdout=sys.stdout
class FaultBuffer:
 def __init__(self): self.failed=False
 def write(self,data):
  if kind=="write" and not self.failed:
   self.failed=True
   real_stdout.buffer.write(data[:max(1,len(data)//2)])
   real_stdout.buffer.flush()
   raise BrokenPipeError("injected receipt write failure")
  return real_stdout.buffer.write(data)
 def flush(self):
  if kind=="flush" and not self.failed:
   self.failed=True
   real_stdout.buffer.flush()
   raise BrokenPipeError("injected receipt flush failure")
  return None
class SafeStream:
 def __init__(self): self.buffer=FaultBuffer()
 def write(self,text): return real_stdout.write(text)
 def flush(self): return None
sys.stdout=SafeStream()
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name="__main__")
'''
        for kind in ("write", "flush"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                counter = base / "invocations"
                marker = f"CHILD_FINISHED_{kind}\n".encode()
                child = ("import os;"
                         f"open({str(counter)!r},'ab').write(b'1');"
                         f"os.write(1,{marker!r})")
                case_injection = injection.replace("FAULT_KIND", repr(kind))
                completed, result, log = self.injected(
                    base, case_injection, child, name=f"{kind}.log", deadline=2,
                    timeout=6, child_args=(), parse_result=False)
                if completed.returncode == 2 and b"cwd" in completed.stderr:
                    self.fail("fault injection did not reach the real child")
                self.assertIsNone(result)
                self.assertEqual(completed.returncode, 3, completed.stderr)
                self.assertIn(f"injected receipt {kind} failure".encode(), completed.stderr)
                self.assertEqual(counter.read_bytes(), b"1")
                self.assertEqual(log.read_bytes(), marker)
                if kind == "write":
                    self.assertFalse(completed.stdout.endswith(b"\n"))
                    with self.assertRaises(json.JSONDecodeError):
                        json.loads(completed.stdout)
                else:
                    self.assertEqual(completed.stdout.count(b"\n"), 1)
                    self.assertEqual(json.loads(completed.stdout)["schema"],
                                     "lunacy-command-result-v1")

    def test_clean_and_nonzero_commands_report_separate_facts(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            completed, result, log = self.invoke(
                base, "import sys;sys.stdout.buffer.write(b'out\\n');sys.stderr.buffer.write(b'err\\n')")
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout.count(b"\n"), 1)
            self.assertEqual(result["schema"], "lunacy-command-result-v1")
            self.assertNotIn("input", result)
            self.assertEqual(result["command"], {"state": "exited", "exit_code": 0, "signal": None})
            self.assertEqual(result["capture"]["status"], "complete")
            self.assertEqual(log.read_bytes(), b"out\nerr\n")
            self.assertEqual(result["capture"]["observed_bytes"], 8)

            completed, result, _ = self.invoke(base, "raise SystemExit(7)", name="nonzero.log")
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(result["command"]["exit_code"], 7)
            self.assertIsNone(result["termination"]["reason"])

    def test_missing_executable_is_spawn_error_and_keeps_exclusive_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            log = base / "run.log"
            command = [sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                       "--log", str(log), "--deadline-seconds", "2", "--",
                       str(base / "does-not-exist")]
            completed = subprocess.run(command, capture_output=True, timeout=5)
            result = json.loads(completed.stdout)
            self.assertEqual(completed.returncode, 2)
            self.assertEqual(result["command"]["state"], "spawn_error")
            self.assertTrue(log.is_file())
            self.assertEqual(log.read_bytes(), b"")

    def test_existing_and_symlink_logs_refuse_before_producer(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            marker = base / "producer-ran"
            for kind in ("file", "directory", "fifo", "symlink", "dangling"):
                with self.subTest(kind=kind):
                    log = base / f"{kind}.log"
                    target = base / f"{kind}.target"
                    if kind == "file":
                        log.write_text("sentinel")
                    elif kind == "directory":
                        log.mkdir()
                    elif kind == "fifo":
                        os.mkfifo(log)
                    elif kind == "symlink":
                        target.write_text("target")
                        log.symlink_to(target)
                    else:
                        log.symlink_to(target)
                    command = [sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                               "--log", str(log), "--deadline-seconds", "2", "--",
                               sys.executable, "-c", f"open({str(marker)!r},'w').write('bad')"]
                    completed = subprocess.run(command, capture_output=True, timeout=5)
                    self.assertEqual(completed.returncode, 2)
                    self.assertEqual(completed.stdout, b"")
                    self.assertLessEqual(len(completed.stderr), 513)
                    self.assertFalse(marker.exists())
                    if kind == "file":
                        self.assertEqual(log.read_text(), "sentinel")
                    elif kind == "directory":
                        self.assertTrue(log.is_dir())
                    elif kind == "fifo":
                        self.assertTrue(log.exists())
                    elif kind == "symlink":
                        self.assertTrue(log.is_symlink())

    def test_merged_symlink_dotdot_path_keeps_kernel_resolution(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            (base / "target" / "nested").mkdir(parents=True)
            (base / "link").symlink_to(base / "target" / "nested",
                                       target_is_directory=True)
            requested = str(base / "link") + "/../out.log"
            command = [sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                       "--log", requested, "--deadline-seconds", "3", "--",
                       sys.executable, "-c", "print('ok')"]
            completed = subprocess.run(command, capture_output=True, timeout=7)
            result = json.loads(completed.stdout)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(result["log_path"], requested)
            self.assertEqual((base / "target" / "out.log").read_bytes(), b"ok\n")
            self.assertFalse((base / "out.log").exists())

    def test_deadline_honors_grace_above_two_before_kill(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            code = ("import signal,time;signal.alarm(8);"
                    "signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(20)")
            started = time.monotonic()
            completed, result, _ = self.invoke(
                base, code, deadline=1, extra=("--term-grace-seconds", 3), timeout=9)
            elapsed = time.monotonic() - started
            self.assertEqual(completed.returncode, 1)
            self.assertGreaterEqual(elapsed, 3.7)
            self.assertLess(elapsed, 7)
            self.assertEqual(result["termination"]["reason"], "deadline")
            self.assertTrue(result["termination"]["term_sent"])
            self.assertTrue(result["termination"]["kill_sent"])
            self.assertEqual(result["command"]["state"], "signalled")
            self.assertEqual(result["command"]["signal"], signal.SIGKILL)

    def test_first_and_second_cancellation_escalate_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            helper, _ = self.popen(
                base, ("import signal,time;signal.alarm(4);"
                       "signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(20)"),
                extra=("--term-grace-seconds", 5))
            time.sleep(.35)
            helper.send_signal(signal.SIGTERM)
            time.sleep(.25)
            helper.send_signal(signal.SIGINT)
            time.sleep(.1)
            helper.send_signal(signal.SIGTERM)
            stdout, stderr = self.communicate_owned(
                helper, timeout=6, settle_seconds=4.2)
            result = json.loads(stdout)
            self.assertEqual(helper.returncode, 1, stderr)
            self.assertEqual(result["termination"]["reason"], "cancelled")
            self.assertGreaterEqual(result["termination"]["cancel_signals"], 2)
            self.assertTrue(result["termination"]["term_sent"])
            self.assertTrue(result["termination"]["kill_sent"])

    def test_parent_exit_with_child_held_pipe_is_incomplete_and_never_signalled(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            code = ("import os,time\n"
                    "pid=os.fork()\n"
                    "if pid: os._exit(0)\n"
                    "time.sleep(2.5)\n")
            helper, log = self.popen(base, code)
            time.sleep(.5)  # direct parent is reaped; bounded drain is still active
            helper.send_signal(signal.SIGTERM)
            stdout, stderr = self.communicate_owned(
                helper, timeout=5, settle_seconds=3)
            result = json.loads(stdout)
            self.assertEqual(helper.returncode, 1, stderr)
            self.assertEqual(result["command"]["exit_code"], 0)
            self.assertEqual(result["capture"]["status"], "incomplete")
            self.assertFalse(result["capture"]["eof"])
            self.assertFalse(result["capture"]["log_is_exact_raw"])
            self.assertIsNone(result["termination"]["reason"])
            self.assertFalse(result["termination"]["term_sent"])
            self.assertGreaterEqual(result["termination"]["cancel_signals"], 1)
            self.assertTrue(log.exists())
            time.sleep(.7)  # bounded fixture child self-exits; no process escapes the test

    def test_byte_cap_marker_accounting_and_unicode_preview_are_independent(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            payload = b"A" * 700 + "€".encode() + b"B" * 700
            code = f"import os;os.write(1,{payload!r})"
            completed, result, log = self.invoke(
                base, code, extra=("--capture-limit", 1024, "--tail-bytes", 300,
                                   "--preview-bytes", 702))
            self.assertEqual(completed.returncode, 1)
            capture = result["capture"]
            self.assertEqual(capture["status"], "truncated")
            self.assertEqual(capture["observed_bytes"], len(payload))
            self.assertEqual(capture["retained_bytes"], 1024)
            self.assertEqual(capture["observed_dropped_bytes"], len(payload) - 1024)
            self.assertFalse(capture["log_is_exact_raw"])
            self.assertIn(b"[LUNACY_CAPTURE_TRUNCATED observed_dropped_bytes=379]", log.read_bytes())
            self.assertEqual(result["preview"]["source_bytes"], 702)
            self.assertIn("\ufffd", result["preview"]["text"])
            self.assertEqual(capture["log_bytes"], len(log.read_bytes()))

    def test_newline_free_exact_capture_and_zero_preview(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            completed, result, log = self.invoke(
                base, "import os;os.write(1,b'x'*1024)", extra=("--preview-bytes", 0))
            self.assertEqual(completed.returncode, 0)
            self.assertEqual(log.read_bytes(), b"x" * 1024)
            self.assertEqual(result["preview"], {
                "encoding": "utf-8-replace", "source_bytes": 0,
                "truncated": True, "text": ""})

    def test_usage_requires_separator_and_rejects_tail_before_log_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            log = base / "run.log"
            command = [sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                       "--log", str(log), "--deadline-seconds", "2",
                       "--capture-limit", "1024", "--tail-bytes", "1025",
                       "--", sys.executable, "-c", "raise SystemExit(99)"]
            completed = subprocess.run(command, capture_output=True, timeout=5)
            self.assertEqual(completed.returncode, 2)
            self.assertFalse(log.exists())
            self.assertEqual(completed.stdout, b"")
            self.assertIn(b"tail-bytes", completed.stderr)

    def test_help_succeeds_without_command_separator(self):
        completed = subprocess.run([sys.executable, "-B", str(SCRIPT), "--help"],
                                   capture_output=True, timeout=5)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn(b"--deadline-seconds", completed.stdout)

    def test_explicit_argv_and_cwd_are_passed_without_shell_expansion(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            literal = "$HOME;echo NOT_A_SHELL"
            code = ("import json,os,sys;"
                    "print(json.dumps({'cwd':os.getcwd(),'argv':sys.argv[1:]}))")
            log = base / "argv.log"
            command = [sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                       "--log", str(log), "--deadline-seconds", "2", "--",
                       sys.executable, "-B", "-c", code, literal]
            completed = subprocess.run(command, capture_output=True, timeout=5)
            result = json.loads(completed.stdout)
            child = json.loads(log.read_text())
            self.assertEqual(completed.returncode, 0)
            self.assertEqual(result["argv"][-1], literal)
            self.assertEqual(child, {"cwd": os.path.realpath(base), "argv": [literal]})

    def test_continuously_ready_reads_do_not_starve_deadline(self):
        injection = '''import os,runpy,sys,time
real_read=os.read
until=time.monotonic()+5
def read(fd,n):
    if not os.get_blocking(fd) and time.monotonic()<until: return b'x'*n
    return real_read(fd,n)
os.read=read
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            code = ("import os,signal,time;signal.alarm(6);os.write(1,b'ready');"
                    "signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(5)")
            started = time.monotonic()
            completed, result, _ = self.injected(
                base, injection, code, deadline=1,
                extra=("--term-grace-seconds", 0, "--capture-limit", 1024,
                       "--tail-bytes", 512, "--preview-bytes", 0))
            elapsed = time.monotonic() - started
            self.assertEqual(completed.returncode, 1)
            # One-second supervision plus the fixed two-second final drain;
            # the injected descriptor remains ready for five seconds.
            self.assertLess(elapsed, 3.7)
            self.assertEqual(result["termination"]["reason"], "deadline")
            self.assertTrue(result["termination"]["kill_sent"])

    def test_postspawn_setup_failures_cleanup_and_emit_json(self):
        injections = {
            "set-blocking": '''import os,runpy,sys
os.set_blocking=lambda *args: (_ for _ in ()).throw(OSError('injected set_blocking failure'))
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
''',
            "selector-construction": '''import runpy,selectors,sys
selectors.DefaultSelector=lambda: (_ for _ in ()).throw(OSError('injected selector creation failure'))
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
''',
            "selector-register": '''import runpy,selectors,sys
Real=selectors.DefaultSelector
class Broken:
 def __init__(self): self.real=Real()
 def register(self,*args): raise OSError('injected selector register failure')
 def unregister(self,*args): return None
 def close(self): self.real.close()
selectors.DefaultSelector=Broken
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
''',
        }
        for name, injection in injections.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                marker = base / "continued-effect"
                code = ("import pathlib,signal,time;signal.alarm(3);time.sleep(.5);"
                        f"pathlib.Path({str(marker)!r}).write_text('continued');time.sleep(.5)")
                completed, result, log = self.injected(
                    base, injection, code, name=f"{name}.log", deadline=1, timeout=6)
                time.sleep(.6)
                self.assertEqual(completed.returncode, 2, completed.stderr)
                self.assertEqual(result["setup_error"]["type"], "OSError")
                self.assertTrue(result["termination"]["parent_reaped"])
                self.assertIn(result["command"]["state"], ("signalled", "exited"))
                self.assertEqual(result["capture"]["status"], "incomplete")
                self.assertFalse(marker.exists())
                self.assertTrue(log.exists())

    def test_read_failure_is_visible_and_parent_is_settled(self):
        injection = '''import os,runpy,sys
real=os.read
def read(fd,n):
    if not os.get_blocking(fd): raise OSError('injected read failure')
    return real(fd,n)
os.read=read
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            completed, result, _ = self.injected(
                base, injection, "import os,time;os.write(1,b'x');time.sleep(.1)")
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(result["capture"]["status"], "incomplete")
            self.assertEqual(result["capture_error"]["message"], "injected read failure")
            self.assertTrue(result["termination"]["parent_reaped"])

    def test_merged_read_failure_interrupts_stdin_at_previous_boundary(self):
        injection = '''import os,runpy,subprocess,sys
real_popen=subprocess.Popen;real_read=os.read;broken=None
def popen(*args,**kwargs):
 global broken
 child=real_popen(*args,**kwargs);broken=child.stdout.fileno();return child
def read(fd,n):
 if fd==broken: raise OSError('injected output fault')
 return real_read(fd,n)
subprocess.Popen=popen;os.read=read
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            source.write_bytes(b"x" * (2 * 1024 * 1024))
            count = base / "count"
            producer = ("import os,signal,sys,time;signal.alarm(5);"
                        "os.write(1,b'ready');time.sleep(.1);"
                        f"data=sys.stdin.buffer.read();open({str(count)!r},'w').write(str(len(data)))")
            completed, result, _ = self.injected(
                base, injection, producer, extra=("--stdin-file", source,
                                                   "--stdin-limit", len(source.read_bytes())),
                timeout=8)
            self.assertEqual(completed.returncode, 1, completed.stderr)
            self.assertEqual(result["capture_error"]["message"], "injected output fault")
            self.assertEqual(result["input"]["status"], "interrupted")
            self.assertFalse(result["input"]["eof_sent"])
            self.assertLess(result["input"]["bytes_written"], len(source.read_bytes()))
            self.assertEqual(int(count.read_text()), result["input"]["bytes_written"])

    def test_merged_setup_failure_preserves_capture_error_projection(self):
        injection = '''import runpy,selectors,sys
def fail(): raise OSError('injected setup fault')
selectors.DefaultSelector=fail
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            completed, result, _ = self.injected(
                base, injection,
                "import signal,time;signal.alarm(3);time.sleep(2)",
                extra=("--term-grace-seconds", 0), timeout=7)
            self.assertEqual(completed.returncode, 2, completed.stderr)
            self.assertEqual(result["setup_error"], {
                "type": "OSError", "message": "injected setup fault"})
            self.assertEqual(result["capture_error"], result["setup_error"])
            self.assertEqual(result["capture"]["status"], "incomplete")

    def test_two_signals_pending_before_first_turn_escalate_immediately(self):
        injection = '''import os,runpy,signal,subprocess,sys
Real=subprocess.Popen
def popen(*args,**kwargs):
    saved_term=signal.getsignal(signal.SIGTERM)
    # SIG_IGN survives exec, so TERM resistance does not depend on child scheduling.
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    try:
        child=Real(*args,**kwargs)
    finally:
        signal.signal(signal.SIGTERM,saved_term)
    if signal.getsignal(signal.SIGTERM) != saved_term:
        raise AssertionError('SIGTERM handler was not restored before queue')
    os.kill(os.getpid(),signal.SIGTERM);os.kill(os.getpid(),signal.SIGINT)
    return child
subprocess.Popen=popen
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            started = time.monotonic()
            completed, result, _ = self.injected(
                base, injection,
                "import signal,time;signal.alarm(8);signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(7)",
                extra=("--term-grace-seconds", 5))
            self.assertLess(time.monotonic() - started, 3)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(result["termination"]["cancel_signals"], 2)
            self.assertTrue(result["termination"]["term_sent"])
            self.assertTrue(result["termination"]["kill_sent"])
            self.assertEqual(result["termination"]["reason"], "cancelled")
            self.assertTrue(result["termination"]["parent_reaped"])
            self.assertEqual(result["command"]["state"], "signalled")
            self.assertEqual(result["command"]["signal"], signal.SIGKILL)

    def test_write_failure_and_chunk_boundaries_preserve_facts(self):
        write_injection = '''import os,runpy,sys
real=os.write
def write(fd,data):
    if fd not in (1,2): raise OSError('injected log write failure')
    return real(fd,data)
os.write=write
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            completed, result, log = self.injected(
                base, write_injection, "print('captured')")
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(result["command"]["exit_code"], 0)
            self.assertEqual(result["capture"]["status"], "write_error")
            self.assertEqual(result["capture"]["log_bytes"], 0)
            self.assertEqual(log.read_bytes(), b"")

        payload = b"H" * 900 + b"M" * 250 + b"T" * 450
        outputs = []
        for chunk_size in (7, 113):
            injection = f'''import os,runpy,sys
real=os.read
def read(fd,n): return real(fd,min(n,{chunk_size}))
os.read=read
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
'''
            with tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                completed, result, log = self.injected(
                    base, injection, f"import os;os.write(1,{payload!r})",
                    extra=("--capture-limit", 1024, "--tail-bytes", 333))
                self.assertEqual(completed.returncode, 1)
                self.assertEqual(result["capture"]["observed_bytes"], len(payload))
                self.assertEqual(result["capture"]["observed_dropped_bytes"], 576)
                outputs.append(log.read_bytes())
        self.assertEqual(outputs[0], outputs[1])

    def test_stdin_snapshot_round_trips_arbitrary_bytes_and_reports_transport(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            payload = b"\x00raw\xff" + " euro=\u20ac ".encode() + bytes(range(256)) * 274
            source.write_bytes(payload)
            completed, result, log = self.invoke(
                base, "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())",
                extra=("--stdin-file", source, "--stdin-limit", len(payload)))
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(log.read_bytes(), payload)
            self.assertEqual(result["input"], {
                "status": "complete", "bytes_acquired": len(payload),
                "bytes_written": len(payload), "eof_sent": True,
            })
            encoded = completed.stdout
            self.assertNotIn(str(source).encode(), encoded)
            self.assertNotIn(payload[:12], encoded)

    def test_empty_stdin_is_present_and_sends_eof_immediately(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "empty.bin"
            source.write_bytes(b"")
            completed, result, log = self.invoke(
                base, "import sys;print(len(sys.stdin.buffer.read()))",
                extra=("--stdin-file", source, "--stdin-limit", 0))
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(log.read_bytes(), b"0\n")
            self.assertEqual(result["input"], {
                "status": "complete", "bytes_acquired": 0,
                "bytes_written": 0, "eof_sent": True,
            })

    def test_stdin_limit_exact_succeeds_and_extra_byte_refuses_before_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            source.write_bytes(b"abcd")
            completed, result, _ = self.invoke(
                base, "import sys;raise SystemExit(sys.stdin.buffer.read()!=b'abcd')",
                name="exact.log", extra=("--stdin-file", source, "--stdin-limit", 4))
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(result["input"]["bytes_written"], 4)

            marker = base / "producer-ran"
            completed, result, log = self.invoke(
                base, f"open({str(marker)!r},'w').write('bad')", name="too-large.log",
                extra=("--stdin-file", source, "--stdin-limit", 3))
            self.assertEqual(completed.returncode, 2)
            self.assertIsNone(result)
            self.assertFalse(log.exists())
            self.assertFalse(marker.exists())
            self.assertEqual(completed.stderr, b"run-command: stdin-file exceeds stdin-limit\n")

    def test_stdin_limit_without_file_is_usage_error_before_log(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            completed, result, log = self.invoke(
                base, "raise SystemExit(99)", extra=("--stdin-limit", 1))
            self.assertEqual(completed.returncode, 2)
            self.assertIsNone(result)
            self.assertFalse(log.exists())
            self.assertIn(b"stdin-limit requires stdin-file", completed.stderr)

    def test_stdin_limit_range_is_exact(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            source.write_bytes(b"")
            for value in (-1, 64 * 1024 * 1024 + 1):
                with self.subTest(value=value):
                    completed, result, log = self.invoke(
                        base, "raise SystemExit(99)", name=f"limit-{value}.log",
                        extra=("--stdin-file", source, "--stdin-limit", value))
                    self.assertEqual(completed.returncode, 2)
                    self.assertIsNone(result)
                    self.assertFalse(log.exists())
                    self.assertIn(b"stdin-limit must be from 0 through 67108864",
                                  completed.stderr)

    def test_stdin_nonregular_leafs_refuse_without_path_or_producer(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            marker = base / "producer-ran"
            target = base / "target.bin"
            target.write_bytes(b"secret-payload")
            candidates = {
                "missing": base / "private-missing-name",
                "directory": base / "private-directory-name",
                "fifo": base / "private-fifo-name",
                "symlink": base / "private-symlink-name",
            }
            candidates["directory"].mkdir()
            os.mkfifo(candidates["fifo"])
            candidates["symlink"].symlink_to(target)
            for name, source in candidates.items():
                with self.subTest(name=name):
                    completed, result, log = self.invoke(
                        base, f"open({str(marker)!r},'w').write('bad')",
                        name=f"{name}.log", extra=("--stdin-file", source))
                    self.assertEqual(completed.returncode, 2)
                    self.assertIsNone(result)
                    self.assertFalse(log.exists())
                    self.assertFalse(marker.exists())
                    self.assertEqual(
                        completed.stderr,
                        b"run-command: stdin-file must be an absolute regular file\n")
                    self.assertNotIn(str(source).encode(), completed.stderr)
                    self.assertNotIn(b"secret-payload", completed.stderr)

    def test_existing_log_refusal_precedes_stdin_acquisition(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "missing-input"
            log = base / "run.log"
            log.write_bytes(b"sentinel")
            command = [
                sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                "--log", str(log), "--deadline-seconds", "2",
                "--stdin-file", str(source), "--", sys.executable, "-c", "pass",
            ]
            completed = subprocess.run(command, capture_output=True, timeout=5)
            self.assertEqual(completed.returncode, 2)
            self.assertEqual(completed.stdout, b"")
            self.assertEqual(log.read_bytes(), b"sentinel")
            self.assertIn(b"log path already exists", completed.stderr)
            self.assertNotIn(b"stdin-file", completed.stderr)

    def test_stdin_detects_change_during_short_reads_before_log(self):
        injection = '''import os,runpy,sys
real=os.read
target=sys.argv[-1]
identity=os.stat(target).st_dev,os.stat(target).st_ino
changed=False
def read(fd,n):
 global changed
 data=real(fd,min(n,7))
 info=os.fstat(fd)
 if not changed and data and (info.st_dev,info.st_ino)==identity:
  changed=True
  with open(target,'ab') as stream: stream.write(b'changed')
 return data
os.read=read
sys.argv=sys.argv[1:-1]
runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            source.write_bytes(b"a" * 100)
            completed, result, log = self.injected(
                base, injection, "raise SystemExit(99)",
                extra=("--stdin-file", source, "--stdin-limit", 1000),
                child_args=(source,))
            self.assertEqual(completed.returncode, 2)
            self.assertIsNone(result)
            self.assertFalse(log.exists())
            self.assertEqual(completed.stderr,
                             b"run-command: stdin-file changed while read\n")

    def test_stdin_read_failure_is_private_and_pre_spawn(self):
        injection = '''import os,runpy,sys
real=os.read
target=sys.argv[-1]
identity=os.stat(target).st_dev,os.stat(target).st_ino
def read(fd,n):
 info=os.fstat(fd)
 if (info.st_dev,info.st_ino)==identity: raise OSError('private-path secret-data')
 return real(fd,n)
os.read=read
sys.argv=sys.argv[1:-1]
runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "private-input-name"
            source.write_bytes(b"secret-data")
            completed, result, log = self.injected(
                base, injection, "raise SystemExit(99)",
                extra=("--stdin-file", source,), child_args=(source,))
            self.assertEqual(completed.returncode, 2)
            self.assertIsNone(result)
            self.assertFalse(log.exists())
            self.assertEqual(completed.stderr, b"run-command: cannot read stdin-file\n")

    def test_stdin_close_failure_is_private_and_pre_spawn(self):
        injection = '''import os,runpy,sys
real=os.close
target=sys.argv[-1]
identity=os.stat(target).st_dev,os.stat(target).st_ino
def close(fd):
 info=os.fstat(fd)
 if (info.st_dev,info.st_ino)==identity: raise OSError('private close failure')
 return real(fd)
os.close=close
sys.argv=sys.argv[1:-1]
runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "private-input-name"
            source.write_bytes(b"secret-data")
            completed, result, log = self.injected(
                base, injection, "raise SystemExit(99)",
                extra=("--stdin-file", source,), child_args=(source,))
            self.assertEqual(completed.returncode, 2)
            self.assertIsNone(result)
            self.assertFalse(log.exists())
            self.assertEqual(completed.stderr, b"run-command: cannot close stdin-file\n")

    def test_child_exit_and_spawn_error_keep_truthful_input_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            source.write_bytes(b"x" * (1024 * 1024))
            completed, result, _ = self.invoke(
                base, "raise SystemExit(0)", extra=("--stdin-file", source), timeout=8)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(result["command"]["exit_code"], 0)
            self.assertEqual(result["input"]["status"], "interrupted")
            self.assertLess(result["input"]["bytes_written"], len(source.read_bytes()))
            self.assertFalse(result["input"]["eof_sent"])

            log = base / "spawn.log"
            command = [
                sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                "--log", str(log), "--deadline-seconds", "2",
                "--stdin-file", str(source), "--", str(base / "missing-executable"),
            ]
            completed = subprocess.run(command, capture_output=True, timeout=5)
            result = json.loads(completed.stdout)
            self.assertEqual(completed.returncode, 2)
            self.assertEqual(result["input"]["status"], "not_started")
            self.assertEqual(result["input"]["bytes_written"], 0)

    def test_nonreader_output_is_drained_and_deadline_is_not_starved(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            source.write_bytes(b"i" * (2 * 1024 * 1024))
            code = ("import os,signal,time;signal.alarm(5);"
                    "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
                    "os.write(1,b'o'*200000);time.sleep(4)")
            started = time.monotonic()
            completed, result, _ = self.invoke(
                base, code, deadline=1, timeout=7,
                extra=("--stdin-file", source, "--stdin-limit", len(source.read_bytes()),
                       "--term-grace-seconds", 0, "--capture-limit", 300000,
                       "--tail-bytes", 0))
            self.assertLess(time.monotonic() - started, 4)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(result["termination"]["reason"], "deadline")
            self.assertEqual(result["capture"]["observed_bytes"], 200000)
            self.assertEqual(result["input"]["status"], "interrupted")
            self.assertLess(result["input"]["bytes_written"], len(source.read_bytes()))

    def test_cancellation_stops_partial_input_and_settles_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            source.write_bytes(b"i" * (2 * 1024 * 1024))
            helper, _ = self.popen(
                base, ("import signal,time;signal.alarm(5);"
                       "signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(4)"),
                extra=("--stdin-file", source, "--stdin-limit", len(source.read_bytes()),
                       "--term-grace-seconds", 0))
            time.sleep(.25)
            helper.send_signal(signal.SIGTERM)
            stdout, stderr = self.communicate_owned(
                helper, timeout=5, settle_seconds=3)
            result = json.loads(stdout)
            self.assertEqual(helper.returncode, 1, stderr)
            self.assertEqual(result["termination"]["reason"], "cancelled")
            self.assertTrue(result["termination"]["parent_reaped"])
            self.assertEqual(result["input"]["status"], "interrupted")
            self.assertLess(result["input"]["bytes_written"], len(source.read_bytes()))

    def test_input_write_eagain_and_zero_write_are_bounded(self):
        injections = {
            "eagain": '''import os,runpy,sys
real=os.write
attempts=0
def write(fd,data):
 global attempts
 if not os.get_blocking(fd) and attempts<2:
  attempts+=1;raise BlockingIOError()
 return real(fd,data)
os.write=write
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
''',
            "zero": '''import os,runpy,sys
real=os.write
done=False
def write(fd,data):
 global done
 if not os.get_blocking(fd) and not done: done=True;return 0
 return real(fd,data)
os.write=write
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
''',
        }
        for name, injection in injections.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                source = base / "input.bin"
                source.write_bytes(b"payload")
                completed, result, log = self.injected(
                    base, injection,
                    "import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())",
                    extra=("--stdin-file", source,))
                if name == "eagain":
                    self.assertEqual(completed.returncode, 0, completed.stderr)
                    self.assertEqual(result["input"]["status"], "complete")
                    self.assertEqual(log.read_bytes(), b"payload")
                else:
                    self.assertEqual(completed.returncode, 1, completed.stderr)
                    self.assertEqual(result["input"]["status"], "interrupted")
                    self.assertEqual(result["input"]["bytes_written"], 0)

    def test_input_setup_failure_is_not_attempted_and_child_is_settled(self):
        injection = '''import os,runpy,sys
real=os.set_blocking
calls=0
def set_blocking(fd,value):
 global calls
 calls+=1
 if calls==2: raise OSError('injected input setup failure')
 return real(fd,value)
os.set_blocking=set_blocking
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            source.write_bytes(b"payload")
            completed, result, _ = self.injected(
                base, injection, "import sys,time;sys.stdin.buffer.read();time.sleep(2)",
                extra=("--stdin-file", source,), timeout=7)
            self.assertEqual(completed.returncode, 2, completed.stderr)
            self.assertEqual(result["input"]["status"], "not_attempted")
            self.assertTrue(result["termination"]["parent_reaped"])

    def test_split_structured_stdout_and_raw_channel_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            code = ("import json,sys;print(json.dumps({'ok':True,'items':[1,2]}));"
                    "print('warning: fixture',file=sys.stderr)")
            completed, result, stdout_log, stderr_log = self.invoke_split(
                base, code, extra=("--stdout-capture-bytes", 2048, "--preview-bytes", 256))
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(stdout_log.read_text()), {"ok": True, "items": [1, 2]})
            self.assertEqual(stderr_log.read_bytes(), b"warning: fixture\n")
            self.assertIsNone(result["log_path"])
            self.assertEqual(result["log_paths"], {
                "stdout": str(stdout_log), "stderr": str(stderr_log)})
            capture = result["capture"]
            self.assertEqual(capture["mode"], "split")
            self.assertEqual(capture["limits"], {"total": 4096, "stdout": 2048,
                                                  "stderr": 2048})
            for name in ("stdout", "stderr"):
                stream = capture["streams"][name]
                self.assertEqual(stream["status"], "complete")
                self.assertTrue(stream["eof"])
                self.assertTrue(stream["log_is_exact_raw"])

            completed, result, stdout_log, stderr_log = self.invoke_split(
                base, "import os;os.write(1,b'diagnostic-looking stdout\\n');"
                "os.write(2,b'{\"stderr_json\":true}\\n')",
                stdout_name="provenance.out", stderr_name="provenance.err")
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(stdout_log.read_bytes(), b"diagnostic-looking stdout\n")
            self.assertEqual(stderr_log.read_bytes(), b'{"stderr_json":true}\n')
            self.assertEqual(result["capture"]["observed_bytes"],
                             len(stdout_log.read_bytes()) + len(stderr_log.read_bytes()))

    def test_split_consumes_maintained_context_excerpt_stdout(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            copy = base / "source-copy"
            shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            wrapper = base / "wrapper.py"
            wrapper.write_text(
                "import subprocess,sys\n" + f"COPY={str(copy)!r}\n" +
                "r=subprocess.run([sys.executable,'-B',COPY+'/scripts/context_excerpt.py',"
                "'action-excerpt','--root',COPY,'--layout','source','--source-relative',"
                "'SKILL.md','--trigger','Worker implementation/report'],capture_output=True)\n"
                "print('wrapper diagnostic: offline context probe',file=sys.stderr)\n"
                "sys.stdout.buffer.write(r.stdout);sys.stderr.buffer.write(r.stderr)\n"
                "raise SystemExit(r.returncode)\n")
            stdout_log = base / "receipt.json"
            stderr_log = base / "diagnostic.log"
            command = [sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                       "--stdout-log", str(stdout_log), "--stderr-log", str(stderr_log),
                       "--deadline-seconds", "5", "--capture-limit", "65536",
                       "--stdout-capture-bytes", "32768", "--tail-bytes", "0", "--",
                       sys.executable, "-B", str(wrapper)]
            completed = subprocess.run(command, capture_output=True, timeout=12)
            result = json.loads(completed.stdout)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            receipt = json.loads(stdout_log.read_bytes())
            self.assertEqual(receipt["schema"], "lunacy.action_excerpt.v1")
            self.assertIn("Current assignment and project rules",
                          receipt["selection"]["row"]["text"])
            self.assertEqual(
                [(item["logical_path"], item["fragment"]) for item in receipt["destinations"]],
                [("worker/ENGINEERING.md", None),
                 ("WORKSPACE.md", "worker-updates-and-immutable-report")])
            self.assertEqual(stderr_log.read_bytes(),
                             b"wrapper diagnostic: offline context probe\n")
            stream = result["capture"]["streams"]["stdout"]
            self.assertEqual(stream["status"], "complete")
            self.assertTrue(stream["eof"])
            self.assertTrue(stream["log_is_exact_raw"])

    def test_split_static_partition_caps_flood_without_borrowing(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            completed, result, stdout_log, stderr_log = self.invoke_split(
                base, "import os;os.write(1,b'O'*3000);os.write(2,b'E'*9000)",
                extra=("--stdout-capture-bytes", 3072))
            self.assertEqual(completed.returncode, 1)
            capture = result["capture"]
            stdout = capture["streams"]["stdout"]
            stderr = capture["streams"]["stderr"]
            self.assertEqual(stdout["status"], "complete")
            self.assertEqual(stdout["retained_bytes"], 3000)
            self.assertEqual(stderr["status"], "truncated")
            self.assertEqual(stderr["retained_bytes"], 1024)
            self.assertEqual(capture["retained_bytes"], 4024)
            self.assertLessEqual(capture["retained_bytes"], capture["limits"]["total"])
            self.assertEqual(stdout_log.read_bytes(), b"O" * 3000)
            self.assertIn(b"LUNACY_CAPTURE_TRUNCATED", stderr_log.read_bytes())

    def test_split_invalid_utf8_head_tail_and_previews_are_stream_local(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            stdout_payload = b"\xff" + b"A" * 698 + b"Z"
            stderr_payload = b"\xfe" + b"B" * 698 + b"Y"
            code = (f"import os;os.write(1,{stdout_payload!r});"
                    f"os.write(2,{stderr_payload!r})")
            completed, result, stdout_log, stderr_log = self.invoke_split(
                base, code, extra=("--capture-limit", 1024,
                                   "--stdout-capture-bytes", 400,
                                   "--tail-bytes", 100, "--preview-bytes", 2))
            self.assertEqual(completed.returncode, 1)
            stdout = result["capture"]["streams"]["stdout"]
            stderr = result["capture"]["streams"]["stderr"]
            self.assertEqual((stdout["retained_bytes"], stderr["retained_bytes"]),
                             (400, 624))
            self.assertEqual((stdout["status"], stderr["status"]),
                             ("truncated", "truncated"))
            self.assertEqual(stdout["preview"]["text"], "\ufffdA")
            self.assertEqual(stderr["preview"]["text"], "\ufffdB")
            self.assertTrue(stdout_log.read_bytes().startswith(b"\xff" + b"A" * 299))
            self.assertTrue(stdout_log.read_bytes().endswith(b"A" * 99 + b"Z"))
            self.assertTrue(stderr_log.read_bytes().startswith(b"\xfe" + b"B" * 523))
            self.assertTrue(stderr_log.read_bytes().endswith(b"B" * 99 + b"Y"))

    def test_split_spawn_error_uses_vacuous_empty_exact_convention(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            stdout_log, stderr_log = base / "out", base / "err"
            command = [sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                       "--stdout-log", str(stdout_log), "--stderr-log", str(stderr_log),
                       "--deadline-seconds", "2", "--tail-bytes", "0", "--",
                       str(base / "missing")]
            completed = subprocess.run(command, capture_output=True, timeout=5)
            result = json.loads(completed.stdout)
            self.assertEqual(completed.returncode, 2)
            self.assertEqual(result["command"]["state"], "spawn_error")
            for name, path in (("stdout", stdout_log), ("stderr", stderr_log)):
                self.assertEqual(path.read_bytes(), b"")
                stream = result["capture"]["streams"][name]
                self.assertEqual(stream["status"], "complete")
                self.assertTrue(stream["eof"])
                self.assertTrue(stream["log_is_exact_raw"])

    def test_split_requires_pair_partition_and_per_stream_tail_before_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            marker = base / "producer-ran"
            stdout_log, stderr_log = base / "out", base / "err"
            invalid_options = (
                ("--stdout-log", stdout_log),
                ("--stderr-log", stderr_log),
                ("--log", base / "merged", "--stdout-log", stdout_log,
                 "--stderr-log", stderr_log),
                ("--stdout-log", stdout_log, "--stderr-log", stderr_log,
                 "--capture-limit", 1024, "--stdout-capture-bytes", 1024,
                 "--tail-bytes", 0),
                ("--stdout-log", stdout_log, "--stderr-log", stderr_log,
                 "--capture-limit", 4096, "--stdout-capture-bytes", 3072,
                 "--tail-bytes", 1025),
            )
            for index, options in enumerate(invalid_options):
                command = [sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                           *map(str, options), "--deadline-seconds", "2", "--",
                           sys.executable, "-c",
                           f"open({str(marker)!r},'w').write('bad')"]
                completed = subprocess.run(command, capture_output=True, timeout=5)
                self.assertEqual(completed.returncode, 2, (index, completed.stderr))
                self.assertEqual(completed.stdout, b"")
                self.assertFalse(marker.exists())
                self.assertFalse(stdout_log.exists())
                self.assertFalse(stderr_log.exists())

    def test_split_preflight_alias_collision_and_second_open_race_do_not_spawn(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            marker = base / "producer-ran"
            same = base / "same.log"
            existing = base / "existing.log"
            existing.write_text("sentinel")
            cases = [
                ["--stdout-log", str(same), "--stderr-log", str(base / "." / "same.log")],
                ["--stdout-log", str(base / "new.log"), "--stderr-log", str(existing)],
            ]
            for index, options in enumerate(cases):
                command = [sys.executable, "-B", str(SCRIPT), "--cwd", str(base), *options,
                           "--deadline-seconds", "2", "--tail-bytes", "0", "--",
                           sys.executable, "-c", f"open({str(marker)!r},'w').write('bad')"]
                completed = subprocess.run(command, capture_output=True, timeout=5)
                self.assertEqual(completed.returncode, 2, (index, completed.stderr))
                self.assertEqual(completed.stdout, b"")
                self.assertFalse(marker.exists())

            stdout_log, stderr_log = base / "reserved.out", base / "raced.err"
            injection = '''import os,runpy,sys
real=os.open
target=sys.argv[-1]
def opened(path,flags,*args):
 if os.path.normpath(os.fspath(path))==os.path.normpath(target) and not os.path.lexists(target):
  fd=real(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
 return real(path,flags,*args)
os.open=opened
sys.argv=sys.argv[1:-1];runpy.run_path(sys.argv[0],run_name='__main__')
'''
            runner = [str(SCRIPT), "--cwd", str(base), "--stdout-log", str(stdout_log),
                      "--stderr-log", str(stderr_log), "--deadline-seconds", "2",
                      "--tail-bytes", "0", "--", sys.executable, "-c",
                      f"open({str(marker)!r},'w').write('bad')"]
            completed = subprocess.run([sys.executable, "-B", "-c", injection, *runner,
                                        str(stderr_log)], capture_output=True, timeout=5)
            self.assertEqual(completed.returncode, 2, completed.stderr)
            self.assertEqual(completed.stdout, b"")
            self.assertTrue(stdout_log.exists())
            self.assertEqual(stdout_log.read_bytes(), b"")
            self.assertTrue(stderr_log.exists())
            self.assertFalse(marker.exists())

    def test_split_read_and_write_faults_are_stream_local(self):
        read_injection = '''import os,runpy,subprocess,sys
real_popen=subprocess.Popen;real_read=os.read;broken=None
def popen(*args,**kwargs):
 global broken
 child=real_popen(*args,**kwargs);broken=child.stderr.fileno();return child
def read(fd,n):
 if fd==broken: raise OSError('injected stderr read failure')
 return real_read(fd,n)
subprocess.Popen=popen;os.read=read
sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            stdout_log, stderr_log = base / "out", base / "err"
            runner = [str(SCRIPT), "--cwd", str(base), "--stdout-log", str(stdout_log),
                      "--stderr-log", str(stderr_log), "--deadline-seconds", "3",
                      "--capture-limit", "4096", "--tail-bytes", "0", "--",
                      sys.executable, "-B", "-c",
                      "import os;os.write(2,b'bad');os.write(1,b'good')"]
            completed = subprocess.run([sys.executable, "-B", "-c", read_injection, *runner],
                                       capture_output=True, timeout=7)
            result = json.loads(completed.stdout)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(stdout_log.read_bytes(), b"good")
            self.assertEqual(result["capture"]["streams"]["stdout"]["status"], "complete")
            self.assertEqual(result["capture"]["streams"]["stderr"]["status"], "read_error")
            self.assertEqual(result["capture"]["status"], "read_error")

        write_injection = '''import os,runpy,sys
real=os.write
target_path=sys.argv[-1]
def write(fd,data):
 try:
  actual=os.fstat(fd);target=os.stat(target_path)
  matches=(actual.st_dev,actual.st_ino)==(target.st_dev,target.st_ino)
 except OSError: matches=False
 if matches: raise OSError('injected stderr write failure')
 return real(fd,data)
os.write=write
sys.argv=sys.argv[1:-1];runpy.run_path(sys.argv[0],run_name='__main__')
'''
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            stdout_log, stderr_log = base / "out", base / "err"
            runner = [str(SCRIPT), "--cwd", str(base), "--stdout-log", str(stdout_log),
                      "--stderr-log", str(stderr_log), "--deadline-seconds", "3",
                      "--capture-limit", "4096", "--tail-bytes", "0", "--",
                      sys.executable, "-B", "-c", "import os;os.write(1,b'good');os.write(2,b'bad')"]
            completed = subprocess.run([sys.executable, "-B", "-c", write_injection,
                                        *runner, str(stderr_log)], capture_output=True, timeout=7)
            result = json.loads(completed.stdout)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(stdout_log.read_bytes(), b"good")
            self.assertEqual(result["capture"]["streams"]["stdout"]["status"], "complete")
            self.assertEqual(result["capture"]["streams"]["stderr"]["status"], "write_error")

    def test_split_independent_eof_retained_descriptor_is_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            code = ("import os,time\n"
                    "os.close(1)\n"
                    "pid=os.fork()\n"
                    "if pid: os._exit(0)\n"
                    "time.sleep(2.7)\n")
            started = time.monotonic()
            completed, result, stdout_log, _ = self.invoke_split(base, code, timeout=6)
            elapsed = time.monotonic() - started
            try:
                self.assertEqual(completed.returncode, 1)
                self.assertLess(elapsed, 2.6)
                stdout = result["capture"]["streams"]["stdout"]
                stderr = result["capture"]["streams"]["stderr"]
                self.assertEqual(stdout["status"], "complete")
                self.assertTrue(stdout["eof"])
                self.assertEqual(stdout_log.read_bytes(), b"")
                self.assertEqual(stderr["status"], "incomplete")
                self.assertFalse(stderr["eof"])
                self.assertFalse(result["capture"]["eof"])
            finally:
                # The known-finite descriptor holder self-exits at 2.7s even
                # if an assertion above fails.
                time.sleep(.5)

    def test_split_hot_outputs_allow_willing_stdin_reader_to_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            payload = b"input" * (256 * 1024)
            source.write_bytes(payload)
            receipt = base / "consumed"
            code = ("import os,signal,sys,threading\n"
                    "signal.alarm(6)\n"
                    "def flood(fd,byte):\n"
                    " while True: os.write(fd,byte*65536)\n"
                    "threading.Thread(target=flood,args=(1,b'O'),daemon=True).start()\n"
                    "threading.Thread(target=flood,args=(2,b'E'),daemon=True).start()\n"
                    "data=sys.stdin.buffer.read()\n"
                    f"open({str(receipt)!r},'w').write(str(len(data)))\n")
            completed, result, _, _ = self.invoke_split(
                base, code, deadline=5, timeout=9,
                extra=("--stdin-file", source, "--stdin-limit", len(payload)))
            self.assertEqual(completed.returncode, 1, completed.stderr)
            self.assertEqual(int(receipt.read_text()), len(payload))
            self.assertEqual(result["input"], {
                "status": "complete", "bytes_acquired": len(payload),
                "bytes_written": len(payload), "eof_sent": True})
            self.assertTrue(result["termination"]["parent_reaped"])
            self.assertEqual(result["command"]["exit_code"], 0)
            self.assertLessEqual(result["capture"]["retained_bytes"], 4096)

    def test_split_dual_flood_keeps_stdin_deadline_and_cancellation_finite(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source = base / "input.bin"
            source.write_bytes(b"x" * (1024 * 1024))
            code = ("import os,signal\n"
                    "signal.alarm(6)\n"
                    "signal.signal(signal.SIGTERM,signal.SIG_IGN)\n"
                    "while True:\n os.write(1,b'O'*65536);os.write(2,b'E'*65536)\n")
            started = time.monotonic()
            completed, result, _, _ = self.invoke_split(
                base, code, deadline=1, timeout=7,
                extra=("--term-grace-seconds", 0, "--stdin-file", source,
                       "--stdin-limit", len(source.read_bytes())))
            self.assertLess(time.monotonic() - started, 3.8)
            self.assertEqual(completed.returncode, 1)
            self.assertEqual(result["termination"]["reason"], "deadline")
            self.assertTrue(result["termination"]["kill_sent"])
            self.assertLessEqual(result["capture"]["retained_bytes"], 4096)
            self.assertIn(result["input"]["status"], ("complete", "interrupted"))

            helper_args = [sys.executable, "-B", str(SCRIPT), "--cwd", str(base),
                           "--stdout-log", str(base / "cancel.out"),
                           "--stderr-log", str(base / "cancel.err"),
                           "--deadline-seconds", "10", "--capture-limit", "4096",
                           "--tail-bytes", "0", "--", sys.executable, "-B", "-c", code]
            helper = subprocess.Popen(helper_args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            time.sleep(.3)
            helper.send_signal(signal.SIGTERM)
            stdout, stderr = self.communicate_owned(helper, timeout=5, settle_seconds=1)
            result = json.loads(stdout)
            self.assertEqual(helper.returncode, 1, stderr)
            self.assertEqual(result["termination"]["reason"], "cancelled")


if __name__ == "__main__":
    unittest.main()
