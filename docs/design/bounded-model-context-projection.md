# Bounded model-context projection

Status: **positive direction, parked until message provenance is modeled**

## 1. Summary

The persisted transcript should remain authoritative while a smaller projection is sent to a model. That separation is a sound architecture, but the current `UntrustedMessage` type contains only `role` and `content`. It cannot distinguish a user answer, a framework question, and a bounded tool result strongly enough for the runtime to compact them without silently changing evidence or reference resolution.

Do not add a tail-slice callback or adapter-only truncation. First introduce typed transcript provenance when a real context budget or compactor is required; then derive a validated, bounded `ModelConversation` from the authoritative transcript.

## 2. Goals and non-goals

Goals:

- keep evidence grounding against the complete persisted transcript;
- bound model-visible context without treating summaries as authoritative facts;
- make projection deterministic, testable, and provider-neutral.

Non-goals:

- silently dropping old messages;
- using another model call for summarisation;
- allowing adapters to mutate trusted instructions or tool definitions;
- changing the 200-message persistence limit in this proposal.

## 3. Evidence and constraints

`Chat.reply` loads and validates the full snapshot. Every `planToolCall` currently receives that same message array, and the OpenAI-compatible adapter serializes all of it. The worst-case payload can therefore be large even though persistence itself is bounded.

OpenAI Agents Python distinguishes local application context from model-visible conversation history. Its handoff filters can change the items forwarded to the next model while session history remains owned separately. That supports a separate projection layer:

- <https://github.com/openai/openai-agents-python/blob/main/docs/context.md>
- <https://github.com/openai/openai-agents-python/blob/main/docs/handoffs.md>

The package's existing design notes already name provenance as the prerequisite for safe compaction. The hot-path audit confirms the cost, but does not remove that prerequisite.

## 4. Options considered

### A. Slice the last N messages in the adapter

Rejected. Guards would inspect one history while the model sees another, the policy would be OpenAI-adapter-specific, and a slice can remove the framework question that makes a confirmed answer meaningful.

### B. Accept an arbitrary `projectMessages` callback

Rejected for now. A callback makes cost opt-in but offers no invariant that evidence-bearing user messages, active questions, or referenced tool context survive. It also creates a public seam before the package can describe correct implementations.

### C. Provenance-first, typed projection

Recommended future design. Persist tagged transcript events, then derive ordinary untrusted model messages under a byte/character and message-count budget.

## 5. Typed contracts

Illustrative future contracts:

```ts
type TranscriptEvent =
  | { readonly _tag: "UserMessage"; readonly content: string }
  | { readonly _tag: "StageQuestion"; readonly stage: string; readonly content: string }
  | { readonly _tag: "ToolContext"; readonly stage: string; readonly content: string }

interface ModelContextPolicy {
  readonly maximumMessages: number
  readonly maximumCharacters: number
}

interface ModelConversation {
  readonly messages: ReadonlyArray<UntrustedMessage>
  readonly sourceEventIndexes: ReadonlyArray<number>
}
```

`sourceEventIndexes` lets tests and diagnostics prove what was retained without logging content. The projector must always retain the current user event and any active issued question. Whether accepted-answer evidence remains model-visible must be an explicit policy, not an accident.

## 6. Call and data flow

```text
session.load
  -> parse full TranscriptEvent[]
  -> ground state against full transcript
  -> projectModelConversation(policy, state, transcript)
  -> guards inspect authoritative transcript
  -> provider receives projected untrusted messages
  -> persist full transcript plus new events
```

## 7. Files and implementation plan

Deferred likely changes:

- `src/core/model.ts`: distinguish authoritative guard history from `ModelConversation`.
- `src/core/chat.ts`: own projection after parsing and grounding.
- `src/core/session.ts`: version a tagged transcript schema.
- adapters: consume only `ModelConversation.messages`.
- migration documentation: require a chat version bump.

No files change now because the prerequisite persisted model is absent.

## 8. Red-green-refactor plan

When activated:

1. Red: prove the current transcript can exceed the model budget and that naive tail slicing loses an active confirmed question.
2. Green: add tagged events and deterministic projection while grounding against the full transcript.
3. Red: cover character limits, current-user retention, tool-context removal, and session migration rejection.
4. Refactor: share bounded-size calculations with tracing attributes.

## 9. Risks and mitigations

- **Semantic drift:** retain the full authoritative transcript and test required-event retention.
- **Persisted schema break:** require an explicit chat version bump.
- **Sensitive telemetry:** record counts only, never message content.
- **False token precision:** budget exact characters/messages unless an adapter supplies a tokenizer-specific policy.

## 10. Decision and activation condition

Do not implement untagged truncation. Activate this design when a caller supplies a concrete model context limit or compaction policy; provenance and migration are part of that feature, not follow-up work.
