import hashlib


def classify_integration_receipt(catalog_path, invoice_path, receipt):
    if receipt is None:
        return "unknown"
    if (receipt.get("catalogSha256") != hashlib.sha256(catalog_path.read_bytes()).hexdigest()
            or receipt.get("invoiceSha256") != hashlib.sha256(invoice_path.read_bytes()).hexdigest()):
        return "stale"
    exit_code = receipt.get("exitCode")
    if exit_code is None:
        return "unknown"
    return "applicable" if exit_code == 0 else "failed"
