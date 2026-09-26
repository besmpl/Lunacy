# Broad case: import service release

This is a synthetic planning snapshot, not a command to run. The adopted outcome is a release that imports both JSON and CSV customer data, exposes validation errors through the CLI and HTTP API, and includes a migration guide. The parent must accept all four behaviors together. No assignment list or ready labels are supplied.

Source snapshot: `core/parse.py` already returns normalized records and error codes for both formats. `api/endpoint.py` and `cli/import.py` each call the parser but render errors separately. `docs/migrate.md` is absent. API, CLI, and docs write disjoint paths; only the final release check writes `build/release/`. The parser contract is frozen at revision 2. Existing API and CLI tests each exercise success only. A full release check needs the settled API, CLI, and guide outputs.

Task: identify the smallest useful checkable results, their consumers, facts/dependencies/effects, and the safe first wave. Do not split by file or invent work just to occupy slots. Include any final integration proof you would require.
