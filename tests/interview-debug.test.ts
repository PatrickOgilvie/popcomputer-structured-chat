import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Answer, Chat, Model, Question, Stage, Tool } from "../src/index.js"
import * as Debug from "../src/debug.js"
import { inMemoryChatSessionStore } from "../src/testing.js"
import type { JsonValue } from "../src/core/json-value.js"
import { createStructuredChatDebugStore, StructuredChatDebugPanel } from "../src/integrations/assistant-ui-debug.js"

const bank = {
  required: { goal: Answer.explicit(Schema.String, { description: "Goal", ask: Question.fixed("What goal?") }) },
  optional: { timeline: Answer.explicit(Schema.String, { description: "Timeline", ask: Question.fixed("When?") }) },
}
const search = Tool.define({ name: "search", description: "Search", input: Schema.Struct({}), execute: () => Effect.void })
const model = (...responses: ReadonlyArray<JsonValue>) => {
  let index = 0
  return Layer.succeed(Model.Service, Model.Service.of({ requestTool: () => Effect.sync(() => {
    const response = responses[index++]
    if (response === undefined) throw new Error("Unexpected model request")
    return response
  }) }))
}
const render = (snapshot: Debug.Snapshot) => {
  const store = createStructuredChatDebugStore()
  store.receive(snapshot)
  return renderToStaticMarkup(createElement(StructuredChatDebugPanel, { store }))
}

test("the panel follows an interview back to a previously asked question", async () => {
  const targets = ["goal", "timeline", "goal"] as const
  let index = 0
  const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Follow the conversation"],
    selection: Stage.questionSelector(bank, () => Effect.succeed({ _tag: "Selected", target: { _tag: "Question", field: targets[index++] ?? "goal" } })),
  })
  const chat = Chat.define({ name: "interview_focus", version: 1, stages: [interview, Stage.tools({ name: "search", instructions: ["Search"], tools: [search] })] })
  const empty = { name: "submit_answers", arguments: { answers: { goal: null, timeline: null }, evidence: [], declines: [], nextQuestion: null } }
  await Effect.runPromise(Effect.gen(function* () {
    const first = yield* Chat.turn(chat, { sessionId: "focus", message: "Hello" })
    const second = yield* Chat.turn(chat, { sessionId: "focus", expectedRevision: first.revision, message: "Tell me more" })
    const third = yield* Chat.turn(chat, { sessionId: "focus", expectedRevision: second.revision, message: "Back to the goal" })
    const snapshot = yield* Debug.inspect(chat, third.turn.state)
    expect(snapshot.stages[0]).toMatchObject({ _tag: "InterviewStage", focus: "goal" })
    const html = render(snapshot)
    expect(html.match(/data-focused-answer="true"[\s\S]*?pcsc-debug__answer-title">([^<]+)/)?.[1]).toBe("Goal")
    expect(html.match(/Brief is current[^<]*/)?.[0]).toBe("Brief is current. 0 of 1 required answers are answered.")
    expect(html.includes('aria-valuemax="1"')).toBe(true)
  }).pipe(Effect.provide(Layer.merge(inMemoryChatSessionStore, model(empty, empty, empty)))))
})

test("optional answers do not change the panel's required progress", async () => {
  const interview = Stage.interview({ name: "brief", ...bank, instructions: ["Collect a brief"],
    selection: Stage.questionSelector(bank, context => Effect.succeed({ _tag: "Selected", target: context.accepted.some(answer => answer.field === "timeline") ? { _tag: "Finish" } : { _tag: "Question", field: "timeline" } })),
  })
  const chat = Chat.define({ name: "interview_progress", version: 1, stages: [interview, Stage.tools({ name: "search", instructions: ["Search"], tools: [search] })] })
  await Effect.runPromise(Effect.gen(function* () {
    const first = yield* Chat.turn(chat, { sessionId: "progress", message: "Branding" })
    const firstHtml = render(yield* Debug.inspect(chat, first.turn.state))
    expect(firstHtml.match(/Brief is current[^<]*/)?.[0]).toBe("Brief is current. 1 of 1 required answers are answered.")
    expect(firstHtml.includes('aria-valuemax="1" aria-valuenow="1"')).toBe(true)
    const completed = yield* Chat.turn(chat, { sessionId: "progress", expectedRevision: first.revision, message: "Next month" })
    const snapshot = yield* Debug.inspect(chat, completed.turn.state)
    expect(snapshot.stages[0]).toMatchObject({ _tag: "InterviewStage", phase: "Complete" })
    const completedHtml = render(snapshot)
    expect(completedHtml.includes('aria-valuemax="1" aria-valuenow="1"')).toBe(true)
    expect(completedHtml.includes('pcsc-debug__stage-meta">1/1</span>')).toBe(true)
  }).pipe(Effect.provide(Layer.merge(inMemoryChatSessionStore, model(
    { name: "submit_answers", arguments: { answers: { goal: "Branding", timeline: null }, evidence: [{ field: "goal", quote: "Branding" }], declines: [], nextQuestion: null } },
    { name: "submit_answers", arguments: { answers: { goal: null, timeline: "Next month" }, evidence: [{ field: "timeline", quote: "Next month" }], declines: [], nextQuestion: null } },
    { name: "search", arguments: {} },
  )))))
})
