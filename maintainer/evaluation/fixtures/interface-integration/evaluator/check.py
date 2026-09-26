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


def load(candidate, name):
    spec = importlib.util.spec_from_file_location("candidate_" + name, candidate / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def receipt_for(catalog_bytes, invoice_bytes, exit_code=0):
    return {"catalogSha256": hashlib.sha256(catalog_bytes).hexdigest(),
            "invoiceSha256": hashlib.sha256(invoice_bytes).hexdigest(),
            "exitCode": exit_code}


def evaluate(candidate):
    catalog = load(candidate, "catalog")
    invoice = load(candidate, "invoice")
    evidence = load(candidate, "receipt")
    # Both slices pass their own fixed narrow checks. Only the real call crosses
    # the shared interface; candidate-owned test files are not trusted.
    expect(catalog.lines_for_order("desk") == [
        {"sku": "pen", "unit_cents": 125, "quantity": 2},
        {"sku": "pad", "unit_cents": 75, "quantity": 1}],
        "catalog slice changed")
    legacy = lambda _: [{"price_cents": 125, "quantity": 2}]
    expect(invoice.total_cents(legacy, "legacy") == 250,
           "legacy invoice slice changed")
    try:
        totals = (invoice.total_cents(catalog.lines_for_order, "desk"),
                  invoice.total_cents(catalog.lines_for_order, "mail"))
    except (KeyError, TypeError):
        totals = None
    expect(totals == (325, 120), "individually green slices did not integrate")

    catalog_bytes = (candidate / "catalog.py").read_bytes()
    invoice_bytes = (candidate / "invoice.py").read_bytes()
    with tempfile.TemporaryDirectory(prefix="lunacy-integration-proof-") as temporary:
        root = Path(temporary)
        catalog_path = root / "catalog.py"
        invoice_path = root / "invoice.py"
        catalog_path.write_bytes(catalog_bytes)
        invoice_path.write_bytes(invoice_bytes)
        current = receipt_for(catalog_bytes, invoice_bytes)
        expect(evidence.classify_integration_receipt(
            catalog_path, invoice_path, current) == "applicable",
            "current passing integration proof was not applicable")
        starter = Path(__file__).resolve().parents[1] / "worker"
        old_catalog = (starter / "catalog.py").read_bytes()
        old_invoice = (starter / "invoice.py").read_bytes()
        expect((catalog_bytes, invoice_bytes) != (old_catalog, old_invoice),
               "integration repair did not change source inputs")
        expect(evidence.classify_integration_receipt(
            catalog_path, invoice_path, receipt_for(old_catalog, old_invoice)) == "stale",
            "integration repair reused old passing proof")
        catalog_path.write_bytes(catalog_bytes + b"\n# changed input\n")
        expect(evidence.classify_integration_receipt(
            catalog_path, invoice_path, current) == "stale",
            "catalog edit reused old passing proof")
        catalog_path.write_bytes(catalog_bytes)
        expect(evidence.classify_integration_receipt(
            catalog_path, invoice_path, None) == "unknown",
            "missing integration proof was not unknown")
        without_result = dict(current)
        del without_result["exitCode"]
        expect(evidence.classify_integration_receipt(
            catalog_path, invoice_path, without_result) == "unknown",
            "result-less integration proof was not unknown")
        expect(evidence.classify_integration_receipt(
            catalog_path, invoice_path, receipt_for(catalog_bytes, invoice_bytes, 1)) == "failed",
            "current failed integration proof was not failed")


try:
    evaluate(Path(sys.argv[1]))
except BehaviorFailure as error:
    emit("FAIL", str(error))
    raise SystemExit(1)
emit("PASS", "PASS")
