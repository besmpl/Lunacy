# Bounded native run recipe (manual, no launcher)

1. Choose one fixture and copy only its `worker/` packet with
   `maintainer.evaluation_pack materialize` into a new owned disposable root.
   For a dirty-state trial, first record the exact existing bytes and prepare a
   separate owned workspace without replacing or resetting them. The
   `dirty-sentinel` fixture is a deterministic preservation control, not native
   isolation proof.
2. Fill one copy of `manifest-template.json` before dispatch: exact source and
   candidate plugin/content identities, literal parent/worker model and effort
   routes (plus any explicit override), context mode,
   allowed operations, fixed check ID, and positive finite budget values. Also
   declare comparison cohort, workload, baseline and acceptance identity, cache
   condition, requested total width, root-inclusive count convention, flat or
   logical-team topology, workspace strategy, and relevant host/resource limits.
   Record a measured pre-run CPU/memory/test-load baseline where available.
   Unknown counters remain `null`; never estimate them.
3. Use the existing authorized native agent tool directly. This recipe does not
   dispatch, route, poll, retry, or scan conversations. Give the worker only the
   materialized packet and its project rules. Packet separation is not access
   control on a shared filesystem: blind evaluation needs a separately restricted
   environment or evaluator source withheld by the operator. Otherwise record
   evaluator access as uncontrolled.
4. Manually observe the predeclared wall-clock, turn, tool-call, and output-byte
   bounds; this runner enforces only its evaluator-child deadline. Keep any
   unavailable observed counter `null`. Record the actual returned handle and
   receipts selected for this run only. Distinguish requested width, effective
   supported capacity, peak active agents and peak open agents; record how the
   host counts root, children and descendants. A child followed by another
   below capacity does **not** demonstrate slot reuse: retain an observed
   occupancy/free-slot transition or a separately authorized capacity-boundary
   probe as evidence. Without it, slot reuse stays unknown.
   A missing/ambiguous return remains UNKNOWN/OPEN and is not replay authority.
5. After the worker and effects settle, run the fixed local evaluator with the
   candidate path. Record its actual exit/result; do not execute a command taken
   from the manifest or candidate output.
6. Record failure and cancellation events, unresolved effects and actual
   resource contention, including runs that never reached the evaluator.
   Preserve failed, incomplete, timed-out, and forbidden-effect runs. Do not
   infer model obedience, custody, or global reliability from fixture success.

For a separately authorized width comparison, use matched source baseline,
acceptance criteria, workload and cache condition for 8/16 coordination then
32/64 scale trials. Include both independent and coupled work; ensure enough
real tasks to occupy the requested width. Include all failed and cancelled
trials, and report actual occupancy, time to accepted outcome, criterion pass
rate, defects, rework, integration delay and parent decision/review load. Keep
unobserved metrics `null`; do not turn a single feasibility run into a speedup
claim. Set tolerable latency/quality margins before comparing.

Packaging is a later gate: build the accepted source into fresh native and
standalone staging destinations, compare canonical policy/receipts and links,
then use the supported plugin update path under separate authority. Do not edit
installed cache or enable duplicate copies. Preserve the prior package and
host setting for rollback; a build is not installation, and installation is not
proof that a live session loaded the candidate or its effective capacity.

The evaluator child deadline limits waiting; it provides no hostile-code
isolation. Use a disposable local account/container if stronger confinement is
required by the candidate's trust level.

For opportunity discovery, use the separate
[`fixtures/opportunity-discovery/`](fixtures/opportunity-discovery/README.md)
manual comparison protocol. Its worker packets intentionally omit a ready
queue; the supplied-queue arm is diagnostic only. The synthetic provisional
annotations and any unblinded condition cannot establish discovery recall or
real-world speedup. This recipe does not dispatch those packets automatically.
