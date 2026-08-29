# Explicit fleet coordinator (private)

`src/fleet-coordinator.ts` provides an opt-in, one-turn coordinator for a
caller-supplied `lunacy-fleet/v1` manifest. Every entry names an absolute
`runRoot`, `runId`, canonical plan, and canonical claim digest. The coordinator
uses a versioned metadata file (`FLEET.STATE.json` by default), a CAS-style
owner/epoch lease, and deterministic round-robin cursor.

The coordinator never discovers roots, creates approvals, or commits run state.
Immediately before a turn it rebinds the root identity and verified kernel
state, checks explicit cross-run claim conflicts, and delegates exactly one
`resumeRun` call. Queue/lease/status records are advisory projections; the
kernel remains the transition authority. `UNKNOWN`, parent boundaries, stale
roots, lease loss, and conflicts are returned as bounded attention results and
are not relaunched by this route.

The route is private/additive. Existing one-run/manual commands are unchanged.
The CLI accepts `--fleet-manifest PATH` and optional `--fleet-state PATH`; the
manifest itself must be canonical JSON and include `schema` `lunacy-fleet/v1`,
`version` `1`, and a non-empty explicit `entries` array.

Coordinator metadata is read through a bounded (1 MiB), no-follow regular-file
boundary; oversized, symlinked, or malformed state returns `StateMalformed`
attention. An entry supplies either a closed host policy or an in-process
driver, never both. Lease expiry is fail-closed before lifecycle delegation,
and arbitrary error text is omitted from returned attention details.
