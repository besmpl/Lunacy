# Golden workflow and optional continuous improvement

Use this workflow when the user explicitly selects Lunacy Golden for a genuinely new engineering outcome, or when current user/project authority expressly includes ongoing plugin improvement. Golden wraps each meaningful authorized outcome in a substantive consultation -> ADHD -> Lunacy delivery -> parent acceptance cycle, including routine Golden work. A finite task needs a clear authorized outcome and ends when every authorized outcome is accepted. Ongoing improvement additionally requires current authority and a viable material big win; if none exists, idle. This is an operating policy, not a new contract, scheduler, automatic router, performance claim, or permission to continue forever. Ordinary Lunacy remains the lower-cost direct delivery path, including known-root-cause fixes, unless the user explicitly selected Golden.

GPT-6 Astra/high is the recommended parent setting for this mode, but guidance cannot select or attest the host model and the recommendation is neither enforced nor proven best. Current host/user authority must select the actual parent.

All [authority and record rules](../WORKSPACE.md#authority-entry-and-coexistence), [exact native routing](PLANNING.md#exact-native-routing), recovery, evidence, and parent-only acceptance remain controlling. A roadmap organizes authorized work; it grants no implementation, external effect, publication, deployment, or release authority. Source-ready is not permission to ship.

## Golden cycle

1. **Frame the outcome.** Astra states the user-visible outcome, constraints and non-goals, preserved behavior, allowed effects, decisive acceptance evidence, and separate release authority. For ongoing improvement, require a substantial expected gain tied to a real bottleneck, defect, or simplification, and state how acceptance evidence will verify that gain. Compare the gain with the added total complexity; prefer deleting obsolete machinery or reusing existing code and platform capabilities over adding a new mechanism. Prefer actual defects, user feedback, failed contracts, or changed constraints over speculative novelty.
2. **Consult.** Obtain one real response from the task-selected adviser using the bounded route below. Consultation precedes ADHD so it can expose constraints and questions, but do not present its preference or ranking to proposal generators as the selected answer. Advice supplies evidence, not authority.
3. **Run actual ADHD.** Read and execute the available ADHD skill, including isolated divergence, parent scoring/clustering/trap removal, and fresh focus/convergence. A summary, cached answer, nominal stage, or ordinary brainstorming is not ADHD completion. Only actual completed predecessor output permits advancement.
4. **Adopt an executable roadmap.** After consultation and ADHD complete, Astra records the chosen design and coherent ready slices in the existing parent-owned `TASK.md` using the [Compact TASK form](PLANNING.md#compact-task-form). Each slice identifies concrete implementation steps, observable completion, preserved behavior, design/interfaces, ownership and dependencies, literal model/effort and context, checks and acceptance evidence, stop/recovery limits, permitted effects, and any separately authorized release actor/action. Fully specify every included implementation slice when adopting its outcome. Genuinely unselected future options outside that adopted outcome may retain only the detail needed to expose dependencies and revisit conditions, unless the user requests more; selecting such an option or materially changing an adopted design requires a new immutable adoption before affected execution.
5. **Deliver through Lunacy.** Normally one worker owns inspection, implementation, tests, self-review, ordinary repair, and its immutable report. Multiple coherent slices may implement one outcome; do not create a cycle per file, check, or same-owner repair. Use up to four implementation owners only for non-overlapping writes and independently safe effects with explicit dependencies and integration order. Use the task-selected `bulk` role for bounded, decisively checkable work and `judgment` role for difficult implementation, diagnosis, or discriminating test design. Their defaults remain Luna/max and Sol/medium; [launch-time worker selections](WORKER-MODELS.md) may replace either role for this task. Sol/high remains explicit-only. Worker-role overrides do not change the parent, ADHD agents, or separately selected consultation route. Refuse an unsupported or conflicting pair before dispatch; never substitute, infer, probe, or fall back. Source-only or design-only authority delivers only its authorized artifacts, never implementation by implication.
6. **Accept before advancing.** A worker's green report is self-review, not acceptance. Astra independently inspects the actual result, diff, integration, and applicable evidence under [Acceptance and barrier](PLANNING.md#acceptance-and-barrier). Reuse completed proof only while its artifact, dependencies, configuration, environment, scope, and requirement assumptions remain unchanged.
7. **Continue or finish.** Further ready slices for the same adopted outcome remain in delivery. A materially distinct authorized outcome after acceptance begins a fresh consultation and actual ADHD cycle. Material contradictory facts require a new adoption reopening affected strategy; reconcile live or unknown effects before action and never blindly replay them. Stop when all finite authorized outcomes are accepted. Continuous means successive authorized material improvements, not endless research or implementation.

### Compact current-stage memory

Keep current Golden coordination in the existing `TASK.md`, and update it before advancing a stage. Do not add a second state, binding, history, recovery, or progress ledger. A compact entry is enough:

```text
Cycle/outcome: cycle-2 / reduce startup latency
Stage/status: ADHD focus / ACTIVE
Completed outputs: consultation -> CONSULT-02.md; divergence/scoring -> ADHD-02.md
Active assignment/handle: focus-latency -> <actual recorded handle>
Next action/blocker: adopt the roadmap after all focus reports complete
```

On continuation, read this entry and reconcile the cited reports and actual assignment/handle observations. Labels alone do not prove completion: partial or missing output leaves the stage incomplete. Reuse applicable same-cycle advice and proof rather than duplicating calls. A completed finite task stays complete on a stale `continue`. A future cycle needs a real new consultation; historical facts may inform it but cannot be relabelled as that call.

## Required Golden strategy tools

### Actual ADHD for every Golden cycle

When Golden is invoked, check the skills currently advertised or available to the task. If ADHD is unavailable, suggest once for the task that the user install or enable it. Describe it as known uninstalled only when current evidence proves that state; otherwise call it unavailable and distinguish disabled or not-loaded possibilities from a known missing installation. Do not repeat the suggestion, auto-install, guess a source, URL, command, or plugin ID. If the user requests installation, use a supported installation flow only after the actual source is known. If ADHD is available, make no installation suggestion. Missing ADHD or its required exact route pauses dependent Golden progression; it does not authorize substitution. Independent already-authorized work may continue only without entering a dependent later stage. The user may explicitly leave Golden or change scope; the parent may not silently skip the stage.

Explicit Golden selection opts into the available ADHD skill's actual procedure despite any routine-work skip heuristic; this summary does not implement or replace that skill. The recommended default is five fresh isolated `gpt-5.6-sol`/`medium` generators producing six ideas each, followed by Astra scoring, clustering, and trap removal, then three fresh isolated Sol/medium deepeners for the leading distinct options. These proposal-only agents do not edit code or `TASK.md`; the implementation-owner limit does not apply to them. Preserve the ADHD skill's isolation and no-ranking rules: generators may receive relevant facts and questions surfaced by consultation, but not the adviser's preference as an answer.

<a id="direct-exact-web-pro-advice"></a>
### Consultation selection and bounded advice

Every Golden cycle consults once before ADHD. On same-cycle resume, reuse the
applicable completed response rather than calling again. Preserve an existing
consultation binding for its task; this default does not migrate it. A task-local
adviser override continues for that task. For a new unbound cycle, honor an
explicit `pro` or `auto` choice; without an override, default to `astra-high`.
Task-local choices are:

- `astra-high` (default): exact `gpt-6-astra` / `high` through a fresh native
  agent whose supplied schema supports both literals; never override a fixed
  role.
- Explicit `pro`: exact `chatgpt-web/pro` / `ultra` through direct
  `codex exec -m chatgpt-web/pro -c 'model_reasoning_effort="ultra"'`, not Oracle
  or browser control.
- Explicit `auto`: prefer Pro; select Astra/high only if Pro is already known
  unavailable **before binding and dispatch**, citing current route-specific
  evidence. Generic quota buckets, missing controls and error text do not
  establish that fact; do not launch an availability probe. A user instruction
  to use Astra is direct selection, not measured quota. If availability is
  unknown, retain Pro preference without probing.

Resolve to one literal pair before the existing immutable adoption/assignment.
Shared [routing and custody rules](PLANNING.md#exact-native-routing) govern
fresh context, changed sealed assignments and unknown effects; selection changes
neither parent, ADHD nor workers. **No post-start automatic failover.** A
failure before the final multipart send may follow earlier submissions; one
dispatch does not imply one provider request. Use a finite deadline and
preserve the actual response, result/exit and handle. Do not replay unknown
attempts, shop for agreement or automatically follow up. Missing required
advice pauses dependent progression; independent already-authorized work may
continue only when it does not enter a later Golden stage.

Compose for cold correctness first and possible prefix reuse second. Put a short,
stable role and output rubric first, then the neutral decision, necessary
baseline and constraints, alternatives, and the minimum supporting and contrary
facts and unknowns. Put volatile task facts, identifiers and timestamps last and
only when they affect the answer. Keep unchanged wording and order stable when
practical, but do not pad a packet or omit material facts to manufacture a common
prefix. Request 250–300 words covering recommendation, rationale, strongest
failure mode, decisive check and reversal evidence.

Supply one self-contained, unranked packet for one coherent decision. Exclude
parent preferences, rankings and authorship. Reuse verified worker excerpts;
do not copy a whole chat, `TASK.md`, roadmap or repository, repeat controlling
policy, add a default summarizer or repository-exploration stage, or carry the
adviser's prior preferred answer forward as evidence. Locators, links and hashes
cannot replace necessary facts in a tool-free packet. Do not split one decision
into extra calls merely to meet a byte target, and do not send a bare delta.
Prefer removing duplicated or irrelevant narration; if sufficiency is uncertain,
include the fact and keep the answer conditional.

Target **4 KiB**, normally at most **8 KiB of all parent-supplied UTF-8**. These
are budgets, not quotas. After assembling the final dispatch input, count its
actual UTF-8 bytes, including the real wrappers and attachments (for example,
`wc -c < final-packet` or `python3 -c 'from pathlib import Path;
print(len(Path("final-packet").read_bytes()))'`), and record the count beside the
existing assignment or receipt. Bytes are not tokens.
Narrow the question or justify a larger packet before dispatch; never truncate
essential evidence to fit. No new compiler, ledger or agent is required. The
parent count does not bound host-injected guidance, tools, total rendered
context, reasoning, output or billing. Preserve full available adviser output
and truncation facts.

Stable leading text is cache-friendly, not proof of a cache hit. Keep three
boundaries distinct: the parent's packet byte budget, any provider-side rendered
prefix cache, and reuse of an applicable answer within the same Golden cycle.
Provider matching can depend on the rendered prefix and eligible boundary,
routing and lifetime; packet delimiters are not API cache breakpoints. A cache
hit still generates fresh advice and cannot replace the required consultation
for a new cycle. A cold miss must remain correct. Do not pad to an assumed
threshold, make warm-up or dummy calls, force session reuse or global tool/config
changes, or invent native cache flags. The official [OpenAI prompt-caching
guide](https://developers.openai.com/api/docs/guides/prompt-caching) is API
background, not proof of behavior, billing, thresholds or lifetime on a native
or ChatGPT-web route.

When route output exposes usage, preserve the raw fields with their provenance.
Missing or null cache counters mean unknown, not zero; a reported zero does not
prove that caching is unsupported. Do not normalize unverified counter semantics
or invent cached savings. A cache-hit ratio requires verified route-matched
counter semantics, coverage and denominator. Cost, savings or billing claims
additionally require applicable pricing and billing evidence. Do not make repeat
calls or live benchmarks solely to measure caching.

Illustrative shape (labels are optional, not a mandatory schema):

```text
Act as an independent technical adviser. Return 250–300 words: recommendation,
rationale, strongest failure mode, decisive check, and reversal evidence.
Response only; no tools or follow-up. All necessary facts follow.

Decision: <one neutral question or outcome>
Baseline and constraints: <only facts required to reason from a cold start>
Alternatives: <two or three real options>
Evidence and unknowns: <minimal supporting and contrary facts; what is unverified>
Task-specific details: <only answer-relevant volatile facts>
```

Advice supplies no authority, repository proof, acceptance or release
permission; the parent records accept/reject/defer. Reuse it while the decision,
constraints and reversal-relevant facts still match—not merely the prompt text.
Prose, elapsed time or adviser-only changes do not justify another call.
Reconsider material changes locally first; if advice is still needed, send a
fresh cold-complete packet rather than reusing the old answer.

## Decision guide

| Evidence | Action |
| --- | --- |
| Golden outcome, including routine work | Consult, run actual ADHD, adopt, deliver through Lunacy, then accept. |
| Ordinary Lunacy known-root-cause fix | Deliver and accept without Golden strategy stages. |
| Same Golden cycle, evidence and premises unchanged | Reuse completed stages and continue from reconciled TASK evidence. |
| Material evidence contradicts one premise | Record a new adoption and reopen affected strategy without replaying unknown effects. |
| Required strategy capability unavailable | Pause the affected choice; no substitution or proof waiver. |
| Golden consultation has unknown effects | Preserve the attempt; no replay, while independent work may continue. |
| Worker reports green | Astra still performs independent acceptance. |
| No supported exact worker route | Refuse dispatch; create a new authorized assignment only when an exact route is authorized and available. |
| No authorized next outcome; or ongoing improvement has no viable big win | Idle. |

Keep feedback small: existing reports may note time to accepted output, first-pass acceptance, defects caught, repair burden, and whether consultation resolved its question. When useful, they may use concrete evidence such as the failed criterion or protected boundary to distinguish instruction ambiguity from an execution mistake. Improve an existing ambiguous instruction instead of adding one new rule for every correction. Do not create a dashboard, measurement service, cache, ledger, launcher, or dynamic router for this mode. Cost claims require trustworthy billing evidence.
