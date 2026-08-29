# Digest-bound decision inbox

The private `decision-inbox` module exposes two independent, explicit
operations:

* `listDecisionInbox({ entries })` reads only caller-selected run roots. It
  returns deterministic, redacted `lunacy-decision-inbox/v1` rows. The rows are
  projections; they never create, consume, or approve a kernel token.
* `submitParentDecision(...)` rebinds the selected row to the current
  generation, revision, epochs, plan digest, and token identity before calling
  `RunKernel.advance` once with a canonical `PARENT_DECISION`. Invalid or stale
  rows return closed attention without mutation. A retry with the same event
  identity is an exact kernel replay.

`promotePhase({ handoff })` is a separate explicit operation. The
`lunacy-phase-handoff/v1` envelope names one predecessor and one successor and
contains a parent-authored authorization digest. Promotion requires the
predecessor's current `COMPLETE`/`PASS` state, exact proof and plan/phase
digests, and no active/pending/claimed/unknown work. Only then does it invoke
`initRun` for the explicitly named successor. There is no discovery, queue,
automatic approval, or general DAG.

The bridge CLI provides private additive routes:

```text
lunacy-bridge inbox --entries ENTRIES.json
lunacy-bridge submit-decision --inbox INBOX.json --plan PLAN.json --run-root RUN --run-id ID --token TOKEN --value PASS|FINDINGS
lunacy-bridge promote-phase --handoff HANDOFF.json
```

Authority-adoption tokens may supply the canonical inline JSON value
`{"kind":"ADOPT","digest":"..."}`; the kernel still validates the
raw/normalized plan digest fence before consuming that token.

These routes do not alter existing Workfront, lifecycle, one-event, or manual
parent-decision output. Disablement simply stops using the routes; kernel
generations, token maps, plans, and phase files remain untouched.
