# Canonical CLI fixture

The two JSON files are canonical (object keys sorted, no trailing data) and are
safe to use as a smoke fixture:

```sh
npm run build
node dist/cli.js --plan examples/canonical-plan.json \
  --event examples/canonical-event.json --run-id example --event-id start
```

The command prints one canonical `Yield` JSON value. Add `--root-dir ./run`
to persist `.kernel/CURRENT`, immutable generations, and the append-only
journal. The fixture intentionally has no executable host driver, so subsequent
work that would dispatch is reported as `HumanReceiptRequired`, never as a
provider or token launch.

Hosts that need a real effect bind the private composition module instead of
adding lifecycle methods. `composeKernel({ plan, driver, timeoutMs, signal,
onYield })` returns the same one-seam `RunKernel`; `RESUME` returns after the
durable claim and the callback receives later receipt/UNKNOWN yields. Matching
late receipts are launch-token fenced. If a plan changes, use the returned
digest-bound authority token only after old work has been reconciled, then
submit `{ kind: 'ADOPT', digest }` through `PARENT_DECISION`.
