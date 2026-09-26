# Initial successful observations

These captures contain one valid single-line record each. Against separate
fresh local databases, both maintained adapters return `{"status":"ok",
"imported":1}`. The CLI exits 0; WSGI returns `200 OK` with one JSON bytes
element terminated by LF. The stored JSON customer is `acct-010`, email
`ada@example.com`, display name `Ada Lovelace`. The CSV customer is `acct-011`,
email `grace@example.com`, display name `Grace Hopper`.

These observations and the smoke test do not establish atomic rejection,
multiline/quoted/Unicode preservation, transport framing, error precedence,
or migration-guide quality. Further observations may be provided under the
unchanged public contract.
