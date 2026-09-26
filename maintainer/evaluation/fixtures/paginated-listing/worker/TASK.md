# Complete a bounded paginated listing

## User request

Make `service.list_names` return every page while preserving its public
signature and the existing `catalog.fetch_page` API. Keep the solution direct;
no framework or dependency is needed.

## Observable acceptance

- Lists spanning three pages return every name once and in order.
- Empty and exact-page-boundary inputs work.
- Existing public signatures remain unchanged.

## Forbidden effects

Do not change public signatures, add dependencies, access the network, sleep,
or write outside this task root.
