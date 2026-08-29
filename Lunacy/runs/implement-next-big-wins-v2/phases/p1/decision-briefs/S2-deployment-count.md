# S2 decision brief — deployment managed-file count

## Question
Should the P1 gate treat `test/r2-deployment.test.js:47` (`managedFiles === 164`) as a baseline-known unrelated red, or as an integration consequence of the fleet release?

## Facts / evidence
- A clean checkout rebuilt from baseline commit `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7` passes the complete `test/r2-deployment.test.js` file, including the exact `managedFiles === 164` assertion. Evidence: `/tmp/lunacy-baseline-r2.log`.
- The settled P1 working tree fails only that assertion with `actual 168`, while the other four R2 tests pass. Evidence: `/tmp/lunacy-current-r2.log`.
- The four additional managed files are the newly built private fleet coordinator artifacts (`dist/fleet-coordinator.js`, `.d.ts`, and source maps) included by `tools/deploy-skill.mjs`'s existing `runtime/dist` inventory. The CLI's fleet route imports this module, so the files are reachable package/runtime surfaces rather than an unrelated test flake.

## Options
1. **Update the exact count assertion to 168** (and any frozen release fixture) as maintained integration-surface work. This is the smallest compatible correction; no R2 product semantics change.
2. **Exclude fleet coordinator artifacts from deployment inventory/package**. This would break the new CLI route or require a separate loading mechanism, and risks violating P1's private route contract.
3. **Retain 164 and classify as baseline-known**. This is factually incorrect after the P1 additions and leaves the authoritative check red.

## Recommendation
Choose option 1 at the P1 integration gate: treat the count assertion as maintained cross-phase integration evidence, update it under explicit parent/gate authority, and rerun the R2/full matrix. S2 does not edit `test/r2-deployment.test.js` or R2 product surfaces without that authority.

## Scope decision
Updating the exact package-count assertion is **in-scope maintained-surface integration work only with explicit P1 gate authorization**; it is outside this S2 adversary's owned coordinator/CLI/test/doc repair surfaces. Until then, preserve the red and do not relabel it baseline/unrelated.
