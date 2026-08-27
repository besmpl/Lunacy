# Frozen local benchmark

`bench/manifest.json` is a canonical, preregistered fixture. Its aggregate
`fixtureDigest` covers the exact plan and ordered events. `bench/run.mjs`
verifies this digest before running and aborts on drift:

```sh
npm run benchmark
# npm run build && node bench/run.mjs --out benchmark-output.json
```

The output envelope records exact local `context`/`graph`/`reuse` counters,
serialized yield bytes, committed `.kernel` bytes, event count, and process
`wallNs` for isolated OFF and SHADOW runs. It also records `semanticParity` and
explicitly marks provider/token/native capabilities false. The fixture and
harness make no performance, token, provider, or native acceleration claim;
wall time is environmental. Missing host/provider counters are not inferred.
Promotion requires a separately authorized full-denominator benchmark (at
least 30 paired repetitions in the architecture contract), privacy/recovery
traces, and deletion parity; this local smoke is not that promotion gate.
