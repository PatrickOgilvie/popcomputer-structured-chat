import { Model, Stage, Tool } from "../src/index.js"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Result, Schema } from "effect"

class PlannedCallRejected extends Schema.TaggedError<PlannedCallRejected>()(
  "PlannedCallRejected",
  { reason: Schema.Literal("unsafe_proposal") },
) {}

const Search = Tool.define({
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
    const model = Layer.succeed(Model.Service, {
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
      Matching.run([Model.Message.user("Find an agency")]).pipe(
        Effect.provide(model),
      ),
    )

    expect(result.serverResult).toEqual({ query: "public sector" })
  })

  test("selects a named model profile when the default is also provided", async () => {
    const ReasoningModel = Model.profile("reasoning")
    const Matching = Stage.tools({
      name: "profiled_matching",
      instructions: ["Route the brief to one search."],
      tools: [Search],
      model: ReasoningModel,
    })
    const requests = await Effect.runPromise(
      Ref.make<ReadonlyArray<"default" | "reasoning">>([]),
    )
    const defaultModel = Layer.succeed(Model.Service, {
      requestTool: () =>
        Ref.update(requests, (recorded) => [
          ...recorded,
          "default" as const,
        ]).pipe(
          Effect.as({
            name: "search",
            arguments: { query: "default model" },
          }),
        ),
    })
    const reasoningModel = Layer.succeed(ReasoningModel, {
      requestTool: () =>
        Ref.update(requests, (recorded) => [
          ...recorded,
          "reasoning" as const,
        ]).pipe(
          Effect.as({
            name: "search",
            arguments: { query: "reasoning model" },
          }),
        ),
    })

    const result = await Effect.runPromise(
      Matching.run([Model.Message.user("Find an agency")]).pipe(
        Effect.provide(Layer.merge(defaultModel, reasoningModel)),
      ),
    )
    const recorded = await Effect.runPromise(Ref.get(requests))

    expect(result.serverResult).toEqual({ query: "reasoning model" })
    expect(recorded).toEqual(["reasoning"])
  })

  test("selects the default model when no profile is configured", async () => {
    const UnusedModel = Model.profile("unused")
    const Matching = Stage.tools({
      name: "default_matching",
      instructions: ["Route the brief to one search."],
      tools: [Search],
    })
    const requests = await Effect.runPromise(
      Ref.make<ReadonlyArray<"default" | "unused">>([]),
    )
    const defaultModel = Layer.succeed(Model.Service, {
      requestTool: () =>
        Ref.update(requests, (recorded) => [
          ...recorded,
          "default" as const,
        ]).pipe(
          Effect.as({
            name: "search",
            arguments: { query: "default model" },
          }),
        ),
    })
    const unusedModel = Layer.succeed(UnusedModel, {
      requestTool: () =>
        Ref.update(requests, (recorded) => [
          ...recorded,
          "unused" as const,
        ]).pipe(
          Effect.as({
            name: "search",
            arguments: { query: "unused model" },
          }),
        ),
    })

    const result = await Effect.runPromise(
      Matching.run([Model.Message.user("Find an agency")]).pipe(
        Effect.provide(Layer.merge(defaultModel, unusedModel)),
      ),
    )
    const recorded = await Effect.runPromise(Ref.get(requests))

    expect(result.serverResult).toEqual({ query: "default model" })
    expect(recorded).toEqual(["default"])
  })

  test("plans a strictly parsed call without executing application code", async () => {
    const executions = await Effect.runPromise(Ref.make(0))
    const PlannedSearch = Tool.define({
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
    const model = Layer.succeed(Model.Service, {
      requestTool: () =>
        Effect.succeed({
          name: "planned_search",
          arguments: { query: "public sector" },
        }),
    })
    const call = await Effect.runPromise(
      Approval.plan([Model.Message.user("Find an agency")]).pipe(
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
    const policy = Model.guard({
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
    const model = Layer.succeed(Model.Service, {
      requestTool: () =>
        Effect.succeed({
          name: "search",
          arguments: { query: "unsafe but valid" },
        }),
    })
    const result = await Effect.runPromise(
      Effect.result(
        Approval.plan([Model.Message.user("Find an agency")]).pipe(
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
    const policy = Model.guard({
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
    const model = Layer.succeed(Model.Service, {
      requestTool: () =>
        Ref.update(requests, (count) => count + 1).pipe(
          Effect.as({
            name: "search",
            arguments: { query: "must not be requested" },
          }),
        ),
    })
    const result = await Effect.runPromise(
      Approval.plan([Model.Message.user("Find an agency")]).pipe(
        Effect.provide(model),
        Effect.result,
      ),
    )
    const requestCount = await Effect.runPromise(Ref.get(requests))

    expect(Result.isFailure(result)).toBe(true)
    expect(requestCount).toBe(0)
  })
})
