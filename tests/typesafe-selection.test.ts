import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Tool } from "../src/index.js"
import * as TypeSafe from "../src/typesafe.js"
import { runtimeConfig } from "./typesafe-runtime.js"

const tool = Tool.define({
  name: "search",
  description: "Find agencies",
  input: Schema.Struct({}),
  execute: () => Effect.void,
})
const tools = [tool] as const
const context = {
  stage: "search",
  trigger: "stage_entered",
  accepted: [],
  messages: [],
  instructions: [],
  candidates: [
    { target: { _tag: "Tool", name: "search" }, description: "Find agencies" },
  ],
} as const
const policy = TypeSafe.selectionPolicy({
  minimumProbability: 0.9,
  minimumMargin: 0.15,
})

test("TypeSafe selection uses probability and margin, not reported confidence", async () => {
  const selector = TypeSafe.selection(tools, {
    policy: TypeSafe.selectionPolicy({
      minimumProbability: 0.9,
      minimumMargin: 0.15,
    }),
  })
  const layer = TypeSafe.layer(
    runtimeConfig(async () =>
      Response.json({
        model: "jev-test",
        usage: { input_tokens: 15, output_tokens: 3 },
        answers: {
          select_tool: {
            type: "choice",
            choice: "tool_0",
            probabilities: { tool_0: 0.95, none: 0.03, uncertain: 0.02 },
            confidence: 0.1,
          },
        },
      }),
    ),
  )
  const result = await Effect.runPromise(
    selector
      .select({
        stage: "search",
        trigger: "stage_entered",
        accepted: [],
        messages: [],
        instructions: [],
        candidates: [
          {
            target: { _tag: "Tool", name: "search" },
            description: "Find agencies",
          },
        ],
      })
      .pipe(Effect.provide(layer)),
  )
  expect(result).toEqual({
    _tag: "Selected",
    target: { _tag: "Tool", name: "search" },
  })
})

test.each([
  [
    "low probability",
    "tool_0",
    { tool_0: 0.7, none: 0.1, uncertain: 0.2 },
    "Uncertain",
  ],
  ["tie", "tool_0", { tool_0: 0.5, none: 0.5, uncertain: 0 }, "Uncertain"],
  [
    "no action",
    "none",
    { tool_0: 0.02, none: 0.95, uncertain: 0.03 },
    "NoMatch",
  ],
  [
    "explicit ambiguity",
    "uncertain",
    { tool_0: 0.02, none: 0.03, uncertain: 0.95 },
    "Uncertain",
  ],
] as const)(
  "TypeSafe selection handles %s",
  async (_label, choice, probabilities, expected) => {
    const selector = TypeSafe.selection(tools, { policy })
    const layer = TypeSafe.layer(
      runtimeConfig(async () =>
        Response.json({
          model: "jev-test",
          usage: { input_tokens: 10, output_tokens: 2 },
          answers: {
            select_tool: {
              type: "choice",
              choice,
              probabilities,
              confidence: 0.99,
            },
          },
        }),
      ),
    )
    expect(
      await Effect.runPromise(
        selector.select(context).pipe(Effect.provide(layer)),
      ),
    ).toEqual({ _tag: expected })
  },
)

test("a small runner-up margin remains uncertain even above the probability threshold", async () => {
  const selector = TypeSafe.selection(tools, {
    policy: TypeSafe.selectionPolicy({
      minimumProbability: 0.5,
      minimumMargin: 0.3,
    }),
  })
  const layer = TypeSafe.layer(
    runtimeConfig(async () =>
      Response.json({
        model: "jev-test",
        usage: { input_tokens: 10, output_tokens: 2 },
        answers: {
          select_tool: {
            type: "choice",
            choice: "tool_0",
            probabilities: { tool_0: 0.6, none: 0.4, uncertain: 0 },
            confidence: 0.99,
          },
        },
      }),
    ),
  )
  expect(
    await Effect.runPromise(
      selector.select(context).pipe(Effect.provide(layer)),
    ),
  ).toEqual({ _tag: "Uncertain" })
})

test.each([
  [
    "inconsistent winner",
    "none",
    { tool_0: 0.95, none: 0.03, uncertain: 0.02 },
  ],
  ["missing option", "tool_0", { tool_0: 0.95, none: 0.05 }],
  [
    "foreign option",
    "foreign",
    { tool_0: 0.9, none: 0.03, uncertain: 0.02, foreign: 0.05 },
  ],
  [
    "invalid distribution",
    "tool_0",
    { tool_0: 0.95, none: 0.95, uncertain: 0.95 },
  ],
] as const)("TypeSafe rejects %s", async (_label, choice, probabilities) => {
  const layer = TypeSafe.layer(
    runtimeConfig(async () =>
      Response.json({
        model: "jev-test",
        usage: { input_tokens: 10, output_tokens: 2 },
        answers: {
          select_tool: {
            type: "choice",
            choice,
            probabilities,
            confidence: 0.99,
          },
        },
      }),
    ),
  )
  const result = await Effect.runPromise(
    Effect.result(TypeSafe.selection(tools, { policy }).select(context)).pipe(
      Effect.provide(layer),
    ),
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "TypeSafeInvalidResponse" },
  })
})

test("candidate and context limits abstain without provider calls", async () => {
  const layer = TypeSafe.layer(
    runtimeConfig(async () => {
      throw new Error("No request expected")
    }),
  )
  const selector = TypeSafe.selection(tools, { policy, maximumCandidates: 3 })
  const candidates = [
    ...context.candidates,
    { target: { _tag: "Repair" as const }, description: "Correct the brief" },
  ]
  expect(
    await Effect.runPromise(
      selector.select({ ...context, candidates }).pipe(Effect.provide(layer)),
    ),
  ).toEqual({ _tag: "NotApplicable", reason: "candidate_budget_exceeded" })
  expect(
    await Effect.runPromise(
      selector
        .select({
          ...context,
          messages: [{ role: "user", content: "x".repeat(10_001) }],
        })
        .pipe(Effect.provide(layer)),
    ),
  ).toEqual({ _tag: "NotApplicable", reason: "context_budget_exceeded" })
})

test("provider authentication failure is not disguised as uncertainty", async () => {
  const layer = TypeSafe.layer(
    runtimeConfig(async () => new Response("unauthorized", { status: 401 })),
  )
  expect(
    await Effect.runPromise(
      Effect.result(TypeSafe.selection(tools, { policy }).select(context)).pipe(
        Effect.provide(layer),
      ),
    ),
  ).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "TypeSafeRequestRejected", reason: "unauthorized" },
  })
})

test("invalid policies and unknown criteria fail at definition time", () => {
  expect(() =>
    TypeSafe.selectionPolicy({ minimumProbability: NaN, minimumMargin: 0.1 }),
  ).toThrow()
  expect(() =>
    TypeSafe.selectionPolicy({ minimumProbability: 0, minimumMargin: 0.1 }),
  ).toThrow()
  // SAFETY: deliberate unregistered key proves runtime definition validation.
  const invalid = { foreign: "Wrong" } as never
  expect(() =>
    TypeSafe.selection(tools, { policy, criteria: invalid }),
  ).toThrow()
})
