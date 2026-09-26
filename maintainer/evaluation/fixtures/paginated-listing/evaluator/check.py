from pathlib import Path
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
    sys.path.insert(0, str(candidate))
    try:
        import catalog
        import service
        return catalog, service
    finally:
        sys.path.pop(0)


def evaluate(candidate):
    catalog, service = load(candidate)
    expect(str(inspect.signature(service.list_names)) == "(names, limit=2)",
           "service.list_names public signature changed")
    expect(str(inspect.signature(catalog.fetch_page)) == "(names, cursor=None, limit=2)",
           "catalog.fetch_page public signature changed")
    expect(service.list_names(["a", "b", "c", "d", "e"], 2)
           == ["a", "b", "c", "d", "e"],
           "paginated listing omitted later page")
    expect(service.list_names([], 2) == [], "empty listing changed")
    expect(service.list_names(["a", "b", "c", "d"], 2) == ["a", "b", "c", "d"],
           "exact page boundary changed")
    boundary = catalog.fetch_page(["a", "b", "c", "d"], "4", 2)
    expect(boundary.names == () and boundary.next_cursor is None,
           "terminal cursor boundary changed")


try:
    evaluate(Path(sys.argv[1]))
except BehaviorFailure as error:
    emit("FAIL", str(error))
    raise SystemExit(1)
emit("PASS", "PASS")
