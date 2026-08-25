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
bun add @popcomputer/structured-chat@next effect@^4.0.0-rc.109
```

The published entry points are ESM-only and support Node.js 22 or newer.

## Start with one tool

```ts
import { Stage, Tool, View } from "@popcomputer/structured-chat"
import { Schema } from "effect"

const ResultCards = View.define({
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

const FindResources = Tool.define({
  name: "find_resources",
  description: "Find resources relevant to the completed request.",
  input: Schema.Struct({
    query: Schema.Trimmed.check(Schema.isNonEmpty()),
  }),
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

const FindResources = Tool.define({
  name: "find_resources",
  description: "Find resources supported by relevant source evidence.",
  input: Schema.Struct({
    query: Schema.Trimmed.check(Schema.isNonEmpty()),
  }),
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
  Chat,
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
    goal: Answer.semantic(Schema.Trimmed.check(Schema.isNonEmpty()), {
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
    audience: Answer.explicit(Schema.Trimmed.check(Schema.isNonEmpty()), {
      description: "Who the requested result is for.",
      ask: Question.fixed("Who is this for?"),
    }),
  },
})

const ResourceFinder = Chat.define({
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
const response = yield* Chat.presentValidationRejection({
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
import { Chat } from "@popcomputer/structured-chat"
import { Effect } from "effect"

const PresentResourceFinder = Chat.present(ResourceFinder, {
  result: ({ result }) => [
    Chat.Text.make(
      "Here are the most relevant evidence-backed resources.",
    ),
    ...result.views,
  ],
})

const program = Effect.gen(function* () {
  const request = yield* parseRequest(Chat.TurnRequestSchema)
  const publicSessionId = request.session?.id ?? crypto.randomUUID()

  return yield* Chat.turn(ResourceFinder, {
    namespace: authenticatedActor.id,
    sessionId: publicSessionId,
    expectedRevision: request.session?.revision,
    message: request.message,
  }).pipe(PresentResourceFinder)
})
```

`Session.Store` is a two-operation Effect service: load a complete snapshot, then
atomically replace it at an expected revision. A stale or concurrent turn
fails with `Session.Conflict`. The package includes an in-memory adapter at
`@popcomputer/structured-chat/testing`; production applications should provide
a durable database adapter, such as the shipped Cloudflare D1 adapter below.

The application should generate initial public session IDs on the server and
pass the authenticated actor as a separate `namespace`. The persistence
identity is the tuple `(namespace, sessionId, chat, version)`: components are
never concatenated. Different component pairs cannot collide at delimiter
boundaries, and two individually valid IDs cannot become invalid merely
because they were joined. Browser-held IDs are references, not authorization.

A session stores at most 200 conversation messages. Each reply reserves room
for the user message and the largest possible assistant result before calling
the model or an application tool. A session with 198 messages may advance; a
session with 199 or 200 messages fails with `Session.Invalid` and reason
`history_limit` without performing model, tool, or persistence work. Start a
new session at that boundary. History summarisation and compaction remain an
explicit application policy rather than silently changing conversation
meaning.

### Durable sessions on Cloudflare D1

The package ships a production-ready `Session.Store` adapter for
Cloudflare D1 behind a dedicated entry point. Apply the shipped migration to
your database, then pass your D1 binding through the narrow
`D1ChatSessionDatabase` port:

```bash
npx wrangler d1 execute SESSIONS_DB \
  --file=node_modules/@popcomputer/structured-chat/migrations/d1/0001_structured_chat_sessions.sql
```

```ts
import { makeD1ChatSessionStore } from "@popcomputer/structured-chat/d1"
import { Session } from "@popcomputer/structured-chat"
import { Layer } from "effect"

const SessionStoreLive = Layer.succeed(
  Session.Store,
  makeD1ChatSessionStore(env.SESSIONS_DB, {
    // Optional: expire sessions for selected namespace prefixes.
    retention: {
      expiringNamespacePrefixes: ["tenant:"],
      retentionMillis: 30 * 24 * 60 * 60 * 1000,
    },
  }),
)
```

Rows are keyed by the full `(namespace, session_id, chat, version)` tuple and
replaced optimistically at an integer revision: a stale `expectedRevision`
fails with `Session.Conflict` and never overwrites newer state. With
retention configured, a load of an expired row in a matching namespace
performs a guarded compare-and-delete before returning nothing, and aged rows
can be removed in bulk. Retention accepts at most 49 non-empty prefixes using
the session-namespace alphabet; an empty prefix is rejected rather than
implicitly selecting every namespace:

```ts
import { cleanupExpiredD1ChatSessions } from "@popcomputer/structured-chat/d1"

const removed = yield* cleanupExpiredD1ChatSessions(env.SESSIONS_DB, {
  expiringNamespacePrefixes: ["tenant:"],
  retentionMillis: 30 * 24 * 60 * 60 * 1000,
})
```

### Non-browser clients and bounded requests

The turn contract is plain JSON over one endpoint, so non-browser clients can
drive it directly. Parse requests through the parameterized factory when the
application needs its own bounds instead of restating the schema:

```ts
import { Chat } from "@popcomputer/structured-chat"

const BoundedTurnRequest = Chat.turnRequestSchema({
  maximumMessageLength: 4_000,
})
```

The default `Chat.TurnRequestSchema` is the no-options instance of
the same factory, so the two accept identical shapes unless you bound them.

On the client side - CLIs, operators, integration tests - extract view data
from a response without React or assistant-ui. Parts that do not match the
view, or fail its strict schema, are skipped:

```ts
import { Chat } from "@popcomputer/structured-chat"

const results = Chat.findTurnParts(response, ResultCards).map(
  (data) => data.results,
)
```

## Explore without interrupting the conversation

An exploration is one application-selected query that runs beside the main
chat. It loads and validates the latest session, executes a registered
read-only tool, and returns independently renderable content. It does not call
the model, append messages, replace the session, or issue a new revision.

Register the closed query set on the chat. A view can carry a complete call
without restating the tool's input encoding:

```ts
const FindRelated = Tool.define({
  name: "find_related",
  description: "Find records related to one visible result.",
  input: Schema.Struct({ seedId: Schema.String }),
  execute: ({ seedId }) => Catalog.findRelated(seedId),
}).pipe(
  Tool.present(RelatedCards, toRelatedCards),
)

const Results = View.define({
  name: "results",
  version: 1,
  schema: Schema.Struct({
    records: Schema.Array(RecordCard),
    exploration: Schema.Struct({
      label: Schema.String,
      call: Chat.ExplorationCallSchema,
    }),
  }),
})

const ResourceFinder = Chat.define({
  name: "resource_finder",
  version: 1,
  stages: [RequestDetails, Lookup],
  explorations: [FindRelated],
})

const viewData = {
  records,
  exploration: {
    label: "Find related",
    call: Tool.makeCall(FindRelated, { seedId: records[0].id }),
  },
}
```

The server parses the small exploration protocol and derives the namespace
from authenticated application context:

```ts
const request = Schema.decodeUnknownSync(
  Chat.ExplorationRequestSchema,
)(await httpRequest.json(), { onExcessProperty: "error" })

const response = Chat.explore(ResourceFinder, {
  namespace: authenticatedTenantId,
  sessionId: request.session.id,
  call: request.call,
}).pipe(Chat.presentExploration(ResourceFinder))
```

For assistant-ui, keep exploration state in the component that owns the
button or slice. The dedicated client accepts the full locally held session
reference but sends only its stable ID:

```ts
import {
  makeAssistantExplorationClient,
} from "@popcomputer/structured-chat/assistant-ui"
import { Result } from "effect"

const explorationClient = makeAssistantExplorationClient({
  endpoint: "/api/resource-finder/explore",
})

const result = await explorationClient.run(
  { session, call: viewData.exploration.call },
  { signal: abortController.signal },
)

if (Result.isFailure(result)) {
  // cancelled | request_failed | invalid_response
  return showExplorationFailure(result.failure.reason)
}

const related = Chat.findExplorationParts(result.success, RelatedCards)
```

Explorations may overlap a normal turn because they never call
`Session.Store.replace`. They always read the latest available snapshot, so
the browser does not send an anchor revision. Query tools are observationally
read-only by contract; commands are rejected from `explorations` at both the
type and runtime boundaries. Results are ephemeral and are not restored after
a reload or included in later model context.

See the compile-checked
[`exploration-lane.ts`](./examples/exploration-lane.ts) example for the full
definition and endpoint composition.

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
const CreateRequest = Tool.command({
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
`Stage.tools` sets. Persisted command chats execute through `Chat.turn`.
The unscoped transition process is available only from the testing entrypoint
because it has no session/revision identity.

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
const RepairableResourceFinder = Chat.define({
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
import * as CloudflareAI from "@popcomputer/structured-chat/model/cloudflare-workers-ai"
import * as OpenAICompatible from "@popcomputer/structured-chat/model/openai-compatible"

const ModelLive = OpenAICompatible.layer({
  provider: OpenAICompatible.Provider.cloudflareWorkersAI({
    model: "@cf/google/gemma-4-26b-a4b-it",
    complete: ({ model, input }, signal) =>
      env.AI.run(model, { ...input }, { signal }),
    requestOptions: {
      temperature: 0,
      max_completion_tokens: 256,
    },
  }),
  timeoutMilliseconds: 15_000,
  classifyError: (cause) => {
    const reason = CloudflareAI.classifyError(cause)
    reportSafeTelemetry({
      reason,
      code: CloudflareAI.errorCode(cause),
    })
    return reason
  },
  retry: {
    maximumAttempts: 2,
    retryableReasons: ["request_failed", "timed_out"],
    delayMilliseconds: 250,
  },
})
```

The built-in Cloudflare classifier walks the provider's cause chains (bounded
depth, cycle-safe) and reports `response_blocked` for security-blocked
responses and `request_failed` otherwise; `CloudflareAI.errorCode`
returns only allowlisted, documented Workers AI error codes for safe telemetry.

Retries wrap only the transport attempt: no application tool has executed, so
repeating an attempt cannot duplicate side effects. Guards run once per turn,
`response_blocked` and schema-parse failures are never retried (invalid output
already receives the chat's one bounded repair), interruption is never
retried, and attempts are bounded by configuration.

The application chooses a provider and model; the package owns the provider's
tool-call dialect and strongest safe schema guarantee. There is no
`toolArguments: "guided" | "strict"` switch for application code to get wrong.

For OpenAI, only the provider definition changes. Recognised Structured Outputs
model families use constrained function arguments automatically; unknown or
older model identifiers conservatively use schema guidance:

```ts
const ModelLive = OpenAICompatible.layer({
  provider: OpenAICompatible.Provider.openAI({
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

Provider credentials, gateway routing, moderation, and any retry policy
beyond the bounded model-layer option above remain at the application
composition edge. If a provider is not built in, implement the
public `Model.ServiceContract` Effect seam; provider-specific SDK types do
not need to leak into chat, stage, or tool definitions.

Built-in provider policy is deliberately conservative:

| Provider definition | Tool argument policy |
| --- | --- |
| `OpenAICompatible.Provider.cloudflareWorkersAI(...)` | Schema-guided, then parsed and validated |
| `OpenAICompatible.Provider.openAI(...)` with a recognised Structured Outputs model | Schema-constrained, then parsed and validated |
| `OpenAICompatible.Provider.openAI(...)` with an unknown model ID | Schema-guided, then parsed and validated |

Providers that only use a JSON Schema as loose generation guidance can be
steered further with the optional `guidanceSchemaOverride` hook. It runs at
serialization time for every outgoing tool — including the synthesized
collect-stage answer tool — receives the tool's name, description, and derived
schema, and may return a replacement schema, or `undefined` to keep the
derived one. Replacement schemas are validated before transport (the root
must be an object schema, and OpenAI strict-mode rules apply to the
post-override document), but they remain guidance-only: responses keep being
validated against the original Effect Schemas.

```ts
const ModelLive = OpenAICompatible.layer({
  provider: OpenAICompatible.Provider.cloudflareWorkersAI({
    model: "@cf/google/gemma-4-26b-a4b-it",
    guidanceSchemaOverride: (tool) =>
      tool.name === "search"
        ? {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "One short search phrase.",
              },
            },
            required: ["query"],
            additionalProperties: false,
          }
        : undefined,
    complete: ({ model, input }, signal) =>
      env.AI.run(model, { ...input }, { signal }),
  }),
  timeoutMilliseconds: 15_000,
})
```

## Connect assistant-ui

```tsx
import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react"
import { Chat } from "@popcomputer/structured-chat"
import {
  makeAssistantChatModelAdapter,
  makeAssistantView,
} from "@popcomputer/structured-chat/assistant-ui"
import type { ReactNode } from "react"

const ResultCardsUI = makeAssistantView(ResultCards, {
  render: ResultCardsComponent,
  fallback: InvalidCardFallback,
})

const QuestionUI = makeAssistantView(Chat.CollectQuestionView, {
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

### Drive a user-visible form from accepted answers

Answers remain server-only unless the definition explicitly discloses them.
Mark the fields that may cross the browser boundary beside their schemas:

```ts
const RequestDetails = Stage.collect({
  name: "request_details",
  fields: {
    goal: Answer.semantic(Schema.Trimmed.check(Schema.isNonEmpty()), {
      description: "The outcome the user wants to achieve.",
      ask: Question.fixed("What would you like help accomplishing?"),
    }).pipe(Answer.visibleToUser({ label: "Goal" })),
    internalRoutingNote: Answer.semantic(Schema.String, {
      description: "Internal routing evidence that must stay server-side.",
      ask: Question.fixed("Which team should handle this?"),
    }),
  },
})
```

Every persisted reply now carries a complete `reply.userAnswers` snapshot for
the exact returned revision. The normal browser response copies it to
`answers`. Visible unanswered or merely asked fields have a `Missing` state;
accepted fields have an `Accepted` state containing only the answer schema's
JSON-encoded value. Hidden field names, prompts, descriptions, evidence, and
values are absent.

The assistant-ui adapter can deliver the correlated session and snapshot to a
small replacement store:

```tsx
import {
  createStructuredChatUserAnswerStore,
  makeAssistantChatModelAdapter,
  useStructuredChatUserAnswers,
} from "@popcomputer/structured-chat/assistant-ui"

const answerStore = createStructuredChatUserAnswerStore()
const model = makeAssistantChatModelAdapter({
  endpoint: "/api/resource-finder/turn",
  onAnswerSnapshot: answerStore.receive,
})

export function RequestSummary() {
  const update = useStructuredChatUserAnswers(answerStore)
  return <SummaryForm snapshot={update?.snapshot ?? null} />
}
```

The store replaces the entire snapshot instead of merging fields, so repairs
and reconfirmations cannot leave stale answers behind. Validation rejections,
notices, failed requests, and malformed responses retain the previous value.
Call `answerStore.clear()` on logout or when changing application context.
Revisions are opaque correlation identifiers, not counters.

This sidecar is response-coupled: it becomes available after the first
successful persisted turn and is not hydrated by a standalone page reload.
Applications that need initial or reload hydration should add an independently
authorized read path rather than treating assistant message history as current
form state.

## Inspect development state

The optional debug inspector has two fixed top-level views. **Conversation**
shows the current stage,
stage progress, required fields, accepted values, issued questions, and
supporting evidence. **LLM Trace** shows the ordered, literal JSON input and
output for every provider invocation, annotated with accepted answers, issued
questions, validation failures, stage changes, executed tools, and terminal
turn failures. It uses a small package-owned panel inspired by DialKit, without
adding DialKit or another runtime dependency.

Debug data uses a separate, explicit response contract. Select it on an
authenticated development endpoint:

```ts
import { Chat } from "@popcomputer/structured-chat"
import * as Debug from "@popcomputer/structured-chat/debug"

if (debugAccessGranted) {
  const outcome = yield* Debug.turn(
    ResourceFinder,
    turnInput,
    { modelPayloads: "literal" },
  )
  return yield* Debug.present(
    ResourceFinder,
    outcome,
    { inspection: { evidence: "include" } },
  )
}

const reply = yield* Chat.turn(ResourceFinder, turnInput)
return yield* Chat.presentReply(reply)
```

Connect that endpoint to the inspector store:

```tsx
import { makeAssistantChatModelAdapter } from "@popcomputer/structured-chat/assistant-ui"
import {
  createStructuredChatDebugStore,
  StructuredChatDebugPanel,
} from "@popcomputer/structured-chat/assistant-ui/debug"

const debugStore = createStructuredChatDebugStore({ maximumTurns: 100 })
const model = makeAssistantChatModelAdapter({
  endpoint: "/api/resource-finder/debug/turn",
  onDebugTurn: debugStore.receiveTurn,
})

export function ResourceFinderDebugPanel() {
  return <StructuredChatDebugPanel store={debugStore} />
}
```

`Debug.turn` installs an isolated Effect recorder for that turn. The built-in
OpenAI-compatible adapter captures the exact `{ model, input }` value passed to
the configured provider `complete` callback and the exact JSON value the
callback returns. This is application-level provider JSON, not HTTP headers,
raw response bytes, or transformations performed later inside an SDK. Captured
model data lives in the explicit success-or-failure outcome; structured-chat
does not write it to the session store. A terminal expected failure produces a
debug failure response containing the events captured before the turn failed,
without claiming that no persistence occurred. No new session revision is
returned, so the assistant adapter can update the LLM Trace view before it
rejects the model run. A failure whose request session ID was invalid carries
`session: null` instead of echoing unvalidated input. Each trace is capped at
200 events; `TraceTruncated` marks omitted tail events while reserving the final
slot for a terminal `TurnFailed`. `Debug.present` accepts ordinary persisted
replies for state-only compatibility, and `Debug.presentState` remains its
explicit alias.

Without `onDebugTurn` (or the state-only `onDebugSnapshot` callback), the normal
adapter continues to reject a response containing debug data. Hiding or
unmounting the panel is not an authorization boundary: the server must decide
whether to run `Debug.turn` and emit the debug response. Literal model payloads
can include full conversation text and application instructions, so expose the
debug endpoint only to authorized development users, send it with
`Cache-Control: no-store`, and do not feed its payloads into ordinary telemetry.
The required `{ modelPayloads: "literal" }` option makes that sensitive-data
exception explicit at the call site. Use `evidence: "omit"` when state
provenance should not cross that boundary. Create one store per chat runtime;
it retains at most 100 turns by default (configurable up to 200) and resets when
the session changes. Call `debugStore.clear()` on logout or when the inspector
session ends. Observer failures are isolated and never change the outcome of
the persisted chat turn.

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

const reply = yield* Chat.turn(ResourceFinder, {
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
const InjectionPolicy = Model.guard({
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
- The core is storage-neutral: sessions persist through the two-operation
  `Session.Store` adapter, and no database is required by default. A
  production Cloudflare D1 adapter ships behind the optional `./d1` entry
  point.
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
