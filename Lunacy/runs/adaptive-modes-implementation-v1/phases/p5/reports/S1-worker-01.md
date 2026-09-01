# P5 S1 Worker 01 — Integrated Disabled Candidate

## Control Block
- Status: **PASS**
- Scope: P5 S1 release-floor census, candidate publication fence, integrated proof.
- Final code: `src/release-admission.ts`, `src/release-quiescence.ts`, `tools/deploy-skill.mjs`.
- New proof: `test/p5-release-generation-census.test.js` (3/3 PASS).
- Floor: built `ONE_SHOT_ROLLOUT_GENERATION_FLOOR` is exactly 22; hermetic retained maximum is 21.
- Focused matrix: 92 tests, 91 pass, 0 fail, 1 existing provider skip.
- Broad gate: 711 tests, 707 pass, 0 fail, 4 existing platform/provider skips.
- Package: 155 files, 592.5 kB packed / 2.9 MB unpacked.
- Disposable deploy/check parity: source `2be4b1db…3092c2`, managed aggregate `b35ad4cd…59d6f` on both runs.
- Boundary: no live install/activation, real-run mutation, commit, or push.

## Implementation
- Reused the existing manifest discovery parents/run roots and added one closed rediscovery seam; no new lock, controller, ledger, schema, epoch, or public mode API.
- Added a read-only in-fence census after quiescence. It classifies Direct, managed-without-rollout, and managed-rollout roots; inventories every durable rollout projection; and refuses any generation `>= 22`.
- Census rows bind root inode, store generation, exact state digest, metadata digest, and rollout generations. Unreadable, omitted, aliased, replaced, or changed roots fail closed.
- Deployment holds the existing release/target/bridge/writer claims from quiescence through publication, repeats closed discovery and the exact census after stage verification, and invokes that fence immediately before the first atomic runtime rename.
- Both ordinary candidate deploy and the exact predecessor candidate path use the same optional pre-publication callback; check and rollback retain their prior behavior.

## Verification
- `npm run typecheck` — PASS; `npm run build` — PASS.
- Roadmap §11 exact focused command — PASS (92/91/0/1); log `/tmp/lunacy-p5-focused.log`.
- Isolated-child R2 crash lattice — PASS on Memory and File stores; also exercised in the broad gate.
- Release/restart/restore package — PASS 51/51: census, R2 lifecycle/lattice, resolver, release exclusion/envelope, exact predecessor, and R5-B restore/recovery.
- `npm run check` — PASS (711/707/0/4), including typecheck, full tests, build, and pack; log `/tmp/lunacy-p5-check.log`.
- Separate `npm pack --dry-run` — PASS; log `/tmp/lunacy-p5-pack.log`.
- Skill quick validation — `Skill is valid!`; log `/tmp/lunacy-p5-quick-validate.log` (`CODEX_HOME` resolved to `$HOME/.codex` because it was unset).
- Disposable `deploy-skill --target "$TARGET"` then `--check` — PASS with identical source/aggregate and 209 managed files; logs `/tmp/lunacy-p5-deploy{,-check}.log`; target removed afterward.

## Integrated Definition of Done
- AUTO/Direct/explicit Explore, exact one-time production resolver, and exact Explore authorization: focused resolver/operator/product tests PASS.
- Direct bytes/Yields/state/restart remain identical with zero managed artifacts/calls: adaptive compatibility and installed Direct tests PASS.
- Focus is exact 2+1 / 3 calls; Explore exact 5+1+3 / 9 calls / 30 ideas; width does not leak into ordinary capacity: deliberation and rollout matrices PASS.
- COMPLETE_PLAN preserves managed provenance and routes the next real ordinary command to `gpt-5.6-sol` / `high`: post-Plan routing fixture PASS.
- Restart/stale output/UNKNOWN custody, no retry/successor, and replay-stable terminal ambiguity: isolated crash lattice and one-shot lifecycle PASS.
- Historical Wave/Report/WIDEN/D4 readers remain migration-free while current writers stay exact: adaptive, L3a, and L3b matrices PASS.
- Gate/repair/resume/completion/rollout produce zero new Waves; advisory context does not enter ordinary implementation prompts: holistic/provenance/rollout tests PASS.
- Generation-21 supported roots pass; generation 22, unreadable state, omitted roots, and changed census digests refuse before publication.
- Disabled restart/replay and newer-disabled/kill-switch rollback policy were rehearsed hermetically; R5-B package rollback preserves evidence and converges without live state.
- Source/package/installed private surfaces and capability attestation agree; package-root exports remain closed.

## Remaining Risk
- Live canary/activation was intentionally not exercised because authority prohibited touching the installed skill or real runs; the verified existing kill/disabled corridor is the only permitted next boundary.
