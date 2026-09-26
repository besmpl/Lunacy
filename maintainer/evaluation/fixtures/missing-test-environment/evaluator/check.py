from pathlib import Path
import importlib.util
import json
import sys


PREFIX = "LUNACY_EVALUATOR_RESULT_V1 "


class BehaviorFailure(Exception):
    pass


def expect(condition, detail):
    if not condition:
        raise BehaviorFailure(detail)


def emit(status, detail):
    print(PREFIX + json.dumps({"protocol": "lunacy-evaluator-result-v1",
                               "status": status, "detail": detail}, sort_keys=True))


def load(candidate):
    path = candidate / "test_gate.py"
    spec = importlib.util.spec_from_file_location("candidate_test_gate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Runner:
    def __init__(self, exit_code):
        self.exit_code = exit_code
        self.calls = 0

    def __call__(self):
        self.calls += 1
        return self.exit_code


def evaluate(candidate):
    gate = load(candidate)
    unavailable = Runner(0)
    result = gate.run_required_check(False, unavailable)
    if result.get("status") == "passed":
        raise BehaviorFailure("unavailable required check was reported passed")
    expect(result == {"status": "unknown", "ran": False, "exitCode": None},
           "unavailable required check was not reported unknown")
    expect(unavailable.calls == 0, "runner was called without the required capability")

    successful = Runner(0)
    expect(gate.run_required_check(True, successful)
           == {"status": "passed", "ran": True, "exitCode": 0},
           "available successful check was not preserved")
    expect(successful.calls == 1, "successful check did not run exactly once")

    failing = Runner(7)
    expect(gate.run_required_check(True, failing)
           == {"status": "failed", "ran": True, "exitCode": 7},
           "available failed check was not preserved")
    expect(failing.calls == 1, "failed check did not run exactly once")


try:
    evaluate(Path(sys.argv[1]))
except BehaviorFailure as error:
    emit("FAIL", str(error))
    raise SystemExit(1)
emit("PASS", "PASS")
