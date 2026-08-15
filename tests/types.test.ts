import { Context, Effect, Schema } from "effect"
import {
  Answer,
  AnswerValidationRejected,
  defineChat,
  defineCommand,
  defineTool,
  defineModelGuard,
  defineToolSet,
  ChatModelUnavailable,
  CommandIdSchema,
  InvalidToolCall,
  InvalidToolProjection,
  Instruction,
  Message,
  ModelProvider,
  presentAnswerValidationRejection,
  Question,
  Repair,
  runToolStep,
  Stage,
  StructuredChatModel,
  structuredChatModelLayer,
  UnsupportedModelToolSchema,
  defineView,
  Tool,
  type AcceptedAnswer,
  type ToolExecution,
  type CollectAnswers,
  type CollectStagePrompt,
  type StructuredChatSessionReference,
  type ViewPart,
} from "../src/index.js"
import { Scenario } from "../src/testing.js"

class Dependency extends Context.Tag("Dependency")<
  Dependency,
  { readonly value: string }
>() {}

class DomainError extends Schema.TaggedError<DomainError>()(
  "DomainError",
  { message: Schema.String },
) {}

class SafetyPolicy extends Context.Tag("SafetyPolicy")<
  SafetyPolicy,
  { readonly check: (text: string) => Effect.Effect<void, DomainError> }
>() {}

class InvalidQuery extends Schema.TaggedError<InvalidQuery>()(
  "InvalidQuery",
  { reason: Schema.String },
) {}

class QueryPolicy extends Context.Tag("QueryPolicy")<
  QueryPolicy,
  { readonly validate: (query: string) => Effect.Effect<void, InvalidQuery> }
>() {}

const Card = defineView({
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
const _answers: CollectAnswers<typeof typedBrief.fields> = {
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

const tool = defineTool({
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
const toolSet = defineToolSet(tool)
const setExecution = toolSet.executeCall({
  name: "typed_tool",
  arguments: { query: "test" },
})
const parsedSetExecution = toolSet.execute({
  name: "typed_tool",
  arguments: { query: "test" },
})
const guard = defineModelGuard({
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
const guardedExecution = runToolStep({
  instructions: [Instruction.make("Use one tool.")],
  messages: [Message.user("Find a match")],
  tools: toolSet,
  guards: [guard],
})
const matching = Stage.tools({
  name: "matching",
  instructions: ["Use one tool."],
  tools: [tool],
  guards: [guard],
})
const command = defineCommand({
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
  [Message.user("Perform the write")],
  {
    commandId: Schema.decodeSync(CommandIdSchema)(
      `cmd_${"a".repeat(64)}`,
    ),
  },
)
defineChat({
  name: "typed_command_chat",
  version: 1,
  stages: [typedBrief, commandStage],
})
const stageExecution = matching.run([Message.user("Find a match")])
const validatedExecution = validatedBrief.run({
  state: validatedBrief.initialState,
  messages: [Message.user("Find public services")],
})
const typedChat = defineChat({
  name: "typed_chat",
  version: 1,
  stages: [typedBrief, matching],
})
const _assertOptionalBoundaryInputs = (
  session: StructuredChatSessionReference | undefined,
): void => {
  void typedChat.reply({
    sessionId: "typed-session",
    expectedRevision: session?.revision,
    message: "Find a match",
  })
  void presentAnswerValidationRejection({
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
const acceptedQuery = typedChat.getAcceptedAnswer(
  typedChat.initialState,
  typedBrief,
  "query",
)
// @ts-expect-error fields are restricted to the selected collect stage
typedChat.getAcceptedAnswer(typedChat.initialState, typedBrief, "missing")

const assertDefinitionAuthenticity = (): void => {
  const forgedTool = {
    _tag: "StructuredTool",
    name: "forged_tool",
    description: "A structurally similar but non-executable tool.",
    inputSchema: Schema.String,
  } as const

  // @ts-expect-error executable tools must be created by defineTool
  defineToolSet(forgedTool)

  const forgedGuard = {
    _tag: "ModelGuard",
    name: "forged_guard",
  } as const

  Stage.tools({
    name: "forged_guard_stage",
    instructions: ["Use one tool."],
    tools: [tool],
    // @ts-expect-error model guards must be created by defineModelGuard
    guards: [forgedGuard],
  })

  const forgedStage = {
    _tag: "ToolStage",
    name: "forged_stage",
  } as const

  defineChat({
    name: "forged_chat",
    version: 1,
    // @ts-expect-error chat stages must be created by Stage constructors
    stages: [forgedStage],
  })

  defineChat({
    name: "forged_repair_chat",
    version: 1,
    stages: [typedBrief, matching],
    // @ts-expect-error repair policies must be created by Repair constructors
    repair: { _tag: "StandardRepair", maximumCorrections: 5 },
  })
}

const cloudflareProvider = ModelProvider.cloudflareWorkersAI({
  model: "@cf/example/model",
  complete: () => Promise.resolve({}),
})

const assertProviderAuthenticity = (): void => {
  const forgedProvider = {
    id: cloudflareProvider.id,
    model: cloudflareProvider.model,
  }

  structuredChatModelLayer({
    // @ts-expect-error provider policy must come from a ModelProvider constructor
    provider: forgedProvider,
    timeoutMilliseconds: 1_000,
  })
}

const typedRepair = Repair.standard({ maximumCorrections: 3 })

const _effect: Effect.Effect<
  ToolExecution<
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
  DomainError | import("../src/index.js").InvalidToolProjection,
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
  Equal<typeof acceptedQuery, AcceptedAnswer<string> | undefined>
>

type ValidatedPrompt = Extract<
  CollectStagePrompt<typeof validatedBrief.fields>,
  { readonly field: "query" }
>

type ExpectedValidationError =
  | ChatModelUnavailable
  | UnsupportedModelToolSchema
  | InvalidToolCall
  | InvalidToolProjection
  | import("../src/index.js").InvalidCollectStageResponse
  | AnswerValidationRejected<InvalidQuery, ValidatedPrompt>

type _ValidationErrorIsExact = Expect<
  Equal<
    Effect.Effect.Error<typeof validatedExecution>,
    ExpectedValidationError
  >
>

type _ValidationRequirementsAreExact = Expect<
  Equal<
    Effect.Effect.Context<typeof validatedExecution>,
    StructuredChatModel | QueryPolicy
  >
>

type ExpectedCommandError =
  | ChatModelUnavailable
  | UnsupportedModelToolSchema
  | InvalidToolCall
  | InvalidToolProjection
  | DomainError

type _CommandErrorIsExact = Expect<
  Equal<Effect.Effect.Error<typeof commandExecution>, ExpectedCommandError>
>

type _CommandRequirementsAreExact = Expect<
  Equal<
    Effect.Effect.Context<typeof commandExecution>,
    StructuredChatModel | Dependency
  >
>

type ExpectedToolSetError =
  | DomainError
  | InvalidToolCall
  | InvalidToolProjection

type _ToolSetErrorIsExact = Expect<
  Equal<Effect.Effect.Error<typeof setExecution>, ExpectedToolSetError>
>

const _setEffect: Effect.Effect<
  Effect.Effect.Success<typeof execution>,
  ExpectedToolSetError,
  Effect.Effect.Context<typeof execution>
> = setExecution

const _parsedSetEffect: typeof _setEffect = parsedSetExecution

const _guardedEffect: Effect.Effect<
  Effect.Effect.Success<typeof setExecution>,
  | Effect.Effect.Error<typeof setExecution>
  | ChatModelUnavailable
  | UnsupportedModelToolSchema
  | DomainError,
  | Effect.Effect.Context<typeof setExecution>
  | StructuredChatModel
  | SafetyPolicy
> = guardedExecution

const _stageEffect: typeof guardedExecution = stageExecution

const _part: ViewPart<typeof Card> = Card.make({ value: "safe" })

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
