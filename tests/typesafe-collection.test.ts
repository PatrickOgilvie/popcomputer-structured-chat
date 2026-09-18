import { describe, expect, test } from "bun:test"
import { Effect, Layer, Predicate, Redacted, Schema } from "effect"
import { Answer, Model, Question, Session, Stage } from "../src/index.js"
import * as TypeSafe from "../src/typesafe.js"
import { runtimeConfig } from "./typesafe-runtime.js"

const fields = {
  interval: Answer.explicit(Schema.Literals(["monthly", "annual"]), {
    description: "Requested billing interval",
    ask: Question.fixed("Monthly or annual?"),
  }),
  invoice: Answer.explicit(Schema.Boolean, {
    description: "Whether the user wants an invoice",
    ask: Question.fixed("Would you like an invoice?"),
  }),
}
const choices = {
  interval: [
    { value: "monthly", meaning: "Every month" },
    { value: "annual", meaning: "Every year" },
  ],
  invoice: [
    { value: true, meaning: "An invoice is requested" },
    { value: false, meaning: "No invoice is requested" },
  ],
} as const
const acceptance = {
  interval: { minimumProbability: 0.9, minimumConfidence: 0.8 },
  invoice: { minimumProbability: 0.9, minimumConfidence: 0.8 },
}
const noGenerativeModel = Layer.succeed(
  Model.Service,
  Model.Service.of({
    requestTool: () =>
      Effect.die(new Error("Unexpected generative extraction")),
  }),
)
const Request = Schema.Struct({
  questions: Schema.Record(
    Schema.String,
    Schema.Struct({ criteria: Schema.Record(Schema.String, Schema.Json) }),
  ),
})
const provider = (
  selection: string | Readonly<Record<string, string>>,
  confidence = 1,
  probability = 1,
) =>
  TypeSafe.layer({
    apiKey: Redacted.make("test-key"),
    model: "jev-test",
    totalTimeoutMilliseconds: 1_000,
    retry: { maximumAttempts: 1, delayMilliseconds: 0 },
    limits: {
      maximumQuestions: 20,
      maximumStateCharacters: 10_000,
      maximumCandidatesPerField: 20,
    },
    fetch: async (_url, init) => {
      const request = Schema.decodeUnknownSync(Schema.fromJsonString(Request))(
        init?.body,
      )
      return Response.json({
        model: "jev-test",
        usage: { input_tokens: 20, output_tokens: 2 },
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => {
            const selected = Predicate.isString(selection)
              ? selection
              : (selection[id] ?? "no_answer")
            return [
              id,
              {
                type: "choice",
                choice: selected,
                confidence,
                probabilities: Object.fromEntries(
                  Object.keys(question.criteria).map((key) => [
                    key,
                    key === selected ? probability : (1 - probability) / (Object.keys(question.criteria).length - 1),
                  ]),
                ),
              },
            ]
          }),
        ),
      })
    },
  })

describe("TypeSafe collection", () => {
  test("collects bounded values and exact evidence with one guarded submission", async () => {
    const checks: Array<string> = []
    const guard = Model.guard({
      name: "record",
      check: () =>
        Effect.sync(() => {
          checks.push("before")
        }),
      checkCall: () =>
        Effect.sync(() => {
          checks.push("after")
        }),
    })
    const stage = Stage.collect({
      name: "billing",
      fields,
      guards: [guard],
      resolver: TypeSafe.collection(fields, { choices, acceptance }),
    })
    const text = "Annual billing please, and no invoice."
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted(text)],
        })
        .pipe(
          Effect.provide(provider("candidate_1")),
          Effect.provide(noGenerativeModel),
        ),
    )
    expect(result.complete).toBe(true)
    expect(result.state.accepted.interval).toEqual({
      value: "annual",
      evidence: { messageIndex: 0, quote: text },
    })
    expect(result.state.accepted.invoice?.value).toBe(false)
    expect(checks).toEqual(["before", "after"])
  })

  test("abstains without converting absence into false or retrying a generative model", async () => {
    const stage = Stage.collect({
      name: "billing",
      fields,
      resolver: TypeSafe.collection(fields, { choices, acceptance }),
    })
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("Hello")],
        })
        .pipe(
          Effect.provide(provider("no_answer")),
          Effect.provide(noGenerativeModel),
        ),
    )
    expect(result.state.accepted).toEqual({})
    expect(result.question?.field).toBe("interval")
    expect(result.complete).toBe(false)
  })
})

describe("TypeSafe collection invariants", () => {
  test("asks an unissued confirmation and never infers it from observed speech", async () => {
    const confirmed = {
      approved: Answer.confirmed(Schema.Boolean, {
        description: "User confirmation",
        ask: Question.fixed("Do you agree?"),
      }),
    }
    const stage = Stage.collect({
      name: "confirmation",
      fields: confirmed,
      resolver: TypeSafe.collection(confirmed, {
        choices: {
          approved: [
            { value: true, meaning: "Agrees" },
            { value: false, meaning: "Disagrees" },
          ],
        },
        acceptance: {
          approved: { minimumProbability: 0.9, minimumConfidence: 0.8 },
        },
      }),
    })
    const opened = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("Yes")],
        })
        .pipe(
          Effect.provide(provider("candidate_0")),
          Effect.provide(noGenerativeModel),
        ),
    )
    expect(opened.state.accepted).toEqual({})
    expect(opened.question?.text).toBe("Do you agree?")
    const asked = stage.markAsked(opened.state, "approved", 1, "Do you agree?")
    const previous = [
      Session.Message.submitted("Yes"),
      Session.Message.authored("Do you agree?"),
    ]
    const observed = await Effect.runPromise(
      stage
        .run({
          state: asked,
          messages: [
            ...previous,
            Session.Message.observed({
              role: "user",
              content: "Yes",
              batchId: "audio",
              id: "part",
            }),
          ],
        })
        .pipe(
          Effect.provide(provider("candidate_0")),
          Effect.provide(noGenerativeModel),
        ),
    )
    expect(observed.state.accepted).toEqual({})
    const accepted = await Effect.runPromise(
      stage
        .run({
          state: asked,
          messages: [...previous, Session.Message.submitted("Yes")],
        })
        .pipe(
          Effect.provide(provider("candidate_0")),
          Effect.provide(noGenerativeModel),
        ),
    )
    expect(accepted.state.accepted.approved).toEqual({
      value: true,
      evidence: { messageIndex: 2, quote: "Yes" },
    })
  })

  test("keeps a low-confidence field pending", async () => {
    const stage = Stage.collect({
      name: "billing",
      fields,
      resolver: TypeSafe.collection(fields, { choices, acceptance }),
    })
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("Maybe annual")],
        })
        .pipe(
          Effect.provide(provider("candidate_1", 0.2)),
          Effect.provide(noGenerativeModel),
        ),
    )
    expect(result.state.accepted).toEqual({})
  })

  test("preserves validator order and rejects the batch atomically", async () => {
    class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {}) {}
    const calls: Array<string> = []
    const validated = {
      first: Answer.explicit(Schema.Boolean, {
        description: "First",
        ask: Question.fixed("First?"),
        validate: () =>
          Effect.sync(() => {
            calls.push("first")
          }).pipe(Effect.andThen(Effect.fail(new Rejected()))),
        reject: { ask: Question.fixed("Please clarify first") },
      }),
      second: Answer.explicit(Schema.Boolean, {
        description: "Second",
        ask: Question.fixed("Second?"),
        validate: () =>
          Effect.sync(() => {
            calls.push("second")
          }),
        reject: { ask: Question.fixed("Please clarify second") },
      }),
    }
    const booleanChoices = [
      { value: true, meaning: "Yes" },
      { value: false, meaning: "No" },
    ] as const
    const policy = { minimumProbability: 0.9, minimumConfidence: 0.8 }
    const stage = Stage.collect({
      name: "validated",
      fields: validated,
      resolver: TypeSafe.collection(validated, {
        choices: { first: booleanChoices, second: booleanChoices },
        acceptance: { first: policy, second: policy },
      }),
    })
    const error = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("Yes to both")],
        })
        .pipe(
          Effect.provide(provider("candidate_0")),
          Effect.provide(noGenerativeModel),
          Effect.flip,
        ),
    )
    expect(error).toMatchObject({
      _tag: "AnswerValidationRejected",
      field: "first",
    })
    expect(calls).toEqual(["first"])
    expect(stage.initialState.accepted).toEqual({})
  })

  test("rejects forged and duplicate selections before acceptance", async () => {
    for (const selections of [
      [
        { _tag: "Selected", field: "interval", candidateId: "forged" },
        { _tag: "Abstained", field: "invoice", reason: "no_answer" },
      ],
      [
        { _tag: "Abstained", field: "interval", reason: "no_answer" },
        { _tag: "Abstained", field: "interval", reason: "no_answer" },
      ],
    ] as const) {
      const resolver = Stage.resolver(fields, choices, () =>
        Effect.succeed({ _tag: "Resolved" as const, selections }),
      )
      const stage = Stage.collect({ name: "invalid", fields, resolver })
      const error = await Effect.runPromise(
        stage
          .run({
            state: stage.initialState,
            messages: [Session.Message.submitted("Annual")],
          })
          .pipe(Effect.provide(noGenerativeModel), Effect.flip),
      )
      expect(error._tag).toBe("InvalidAnswerResolution")
    }
  })

  test("runs pre and post guards once when falling back for long evidence", async () => {
    const checks: Array<string> = []
    const guard = Model.guard({
      name: "record_fallback",
      check: () =>
        Effect.sync(() => {
          checks.push("before")
        }),
      checkCall: () =>
        Effect.sync(() => {
          checks.push("after")
        }),
    })
    const stage = Stage.collect({
      name: "fallback",
      fields,
      guards: [guard],
      resolver: TypeSafe.collection(fields, { choices, acceptance }),
    })
    const model = Layer.succeed(
      Model.Service,
      Model.Service.of({
        requestTool: () =>
          Effect.succeed({
            name: "submit_answers",
            arguments: {
              answers: { interval: "annual", invoice: null },
              evidence: [{ field: "interval", quote: "annual" }],
              nextQuestion: null,
            },
          }),
      }),
    )
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("annual " + "x".repeat(2_001))],
        })
        .pipe(Effect.provide(model), Effect.provide(provider("candidate_0"))),
    )
    expect(result.state.accepted.interval?.value).toBe("annual")
    expect(checks).toEqual(["before", "after"])
  })

  test("rejects binding a resolver to different field definitions", () => {
    const resolver = TypeSafe.collection(fields, { choices, acceptance })
    expect(() =>
      Stage.collect({ name: "wrong_binding", fields: { ...fields }, resolver }),
    ).toThrow("exact stage fields")
  })
})

describe("TypeSafe collection routing", () => {
  test("honors the exact uncertainty escape without inference", async () => {
    const stage = Stage.collect({
      name: "escape",
      fields,
      questions: { escape: "Not sure yet" },
      resolver: TypeSafe.collection(fields, { choices, acceptance }),
    })
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("not sure yet")],
        })
        .pipe(
          Effect.provide(
            TypeSafe.layer(
              runtimeConfig(async () => {
                throw new Error("Escape reached provider")
              }),
            ),
          ),
          Effect.provide(noGenerativeModel),
        ),
    )
    expect(result.state.accepted).toEqual({})
    expect(result.question?.field).toBe("interval")
  })

  test("allows a correction while another field is pending", async () => {
    const stage = Stage.collect({
      name: "correctable",
      fields,
      resolver: TypeSafe.collection(fields, { choices, acceptance }),
    })
    const firstMessage = Session.Message.submitted("Monthly please")
    const first = await Effect.runPromise(
      stage
        .run({ state: stage.initialState, messages: [firstMessage] })
        .pipe(
          Effect.provide(provider({ interval: "candidate_0" })),
          Effect.provide(noGenerativeModel),
        ),
    )
    if (first.question === undefined) throw new Error("Expected pending invoice question")
    const corrected = await Effect.runPromise(
      stage
        .run({
          state: first.state,
          messages: [
            firstMessage,
            Session.Message.authored(first.question.text),
            Session.Message.submitted("Actually, annual please"),
          ],
        })
        .pipe(
          Effect.provide(provider({ interval: "candidate_1" })),
          Effect.provide(noGenerativeModel),
        ),
    )
    expect(first.complete).toBe(false)
    expect(first.state.accepted.interval?.value).toBe("monthly")
    expect(corrected.state.accepted.interval).toEqual({
      value: "annual",
      evidence: { messageIndex: 2, quote: "Actually, annual please" },
    })
    expect(corrected.state.accepted.invoice).toBeUndefined()
  })

  test("uses the generative path when candidates exceed the configured budget", async () => {
    const stage = Stage.collect({
      name: "bounded",
      fields,
      resolver: TypeSafe.collection(fields, { choices, acceptance }),
    })
    const settings = runtimeConfig(async () => {
      throw new Error("Over-budget request reached provider")
    })
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("Annual please")],
        })
        .pipe(
          Effect.provide(
            TypeSafe.layer({
              ...settings,
              limits: { ...settings.limits, maximumCandidatesPerField: 3 },
            }),
          ),
          Effect.provideService(Model.Service, {
            requestTool: () =>
              Effect.succeed({
                name: "submit_answers",
                arguments: {
                  answers: { interval: "annual", invoice: null },
                  evidence: [{ field: "interval", quote: "Annual" }],
                  nextQuestion: null,
                },
              }),
          }),
        ),
    )
    expect(result.state.accepted.interval?.value).toBe("annual")
  })

  test("propagates provider failure without another extraction strategy", async () => {
    const stage = Stage.collect({
      name: "failure",
      fields,
      resolver: TypeSafe.collection(fields, { choices, acceptance }),
    })
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("Annual")],
        })
        .pipe(
          Effect.provide(
            TypeSafe.layer(
              runtimeConfig(async () => Response.json({}, { status: 401 })),
            ),
          ),
          Effect.provide(noGenerativeModel),
          Effect.result,
        ),
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TypeSafeRequestRejected" },
    })
  })

  test("preserves pre-call and post-call guard rejection", async () => {
    class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}
    for (const phase of ["before", "after"] as const) {
      let calls = 0
      const guard = Model.guard({
        name: "deny",
        check: () =>
          phase === "before" ? Effect.fail(new Denied()) : Effect.void,
        checkCall: () => Effect.fail(new Denied()),
      })
      const strategy = Stage.resolver(fields, choices, (context) =>
        Effect.sync(() => {
          calls += 1
          return {
            _tag: "Resolved" as const,
            selections: context.fields.map((field) => ({
              _tag: "Selected" as const,
              field: field.field,
              candidateId: "candidate_1",
            })),
          }
        }),
      )
      const stage = Stage.collect({
        name: "guarded",
        fields,
        resolver: strategy,
        guards: [guard],
      })
      const result = await Effect.runPromise(
        stage
          .run({
            state: stage.initialState,
            messages: [Session.Message.submitted("Annual, no invoice")],
          })
          .pipe(Effect.provide(noGenerativeModel), Effect.result),
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "Denied" },
      })
      expect(calls).toBe(phase === "before" ? 0 : 1)
    }
  })
})


test("TypeSafe collection applies the probability threshold independently", async () => {
  const stage = Stage.collect({
    name: "probability_threshold",
    fields,
    resolver: TypeSafe.collection(fields, { choices, acceptance }),
  })
  const result = await Effect.runPromise(stage.run({
    state: stage.initialState,
    messages: [Session.Message.submitted("Annual please")],
  }).pipe(
    Effect.provide(provider("candidate_1", 1, 0.7)),
    Effect.provide(noGenerativeModel),
  ))
  expect(result.state.accepted).toEqual({})
})
