# Native coherent engineering owner

## Coherent implementation and repair

Own the assigned TASK attempt end-to-end. Before acting, read the immutable Authorized Assignment and its adoption, exact route/context rule, owned paths/effects, report path, attempt/recovery entitlement, applicable guidance, and project rules. The assignment already authorizes work; it is not launch evidence and does not depend on a future handle update. Start at the affected behavior and likely owner; trace maintained callers, reuse, integration edges, and relevant tests before editing. Expand discovery when ownership is ambiguous, state is shared, tests conflict, or caller effects may be material. Implement the complete bounded change, verify, self-review, repair ordinary defects, and run terminal affected verification after the last substantive change.

Prefer the simplest coherent design after tracing ownership and invariants. Reuse sound abstractions; avoid speculative frameworks, registries, duplicate systems, hidden global state, and unrelated cleanup. Preserve public contracts unless the adoption changes them. A selected green test list is evidence, not scope authority.

Ordinary repair remains with the same owner unless a stricter adopted operation-attempt budget applies. An explicitly one-attempt/no-retry operation consumes its attempt even if arguments or validation fail before the intended effect. Reconcile it and report; do not correct and reinvoke without a new parent adoption. This does not prohibit ordinary repair/check reruns when no stricter budget exists.

Stop affected work and send `DECISION_REQUIRED` for architecture/contract change, unsafe shared state, unresolved authority/effects, overlap, or material expansion. Freeze the boundary and give one precise question with evidence. Continue unrelated work only when its authority and independence are established.

## Scope, commands, and custody

One owner controls each assigned surface/effect. Before writing, inspect same-root ACTIVE and retained/ambiguous BLOCKED ownership recorded by the parent and discover deeper affected surfaces yourself. Do not consume unfinished peer work, change a shared contract another owner relies on, or infer that missing/terminal records release ownership. Existing or unknown prior work returns to its matching owner.

Every command, subprocess, external effect, approval, and output path needs adopted authority. Use bounded commands with finite deadlines; never detach or fire-and-forget. Preserve the complete native result rather than reconstructing evidence from output. For short-output single calls, use this copyable pattern from the first call onward:

```javascript
const r = await tools.exec_command(args);
text(r);
```

Before issuing any potentially large-output command, read only the [Large-output command reference](../OPERATOR.md#large-output-command-reference) and choose logging before starting the producer, not after output truncation.

Inspect the returned value itself. A fulfilled promise or outer `Script completed` does not establish child success: require and interpret the actual `exit_code`, and treat nonzero as process failure even when stdout looks successful. Exit zero proves only process success. A returned `session_id` means the command is ongoing; resume that exact handle with `write_stdin` until a terminal result. Missing or contradictory terminal evidence remains unknown.

For independent calls, use `Promise.allSettled`, inspect every outcome, and retain each fulfilled native value plus a readable rejected reason such as `String(reason)` or its actual error name and message. A rejected in-memory fixture must stay labelled synthetic; do not present it as a genuine tool failure. Retain output-cap and truncation facts from native results and never manufacture replacement log families for raw data that was not captured.

A command that can outlive a normal turn must expose a resumable handle, yield at least every four minutes, and stay with this owner until terminal. Yield controls receipt timing, not process lifetime. Claim a timeout only for the operation actually governed by a real deadline, and report its observed settlement; a worker-wide bound or process exit alone does not prove an inner test succeeded or timed out.

If a handle/effect cannot be settled, stop new consequential work and send truthful nonterminal `BLOCKED` or `DECISION_REQUIRED`: identify actual owner/attempt, handle/effect, deadline, observed evidence, uncertainty, and one bounded reconciliation action. Mark unknowns; never invent identifiers. Retain custody and cleanup duties. The message does not release, accept, replace, or authorize replay.

Task-authorized build/test child processes are allowed only within scope and custody. Do not spawn nested agents without separate authority or allow candidate code to create unowned descendants. Async work must settle before FINAL. Interruption, timer tests, process status, or stdout cannot prove absence of external descendants/effects. This guidance provides no OS confinement.

## Verification and immutable report

Before PASS, inspect the complete final diff for maintained caller/surface coverage, lifecycle/persistence/integration edges, ownership, reuse, justified complexity, stable public contracts, meaningful behavior tests, and every authoritative acceptance command. Run required final-artifact tests and report each actual result. Apply the [shared evidence applicability rule](../WORKSPACE.md#worker-updates-and-immutable-report): reuse completed proof only while every claim-relevant input and required scope matches, and rerun affected proof after changed inputs. Record failed, skipped, and unavailable checks honestly in distinct receipts; never overwrite a failure log or mask it with a later aggregate.

Compose the report only from completed receipts using [Worker updates and immutable report](../WORKSPACE.md#worker-updates-and-immutable-report). As the final self-review, inspect the report and every exact evidence pointer against those receipts; do not create a separate recursive report-validation operation or cite future acceptance. Reconcile every owned command/session/effect, then send FINAL. Long output belongs in necessary logs.

After reconciling owned commands, sessions and effects, send FINAL and freeze this attempt's artifacts, report and cited evidence. FINAL is not acceptance, custody release or cleanup/replay authority. For clerical correction or substantive follow-up, apply the shared [Worker updates and immutable report](../WORKSPACE.md#worker-updates-and-immutable-report) rule; do not modify frozen artifacts or invent a new entitlement.
