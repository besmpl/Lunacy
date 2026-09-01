# P4 S1 Worker Report

Status: **PASS**

## Delivered

- Added the private `runtime/bridge.mjs resolve-plan` route with canonical `PlanAuthorshipInput`, exact deliberation/rollout policies, and the closed trusted `auto|direct|explore` flag.
- Kept `resolvePrePlan` to exactly one production call per resolver invocation and removed prose from the selection boundary.
- Preserved Direct as a complete-Plan bypass with no managed-only inputs, provider work, run state, or artifacts.
- Validated Focus/Explore Wave, compiled Plan, topology, capability, rollout policy, and host policy before entering the existing managed `START` path in the same process.
- Added a private one-use `ExploreAuthorization` bound to projected intent Ref, authority digest, Wave digest, run/phase, and rollout-policy digest. Composition inspects the tuple; kernel admission consumes and verifies it. Serialization, lookalikes, reuse, the legacy `explicitExplore` boolean, and retained implicit-Explore facts cannot authorize current Explore.
- Kept the authorization outside package-root exports, durable state, schemas, manifests, journals, ledgers, and output.
- Updated generated deployment help plus README, skill, bridge/API/install/recovery, and operator-contract surfaces for the verified installed route and explicit-only Explore admission.
- Added exact refusal, Direct, Focus, Explore, one-use/mismatch, root-surface, and isolated tracked-input installed-runtime tests.

## Verification

- Focused build/tests: `npm run build --silent && node --test test/p4-operator-docs.test.js test/p4-resolve-plan.test.js test/product-surface.test.js` — **15/15 passed**.
- Broader adaptive/deployment suite: P2 lifecycle/deliberation, P4 rollout/resolver, product surface, and deployment adversary — **51 passed, 1 expected skip**.
- Isolated deployment smoke copied only maintained release inputs, deployed to a disposable target, invoked installed `runtime/bridge.mjs resolve-plan`, proved Direct artifact-free, and admitted explicit Explore exactly once — **PASS**.
- Terminal `npm run check` (typecheck, 708 tests, build, package dry-run) — **704 passed, 4 expected platform/provider skips, 0 failed**.
- `git diff --check` — **PASS**.

## Scope and risk

- No public root API, persistent state/schema, or ledger control plane was added.
- No live skill install/activation, commit, push, reset, clean, or unrelated-work reversal was performed.
- Remaining skips are the repository's existing host/provider-dependent checks; all runnable checks passed.
