import {
  Answer,
  Chat,
  Model,
  Question,
  Session,
  Stage,
  Tool,
} from "../src/index.js"
import * as Debug from "../src/debug.js"
import * as OpenAI from "../src/model/openai-compatible.js"
import { recordDebugEvent } from "../src/core/debug-trace.js"
import { JsonValueSchema } from "../src/core/json-value.js"
import { Chat as ChatTest } from "../src/testing.js"
import { inMemoryChatSessionStore } from "../src/testing.js"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"

const DebugBrief = Stage.collect({
  name: "debug_brief",
  fields: {
    topic: Answer.semantic(Schema.String, {
      description: "The topic the user wants to explore",
      ask: Question.fixed("What should we explore?"),
    }),
  },
})

const DebugSearch = Tool.define({
  name: "debug_search",
  description: "Search using the completed debug brief.",
  input: Schema.Struct({ topic: Schema.String }),
  execute: ({ topic }) => Effect.succeed({ topic }),
})

const DebugResult = Stage.tools({
  name: "debug_result",
  instructions: ["Search using the completed debug brief."],
  tools: [DebugSearch],
})

const DebugChat = Chat.define({
  name: "debug_chat",
  version: 1,
  stages: [DebugBrief, DebugResult],
})

const emptyUserAnswers = {
  schemaVersion: 1,
  chat: { name: "debug_chat", version: 1 },
  sections: [],
} as const

const overflowDebugTrace = Effect.forEach(
  Array.from({ length: 250 }),
  () =>
    recordDebugEvent({
      _tag: "ToolCalled",
      tool: "overflow_probe",
    }),
  { concurrency: 1, discard: true },
)

const overflowModel = Layer.succeed(Model.Service, {
  requestTool: (request) =>
    overflowDebugTrace.pipe(
      Effect.as(
        request.tools.some(({ name }) => name === "submit_answers")
          ? {
              name: "submit_answers",
              arguments: {
                answers: { topic: "Effect" },
                evidence: [{ field: "topic", quote: "Effect" }],
                nextQuestion: null,
              },
            }
          : {
              name: "debug_search",
              arguments: { topic: "Effect" },
            },
      ),
    ),
})

describe("Debug.present", () => {
  test("adds the safe state projection to an ordinary presented reply", async () => {
    const response = await Effect.runPromise(
      Debug.present(DebugChat, {
        sessionId: "debug:01",
        revision: "1",
        userAnswers: emptyUserAnswers,
        turn: {
          _tag: "Question",
          stage: "debug_brief",
          state: ChatTest.initialState(DebugChat),
          question: {
            field: "topic",
            mode: "semantic",
            text: "What should we explore?",
            options: [],
          },
        },
      }),
    )

    expect(response.outcome).toBe("success")
    if (response.outcome !== "success") {
      throw new Error("Expected a successful state-only response")
    }
    expect(response.message.content[0]).toMatchObject({
      type: "data",
      name: "collect_question",
    })
    expect(response.session).toEqual({ id: "debug:01", revision: "1" })
    expect(response.schemaVersion).toBe(2)
    expect(response.answers).toEqual(emptyUserAnswers)
    expect(response.debug.chat).toEqual({ name: "debug_chat", version: 1 })
    expect(response.debug.currentStage).toEqual({
      index: 0,
      name: "debug_brief",
      kind: "collect",
    })
    expect(response.trace).toEqual({
      schemaVersion: 1,
      events: [],
    })
  })

  test("captures literal provider input and output with semantic annotations", async () => {
    const providerRequests: Array<OpenAI.ProviderRequest> = []
    const providerResponses = [
      {
        id: "response-invalid-tool",
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "unknown_debug_tool",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: "response-01",
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "submit_answers",
                    arguments: JSON.stringify({
                      answers: { topic: "Effect" },
                      evidence: [{ field: "topic", quote: "Effect" }],
                      nextQuestion: null,
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        id: "response-02",
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "debug_search",
                    arguments: JSON.stringify({ topic: "Effect" }),
                  },
                },
              ],
            },
          },
        ],
      },
    ] as const
    const model = OpenAI.layer({
      timeoutMilliseconds: 1_000,
      provider: OpenAI.Provider.openAI({
        model: "gpt-5-mini",
        complete: (request) => {
          providerRequests.push(request)
          const response = providerResponses[providerRequests.length - 1]
          return response === undefined
            ? Promise.reject(new Error("Unexpected provider call"))
            : Promise.resolve(response)
        },
      }),
    })

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const reply = yield* Debug.turn(DebugChat, {
          sessionId: "debug:literal",
          message: "I want to explore Effect",
        }, { modelPayloads: "literal" })
        return yield* Debug.present(DebugChat, { ...reply }, {
          presentation: {
            result: () => [{ type: "text", text: "Debug complete" }],
          },
        })
      }).pipe(
        Effect.provide(Layer.merge(model, inMemoryChatSessionStore)),
      ),
    )

    const input = response.trace.events.find(
      (event) => event._tag === "ModelInput",
    )
    const output = response.trace.events.find(
      (event) => event._tag === "ModelOutput",
    )

    expect(input).toMatchObject({
      _tag: "ModelInput",
      call: 0,
      provider: "openai",
      model: "gpt-5-mini",
      providerAttempt: 1,
    })
    if (input?._tag !== "ModelInput") {
      throw new Error("Expected one literal model input")
    }
    const providerRequest = providerRequests[0]
    if (providerRequest === undefined) {
      throw new Error("Expected one provider request")
    }
    const expectedRequest = Schema.decodeUnknownSync(JsonValueSchema)({
      model: "gpt-5-mini",
      input: providerRequest.input,
    })
    expect(input.request).toEqual(expectedRequest)
    expect(output).toMatchObject({
      _tag: "ModelOutput",
      call: 0,
      response: providerResponses[0],
    })
    expect(response.trace.events.map(({ _tag }) => _tag)).toEqual([
      "ModelInput",
      "ModelOutput",
      "ModelOutputRejected",
      "ModelInput",
      "ModelOutput",
      "ToolCalled",
      "QuestionAnswered",
      "StageAdvanced",
      "ModelInput",
      "ModelOutput",
      "ToolCalled",
    ])
    expect(response.trace.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        _tag: "ModelOutputRejected",
        call: 0,
        reason: "invalid_tool_call",
      }),
      expect.objectContaining({
        _tag: "QuestionAnswered",
        stage: "debug_brief",
        field: "topic",
      }),
      expect.objectContaining({
        _tag: "StageAdvanced",
        from: "debug_brief",
        to: "debug_result",
      }),
      expect.objectContaining({
        _tag: "ToolCalled",
        tool: "debug_search",
      }),
    ]))
    if (response.outcome !== "success") {
      throw new Error("Expected a successful debug response")
    }
    expect(response.answers).toEqual(emptyUserAnswers)
  })

  test("truncates a successful trace before its protocol limit", async () => {
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* Debug.turn(DebugChat, {
          sessionId: "debug:overflow-success",
          message: "I want to explore Effect",
        }, { modelPayloads: "literal" })
        return yield* Debug.present(DebugChat, outcome, {
          presentation: {
            result: () => [{ type: "text", text: "Debug complete" }],
          },
        })
      }).pipe(
        Effect.provide(
          Layer.merge(overflowModel, inMemoryChatSessionStore),
        ),
      ),
    )

    expect(response.outcome).toBe("success")
    expect(response.trace.events).toHaveLength(199)
    expect(response.trace.events.at(-1)).toEqual({
      _tag: "TraceTruncated",
      sequence: 198,
    })
  })

  test("presents events from a terminal failed turn", async () => {
    const model = OpenAI.layer({
      timeoutMilliseconds: 1_000,
      provider: OpenAI.Provider.openAI({
        model: "gpt-5-mini",
        complete: () => Promise.reject(new Error("provider unavailable")),
      }),
    })

    const { outcome, response } = await Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* Debug.turn(DebugChat, {
          sessionId: "debug:failed",
          message: "I want to explore Effect",
        }, { modelPayloads: "literal" })
        const response = yield* Debug.present(DebugChat, outcome)
        return { outcome, response }
      }).pipe(
        Effect.provide(Layer.merge(model, inMemoryChatSessionStore)),
      ),
    )

    expect(outcome._tag).toBe("Failed")
    if (outcome._tag !== "Failed") {
      throw new Error("Expected a failed debug outcome")
    }
    expect(outcome.error).toMatchObject({
      _tag: "ChatModelUnavailable",
      reason: "request_failed",
    })
    expect(response).toEqual({
      schemaVersion: 2,
      outcome: "failure",
      session: { id: "debug:failed" },
      trace: {
        schemaVersion: 1,
        events: [
          expect.objectContaining({
            _tag: "ModelInput",
            call: 0,
          }),
          {
            _tag: "ModelCallFailed",
            sequence: 1,
            call: 0,
            reason: "request_failed",
          },
          { _tag: "TurnFailed", sequence: 2 },
        ],
      },
    })
  })

  test("reserves the final trace slot for an overflowing failed turn", async () => {
    const store = Layer.succeed(Session.Store, {
      load: () =>
        overflowDebugTrace.pipe(
          Effect.andThen(
            Effect.fail(
              new Session.StoreUnavailable({ reason: "load_failed" }),
            ),
          ),
        ),
      replace: () => Effect.die("must not replace"),
    })

    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* Debug.turn(DebugChat, {
          sessionId: "debug:overflow-failure",
          message: "I want to explore Effect",
        }, { modelPayloads: "literal" })
        return yield* Debug.present(DebugChat, outcome)
      }).pipe(
        Effect.provide(Layer.merge(overflowModel, store)),
      ),
    )

    expect(response.outcome).toBe("failure")
    expect(response.trace.events).toHaveLength(200)
    expect(response.trace.events.at(-2)).toEqual({
      _tag: "TraceTruncated",
      sequence: 198,
    })
    expect(response.trace.events.at(-1)).toEqual({
      _tag: "TurnFailed",
      sequence: 199,
    })
  })

  test("presents an invalid input failure without echoing its session ID", async () => {
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* Debug.turn(DebugChat, {
          sessionId: "invalid session id",
          message: "I want to explore Effect",
        }, { modelPayloads: "literal" })
        expect(outcome).toMatchObject({
          _tag: "Failed",
          sessionId: null,
          error: { reason: "invalid_input" },
        })
        return yield* Debug.present(DebugChat, outcome)
      }).pipe(
        Effect.provide(
          Layer.merge(overflowModel, inMemoryChatSessionStore),
        ),
      ),
    )

    expect(response).toMatchObject({
      schemaVersion: 2,
      outcome: "failure",
      session: null,
    })
  })

  test("rejects a trace whose sequence disagrees with array order", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Debug.present(DebugChat, {
          _tag: "Failed",
          sessionId: "debug:malformed-sequence",
          error: new Session.Invalid({ reason: "invalid_input" }),
          events: [{ _tag: "TurnFailed", sequence: 1 }],
        }),
      ),
    )

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "invalid_trace" },
    })
  })
})
