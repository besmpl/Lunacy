# P4 Hard Gate 01 — resumable outer release envelope

## Verdict: PASS

The outer envelope is an opt-in, digest/identity-bound projection subordinate to existing release admission, exclusion, quiescence, target lock, and inner transaction recovery.

## Evidence accepted

- S1 implemented the closed v2 marker/schema, mutation-free status, resumable admission/delegation, opt-in CLI integration, docs, and recovery smoke without changing disabled/legacy behavior.
- S2 proved and repaired mismatched canonical path-digest binding, identity/owner retargetable CAS, resume-without-marker fresh launch, adoption of a foreign inner marker, and committed status without aggregate proof.
- Final terminal verification: `npm run check` 479 tests = 477 pass, 0 fail, 2 platform skips; typecheck/build/pack PASS; focused release matrix 16/16 PASS.
- Parent inspected envelope validation/CAS and deploy resume/inner-binding seams, then sampled all six envelope adversarial tests plus typecheck (PASS).

## Accepted boundaries

- Status performs no discovery, lock acquisition, cleanup, quiescence, publication, or other mutation.
- Resume requires the exact existing outer marker and revalidates manifest/target/owner/snapshot/inner identities under the established lock order.
- A stale owner can be rebound only at prepared with an advancing epoch and definitive non-live proof.
- `committed` is derived only with a verified inner aggregate; the outer marker never controls managed-tree bytes or rollback.
- Disabled/default/legacy/exact routes remain unchanged without explicit envelope flags.

The P4 write barrier is closed. Any later P4-owned change invalidates this gate and requires a new numbered gate.
