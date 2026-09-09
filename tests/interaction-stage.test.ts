import { Chat, Model, Session, Stage, Tool } from "../src/index.js"
import { inMemoryChatSessionStore, Scenario } from "../src/testing.js"
import { expect, test } from "bun:test"
import { Effect, Layer, Result, Schema } from "effect"

test("a mixed stage parses query inputs once without resolving command context", async () => {
  const Inspect = Tool.define({
    name: "inspect_date",
    description: "Read records for a date.",
    input: Schema.Struct({ date: Schema.DateFromString }),
    execute: ({ date }) => Effect.succeed(date.toISOString()),
  })
  const Edit = Tool.command({
    name: "edit_date",
    description: "Edit records for a date.",
    input: Schema.Struct({ date: Schema.DateFromString }),
    execute: ({ date }) => Effect.succeed(date.toISOString()),
  })
  const stage = Stage.interact({
    name: "dates",
    instructions: ["Inspect the requested date."],
    tools: [Inspect, Edit],
  })
  const date = new Date("2026-09-01T00:00:00.000Z")
  const result = await Effect.runPromise(
    stage.run(
      [Model.Message.user("Inspect September 1")],
      () => Effect.die(new Error("Queries must not resolve command identity")),
    ).pipe(Effect.provide(Scenario.model(Scenario.call(Inspect, { date })))),
  )

  expect(result.name).toBe(Inspect.name)
  expect(result.execution.serverResult).toBe(date.toISOString())
  expect(result.complete).toBe(false)
})

test("an interaction can inspect, edit, clarify and edit again without completing", async () => {
  const commandIds: string[] = []
  const Inspect = Tool.define({
    name: "inspect",
    description: "Read the draft",
    input: Schema.Struct({}),
    execute: () => Effect.succeed({ revision: 0 }),
  })
  const Clarify = Tool.define({
    name: "clarify",
    description: "Ask a question",
    input: Schema.Struct({
      intent: Schema.String,
      question: Schema.String,
    }),
    execute: Effect.succeed,
  })
  const Edit = Tool.command({
    name: "edit",
    description: "Edit the draft",
    input: Schema.Struct({ name: Schema.String }),
    execute: (input, { commandId }) =>
      Effect.sync(() => {
        commandIds.push(commandId)
        return input
      }),
  })
  const chat = Chat.define({
    name: "authoring",
    version: 1,
    stages: [
      Stage.interact({
        name: "author",
        instructions: ["Build a conversation"],
        tools: [Inspect, Edit, Clarify],
      }),
    ],
  })
  const calls = [
    { name: "inspect", arguments: {} },
    { name: "edit", arguments: { name: "Partners" } },
    {
      name: "clarify",
      arguments: { intent: "Add budget", question: "What currency?" },
    },
    { name: "edit", arguments: { name: "Partners in GBP" } },
  ]
  let index = 0
  const model = Layer.succeed(Model.Service, {
    requestTool: () =>
      Effect.sync(() => {
        const call = calls[index++]
        if (call === undefined) throw new Error("Unexpected model request")
        return call
      }),
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      let revision: string | undefined
      for (const message of ["Show me", "Rename", "Add budget", "GBP"]) {
        const input = { sessionId: "builder", message }
        const reply = yield* Chat.turn(
          chat,
          revision === undefined
            ? input
            : { ...input, expectedRevision: revision },
        )
        expect(reply.turn._tag).toBe("ToolResult")
        expect(reply.turn.state.status).toBe("active")
        revision = reply.revision
      }
    }).pipe(Effect.provide(Layer.merge(model, inMemoryChatSessionStore))),
  )
  expect(commandIds).toHaveLength(2)
  expect(commandIds[0]).not.toBe(commandIds[1])
})

test("interaction command identity survives a failed session write", async () => {
  const ids: string[] = []
  const Edit = Tool.command({
    name: "edit",
    description: "Edit",
    input: Schema.Struct({}),
    execute: (_, { commandId }) =>
      Effect.sync(() => {
        ids.push(commandId)
        return { edited: true }
      }),
  })
  const chat = Chat.define({
    name: "retry_author",
    version: 1,
    stages: [
      Stage.interact({
        name: "author",
        instructions: ["Edit"],
        tools: [Edit],
      }),
    ],
  })
  const live = Layer.merge(
    Layer.succeed(Model.Service, {
      requestTool: () => Effect.succeed({ name: "edit", arguments: {} }),
    }),
    Layer.succeed(Session.Store, {
      load: () => Effect.succeed(null),
      replace: () =>
        Effect.fail(
          new Session.StoreUnavailable({ reason: "write_failed" }),
        ),
    }),
  )
  for (let attempt = 0; attempt < 2; attempt++)
    await Effect.runPromise(
      Chat.turn(chat, { sessionId: "retry", message: "Edit" }).pipe(
        Effect.provide(live),
        Effect.result,
      ),
    )
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBe(ids[1])
})

test("a retry cannot bypass a turn receipt by selecting a different command", async () => {
  class CommandReplayMismatch extends Schema.TaggedError<CommandReplayMismatch>()(
    "CommandReplayMismatch",
    {},
  ) {}

  const receipts = new Map<Tool.CommandId, "edit" | "publish">()
  const writes: Array<"edit" | "publish"> = []
  const execute = (command: "edit" | "publish", commandId: Tool.CommandId) =>
    Effect.suspend(() => {
      const prior = receipts.get(commandId)
      if (prior !== undefined && prior !== command) {
        return Effect.fail(new CommandReplayMismatch())
      }
      if (prior === undefined) {
        receipts.set(commandId, command)
        writes.push(command)
      }
      return Effect.succeed({ command })
    })
  const Edit = Tool.command({
    name: "edit",
    description: "Edit the draft",
    input: Schema.Struct({}),
    execute: (_, { commandId }) => execute("edit", commandId),
  })
  const Publish = Tool.command({
    name: "publish",
    description: "Publish the draft",
    input: Schema.Struct({}),
    execute: (_, { commandId }) => execute("publish", commandId),
  })
  const chat = Chat.define({
    name: "retry_command_choice",
    version: 1,
    stages: [
      Stage.interact({
        name: "author",
        instructions: ["Perform the requested draft action"],
        tools: [Edit, Publish],
      }),
    ],
  })
  const model = Scenario.model(
    Scenario.call(Edit, {}),
    Scenario.call(Publish, {}),
    Scenario.call(Edit, {}),
  )
  const store = Layer.succeed(Session.Store, {
    load: () => Effect.succeed(null),
    replace: () =>
      Effect.fail(new Session.StoreUnavailable({ reason: "write_failed" })),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const turn = Chat.turn(chat, { sessionId: "retry", message: "Edit" })
      const first = yield* Effect.result(turn)
      const changedCommand = yield* Effect.result(turn)
      const replay = yield* Effect.result(turn)

      expect(Result.isFailure(first) && first.failure._tag).toBe(
        "ChatSessionStoreUnavailable",
      )
      expect(Result.isFailure(changedCommand) && changedCommand.failure._tag).toBe(
        "CommandReplayMismatch",
      )
      expect(Result.isFailure(replay) && replay.failure._tag).toBe(
        "ChatSessionStoreUnavailable",
      )
    }).pipe(Effect.provide(Layer.merge(model, store))),
  )
  expect(writes).toEqual(["edit"])
  expect(receipts.size).toBe(1)
})

test("out-of-stage calls fail before execution and declared completion is terminal", async () => {
  let executions = 0
  const Finish = Tool.define({
    name: "finish",
    description: "Finish",
    input: Schema.Struct({}),
    execute: () =>
      Effect.sync(() => {
        executions++
        return { done: true }
      }),
  })
  const interaction = Stage.interact({
    name: "author",
    instructions: ["Finish when requested"],
    tools: [Finish],
    completeOn: ["finish"],
  })
  const chat = Chat.define({
    name: "finish_author",
    version: 1,
    stages: [interaction],
  })
  const unknown = Layer.succeed(Model.Service, {
    requestTool: () =>
      Effect.succeed({ name: "unregistered", arguments: {} }),
  })
  const rejected = await Effect.runPromise(
    Chat.turn(chat, { sessionId: "rejected", message: "Run it" }).pipe(
      Effect.provide(Layer.merge(unknown, inMemoryChatSessionStore)),
      Effect.result,
    ),
  )
  expect(Result.isFailure(rejected)).toBe(true)
  expect(executions).toBe(0)
  const model = Layer.succeed(Model.Service, {
    requestTool: () => Effect.succeed({ name: "finish", arguments: {} }),
  })
  await Effect.runPromise(
    Effect.gen(function* () {
      const reply = yield* Chat.turn(chat, {
        sessionId: "finish",
        message: "Finish",
      })
      expect(reply.turn._tag).toBe("Complete")
      const repeated = yield* Chat.turn(chat, {
        sessionId: "finish",
        expectedRevision: reply.revision,
        message: "Again",
      }).pipe(Effect.result)
      expect(Result.isFailure(repeated)).toBe(true)
    }).pipe(Effect.provide(Layer.merge(model, inMemoryChatSessionStore))),
  )
  expect(executions).toBe(1)
})
