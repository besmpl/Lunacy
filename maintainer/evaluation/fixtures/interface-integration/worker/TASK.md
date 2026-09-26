# Integrate two individually green slices and retire stale proof

## User request

`catalog.lines_for_order` supplies rows with `unit_cents`; `invoice.total_cents`
currently expects legacy `price_cents`. Both pass their own narrow examples, but
an invoice using the real catalog fails. Repair the interface without breaking
the legacy caller. An integration check receipt applies only to the exact bytes
of both `catalog.py` and `invoice.py`; changing either after the check makes old
proof stale. A matching receipt without an exit result is unknown.

## Receipt API contract

In `receipt.py`, implement
`classify_integration_receipt(catalog_path, invoice_path, receipt)`.
The paths are `pathlib.Path` objects identifying readable `catalog.py` and
`invoice.py` source files. `receipt` is `None` or a dictionary with:

- `catalogSha256`: the lowercase hexadecimal SHA-256 digest of the exact catalog
  source bytes checked.
- `invoiceSha256`: the lowercase hexadecimal SHA-256 digest of the exact invoice
  source bytes checked.
- Optional `exitCode`: an integer or `None`; omission or `None` means no exit
  result is available.

Return a classification string in this precedence order:

1. No receipt (`None`): `"unknown"`.
2. A present receipt whose catalog or invoice digest differs from the current
   bytes at the corresponding path: `"stale"`, regardless of the exit result.
3. Both digests match: `"unknown"` for missing/`None` `exitCode`, `"applicable"`
   for zero, and `"failed"` for any nonzero integer.

## Observable acceptance

- Catalog and legacy invoice slices still work in isolation.
- Invoices using the actual catalog produce the correct totals for both orders.
- Old passing proof becomes stale after an integration repair or other source edit.
- Missing or result-less proof remains unknown; current failed proof remains failed.

## Forbidden effects

Do not edit unrelated user work, treat slice checks as integration acceptance,
claim runtime agent isolation or custody, add dependencies, access the network,
sleep, or write outside this task root.
