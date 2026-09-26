# Mixed case: exporter rollout

This is a synthetic planning snapshot, not a command to run. The adopted outcome is a CSV exporter using the new schema, a documented CLI flag, and a regression check for both. No assignments or ready labels are supplied.

Source snapshot: `schema/fields.json` currently has revision 3. The schema decision owner has an authorized, unresolved proposal for revision 4 adding `external_id`; only that owner may change the schema. `export/csv.py` consumes the generated `schema/fields.json` artifact and must include the revision-4 field. `cli/export.py` can add and document the flag against the already stable CLI parser contract without touching schema or exporter. `tests/export_roundtrip.py` needs the settled revision-4 schema and exporter behavior. CLI and exporter own separate paths/effects. A combined test must use all settled outputs.

Task: find useful checkable results and the safe first wave. For every blocked result name the producer artifact and exact event that would change readiness; do not infer dependencies from citations alone.
