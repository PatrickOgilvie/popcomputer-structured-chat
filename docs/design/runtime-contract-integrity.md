# Runtime contract integrity

## Summary

Harden `@popcomputer/structured-chat` so its Effect types, Effect Schema
directions, persisted state, tool execution, and UI presentation agree at
runtime. The package keeps its current schema-first workflow and small public
surface while adding only two caller-facing concepts:

```ts
const call = yield* Matching.plan(messages)
const result = yield* Matching.toolSet.execute(call)
```

```ts
const reply = yield* Matchmaker.reply({
  namespace: authenticatedUser.id,
  sessionId: publicSessionId,
  expectedRevision,
  message,
})
```

`ToolSet.execute` consumes an already parsed call without decoding it again.
`namespace` remains a separate storage key component rather than being
concatenated with a browser-held session ID. Existing one-step APIs remain:

```ts
const result = yield* Matching.run(messages)
const reply = yield* Matchmaker.reply({ sessionId, message })
```

## Context / Current State

The package derives provider tool definitions, runtime parsers, workflow state,
tool results, and browser views from Effect Schema definitions. The DCA chat
application composes the package inside `@popcomputer/web` actions and provides
Cloudflare model and D1 session-store adapters through Effect Layers.

The current implementation has four contract mismatches:

1. Values declared as `Schema.Type` are sometimes passed to `decodeUnknown`,
   which expects the schema's Encoded side. Parsed tool calls are also decoded
   twice between planning and execution.
2. Several expected failures are missing from declared Effect error unions or
   escape as synchronous `ParseError` defects.
3. Persisted state records that a confirmation field was asked, but not when;
   adaptive wording records text, but not the field it describes.
4. Session ownership is encoded by delimiter concatenation, which is neither
   injective nor bounded by the component schemas.

Two operational checks are also incomplete: a history limit can be discovered
only after model and tool effects execute, and DCA's representative D1 test is
not part of the normal test command.

## Goals

- Make every Effect Schema call use the correct Type or Encoded direction.
- Execute a parsed tool call without reparsing it.
- Make every expected runtime failure appear in the declared Effect channel.
- Prevent model or tool work when the resulting turn cannot fit in history.
- Require confirmed evidence to follow the server-issued question.
- Bind model-authored adaptive wording to the pending field selected by the
  server.
- Make authenticated session ownership injective without application-owned
  string encoding.
- Restore safe retry and invalid-response diagnostics in the DCA model adapter.
- Run the D1 optimistic-concurrency test in the normal suite.
- Reduce duplicated guard-phase mechanics and concentrate unavoidable type
  erasure behind documented internal helpers.
- Preserve the concise Popcomputer action shape: parse at the action boundary,
  call one Effect use case, translate typed failures, and return a typed view.

## Non-Goals

- Supporting historical persisted chat-state shapes or migrating live sessions.
- Adding an arbitrary agent graph, streaming protocol, provider gateway, or
  database package.
- Exposing raw Effect Schema parse errors, model output, persisted content, or
  unknown causes in public errors or telemetry.
- Supporting definitions shared between duplicated physical package copies.
- Adding configurable history compaction before a production caller requires
  it.

## Invariants

1. `Schema.decodeUnknownEffect(schema)` is used only for Encoded or unknown boundary
   input.
2. `Schema.decodeEffect(Schema.toType(schema))` is used for values promised as `Schema.Type`.
3. `Schema.encodeUnknownEffect(schema)` projects Type-side state or results to a
   persistence/model boundary.
4. A model-authored tool call is parsed exactly once before execution.
5. `ToolSet.execute` accepts only the parsed `ToolSetCall` union; `executeCall`
   remains the unknown-input parse-and-execute convenience.
6. `ToolSetError` includes `InvalidToolCall`, `InvalidToolProjection`, and every
   application tool failure exactly.
7. A persisted reply never performs model or tool effects unless the maximum
   two-message turn can fit within the 200-message limit.
8. A confirmed answer's evidence message index is strictly greater than the
   index at which the server first issued that field's question.
9. Adaptive wording is used only when its declared field equals the server's
   first missing field.
10. Session namespace and public session ID remain separate values at every
    package and persistence seam.
11. Public errors and diagnostics contain stable reason, target, dependency,
    stage, and attempt fields only; they never contain raw payloads or causes.
12. The chat state version changes when an application's persisted state shape
    changes incompatibly.

## Design Constraints

- Effect Schema remains the single parser and codec model.
- Effect Services and Layers remain the dependency mechanism.
- Application tools retain their precise Effect errors and requirements.
- The browser owns only its public session ID, optimistic revision, and latest
  message.
- The server owns workflow state, history, namespace, tool availability, and
  presentation.
- Application-owned projectors remain ordinary functions for concise DX, but
  package orchestration evaluates them inside Effect when their failure is an
  expected boundary outcome.
- No compatibility layer is required because the package and DCA integration
  are pre-release and their current migration is uncommitted.

## Alternatives Considered

### Option 1: Patch each failing call site

Change individual `decodeUnknown` calls, add the missing error union member,
and adjust the two reported predicates without changing interfaces.

This minimizes the diff but leaves `plan -> executeCall` semantically wrong,
keeps delimiter encoding in every application, and allows Type/Encoded drift to
reappear independently in tools, views, and persistence. Rejected because the
same invariants remain distributed.

### Option 2: Explicit parsed execution and directional boundaries

Add `ToolSet.execute`, validate Type-side projections, encode persistence and
model boundaries, record confirmation issuance cursors, bind adaptive wording
to a field, and pass session namespaces as a separate scope component.

This keeps the public surface small while making each operation name express
its trust level. It localizes schema direction and state invariants in the
modules that own them. Recommended.

### Option 3: Make every constructor and adapter fully Effect-returning

Replace `Text.make`, `View.make`, question constructors, and transport
callbacks with Effects, and introduce a session-key service for namespacing.

This makes every possible rejection typed but adds substantial ceremony to
static schema-authored definitions and ordinary presentation composition. Most
constructor failures are startup defects; only data-dependent evaluation inside
an advertised Effect needs translation. Rejected as unnecessary caller burden.

## Recommendation

Implement Option 2 in vertical behavior slices. Keep sync smart constructors
for application-authored definitions, but evaluate presentation and tool
projectors within their owning Effects. Keep unknown-input convenience methods
and add the parsed operation beside them rather than overloading one method with
two trust levels.

## Proposed Design

### End-user DX

Planning and approval before execution becomes explicit:

```ts
// Before: executeCall reparses a value returned by plan.
const call = yield* Matching.plan(messages)
const result = yield* Matching.toolSet.executeCall(call)

// After: execute consumes the parsed Type-side call.
const call = yield* Matching.plan(messages)
const result = yield* Matching.toolSet.execute(call)
```

The direct path stays one operation:

```ts
const result = yield* Matching.run(messages)
```

Authenticated actions stop constructing storage IDs:

```ts
// Before
const storageSessionId = `${actorId}:${publicSessionId}`
const reply = yield* Matchmaker.reply({
  sessionId: storageSessionId,
  expectedRevision,
  message,
})

// After
const reply = yield* Matchmaker.reply({
  namespace: actorId,
  sessionId: publicSessionId,
  expectedRevision,
  message,
})
```

Presentation composition does not change:

```ts
return yield* presentChatReply(
  { ...reply, sessionId: publicSessionId },
  {
    result: ({ result }) => [
      Text.make(makeExplanation(result.modelResult)),
      ...result.views,
    ],
  },
)
```

Invalid dynamic text now fails as `InvalidChatPresentation` instead of dying
with `ParseError`.

## Domain Model and Types

```ts
export interface ChatReplyInput {
  readonly namespace?: string
  readonly sessionId: string
  readonly expectedRevision?: string
  readonly message: string
}

export interface ChatSessionScope {
  readonly namespace: string // empty only for the unscoped default
  readonly sessionId: string
  readonly chat: string
  readonly version: number
}
```

The store treats the tuple, not a rendered string, as identity:

```txt
(namespace, sessionId, chat, version)
```

Confirmation state records its first issued assistant question:

```ts
export interface AcceptedAnswer<Value> {
  readonly value: Value
  readonly evidence: {
    readonly messageIndex: number
    readonly quote: string
  }
}

export interface CollectStageState<Fields extends AnswerFields> {
  readonly accepted: Partial<{
    [Field in keyof Fields]: AcceptedAnswer<AnswerValue<Fields[Field]>>
  }>
  readonly asked: Partial<
    Record<keyof Fields & string, {
      readonly messageIndex: number
      readonly text: string
    }>
  >
}
```

Value and evidence are one persisted unit, so neither can be present without
the other. On session load, every evidence index must resolve to a user message
whose content contains the quote. A semantic quote supports an inference and
is not an equality assertion about the accepted typed value. Quotes remain
untrusted conversation data.

The model-facing proposal contains the quote but not `messageIndex`. The
runtime searches eligible user messages from newest to oldest and owns the
index written to persisted state. This removes transcript bookkeeping from the
model without weakening provenance validation.

`asked[field]` contains the future assistant-message index and exact text when
the question is first returned. `Chat.reply` appends that question at exactly
that index. Loaded sessions require the indexed message to be an assistant
message with the same text. A confirmed evidence message must therefore satisfy:

```ts
evidence.messageIndex > state.asked[field].messageIndex
```

Adaptive proposals couple identity and wording:

```ts
type ProposedNextQuestion<Field extends string> = {
  readonly field: Field
  readonly text: string
  readonly options?: ReadonlyArray<{ readonly label: string }>
}

type CollectProposal<Answers, Field extends string> = {
  readonly answers: Partial<Answers>
  readonly evidence: ReadonlyArray<GroundedEvidence<Field>>
  readonly nextQuestion: ProposedNextQuestion<Field> | null
}
```

Domain acceptance remains distinct from structural parsing:

```ts
Answer.explicit(Schema.Number, {
  description: "Project budget in GBP; must be at least 5,000",
  ask: Question.fixed("What budget have you set aside?"),
  validate: validateBudget,
  reject: {
    ask: Question.fixed("Could you revise the budget?"),
  },
})
```

The answer schema is model-visible and decodes provider data. The optional
validator receives that decoded Type-side value and owns application/domain
acceptance. Constraints moved out of a schema are repeated in `description` so
the model can avoid predictable rejections. Validator errors and Effect
requirements remain exact in `CollectStage.run`; a failure is wrapped in
`AnswerValidationRejected` with a fixed or choice retry prompt. Rejection is
atomic and non-progressing: no proposed answers, rejected user message, or
revision are persisted. `presentAnswerValidationRejection` renders the prompt
without exposing choice values and reuses the prior opaque session reference.

Tool-call errors use honest semantic fields:

```ts
type InvalidToolCallReason =
  | "invalid_envelope"
  | "unknown_tool"
  | "invalid_arguments"

class InvalidToolCall {
  readonly _tag: "InvalidToolCall"
  readonly reason: InvalidToolCallReason
  readonly tool: ToolName | null
}
```

No raw parse cause is retained in the public schema.

## Types, Interfaces, and APIs

```ts
export interface ToolSet<Tools extends ToolTuple> {
  readonly tools: Tools
  readonly models: ReadonlyArray<ModelToolDefinition>

  readonly parseCall: (
    input: unknown,
  ) => Effect.Effect<ToolSetCall<Tools>, InvalidToolCall>

  readonly execute: (
    call: ToolSetCall<Tools>,
  ) => Effect.Effect<
    ToolSetExecution<Tools>,
    ToolSetError<Tools>,
    ToolSetRequirements<Tools>
  >

  readonly executeCall: (
    input: unknown,
  ) => Effect.Effect<
    ToolSetExecution<Tools>,
    ToolSetError<Tools>,
    ToolSetRequirements<Tools>
  >
}

export type ToolSetError<Tools extends ToolTuple> =
  | InvalidToolCall
  | InvalidToolProjection
  | ToolErrorOf<Tools[number]>
```

Directional internal operations:

```ts
const parseEncodedCall = Schema.decodeUnknownEffect(callSchema)
const validateModelResult = Schema.decodeEffect(Schema.toType(modelResultSchema))
const encodeModelResult = Schema.encodeUnknownEffect(modelResultSchema)
const validateViewInput = Schema.decodeEffect(Schema.toType(view.inputSchema))
const decodeSerializedView = Schema.decodeUnknownEffect(view.partSchema)
const encodePersistedState = Schema.encodeUnknownEffect(chat.stateSchema)
const decodePersistedState = Schema.decodeUnknownEffect(chat.stateSchema)
```

Presentation uses one private Effect boundary:

```ts
const buildPresentation = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: () => invalidPresentation(),
  })
```

`presentChatReply` and `presentChatNotice` compose `buildPresentation` with the
final response Schema parser.

## Seams, Boundaries, Adapters, and Implementations

### Model boundary

- Input: trusted instructions, untrusted messages, JSON Schema tool models.
- Output: unknown provider envelope.
- Owner: OpenAI-compatible adapter.
- Parsing: provider envelope and JSON arguments are decoded once.
- Failure: `ChatModelUnavailable` with safe reason only.

### Tool boundary

- Unknown provider call enters `ToolSet.parseCall` or `executeCall`.
- Parsed calls enter `ToolSet.execute`.
- Application projectors return Type-side values and run inside Effect.
- Model-visible results are schema-encoded before JSON serialization.

### Persistence boundary

- Chat runtime schema-encodes Type-side state before `store.replace`.
- Store adapters persist the encoded unknown value.
- Loaded state is unknown and schema-decoded by the chat runtime.
- Namespace and public session ID are separate store fields.

### Browser protocol boundary

- Application callbacks produce candidate parts inside an Effect try boundary.
- The complete response is decoded by `StructuredChatTurnResponseSchema`.
- Only typed, display-safe parts cross to the browser.

### DCA action boundary

```txt
unknown HTTP request
  -> @popcomputer/web validateRequest
  -> authenticated actor parser
  -> runStructuredMatchmakerTurn
  -> DcaMatchmaker.reply(namespace + public session ID)
  -> presentChatReply
  -> typed JSON response
```

Cloudflare bindings and D1 stay in DCA External Adapter Modules and are
provided through request-scoped Effect Layers.

## Call Stacks and Data Flow

### Current / Old Flow

```txt
provider call (Encoded)
  -> ToolSet.parseCall
  -> ToolCall (Type)
  -> runToolStep
  -> ToolSet.executeCall
  -> Tool.parseCall again
  -> transformation schema rejects the already decoded Type
```

```txt
projector returns Schema.Type
  -> decodeUnknown expects Schema.Encoded
  -> valid Date/refined value rejected
```

```txt
199 persisted messages
  -> model request
  -> tool Effect
  -> 201 projected messages
  -> history_limit
  -> no replacement; retry repeats work
```

### Proposed / New Flow

```txt
provider call (unknown Encoded)
  -> ToolSet.parseCall / schema decode
  -> ToolSetCall (Type)
  -> guards inspect parsed call
  -> ToolSet.execute
  -> selected Tool.execute(Type arguments)
  -> application Effect
  -> Type-side result validation
  -> model-result schema encoding
  -> bounded JSON model context
```

```txt
store.load unknown snapshot
  -> snapshot schema decode
  -> chat-state schema decode (Encoded -> Type)
  -> cross-check accepted evidence against persisted user messages
  -> worst-case history precondition
  -> run stage/tool
  -> chat-state schema encode (Type -> Encoded)
  -> store.replace complete revision
```

```txt
collect proposal
  -> answer/evidence schema decode
  -> validate exact user quote
  -> ground every issued question against its exact assistant transcript entry
  -> for confirmed fields, compare evidence index with the issued question
  -> persist each value and its evidence as one accepted-answer unit
  -> select first missing field
  -> verify nextQuestion.field
  -> emit prompt and record its first issued index and exact text
```

```txt
persisted command turn
  -> load and validate snapshot/revision/history capacity
  -> derive SHA-256 commandId from namespace/chat/version/session/revision/name
  -> plan exactly one call to the command stage's single command
  -> application executes through its durable idempotency endpoint
  -> command stage completes
  -> one optimistic session replacement

retry after an ambiguous or failed replacement
  -> same persisted revision produces the same commandId
  -> application replays the original outcome for identical input
  -> application rejects the same commandId paired with different input
```

Commands are distinct from repeatable query tools. `Stage.tools` accepts only
queries; `Stage.command` accepts exactly one command and is terminal. The
package deliberately does not add a planned/executing/completed journal to the
chat state because that would require either multiple session writes or a new
durable command-journal seam. The application endpoint remains the necessary
owner of atomic side-effect idempotency. `Chat.run` cannot supply persisted
turn identity and therefore refuses command execution; `Chat.reply` is the
safe command-chat entry point.

Valid-flow tests may use the typed `Scenario` model layer from the testing entry
point. `Scenario.answers(stage, ...)` encodes Type-side values through the
field schemas and derives evidence from the real model request transcript.
Index inference succeeds only for exactly one containing user message; repeated
quotes require an explicit verified `messageIndex`. `Scenario.call(tool, ...)`
similarly encodes typed tool input. Boundary and adversarial tests continue to
use raw layers so malformed calls, invalid evidence, history limits, and stale
state are not normalized by the helper.

```txt
persisted follow-up with Repair.standard
  -> one closed plan over apply_conversation_repairs + final query tools
  -> query selected: execute once; no behavior change
  -> repair selected: strictly parse a bounded closed transition union
     -> semantic/explicit: require evidence from the current user message,
        rerun field validation, replace value+evidence atomically
     -> confirmed: clear value+evidence+issued question and enqueue collect stage
  -> at most one second model request
     -> rerun query after replacements, or reissue earliest confirmation
  -> persist the ordered pending-stage queue with the turn
```

Repair is opt-in and valid only with a repeatable final query stage. During
reconfirmation, completed later collect stages remain grounded and suspended;
the persisted queue names exactly the incomplete stages and the active cursor
must equal its first entry. Completing one entry advances to the next, then
clears repair state before returning to the final query. The normal invariant
(past collectors complete, active collector incomplete, future collectors
initial) remains unchanged when the queue is empty or repair is disabled.
Commands are excluded at definition time.

### Failure Flow

```txt
malformed envelope
  -> InvalidToolCall { reason: "invalid_envelope", tool: null }

valid but unregistered name
  -> InvalidToolCall { reason: "unknown_tool", tool: name }

registered tool with invalid arguments
  -> InvalidToolCall { reason: "invalid_arguments", tool: name }

application projection violates Type schema or encoding
  -> InvalidToolProjection in ToolSetError

presentation callback or constructor rejects data
  -> InvalidChatPresentation in Effect error channel

persisted state fails decoding/encoding
  -> InvalidChatSession with safe boundary reason
```

### Retry / Cancellation / Idempotency Flow

```txt
reply input
  -> load snapshot and revision
  -> reject stale revision
  -> reject history > 198 before model work
  -> model/tool Effects
  -> one optimistic complete replacement
```

The 198-message precondition reserves the maximum user plus assistant growth.
A rejection performs zero model requests, tool Effects, or store writes.

DCA retries one `request_failed` model operation once. Independently, the core
planner permits one repair request for `invalid_response` or an
`InvalidToolCall`; pre-request guards run once, call guards see only the final
parsed call, and application tools never execute before the repair succeeds.
Both retries remain in the Effect request path so interruption, safe logging,
and the second failure are owned by the same fiber.

If both planner attempts remain invalid during collection, the collect stage
does not fail the public turn. It preserves accepted state and presents the
application-authored pending question without model-authored options. Tool and
command stages retain the typed failure because silently choosing an
application capability would be unsafe.

### Observability Flow

Package spans retain operation names and safe attributes such as chat, stage,
tool, phase, and message count. Typed errors carry stable safe reasons. DCA
logs:

- dependency `workers_ai`, attempt `2`, and error tag/reason before retry;
- dependency `workers_ai` and error tag/reason for rejected provider shapes;
- complete matchmaker turn outcome and duration;
- final action failure tag/reason.

No log includes provider output, tool arguments, conversation content, stored
state, or raw causes.

## Files to Add / Change / Delete

### Add

- `docs/design/runtime-contract-integrity.md` — this target-state contract.

### Change in `@popcomputer/structured-chat`

- `src/core/tool.ts` — Type-side projection validation, encoded model context,
  local symbols, classified call errors, and documented casts.
- `src/core/tool-set.ts` — parsed `execute`, exact error union, classified
  envelope/name/argument failures, and removal of redundant model casts.
- `src/core/model.ts` — compose planning with parsed execution.
- `src/core/stage.ts` — use parsed tool-set execution.
- `src/core/view.ts` — validate Type-side constructors and retain Encoded-side
  decoders.
- `src/core/protocol.ts` — evaluate presentation inside the typed Effect path.
- `src/core/collect-stage.ts` — accepted-answer provenance, grounded issued
  questions, temporal confirmation, field-bound adaptive proposals, and
  Type/Encoded-safe state.
- `src/core/chat.ts` — persisted evidence cross-checks, typed accepted-answer
  access, preflight history, state encoding, namespace scope, and safe boundary
  reasons.
- `src/core/session.ts` — namespace and safe error contracts.
- `src/core/model-guard.ts` — one private guard-phase runner.
- `src/core/question.ts` — document the remaining tuple cast.
- `src/testing/in-memory-session-store.ts` — collision-free tuple key.
- `src/index.ts` — export changed public schemas/types.
- `tests/*.test.ts` and `tests/types.test.ts` — public-seam and exact-type
  regressions.
- `README.md` and examples — parsed execution, namespaces, history behavior,
  safe diagnostics, and version-change guidance.

### Change in DCA

- `src/matchmaker/run-structured-matchmaker-turn.ts` — pass actor namespace
  separately.
- `src/matchmaker/matchmaker-actor.ts` — retain actor parsing without using it
  as a rendered storage ID.
- `src/matchmaker/matchmaker-structured-chat.ts` — bump persisted chat version.
- `src/matchmaker/cloudflare-ai-gateway-chat.ts` — Effect-owned retry and safe
  diagnostics.
- `src/matchmaker/d1-chat-session-store.ts` — namespace column predicates.
- `src/matchmaker/d1-chat-session-store.integration.test.ts` — normal test,
  namespace isolation, and optimistic conflict.
- `src/db/schema.ts` and `migrations/0001_structured_chat_sessions.sql` —
  namespace in the composite primary key.
- affected tests and architecture documentation.

### Delete

- The environment gate that skips D1 verification.
- Delimiter-based actor/session ID constructors.
- Duplicated guard iteration and span mechanics.

## RGR TDD Test Plan

1. **Parsed tool execution**
   - Red: `runToolStep` rejects `Schema.DateFromString` input.
   - Green: add `ToolSet.execute` and compose it after planning.
   - Refactor: make `executeCall = parseCall -> execute` the single convenience
     composition.
2. **Type/Encoded projections**
   - Red: Date model projection and Date view constructor fail.
   - Green: validate Type-side values and encode model context.
   - Refactor: name directional helpers by their boundary operation.
3. **Exact error unions**
   - Red: exact type equality excludes `InvalidToolProjection`.
   - Green: correct `ToolSetError` and every dependent stage/chat union.
   - Refactor: remove the now-false cast claim.
4. **Session persistence law**
   - Red: transformed collected answer cannot round-trip through `reply` and
     the in-memory store.
   - Green: encode state before replacement and decode after loading.
   - Refactor: classify snapshot, state, and replacement failures safely.
5. **History preflight**
   - Red: 199 messages execute a model-result tool then fail without a write.
   - Green: reserve two messages before `run`.
   - Refactor: centralize history constants and prove 198/199/200 outcomes,
     including zero calls on rejection.
6. **Temporal confirmation and adaptive binding**
   - Red: pre-question evidence confirms; second-field wording is attached to
     the first field.
   - Green: persist the issued question and require matching
     `nextQuestion.field`.
   - Refactor: group adaptive text/options under one proposal object.
7. **Typed presentation**
   - Red: dynamic invalid text escapes `Effect.result` for reply and notice.
   - Green: evaluate builders and callbacks inside `Effect.try`.
   - Refactor: share one response parser and invalid-presentation constructor.
8. **Session namespace**
   - Red: two actor/session component pairs address one old rendered key.
   - Green: separate namespace through package and D1 scope.
   - Refactor: use a tuple key in the in-memory adapter and composite columns in
     D1.
9. **Operational evidence and cleanup**
   - Red: retry/rejection paths emit no safe diagnostics and D1 test is skipped.
   - Green: restore Effect logs and run Miniflare test normally.
   - Refactor: consolidate guard phases, replace global symbols, and justify or
     eliminate remaining casts.

Every slice is verified through public package interfaces or the production D1
adapter seam. No module mocks or method spies are introduced.

## Risks and Open Questions

- Reserving two history messages rejects a 199-message turn that might have
  produced no assistant context. This conservative loss of one slot is an
  intentional trade-off until compaction exists.
- `accepted` and `asked` change persisted state. Applications bump their chat
  version rather than interpreting snapshots from either older shape.
- D1 test runtime cost becomes part of ordinary local verification. If it
  becomes material, the test may receive a dedicated command only when that
  command is also mandatory in CI; it must not return to an opt-in environment
  flag.
- Public errors intentionally omit raw causes. If production diagnosis proves
  insufficient, add a package-owned redacted observer contract rather than
  exposing arbitrary parse trees.
