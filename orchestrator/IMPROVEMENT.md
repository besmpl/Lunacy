# Golden workflow and optional continuous improvement

Use this workflow when the user explicitly selects Lunacy Golden for a genuinely new engineering outcome, or when current user/project authority expressly includes ongoing plugin improvement. A finite task needs a clear authorized outcome, not an invented big-win justification, and ends when that outcome is complete. Ongoing improvement additionally requires a viable material big win; if none exists, idle. This is an operating policy, not a new contract, scheduler, automatic router, performance claim, or permission to continue forever. Ordinary fixes with a known root cause go directly through the normal delivery path.

GPT-6 Astra/high is the recommended parent setting for this mode, but guidance cannot select or attest the host model and the recommendation is neither enforced nor proven best. Current host/user authority must select the actual parent.

All [authority and record rules](../WORKSPACE.md#authority-entry-and-coexistence), [exact native routing](PLANNING.md#exact-native-routing), recovery, evidence, and parent-only acceptance remain controlling. A roadmap organizes authorized work; it grants no implementation, external effect, publication, deployment, or release authority. Source-ready is not permission to ship.

## Slow strategy, fast delivery

1. **Frame the outcome.** Astra states the user-visible outcome, constraints and non-goals, preserved behavior, allowed effects, decisive acceptance evidence, and separate release authority. For ongoing improvement, require a substantial expected gain tied to a real bottleneck, defect, or simplification, and state how acceptance evidence will verify that gain. Compare the gain with the added total complexity; prefer deleting obsolete machinery or reusing existing code and platform capabilities over adding a new mechanism. Prefer actual defects, user feedback, failed contracts, or changed constraints over speculative novelty.
2. **Use strategy only for a consequential unsettled choice.** A genuine broad design fork may use ADHD first. Known alternatives may go directly to the selected adviser. A decisive local check may settle the choice without either. Unchanged applicable evidence reuses the existing decision; material contradictory evidence reopens only the affected choice.
3. **Adopt an executable roadmap.** Astra records the chosen design and coherent ready slices in the existing parent-owned `TASK.md` using the [Compact TASK form](PLANNING.md#compact-task-form). Each slice identifies concrete implementation steps, observable completion, preserved behavior, design/interfaces, ownership and dependencies, literal model/effort and context, checks and acceptance evidence, stop/recovery limits, permitted effects, and any separately authorized release actor/action. Fully specify every included implementation slice when adopting its outcome. Genuinely unselected future options outside that adopted outcome may retain only the detail needed to expose dependencies and revisit conditions, unless the user requests more; selecting such an option or materially changing an adopted design requires a new immutable adoption before affected execution.
4. **Deliver the next ready slice.** Normally one worker owns inspection, implementation, tests, self-review, ordinary repair, and its immutable report. Use up to four implementation owners only for non-overlapping writes and independently safe effects with explicit dependencies and integration order. Use the task-selected `bulk` role for bounded, decisively checkable work and `judgment` role for difficult implementation, diagnosis, or discriminating test design. Their defaults remain Luna/max and Sol/medium; [launch-time worker selections](WORKER-MODELS.md) may replace either role for this task. Sol/high remains explicit-only. Worker-role overrides do not change the parent, ADHD agents, or separately selected consultation route. Refuse an unsupported or conflicting pair before dispatch; never substitute, infer, probe, or fall back.
5. **Accept before advancing.** A worker's green report is self-review, not acceptance. Astra independently inspects the actual result, diff, integration, and applicable evidence under [Acceptance and barrier](PLANNING.md#acceptance-and-barrier). Reuse completed proof only while its artifact, dependencies, configuration, environment, scope, and requirement assumptions remain unchanged.
6. **Continue from evidence.** After acceptance and any separately authorized shipping, observe actual results. Advance directly to the next authorized ready slice while the design remains valid. Reopen only a choice invalidated by material evidence. Stop when the authorized outcome is complete; continuous means successive authorized improvements, not endless research or implementation.

## Conditional strategy tools

### ADHD for a real design fork

When Golden is invoked, check the skills currently advertised or available to the task. If ADHD is unavailable, suggest once for the task that the user install or enable it. Describe it as known uninstalled only when current evidence proves that state; otherwise call it unavailable and distinguish disabled or not-loaded possibilities from a known missing installation. Do not repeat the suggestion, auto-install, guess a source, URL, command, or plugin ID, or delay otherwise-ready work. If the user requests installation, use a supported installation flow only after the actual source is known. If ADHD is available, make no installation suggestion. This notice does not make ADHD mandatory, change the required-ideation boundary, or turn a missing exact route for an available ADHD skill into an installation problem.

When ADHD is selected, read and follow the available ADHD skill's actual procedure; this summary does not implement or replace that skill. The recommended default is five fresh isolated `gpt-5.6-sol`/`medium` generators producing six ideas each, followed by Astra scoring, clustering, and trap removal, then three fresh isolated Sol/medium deepeners for the leading distinct options. These proposal-only agents do not edit code or `TASK.md`; the implementation-owner limit does not apply to them. This is a conditional starting policy, not mandatory attendance or proof of superiority. If the ADHD capability or its exact authorized route is unavailable, do not silently replace it; use already sufficient independent evidence or pause the affected unresolved choice.

<a id="direct-exact-web-pro-advice"></a>
### Consultation selection and bounded advice

Consult only for a consequential unresolved decision; use existing applicable
advice or a decisive local check first. Task-local choices are:

- `pro` (default): exact `chatgpt-web/pro` / `ultra` through direct
  `codex exec -m chatgpt-web/pro -c 'model_reasoning_effort="ultra"'`, not Oracle
  or browser control.
- `astra-high`: exact `gpt-6-astra` / `high` through a fresh native agent whose
  supplied schema supports both literals; never override a fixed role.
- Explicit `auto`: prefer Pro; select Astra/high only if Pro is already known
  unavailable **before binding and dispatch**, citing current route-specific
  evidence. Generic quota buckets, missing controls and error text do not
  establish that fact; do not launch an availability probe. A user instruction
  to use Astra is direct selection, not measured quota. If availability is
  unknown, retain Pro preference or skip optional advice when evidence suffices.

Resolve to one literal pair before the existing immutable adoption/assignment.
Shared [routing and custody rules](PLANNING.md#exact-native-routing) govern
fresh context, changed sealed assignments and unknown effects; selection changes
neither parent, ADHD nor workers. **No post-start automatic failover.** A
failure before the final multipart send may follow earlier submissions; one
dispatch does not imply one provider request. Use a finite deadline and
preserve the actual response, result/exit and handle. Do not replay unknown
attempts, shop for agreement or automatically follow up. Missing required
advice pauses only dependent work; sufficient independent authorized work may
continue.

Supply one self-contained, unranked packet: decision/outcome, scope and
constraints, two or three alternatives or the precise unresolved contract,
essential evidence/excerpts, contrary facts and unknowns. Exclude parent
preferences, rankings and authorship. Reuse verified worker excerpts; do not
add a default summarizer or repository-exploration stage. Locators cannot
replace necessary facts in a tool-free packet. Keep answers conditional where
a missing fact could reverse them.

Target **4 KiB**, normally at most **8 KiB of all parent-supplied UTF-8**,
including wrappers and attachments. Narrow the actual question or justify a
larger bound before dispatch; never truncate essential evidence to fit. Request
250–300 words: recommendation, rationale, strongest failure mode, decisive
check and reversal evidence. These targets do not cap host context, reasoning,
actual output or billing. Preserve full available output and truncation facts;
invent no native token/filter controls or global configuration changes.

Advice supplies no authority, repository proof, acceptance or release
permission; the parent records accept/reject/defer. Reuse it while the decision,
constraints and reversal-relevant facts still match—not merely the prompt text.
Prose, elapsed time or adviser-only changes do not justify another call.
Reconsider material changes locally first; if advice is still needed, send a
fresh self-contained packet, not a bare delta or an old recommendation
presented as fact.

## Decision guide

| Evidence | Action |
| --- | --- |
| Known root-cause fix under a valid design | Deliver and accept; bypass ADHD and consultation. |
| Consequential new architecture fork | ADHD, then the selected adviser only if a material choice remains unresolved. |
| Known alternatives with a high-impact tradeoff | Use the selected adviser directly, or run a decisive local check. |
| Existing evidence and premises unchanged | Reuse the decision and continue the roadmap. |
| Material evidence contradicts one premise | Reopen only that affected decision. |
| Required strategy capability unavailable | Pause the affected choice; no substitution or proof waiver. |
| Optional consultation has unknown effects | Preserve the attempt; no replay, while independent work may continue. |
| Worker reports green | Astra still performs independent acceptance. |
| No supported exact worker route | Refuse dispatch; create a new authorized assignment only when an exact route is authorized and available. |
| No authorized next outcome; or ongoing improvement has no viable big win | Idle. |

Keep feedback small: existing reports may note time to accepted output, first-pass acceptance, defects caught, repair burden, and whether consultation resolved its question. Do not create a dashboard, measurement service, cache, ledger, launcher, or dynamic router for this mode. Cost claims require trustworthy billing evidence.
