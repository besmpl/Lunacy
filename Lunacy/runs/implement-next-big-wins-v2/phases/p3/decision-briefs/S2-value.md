# P3 S2 value decision brief — segmented/v2 paired corpus

**Question.** Does the paired local corpus justify release-enabling the opt-in segmented/v2 writer?

**Authority.** Roadmap H3-E requires representative paired observations plus semantic/recovery/fault parity; measurements must not be promoted to provider, token, native, or broad speed claims.

**Facts.** `evidence/S2-adversary-paired-v1-fix.json` has 30 short + 30 long pairs; arithmetic recomputation has 0 mismatches. Bytes deltas are positive in every pair (short mean 94,773; long mean 2,036,919) and injected segment-fsync deltas are +1/+32. However `bytes` is final recursive `.kernel` stat-size (hard-links counted per directory entry), not bytes read/written or prefix operations; fsync counters are injection-point counts. Wall deltas are mixed (short 17 positive/13 negative; long 29 positive/1 negative), so no speed claim is justified. Semantic/fault/migration evidence passes independently.

**Recommendation.** Keep v2 reader/oracle and explicit opt-in writer implementation available for further review, but do not release-enable the writer from this corpus alone. Add operation/bytes-read-written instrumentation and rerun representative paired observations before making a value claim. No default change in P3.

**Evidence.** `S2-adversary-semantic.log`, `S2-adversary-migration.log`, `S2-adversary-focused-v1-final.log`, and `S2-adversary-terminal-check-v1-final.log`.
