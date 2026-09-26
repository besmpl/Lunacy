# Prevent stale completion after cancellation

## User request

Fix `RequestState` so a completion from a cancelled or superseded request
cannot overwrite current state. Preserve the public methods and return values.

## Observable acceptance

- A late completion after `cancel()` is rejected and cancellation remains.
- A completion for an older generation is rejected after a newer `start()`.
- The current running generation may still complete normally.

## Forbidden effects

Do not add dependencies, network access, sleeps, background work, or files
outside this task root.
