import { Answer, Chat, Model, Question, Stage, Tool } from "../src/index.js"
import * as TypeSafe from "../src/typesafe.js"
import { Context, Effect, Schema } from "effect"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false
type Expect<T extends true> = T
const fields = {
  interval: Answer.explicit(Schema.Literals(["monthly", "annual"]), {
    description: "Billing interval",
    ask: Question.fixed("Which interval?"),
  }),
}
const stage = Stage.collect({
  name: "billing",
  fields,
  detector: TypeSafe.detection(fields, {
    policy: TypeSafe.detectionPolicy({ detectedAtOrAbove: 0.9, undetectedAtOrBelow: 0.1 }),
  }),
})
const execution = stage.run({ state: stage.initialState, messages: [] })
type _RequirementsAreExact = Expect<
  Equal<Effect.Services<typeof execution>, Model.Service | TypeSafe.Service>
>
type _ProviderErrorsPropagate = Expect<
  Equal<
    Extract<Effect.Error<typeof execution>, TypeSafe.EvaluationError>,
    TypeSafe.EvaluationError
  >
>
type _RejectionsAreSurfaced = Expect<
  Equal<
    Extract<Effect.Error<typeof execution>, Stage.InvalidAnswerDetection>,
    Stage.InvalidAnswerDetection
  >
>
const tool = Tool.define({
  name: "done",
  description: "Finish",
  input: Schema.Struct({}),
  execute: () => Effect.succeed("done"),
})
const chat = Chat.define({
  name: "billing_chat",
  version: 1,
  stages: [
    stage,
    Stage.tools({ name: "finish", instructions: ["Finish"], tools: [tool] }),
  ],
})
type _ChatRequirementsPropagate = Expect<
  Equal<
    Extract<Chat.Requirements<typeof chat>, TypeSafe.Service>,
    TypeSafe.Service
  >
>
const run = Effect.gen(function* () {
  const service = yield* TypeSafe.Service
  const response = yield* service.evaluate({
    state: "Annual please",
    questions: TypeSafe.batch({
      interval: TypeSafe.choice("Which interval?", {
        monthly: "Every month",
        annual: "Every year",
      }),
    }),
  })
  const interval: "monthly" | "annual" = response.answers.interval.value
  // @ts-expect-error Unregistered question keys do not exist.
  void response.answers.missing
  return interval
})
void run
void (() => {
  TypeSafe.detection(fields, {
    policy: TypeSafe.detectionPolicy({ detectedAtOrAbove: 0.9, undetectedAtOrBelow: 0.1 }),
    // @ts-expect-error Only registered field names may be overridden.
    overrides: { unknown: {} },
  })
})

class BriefContext extends Context.Service<BriefContext, { readonly currency: string }>()("BriefContext") {}
class ContextUnavailable extends Schema.TaggedError<ContextUnavailable>()("ContextUnavailable", {}) {}
const enrichment = Stage.extractionContext(fields, ({ accepted, extracting }) => Effect.gen(function* () {
  const service = yield* BriefContext
  const previous: "monthly" | "annual" | undefined = accepted.interval?.value
  const keys: ReadonlyArray<"interval"> = extracting
  // @ts-expect-error Accepted answers retain the exact field registry.
  void accepted.unknown
  if (service.currency.length === 0) return yield* new ContextUnavailable()
  return { currency: service.currency, previous: previous ?? null, keys }
}))
const enriched = Stage.collect({ name: "enriched", fields, context: enrichment })
const enrichedRun = enriched.run({ state: enriched.initialState, messages: [] })
type _ContextRequirementsAreExact = Expect<Equal<Effect.Services<typeof enrichedRun>, Model.Service | BriefContext>>
type _ContextFailuresAreExact = Expect<Equal<Extract<Effect.Error<typeof enrichedRun>, ContextUnavailable | Stage.InvalidExtractionContext>, ContextUnavailable | Stage.InvalidExtractionContext>>
const enrichedChat = Chat.define({ name: "enriched_chat", version: 1, stages: [enriched, Stage.tools({ name: "finish", instructions: ["Finish"], tools: [tool] })] })
type _ContextRequirementsReachChat = Expect<Equal<Extract<Chat.Requirements<typeof enrichedChat>, BriefContext>, BriefContext>>
type _EnrichedAnswersArePreserved = Expect<Equal<NonNullable<Chat.State<typeof enrichedChat>["stages"]["enriched"]["accepted"]["interval"]>["value"], "monthly" | "annual">>
type _ContextErrorsReachChat = Expect<Equal<Extract<Chat.TurnError<typeof enrichedChat>, ContextUnavailable>, ContextUnavailable>>
