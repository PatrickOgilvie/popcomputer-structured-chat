import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Answer, Question, Session, Tool } from "../src/index.js"
import * as TypeSafe from "../src/typesafe.js"
import { runtimeConfig } from "./typesafe-runtime.js"

const answer = Answer.explicit(Schema.String, { description: "The outcome", ask: Question.fixed("What outcome?") })
const bank = { required: { goal: answer }, optional: {} }
const policy = TypeSafe.selectionPolicy({ minimumProbability: 0.9, minimumMargin: 0.15 })
const context = {
  stage: "brief", trigger: "user_reply", instructions: [], accepted: [], focus: { _tag: "None" },
  conversation: [{ messageIndex: 0, message: Session.Message.submitted("Earlier context") }],
  candidates: [{ target: { _tag: "Question", field: "goal" }, requirement: "required", purpose: "collect", description: "The outcome", question: answer.question }],
} as const

test.each([
  ["question_0", 0.95, "Selected"],
  ["question_0", 0.7, "Uncertain"],
  ["question_0", 0.5, "Uncertain"],
  ["uncertain", 0.02, "Uncertain"],
] as const)("question selection uses probability and margin: %s / %s", async (choice, probability, expected) => {
  const bodies: Array<string> = []
  const selector = TypeSafe.questionSelection(bank, { policy })
  const result = await Effect.runPromise(selector.select(context).pipe(Effect.provide(TypeSafe.layer(runtimeConfig(async (_url, init) => {
    bodies.push(Schema.decodeUnknownSync(Schema.String)(init?.body))
    return Response.json({ model: "jev-test", usage: { input_tokens: 3, output_tokens: 2 }, answers: {
      select_question: { type: "choice", choice, confidence: 0.01, probabilities: { question_0: probability, uncertain: 1 - probability } },
    } })
  })))))
  expect(result._tag).toBe(expected)
  expect(bodies[0]).toContain("Earlier context")
  expect(bodies[0]).not.toContain('"finish":')
})

test("question candidate overflow defers before a provider request", async () => {
  const selector = TypeSafe.questionSelection(bank, { policy, maximumCandidates: 2 })
  const result = await Effect.runPromise(selector.select({ ...context, candidates: [...context.candidates, { target: { _tag: "Finish" }, description: "Finish" }] }).pipe(Effect.provide(TypeSafe.layer(runtimeConfig(async () => { throw new Error("Unexpected provider request") })))))
  expect(result).toEqual({ _tag: "NotApplicable", reason: "candidate_budget_exceeded" })
})

test("Jev can select an offered interview tool while required answers are missing", async () => {
  const tool = Tool.define({ name: "examples", description: "Show examples", input: Schema.Struct({}), execute: () => Effect.void })
  const selector = TypeSafe.questionSelection({ ...bank, tools: [tool] }, { policy })
  const result = await Effect.runPromise(selector.select({ ...context, candidates: [...context.candidates,
    { target: { _tag: "Tool", name: "examples" }, description: "Show examples", inputSchema: { type: "object", properties: {} } },
  ] }).pipe(Effect.provide(TypeSafe.layer(runtimeConfig(async (_url, init) => {
    const body = Schema.decodeUnknownSync(Schema.String)(init?.body)
    expect(body).toContain("Earlier context")
    expect(body).toContain("tool_1")
    expect(body).not.toContain('"finish":')
    return Response.json({ model: "jev-test", usage: { input_tokens: 3, output_tokens: 2 }, answers: {
      select_question: { type: "choice", choice: "tool_1", confidence: 0.98, probabilities: { question_0: 0.01, tool_1: 0.98, uncertain: 0.01 } },
    } })
  })))))
  expect(result).toEqual({ _tag: "Selected", target: { _tag: "Tool", name: "examples" } })
})
