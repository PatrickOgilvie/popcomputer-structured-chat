import { Answer, Chat, Question, Stage, Tool } from "../src/index.js"
import * as Debug from "../src/debug.js"
import { Chat as ChatTest } from "../src/testing.js"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"

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

describe("Debug.present", () => {
  test("adds the safe state projection to an ordinary presented reply", async () => {
    const response = await Effect.runPromise(
      Debug.present(DebugChat, {
        sessionId: "debug:01",
        revision: "1",
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

    expect(response.message.content[0]).toMatchObject({
      type: "data",
      name: "collect_question",
    })
    expect(response.session).toEqual({ id: "debug:01", revision: "1" })
    expect(response.debug.chat).toEqual({ name: "debug_chat", version: 1 })
    expect(response.debug.currentStage).toEqual({
      index: 0,
      name: "debug_brief",
      kind: "collect",
    })
  })
})
