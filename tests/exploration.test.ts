import { Chat, Model, Session, Stage, Tool, View } from "../src/index.js"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"

interface FixtureOptions {
  readonly executeExploration?: (
    query: string,
  ) => Effect.Effect<{ readonly query: string }>
}

const makeFixture = (options: FixtureOptions = {}) => {
  let snapshot: unknown | null = null
  let writes = 0
  let modelCalls = 0
  let explorationCalls = 0

  const PrimaryQuery = Tool.define({
    name: "primary_query",
    description: "Run the primary conversation query.",
    input: Schema.Struct({}),
    execute: () => Effect.succeed({ ready: true }),
  })
  const PrimaryStage = Stage.tools({
    name: "primary",
    instructions: ["Run the primary query."],
    tools: [PrimaryQuery],
  })
  const RelatedView = View.define({
    name: "related_records",
    version: 1,
    schema: Schema.Struct({ query: Schema.String }),
  })
  const RelatedQuery = Tool.define({
    name: "related_query",
    description: "Find related records without progressing the chat.",
    input: Schema.Struct({ query: Schema.String }),
    execute: ({ query }) =>
      Effect.sync(() => {
        explorationCalls += 1
      }).pipe(
        Effect.andThen(() =>
          options.executeExploration === undefined
            ? Effect.succeed({ query })
            : options.executeExploration(query),
        ),
      ),
  }).pipe(
    Tool.present(RelatedView, ({ query }) => ({ query })),
  )
  const Definition = Chat.define({
    name: "exploration_chat",
    version: 1,
    stages: [PrimaryStage],
    explorations: [RelatedQuery],
  })
  const store = Layer.succeed(Session.Store, {
    load: () => Effect.succeed(snapshot),
    replace: (input) =>
      Effect.sync(() => {
        writes += 1
        const revision = String(writes)
        snapshot = {
          revision,
          state: input.state,
          messages: input.messages,
        }
        return { revision }
      }),
  })
  const model = Layer.succeed(Model.Service, {
    requestTool: () =>
      Effect.sync(() => {
        modelCalls += 1
        return { name: "primary_query", arguments: {} }
      }),
  })

  return {
    Definition,
    RelatedQuery,
    get snapshot() {
      return snapshot
    },
    get writes() {
      return writes
    },
    get modelCalls() {
      return modelCalls
    },
    get explorationCalls() {
      return explorationCalls
    },
    live: Layer.merge(store, model),
    store,
  }
}

describe("Chat.explore", () => {
  test("runs one correlated query without invoking the model or replacing the session", async () => {
    const fixture = makeFixture()
    await Effect.runPromise(
      Chat.turn(fixture.Definition, {
        sessionId: "exploration:1",
        message: "Start the conversation",
      }).pipe(Effect.provide(fixture.live)),
    )
    const storedBefore = fixture.snapshot
    const writesBefore = fixture.writes
    const modelCallsBefore = fixture.modelCalls

    const run = await Effect.runPromise(
      Chat.explore(fixture.Definition, {
        sessionId: "exploration:1",
        call: Tool.makeCall(fixture.RelatedQuery, {
          query: "adjacent options",
        }),
      }).pipe(Effect.provide(fixture.store)),
    )

    expect(run).toMatchObject({
      name: "related_query",
      input: { query: "adjacent options" },
      execution: {
        serverResult: { query: "adjacent options" },
        views: [
          {
            type: "data",
            name: "related_records",
            data: {
              schemaVersion: 1,
              query: "adjacent options",
            },
          },
        ],
      },
    })
    expect(fixture.explorationCalls).toBe(1)
    expect(fixture.modelCalls).toBe(modelCallsBefore)
    expect(fixture.writes).toBe(writesBefore)
    expect(fixture.snapshot).toBe(storedBefore)
  })

  test("overlaps a main turn and independent explorations with one session replacement", async () => {
    let notifyExplorationsStarted: () => void = () => undefined
    const explorationsStarted = new Promise<void>((resolve) => {
      notifyExplorationsStarted = resolve
    })
    let releaseExplorations: () => void = () => undefined
    const explorationsReleased = new Promise<void>((resolve) => {
      releaseExplorations = resolve
    })
    let startedExplorations = 0
    const fixture = makeFixture({
      executeExploration: (query) =>
        Effect.promise(async () => {
          startedExplorations += 1
          if (startedExplorations === 2) {
            notifyExplorationsStarted()
          }
          await explorationsReleased
          return { query }
        }),
    })
    const opening = await Effect.runPromise(
      Chat.turn(fixture.Definition, {
        sessionId: "exploration:concurrent",
        message: "Start the conversation",
      }).pipe(Effect.provide(fixture.live)),
    )
    const writesBefore = fixture.writes

    let notifyTurnStarted: () => void = () => undefined
    const turnStarted = new Promise<void>((resolve) => {
      notifyTurnStarted = resolve
    })
    let releaseTurn: () => void = () => undefined
    const turnReleased = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    let concurrentModelCalls = 0
    const concurrentModel = Layer.succeed(Model.Service, {
      requestTool: () =>
        Effect.promise(async () => {
          concurrentModelCalls += 1
          notifyTurnStarted()
          await turnReleased
          return { name: "primary_query", arguments: {} }
        }),
    })
    const turnPromise = Effect.runPromise(
      Chat.turn(fixture.Definition, {
        sessionId: "exploration:concurrent",
        expectedRevision: opening.revision,
        message: "Refine the conversation",
      }).pipe(
        Effect.provide(Layer.merge(fixture.store, concurrentModel)),
      ),
    )
    const firstExplorationPromise = Effect.runPromise(
      Chat.explore(fixture.Definition, {
        sessionId: "exploration:concurrent",
        call: Tool.makeCall(fixture.RelatedQuery, { query: "first" }),
      }).pipe(Effect.provide(fixture.store)),
    )
    const secondExplorationPromise = Effect.runPromise(
      Chat.explore(fixture.Definition, {
        sessionId: "exploration:concurrent",
        call: Tool.makeCall(fixture.RelatedQuery, { query: "second" }),
      }).pipe(Effect.provide(fixture.store)),
    )

    await Promise.all([turnStarted, explorationsStarted])
    releaseTurn()
    releaseExplorations()
    const [turn, firstExploration, secondExploration] =
      await Promise.all([
        turnPromise,
        firstExplorationPromise,
        secondExplorationPromise,
      ])

    expect(turn.revision).toBe("2")
    expect(firstExploration).toMatchObject({
      name: "related_query",
      input: { query: "first" },
    })
    expect(secondExploration).toMatchObject({
      name: "related_query",
      input: { query: "second" },
    })
    expect(concurrentModelCalls).toBe(1)
    expect(fixture.explorationCalls).toBe(2)
    expect(fixture.writes).toBe(writesBefore + 1)
    expect(fixture.snapshot).toMatchObject({ revision: "2" })
  })

  test("fails safely when the session does not exist", async () => {
    const fixture = makeFixture()
    const result = await Effect.runPromise(
      Effect.result(
        Chat.explore(fixture.Definition, {
          sessionId: "missing:1",
          call: Tool.makeCall(fixture.RelatedQuery, { query: "nearby" }),
        }).pipe(Effect.provide(fixture.store)),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Session.NotFound)
      expect(result.failure).toMatchObject({ reason: "not_found" })
    }
    expect(fixture.explorationCalls).toBe(0)
  })

  test("rejects calls outside the closed exploration registry", async () => {
    const fixture = makeFixture()
    await Effect.runPromise(
      Chat.turn(fixture.Definition, {
        sessionId: "exploration:2",
        message: "Start the conversation",
      }).pipe(Effect.provide(fixture.live)),
    )
    const result = await Effect.runPromise(
      Effect.result(
        Chat.explore(fixture.Definition, {
          sessionId: "exploration:2",
          call: { name: "primary_query", arguments: {} },
        }).pipe(Effect.provide(fixture.store)),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Tool.InvalidCall)
      expect(result.failure).toMatchObject({ reason: "unknown_tool" })
    }
    expect(fixture.explorationCalls).toBe(0)
  })

  test("revalidates persisted state before executing the query", async () => {
    const fixture = makeFixture()
    const invalidStore = Layer.succeed(Session.Store, {
      load: () =>
        Effect.succeed({ revision: "1", state: {}, messages: [] }),
      replace: () => Effect.die("exploration must not replace state"),
    })
    const result = await Effect.runPromise(
      Effect.result(
        Chat.explore(fixture.Definition, {
          sessionId: "exploration:invalid",
          call: Tool.makeCall(fixture.RelatedQuery, { query: "nearby" }),
        }).pipe(Effect.provide(invalidStore)),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(Session.Invalid)
      expect(result.failure).toMatchObject({ reason: "invalid_state" })
    }
    expect(fixture.explorationCalls).toBe(0)
  })
})
