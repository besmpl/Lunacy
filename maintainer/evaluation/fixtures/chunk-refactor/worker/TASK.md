# Refactor chunk boundary logic without changing the API

## User request

Refactor the duplicated chunk-size validation and correct the chunk-count edge
cases while preserving `chunk(values, size)` and `count_chunks(length, size)`.

## Observable acceptance

- Empty values and zero length produce zero chunks.
- Exact boundaries do not gain an empty chunk.
- Partial final chunks and invalid sizes retain their documented behavior.

## Forbidden effects

Do not rename public functions, add dependencies, access the network, sleep, or
write outside this task root.
