# Plan — implement the complete next-big-wins roadmap

## Goal

Implement, verify, integrate, and prepare a safely releasable version of every accepted direction in `docs/NEXT_BIG_WINS_ROADMAP.md`, in its fixed order.

## Baseline and authority

- Baseline commit: `9e77159577a5fc8d0fb5e3f182c8fdd8584df4b7` plus the uncommitted accepted roadmap/control artifacts.
- Product plan: `docs/NEXT_BIG_WINS_ROADMAP.md`.
- Accepted ranking/gate: `Lunacy/runs/next-big-wins-v2/phases/p2/{reports/S5-worker-01.md,hard-gate-01.md}`.
- Existing package behavior, schemas, tests, compatibility, recovery, and release contracts remain authoritative unless this run explicitly adds a versioned opt-in surface.

## Global constraints

- Kernels remain the only run-transition authority; existing release transactions remain the only managed-tree publication authority.
- No ambient discovery, automatic approval, general DAG, blind UNKNOWN retry, second authority, or unsupported performance/token/provider claim.
- Prefer private/additive/versioned seams and existing primitives over new frameworks.
- Existing one-run/manual, legacy history, Workfront, deployment, install, and rollback behavior must remain supported.
- Each phase captures its own frozen comparison baseline, implements the smallest coherent release, proves recovery/fault behavior, self-reviews, and ends at a hard write barrier.
- Direction 3's writer may ship only if its representative paired corpus demonstrates bounded-prefix value and all semantic/recovery/fault parity gates pass; otherwise retain only safe reader/oracle work and record the value gate as not met.
- No production install/deploy/push occurs before the integrated final gate and explicit release authority applicable at that time.

## Phases and dependencies

### P1 — explicit multi-run fleet coordinator

Implement F1-A through F1-E as one coherent additive release: versioned explicit manifest, CAS lease/round-robin turn, cross-run claim revalidation, lifecycle delegation, restart/fairness hardening, private route/docs/tests. No scheduler daemon or discovery.

Named adversarial risk: competing coordinators could duplicate work or create a second authority. After the implementer settles, run one independent Luna/xhigh adversarial pass focused on lease loss, stale roots, conflicts, UNKNOWN, crash convergence, and kernel-authority preservation.

Gate: contract/bytes frozen, focused+full checks green, parent inspects coordinator/authority seam and a bounded concurrency/fault sample. P2 cannot start before PASS.

### P2 — digest-bound decision inbox and exact promotion

Implement I2-A through I2-E: projection-only inbox/redaction, deterministic selected-run listing, exact rebound `PARENT_DECISION` submission, explicit predecessor/successor handoff, crash/retry proof. Inbox and promotion remain separately controllable; no auto-approval/DAG.

Named adversarial risk: stale/replayed bindings or promotion races could consume the wrong token or bypass a gate. After implementation, one independent Luna/xhigh pass attacks token consumption, digest/epoch drift, concurrent submit, pre-PASS promotion, live-old-work, and retry identity.

Gate: mutation-free inbox, invalid bindings non-consuming, exact replay, promotion gated by explicit parent proof, existing Workfront/cross-phase behavior unchanged, focused+full checks green. P3 cannot start before PASS.

### P3 — incremental bounded-prefix segmented history

Implement H3-A through H3-E reader-first: v2 format/crash protocol, legacy/v1/v2 oracle, opt-in suffix writer, migration/retention/rollback, representative paired value corpus. Preserve complete logical replay and never prune on ordinary append.

Named adversarial risk: digest/range, seal/publication, migration, or GC faults could expose mixed history or delete recovery evidence. After implementation, one independent Luna/xhigh pass attacks tamper, gaps/overlaps, stale fences, every publication boundary, rollback, retention, and Memory/File parity.

Gate: semantic/recovery/fault parity mandatory. Writer enablement additionally requires the roadmap's value evidence; no gain claim is assumed. P4 cannot start before PASS or an explicit parent decision to retain reader-only output after a truthful no-value result.

### P4 — resumable outer release-operation envelope

Implement O4-A through O4-E: v2 envelope/phase matrix, mutation-free status, resumable admission/revalidation, delegation to existing inner transaction, rollback/compatibility/fault proof. Outer status is derived and subordinate.

Named adversarial risk: outer/inner disagreement or stale ownership could corrupt release/rollback. After implementation, one independent Luna/xhigh pass attacks phase crashes, stale/tampered identities, owner liveness, concurrent release, legacy/exact paths, unowned-file preservation, and residue.

Gate: deterministic status, exact authority rebinding, outer/inner crash convergence, legacy bytes/contracts preserved, focused+full/release checks green.

### P5 — integrated certification and release preparation

One Luna/xhigh integration owner audits all maintained affected surfaces, runs the authoritative complete package/deploy/check matrix once on the final state, verifies docs/migrations/rollback and produces a release candidate/evidence bundle. Use Sol/high only if a named cross-phase architecture/acceptance contradiction requires consequential adjudication.

Final parent gate judges the entire user goal, simplicity, compatibility, recovery, and claim discipline. Publication/install/push remains a separate final action governed by current explicit authority.

## Verification ownership

- Implementers own terminal focused and full verification after their last change.
- Each phase's one adversary attacks only its named high-cost risk and verifies repairs/impacted surfaces.
- No routine gate scout; use one only if multiple interacting writers or conflicting reports make parent compression necessary.
- Parent phase gates inspect exact diff/symbol slices plus one bounded acceptance sample, not a duplicate full matrix.
- P5 owns the single final broad integration/release matrix.

## Rollback strategy

Keep every direction additive/versioned and phase-separable. Record a clean phase boundary after each PASS. Rollback disables the new route/format/envelope or reverts that phase while retaining prior authoritative generations/transactions. Never edit durable evidence to simulate rollback.
