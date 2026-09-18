import { Effect, Redacted, Schema } from "effect"
import { Answer, Question, Stage } from "@popcomputer/structured-chat"
import * as TypeSafe from "@popcomputer/structured-chat/typesafe"

const fields = {
  need: Answer.semantic(Schema.Trimmed.check(Schema.isNonEmpty()), {
    description: "The requested agency capability",
    ask: Question.adaptive("Ask what help the client needs.", {
      fallback: "What do you need help with?",
    }),
  }),
  budget: Answer.explicit(
    Schema.Literals(["under_25k", "25k_to_50k", "50k_plus"]),
    {
      description: "The budget band",
      ask: Question.adaptiveChoice("Ask for the budget band.", {
        minimumOptions: 3,
        maximumOptions: 4,
      }),
    },
  ),
}

// Jev marks which questions the latest message already answered. Only detected
// fields may be filled by the ordinary generative extraction, and when none are
// detected the model is not called at all.
export const Brief = Stage.collect({
  name: "brief",
  fields,
  detector: TypeSafe.detection(fields, {
    // Illustrative thresholds: calibrate against representative application data.
    acceptance: {
      need: { minimumProbability: 0.8 },
      budget: { minimumProbability: 0.9 },
    },
  }),
})

// Call at the server's composition root with explicitly loaded configuration.
export const evaluatorLayer = (
  apiKey: Redacted.Redacted<string>,
  model: string,
) =>
  TypeSafe.layer({
    apiKey,
    model,
    totalTimeoutMilliseconds: 1_500,
    retry: { maximumAttempts: 2, delayMilliseconds: 100 },
    limits: {
      maximumQuestions: 16,
      maximumStateCharacters: 8_000,
      maximumCandidatesPerField: 16,
    },
  })

const routing = TypeSafe.batch({
  department: TypeSafe.choice("Which department handles this request?", {
    billing: "Invoices, payments, or billing changes",
    support: "Help using the product",
    neither: "Neither department is appropriate",
  }),
  urgent: TypeSafe.noul("Does the user explicitly need help immediately?"),
  disruption: TypeSafe.score("How disrupted is the user's work?", [
    "No work is blocked",
    "Some work is blocked, but there is a workaround",
    "All relevant work is blocked with no workaround",
  ]),
})

export const evaluateRequest = (message: string) =>
  Effect.gen(function* () {
    const evaluator = yield* TypeSafe.Service
    return yield* evaluator.evaluate({
      state: { message },
      questions: routing,
    })
  })
