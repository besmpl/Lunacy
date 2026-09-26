---
name: lunacy
description: Orchestrate genuinely new authorized tasks through parent decisions and acceptance with coherent native workers. Explicit selection is required; never take over existing, managed, or provenance-uncertain work.
---

# Lunacy native workflow

<a id="ordinary-path"></a>
## Ordinary delivery at a glance

Confirm current authority/scope. For small/coupled work, seal one coherent
owner and exact route in a combined assignment. For large independent work,
use [ready-work policy](orchestrator/PLANNING.md#ready-work-parallel-delivery)
and the [native dispatch recipe](#native-dispatch-recipe). Root dispatches;
wait boundedly, inspect results/effects, and accept only after custody settles.
Avoid extra plan/state/gate records.

[dispatch mode](orchestrator/PLANNING.md#dispatch-modes-and-wave-protocol):
super-parallel/22; normal/limit overrides.

<a id="native-dispatch-recipe"></a>
### Native dispatch recipe

1. **Prepare all packets.** On adoption/readiness change, seal complete packets
   for the whole independent group before first spawn: scope/acceptance,
   route/context/report, inputs/baseline, dependencies/revision,
   effects/integration. One owner per effect; keep coupled work together.
2. **Size.** Use `max(0, min(remaining task cap, host room, model/resources))`;
   choose largest safe set. Default cap 22; lower cap sizes waves, not work.
3. **Launch/record.** Call `agents.spawn_agent` consecutively, with no
   planning/polls/waits/other calls between. Calls are sequential; workers may
   overlap; no batch API/scheduler. Inspect each return; record actual
   handles/uncertainty in `TASK` after the wave or at an interruption boundary.
   Authority/route/capacity/effect changes stop affected launches; never replay
   unknown.
4. **Refill/wait.** At initial dispatch, real completion/blocker/decision,
   changed check/integration or authority/interface/capacity/resource/custody
   event, or due recovery, inspect once; settle cancellation/unsafe effects and
   prerequisites; recompute. Prepare complete next packets; use safe room
   before waiting, even while unrelated children run. Task-wide cancellation
   stops refill. Before waiting, do one bounded sweep; wait only on a live handle
   if no useful safe launch is ready. Never poll healthy workers or rescan
   unchanged evidence.

Apply these invariants immediately:

<a id="supported-scope-and-capability-ceilings"></a>
<a id="entry-and-reciprocal-selection"></a>
- A task-directed invocation selects Lunacy for genuinely new work, including
  non-engineering tasks, with current authority; selection alone does not
  authorize deletion or other effects. Existing/managed/provenance-uncertain
  work keeps its owner/contract.
- One owner controls each surface/effect. Unknown effects forbid replay,
  replacement, release, or acceptance. Settle known effects only through
  observed completion or authorized wait, cancellation, or cleanup; timeout,
  missing records, terminal prose, or dirty tree proves no release.
- Seal model/effort/purpose/transport before dispatch. `bulk`/`judgment` default
  to `gpt-6-luna` / `max`. Only a clear affirmative task-local request such as
  `use Sol medium` may bind suitable `judgment`; quoted, negated, hypothetical,
  or incidental mentions do not. See [exact native
  routing](orchestrator/PLANNING.md#exact-native-routing); never infer/probe/
  substitute/fall back/rebind live work.
- Worker owns delivery, verification, pre-FINAL repair/report/logs; parent owns
  approach, decisions, `TASK.md`, coordination, and independent acceptance.
  Post-FINAL substantive repair requires settled effects and a new
  assignment/report; history stays frozen.
- Explicit [Golden](orchestrator/IMPROVEMENT.md#golden-cycle) is unchanged;
  never silently downgrade it to ordinary delivery.

## Before-action reads

Read current authority and mutable `TASK.md` coordination on boundary changes.
Read only action-relevant detail. Missing records decide nothing; ambiguous
resumes require the existing contract.

<a id="ordinary-progressive-reads"></a>
### Ordinary trigger table

<a id="compact-examples"></a>
| Trigger | Read next |
| --- | --- |
| One-owner adoption/dispatch | [authority](WORKSPACE.md#authority-entry-and-coexistence), [TASK](orchestrator/PLANNING.md#compact-task-form), [contract](WORKSPACE.md#the-uniform-record-contract), [routing](orchestrator/PLANNING.md#exact-native-routing) |
| Parallel parent or logical-team coordination | [ready-work policy](orchestrator/PLANNING.md#ready-work-parallel-delivery), [records](WORKSPACE.md#the-uniform-record-contract); [recovery](orchestrator/PLANNING.md#recovery-and-anti-stall) |
| Worker implementation/report | Current assignment and project rules, then [worker delivery](worker/ENGINEERING.md) and [report contract](WORKSPACE.md#worker-updates-and-immutable-report); code-specific guidance applies to code work |
| Parent acceptance/evidence gap | [acceptance](orchestrator/PLANNING.md#acceptance-and-barrier), [barrier](WORKSPACE.md#ownership-barrier-and-acceptance), affected checks; dispatch links only for assignment/effect/custody gaps |
| Pre-FINAL defect | [repair](worker/ENGINEERING.md#coherent-implementation-and-repair); keep current owner |
| Post-FINAL defect | [handoff](orchestrator/PLANNING.md#compact-post-final-repair-handoff) after effects settle |
| Overlap, unknown authority/effects, deadline, recovery | [coexistence](WORKSPACE.md#authority-entry-and-coexistence), [barrier](WORKSPACE.md#ownership-barrier-and-acceptance), [deadline](orchestrator/PLANNING.md#adopted-deadlines-and-finalization), [recovery](orchestrator/PLANNING.md#recovery-and-anti-stall); stop only affected work |
| Adopted task deadline | [coexistence](WORKSPACE.md#authority-entry-and-coexistence), [barrier](WORKSPACE.md#ownership-barrier-and-acceptance), [deadline](orchestrator/PLANNING.md#adopted-deadlines-and-finalization) |
| Explicit worker customization | [models](orchestrator/WORKER-MODELS.md#two-roles-unchanged-defaults) |
| Explicit research swarm | [protocol](orchestrator/RESEARCH-SWARM.md) |
| Explicit Golden or usage comparison | [Golden](orchestrator/IMPROVEMENT.md#golden-cycle) or the [usage comparison](orchestrator/USAGE-METRICS.md#ordinary-overhead-comparison); neither is an ordinary prerequisite |

After compaction/boundary change, reread authority, `TASK.md` and anchors;
cached notes aren't authority.

## Capability ceiling

<a id="optional-captured-command-evidence-index"></a>
Optional [navigation](OPERATOR.md#optional-action-context-navigator) and [authorized POSIX runners](OPERATOR.md) aren't model
launchers, sandboxes, supervisors or authority resolvers. Capture proves neither
settled effects nor correctness. Indexing grants no replay/acceptance; commands
require authority.
