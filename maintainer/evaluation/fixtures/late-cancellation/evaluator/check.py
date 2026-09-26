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
    path = candidate / "request_state.py"
    spec = importlib.util.spec_from_file_location("candidate_request_state", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.RequestState


def evaluate(candidate):
    request_state = load(candidate)()
    cancelled = request_state.start()
    request_state.cancel()
    accepted = request_state.complete(cancelled, "late")
    expect(not accepted and request_state.snapshot() == (cancelled, "cancelled", None),
           "late completion overwrote cancellation")

    request_state = load(candidate)()
    stale = request_state.start()
    current = request_state.start()
    accepted = request_state.complete(stale, "stale")
    expect(not accepted and request_state.snapshot() == (current, "running", None),
           "stale generation overwrote newer request")
    expect(request_state.complete(current, "fresh") is True,
           "current generation was not accepted")
    expect(request_state.snapshot() == (current, "completed", "fresh"),
           "current completion was not retained")


try:
    evaluate(Path(sys.argv[1]))
except BehaviorFailure as error:
    emit("FAIL", str(error))
    raise SystemExit(1)
emit("PASS", "PASS")
