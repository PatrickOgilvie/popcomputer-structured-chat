# Runtime leaf tracing

Status: **implemented and verified (2026-08-11)**

## 1. Summary

Add leaf spans around the two external hot-path seams that are currently hidden inside broader spans: the configured model request and session-store load/replace. Record only bounded aggregate counts and stable low-cardinality operation attributes. Never record instructions, messages, tool arguments/results, session identifiers, namespaces, revisions, or provider responses.

This makes latency and call multiplicity visible without changing Effects, errors, or adapter ownership.

## 2. Goals and non-goals

Goals:

- separate provider latency from guards/parsing and tool execution;
- separate session read/write latency from runtime work;
- expose safe request/history size indicators;
- preserve existing span names and parent/child structure.

Non-goals:

- full provider-specific OpenTelemetry semantic conventions;
- content capture, token counting, or cost estimation;
- metrics exporters or tracing SDK setup;
- adapter retries.

## 3. Evidence and constraints

Existing `tool_step.plan` spans combine pre-guards, provider I/O, response parsing, and post-guards. Existing `session.reply` spans combine store reads/writes with the entire state machine. Leaf spans are necessary to identify which boundary dominates a hot reply.

OpenTelemetry's GenAI conventions warn that input/output messages and tool arguments/results can contain sensitive information and recommend filtering or truncation. Its convention guidance also favors low-cardinality, inexpensive attributes available at span start. This spec therefore records counts only:

- <https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/>
- <https://opentelemetry.io/docs/specs/semconv/how-to-write-conventions/>

## 4. Options considered

### A. Instrument only application adapters

Applications can do this, but package traces would remain incomplete and adapter implementations would use inconsistent names.

### B. Adopt unstable provider semantic conventions wholesale

Rejected for this provider-neutral core. Model/provider names and token usage are not reliably available at the current seam, and content attributes are unsafe by default.

### C. Package-owned leaf spans with aggregate attributes

Recommended. The core owns semantic session operations; the OpenAI-compatible adapter owns its remote request.

## 5. Typed contracts

No public Effect types change.

Span contract:

| Span | Parent | Attributes |
|---|---|---|
| `popcomputer.structured_chat.model.request` | `tool_step.plan` | `messageCount`, `messageCharacterCount`, `instructionCount`, `toolCount` |
| `popcomputer.structured_chat.session.load` | `session.reply` | `chat`, `version` |
| `popcomputer.structured_chat.session.replace` | `session.reply` | `chat`, `version`, `messageCount`, `messageCharacterCount`, `stage`, `status` |

All values are numeric or bounded enum/name values already owned by the definition. `sessionId`, `namespace`, revision, content, and model-generated names are excluded.

## 6. Call and data flow

```text
session.reply
  -> session.load
  -> checked/trusted runtime
     -> tool_step.plan
        -> model.request
     -> tool execution
  -> session.replace
```

Failure propagation is unchanged; Effect closes spans with the underlying exit.

## 7. Files and implementation plan

- `src/core/model.ts`: add a shared exact character-count helper or model-request leaf span if every model adapter should inherit it.
- `src/adapters/openai-compatible-model.ts`: if the span is adapter-owned, wrap the transport request only.
- `src/core/chat.ts`: wrap `store.load` and `store.replace` at their semantic call sites.
- `tests/model.test.ts` or a new tracing test: capture spans with a test tracer and assert names/attributes.
- `tests/chat.test.ts`: assert load/replace leaf spans and absence of sensitive values if the test tracer is shared.

Preferred placement is core `planToolCall` immediately around `model.requestTool`, because every `StructuredChatModel` implementation then receives consistent instrumentation. The span measures adapter parsing as well as transport, which matches the service boundary.

## 8. Red-green-refactor plan

1. Red: install a small Effect test tracer and assert the three leaf names and aggregate attributes.
2. Green: wrap `model.requestTool`, `store.load`, and `store.replace` with `Effect.withSpan`.
3. Red: assert no session ID, namespace, message content, or tool arguments occur in attributes.
4. Refactor: centralize exact message-character counting to avoid mismatched calculations.
5. Verify all existing error and timeout tests remain unchanged.

## 9. Risks and mitigations

- **Sensitive data leakage:** whitelist fixed attributes; never spread inputs into attributes.
- **High cardinality:** omit session/revision IDs and dynamic provider payload values.
- **Span duplication:** use one package-owned model service span; adapters may add transport spans beneath it.
- **Misleading size:** name the value `messageCharacterCount`, not tokens or bytes.
- **Tracing overhead:** counting is linear over already bounded messages and does not serialize content.

## 10. Decision

Implement the three leaf spans and safe aggregate attributes. Use the resulting traces as the evidence source for any future turn-budget or context-projection work.
