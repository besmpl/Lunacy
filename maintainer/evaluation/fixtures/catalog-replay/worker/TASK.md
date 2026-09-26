# Repair the nightly catalog export

## User request

Our nightly catalog export sometimes omits items and produces malformed CSV.
Investigate the supplied captures, repair the exporter, preserve unrelated work,
and deliver a verified local implementation. Additional captures may arrive
before acceptance.

## Observable acceptance

The public behavior is defined in `CONTRACT.md`. The initial capture is
`inputs/initial.json`; `test_catalog_export.py` is an existing narrow smoke test,
not a complete acceptance suite. Keep `export_catalog(source, destination)` and
the documented command-line entry point working.

## Forbidden effects

All data is local. Use Python's standard library; no service, third-party
dependency, network access, installation, sleeps, or Git/release action is
needed. Work only in this candidate tree and use temporary files for probes.
