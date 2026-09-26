# Import-service draft checkpoint

Work was explicitly stopped before independent v2 acceptance and integration.
Preserve this snapshot; do not treat it as a registered or accepted fixture.

## What is here

- Complete worker packet, supplied parser/store, starter adapters and smoke tests.
- Independently authored fixed evaluator, frozen synthetic captures/expectations,
  correct reference and deliberately incomplete control.
- Independent oracle-control tests in `oracle-tests/test_import_service.py`.
- Prospective public contract v2 and matching reference migration guidance.

The existing evaluation runner still has nine registered fixtures. No live
native experiment was launched with this draft. No plugin runtime default,
installed artifact or provider setting was changed by this draft preparation.

## Evidence at stop

Original starter/reference smoke: 2 tests pass each. Initial independent oracle
controls: 14 pass. Fresh independent review nevertheless reproduced three gaps:

1. v1 omitted the standard-library CSV field-size ceiling: reference rejected
   a 131073-character CSV field (while the same JSON string passed).
2. A per-row-commit store mutant passed despite failure to roll back a late write.
3. A WSGI mutant swallowing stream OSError passed despite violating propagation.

Before any native participant, v2 explicitly adopted the unchanged 131072-character
CSV per-field/default-runtime ceiling, including header and ignored fields (JSON
unchanged), and published existing SQLite schema/constraint compatibility for a
real failed-later-write probe. This is a prospective bounded-contract revision,
not proof that the reference satisfied v1. Larger CSV or variable ambient CSV
configuration is an explicit contract-replacement trigger.

The oracle repair added seven controls: all seven fail against the old checker;
the repaired 21-test suite passes (13.118 seconds, 30-second outer bound).
Those are author/test receipts, not independent acceptance of v2. The reference
migration guide was semantically reviewed against v1 subject to the CSV mismatch;
its subsequent v2 additions have not received the final independent review.

## Unfinished, not waived

- Independent review of final v2 checker, controls, contract and guide.
- Final variant run/preservation evidence and acceptance at the integrated paths.
- Registration, maintainer-suite integration and final affected checks.
- A separately bounded native discovery/evidence-transfer experiment, if justified.

For a future authorized local control run (not performed by saving this snapshot):

```sh
IMPORT_SERVICE_FIXTURE="$PWD/maintainer/evaluation/drafts/import-service" \
  python3 -B -m unittest discover \
  -s maintainer/evaluation/drafts/import-service/oracle-tests -p 'test_*.py' -v
```

Runtime PASS cannot certify migration semantics, native coordination, discovery,
model obedience, speedup or scale. The trusted checker runs local candidate code;
it is not a sandbox. Raw session logs and private operational artifacts are not
part of this source checkpoint. All workers/processes were settled before saving.
