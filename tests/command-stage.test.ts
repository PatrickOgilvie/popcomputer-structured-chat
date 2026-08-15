import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Result, Schema } from "effect"
import {
  Answer,
  ChatSessionStore,
  ChatSessionStoreUnavailable,
  CommandIdSchema,
  deriveCommandId,
  defineChat,
  defineCommand,
  Message,
  Question,
  Stage,
  StructuredChatModel,
  Tool,
} from "../src/index.js"
import { inMemoryChatSessionStore } from "../src/testing.js"

describe("Stage.command", () => {
  test("binds command identity to every documented tuple component", async () => {
    const base = {
      namespace: "account-one",
      chat: "delivery_chat",
      version: 1,
      sessionId: "delivery-session",
      expectedRevision: "4",
      command: "send_proposal",
    } as const

    const ids = await Effect.runPromise(
      Effect.all([
        deriveCommandId(base),
        deriveCommandId(base),
        deriveCommandId({ ...base, namespace: "account-two" }),
        deriveCommandId({ ...base, chat: "renewal_chat" }),
        deriveCommandId({ ...base, version: 2 }),
        deriveCommandId({ ...base, sessionId: "renewal-session" }),
        deriveCommandId({ ...base, expectedRevision: "5" }),
        deriveCommandId({ ...base, command: "archive_proposal" }),
      ]),
    )

    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).not.toBe(ids[2])
    expect(ids[0]).not.toBe(ids[3])
    expect(ids[0]).not.toBe(ids[4])
    expect(ids[0]).not.toBe(ids[5])
    expect(ids[0]).not.toBe(ids[6])
    expect(ids[0]).not.toBe(ids[7])
  })

  test("plans and executes exactly one command with an explicit identity", async () => {
    const observed = await Effect.runPromise(
      Ref.make<string | undefined>(undefined),
    )
    const Send = defineCommand({
      name: "send_proposal",
      description: "Send the approved proposal once.",
      input: Schema.Struct({ recipient: Schema.String }),
      execute: ({ recipient }, { commandId }) =>
        Ref.set(observed, commandId).pipe(
          Effect.as({ recipient, status: "sent" as const }),
        ),
    }).pipe(
      Tool.modelResult(
        Schema.Struct({ status: Schema.Literal("sent") }),
        ({ status }) => ({ status }),
      ),
    )
    const Delivery = Stage.command({
      name: "delivery",
      instructions: ["Send the proposal to the named recipient."],
      command: Send,
    })
    const commandId = Schema.decodeSync(CommandIdSchema)(
      `cmd_${"a".repeat(64)}`,
    )
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "send_proposal",
          arguments: { recipient: "team@example.com" },
        }),
    })

    const result = await Effect.runPromise(
      Delivery.run(
        [Message.user("Send it to team@example.com")],
        { commandId },
      ).pipe(Effect.provide(model)),
    )

    expect(result.serverResult).toEqual({
      recipient: "team@example.com",
      status: "sent",
    })
    expect(await Effect.runPromise(Ref.get(observed))).toBe(commandId)
  })

  test("derives the same command ID when a failed store write retries", async () => {
    const attempts = await Effect.runPromise(
      Ref.make<ReadonlyArray<{ id: string; recipient: string }>>([]),
    )
    const outcomes = await Effect.runPromise(
      Ref.make<ReadonlyMap<string, { readonly delivery: number }>>(new Map()),
    )
    const sends = await Effect.runPromise(Ref.make(0))
    const Send = defineCommand({
      name: "idempotent_send",
      description: "Send once through an idempotent application endpoint.",
      input: Schema.Struct({ recipient: Schema.String }),
      execute: ({ recipient }, { commandId }) =>
        Ref.update(attempts, (current) => [
          ...current,
          { id: commandId, recipient },
        ]).pipe(
          Effect.andThen(
            Ref.modify(outcomes, (current) => {
              const prior = current.get(commandId)
              if (prior !== undefined) {
                return [prior, current]
              }
              const outcome = { delivery: current.size + 1 }
              const next = new Map(current)
              next.set(commandId, outcome)
              return [outcome, next]
            }),
          ),
          Effect.tap((outcome) =>
            Ref.update(sends, (count) =>
              outcome.delivery > count ? count + 1 : count,
            ),
          ),
        ),
    })
    const Delivery = Stage.command({
      name: "idempotent_delivery",
      instructions: ["Send the requested message once."],
      command: Send,
    })
    const DeliveryChat = defineChat({
      name: "delivery_chat",
      version: 1,
      stages: [Delivery],
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "idempotent_send",
          arguments: { recipient: "team@example.com" },
        }),
    })
    const unavailableStore = Layer.succeed(ChatSessionStore, {
      load: () => Effect.succeed(null),
      replace: () =>
        Effect.fail(new ChatSessionStoreUnavailable({ reason: "write_failed" })),
    })
    const live = Layer.merge(model, unavailableStore)
    const reply = () =>
      Effect.result(
        DeliveryChat.reply({
          namespace: "account-one",
          sessionId: "delivery-session",
          message: "Send it to the team.",
        }).pipe(Effect.provide(live)),
      )

    const first = await Effect.runPromise(reply())
    const second = await Effect.runPromise(reply())
    const recorded = await Effect.runPromise(Ref.get(attempts))

    expect(Result.isFailure(first)).toBe(true)
    expect(Result.isFailure(second)).toBe(true)
    expect(recorded).toHaveLength(2)
    expect(recorded[0]?.id).toBe(recorded[1]?.id)
    expect(await Effect.runPromise(Ref.get(sends))).toBe(1)
  })

  test("completes a persisted command chat and will not execute it again", async () => {
    const executions = await Effect.runPromise(Ref.make(0))
    const Send = defineCommand({
      name: "terminal_send",
      description: "Send one terminal message.",
      input: Schema.Struct({ body: Schema.String }),
      execute: ({ body }) =>
        Ref.update(executions, (count) => count + 1).pipe(
          Effect.as({ body }),
        ),
    })
    const Delivery = Stage.command({
      name: "terminal_delivery",
      instructions: ["Send one message."],
      command: Send,
    })
    const DeliveryChat = defineChat({
      name: "terminal_delivery_chat",
      version: 1,
      stages: [Delivery],
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.succeed({
          name: "terminal_send",
          arguments: { body: "Hello" },
        }),
    })
    const live = Layer.merge(model, inMemoryChatSessionStore)

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* DeliveryChat.reply({
          sessionId: "terminal-delivery",
          message: "Send hello.",
        })
        const second = yield* Effect.result(
          DeliveryChat.reply({
            sessionId: "terminal-delivery",
            expectedRevision: first.revision,
            message: "Send it again.",
          }),
        )
        return { first, second }
      }).pipe(Effect.provide(live)),
    )

    expect(result.first.turn._tag).toBe("Complete")
    expect(Result.isFailure(result.second)).toBe(true)
    expect(await Effect.runPromise(Ref.get(executions))).toBe(1)
  })

  test("carries command identity across collection completed in the same turn", async () => {
    const requests = await Effect.runPromise(Ref.make(0))
    const observed = await Effect.runPromise(
      Ref.make<string | undefined>(undefined),
    )
    const Recipient = Stage.collect({
      name: "recipient",
      fields: {
        email: Answer.explicit(Schema.String, {
          description: "The recipient email address",
          ask: Question.fixed("Who should receive it?"),
        }),
      },
    })
    const Send = defineCommand({
      name: "collected_send",
      description: "Send to the collected recipient.",
      input: Schema.Struct({ email: Schema.String }),
      execute: ({ email }, { commandId }) =>
        Ref.set(observed, commandId).pipe(Effect.as({ email })),
    })
    const Delivery = Stage.command({
      name: "collected_delivery",
      instructions: ["Send to the collected recipient."],
      command: Send,
    })
    const DeliveryChat = defineChat({
      name: "collected_delivery_chat",
      version: 1,
      stages: [Recipient, Delivery],
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Ref.updateAndGet(requests, (count) => count + 1).pipe(
          Effect.map((count) =>
            count === 1
              ? {
                  name: "submit_answers",
                  arguments: {
                    answers: { email: "team@example.com" },
                    evidence: [
                      {
                        field: "email",
                        quote: "team@example.com",
                      },
                    ],
                    nextQuestion: null,
                  },
                }
              : {
                  name: "collected_send",
                  arguments: { email: "team@example.com" },
                },
          ),
        ),
    })

    const reply = await Effect.runPromise(
      DeliveryChat.reply({
        sessionId: "collected-delivery",
        message: "Send it to team@example.com.",
      }).pipe(
        Effect.provide(Layer.merge(model, inMemoryChatSessionStore)),
      ),
    )

    expect(reply.turn._tag).toBe("Complete")
    expect(await Effect.runPromise(Ref.get(observed))).toMatch(
      /^cmd_[0-9a-f]{64}$/,
    )
  })

  test("rejects the history limit before command planning or execution", async () => {
    let modelCalls = 0
    let commandCalls = 0
    const Send = defineCommand({
      name: "bounded_send",
      description: "Must not run beyond the history boundary.",
      input: Schema.Struct({}),
      execute: () =>
        Effect.sync(() => {
          commandCalls += 1
          return { sent: true }
        }),
    })
    const Delivery = Stage.command({
      name: "bounded_delivery",
      instructions: ["Send once."],
      command: Send,
    })
    const DeliveryChat = defineChat({
      name: "bounded_delivery_chat",
      version: 1,
      stages: [Delivery],
    })
    const store = Layer.succeed(ChatSessionStore, {
      load: () =>
        Effect.succeed({
          revision: "1",
          state: DeliveryChat.initialState,
          messages: Array.from({ length: 199 }, (_, index) =>
            index % 2 === 0
              ? Message.user(`User ${index}`)
              : Message.assistant(`Assistant ${index}`),
          ),
        }),
      replace: () => Effect.die("must not replace"),
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.sync(() => {
          modelCalls += 1
          return { name: "bounded_send", arguments: {} }
        }),
    })

    const result = await Effect.runPromise(
      Effect.result(
        DeliveryChat.reply({
          sessionId: "bounded-delivery",
          expectedRevision: "1",
          message: "Continue",
        }).pipe(Effect.provide(Layer.merge(store, model))),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    expect(modelCalls).toBe(0)
    expect(commandCalls).toBe(0)
  })

  test("will not execute a command through an unscoped direct chat run", async () => {
    let modelCalls = 0
    let commandCalls = 0
    const Send = defineCommand({
      name: "scoped_send",
      description: "Requires persisted command identity.",
      input: Schema.Struct({}),
      execute: () =>
        Effect.sync(() => {
          commandCalls += 1
          return { sent: true }
        }),
    })
    const Delivery = Stage.command({
      name: "scoped_delivery",
      instructions: ["Send once."],
      command: Send,
    })
    const DeliveryChat = defineChat({
      name: "scoped_delivery_chat",
      version: 1,
      stages: [Delivery],
    })
    const model = Layer.succeed(StructuredChatModel, {
      requestTool: () =>
        Effect.sync(() => {
          modelCalls += 1
          return { name: "scoped_send", arguments: {} }
        }),
    })

    const result = await Effect.runPromise(
      Effect.result(
        DeliveryChat.run({
          state: DeliveryChat.initialState,
          messages: [Message.user("Send it")],
        }).pipe(Effect.provide(model)),
      ),
    )

    expect(Result.isFailure(result)).toBe(true)
    expect(modelCalls).toBe(0)
    expect(commandCalls).toBe(0)
  })
})
