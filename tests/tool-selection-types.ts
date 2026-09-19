import { Context, Effect, Schema } from "effect"
import { Chat, Model, Stage, Tool } from "../src/index.js"
import * as TypeSafe from "../src/typesafe.js"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Expect<T extends true> = T
class InputService extends Context.Service<
  InputService,
  { readonly query: string }
>()("InputService") {}
class InputFailure extends Schema.TaggedError<InputFailure>()(
  "InputFailure",
  {},
) {}
const search = Tool.define({
  name: "search",
  description: "Search",
  input: Schema.Struct({ query: Schema.String }),
  execute: (input) => Effect.succeed(input),
})
const tools = [search] as const
const inputs = Stage.toolInputs(tools, {
  search: () =>
    InputService.pipe(
      Effect.flatMap((input) =>
        input.query.length > 0
          ? Effect.succeed(input)
          : Effect.fail(new InputFailure()),
      ),
    ),
})
const stage = Stage.tools({
  name: "search",
  instructions: ["Search"],
  tools,
  inputs,
  selection: TypeSafe.selection(tools, {
    policy: TypeSafe.selectionPolicy({
      minimumProbability: 0.9,
      minimumMargin: 0.1,
    }),
  }),
})
const execution = stage.run([])
type _Requirements = Expect<
  Equal<
    Effect.Services<typeof execution>,
    InputService | Model.Service | TypeSafe.Service
  >
>
type _InputErrors = Expect<
  Equal<Extract<Effect.Error<typeof execution>, InputFailure>, InputFailure>
>
type _ProviderErrors = Expect<
  Equal<
    Extract<Effect.Error<typeof execution>, TypeSafe.EvaluationError>,
    TypeSafe.EvaluationError
  >
>
const chat = Chat.define({ name: "selected", version: 1, stages: [stage] })
type _ChatRequirements = Expect<
  Equal<
    Chat.Requirements<typeof chat>,
    InputService | Model.Service | TypeSafe.Service
  >
>
const legacy = Stage.tools({ name: "legacy", instructions: ["Search"], tools })
type _LegacyExecution = Expect<
  Equal<
    Effect.Success<ReturnType<typeof legacy.run>>["serverResult"],
    { readonly query: string }
  >
>

void (() => {
  // @ts-expect-error Wrong decoded argument type.
  Stage.toolInputs(tools, { search: () => Effect.succeed({ query: 1 }) })
  // @ts-expect-error Unknown input binding.
  Stage.toolInputs(tools, { missing: () => Effect.succeed({}) })
  Stage.toolSelector(tools, () =>
    // @ts-expect-error Unknown selected tool.
    Effect.succeed({
      _tag: "Selected",
      target: { _tag: "Tool", name: "missing" },
    }),
  )
  TypeSafe.selection(tools, {
    policy: TypeSafe.selectionPolicy({
      minimumProbability: 0.9,
      minimumMargin: 0.1,
    }),
    // @ts-expect-error Only registered tools have criteria.
    criteria: { missing: "Missing" },
  })
})
