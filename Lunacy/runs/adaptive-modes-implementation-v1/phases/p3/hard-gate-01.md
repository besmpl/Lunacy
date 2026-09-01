# P3 Hard Gate 01

Status: **PASS**

Accepted observable:
- Durable Focus readers accept the supported historical/current union while current at/above-floor command admission enforces the exact retained 1–2-group Focus contract.
- New Focus authorship is exact 2+1 / 3 calls; Explore remains exact 5+1+3 / 9 calls and is never selected implicitly.
- `resolvePrePlan` is the single deterministic production selection/authorship/Plan-parse seam; legacy helpers delegate without changing their public result shape.
- Direct preserves complete-Plan/package-root identity and unresolved AUTO refuses without side effects.

Evidence:
- Worker terminal: `npm run check` PASS — 701 tests, 697 pass, 0 fail, 4 existing platform/provider skips.
- Parent bounded acceptance: `npm run build --silent && node --test test/p2-deliberation.test.js test/p2-one-shot-lifecycle.test.js test/l3b-wave-writer-contraction.test.js` PASS — 22/22, zero skipped.
- Targeted source inspection confirmed reader/writer separation, contextual admission in the accepted-report production path, and compatibility delegation.

Compatibility and rollout:
- Reader-first compatibility remains intact below generation floor 22.
- No installed CLI/adapter, live activation, installation, commit, or push occurred.
- P4 may now wire the private installed resolver and invocation-scoped Explore authorization.
