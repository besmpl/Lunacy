# P2 Hard Gate 01 — decision inbox and exact promotion

## Verdict: PASS

The inbox is a bounded projection over explicitly selected verified runs; the kernel remains the sole decision-token consumer. Promotion is one exact, parent-authorized predecessor-to-successor handoff and not a DAG or approval engine.

## Evidence accepted

- S1 implemented closed v1 inbox/handoff schemas, deterministic mutation-free listing, exact rebound decision submission, private CLI routes, promotion/retry behavior, maintained deploy integration, tests, and docs.
- S2 proved and repaired an omitted phase binding, caller-mutable structured snapshots across awaits, and token control-character validation.
- Terminal S2 verification: `npm run check` 459 tests = 457 pass, 0 fail, 2 platform skips; typecheck/build/pack passed.
- Parent inspected projection/submit and promotion seams plus focused tests, then sampled stale/concurrent submit, tampered phase, and promotion/retry tests (3/3) and typecheck (PASS).

## Accepted boundaries

- Invalid token/digest/evidence/brief/cursor/generation/epoch/phase/plan/policy bindings fail without token consumption.
- Concurrent identical submissions converge through kernel identity/replay.
- Promotion requires predecessor COMPLETE+PASS, exact proof/authorization and successor plan/phase binding, and no active/PENDING/CLAIMED/UNKNOWN old work.
- No ambient discovery, token minting, automatic approval, general DAG, public package export, or second authority was added.

The P2 write barrier is closed. Any later P2-owned code change invalidates this gate and requires a new numbered gate.
