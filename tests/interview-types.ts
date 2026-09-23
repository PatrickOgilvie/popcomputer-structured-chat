import { Context, Effect, Schema } from "effect"
import { Answer, Chat, Model, Question, Stage, Tool } from "../src/index.js"
import * as TypeSafe from "../src/typesafe.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T
const budgetChoices = Question.choice(Question.adaptive("Establish a comfortable budget", { fallback: "What budget?" }), [
  { label: "£10k", value: 10000 }, { label: "£20k", value: 20000 },
])
type _ChoiceValues = Expect<Equal<(typeof budgetChoices)["options"][number]["value"], 10000 | 20000>>
class SelectionService extends Context.Service<SelectionService, { readonly finish: boolean }>()("SelectionService") {}
class SelectionFailure extends Schema.TaggedError<SelectionFailure>()("SelectionFailure", {}) {}
const text = Answer.explicit(Schema.String, { description: "An answer", ask: Question.fixed("What is it?") })
const bank = { required: { goal: text }, optional: { timeline: text } } as const
// Dynamically authored banks retain runtime overlap checks without claiming every key overlaps.
const dynamicRequired = Object.fromEntries([["goal", text] as const])
const dynamicOptional = Object.fromEntries([["timeline", text] as const])
Stage.interview({ name: "authored", required: dynamicRequired, optional: dynamicOptional, instructions: ["Gather answers"] })
const selector = Stage.questionSelector(bank, () => Effect.gen(function* () {
  const config = yield* SelectionService
  if (!config.finish) return yield* new SelectionFailure()
  return { _tag: "Selected", target: { _tag: "Finish" } } as const
}))
const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Collect a brief"], selection: selector })
const execution = interview.run({ state: interview.initialState, messages: [] })
type _Requirements = Expect<Equal<Effect.Services<typeof execution>, Model.Service | SelectionService>>
type _Failure = Expect<Equal<Extract<Effect.Error<typeof execution>, SelectionFailure>, SelectionFailure>>
type Completed = Extract<Effect.Success<typeof execution>, { readonly complete: true }>
type _Required = Expect<Equal<Completed["answers"]["goal"], string>>
type _Optional = Expect<Equal<Completed["answers"]["timeline"], string | undefined>>

const jev = Stage.interview({ name: "brief", ...bank, instructions: ["Collect a brief"], selection: TypeSafe.questionSelection(bank, {
  policy: TypeSafe.selectionPolicy({ minimumProbability: 0.9, minimumMargin: 0.1 }),
}) })
type _JevRequirements = Expect<Equal<Effect.Services<ReturnType<typeof jev.run>>, Model.Service | TypeSafe.Service>>
const search = Tool.define({ name: "search", description: "Search", input: Schema.Struct({}), execute: () => Effect.void })
const chat = Chat.define({ name: "interview_types", version: 1, stages: [interview, Stage.tools({ name: "search", instructions: ["Search"], tools: [search] })] })
type _ChatRequirements = Expect<Equal<Chat.Requirements<typeof chat>, Model.Service | SelectionService>>

// @ts-expect-error Selectors may only name fields in their declared bank.
Stage.questionSelector(bank, () => Effect.succeed({ _tag: "Selected", target: { _tag: "Question", field: "unknown" } }))
Stage.interview({ name: "invalid", required: bank.required,
  // @ts-expect-error A field cannot be both required and optional.
  optional: { goal: text }, instructions: ["Collect a brief"],
})

export type InterviewTypeAssertions = [_ChoiceValues, _Requirements, _Failure, _Required, _Optional, _JevRequirements, _ChatRequirements]

class InputService extends Context.Service<InputService, { readonly id: string }>()("InputService") {}
class QueryFailure extends Schema.TaggedError<QueryFailure>()("QueryFailure", {}) {}
const lookup = Tool.define({ name: "lookup", description: "Look up examples", input: Schema.Struct({ id: Schema.String }),
  execute: input => Effect.gen(function* () {
    const config = yield* SelectionService
    yield* Tool.Context
    if (!config.finish) return yield* new QueryFailure()
    return { id: input.id }
  }),
})
const tools = [lookup] as const
const actionBank = { ...bank, tools }
const withTools = Stage.interview({ name: "brief", ...actionBank, instructions: ["Help and collect"],
  inputs: Stage.toolInputs(tools, { lookup: () => InputService.pipe(Effect.map(service => ({ id: service.id }))) }),
  selection: Stage.questionSelector(actionBank, () => Effect.succeed({ _tag: "Selected", target: { _tag: "Tool", name: "lookup" } })),
})
type _ToolRequirements = Expect<Equal<Effect.Services<ReturnType<typeof withTools.run>>, Model.Service | SelectionService | InputService | Tool.Context>>
type _ToolFailure = Expect<Equal<Extract<Effect.Error<ReturnType<typeof withTools.run>>, QueryFailure>, QueryFailure>>
const toolChat = Chat.define({ name: "tools", version: 1, stages: [withTools, Stage.tools({ name: "search", instructions: ["Search"], tools: [search] })] })
type _ToolChatRequirements = Expect<Equal<Chat.Requirements<typeof toolChat>, Model.Service | SelectionService | InputService>>
type _ToolResult = Expect<Equal<Extract<Effect.Success<ReturnType<typeof withTools.run>>, { readonly action: object }>["action"],
  { readonly _tag: "ToolResult"; readonly result: Tool.SetExecution<typeof tools> } | Stage.ToolClarification>>
// @ts-expect-error Selection is closed over registered tool names.
Stage.questionSelector(actionBank, () => Effect.succeed({ _tag: "Selected", target: { _tag: "Tool", name: "unregistered" } }))
// @ts-expect-error A question-only bank grants no query capability.
Stage.questionSelector(bank, () => Effect.succeed({ _tag: "Selected", target: { _tag: "Tool", name: "lookup" } }))
export type InterviewToolTypeAssertions = [_ToolRequirements, _ToolFailure, _ToolChatRequirements, _ToolResult]

const boundGoal = (state: Chat.State<typeof toolChat>) => Chat.acceptedAnswer(toolChat, state, withTools, "goal")
export type BoundInterviewAnswerAssertion = Expect<Equal<NonNullable<ReturnType<typeof boundGoal>>["value"], string>>
