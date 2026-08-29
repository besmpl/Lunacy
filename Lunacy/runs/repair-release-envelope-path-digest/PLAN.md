# Plan — repair latest Lunacy production deploy blocker

## Goal

Repair the exact `ReferenceError: pathDigest is not defined` hit by the first production `--release-envelope` deployment of the P5 READY candidate, add regression proof for the real CLI path, and leave the candidate ready for an exact production retry.

## Evidence and boundary

- First red: `tools/deploy-skill.mjs:1617` on fresh envelope creation.
- The helper is currently scoped inside the existing-envelope branch at `tools/deploy-skill.mjs:1598` but is also used by fresh creation and later quiescence.
- The failed attempt reported envelope status `ABSENT`; no installed target mutation was observed.
- Preserve release ownership, fail-closed behavior, canonical digest semantics, legacy deploy/check/restore bytes, and unrelated candidate work.

## Execution and gate

One Luna/xhigh worker owns the root-cause repair and focused regression. No Sol/adversary is warranted for this narrow lexical-scope defect. Parent inspects the exact diff and runs a bounded fresh-envelope acceptance sample before retrying production.
