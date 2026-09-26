# Catalog export contract

## Archive and current state

- The UTF-8 JSON archive is an object with required `first` and `pages` fields.
  `first` is an opaque cursor string or null. `pages` is an object mapping cursor
  strings to pages. Empty strings are valid cursors; do not interpret cursors as
  numbers or infer them from row counts.
- Each reachable page is an object with required `rows` (an array) and `next`
  (a cursor string or null). An empty page can have a successor. Only the chain
  reachable from `first` belongs to the capture; unreachable page contents are
  ignored. A missing reachable cursor or a cycle is invalid. A null `first`
  means an empty catalog.
- Every reachable row is an object containing `sku` (a nonempty string),
  `revision` (a nonnegative integer, not a boolean), `active` (a boolean), and
  `name` (a string). Validate every reachable row, including inactive and
  superseded rows. Do not coerce field types.
- For each SKU, the greatest revision defines the current state, regardless of
  arrival order. Its payload is `(active, name)`. Repetitions with the same
  greatest revision and identical payload are harmless; differing payloads at
  that greatest revision invalidate the capture. Payload differences at lower,
  superseded revisions do not invalidate an otherwise valid capture. Inactive
  current states are absent from the export.
- Unknown extra fields on the archive, pages, or rows are ignored. They do not
  participate in payload equality; the required fields and types still apply.

## Output and interfaces

- Write UTF-8 CSV without a BOM. The header is `sku,revision,name`. Data rows are
  sorted in ascending Unicode code-point order by SKU, with no locale folding
  or normalization. Revisions use ordinary decimal integer text.
- Use canonical minimal CSV quoting: quote a field exactly when it contains a
  comma, double quote, CR, or LF; inside a quoted field double each double quote.
  Record terminators are LF. Preserve names exactly, including Unicode, quotes,
  commas, and embedded CR/LF. Even an empty catalog emits the header and its LF.
- Preserve the callable `export_catalog(source, destination)`, accepting input
  and output filesystem paths as strings or `pathlib.Path` values. Its return
  value is unspecified. The CLI is:

  ```sh
  python3 -B catalog_export.py INPUT_JSON OUTPUT_CSV
  ```

- A successful return or zero exit means the complete output was written.
  Parse, acquisition, or validation failure must raise from the callable and
  produce a nonzero CLI exit. Such a failure must leave an existing destination
  byte-for-byte unchanged: no partial successful export. This is not a promise
  of crash durability or recovery from a disk/write failure.
