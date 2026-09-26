# Repair customer imports across maintained callers

## User request

Our local customer import service accepts JSON and CSV through a command-line
tool and a WSGI HTTP adapter. Make both callers deliver the same validated,
atomic import behavior, preserve customer data exactly as documented, and
provide migration guidance for callers. Investigate the supplied observations,
repair the implementation, preserve unrelated work, and deliver a verified
local result. Additional raw observations may arrive before acceptance.

This is one complete product outcome. Choose coherent ownership and work
boundaries from the actual code; there is no supplied assignment queue.

## Observable acceptance

The complete public behavior and fixed interfaces are in `CONTRACT.md`.
Preserve `core.parse.parse_records`, `core.store.list_customers`,
`core.store.commit_customers`, `service.import_customers`, the documented
`python -B cli.py --database PATH --format json|csv --input PATH` entry point,
and `http_api.application(environ, start_response)`.

- JSON and CSV follow the documented row rules, normalization, error order,
  structural rejection, and exact display-name preservation.
- An invalid batch does not create or change the database; a valid batch
  atomically upserts all normalized rows and preserves unrelated customers.
- The actual CLI and actual WSGI callable preserve shared results, transport
  framing, text, terminal outcomes, and unexpected I/O failures.
- `docs/migrate.md` explains formats, normalization/preservation, row errors,
  CLI exit codes, HTTP statuses, and no partial import for existing callers.

`inputs/initial.json`, `inputs/initial.csv`, and `inputs/OBSERVATIONS.md` are the
initial raw observations. `python -B -m unittest -v test_smoke` exercises only
ordinary successful single-line input. It is intentionally insufficient for
acceptance, not evidence that all contract requirements work. Additional
observations use the same contract; they do not add a new requirement.
Add focused checks and exercise the real adapters before reporting completion.
Migration quality needs semantic review; a runtime PASS alone is not complete
acceptance or proof of native coordination.

## Forbidden effects

All data is local. Use Python's standard library and only this candidate tree
for changes and writable scratch. Preserve existing input observations and
unrelated historical data/reports. Do not add dependencies, install anything,
access the network or providers, start sockets/live servers/threads, sleep,
change global configuration, or perform Git/release actions. Invoke WSGI with
ordinary binary streams and its request callable; no web server is needed.
Do not claim checker success proves process isolation, routing, custody, or
unobserved effects. Do not import evaluator/reference code into the candidate.
