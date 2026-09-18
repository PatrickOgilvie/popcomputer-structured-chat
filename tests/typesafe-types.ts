import { Answer, Chat, Model, Question, Stage, Tool } from "../src/index.js"
import * as TypeSafe from "../src/typesafe.js"
import { Effect, Schema } from "effect"

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
  resolver: TypeSafe.collection(fields, {
    choices: {
      interval: [
        { value: "monthly", meaning: "Every month" },
        { value: "annual", meaning: "Every year" },
      ],
    },
    acceptance: {
      interval: { minimumProbability: 0.9, minimumConfidence: 0.8 },
    },
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
  TypeSafe.collection(fields, {
    // @ts-expect-error Candidate values must satisfy the answer's literal type.
    choices: { interval: [{ value: "weekly", meaning: "Every week" }] },
    acceptance: {
      interval: { minimumProbability: 0.9, minimumConfidence: 0.8 },
    },
  })
  const numeric = {
    count: Answer.explicit(Schema.Number, {
      description: "Count",
      ask: Question.fixed("How many?"),
    }),
  }
  TypeSafe.collection(numeric, {
    // @ts-expect-error Finite collection supports strings and booleans, not arbitrary numbers.
    choices: { count: [{ value: 1, meaning: "One" }] },
    acceptance: { count: { minimumProbability: 0.9, minimumConfidence: 0.8 } },
  })
})
