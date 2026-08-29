# P2 hard gate 01 — production installation

Status: **PASS**

## Result

- Baseline full `npm run check`: PASS before the narrow deploy-tool repair; after the repair, typecheck/build and focused release/deployment tests passed 12/12, plus the parent fresh-envelope regression 1/1.
- Production snapshot binding: PASS.
- Resumable production release envelope: `VALID`, phase `committed`, recovery attempts `0`.
- Production deploy: `status: deployed`, source digest `4c6703de632a9c21cfefbcf84aef1ed114704fbe8d7d5da6b81ac0028be7a6da`, 174 managed files, aggregate `4a3dc512c4b18c00fda2e31625c824a516bba1b30512eb6b5cdfc1522f9af925`.
- Independent production check with a fresh manifest/snapshot: `status: current`, same source digest, managed count, and aggregate.
- Source and installed `SKILL.md`, `README.md`, `WORKSPACE.md`, planning doctrine, worker engineering guide, and Luna compatibility reference match byte-for-byte.

## Recovery

The outer marker is committed and requires no recovery action. The managed deploy retained the prior transaction-safe complete-tree publication and unrelated top-level skill files. If rollback is later authorized, use the repository's attested rollback workflow; do not hand-copy runtime files.

Evidence is in `phases/p2/evidence/`.
