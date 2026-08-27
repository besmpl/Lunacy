# Frozen local benchmark

`manifest.json` is a preregistered, canonical fixture. Its aggregate
`fixtureDigest` covers the plan and ordered events; `bench/run.mjs` refuses to
run if that digest does not match. Run:

```sh
npm run benchmark
# or: npm run build && node bench/run.mjs --out bench-output.json
```

The output is a local measurement envelope containing exact acceleration
counters, committed `.kernel` bytes, serialized yield bytes, and `wallNs` for
the current process. `OFF` is compared with isolated `SHADOW` execution for
semantic parity. The harness has no provider, token, or native capability and
makes no speedup/promotion claim. Wall time is environmental and is not a
reproducible fixture value.

The native Workfront M3 paired fixture is run separately with:

```sh
npm run build && node bench/workfront-paired.mjs
```

It replays deterministic small/wide/deep checkpoints plus a 500-step boundary
case, records exact baseline versus capsule input bytes and dependency facts,
and verifies cold/warm capsule parity. A local gate requires both cold and warm
p95 inspection latency to remain at or below 50 ms. The gate catches local
algorithm or I/O regressions; it is not a provider-performance claim and does
not change the runtime default. Provider, token, and native host counters
remain unavailable, so the overall result stays `NOT_CLAIMED` until the
required paired evidence is supplied.
