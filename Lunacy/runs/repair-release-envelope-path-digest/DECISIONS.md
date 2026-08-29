# Decisions

- Treat the live fresh-envelope `ReferenceError` as a release blocker; do not bypass `--release-envelope` or weaken the production manifest boundary.
- Use the smallest root-cause scope repair and add regression proof through the concrete CLI path that the prior suite missed.
- No production retry until the worker's terminal verification and parent gate pass.
