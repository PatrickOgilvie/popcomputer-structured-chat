import { Chat, View } from "../src/index.js"
import { describe, expect, test } from "bun:test"
import { cast, Effect, Result, Schema } from "effect"

const emptyUserAnswers = {
  schemaVersion: 1,
  chat: { name: "protocol_chat", version: 1 },
  sections: [],
} as const

describe("Chat.presentReply", () => {
  test("classifies dynamic text construction failures in the Effect channel", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.suspend(() =>
          Chat.presentReply(
            {
              sessionId: "chat:01",
              revision: "2",
              userAnswers: emptyUserAnswers,
              turn: {
                _tag: "ToolResult",
                stage: "matching",
                result: { views: [] },
              },
            },
            {
              result: () => [Chat.Text.make("Trailing whitespace ")],
            },
          ),
        ),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Chat.InvalidPresentation)
    }
  })

  test("classifies invalid notice text in the Effect channel", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.suspend(() =>
          Chat.notice({ text: "Trailing whitespace " }),
        ),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Chat.InvalidPresentation)
    }
  })

  test("projects choices and uncertainty without exposing option values", async () => {
    const response = await Effect.runPromise(
      Chat.presentReply({
        sessionId: "chat:01",
        revision: "1",
        userAnswers: emptyUserAnswers,
        turn: {
          _tag: "Question",
          stage: "brief",
          question: {
            field: "localOnly",
            text: "Only show local firms?",
            options: [
              { label: "Yes", value: true },
              { label: "No", value: false },
            ],
            escape: { label: "Not sure yet" },
          },
        },
      }),
    )

    expect(response).toEqual({
      schemaVersion: 2,
      session: { id: "chat:01", revision: "1" },
      message: {
        role: "assistant",
        content: [
          {
            type: "data",
            name: "collect_question",
            data: {
              schemaVersion: 1,
              stage: "brief",
              field: "localOnly",
              text: "Only show local firms?",
              options: [
                { label: "Yes" },
                { label: "No" },
                { label: "Not sure yet" },
              ],
            },
          },
        ],
      },
      answers: emptyUserAnswers,
    })
  })

  test("presents a non-progressing validation retry without option values", async () => {
    const response = await Effect.runPromise(
      Chat.presentValidationRejection({
        rejection: {
          stage: "brief",
          question: {
            field: "budget",
            text: "Could you revise the budget?",
            options: [
              { label: "£5,000", value: 5_000 },
              { label: "£10,000", value: 10_000 },
            ],
          },
        },
        session: { id: "chat:01", revision: "2" },
      }),
    )

    expect(response.session).toEqual({ id: "chat:01", revision: "2" })
    expect(response.schemaVersion).toBe(2)
    expect(response).not.toHaveProperty("answers")
    expect(response.message.content).toEqual([
      {
        type: "data",
        name: "collect_question",
        data: {
          schemaVersion: 1,
          stage: "brief",
          field: "budget",
          text: "Could you revise the budget?",
          options: [{ label: "£5,000" }, { label: "£10,000" }],
        },
      },
    ])
  })

  test("composes deterministic text with validated tool views", async () => {
    const response = await Effect.runPromise(
      Chat.presentReply(
        {
          sessionId: "chat:01",
          revision: "2",
          userAnswers: emptyUserAnswers,
          turn: {
            _tag: "ToolResult",
            stage: "matching",
            result: {
              views: [
                {
                  type: "data" as const,
                  name: "agency_cards",
                  data: { schemaVersion: 1, agencies: [] },
                },
              ],
            },
          },
        },
        {
          result: ({ result }) => [
            Chat.Text.make("I found one strong match."),
            ...result.views,
          ],
        },
      ),
    )

    expect(response.message.content[0]).toEqual({
      type: "text",
      text: "I found one strong match.",
    })
    expect(response.message.content[1]).toMatchObject({
      type: "data",
      name: "agency_cards",
    })
  })

  test("rejects an empty tool result instead of emitting an invalid message", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Chat.presentReply({
          sessionId: "chat:01",
          revision: "2",
          userAnswers: emptyUserAnswers,
          turn: {
            _tag: "ToolResult",
            stage: "matching",
            result: { views: [] },
          },
        }),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Chat.InvalidPresentation)
    }
  })

  test("presents a non-progressing safety notice with optional prior state", async () => {
    const initial = await Effect.runPromise(
      Chat.notice({
        text: "That request could not be processed safely.",
        session: undefined,
      }),
    )
    const retryable = await Effect.runPromise(
      Chat.notice({
        text: "That request could not be processed safely.",
        session: { id: "chat:01", revision: "2" },
      }),
    )

    expect(initial.session).toBeUndefined()
    expect(initial.schemaVersion).toBe(2)
    expect(initial).not.toHaveProperty("answers")
    expect(retryable.session).toEqual({
      id: "chat:01",
      revision: "2",
    })
    expect(retryable.schemaVersion).toBe(2)
    expect(retryable).not.toHaveProperty("answers")
  })
})

describe("Chat turn response protocol v2", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "Continue" }],
  } as const
  const persisted = {
    schemaVersion: 2,
    session: { id: "chat:01", revision: "3" },
    message,
    answers: emptyUserAnswers,
  } as const

  test("strictly separates persisted and non-progressing members", () => {
    const decodePersisted = Schema.decodeUnknownResult(
      Chat.PersistedTurnResponseSchema,
    )
    const decodeNonProgressing = Schema.decodeUnknownResult(
      Chat.NonProgressingResponseSchema,
    )

    expect(Result.isSuccess(decodePersisted(persisted, {
      onExcessProperty: "error",
    }))).toBe(true)
    expect(Result.isFailure(decodePersisted({
      schemaVersion: 2,
      session: persisted.session,
      message,
    }, { onExcessProperty: "error" }))).toBe(true)
    expect(Result.isSuccess(decodeNonProgressing({
      schemaVersion: 2,
      session: persisted.session,
      message,
    }, { onExcessProperty: "error" }))).toBe(true)
    expect(Result.isFailure(decodeNonProgressing(persisted, {
      onExcessProperty: "error",
    }))).toBe(true)
  })

  test.each([
    ["v1 envelope", { ...persisted, schemaVersion: 1 }],
    [
      "missing persisted session",
      { schemaVersion: 2, message, answers: emptyUserAnswers },
    ],
    [
      "wrong answer snapshot version",
      {
        ...persisted,
        answers: { ...emptyUserAnswers, schemaVersion: 2 },
      },
    ],
    [
      "invalid answer state tag",
      {
        ...persisted,
        answers: {
          ...emptyUserAnswers,
          sections: [
            {
              key: "brief",
              label: "Brief",
              fields: [
                {
                  key: "budget",
                  label: "Budget",
                  state: { _tag: "Unknown" },
                },
              ],
            },
          ],
        },
      },
    ],
    [
      "non-JSON accepted answer value",
      {
        ...persisted,
        answers: {
          ...emptyUserAnswers,
          sections: [
            {
              key: "brief",
              label: "Brief",
              fields: [
                {
                  key: "budget",
                  label: "Budget",
                  state: { _tag: "Accepted", value: Number.NaN },
                },
              ],
            },
          ],
        },
      },
    ],
    [
      "nested excess answer property",
      {
        ...persisted,
        answers: {
          ...emptyUserAnswers,
          sections: [
            {
              key: "brief",
              label: "Brief",
              fields: [
                {
                  key: "budget",
                  label: "Budget",
                  state: { _tag: "Missing", unexpected: true },
                },
              ],
            },
          ],
        },
      },
    ],
  ])("rejects %s", (_name, input) => {
    const decoded = Schema.decodeUnknownResult(
      Chat.TurnResponseSchema,
    )(input, { onExcessProperty: "error" })

    expect(Result.isFailure(decoded)).toBe(true)
  })
})

describe("Chat.turnRequestSchema", () => {
  const decode = Schema.decodeUnknownResult(
    Chat.TurnRequestSchema,
  )

  test("accepts the documented browser payload", () => {
    const decoded = decode({
      session: { id: "chat:01", revision: "1" },
      message: "Hello there",
    })

    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) {
      expect(decoded.success).toEqual({
        session: { id: "chat:01", revision: "1" },
        message: "Hello there",
      })
    }
  })

  test.each([
    ["an empty message", { message: "" }],
    ["a whitespace-only message", { message: "   " }],
    ["an oversized message", { message: "a".repeat(50_001) }],
    ["a non-string message", { message: 42 }],
  ])("default instance rejects %s", (_name, input) => {
    expect(Result.isFailure(decode(input))).toBe(true)
  })

  test("factory without options accepts exactly the default instance", () => {
    const inputs: ReadonlyArray<unknown> = [
      { message: "Hello there" },
      { session: { id: "chat:01", revision: "1" }, message: "Hi" },
      {},
      { message: "" },
      { message: "   " },
      { message: 42 },
      { message: "a".repeat(50_000) },
      { message: "a".repeat(50_001) },
      { session: { id: "bad id", revision: "1" }, message: "Hi" },
    ]

    for (const input of inputs) {
      expect(Schema.is(Chat.turnRequestSchema())(input)).toBe(
        Schema.is(Chat.TurnRequestSchema)(input),
      )
    }
  })

  test("factory applies maximumMessageLength to trimmed non-empty text", () => {
    const schema = Chat.turnRequestSchema({
      maximumMessageLength: 10,
    })

    expect(Result.isSuccess(Schema.decodeUnknownResult(schema)({ message: "short" }))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(schema)({ message: "" }))).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(schema)({ message: "          " })),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(schema)({ message: "longer than ten" }),
      ),
    ).toBe(true)
  })

  test.each([
    [0],
    [-5],
    [1.5],
    [Number.NaN],
  ])("factory rejects the invalid bound %p", (maximumMessageLength) => {
    expect(() =>
      Chat.turnRequestSchema({ maximumMessageLength }),
    ).toThrow()
  })
})

describe("Chat.findTurnParts", () => {
  const Card = View.define({
    name: "card",
    version: 1,
    schema: Schema.Struct({ value: Schema.String }),
  })
  const ForeignCard = View.define({
    name: "foreign_card",
    version: 1,
    schema: Schema.Struct({ value: Schema.String }),
  })

  test("returns only strictly decoded parts for the requested view", async () => {
    const response = await Effect.runPromise(
      Chat.presentReply({
        sessionId: "chat:01",
        revision: "1",
        userAnswers: emptyUserAnswers,
        turn: {
          _tag: "ToolResult",
          stage: "matching",
          result: { views: [] },
        },
      }, {
        result: () => [
          ForeignCard.make({ value: "other view" }),
          Card.make({ value: "safe" }),
          // Same view name but an incompatible schemaVersion.
          {
            type: "data" as const,
            name: "card",
            data: { schemaVersion: 999, value: "stale" },
          },
          // Same view name and version but corrupt data.
          {
            type: "data" as const,
            name: "card",
            data: { schemaVersion: 1, value: 42 },
          },
        ],
      }),
    )
    const parts = Chat.findTurnParts(response, Card)

    expect(parts).toEqual([{ schemaVersion: 1, value: "safe" }])
  })

  test("round-trips the built-in collect question view", async () => {
    const response = await Effect.runPromise(
      Chat.presentReply({
        sessionId: "chat:01",
        revision: "3",
        userAnswers: emptyUserAnswers,
        turn: {
          _tag: "Question",
          stage: "brief",
          question: {
            field: "localOnly",
            text: "Only show local firms?",
            options: [{ label: "Yes", value: true }],
            escape: { label: "Not sure yet" },
          },
        },
      }),
    )

    expect(Chat.findTurnParts(response, Chat.CollectQuestionView)).toEqual([
      {
        schemaVersion: 1,
        stage: "brief",
        field: "localOnly",
        text: "Only show local firms?",
        options: [{ label: "Yes" }, { label: "Not sure yet" }],
      },
    ])
  })

  test("returns an empty array for empty transcript content", () => {
    // SAFETY: this exercises the finder beyond the non-empty transcript
    // contract, where it must fail closed with no matches.
    const emptyResponse = cast<unknown, Chat.TurnResponse>({
      schemaVersion: 2,
      session: { id: "chat:01", revision: "1" },
      message: { role: "assistant", content: [] },
      answers: emptyUserAnswers,
    })

    expect(Chat.findTurnParts(emptyResponse, Card)).toEqual([])
  })

  test("ignores text parts entirely", async () => {
    const response = await Effect.runPromise(
      Chat.notice({ text: "Nothing to decode here." }),
    )

    expect(Chat.findTurnParts(response, Card)).toEqual([])
  })
})

describe("exploration protocol", () => {
  const Card = View.define({
    name: "exploration_card",
    version: 1,
    schema: Schema.Struct({ value: Schema.String }),
  })

  test("accepts only a stable session id and one encoded tool call", () => {
    const decode = Schema.decodeUnknownResult(
      Chat.ExplorationRequestSchema,
    )
    const valid = decode({
      session: { id: "chat:01" },
      call: { name: "related_query", arguments: { query: "nearby" } },
    }, { onExcessProperty: "error" })
    const revision = decode({
      session: { id: "chat:01", revision: "2" },
      call: { name: "related_query", arguments: {} },
    }, { onExcessProperty: "error" })

    expect(Result.isSuccess(valid)).toBe(true)
    expect(Result.isFailure(revision)).toBe(true)
  })

  test("presents validated views without pretending to advance the chat", async () => {
    const response = await Effect.runPromise(
      Chat.presentExplorationRun({
        name: "related_query",
        input: { query: "nearby" },
        execution: {
          views: [Card.make({ value: "Related result" })],
        },
      }),
    )

    expect(response).toEqual({
      schemaVersion: 1,
      content: [
        {
          type: "data",
          name: "exploration_card",
          data: { schemaVersion: 1, value: "Related result" },
        },
      ],
    })
    expect(response).not.toHaveProperty("session")
    expect(response).not.toHaveProperty("message")
    expect(Chat.findExplorationParts(response, Card)).toEqual([
      { schemaVersion: 1, value: "Related result" },
    ])
  })

  test("rejects an empty exploration presentation", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Chat.presentExplorationRun({
          name: "related_query",
          input: {},
          execution: { views: [] },
        }),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Chat.InvalidPresentation)
    }
  })
})
