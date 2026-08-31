# Private recovery forensics

`lunacy-bridge inspect-recovery` is an opt-in, read-only inspection route for one
explicit run and launch token:

```sh
node dist/bridge-cli.js inspect-recovery \
  --run-root /absolute/run/root --run-id RUN \
  --launch-token TOKEN [--command-digest SHA256] [--policy POLICY.json]
```

The command emits one canonical `lunacy-recovery/v1` capsule. It verifies the
CURRENT generation through `ArtifactStore.loadReadOnly`, reports the bounded
legacy/segmented journal budget, exact outbox state and lease status, and
presence/binding of launch-intent, launch, and terminal records. Raw tokens,
lease IDs, paths, reports, worker output, credentials, and journal payloads are
not returned; identity and content digests are retained for proof.

The capsule enforces a 256-character ceiling on request, run, and phase
identities and rejects control characters with the stable `Recovery:` input
error. A step identity containing a path separator, control character, `.`,
`..`, or exceeding that ceiling is never emitted verbatim: `outbox.stepId`
contains the deterministic bounded form `sha256:<hex>`. Internal command and
report binding still uses the exact durable step key; deterministic report-path
derivation uses the same digest representation for unsafe step keys. The
inspector validates the complete nested capsule (including closed object keys,
enum values, digest patterns, and string ceilings) before returning it.

`--policy` is optional. When supplied, the closed host policy digest, run root,
run identity, and plan digest are checked in addition to the record bindings.
`--effects-root` may select an explicitly provisioned effects namespace under
the run root. Missing or malformed evidence is represented as a stable bounded
status rather than synthesized as a successful effect. `nextProof` is
informational only (for example, “observe exact launch token or obtain a human
receipt”); the route never dispatches, observes, acknowledges, repairs,
quarantines, projects, acquires locks, or writes a cache.

The API/CLI also accepts the parity spellings `kernelRoot`, `expectedRunId`, and
`token` (`--kernel-root`, `--expected-run-id`, `--token`). Supplying both
spellings with different values is rejected; selectors are never resolved by
precedence. The managed bridge package carries the private recovery modules
(and advertises the route from its generated README) in its signed deployment
inventory while keeping package-root exports unchanged.

Repeated calls against an unchanged run produce byte-identical canonical JSON.
The inspector rebinds CURRENT, the committed generation, and the complete
bounded effects namespace before returning. Any pointer, generation, effect,
or report mutation during inspection fails closed without cleanup or repair.
The existing one-event, drive, and Workfront routes and package-root exports are
unchanged.

## Adaptive deliberation boundary

Managed Focus/Explore uses the same recovery owner. A provider timeout,
cancellation, crash, or ambiguous entry is not durably `UNKNOWN` until the
owned process tree has exited, per-attempt scratch is removed, and teardown is
bound. Recovery never re-enters that epoch: the full reservation stays charged,
and late output is inert. Installed automatic D3 Focus does not retry or
replace that Wave: after valid teardown it returns the single parent decision
boundary. A separately user-explicit ADHD/Explore Wave remains available under
its own authority; it is never inferred as an automatic replacement. Missing
receipt, final transport, authority anchor, role/predecessor binding, or native
isolation proof blocks rather than promoting a partial Report set or falling
back to another route.

The capsule remains diagnostic and cannot repair or promote managed state.
Keep rollout disabled (or publish a strictly newer disabled generation) while
investigating and preserve the Wave, Reports, receipts, transport/teardown,
anchors, settlements, leases, and journal. See the [adaptive operator
contract](../orchestrator/DELIBERATION.md) for kill/revocation and the bounded
diagnostic counters.
