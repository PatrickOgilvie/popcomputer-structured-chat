import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Answer, Chat, Model, Question, Session, Stage, Tool } from "../src/index.js"
import { Chat as ChatTest, inMemoryChatSessionStore } from "../src/testing.js"
import * as Debug from "../src/debug.js"
import type { JsonValue } from "../src/core/json-value.js"

const bank = {
  required: {
    goal: Answer.explicit(Schema.String, { description: "The desired work", ask: Question.fixed("What work?") }),
    budget: Answer.explicit(Schema.Number, { description: "The budget", ask: Question.fixed("What budget?") }),
  }, optional: {},
} as const
const proposal = (goal: string | null = null, budget: number | null = null) => ({
  name: "submit_answers", arguments: { answers: { goal, budget }, nextQuestion: null,
    evidence: [...(goal === null ? [] : [{ field: "goal", quote: goal }]), ...(budget === null ? [] : [{ field: "budget", quote: String(budget) }])],
  },
})
const model = (...responses: ReadonlyArray<JsonValue>) => {
  let index = 0
  return Layer.succeed(Model.Service, Model.Service.of({ requestTool: () => Effect.sync(() => {
    const response = responses[index++]
    if (response === undefined) throw new Error("Unexpected model request")
    return response
  }) }))
}
const done = Stage.tools({ name: "done", instructions: ["Finish"], afterExecution: "complete", tools: [
  Tool.define({ name: "finish", description: "Finish", input: Schema.Struct({}), execute: () => Effect.succeed("done") }),
] })
const examples = Tool.define({
  name: "examples", description: "Show examples for the requested work", input: Schema.Struct({}),
  execute: () => Tool.acceptedAnswer({ stage: "brief", field: "goal", schema: Schema.String }).pipe(Effect.map(goal => `${goal} example`)),
}).pipe(Tool.modelResult(Schema.String, result => result))

describe("interview tools", () => {
  test("commits a tool result with this turn's answers, stays in the interview and resumes questions", async () => {
    const tools = [examples] as const
    const actions = { ...bank, tools }
    const contexts: Array<Stage.QuestionSelectionContext> = []
    const interview = Stage.interview({ name: "brief", ...actions, instructions: ["Help with examples and collect the brief"],
      inputs: Stage.toolInputs(tools, { examples: () => Effect.succeed({}) }),
      selection: Stage.questionSelector(actions, context => {
        contexts.push(context)
        const latest = context.conversation.filter(item => item.message.role === "user").at(-1)?.message.content ?? ""
        return Effect.succeed({ _tag: "Selected", target: latest.includes("examples") ? { _tag: "Tool", name: "examples" }
          : context.candidates.find(candidate => candidate.target._tag === "Finish")?.target ?? { _tag: "Question", field: "budget" } })
      }),
    })
    const chat = Chat.define({ name: "interview_tools", version: 1, stages: [interview, done] })
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Chat.turn(chat, { sessionId: "tools", message: "Brand strategy; show examples" })
      expect(first.turn).toMatchObject({ _tag: "ToolResult", stage: "brief", result: { serverResult: "Brand strategy example" }, state: { stage: 0, status: "active" } })
      expect(first.turn.state.stages.brief.accepted.goal?.value).toBe("Brand strategy")
      expect(interview.canFinish(first.turn.state.stages.brief)).toBe(false)
      expect(first.turn.state.stages.brief.phase._tag).toBe("Ready")
      const parsed = yield* ChatTest.parseState(chat, first.turn.state)
      expect((yield* Debug.inspect(chat, parsed)).stages[0]).toMatchObject({ _tag: "InterviewStage", tools: ["examples"], satisfiedFields: 1 })
      const second = yield* Chat.turn(chat, { sessionId: "tools", expectedRevision: first.revision, message: "Those look useful" })
      expect(second.turn).toMatchObject({ _tag: "Question", stage: "brief", question: { field: "budget" } })
      expect(JSON.stringify(contexts[1]?.conversation)).toContain("Brand strategy example")
      const interrupted = yield* Chat.turn(chat, { sessionId: "tools", expectedRevision: second.revision, message: "Show more examples" })
      expect(interrupted.turn).toMatchObject({ _tag: "ToolResult", stage: "brief" })
      expect(interrupted.turn.state.stages.brief.phase).toEqual(second.turn.state.stages.brief.phase)
      expect(interrupted.turn.state.stages.brief.asked.budget).toEqual(second.turn.state.stages.brief.asked.budget)
      const final = yield* Chat.turn(chat, { sessionId: "tools", expectedRevision: interrupted.revision, message: "20000" })
      expect(final.turn).toMatchObject({ _tag: "Complete", stage: "done" })
      expect(final.turn.state.stages.brief.phase._tag).toBe("Complete")
    }).pipe(Effect.provide(Layer.merge(inMemoryChatSessionStore, model(proposal("Brand strategy"), proposal(), proposal(), proposal(null, 20000), { name: "finish", arguments: {} })))))
  })

  test("clarifies missing arguments and executes from the reply without completing required answers", async () => {
    const lookup = Tool.define({ name: "lookup", description: "Look up a named agency", input: Schema.Struct({ name: Schema.String }), execute: input => Effect.succeed(input.name) })
    const actions = { ...bank, tools: [lookup] as const }
    const interview = Stage.interview({ name: "brief", ...actions, instructions: ["Help with requests"],
      selection: Stage.questionSelector(actions, () => Effect.succeed({ _tag: "Selected", target: { _tag: "Tool", name: "lookup" } })),
    })
    const chat = Chat.define({ name: "interview_clarify", version: 1, stages: [interview, done] })
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Chat.turn(chat, { sessionId: "clarify", message: "Look up an agency" })
      expect(first.turn).toMatchObject({ _tag: "Clarification", stage: "brief", clarification: { text: "Which agency?" }, state: { stage: 0 } })
      const second = yield* Chat.turn(chat, { sessionId: "clarify", expectedRevision: first.revision, message: "Northstar" })
      expect(second.turn).toMatchObject({ _tag: "ToolResult", stage: "brief", result: { serverResult: "Northstar" } })
      expect(interview.canFinish(second.turn.state.stages.brief)).toBe(false)
    }).pipe(Effect.provide(Layer.merge(inMemoryChatSessionStore, model(proposal(), { name: "request_tool_clarification", arguments: { text: "Which agency?" } }, proposal(), { name: "lookup", arguments: { name: "Northstar" } })))))
  })

  test.each([false, true])("LLM action selection can call tools and rejects invalid actions safely (invalid: %s)", async invalid => {
    let executions = 0
    const tool = Tool.define({ name: "example", description: "Show an example", input: Schema.Struct({}), execute: () => Effect.sync(() => ++executions) })
    const tools = [tool] as const
    const interview = Stage.interview({ name: "brief", ...bank, tools, instructions: ["Help with requests"], inputs: Stage.toolInputs(tools, { example: () => Effect.succeed({}) }) })
    const turn = await Effect.runPromise(interview.run({ state: interview.initialState, messages: [Session.Message.submitted("Show an example")] }).pipe(Effect.provide(model(proposal(), { name: "select_next_question", arguments: { choice: invalid ? "action_99" : "action_2", text: null, options: [] } }))))
    expect(executions).toBe(invalid ? 0 : 1)
    if (invalid) expect(turn.question?.field).toBe("goal")
    else expect(turn).toMatchObject({ complete: false, action: { _tag: "ToolResult", result: { serverResult: 1 } } })
  })

  test("a failed query leaves the session uncommitted", async () => {
    class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {}) {}
    const query = Tool.define({ name: "query", description: "Fetch examples", input: Schema.Struct({}), execute: () => Effect.fail(new Unavailable()) })
    const tools = [query] as const
    const actions = { ...bank, tools }
    const interview = Stage.interview({ name: "brief", ...actions, instructions: ["Help"], inputs: Stage.toolInputs(tools, { query: () => Effect.succeed({}) }),
      selection: Stage.questionSelector(actions, () => Effect.succeed({ _tag: "Selected", target: { _tag: "Tool", name: "query" } })),
    })
    const chat = Chat.define({ name: "failed_query", version: 1, stages: [interview, done] })
    await Effect.runPromise(Effect.gen(function* () {
      const store = yield* Session.Store
      const result = yield* Chat.turn(chat, { sessionId: "failure", message: "Brand strategy" }).pipe(Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "Unavailable" } })
      expect(yield* store.load({ namespace: "", sessionId: "failure", chat: "failed_query", version: 1 })).toBeNull()
    }).pipe(Effect.provide(Layer.merge(inMemoryChatSessionStore, model(proposal("Brand strategy"))))))
  })

  test("selector and input bindings must use the exact interview capability definitions", () => {
    const other = Tool.define({ name: "examples", description: "Different implementation", input: Schema.Struct({}), execute: () => Effect.void })
    const tools = [examples] as const
    expect(() => Stage.interview({ name: "brief", ...bank, tools, instructions: ["Help"], selection: Stage.questionSelector({ ...bank, tools: [other] }, () => Effect.succeed({ _tag: "Uncertain" })) })).toThrow("exact tools")
    expect(() => Stage.interview({ name: "brief", ...bank, tools, instructions: ["Help"], inputs: Stage.toolInputs([other], { examples: () => Effect.succeed({}) }) })).toThrow("exact registered definitions")
  })
})
