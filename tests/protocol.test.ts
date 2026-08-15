import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import {
  InvalidChatPresentation,
  presentAnswerValidationRejection,
  presentChatNotice,
  presentChatReply,
  Text,
} from "../src/index.js"

describe("presentChatReply", () => {
  test("classifies dynamic text construction failures in the Effect channel", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.suspend(() =>
          presentChatReply(
            {
              sessionId: "chat:01",
              revision: "2",
              turn: {
                _tag: "ToolResult",
                stage: "matching",
                result: { views: [] },
              },
            },
            {
              result: () => [Text.make("Trailing whitespace ")],
            },
          ),
        ),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidChatPresentation)
    }
  })

  test("classifies invalid notice text in the Effect channel", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.suspend(() =>
          presentChatNotice({ text: "Trailing whitespace " }),
        ),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InvalidChatPresentation)
    }
  })

  test("projects choices and uncertainty without exposing option values", async () => {
    const response = await Effect.runPromise(
      presentChatReply({
        sessionId: "chat:01",
        revision: "1",
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
      schemaVersion: 1,
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
    })
  })

  test("presents a non-progressing validation retry without option values", async () => {
    const response = await Effect.runPromise(
      presentAnswerValidationRejection({
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
      presentChatReply(
        {
          sessionId: "chat:01",
          revision: "2",
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
            Text.make("I found one strong match."),
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
        presentChatReply({
          sessionId: "chat:01",
          revision: "2",
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
      expect(result.failure).toBeInstanceOf(InvalidChatPresentation)
    }
  })

  test("presents a non-progressing safety notice with optional prior state", async () => {
    const initial = await Effect.runPromise(
      presentChatNotice({
        text: "That request could not be processed safely.",
        session: undefined,
      }),
    )
    const retryable = await Effect.runPromise(
      presentChatNotice({
        text: "That request could not be processed safely.",
        session: { id: "chat:01", revision: "2" },
      }),
    )

    expect(initial.session).toBeUndefined()
    expect(retryable.session).toEqual({
      id: "chat:01",
      revision: "2",
    })
  })
})
