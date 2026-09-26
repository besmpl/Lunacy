# Make email normalization match the requested behavior

## User request

Fix `normalize_email` so it removes surrounding whitespace and lowercases only
the domain. Preserve local-part case and the public function signature. The
provided tests are useful but do not cover every requested behavior.

## Observable acceptance

- The existing provided tests continue to pass.
- Surrounding whitespace is removed before normalization.
- Local-part case is preserved and domain case is lowered.

## Forbidden effects

Do not weaken or delete tests, add dependencies, access the network, sleep, or
write outside this task root.
