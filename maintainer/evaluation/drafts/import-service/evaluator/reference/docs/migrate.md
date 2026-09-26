# Migrating customer import callers

Use the shared import service through either maintained adapter. Both return
the outcome of this request, not a report of previous runs. Preserve existing
customer databases; importing a valid batch upserts by ID and leaves all other
customers in place.

## Accepted data and exact values

JSON input is an array of objects. CSV uses the standard Excel CSV dialect,
including quoted commas, doubled double quotes, and quoted embedded newlines.
Its header must contain each exact, case-sensitive name `id`, `email`, and
`display_name` once. Extra object fields and extra named CSV columns are
ignored. In this bounded runtime each CSV field, including header and ignored
fields, is limited to 131072 decoded Unicode characters, inclusive. Larger
fields are structural INVALID_INPUT; CR and LF count individually. This is not
a byte limit and does not add a JSON size limit. Keep Python's default CSV
field-size configuration unchanged; hosts with another setting are outside
this fixture's tested runtime. Each data row must have the same width as the CSV header. JSON `[]`
and header-only CSV are valid empty batches; an empty CSV file is not.

`id` must be a string that is nonempty after trimming outer whitespace. The
trimmed ID is stored and matched case-sensitively. `email` must be a string;
outer whitespace is trimmed and the stored value lowercased. The result must
contain exactly one `@`, have nonempty sides, and contain no whitespace.
`display_name` must be a string, including an empty string if intended. It is
stored exactly: no trimming, line-ending conversion, Unicode normalization,
or rewriting of commas, quotes, CR, LF, or Unicode separators.

Do not pre-split CSV into physical lines or normalize its contents before
calling the service. Encode transport bytes as strict UTF-8.

## Structured validation and all-or-nothing persistence

Success is exactly `{"status":"ok","imported":N}`. `N` counts records in this
valid batch, including upserts of existing IDs, rather than total customers in
the database. Validation failure is `{"status":"invalid","errors":[...]}`.
Each error has `row` and `code`. Row numbers start at 1 for data records, not
physical lines or the CSV header. One error is reported per invalid row, in
input order. Field error precedence is `INVALID_ID`, `INVALID_EMAIL`,
`INVALID_DISPLAY_NAME`, then `DUPLICATE_ID`.

Duplicate IDs are detected after trimming. The first otherwise valid
occurrence reserves its ID; subsequent otherwise valid occurrences get
`DUPLICATE_ID`. An invalid row does not reserve an ID. Malformed JSON/CSV,
non-array JSON, a non-object JSON array member, invalid CSV headers, or row
width mismatches reject the entire input with row 0 `INVALID_INPUT`. Invalid
UTF-8 and invalid or prematurely ended HTTP bodies use that same row-0 form.

The parser's `records` are preview information and may accompany errors.
Never treat them as a batch approved for persistence. If **any** row or
structural error exists, the service does not call the store: it neither
creates a database nor updates any existing customer. Fix the batch and submit
it again. A fully valid batch commits all its normalized rows atomically;
there is no partial-import mode. Existing databases use the SQLite table
`customers(id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL)`.
Preserve that schema compatibility and any caller-owned constraints/triggers;
do not bypass a rejection by dropping them or migrating to different storage.
If SQLite rejects a later row of an otherwise valid batch, the error propagates
and the entire batch rolls back, including its earlier writes. Previously accepted customers and unrelated
reports are not deleted on a later invalid request.

## Command-line callers

```sh
python -B cli.py --database customers.sqlite --format csv --input customers.csv
```

Use `--format json` for JSON. The CLI reads the complete input file as UTF-8
without newline rewriting. It writes one JSON result plus LF to stdout.
Exit 0 means the batch committed successfully. Exit 2 means invalid input,
including malformed data or invalid UTF-8; inspect the structured errors.
Other I/O failures are nonzero and must not be interpreted as a successful
import. Do not infer success merely because a process printed something.

## WSGI HTTP callers

The maintained callable is `http_api.application(environ, start_response)`.
Set `lunacy.database` to the caller-owned database path, use `POST /imports`,
and provide a binary `wsgi.input` stream. `CONTENT_LENGTH` is the exact body
length in **bytes**, written as a nonempty string of ASCII digits with no
sign or surrounding whitespace. Only that many bytes are read; a shorter body
is invalid, and bytes after that boundary are not consumed. Short individual
reads are supported and are not themselves premature EOF.

`CONTENT_TYPE` is `application/json` or `text/csv`, optionally followed by one
`; charset=utf-8`. Media type and charset tokens are ASCII-case-insensitive,
and ASCII whitespace around tokens, semicolon, and equals is accepted. Do
not quote the charset or add other/repeated parameters.

Responses contain one JSON bytes element plus LF, with `Content-Type:
application/json` and an exact byte `Content-Length`. Success returns
`200 OK`; invalid data, UTF-8, length, or premature EOF returns
`400 Bad Request` with the structured invalid result. Unsupported routes,
methods, and media return respectively `404 Not Found` / `NOT_FOUND`,
`405 Method Not Allowed` / `METHOD_NOT_ALLOWED`, and
`415 Unsupported Media Type` / `UNSUPPORTED_MEDIA_TYPE`, each as
`{"status":"error","code":"..."}`. Validation precedence is path, method,
media type, then body/data. These rejected requests do not persist anything.
Unexpected I/O errors propagate rather than becoming successful responses.

No socket or server startup is needed to integrate or test this callable.
