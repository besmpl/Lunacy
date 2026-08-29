# P3 S2 decision brief — legacy segmented/v1 hard-link race

**Question.** May the repaired segmented writer ship while legacy `segmented/v1` remains writable?

**Authority / proof.** Baseline `HEAD=9e77159` `src/store.ts:1939-1944` hard-links a prior segment after `injectFault('hard-link')`, then fsyncs and publishes the descriptor without re-reading or binding source identity. Reproducer: `evidence/S2-v1-hardlink-race.log` (same public `FileArtifactStore` path; no source edits). It mutates `g1/segment-00000001-00000002.ndjson` in the injection window; commit returns `ok`, `CURRENT` advances to `generation:2`, while the published descriptor remains 962 bytes/digest `7af76b…` and actual linked bytes are 13/digest `4c8fa7…`; restart `load()` rejects `ManifestMismatch: ... byte count mismatch`.

**Blast radius.** Any v1 append that reuses a sealed segment can publish an apparently successful but unrecoverable generation if an in-place writer/attacker changes the source between predecessor verification and `fs.link`; `CURRENT` then points at mixed history. This is a durability/integrity failure, not merely a benchmark concern. The race is pre-existing; v2 repair adds source identity + byte/digest rebinding but does not alter v1 behavior.

**Compatibility / options.** (A) Patch v1 with the same bound-source checks (small, behavior-preserving on healthy files; malformed/tampered source now fails closed). (B) Keep v1 writer enabled (not acceptable for integrity). (C) Disable/reader-only v1 until a separately authorized patch (safest immediate compatibility posture).

**Recommendation.** DECISION_REQUIRED: retain v1 read compatibility but do not release-enable its writer; authorize a focused parity patch and regressions before any v1 writer claim. Do not silently migrate or change public defaults in this phase.
