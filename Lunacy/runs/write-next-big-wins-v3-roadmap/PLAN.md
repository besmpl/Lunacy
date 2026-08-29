# Plan — write the next major wins roadmap

## Goal

Turn the accepted four-direction ranking from `Lunacy/runs/next-big-wins-v3/phases/p2/reports/S5-worker-01.md` into a detailed, implementation-ready repository roadmap at `docs/NEXT_BIG_WINS_V3_ROADMAP.md`.

## Scope

- Preserve the accepted rank and boundaries: proof-gated durable continuation; transport-neutral attested execution; portable authoritative run continuity; authenticated incremental run-state engine.
- For each direction document the current bottleneck and evidence, desired boundary, non-goals, smallest coherent first release, later stages, reuse/ownership seams, compatibility and recovery behavior, verification and decisive proof, rollout/rollback, risks, dependencies, and completion gates.
- Include a cross-direction sequence and shared prerequisites without merging the four product boundaries.
- Clearly label facts, hypotheses, and proof required. Make no unsupported performance, token, provider, security, or production claims.
- Documentation only. Do not modify source, tests, package/release/install state, git history, or the accepted discovery artifacts.

## Execution

One Luna/xhigh documentation owner writes the roadmap and verifies structure, references, formatting, and scope. A separate adversary or Sol judgment is not justified because the accepted consequential ranking is already frozen and this step only expands it faithfully.

## Gate

Parent checks that all four accepted directions are detailed, distinct, ordered, compatible, recoverable, evidence-disciplined, and written to the requested file.
