# P3 Hard Gate 01 — bounded-prefix segmented history

## Verdict: PASS with reader/oracle release and no writer enablement/value claim

P3 correctness, compatibility, recovery, and fault gates pass. The measurement value gate does not authorize default/managed v2 writer selection or a performance/value claim.

## Evidence accepted

- Reader-first `segmented/v2` reconstructs the complete authenticated logical journal from exact journal-free state + head + prefix/suffix segments before exposing state.
- Opt-in writer/seal, migration, rollback, retention/GC, Memory/File parity, and nine publication fault points were implemented and exercised; ordinary append cannot prune the verified prefix.
- Adversarial work found and repaired v2 read-only/reuse rebinding, source-link races, exact GC projection, migration marker validation, explicit-format migration, v1→v2 prefix pruning, recovery-forensics v2 budget reporting, and the same pre-existing hard-link race in maintained v1 writes.
- Final adversarial terminal state: focused P3/R2/recovery 33/33 PASS; `npm run check` 473 tests = 471 pass, 0 fail, 2 platform skips; typecheck/build/pack PASS.
- Parent inspected the reader/write/rebind seams and final explicit migration repair, then sampled explicit migration, publication-fault convergence, and managed-default guard (3/3) plus typecheck (PASS).

## Explicit value disposition

The 30 short + 30 long corpus is internally consistent, but its byte metric is recursive namespace stat-size rather than bytes read/written/prefix operations, its fsync metric is injection-point count, and wall samples are mixed. Therefore:

- no speed, byte-I/O, fsync, token, provider, native, or generalized value claim is authorized;
- no existing default or managed route may select v2 writes;
- the safe reader/oracle ships; the writer remains private explicit experimental opt-in for further local evidence only;
- future enablement requires actual operation/bytes-read-written instrumentation plus a new decision/gate.

The P3 write barrier is closed. Any later P3-owned source/test/bench/doc change invalidates this gate and requires a new numbered gate.
