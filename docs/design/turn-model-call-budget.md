# Turn model-call budget

Status: **park the one-plan rewrite; retain the existing finite stage traversal**

## 1. Summary

This spec evaluates replacing the recursive chat transition with one model plan per `Chat.reply`. The proposed rewrite is not recommended for the current package. A collect stage and the final executable stage have different trusted instructions, closed tool sets, guards, parsers, and error unions. Combining them into one chat-wide planner would weaken those stage boundaries or require a new orchestration protocol larger than the hot-path problem.

The existing behavior is finite and intentional: a completed collect stage may immediately enter the next stage, and an enabled repair may make one bounded second request before rerunning the query. Keep that behavior. Reconsider an explicit public turn budget only when real provider-cost or latency data, supplied by the tracing spec, shows that callers need to stop before an immediately reachable stage.

## 2. Goals and non-goals

Goals:

- make the number and reason for model calls in one reply explicit;
- preserve stage-scoped security and validation;
- identify a safe activation condition for a future budget.

Non-goals:

- arbitrary workflow graphs or cycles;
- a model-authored plan that bypasses stage parsers;
- changing repair or cross-stage continuation in this change set.

## 3. Evidence and constraints

The current call stack is:

```text
Chat.reply
  -> runRuntime
     -> CollectStage.run -> model request
     -> trusted transition to next stage
     -> ToolStage.run -> model request
```

Repair adds one planning request and then calls the final query once. Tests and the public README promise both behaviors.

Open-source precedents use explicit stop conditions rather than assuming an unbounded loop. Vercel AI SDK keeps a generation single-step unless callers opt into multi-step execution and supplies `stepCountIs(n)` as a hard stop. OpenAI Agents SDKs likewise expose a maximum-turn limit. These validate a budget primitive, not a mandatory one-call rewrite:

- <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>
- <https://ai-sdk.dev/docs/reference/ai-sdk-core/step-count-is>
- <https://github.com/openai/openai-agents-js/releases>

## 4. Options considered

### A. One chat-wide model plan

One request would choose answers and the final tool call together.

Rejected because the final call may depend on server-validated, transformed answers; collect validators can fail; confirmed fields require a later user turn; and each stage owns different guards and schemas. A speculative final call cannot be trusted after any of those transitions.

### B. Default `maximumModelCallsPerReply: 1`

This is mechanically safe if the runtime returns a new “continue” turn after the budget is exhausted, but it changes successful replies into extra client round trips and breaks the documented direct continuation path.

Rejected as a default. It may become an opt-in policy if telemetry establishes a caller need and a typed continuation result is designed.

### C. Preserve semantics and measure leaf calls

Recommended. Add provider-call spans in the tracing work and retain the existing finite state-machine traversal.

## 5. Typed contracts

No public contract changes are proposed now.

A future design must not use an untyped integer alone. It needs a terminally handled result such as:

```ts
type ChatTurn =
  | ExistingTurns
  | {
      readonly _tag: "ContinuationRequired"
      readonly state: ChatState
      readonly reason: "model_call_budget"
    }
```

It must also specify whether repair planning consumes the same budget and how a persisted continuation obtains command identity without synthesizing a user message.

## 6. Call and data flow

The accepted flow remains:

```text
boundary parse/ground
  -> stage-specific plan
  -> stage-specific parse/guards/validators
  -> trusted state transition
  -> immediately reachable stage-specific plan
  -> one optimistic persistence replacement
```

## 7. Files and implementation plan

No runtime files change for this proposal. `runtime-leaf-tracing.md` supplies the measurement needed for a later decision.

## 8. Red-green-refactor plan

No implementation is recommended, so no red test is added. If activated later:

1. Red: cover budget exhaustion after a completed collect stage and during repair.
2. Green: add the typed continuation result without weakening command identity or persistence.
3. Refactor: share budget accounting between public `run` and persisted `reply`.

## 9. Risks and mitigations

- **Hidden cost remains possible:** provider leaf spans expose actual call counts and durations.
- **Future budget breaks persistence:** require a typed continuation design before implementation.
- **Chat-wide planning weakens trust boundaries:** retain closed stage planners.

## 10. Decision and activation condition

Do not implement a one-plan rewrite. Reopen an opt-in budget only after traces show problematic multi-call replies and at least one caller can define the desired continuation UX.
