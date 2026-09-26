def classify_integration_receipt(catalog_path, invoice_path, receipt):
    if receipt is None:
        return "unknown"
    if receipt.get("exitCode") == 0:
        return "applicable"
    return "failed"
