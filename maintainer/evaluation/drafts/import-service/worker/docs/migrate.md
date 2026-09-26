# Customer import entry points

Import a local UTF-8 JSON or CSV customer file with:

```sh
python -B cli.py --database customers.sqlite --format json --input customers.json
```

The HTTP adapter is `http_api.application`. Supply `POST /imports`,
`application/json` or `text/csv`, the byte content length, a binary input
stream, and the caller-owned database path in `lunacy.database`.

Each customer has `id`, `email`, and `display_name`. Successful responses are
JSON objects containing `status: "ok"` and the number imported. Consult
`CONTRACT.md` for the complete behavior required of callers and adapters.
