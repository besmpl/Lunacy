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
    path = candidate / "contact.py"
    spec = importlib.util.spec_from_file_location("candidate_contact", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evaluate(candidate):
    contact = load(candidate)
    expect(contact.normalize_email("Alice@EXAMPLE.COM") == "Alice@example.com",
           "provided normalization behavior regressed")
    expect(contact.normalize_email("  Alice@EXAMPLE.COM  ") == "Alice@example.com",
           "email whitespace was not normalized")
    expect(contact.normalize_email("\tAlice@EXAMPLE.COM\n") == "Alice@example.com",
           "email whitespace was not normalized")
    expect(contact.normalize_email("Case@Mixed.Example") == "Case@mixed.example",
           "local or domain case normalization changed")


try:
    evaluate(Path(sys.argv[1]))
except BehaviorFailure as error:
    emit("FAIL", str(error))
    raise SystemExit(1)
emit("PASS", "PASS")
