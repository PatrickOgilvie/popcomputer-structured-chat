import { Effect, Redacted, Schema } from "effect"
import { Answer, Question, Stage } from "@popcomputer/structured-chat"
import * as TypeSafe from "@popcomputer/structured-chat/typesafe"

const fields = {
  interval: Answer.explicit(Schema.Literals(["monthly", "annual"]), {
    description: "The requested billing interval",
    ask: Question.fixed("Monthly or annual?"),
  }),
  invoice: Answer.explicit(Schema.Boolean, {
    description: "Whether the user wants an invoice",
    ask: Question.fixed("Would you like an invoice?"),
  }),
}

export const Billing = Stage.collect({
  name: "billing",
  fields,
  resolver: TypeSafe.collection(fields, {
    choices: {
      interval: [
        { value: "monthly", meaning: "Pay every month" },
        { value: "annual", meaning: "Pay every year" },
      ],
      invoice: [
        { value: true, meaning: "An invoice is requested" },
        { value: false, meaning: "An invoice is explicitly declined" },
      ],
    },
    // Illustrative thresholds: calibrate against representative application data.
    acceptance: {
      interval: { minimumProbability: 0.9, minimumConfidence: 0.8 },
      invoice: { minimumProbability: 0.9, minimumConfidence: 0.8 },
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

const intakeFields = {
  need: Answer.semantic(Schema.Trimmed.check(Schema.isNonEmpty()), {
    description: "What the client needs help with",
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
export const Intake = Stage.collect({
  name: "intake",
  fields: intakeFields,
  detector: TypeSafe.detection(intakeFields, {
    // Illustrative thresholds: calibrate against representative application data.
    acceptance: {
      need: { minimumProbability: 0.8 },
      budget: { minimumProbability: 0.9 },
    },
  }),
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
