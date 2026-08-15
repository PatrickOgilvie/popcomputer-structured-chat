# @popcomputer/structured-chat

Schema-defined, server-owned chat workflows for Effect applications.

`@popcomputer/structured-chat` lets an application describe:

- the facts a conversation must collect;
- the tools available at each stage;
- the data returned to the model;
- the data rendered by the browser; and
- the order in which those capabilities become available.

The framework derives the model tool schemas, runtime validation, workflow
state, browser protocol, and Effect requirements from those definitions.

```sh
bun add @popcomputer/structured-chat effect
```

The published entry points are ESM-only and support Node.js 22 or newer.

## Start with one tool

```ts
import {
  defineTool,
  defineView,
  Stage,
  Tool,
} from "@popcomputer/structured-chat"
import { Schema } from "effect"

const ResultCards = defineView({
  name: "result_cards",
  version: 1,
  schema: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        summary: Schema.String,
      }),
    ),
  }),
})

const FindResources = defineTool({
  name: "find_resources",
  description: "Find resources relevant to the completed request.",
  input: Schema.Struct({ query: Schema.NonEmptyTrimmedString }),
  execute: ({ query }) => ResourceCatalog.search(query),
}).pipe(
  Tool.modelResult(ResourceEvidenceSchema, ({ evidence }) => evidence),
  Tool.present(ResultCards, ({ results }) => ({ results })),
)

const Lookup = Stage.tools({
  name: "lookup",
  instructions: ["Route the completed request to one resource lookup."],
  tools: [FindResources],
})
```

`FindResources` is the single source of truth for one capability. Its input
schema becomes both the model-facing JSON Schema and the authoritative runtime
parser. Its Effect error and service requirements remain typed.

The three result surfaces are deliberately separate:

| Surface | Purpose | Typical contents |
| --- | --- | --- |
| Server result | Trusted application work | rows, graph nodes, internal scores |
| Model result | Bounded reasoning evidence | opaque refs, summaries, citations |
| Views | Browser display | cards, links, public images |

Internal data does not reach the model or browser merely because a tool loaded
it.

See the compile-checked
[`resource-search.ts`](./examples/resource-search.ts) example for a complete
tool, service, model projection, browser projection, and stage definition.

## Compose directly with document-graph

Structured chat does not wrap or replace retrieval. An application-defined
`@popcomputer/document-graph` handle is already an Effect and can be the tool
execution directly:

```ts
import { SearchKnowledgeBase } from "./knowledge-graph.js"

const FindResources = defineTool({
  name: "find_resources",
  description: "Find resources supported by relevant source evidence.",
  input: Schema.Struct({ query: Schema.NonEmptyTrimmedString }),
  execute: ({ query }) => SearchKnowledgeBase.search(query, { limit: 6 }),
}).pipe(
  Tool.modelResult(ResourceEvidenceSchema, toModelEvidence),
  Tool.present(ResultCards, toResultCards),
)
```

`SearchKnowledgeBase` remains the application-owned graph retrieval policy: it
can combine direct resource matches with supporting documents reached through
typed relationships. Structured chat contributes the closed tool schema, stage
policy, result projections, and UI protocol. The graph's typed failures and
Effect requirements flow through the tool without another adapter layer.

## Put a free-form conversation on rails

Collection stages describe meaning, not a fixed form wizard:

```ts
import {
  Answer,
  defineChat,
  Question,
  Stage,
} from "@popcomputer/structured-chat"
import { Schema } from "effect"

const RequestDetails = Stage.collect({
  name: "request_details",
  questions: {
    guidance:
      "Ask one conversational question at a time and briefly explain why the answer improves the result.",
    escape: "Not sure yet",
  },
  fields: {
    goal: Answer.semantic(Schema.NonEmptyTrimmedString, {
      description: "The outcome the user wants to achieve.",
      ask: Question.adaptiveChoice(
        "What would you like help accomplishing?",
        {
          minimumOptions: 3,
          maximumOptions: 5,
          fallbackOptions: [
            "Understand a topic",
            "Compare available options",
            "Plan the next steps",
          ],
        },
      ),
    }),
    audience: Answer.explicit(Schema.NonEmptyTrimmedString, {
      description: "Who the requested result is for.",
      ask: Question.fixed("Who is this for?"),
    }),
  },
})

const ResourceFinder = defineChat({
  name: "resource_finder",
  version: 1,
  stages: [RequestDetails, Lookup],
})
```

The model can understand an answer supplied naturally earlier in the
conversation, but the runtime decides whether each field is complete and which
stage is active.

`questions.guidance` is trusted application policy for model-authored wording.
`questions.escape` adds the same uncertainty option to every browser question.
When the user chooses it, the server keeps the current field unresolved even if
the model incorrectly proposes the label as an answer; an adaptive question can
then explore the same need from another angle.

A field can resolve the escape instead of looping. Declare
`escape: { value }` on the answer and the stage accepts that
application-authored value when the user chooses the uncertainty option
while the field is pending. The value is validated against the answer schema
at definition time and requires `questions.escape` to be configured; a
confirmed field still requires its question to have been issued first.
Fields without an escape value stay unresolved and are re-asked from another
angle, so a user who genuinely cannot answer never blocks the workflow
unless the application wants it to.

For an adaptive choice, valid contextual model suggestions take precedence.
`fallbackOptions` guarantees useful buttons when a model or provider omits them;
the runtime validates both sources against the same option bounds and never
extracts choices from conversational prose.

- `Answer.semantic` instructs the model that it may infer a typed fact from
  quoted user evidence.
- `Answer.explicit` instructs the model to require a direct user statement.
- `Answer.confirmed` is ignored until the server has actually issued that
  question and the user then confirms it.

Only `confirmed` carries a server-enforced ordering guarantee: acceptance
requires an issued assistant question grounded at its exact transcript location
plus evidence from a later user message. Loaded sessions that violate that
ordering are rejected, and repair requires reconfirmation. The
`semantic`/`explicit` distinction is model instruction only — the server
verifies both the same way, as one exact quote from any user message. Choose
`confirmed` when the ordering guarantee must hold against a misbehaving model,
not just a well-prompted one.

| Answer mode | Server enforcement | Model interpretation |
| --- | --- | --- |
| `Answer.confirmed` | The exact assistant question must exist before the supporting user message | Treat the later statement as an explicit answer |
| `Answer.explicit` | Requires an exact quote from a user message | Accept only a directly stated value |
| `Answer.semantic` | Requires an exact quote from a user message | May infer the typed value from that evidence |
| No collect stage | The final tool stage is active immediately | No preliminary fact extraction |

See the compile-checked
[`answer-modes.ts`](./examples/answer-modes.ts) example for required Q&A,
free-form understanding, and completely open tool chat definitions.

Every proposed answer requires an exact quote from a user message. The model
does not calculate transcript positions: the runtime resolves the most recent
eligible user message, then persists its index with the typed value and quote
as one unit. Loaded sessions are rejected if that quote no longer points to the
same user message. Assistant text cannot become evidence.

Applications can read the typed value and its provenance without reaching into
the persisted state shape:

```ts
const goal = ResourceFinder.getAcceptedAnswer(
  reply.turn.state,
  RequestDetails,
  "goal",
)

goal?.value
goal?.evidence.messageIndex
goal?.evidence.quote
```

For semantic answers, the quote supports the model's inference; it does not
need to equal the typed value. Treat the quote as untrusted user content.

### Validate domain acceptance conversationally

Keep parsing and business acceptance separate when a structurally valid value
may still be unsuitable for the workflow:

```ts
class ResultLimitOutOfRange extends Schema.TaggedError<ResultLimitOutOfRange>()(
  "ResultLimitOutOfRange",
  { minimum: Schema.Number, maximum: Schema.Number },
) {}

const ResultLimit = Answer.explicit(Schema.Number, {
  // The description remains model-visible, so repeat acceptance constraints.
  description: "Number of results; must be a whole number from 1 to 20",
  ask: Question.fixed("How many results would you like?"),
  validate: (limit) =>
    Number.isInteger(limit) && limit >= 1 && limit <= 20
      ? Effect.void
      : Effect.fail(
          new ResultLimitOutOfRange({ minimum: 1, maximum: 20 }),
        ),
  reject: {
    ask: Question.fixed("Choose a whole number from 1 to 20."),
  },
})
```

`schema` is the structural, model-visible contract. `validate` runs on its
decoded Type-side value and may use Effect services. Its exact errors and
requirements flow through the stage and chat types. If it fails, the package
returns `AnswerValidationRejected` with the original typed error and the
trusted retry prompt; no answer, message, revision, or partial field set is
persisted.

When one proposal contains several answers, validators run sequentially in
field-definition order and stop at the first rejection. A later validator is
not started after an earlier field fails. This ordering is deliberate because
validators may use Effect services; combine independent checks inside a single
field validator if the application wants its own concurrency and error policy.

Present that non-progressing retry with the browser's previous session
reference, if one exists:

```ts
const response = yield* presentAnswerValidationRejection({
  rejection,
  session: request.session,
})
```

Retry prompts are fixed or choice questions in v1. They never require another
model call, and choice values remain server-only.

For adaptive questions, the model proposes a field together with its wording
and options. The runtime accepts that presentation only when the field matches
the server-selected first missing field. The model can phrase a question; it
cannot choose which workflow requirement comes next. Missing, invalid, or
wrong-field adaptive presentation falls back to the application-authored
question without suggested choices, so optional model wording cannot make the
workflow unavailable.

`Question.adaptive(goal, { fallback })` keeps those two voices separate: the
goal is model-facing phrasing guidance and is never shown to the user, while
the fallback is the user-facing question presented whenever no valid model
wording is available. Adaptive-choice options — model-authored and
`fallbackOptions` alike — are validated against the answer schema, because a
selected label is later submitted as that answer's value.

## Run one server action

The browser submits only its latest text and, after the first turn, an opaque
session reference. State, history, tools, and answers stay on the server.

```ts
import {
  presentChatReply,
  StructuredChatTurnRequestSchema,
  Text,
} from "@popcomputer/structured-chat"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const request = yield* parseRequest(StructuredChatTurnRequestSchema)
  const publicSessionId = request.session?.id ?? crypto.randomUUID()

  const reply = yield* ResourceFinder.reply({
    namespace: authenticatedActor.id,
    sessionId: publicSessionId,
    expectedRevision: request.session?.revision,
    message: request.message,
  })

  return yield* presentChatReply(
    { ...reply, sessionId: publicSessionId },
    {
      result: ({ result }) => [
        Text.make("Here are the most relevant evidence-backed resources."),
        ...result.views,
      ],
    },
  )
})
```

`ChatSessionStore` is a two-operation adapter: load a complete snapshot, then
atomically replace it at an expected revision. A stale or concurrent turn
fails with `ChatSessionConflict`. The package includes an in-memory adapter at
`@popcomputer/structured-chat/testing`; production applications should provide
a durable database adapter.

The application should generate initial public session IDs on the server and
pass the authenticated actor as a separate `namespace`. The persistence
identity is the tuple `(namespace, sessionId, chat, version)`: components are
never concatenated. Different component pairs cannot collide at delimiter
boundaries, and two individually valid IDs cannot become invalid merely
because they were joined. Browser-held IDs are references, not authorization.

A session stores at most 200 conversation messages. Each reply reserves room
for the user message and the largest possible assistant result before calling
the model or an application tool. A session with 198 messages may advance; a
session with 199 or 200 messages fails with `InvalidChatSession` and reason
`history_limit` without performing model, tool, or persistence work. Start a
new session at that boundary. History summarisation and compaction remain an
explicit application policy rather than silently changing conversation
meaning.

## Continue naturally after the first tool result

`Stage.tools(...)` stays active by default. A user can refine the previous
lookup without restarting the collection stage:

```txt
User: We need onboarding guidance for a new team.
Assistant: [resource results]
User: Prefer concise resources with practical examples.
Assistant: [refined resource results]
```

When a tool defines `Tool.modelResult(...)`, each bounded result is retained in
server-owned history as untrusted assistant context. That lets the next model
step resolve references to earlier results while keeping server-only data and
browser views out of the prompt. Retrieved result text never becomes trusted
instructions.

For a deliberately one-shot read, opt into completion explicitly:

```ts
const FetchReportOnce = Stage.tools({
  name: "fetch_report_once",
  instructions: ["Fetch the completed report once."],
  tools: [FetchReport],
  afterExecution: "complete",
})
```

## Run writes as terminal commands

Declare side effects honestly. A command receives the package-derived stable
ID that its application endpoint must use as an idempotency key:

```ts
const CreateRequest = defineCommand({
  name: "create_request",
  description: "Create the confirmed request once.",
  input: CreateRequestInput,
  execute: (input, { commandId }) =>
    Requests.create(input, { idempotencyKey: commandId }),
}).pipe(
  Tool.present(RequestReceipt, toRequestReceipt),
)

const CreateRequestStage = Stage.command({
  name: "create_request",
  instructions: ["Create the confirmed request."],
  command: CreateRequest,
})
```

`Stage.command` accepts exactly one command, must be the final chat stage, and
always completes the chat. Commands cannot be added to repeatable
`Stage.tools` sets. Persisted command chats execute through `Chat.reply`; the
unscoped `Chat.run` seam refuses to run them because it has no session/revision
identity.

The command ID is an opaque SHA-256 identity derived from `(namespace, chat,
version, sessionId, expectedRevision, commandName)`. A retry after a failed
session-store write therefore reaches the application with the same ID. The
application's durable idempotent endpoint must:

- return the original outcome when the same ID and input are retried;
- reject reuse of one ID with different input; and
- commit its idempotency record atomically with the side effect.

This v1 design preserves the session store's single optimistic replacement per
turn. It does not pretend that one chat-state write can journal a command before
and after execution.

## Opt into bounded conversation repair

Repair is disabled by default. Enable it only on chats whose final stage is a
repeatable query:

```ts
const RepairableResourceFinder = defineChat({
  name: "resource_finder",
  version: 2,
  stages: [RequestDetails, Lookup],
  repair: Repair.standard({ maximumCorrections: 5 }),
})
```

On a persisted follow-up, the model sees a closed choice between the stage's
queries and `apply_conversation_repairs`. An ordinary follow-up chooses a query
and still uses one model request. A correction uses at most one bounded second
request after the package applies the typed transition:

- semantic and explicit answers are replaced in place only with fresh evidence
  from the current user message, then the query is rerun;
- confirmed answers are cleared together with their issuance cursor, the chat
  rewinds to the earliest affected collect stage, and the question is reissued;
- multiple confirmed corrections are retained as an ordered persisted
  reconfirmation queue; and
- field validators run again before a replacement is accepted.

Repair cannot be enabled for a terminal query or command chat. Commands are
never offered to repair planning and never rerun. Enabling repair adds repair
state to persisted sessions, so bump the chat version when adding it to an
existing definition.

## Connect a model provider

```ts
import {
  ModelProvider,
  structuredChatModelLayer,
} from "@popcomputer/structured-chat"

const ModelLive = structuredChatModelLayer({
  provider: ModelProvider.cloudflareWorkersAI({
    model: "@cf/google/gemma-4-26b-a4b-it",
    complete: ({ model, input }, signal) =>
      env.AI.run(model, { ...input }, { signal }),
    requestOptions: {
      temperature: 0,
      max_completion_tokens: 256,
    },
  }),
  timeoutMilliseconds: 15_000,
  classifyError: (cause) =>
    workersAIBlocked(cause)
      ? "response_blocked"
      : "request_failed",
})
```

The application chooses a provider and model; the package owns the provider's
tool-call dialect and strongest safe schema guarantee. There is no
`toolArguments: "guided" | "strict"` switch for application code to get wrong.

For OpenAI, only the provider definition changes. Recognised Structured Outputs
model families use constrained function arguments automatically; unknown or
older model identifiers conservatively use schema guidance:

```ts
const ModelLive = structuredChatModelLayer({
  provider: ModelProvider.openAI({
    model: "gpt-5.6-luna",
    complete: ({ model, input }, signal) =>
      openAI.chat.completions.create(
        { ...input, model },
        { signal },
      ),
  }),
  timeoutMilliseconds: 15_000,
})
```

The adapter always requires exactly one tool call, disables parallel tool
calls and streaming, separates trusted instructions from untrusted
conversation text, parses the provider envelope and JSON arguments, then lets
the selected Effect Schema validate them. Provider options cannot override
those invariants.

Cloudflare Workers AI uses schemas as generation guidance because its API does
not guarantee schema-constrained output. Invalid output is rejected at the
Effect Schema boundary and may receive the chat's one bounded repair attempt.
Recognised OpenAI models add `strict: true`. Before contacting OpenAI, the
adapter rejects schemas whose root is not an object, whose objects allow
additional properties, or whose object properties are optional.

Model optional values explicitly with `Schema.NullOr(...)` so the field remains
required while its value may be absent. If a constrained provider receives an
incompatible tool, the request fails before transport with
`UnsupportedModelToolSchema`, including the safe tool name, schema path, and
incompatibility reason. Every provider response is still parsed with the
original Effect Schema: constrained generation strengthens the trust boundary;
it never replaces it.

Provider credentials, gateway routing, retries, and moderation remain at the
application composition edge. If a provider is not built in, implement the
public `StructuredChatModelService` Effect seam; provider-specific SDK types do
not need to leak into chat, stage, or tool definitions.

Built-in provider policy is deliberately conservative:

| Provider definition | Tool argument policy |
| --- | --- |
| `ModelProvider.cloudflareWorkersAI(...)` | Schema-guided, then parsed and validated |
| `ModelProvider.openAI(...)` with a recognised Structured Outputs model | Schema-constrained, then parsed and validated |
| `ModelProvider.openAI(...)` with an unknown model ID | Schema-guided, then parsed and validated |

## Connect assistant-ui

```tsx
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react"
import { CollectQuestionView } from "@popcomputer/structured-chat"
import {
  makeAssistantChatModelAdapter,
  makeAssistantView,
} from "@popcomputer/structured-chat/assistant-ui"
import type { ReactNode } from "react"

const ResultCardsUI = makeAssistantView(ResultCards, {
  render: ResultCardsComponent,
  fallback: InvalidCardFallback,
})

const QuestionUI = makeAssistantView(CollectQuestionView, {
  render: RequestQuestion,
  fallback: InvalidQuestionFallback,
})

const model = makeAssistantChatModelAdapter({
  endpoint: "/api/resource-finder/turn",
})

export function ResourceFinderRuntime({
  children,
}: Readonly<{ children: ReactNode }>) {
  const runtime = useLocalRuntime(model)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <QuestionUI />
      <ResultCardsUI />
      {children}
    </AssistantRuntimeProvider>
  )
}
```

The adapter sends only the current user text and latest opaque session
reference. It rejects attachments, strictly parses responses, and stores the
new reference in assistant message metadata. A selected option is simply its
displayed text; the server-owned stage determines what that text may answer.
Pass `fetch` only when the application needs a custom transport or test seam.

This is the lowest-friction assistant-ui `LocalRuntime` path. Its attachment,
speech, feedback, suggestion, history, and thread-list adapters remain ordinary
assistant-ui composition; structured-chat does not replace them. The default
structured-chat session is linear and optimistically revisioned. Applications
that expose message editing, regeneration, or persistent branching should pair
it with an application-owned branch/session policy rather than treating browser
history as authoritative.

## Plan without executing

The default remains one call:

```ts
const result = yield* Lookup.run(messages)
```

Approval flows, dry runs, and evals can stop after a strictly parsed proposal:

```ts
const call = yield* Lookup.plan(messages)

// Application-owned review or approval.
const result = yield* Lookup.toolSet.execute(call)
```

`plan` uses the same trusted instructions, closed tool set, guards, provider
adapter, and schemas as `run`; it simply omits application execution.
`execute` accepts that already parsed call. Use `executeCall(unknownInput)`
only at a boundary where the call has not already been parsed.

## Test transcript scenarios

The optional testing entry point scripts valid model calls while exercising the
real public runtime, schemas, Effects, and session store:

```ts
import {
  inMemoryChatSessionStore,
  Scenario,
} from "@popcomputer/structured-chat/testing"

const ModelTest = Scenario.model(
  Scenario.answers(RequestDetails, {
    goal: Scenario.quoted("prepare an onboarding plan", {
      quote: "prepare an onboarding plan",
    }),
    audience: Scenario.quoted("new team members", {
      quote: "new team members",
    }),
  }),
  Scenario.call(FindResources, {
    query: "onboarding plan for new team members",
  }),
)

const reply = yield* ResourceFinder.reply({
  sessionId: "scenario-1",
  message: "Help me prepare an onboarding plan for new team members.",
}).pipe(
  Effect.provide(Layer.merge(ModelTest, inMemoryChatSessionStore)),
)
```

Scenario values use each schema's Type side and are encoded into provider
calls, so transformed schemas remain covered. A quote without an index must
occur in exactly one preceding user message; assistant matches are ignored. If
the same quote occurs in several user messages, specify
`{ quote, messageIndex }` and the helper verifies that exact message.

Use the DSL for valid conversational flows. Keep malformed envelopes, invalid
evidence, stale revisions, and history/size limits on raw model and store
layers—their purpose is to exercise states the helper intentionally refuses to
construct.

After enabling repair, valid correction scripts can use the same evidence
rules:

```ts
Scenario.repairs(
  Scenario.replace(RequestDetails, "audience", "engineering managers", {
    quote: "Actually, engineering managers",
  }),
)
```

For a field declared with `Answer.confirmed`, use `Scenario.reconfirm(...)` in
the same corrections list. The helper's type contract prevents replacement of
confirmed fields and reconfirmation of semantic or explicit fields.

## Prompt injection and trust boundaries

The framework provides structural containment, not a claim that a prompt can
make an LLM intrinsically safe.

Built-in boundaries include:

- trusted stage instructions and untrusted conversation are separate fields;
- provider adapters serialize conversation under `untrustedConversation` in a
  user message rather than interpolating it into system instructions;
- each stage exposes a closed tool set, so later capabilities cannot be called
  early;
- exactly one call is accepted and unknown calls are parsed before execution;
- excess capability fields are rejected;
- collection requires exact user-message evidence;
- confirmed fields cannot be populated before being issued;
- session state and history are server-owned and revisioned;
- bounded tool model results used for follow-ups remain untrusted conversation
  context;
- model, server, and browser result projections are distinct; and
- optional guards can inspect both the untrusted conversation before the
  model and the strictly parsed proposal before application code executes.

Optional guards run before the provider and, when configured, after strict
call parsing but before application execution. Both hooks can use ordinary
Effect services:

```ts
const InjectionPolicy = defineModelGuard({
  name: "prompt_injection_policy",
  check: ({ messages, toolNames }) =>
    PolicyService.check({ messages, toolNames }),
  checkCall: ({ messages, call }) =>
    PolicyService.checkCall({ messages, call }),
})

const Lookup = Stage.tools({
  name: "lookup",
  instructions: ["Route the completed request to one resource lookup."],
  tools: [FindResources],
  guards: [InjectionPolicy],
})
```

See the complete, strictly type-checked
[`prompt-injection-policy.ts`](./examples/prompt-injection-policy.ts) example
for an Effect service whose typed policy rejection flows through the stage.

The package intentionally does not ship a universal keyword detector. Prompt
injection is contextual, and a weak detector can create false confidence. A
guard may call a specialised classifier, a policy service, or deterministic
application rules and return the application's typed Effect failure.

Applications still own:

- authentication, actor-to-session binding, CSRF and origin protection;
- tool-level authorization and database visibility filters;
- confirmation for consequential writes;
- output escaping and safe link/image policies;
- provider moderation and data-retention choices; and
- rate limits, spend limits, secrets, network policy, audit retention, and DLP.

Those last operational concerns belong in the hosting platform or API gateway,
not in a chat workflow package.

## Versions

| Version | Change it when | Effect of changing it |
| --- | --- | --- |
| Chat `version` | Persisted stage, answer, provenance, command, or repair state is no longer compatible | Creates a new persistence scope; old sessions are not silently decoded as the new workflow |
| View `version` | Browser data shape or meaning changes incompatibly | Changes `schemaVersion`; old payloads fail closed in the renderer |

Tool inputs and model-result projections are schema-validated but do not have a
separate numeric version. Make incompatible tool changes deliberately: rename
the tool or coordinate provider, application, and eval changes together.

## Design trade-offs

- Workflows are sequential collect stages followed by one query-tool or command
  stage. Query stages remain active for follow-ups unless explicitly terminal;
  command stages are always terminal. Arbitrary cyclic agent graphs are
  intentionally out of scope.
- Every model request produces exactly one closed, schema-parsed call. One
  contract-invalid response may receive a bounded repair request before any
  application tool executes. If collection still receives invalid or
  ungrounded model output — including evidence quotes that do not appear
  verbatim in a user message — it safely presents the application-authored
  pending question without advancing answers. A turn
  may advance from collection into its next sequential stage. Opt-in repair
  adds one specifically bounded planner step on a final-stage correction: one
  repair call may be followed by one collect/query call. There is no unbounded
  model → tool → model loop.
- Tool and command execution are application-owned. Commands make idempotency
  identity explicit; the framework does not infer authorization or provide the
  application's durable outcome journal.
- Durable persistence requires an adapter; no database is selected by default.
- Public errors expose only stable, content-free reasons and identifiers
  relevant to each failure—not raw prompts, provider responses, persisted
  state, or unknown causes. Content-free Effect spans cover model
  requests and session-store loads/replacements, with aggregate message and
  character counts where available. They never include session identifiers,
  namespaces, revisions, message content, or tool arguments/results.
- assistant-ui and React are optional peer integrations. The core has no React
  runtime dependency.
- The default browser adapter is non-streaming and uses one linear server
  revision. Streaming and branch-aware thread restoration require explicit
  application protocols rather than hidden framework behaviour.

These constraints keep the default path legible while leaving provider,
persistence, guards, tools, views, and Effect services independently
composable.
