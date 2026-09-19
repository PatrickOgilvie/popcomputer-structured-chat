import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Answer, Model, Question, Session, Stage, Tool } from "../src/index.js"
import * as TypeSafe from "../src/typesafe.js"
import { captureDebugEvents } from "../src/core/debug-trace.js"
import { runtimeConfig } from "./typesafe-runtime.js"

const fields = {
  need: Answer.explicit(Schema.String, {
    description: "Work needed",
    ask: Question.fixed("What work?"),
  }),
}
const tools = [
  Tool.define({
    name: "search",
    description: "Find agencies",
    input: Schema.Struct({ query: Schema.String }),
    execute: (input) => Effect.succeed(input.query),
  }),
] as const
const detectionPolicy = TypeSafe.detectionPolicy({
  detectedAtOrAbove: 0.9,
  undetectedAtOrBelow: 0.1,
})
const selectionPolicy = TypeSafe.selectionPolicy({
  minimumProbability: 0.9,
  minimumMargin: 0.1,
})
const detectionContext = {
  fields: [{ field: "need", mode: "explicit", description: "Work needed" }],
  evidence: [{ id: "message_0", messageIndex: 0, quote: "branding" }],
} as const
const selectionContext = {
  stage: "search",
  trigger: "stage_entered",
  accepted: [],
  messages: [],
  instructions: [],
  candidates: [
    { target: { _tag: "Tool", name: "search" }, description: "Find agencies" },
  ],
} as const

type DecisionEffect = Effect.Effect<
  Stage.DetectionResolution | Stage.ToolSelection,
  TypeSafe.EvaluationError,
  TypeSafe.Service
>
const decisions = (
  onUnavailable: TypeSafe.UnavailablePolicy,
): ReadonlyArray<DecisionEffect> => [
  TypeSafe.detection(fields, { policy: detectionPolicy, onUnavailable }).detect(
    detectionContext,
  ),
  TypeSafe.selection(tools, { policy: selectionPolicy, onUnavailable }).select(
    selectionContext,
  ),
]

test.each([
  [408, "timeout"],
  [429, "rate_limited"],
  [503, "server"],
  [529, "overloaded"],
] as const)(
  "HTTP %i falls back after bounded retries for detection and selection",
  async (status, reason) => {
    let attempts = 0
    const provider = TypeSafe.layer({
      ...runtimeConfig(async () => {
        attempts += 1
        return Response.json({ error: "Unavailable" }, { status })
      }),
      retry: { maximumAttempts: 2, delayMilliseconds: 0 },
    })
    const result = await Effect.runPromise(
      captureDebugEvents(Effect.all(decisions("fallback"))).pipe(
        Effect.provide(provider),
      ),
    )
    expect(result.result).toMatchObject({
      _tag: "Success",
      success: [
        { _tag: "NotApplicable", reason: "provider_unavailable" },
        { _tag: "NotApplicable", reason: "provider_unavailable" },
      ],
    })
    expect(attempts).toBe(4)
    expect(
      result.events.filter((event) => event._tag === "TypeSafeFallback"),
    ).toEqual([
      expect.objectContaining({ operation: "detection", reason }),
      expect.objectContaining({ operation: "selection", reason }),
    ])
  },
)

test("network failure hands off, while the default policy retains the provider failure", async () => {
  const provider = TypeSafe.layer(
    runtimeConfig(async () => {
      throw new Error("Disconnected")
    }),
  )
  for (const decision of decisions("fallback")) {
    expect(
      await Effect.runPromise(decision.pipe(Effect.provide(provider))),
    ).toEqual({ _tag: "NotApplicable", reason: "provider_unavailable" })
  }
  const strict: ReadonlyArray<DecisionEffect> = [
    TypeSafe.detection(fields, { policy: detectionPolicy }).detect(
      detectionContext,
    ),
    TypeSafe.selection(tools, { policy: selectionPolicy }).select(
      selectionContext,
    ),
    ...decisions("fail"),
  ]
  for (const decision of strict) {
    expect(
      await Effect.runPromise(
        Effect.result(decision).pipe(Effect.provide(provider)),
      ),
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "TypeSafeUnavailable", reason: "network" },
    })
  }
})

test.each([400, 401, 403, 404, 200])(
  "HTTP %i permanent or malformed responses do not become fallback",
  async (status) => {
    const provider = TypeSafe.layer(
      runtimeConfig(async () =>
        Response.json({ error: "Rejected" }, { status }),
      ),
    )
    for (const decision of decisions("fallback")) {
      const result = await Effect.runPromise(
        captureDebugEvents(decision).pipe(Effect.provide(provider)),
      )
      expect(result.result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag:
            status === 200
              ? "TypeSafeInvalidResponse"
              : "TypeSafeRequestRejected",
        },
      })
      expect(
        result.events.some((event) => event._tag === "TypeSafeFallback"),
      ).toBe(false)
    }
  },
)

test("an outage lets the model judge presence and extracts a grounded answer", async () => {
  const stage = Stage.collect({
    name: "brief",
    fields,
    detector: TypeSafe.detection(fields, {
      policy: detectionPolicy,
      onUnavailable: "fallback",
    }),
  })
  const requests: Array<Model.ToolRequest> = []
  const model = Layer.succeed(
    Model.Service,
    Model.Service.of({
      requestTool: (request) => {
        requests.push(request)
        return Effect.succeed({
          name: "submit_answers",
          arguments: {
            answers: { need: "branding" },
            evidence: [{ field: "need", quote: "branding" }],
            nextQuestion: null,
          },
        })
      },
    }),
  )
  const provider = TypeSafe.layer(
    runtimeConfig(async () => Response.json({}, { status: 503 })),
  )
  const result = await Effect.runPromise(
    stage
      .run({
        state: stage.initialState,
        messages: [Session.Message.submitted("We need branding")],
      })
      .pipe(Effect.provide(Layer.merge(provider, model))),
  )
  expect(result.state.accepted.need).toEqual({
    value: "branding",
    evidence: { messageIndex: 0, quote: "branding" },
  })
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0])).toContain("Uncertain")
})

const selectedStage = () =>
  Stage.tools({
    name: "search",
    tools,
    instructions: ["Search"],
    selection: TypeSafe.selection(tools, {
      policy: selectionPolicy,
      onUnavailable: "fallback",
    }),
    inputs: Stage.toolInputs(tools, {
      search: () => Effect.succeed({ query: "application-owned" }),
    }),
  })

test.each(["call", "clarify"] as const)(
  "selection outage preserves model %s and input ownership",
  async (action) => {
    const model = Layer.succeed(
      Model.Service,
      Model.Service.of({
        requestTool: () =>
          Effect.succeed(
            action === "call"
              ? { name: "search", arguments: {} }
              : {
                  name: "request_tool_clarification",
                  arguments: { text: "Which agencies?" },
                },
          ),
      }),
    )
    const provider = TypeSafe.layer(
      runtimeConfig(async () => Response.json({}, { status: 503 })),
    )
    const result = await Effect.runPromise(
      selectedStage()
        .run([])
        .pipe(Effect.provide(Layer.merge(provider, model))),
    )
    expect(result).toMatchObject(
      action === "call"
        ? { _tag: "Executed", execution: { serverResult: "application-owned" } }
        : { _tag: "Clarification", text: "Which agencies?" },
    )
  },
)

test("a failed LLM fallback remains a typed failure", async () => {
  const model = Layer.succeed(
    Model.Service,
    Model.Service.of({
      requestTool: () =>
        Effect.fail(new Model.Unavailable({ reason: "request_failed" })),
    }),
  )
  const provider = TypeSafe.layer(
    runtimeConfig(async () => Response.json({}, { status: 503 })),
  )
  const result = await Effect.runPromise(
    Effect.result(selectedStage().run([])).pipe(
      Effect.provide(Layer.merge(provider, model)),
    ),
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ChatModelUnavailable", reason: "request_failed" },
  })
})

test.each(["deadline", "interruption"] as const)(
  "%s aborts transport and only a deadline permits fallback",
  async (operation) => {
    let aborted = false
    let modelCalls = 0
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const provider = TypeSafe.layer(
          runtimeConfig(
            (_url, init) =>
              new Promise((_resolve, reject) => {
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    aborted = true
                    reject(new Error("aborted"))
                  },
                  { once: true },
                )
                Effect.runSync(Deferred.succeed(started, undefined))
              }),
          ),
        )
        const model = Layer.succeed(
          Model.Service,
          Model.Service.of({
            requestTool: () => {
              modelCalls += 1
              return Effect.succeed({ name: "search", arguments: {} })
            },
          }),
        )
        const fiber = yield* selectedStage()
          .run([])
          .pipe(Effect.provide(Layer.merge(provider, model)), Effect.forkChild)
        yield* Deferred.await(started)
        if (operation === "deadline") yield* TestClock.adjust(1_000)
        else yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(aborted).toBe(true)
    expect(modelCalls).toBe(operation === "deadline" ? 1 : 0)
    if (operation === "deadline") expect(Exit.isSuccess(result)).toBe(true)
    else
      expect(
        Exit.isFailure(result) &&
          result.cause.reasons.some(Cause.isInterruptReason),
      ).toBe(true)
  },
)
