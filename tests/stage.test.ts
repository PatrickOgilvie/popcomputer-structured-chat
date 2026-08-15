import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Result, Schema } from "effect"
import {
  defineModelGuard,
  defineTool,
  Message,
  Stage,
  StructuredChatModel,
} from "../src/index.js"

class PlannedCallRejected extends Schema.TaggedError<PlannedCallRejected>()(
  "PlannedCallRejected",
  { reason: Schema.Literal("unsafe_proposal") },
) {}

const Search = defineTool({
  name: "search",
  description: "Search published work.",
  input: Schema.Struct({ query: Schema.String }),
  execute: ({ query }) => Effect.succeed({ query }),
})

describe("Stage.tools", () => {
  test("provides a concise closed-capability model step", async () => {
    const Matching = Stage.tools({
      name: "matching",
      instructions: ["Route the brief to one search."],
      tools: [Search],
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: (request) => {
        expect(request.instructions.map(String)).toEqual([
          "Route the brief to one search.",
        ])
        expect(request.tools.map(({ name }) => name)).toEqual(["search"])

        return Effect.succeed({
          name: "search",
          arguments: { query: "public sector" },
        })
      },
    })
    const result = await Effect.runPromise(
      Matching.run([Message.user("Find an agency")]).pipe(
        Effect.provide(model),
      ),
    )

    expect(result.serverResult).toEqual({ query: "public sector" })
  })

  test("plans a strictly parsed call without executing application code", async () => {
    const executions = await Effect.runPromise(Ref.make(0))
    const PlannedSearch = defineTool({
      name: "planned_search",
      description: "Search published work after approval.",
      input: Schema.Struct({ query: Schema.String }),
      execute: ({ query }) =>
        Ref.update(executions, (count) => count + 1).pipe(
          Effect.as({ query }),
        ),
    })
    const Approval = Stage.tools({
      name: "approval",
      instructions: ["Propose one search for review."],
      tools: [PlannedSearch],
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "planned_search",
          arguments: { query: "public sector" },
        }),
    })
    const call = await Effect.runPromise(
      Approval.plan([Message.user("Find an agency")]).pipe(
        Effect.provide(model),
      ),
    )
    const count = await Effect.runPromise(Ref.get(executions))

    expect(call).toEqual({
      name: "planned_search",
      arguments: { query: "public sector" },
    })
    expect(count).toBe(0)
  })

  test("applies semantic guards to a parsed plan", async () => {
    const checks = await Effect.runPromise(Ref.make(0))
    const policy = defineModelGuard({
      name: "planned_call_policy",
      check: () => Effect.void,
      checkCall: () =>
        Ref.update(checks, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.fail(
              new PlannedCallRejected({
                reason: "unsafe_proposal",
              }),
            ),
          ),
        ),
    })
    const Approval = Stage.tools({
      name: "guarded_approval",
      instructions: ["Propose one safe search for review."],
      tools: [Search],
      guards: [policy],
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "search",
          arguments: { query: "unsafe but valid" },
        }),
    })
    const result = await Effect.runPromise(
      Effect.result(
        Approval.plan([Message.user("Find an agency")]).pipe(
          Effect.provide(model),
        ),
      ),
    )
    const checkCount = await Effect.runPromise(Ref.get(checks))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(PlannedCallRejected)
    }
    expect(checkCount).toBe(1)
  })

  test("applies guards before requesting a staged plan", async () => {
    const requests = await Effect.runPromise(Ref.make(0))
    const policy = defineModelGuard({
      name: "staged_request_policy",
      check: () =>
        Effect.fail(
          new PlannedCallRejected({ reason: "unsafe_proposal" }),
        ),
    })
    const Approval = Stage.tools({
      name: "request_guarded_approval",
      instructions: ["Propose one safe search for review."],
      tools: [Search],
      guards: [policy],
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Ref.update(requests, (count) => count + 1).pipe(
          Effect.as({
            name: "search",
            arguments: { query: "must not be requested" },
          }),
        ),
    })
    const result = await Effect.runPromise(
      Approval.plan([Message.user("Find an agency")]).pipe(
        Effect.provide(model),
        Effect.result,
      ),
    )
    const requestCount = await Effect.runPromise(Ref.get(requests))

    expect(Result.isFailure(result)).toBe(true)
    expect(requestCount).toBe(0)
  })
})
