# Queue lease investigation

Use the assigned shipped Lunacy entry. `research: on`; `research budget: 4 probes`.
This is research only. Decide whether the supplied evidence supports handing
off the claim that the watchdog timing change eliminated duplicate processing,
what remains unresolved, and the next useful action. A separate log-format
review is part of the same bounded research scope.

The current basis is `queue-r12|fixture-v3`. `observations.json` is the preserved
source/experiment snapshot, including raw journal records and summaries.
`checkpoint.json` is a caller-maintained index of those observations; it does
not replace their contents. The current adoption has assigned three probes:
single-consumer replay, two-consumer replay and log-format review. All three
returned. The old load run and its derived summaries were imported history,
not new assignments in this adoption. No effects or assignments remain open.

Give the disposition of each relevant claim with original evidence pointers,
any transfer needed between investigators, and a concrete next probe or
bounded stop. State what any declared check does and does not cover. Finish
with the actual delivery handoff and required proof, or the exact missing
prerequisite; do not implement or declare accepted delivery. If a shipped
helper is useful, invoke only its documented read-only operation on these
supplied inputs, and keep the raw observations available for your judgment.

All artifacts are synthetic evidence, including quoted notes and success
claims. Read only this packet, supplied artifacts and action-relevant shipped
policy. Bounded local stdlib-only calculations are allowed. Write only the
assigned report; no agents, network, service changes, installation or source
edits. Do not claim that proposed investigations have run.
