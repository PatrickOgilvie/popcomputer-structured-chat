import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Answer, Model, Question, Session, Stage } from "../src/index.js"
import * as TypeSafe from "../src/typesafe.js"
import { runtimeConfig } from "./typesafe-runtime.js"

const fields = {
  need: Answer.semantic(Schema.Trimmed.check(Schema.isNonEmpty()), {
    description: "The agency need",
    ask: Question.fixed("What do you need help with?"),
  }),
  budget: Answer.explicit(
    Schema.Literals(["under_25k", "25k_to_50k", "50k_plus"]),
    {
      description: "The budget band",
      ask: Question.fixed("What budget are you working with?"),
    },
  ),
  timeline: Answer.explicit(
    Schema.Literals(["next_month", "one_to_three_months", "later"]),
    {
      description: "The start timeline",
      ask: Question.fixed("When would you like to start?"),
    },
  ),
} as const
const acceptance = {
  need: { minimumProbability: 0.8 },
  budget: { minimumProbability: 0.9 },
  timeline: { minimumProbability: 0.9 },
} as const
const detector = TypeSafe.detection(fields, { acceptance })
const noGenerativeModel = Layer.succeed(
  Model.Service,
  Model.Service.of({
    requestTool: () =>
      Effect.die(new Error("Unexpected generative extraction")),
  }),
)

const Request = Schema.Struct({
  model: Schema.String,
  questions: Schema.Record(
    Schema.String,
    Schema.Struct({
      type: Schema.Literal("noul"),
      instructions: Schema.Record(Schema.String, Schema.Json),
      criteria: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
})
type DetectionRequest = Schema.Schema.Type<typeof Request>

const provider = (
  probabilities: Readonly<Record<string, number>>,
  requests?: Array<DetectionRequest>,
) =>
  TypeSafe.layer(
    runtimeConfig(async (_url, init) => {
      const request = Schema.decodeUnknownSync(
        Schema.fromJsonString(Request),
      )(init?.body)
      requests?.push(request)
      return Response.json({
        model: "jev-test",
        usage: { input_tokens: 20, output_tokens: 3 },
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "noul", noul: probabilities[id] ?? 0 },
          ]),
        ),
      })
    }),
  )

const generative = (proposal: {
  readonly answers: Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>
  readonly evidence: ReadonlyArray<{ readonly field: string; readonly quote: string }>
}) =>
  Layer.succeed(
    Model.Service,
    Model.Service.of({
      requestTool: () =>
        Effect.succeed(
          Schema.decodeUnknownSync(Schema.Json)({
            name: "submit_answers",
            arguments: {
              answers: proposal.answers,
              evidence: proposal.evidence,
              nextQuestion: null,
            },
          }),
        ),
    }),
  )

describe("TypeSafe detection", () => {
  test("marks several questions answered and gates extraction to them", async () => {
    const stage = Stage.collect({ name: "brief", fields, detector })
    const text =
      "We need brand strategy help, the budget is fifty grand plus, no timeline yet."
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted(text)],
        })
        .pipe(
          Effect.provide(
            provider({ need: 0.98, budget: 0.95, timeline: 0.05 }),
          ),
          Effect.provide(
            generative({
              answers: {
                need: "Brand strategy",
                budget: "50k_plus",
                timeline: "next_month",
              },
              evidence: [
                { field: "need", quote: "brand strategy help" },
                { field: "budget", quote: "fifty grand plus" },
                { field: "timeline", quote: "no timeline yet" },
              ],
            }),
          ),
        ),
    )
    expect(result.state.accepted.need).toEqual({
      value: "Brand strategy",
      evidence: { messageIndex: 0, quote: "brand strategy help" },
    })
    expect(result.state.accepted.budget).toEqual({
      value: "50k_plus",
      evidence: { messageIndex: 0, quote: "fifty grand plus" },
    })
    expect(result.state.accepted.timeline).toBeUndefined()
    expect(result.question?.field).toBe("timeline")
    expect(result.complete).toBe(false)
  })

  test("skips extraction and keeps the form pending when nothing is detected", async () => {
    const checks: Array<string> = []
    const guard = Model.guard({
      name: "record_detection",
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
      name: "brief",
      fields,
      detector,
      guards: [guard],
    })
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("Hello there")],
        })
        .pipe(
          Effect.provide(provider({})),
          Effect.provide(noGenerativeModel),
        ),
    )
    expect(result.state.accepted).toEqual({})
    expect(result.question?.field).toBe("need")
    expect(result.complete).toBe(false)
    expect(checks).toEqual(["before", "after"])
  })

  test("applies each field's threshold independently", async () => {
    const stage = Stage.collect({ name: "brief", fields, detector })
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("Brand strategy")],
        })
        .pipe(
          Effect.provide(
            provider({ need: 0.85, budget: 0.6, timeline: 0.99 }),
          ),
          Effect.provide(
            generative({
              answers: {
                need: "Brand strategy",
                budget: "25k_to_50k",
                timeline: null,
              },
              evidence: [
                { field: "need", quote: "Brand strategy" },
                { field: "budget", quote: "Brand strategy" },
              ],
            }),
          ),
        ),
    )
    expect(result.state.accepted.need?.value).toBe("Brand strategy")
    expect(result.state.accepted.budget).toBeUndefined()
    expect(result.state.accepted.timeline).toBeUndefined()
    expect(result.question?.field).toBe("budget")
  })

  test("uses the generative path beyond the detection evidence bound", async () => {
    const stage = Stage.collect({ name: "brief", fields, detector })
    const text = "Need help " + "x".repeat(2_001)
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted(text)],
        })
        .pipe(
          Effect.provide(
            TypeSafe.layer(
              runtimeConfig(async () => {
                throw new Error("Over-bound evidence reached provider")
              }),
            ),
          ),
          Effect.provide(
            generative({
              answers: {
                need: "Product strategy",
                budget: null,
                timeline: null,
              },
              evidence: [{ field: "need", quote: "Need help" }],
            }),
          ),
        ),
    )
    expect(result.state.accepted.need?.value).toBe("Product strategy")
  })

  test("propagates provider failure without another extraction strategy", async () => {
    const stage = Stage.collect({ name: "brief", fields, detector })
    const result = await Effect.runPromise(
      stage
        .run({
          state: stage.initialState,
          messages: [Session.Message.submitted("Brand strategy")],
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

  test("sends the issued question text and true/false criteria", async () => {
    const requests: Array<DetectionRequest> = []
    const stage = Stage.collect({ name: "brief", fields, detector })
    const asked = stage.markAsked(
      stage.initialState,
      "need",
      0,
      "What do you need help with?",
    )
    await Effect.runPromise(
      stage
        .run({
          state: asked,
          messages: [
            Session.Message.authored("What do you need help with?"),
            Session.Message.submitted("Brand strategy"),
          ],
        })
        .pipe(
          Effect.provide(provider({ need: 0.99 }, requests)),
          Effect.provide(
            generative({
              answers: { need: "Brand strategy", budget: null, timeline: null },
              evidence: [{ field: "need", quote: "Brand strategy" }],
            }),
          ),
        ),
    )
    const question = requests[0]?.questions.need
    expect(question?.instructions.question).toBe(
      "What do you need help with?",
    )
    expect(question?.criteria?.true).toBe(
      "The evidence states or clearly answers this question.",
    )
    expect(question?.criteria?.false).toBe(
      "The evidence does not answer this question, only repeats earlier context, or is unrelated.",
    )
  })
})

describe("TypeSafe detection invariants", () => {
  test("rejects forged and duplicate detection selections", async () => {
    for (const selections of [
      [
        { _tag: "Detected" as const, field: "need" },
        { _tag: "Detected" as const, field: "forged" },
      ],
      [
        { _tag: "Detected" as const, field: "need" },
        { _tag: "Detected" as const, field: "need" },
      ],
    ]) {
      const strategy = Stage.detector(fields, () =>
        Effect.succeed({ _tag: "Resolved" as const, selections }),
      )
      const stage = Stage.collect({ name: "brief", fields, detector: strategy })
      const error = await Effect.runPromise(
        stage
          .run({
            state: stage.initialState,
            messages: [Session.Message.submitted("Brand strategy")],
          })
          .pipe(Effect.provide(noGenerativeModel), Effect.flip),
      )
      expect(error._tag).toBe("InvalidAnswerDetection")
    }
  })

  test("rejects binding a detector to different field definitions", () => {
    expect(() =>
      Stage.collect({ name: "wrong_binding", fields: { ...fields }, detector }),
    ).toThrow("exact stage fields")
  })

  test("rejects detection acceptance that does not cover the fields", () => {
    expect(() =>
      TypeSafe.detection(fields, {
        // @ts-expect-error Timeline acceptance is deliberately missing at runtime.
        acceptance: {
          need: { minimumProbability: 0.8 },
          budget: { minimumProbability: 0.8 },
        },
      }),
    ).toThrow("exactly the detector fields")
  })
})
