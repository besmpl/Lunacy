# Direct admission and legacy acceleration input

The package has one public lifecycle operation, `RunKernel.advance(input)`.
The validated plan, reducer journal order, artifact-store generation, and
outbox transitions are the only admission and publication authority.

Older hosts may still pass graph, context, or reuse fields inside
`KernelOptions.acceleration`. These fields are tolerated as cold legacy
decoration and are ignored: they do not prepare candidates, change ordering,
create effects, write compatibility artifacts, or add lifecycle methods.
`AccelerationMetrics` remains an in-process diagnostic sink for managed
rollout counters only; it is not durable authority and is lost on restart.

No migration is needed for the removed private accelerators because they did
not own durable state. Existing journals and generations continue through the
same direct reducer/store reader, and rollback uses the preceding runtime
without any new artifact shape.
