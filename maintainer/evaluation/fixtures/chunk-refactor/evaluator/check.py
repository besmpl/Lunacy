from pathlib import Path
import importlib.util
import inspect
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
    path = candidate / "chunks.py"
    spec = importlib.util.spec_from_file_location("candidate_chunks", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def evaluate(candidate):
    chunks = load(candidate)
    expect(list(inspect.signature(chunks.chunk).parameters) == ["values", "size"],
           "chunk public signature changed")
    expect(list(inspect.signature(chunks.count_chunks).parameters) == ["length", "size"],
           "count_chunks public signature changed")
    expect(chunks.chunk([], 3) == [], "empty chunking changed")
    expect(chunks.count_chunks(0, 3) == 0, "empty length must have zero chunks")
    expect(chunks.count_chunks(4, 2) == 2, "exact boundary gained an empty chunk")
    expect(chunks.count_chunks(5, 2) == 3, "partial chunk count changed")
    expect(chunks.chunk([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]],
           "partial chunking changed")
    for call in (lambda: chunks.chunk([1], 0), lambda: chunks.count_chunks(1, 0),
                 lambda: chunks.chunk([1], -1),
                 lambda: chunks.count_chunks(1, -1)):
        try:
            call()
        except ValueError:
            pass
        else:
            raise BehaviorFailure("invalid size must raise ValueError")
    try:
        chunks.count_chunks(-1, 2)
    except ValueError:
        pass
    else:
        raise BehaviorFailure("negative length must raise ValueError")


try:
    evaluate(Path(sys.argv[1]))
except BehaviorFailure as error:
    emit("FAIL", str(error))
    raise SystemExit(1)
emit("PASS", "PASS")
