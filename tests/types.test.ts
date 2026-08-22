import { Answer, Chat, Model, Question, Repair, Stage, Tool, View } from "../src/index.js"
import * as OpenAI from "../src/model/openai-compatible.js"
import { Chat as ChatTest } from "../src/testing.js"
import { Context, Effect, Schema } from "effect"
import { Scenario } from "../src/testing.js"

class Dependency extends Context.Service<
  Dependency,
  { readonly value: string }
>()("Dependency") {}

class DomainError extends Schema.TaggedError<DomainError>()(
  "DomainError",
  { message: Schema.String },
) {}

class SafetyPolicy extends Context.Service<
  SafetyPolicy,
  { readonly check: (text: string) => Effect.Effect<void, DomainError> }
>()("SafetyPolicy") {}

class InvalidQuery extends Schema.TaggedError<InvalidQuery>()(
  "InvalidQuery",
  { reason: Schema.String },
) {}

class QueryPolicy extends Context.Service<
  QueryPolicy,
  { readonly validate: (query: string) => Effect.Effect<void, InvalidQuery> }
>()("QueryPolicy") {}

const Card = View.define({
  name: "card",
  version: 1,
  schema: Schema.Struct({ value: Schema.String }),
})

const typedBrief = Stage.collect({
  name: "brief",
  fields: {
    query: Answer.semantic(Schema.String, {
      description: "Search query",
      ask: Question.fixed("What should we search for?"),
    }),
  },
})
const validatedBrief = Stage.collect({
  name: "validated_brief",
  fields: {
    query: Answer.explicit(Schema.String, {
      description: "A non-empty catalog query accepted by policy",
      ask: Question.fixed("What should we search for?"),
      validate: (query) =>
        QueryPolicy.pipe(
          Effect.flatMap((policy) => policy.validate(query)),
        ),
      reject: {
        ask: Question.fixed("Please provide a supported catalog query."),
      },
    }),
  },
})
const invalidAdaptiveRejection = {
  description: "Invalid adaptive rejection",
  ask: Question.fixed("What should we search for?"),
  validate: (_query: string) => Effect.void,
  reject: {
    ask: Question.adaptive("Ask for another query", {
      fallback: "What should we search for instead?",
    }),
  },
}
// @ts-expect-error rejection questions are deterministic in v1
Answer.explicit(Schema.String, invalidAdaptiveRejection)
Answer.confirmed(Schema.Boolean, {
  description: "Invalid adaptive boolean",
  // @ts-expect-error adaptive choices resolve to string answer values
  ask: Question.adaptiveChoice("Choose", {
    minimumOptions: 2,
    maximumOptions: 3,
  }),
})
const assertEscapeValueTypes = (): void => {
  Answer.semantic(Schema.String, {
    description: "Invalid escape value",
    ask: Question.fixed("What is it?"),
    // @ts-expect-error escape values use the field schema's Type side
    escape: { value: 42 },
  })
}
const _answers: Stage.Answers<typeof typedBrief.fields> = {
  query: "public sector",
}
const assertScenarioTypes = (): void => {
  Scenario.answers(typedBrief, {
    // @ts-expect-error quoted values use the field schema's Type side
    query: Scenario.quoted(42, { quote: "42" }),
  })
  // @ts-expect-error tool calls use the tool input schema's Type side
  Scenario.call(tool, { query: 42 })
  // @ts-expect-error replacement values use the field schema's Type side
  Scenario.replace(typedBrief, "query", 42, { quote: "42" })
  // @ts-expect-error semantic fields are replaced, not reconfirmed
  Scenario.reconfirm(typedBrief, "query", { quote: "changed" })
}

const tool = Tool.define({
  name: "typed_tool",
  description: "Verify inferred types.",
  input: Schema.Struct({ query: Schema.String }),
  execute: ({ query }) =>
    Dependency.pipe(
      Effect.flatMap(({ value }) =>
        query.length > 0
          ? Effect.succeed({ value })
          : Effect.fail(new DomainError({ message: "empty" })),
      ),
    ),
}).pipe(
  Tool.modelResult(
    Schema.Struct({ summary: Schema.String }),
    ({ value }) => ({ summary: value }),
  ),
  Tool.present(Card, ({ value }) => ({ value })),
)

const execution = tool.execute({ query: "test" })
const toolSet = Tool.set(tool)
const setExecution = toolSet.executeCall({
  name: "typed_tool",
  arguments: { query: "test" },
})
const parsedSetExecution = toolSet.execute({
  name: "typed_tool",
  arguments: { query: "test" },
})
const guard = Model.guard({
  name: "safety_policy",
  check: ({ messages }) =>
    SafetyPolicy.pipe(
      Effect.flatMap((policy) =>
        policy.check(messages.map(({ content }) => content).join("\n")),
      ),
    ),
  checkCall: ({ call }) =>
    SafetyPolicy.pipe(
      Effect.flatMap((policy) => policy.check(call.name)),
    ),
})
const guardedExecution = Model.runToolStep({
  instructions: [Model.Instruction.make("Use one tool.")],
  messages: [Model.Message.user("Find a match")],
  tools: toolSet,
  guards: [guard],
})
const matching = Stage.tools({
  name: "matching",
  instructions: ["Use one tool."],
  tools: [tool],
  guards: [guard],
})
const command = Tool.command({
  name: "typed_command",
  description: "Perform one typed write.",
  input: Schema.Struct({ query: Schema.String }),
  execute: ({ query }, { commandId }) =>
    Dependency.pipe(
      Effect.flatMap(({ value }) =>
        query.length > 0
          ? Effect.succeed({ value, commandId })
          : Effect.fail(new DomainError({ message: "empty" })),
      ),
    ),
})
const commandStage = Stage.command({
  name: "command",
  instructions: ["Perform one write."],
  command,
})
const assertCommandBoundaries = (): void => {
  // @ts-expect-error commands cannot enter repeatable query stages
  Stage.tools({ name: "unsafe_command", instructions: ["Run."], tools: [command] })
  // @ts-expect-error command execution requires an explicit stable identity
  command.execute({ query: "test" })
}
const commandExecution = commandStage.run(
  [Model.Message.user("Perform the write")],
  {
    commandId: Schema.decodeSync(Tool.CommandIdSchema)(
      `cmd_${"a".repeat(64)}`,
    ),
  },
)
Chat.define({
  name: "typed_command_chat",
  version: 1,
  stages: [typedBrief, commandStage],
})
const stageExecution = matching.run([Model.Message.user("Find a match")])
const validatedExecution = validatedBrief.run({
  state: validatedBrief.initialState,
  messages: [Model.Message.user("Find public services")],
})
const typedChat = Chat.define({
  name: "typed_chat",
  version: 1,
  stages: [typedBrief, matching],
})
// @ts-expect-error compiled runtime operations stay behind Chat.turn
void typedChat.reply
const _assertOptionalBoundaryInputs = (
  session: Chat.SessionReference | undefined,
): void => {
  void Chat.turn(typedChat, {
    sessionId: "typed-session",
    expectedRevision: session?.revision,
    message: "Find a match",
  })
  void Chat.presentValidationRejection({
    rejection: {
      stage: "brief",
      question: {
        field: "query",
        text: "What should we search for?",
        options: [],
      },
    },
    session,
  })
}
const acceptedQuery = Chat.acceptedAnswer(
  typedChat,
  ChatTest.initialState(typedChat),
  typedBrief,
  "query",
)
Chat.acceptedAnswer(
  typedChat,
  ChatTest.initialState(typedChat),
  typedBrief,
  // @ts-expect-error fields are restricted to the selected collect stage
  "missing",
)

const assertDefinitionAuthenticity = (): void => {
  const forgedTool = {
    _tag: "StructuredTool",
    name: "forged_tool",
    description: "A structurally similar but non-executable tool.",
    inputSchema: Schema.String,
  } as const

  // @ts-expect-error executable tools must be created by Tool.define
  Tool.set(forgedTool)

  const forgedGuard = {
    _tag: "ModelGuard",
    name: "forged_guard",
  } as const

  Stage.tools({
    name: "forged_guard_stage",
    instructions: ["Use one tool."],
    tools: [tool],
    // @ts-expect-error model guards must be created by Model.guard
    guards: [forgedGuard],
  })

  const forgedStage = {
    _tag: "ToolStage",
    name: "forged_stage",
  } as const

  Chat.define({
    name: "forged_chat",
    version: 1,
    // @ts-expect-error chat stages must be created by Stage constructors
    stages: [forgedStage],
  })

  Chat.define({
    name: "forged_repair_chat",
    version: 1,
    stages: [typedBrief, matching],
    // @ts-expect-error repair policies must be created by Repair constructors
    repair: { _tag: "StandardRepair", maximumCorrections: 5 },
  })
}

const cloudflareProvider = OpenAI.Provider.cloudflareWorkersAI({
  model: "@cf/example/model",
  complete: () => Promise.resolve({}),
})

const assertProviderAuthenticity = (): void => {
  const forgedProvider = {
    id: cloudflareProvider.id,
    model: cloudflareProvider.model,
  }

  OpenAI.layer({
    // @ts-expect-error provider policy must come from a OpenAI.Provider constructor
    provider: forgedProvider,
    timeoutMilliseconds: 1_000,
  })
}

const typedRepair = Repair.standard({ maximumCorrections: 3 })

type TypedChatReply = Chat.Reply<typeof typedChat>

const _assertPresentChatReplyAcceptsReplyDirectly = (
  reply: TypedChatReply,
): void => {
  void Chat.presentReply(reply)
}

const _effect: Effect.Effect<
  Tool.Execution<
    { readonly value: string },
    Schema.Struct<{ readonly summary: typeof Schema.String }>,
    readonly [
      {
        readonly view: typeof Card
        readonly project: (
          result: { readonly value: string },
        ) => { readonly value: string } | undefined
      },
    ]
  >,
  DomainError | import("../src/index.js").Tool.InvalidProjection,
  Dependency
> = execution

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false

type Expect<Value extends true> = Value

type _AcceptedAnswerIsExact = Expect<
  Equal<typeof acceptedQuery, Stage.AcceptedAnswer<string> | undefined>
>

type ValidatedPrompt = Extract<
  Stage.Prompt<typeof validatedBrief.fields>,
  { readonly field: "query" }
>

type ExpectedValidationError =
  | Model.Unavailable
  | Model.UnsupportedToolSchema
  | Tool.InvalidCall
  | Tool.InvalidProjection
  | import("../src/index.js").Stage.InvalidResponse
  | Stage.AnswerValidationRejected<InvalidQuery, ValidatedPrompt>

type _ValidationErrorIsExact = Expect<
  Equal<
    Effect.Error<typeof validatedExecution>,
    ExpectedValidationError
  >
>

type _ValidationRequirementsAreExact = Expect<
  Equal<
    Effect.Services<typeof validatedExecution>,
    Model.Service | QueryPolicy
  >
>

type ExpectedCommandError =
  | Model.Unavailable
  | Model.UnsupportedToolSchema
  | Tool.InvalidCall
  | Tool.InvalidProjection
  | DomainError

type _CommandErrorIsExact = Expect<
  Equal<Effect.Error<typeof commandExecution>, ExpectedCommandError>
>

type _CommandRequirementsAreExact = Expect<
  Equal<
    Effect.Services<typeof commandExecution>,
    Model.Service | Dependency
  >
>

type ExpectedToolSetError =
  | DomainError
  | Tool.InvalidCall
  | Tool.InvalidProjection

type _ToolSetErrorIsExact = Expect<
  Equal<Effect.Error<typeof setExecution>, ExpectedToolSetError>
>

const _setEffect: Effect.Effect<
  Effect.Success<typeof execution>,
  ExpectedToolSetError,
  Effect.Services<typeof execution>
> = setExecution

const _parsedSetEffect: typeof _setEffect = parsedSetExecution

const _guardedEffect: Effect.Effect<
  Effect.Success<typeof setExecution>,
  | Effect.Error<typeof setExecution>
  | Model.Unavailable
  | Model.UnsupportedToolSchema
  | DomainError,
  | Effect.Services<typeof setExecution>
  | Model.Service
  | SafetyPolicy
> = guardedExecution

const _stageEffect: typeof guardedExecution = stageExecution

const _part: View.Part<typeof Card> = Card.make({ value: "safe" })

void _effect
void _setEffect
void _parsedSetEffect
void _guardedEffect
void _stageEffect
void validatedExecution
void commandExecution
void assertCommandBoundaries
void assertScenarioTypes
void assertEscapeValueTypes
void _part
void _answers
void acceptedQuery
void typedRepair
void assertDefinitionAuthenticity
void assertProviderAuthenticity
void _assertPresentChatReplyAcceptsReplyDirectly
