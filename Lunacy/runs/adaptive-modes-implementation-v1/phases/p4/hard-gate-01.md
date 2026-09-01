# P4 Hard Gate 01

Status: **PASS**

Accepted observable:
- The tracked/deployed private bridge exposes one exact `resolve-plan` route with trusted `auto|direct|explore`, canonical existing documents, and no free-form authority parser.
- Each invocation calls `resolvePrePlan` once. Direct returns the complete Plan without managed composition/state/artifacts; Focus and explicitly authorized Explore validate and enter the existing managed START path in-process.
- Current Explore requires an exact one-use invocation-local authorization bound to intent, authority, Wave, run/phase, and rollout-policy digest. Legacy `explicitExplore` and cross/stale/lookalike proofs refuse before mutation.
- The authorization is absent from package-root exports and durable state/schema/ledgers.

Evidence:
- Worker terminal: `npm run check` PASS — 708 tests, 704 pass, 0 fail, 4 existing platform/provider skips.
- Parent bounded acceptance: `npm run build --silent && node --test test/p4-resolve-plan.test.js test/product-surface.test.js test/p4-operator-docs.test.js` PASS — 15/15, zero skipped.
- Targeted inspection confirmed one resolver call in the route, same-process mint/consume, and exact admission binding.

Release boundary:
- No live install/activation, commit, or push occurred.
- P5 must add the final release-fenced supported-root floor census, then prove the complete command matrix, tracked-only isolated deploy/check, and rollback rehearsal without modifying the live installed skill.
