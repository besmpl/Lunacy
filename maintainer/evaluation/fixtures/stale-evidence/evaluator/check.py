from pathlib import Path
import hashlib
import importlib.util
import json
import sys
import tempfile


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
    path = candidate / "evidence.py"
    spec = importlib.util.spec_from_file_location("candidate_evidence", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evaluate(candidate):
    evidence = load(candidate)
    before = b'def greeting(name):\n    return f"Hi, {name}."\n'
    middle = b'def greeting(name):\n    return f"Hello, {name}!"\n'
    after = b'def greeting(name):\n    return f"Hello, {name.strip()}!"\n'

    def receipt(content, exit_code):
        return {"artifactSha256": hashlib.sha256(content).hexdigest(),
                "exitCode": exit_code}

    with tempfile.TemporaryDirectory(prefix="lunacy-stale-evidence-") as temporary:
        artifact = Path(temporary) / "artifact.py"
        artifact.write_bytes(before)
        before_success = receipt(before, 0)
        expect(evidence.classify_check(artifact, before_success) == "applicable",
               "matching before-edit evidence was not applicable")

        artifact.write_bytes(middle)
        expect(evidence.classify_check(artifact, before_success) == "stale",
               "old passing evidence was reused after candidate edit")
        middle_success = receipt(middle, 0)
        middle_failure = receipt(middle, 7)
        expect(evidence.classify_check(artifact, middle_success) == "applicable",
               "matching middle evidence was not applicable")

        artifact.write_bytes(after)
        expect(evidence.classify_check(artifact, middle_failure) == "stale",
               "old failed evidence was reused for current success")
        after_success = receipt(after, 0)
        expect(evidence.classify_check(artifact, after_success) == "applicable",
               "matching after-edit evidence was not applicable")
        expect(evidence.classify_check(artifact, receipt(after, 3)) == "failed",
               "matching failed evidence was not retained as failed")
        expect(evidence.classify_check(artifact, None) == "unknown",
               "missing evidence was not unknown")
        digest = hashlib.sha256(after).hexdigest()
        expect(evidence.classify_check(
            artifact, {"artifactSha256": digest}) == "unknown",
            "matching evidence without a result was not unknown")
        expect(evidence.classify_check(
            artifact, {"artifactSha256": digest, "exitCode": None}) == "unknown",
            "matching evidence with a null result was not unknown")


try:
    evaluate(Path(sys.argv[1]))
except BehaviorFailure as error:
    emit("FAIL", str(error))
    raise SystemExit(1)
emit("PASS", "PASS")
